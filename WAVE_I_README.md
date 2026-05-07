# Wave I — Foundation + AdminView Refactor

**18 files** total in `sfgl-fixes/`. Drop them into matching paths in your repo, commit, push to GitHub, let Vercel deploy.

---

## What goes where

```
sfgl-fixes/index.html                                   →  index.html
sfgl-fixes/src/theme.js                                 →  src/theme.js
sfgl-fixes/src/app-global.css                           →  src/app-global.css
sfgl-fixes/src/api/firebase.js                          →  src/api/firebase.js
sfgl-fixes/src/utils/sharedHelpers.js                   →  src/utils/sharedHelpers.js   (NEW)
sfgl-fixes/src/pages/PullToRefresh.jsx                  →  src/pages/PullToRefresh.jsx
sfgl-fixes/src/pages/DialogContext.jsx                  →  src/pages/DialogContext.jsx
sfgl-fixes/src/pages/DraftModal.jsx                     →  src/pages/DraftModal.jsx
sfgl-fixes/src/pages/AdminView.jsx                      →  src/pages/AdminView.jsx
sfgl-fixes/src/pages/admin/CollapsibleGroup.jsx         →  src/pages/admin/CollapsibleGroup.jsx       (NEW)
sfgl-fixes/src/pages/admin/adminStyles.js               →  src/pages/admin/adminStyles.js             (NEW)
sfgl-fixes/src/pages/admin/processTournamentData.js     →  src/pages/admin/processTournamentData.js   (NEW)
sfgl-fixes/src/pages/admin/MergePlayersPanel.jsx        →  src/pages/admin/MergePlayersPanel.jsx      (NEW)
sfgl-fixes/src/pages/admin/TournamentResultsPanel.jsx   →  src/pages/admin/TournamentResultsPanel.jsx (NEW)
sfgl-fixes/src/pages/admin/WaiverProcessingPanel.jsx    →  src/pages/admin/WaiverProcessingPanel.jsx  (NEW)
sfgl-fixes/src/pages/admin/SwingWinnerPanel.jsx         →  src/pages/admin/SwingWinnerPanel.jsx       (NEW)
sfgl-fixes/src/pages/admin/DataSyncPanel.jsx            →  src/pages/admin/DataSyncPanel.jsx          (NEW)
sfgl-fixes/src/pages/admin/LivIneligiblePanel.jsx       →  src/pages/admin/LivIneligiblePanel.jsx     (NEW)
sfgl-fixes/src/pages/admin/ManagerAccountsPanel.jsx     →  src/pages/admin/ManagerAccountsPanel.jsx   (NEW)
sfgl-fixes/src/pages/admin/SeasonSettingsPanel.jsx      →  src/pages/admin/SeasonSettingsPanel.jsx    (NEW)
```

You'll need to create the new `src/pages/admin/` folder if it doesn't exist.

---

## Important: one tiny App.jsx edit

In `src/App.jsx`, around **line 341**, change:

```jsx
<PullToRefresh onRefresh={refetch}>
```

to just:

```jsx
<PullToRefresh>
```

(The `onRefresh` prop has been dead for several waves — `PullToRefresh` does a full page reload, not an in-place refetch. Wave I removes the prop entirely so nothing breaks if it's left in, but this keeps it clean.)

That's the only change to App.jsx — everything else stays the same.

---

## What this delivers

### Foundation
- `utils/sharedHelpers.js` — single source of truth for `normalizeNordic`, ET timezone helpers (replaces the broken hand-rolled `etOffset = -4` math that was wrong half the year), swing helpers (`getSwingTournaments`, `getSwingPot`, `getSwingLeader`), and `buildEffectiveRoster`.
- `theme.js` — added `btnSuccess`, `pillBase/Success/Danger/Gold` for next wave's button standardisation.
- `firebase.js` — `transactionsApi.getById` now actually exists (TransactionsView calls it as `getById?.()`, which silently no-oped before).
- `app-global.css` — toast container respects iOS safe-area, focus-visible standardisation, prefers-reduced-motion respect.
- `index.html` — preconnect to `a.espncdn.com` (saves ~150-250ms on first headshot).

### Drop-in fixes
- `PullToRefresh.jsx` — dead `onRefresh` prop removed.
- `DraftModal.jsx` — fixed import from `'../api'` (the barrel — inconsistent with rest of project) to `'../api/firebase'` (direct, used everywhere else).
- `DialogContext.jsx` — toast container now has `sfgl-toast-container` class for CSS-driven safe-area padding.

### AdminView splitting
The 1615-line `AdminView.jsx` is now ~115 lines that orchestrate 9 panel components in 4 collapsible groups. Internal state has been pushed down into each panel — the orchestrator only passes data, not setState.

| Old (lines) | New (lines) | Now lives in |
|---|---|---|
| 1615 | 115 | `pages/AdminView.jsx` (orchestrator) |
| | 75 | `pages/admin/CollapsibleGroup.jsx` |
| | 100 | `pages/admin/adminStyles.js` |
| | 145 | `pages/admin/processTournamentData.js` |
| | 200 | `pages/admin/MergePlayersPanel.jsx` |
| | 280 | `pages/admin/TournamentResultsPanel.jsx` |
| | 290 | `pages/admin/WaiverProcessingPanel.jsx` |
| | 130 | `pages/admin/SwingWinnerPanel.jsx` |
| | 200 | `pages/admin/DataSyncPanel.jsx` |
| | 145 | `pages/admin/LivIneligiblePanel.jsx` |
| | 130 | `pages/admin/ManagerAccountsPanel.jsx` |
| | 220 | `pages/admin/SeasonSettingsPanel.jsx` |

Each panel is now small enough to review and edit in isolation. Future bugs will be much easier to find.

---

## How to test

1. Drop in the files, commit, push.
2. Once Vercel deploys, hit Commish tab.
3. Verify each of the 4 groups expands/collapses (state persisted between refreshes).
4. Verify each section *visually* matches what was there before (no UI regressions).
5. Spot-test a couple of admin actions — fetch a tournament, sync OWGR, etc.

If anything looks wrong: rollback the commit. Each panel is now small enough that I can fix it surgically in a follow-up.

---

## What's NOT in Wave I (coming in Waves J + K)

- **RostersView refactor** (1235 lines → split into pieces, replace 90s polling with onSnapshot subscriptions) — Wave J
- **TransactionsView refactor** (1270 lines → extract EditTransactionModal + AddManualTransactionPanel, memoise filtered/sorted) — Wave K
- **Final UI polish**: button standardisation across views, headshot color legend, mulligan label sizing, empty-state consistency, "logo as scroll-to-top" — Wave K

Deploy Wave I, confirm everything still works, and I'll start Wave J.
