# SFGL — working notes for Claude

`README.md` explains the project: deploy targets, data flow, and the traps.
This file is the workflow plus the rules that are easy to break without
noticing.

## Git workflow

**Do not open pull requests.** Merge finished work straight into `main`.

The standing instruction is: branch, commit, merge to `main`, push. No PR, no
review gate, no waiting for approval. If a session's setup names a feature
branch to develop on, still finish by merging that branch into `main` and
pushing `main` — leaving work on a branch is not "done".

```
git checkout -b <branch>          # work here
git commit                        # commit as you go
git checkout main
git merge <branch>
git push -u origin main
```

Merging to `main` is what makes a change real: **Vercel deploys `main`**. Code
sitting on a branch is not live, no matter how finished it is. A change isn't
delivered until `main` has it.

Bring `main` into a long-running branch (`git merge main`) before merging back,
so conflicts surface on the branch rather than on `main`.

## Deploy targets

Three deploy targets that cannot import from each other:

- `src/` — the Vite-bundled browser app. Can import from `api/`.
- `api/` — Vercel serverless functions. **Cannot** import from `src/` — Vercel
  uploads only `api/`, so such an import passes lint, passes the build, and
  crashes in production. Files starting with `_` (e.g. `api/_league.js`) are
  shared imports, not routes, and don't count against the Hobby-plan
  12-function cap.
- `scripts/` — Node test and maintenance scripts, run by hand.

The native iOS/Android apps are Capacitor shells that live-load
`https://www.sfglgolf.com` (see `capacitor.config.ts`), so a Vercel deploy
reaches phones too — no app-store resubmission needed for web changes.

**Shared logic goes in `api/`, which is the only directory both the browser and
the functions can reach.** This used to work the other way — logic was copied,
and each copy carried a `KEEP IN SYNC` comment naming its twin. Every one of
those pairs drifted, and each drift produced a bug where the browser and the
cron disagreed about the same league. Do not add a new one.

- `api/_league.js` — season, swings, the ET clock, waiver cutoff, transaction→team matching
- `api/_rules.js` — bonuses, segments, fees, the pot, roster replay, the swing award
- `api/_playerNames.js` — name identity (`nameKey`, `NameSet`, `NameMap`, `namesMatch`)
- `api/_constants.js` — shared server constants

## Hard constraints

**Never compare golfer names with `===` or a normalized key.** Use `NameSet`,
`NameMap`, or `namesMatch` from `api/_playerNames.js`. `nameKey` compares
strings, not identities.

**Never `orderBy('start_date')`.** Firestore drops documents missing the ordered
field. Sort in JS. And `start_date` is an ordering field, not a real date — use
`resolveTournamentStart`.

**Never build a date from a date-only string with `new Date(str)`.** That is UTC
midnight, i.e. the previous day west of Greenwich. Anchor at noon UTC, or use
the shared resolvers.

**All league time is ET.** `getETNow` / `getETClock` from `api/_league.js`.

**Firebase is initialized in exactly one place.** `src/api/_init.js` exports
`app`, `db`, `auth` and `firebaseConfig`, and it is what configures App Check.
Never call `initializeApp` elsewhere, and never reach for the app via
`getApps()[0]` — both patterns existed here and both made App Check's presence
depend on which module the bundler evaluated first.

## House style

- New modals use `<BottomSheet>`. It portals, traps focus, and locks scroll.
  Hand-rolling a fixed overlay breaks under `PullToRefresh`'s transform.
- Clickable non-buttons use `activatable()` from `src/utils/a11y.js`.
- Colours and font sizes come from `src/theme.js`. No raw `rgba(...)`, no raw
  pixel font sizes.
- A transaction's team is `teamId`; `team` is an editable display name.
- Comments explain *why*, especially when the obvious-looking alternative is
  wrong. Match the density already in the file.

## Checks before merging

```
npm run lint                                  # 0 errors; the repo carries pre-existing warnings
npm run build                                 # must succeed AND emit no warnings
for f in scripts/test-*.mjs; do node "$f"; done
```

The build being warning-free is load-bearing: circular-chunk and
"dynamically imported but also statically imported" warnings are how the two
bundle regressions in this repo's history announced themselves.

`scripts/test-*.mjs` are plain Node scripts — no runner, no config. Several are
**consistency guards** that read the source and fail when two places that must
agree stop agreeing (the colour palette, the font scale, Firebase
initialization, the stale-data collection lists, the chunks on the first-load
critical path). When one fails, make the sources agree — do not relax the
guard.

New behaviour that could silently diverge between client and server, or between
local state and Firestore, should come with a test. That is the failure mode
this codebase actually has.

## Do not

- Add a cache-buster to `/api/field`. It is CDN-cached on purpose.
- Use `teamsApi.setAll` for ordinary edits — it persists the caller's whole
  in-memory array and reverts other managers' concurrent changes.
- Deploy `firestore.rules` without reading its header. It is a reconstruction
  of the intended model, not an export of what is live.
