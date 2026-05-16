// src/api/firebase.js
// ============================================================================
// Barrel re-export. All existing consumer imports keep working unchanged:
//   import { playersApi } from '../api/firebase';
//   import { teamsApi, transactionsApi } from '../api/firebase';
//
// The actual implementations now live in per-domain sibling files. This
// barrel exists so consumers never need to know which domain file holds
// which API — they all import from one canonical location.
//
// Batch 5 split (April-May 2026): firebase.js used to be a 1000-line
// monolith. Split into:
//   _init.js         — Firebase app + db init
//   _helpers.js      — shared private helpers (_getAllOrdered, _subscribeOrdered)
//   players.js       — playersApi + playerRankingsApi + headshotsApi + playerStatsApi
//   teams.js         — teamsApi
//   tournaments.js   — tournamentsApi + tournamentResultsApi
//   transactions.js  — transactionsApi
//   admin.js         — settingsApi + draftStateApi + managerAuthApi + draftPicksApi
//   data.js          — sfglDataApi + globalPlayerStatsApi (the /sfgl_data/{key} collection)
//
// Firestore collections (unchanged):
//   players, app_metadata, teams, tournaments, transactions, league_settings,
//   draft_state, draft_picks, tournament_results, sfgl_data
// ============================================================================

// `db` is exported from _init so consumers that need the raw Firestore
// instance (none today, but kept for parity with the original API surface)
// can still get it.
export { db } from './_init';

// Domain APIs — order chosen alphabetically for predictable reading order.
export {
  playersApi,
  playerRankingsApi,
  headshotsApi,
  playerStatsApi,
} from './players';

export { teamsApi } from './teams';

export {
  tournamentsApi,
  tournamentResultsApi,
} from './tournaments';

export { transactionsApi } from './transactions';

export {
  settingsApi,
  draftStateApi,
  managerAuthApi,
  draftPicksApi,
} from './admin';

export {
  sfglDataApi,
  globalPlayerStatsApi,
} from './data';
