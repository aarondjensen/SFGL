// Re-export storage from wherever it currently exists
// This maintains backward compatibility
export { storage } from './storage';

// Export Supabase client and APIs
export { 
  supabase, 
  playerRankingsApi, 
  livRosterApi,
  teamsApi,
  tournamentsApi,
  transactionsApi,
  settingsApi,
  playerStatsApi,
  headshotsApi,
} from './supabase';
