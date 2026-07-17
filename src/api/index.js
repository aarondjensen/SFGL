// Re-export storage
export { storage } from './storage';

// Export Firebase APIs (replaces Supabase)
export {
  db,
  playersApi,
  playerRankingsApi,
  teamsApi,
  tournamentsApi,
  transactionsApi,
  settingsApi,
  playerStatsApi,
  headshotsApi,
  draftStateApi,
  draftPicksApi,
  sfglDataApi,
  globalPlayerStatsApi,
  playerRegistryApi,
  tournamentResultsApi,
} from './firebase';
