# SFGL

A fantasy golf league app, installable as a PWA and shipped to iOS and Android
through Capacitor. Managers draft rosters, set a lineup each tournament
week (five starters by default, plus an optional backup — both configurable in
Season Settings), claim free agents and waivers, and are scored on their
starters' PGA Tour earnings across three seasonal "swings".

---

## The one thing to understand first

**There are two deploy targets and they cannot import from each other.**

| | ships to | can import |
|---|---|---|
| `src/` | the Vite browser bundle | `src/`, `api/` |
| `api/` | Vercel serverless functions | `api/` only |

Vercel uploads `api/` and nothing else, so a function that imports from `src/`
crashes at runtime. Vite, meanwhile, happily bundles `api/` into the browser
build. That asymmetry makes **`api/` the only directory both sides can reach**,
which is why the shared logic lives there:

| module | holds |
|---|---|
| `api/_league.js` | `SEASON`, the swing definitions, the ET wall clock, waiver-cutoff maths, transaction→team matching |
| `api/_rules.js` | bonuses, segment resolution, fees, the swing pot, effective-roster replay, the swing award |
| `api/_playerNames.js` | name identity — `nameKey`, `NameSet`, `NameMap`, `namesMatch` |
| `api/_constants.js` | shared server constants |

Files prefixed with `_` are not routable by Vercel, so they are modules rather
than endpoints. `src/utils/sharedHelpers.js` re-exports most of the above, so
view code has one place to import from.

**If you find yourself copying a constant or a rule between the client and the
cron, it belongs in `api/`.** Every duplicated pair in this codebase's history
drifted, and each drift produced a bug where the browser and the server
disagreed about the same league.

---

## Running it

```bash
npm install
cp .env.example .env.local     # then fill it in — see .env.example for where each value comes from
npm run dev                    # Vite dev server, http://localhost:5173
```

`npm run dev` does **not** serve `api/`. Requests to `/api/*` are proxied to
`localhost:3000`, so to exercise the serverless functions locally run
`vercel dev` instead. Without it, the tee-time, live-score, headshot and push
paths fail; everything backed by Firestore still works.

| script | does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | production build to `dist/` |
| `npm run preview` | serve the built bundle |
| `npm run lint` | ESLint across the repo |
| `npm run analyze` | build + open a treemap of the bundle at `dist/stats.html` |

### Tests

Plain Node scripts, no runner, no config. Each is self-contained and prints its
own results:

```bash
for f in scripts/test-*.mjs; do node "$f"; done
```

`scripts/test-bundle-budget.mjs` reads `dist/`, so run `npm run build` first.

Two scripts talk to production and need Firebase Admin credentials — either
`FIREBASE_SERVICE_ACCOUNT` (the JSON blob Vercel already holds for `/api/cron`)
or the three fields separately. They read `.env.local` (and `.env.production`,
`.env`) from the repo root themselves, so the simplest setup is:

```bash
vercel env pull .env.local
node scripts/backfill-transaction-teamid.mjs
```

A real environment variable always wins over the file, so CI is unaffected. To
set one for a single shell instead:

```powershell
# PowerShell — -Raw matters, or you get an array of lines rather than one string
$env:FIREBASE_SERVICE_ACCOUNT = Get-Content service-account.json -Raw
```
```bash
# bash / zsh
export FIREBASE_SERVICE_ACCOUNT="$(cat service-account.json)"
```

`audit-tournament-results.mjs` is read-only. `backfill-transaction-teamid.mjs`
is a dry run unless given `--apply`.

Several of these are **consistency guards** rather than unit tests — they read
the source and fail when two places that must agree stop agreeing (the colour
palette, the font scale, the stale-data collection lists, the set of chunks on
the first-load critical path). If one fails, the fix is usually to make the
sources agree again, not to update the expectation.

---

## Layout

```
src/
  App.jsx              shell: tabs, header, nav, boot sequence, modals
  main.tsx             entry — root render, service worker, foreground push
  hooks/index.js       useLeague — ALL league state, the load cascade, every write path
  api/
    _init.js           Firebase app + Firestore + Auth + App Check (used by authApi, cronApi)
    firebase.js        every Firestore read/write, per collection
    authApi.js         sign-in, team claiming, the commissioner claim
    pushNotifications.js  FCM subscription + foreground handler (lazy-loaded)
    pushSend.js        three fetch() calls to /api/push — no Firebase, so cheap to import
  pages/               one file per tab, plus the modals and DialogContext
  components/          BottomSheet (the one modal shell), TeamName, AccountModal, …
  utils/               client-only helpers; sharedHelpers.js re-exports api/_rules
  theme.js             the palette, the type scale, and shared style objects
api/                   serverless functions + the shared modules above
scripts/               test and audit scripts
android/, ios/         Capacitor native projects
firestore.rules        the security model — READ THE HEADER BEFORE DEPLOYING
```

### Data flow

`useLeague` is the single owner of league state. Nothing else reads Firestore
for the collections it manages.

Loading is two-tier so first paint is not held hostage by the heavy
collections:

- **Tier 1 (awaited)** — teams, tournaments, transactions, settings, player
  registry. The splash lifts when these resolve.
- **Tier 2 (background)** — player stats, headshots, the ~600-player rankings.
  These stream in after the app is interactive.

Each collection cascades **Firestore → `sfgl_data` → localStorage**, and
localStorage is also seeded synchronously at startup so a returning visitor
paints immediately and revalidates behind the paint. Once the initial load
settles, `onSnapshot` subscriptions keep teams, transactions, tournaments and
settings live.

When a collection fails to load, `loadErrors` records it and the app shows a
stale-data banner with a retry. That list means "currently stale" — a
subscription delivering a snapshot retires its own entry.

---

## Server endpoints

| route | does |
|---|---|
| `/api/field` | this week's field, player IDs, tee times and odds in one scrape (CDN-cached — do not add a cache-buster) |
| `/api/live` | live leaderboard scoring |
| `/api/headshots` | ESPN athlete IDs for player names |
| `/api/owgr` | OWGR world rankings |
| `/api/pga-results` | official earnings from PGA Tour past-results pages |
| `/api/pga-schedule` | the full season schedule |
| `/api/push` | server-side FCM sender |
| `/api/log-error` | emails sanitized client crash reports |
| `/api/cron` | everything scheduled or commissioner-triggered (below) |

`/api/cron` dispatches on `?action=`. Two classes of caller, two credentials:

- **Scheduler actions** — `waivers`, `process-results`, `owgr-rankings`,
  `lineup-reminder`, `lead-watch`, `field-check`. Pinged by cron-job.org with
  `Authorization: Bearer $CRON_SECRET`. They **fail closed**: with no
  `CRON_SECRET` configured the endpoint returns 503 rather than running
  unauthenticated.
- **Commissioner actions** — `notify-results`, `pgat-stats`,
  `sync-cron-schedule`, `resync-legacy-tournaments`, `name-audit`. Invoked from
  the commish panel with a Firebase ID token carrying `commissioner: true`.
  `CRON_SECRET` is also accepted so curl-based runbooks keep working — which
  makes that secret equivalent to full commissioner access.

`stamp-commissioner`, which writes the custom claim itself, takes `CRON_SECRET`
only — the action that grants commissioner status is not gated on already being
a commissioner.

---

## Things that will bite you

**Player names are not strings.** The same golfer appears as "Nico Echavarria"
and "Nicolas Echavarria" across OWGR, PGA Tour, ESPN and the rosters. Use
`NameSet` / `NameMap` / `namesMatch` from `api/_playerNames.js`, which compare
equivalence classes. `nameKey` (aliased as `normalizeNordic`) answers "are these
the same string, modulo formatting" — **not** "are these the same golfer". Using
a bare key comparison for field membership, tee times, odds, scores or earnings
is a bug, and has been several times.

**`start_date` on a tournament is an ordering field, not a date.**
`_ensureStartDates` in `src/api/firebase.js` back-fills missing values with a
synthetic weekly series anchored at 2025-01-06 purely to keep the schedule in
order. The real date comes from `resolveTournamentStart` in `src/utils/index.js`,
which tries the parsed date first and only falls back to the ordering field.
Never `orderBy('start_date')` in a query either — Firestore silently drops
documents missing the ordered field, which once made the whole collection read
as empty.

**Time is Eastern.** Waiver windows, lineup locks and free-agency windows are
all ET. Use `getETNow` / `getETClock` from `api/_league.js`; never
`new Date()` against a local clock, and never `new Date(isoDateString)` for a
date-only value — that is UTC midnight, which is the previous day everywhere
west of Greenwich.

**Modals must portal.** `PullToRefresh` wraps the app in a transform, which
becomes the containing block for any descendant `position: fixed`. Use
`BottomSheet` — it portals to `document.body`, traps focus, locks scroll, and is
the only modal shell.

**A transaction's team is `teamId`, not `team`.** `team` holds the display
name, which managers can edit. `txBelongsToTeam` prefers the id and falls back
to the name for legacy rows.

**Colours and font sizes come from `theme.js`.** Raw `rgba(...)` literals and
raw pixel font sizes are caught by `scripts/test-theme-palette.mjs`.

**`src/api/_init.js` is the only place Firebase is initialized.** It exports
`app`, `db` and `auth`, and it is what sets up App Check. `firebase.js` imports
`db` from it and re-exports it, so importing either gets you the same instance
with App Check already configured — ES modules evaluate their imports first.
Never call `initializeApp` or reach for `getApps()[0]` anywhere else; both
patterns existed here, and both made App Check's presence depend on module
evaluation order.

---

## Native builds

```bash
npm run build
npx cap sync
npx cap open ios       # or: npx cap open android
```

Push on native goes through `@capacitor-firebase/messaging` rather than web
push — no service worker, no VAPID. iOS additionally needs the Push
Notifications and Background Modes capabilities and an APNs key uploaded to
Firebase.

---

## Security

- Commissioner authority is a **custom claim** on the Firebase ID token,
  stamped server-side by `api/cron.js`. It is never a client-writable field.
- `firestore.rules` is checked in, but **it is a reconstruction of the intended
  model, not an export of what is deployed**. There is no `firebase.json` here,
  so nothing deploys it automatically. Read its header before touching
  production, and run
  `node scripts/backfill-transaction-teamid.mjs` first — the transaction
  ownership rules key on `teamId`, and rows predating that column need it
  filled in. The script is a dry run unless given `--apply`.
- Service-account JSON must never be committed; `.gitignore` covers the usual
  filenames.
- `VITE_*` values are inlined into the browser bundle and are public by design.
  Firestore rules and App Check are what protect the data.
