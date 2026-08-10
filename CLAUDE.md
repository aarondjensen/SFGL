# Working in this repo

Read `README.md` first — it explains the two deploy targets, the data flow, and
the traps. This file is only the rules that are easy to break without noticing.

## Hard constraints

**`api/` must never import from `src/`.** Vercel uploads only `api/`, so such an
import passes lint, passes the build, and crashes in production. The reverse is
fine and is the whole mechanism: `src/` imports shared logic *from* `api/`.

**Shared logic goes in `api/`.** `api/_league.js` (season, swings, ET clock,
waiver cutoff), `api/_rules.js` (fees, segments, pot, roster replay),
`api/_playerNames.js` (name identity). If the client and the cron both need to
know something, there is exactly one place it may live. Do not add a "keep in
sync" comment — every pair that had one had already drifted.

**Never compare golfer names with `===` or a normalized key.** Use `NameSet`,
`NameMap`, or `namesMatch` from `api/_playerNames.js`. `nameKey` compares
strings, not identities.

**Never `orderBy('start_date')`.** Firestore drops documents missing the ordered
field. Sort in JS. And `start_date` is an ordering field, not a real date — use
`resolveTournamentStart`.

**Never build a date-only string with `new Date(str)`.** That is UTC midnight,
i.e. the previous day west of Greenwich. Anchor at noon UTC, or use the shared
resolvers.

**All league time is ET.** `getETNow` / `getETClock` from `api/_league.js`.

## House style

- New modals use `<BottomSheet>`. It portals, traps focus, and locks scroll.
  Hand-rolling a fixed overlay breaks under `PullToRefresh`'s transform.
- Clickable non-buttons use `activatable()` from `src/utils/a11y.js`.
- Colours and font sizes come from `src/theme.js`. No raw `rgba(...)`, no raw
  pixel font sizes.
- A transaction's team is `teamId`; `team` is an editable display name.
- Comments explain *why*, especially when the obvious-looking alternative is
  wrong. Match the density already in the file.

## Before you call it done

```bash
npm run lint                                  # must be 0 errors
npm run build                                 # must emit no warnings
for f in scripts/test-*.mjs; do node "$f"; done
```

The build being warning-free is load-bearing: circular-chunk and
"dynamically imported but also statically imported" warnings are how the two
bundle regressions in this repo's history announced themselves.

Several `scripts/test-*.mjs` are consistency guards that read the source and
fail when two places that must agree stop agreeing. When one fails, make the
sources agree — do not relax the guard.

New behaviour that could silently diverge between client and server, or between
local state and Firestore, should come with a test. That is the failure mode
this codebase actually has.

## Do not

- Add a cache-buster to `/api/field`. It is CDN-cached on purpose.
- Use `teamsApi.setAll` for ordinary edits — it persists the caller's whole
  in-memory array and reverts other managers' concurrent changes.
- Deploy `firestore.rules` without reading its header. It is a reconstruction,
  not an export.
