// Re-export storage from wherever it currently exists
// This maintains backward compatibility
export { storage } from './storage';

// Export Supabase client and APIs
export { 
  supabase,
  playersApi,           // New consolidated API
  playerRankingsApi,    // Legacy wrapper
  livRosterApi,
  teamsApi,
  tournamentsApi,
  transactionsApi,
  settingsApi,
  playerStatsApi,       // Legacy wrapper
  headshotsApi,         // Legacy wrapper
} from './supabase';
