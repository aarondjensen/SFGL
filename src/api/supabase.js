import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

/**
 * Player Rankings API
 * Stores OWGR rankings in Supabase for cross-device sync
 */

export const playerRankingsApi = {
  /**
   * Fetch all player rankings from Supabase
   */
  async getAll() {
    const { data, error } = await supabase
      .from('player_rankings')
      .select('*')
      .order('world_rank', { ascending: true });
    
    if (error) {
      console.error('Error fetching player rankings:', error);
      throw error;
    }
    
    return data || [];
  },

  /**
   * Update all player rankings (replaces entire list)
   */
  async updateAll(players) {
    try {
      // Delete all existing rankings
      const { error: deleteError } = await supabase
        .from('player_rankings')
        .delete()
        .neq('id', '00000000-0000-0000-0000-000000000000'); // Delete all rows
      
      if (deleteError) throw deleteError;
      
      // Insert new rankings
      const rows = players.map(p => ({
        name: p.name,
        world_rank: p.worldRank,
        pga_tour_id: p.pgaTourId || null,
      }));
      
      const { data, error: insertError } = await supabase
        .from('player_rankings')
        .insert(rows)
        .select();
      
      if (insertError) throw insertError;
      
      // Update metadata
      await supabase
        .from('app_metadata')
        .upsert({
          key: 'player_rankings_last_updated',
          value: new Date().toISOString(),
        });
      
      return data;
    } catch (error) {
      console.error('Error updating player rankings:', error);
      throw error;
    }
  },

  /**
   * Get last updated timestamp
   */
  async getLastUpdated() {
    const { data, error } = await supabase
      .from('app_metadata')
      .select('value')
      .eq('key', 'player_rankings_last_updated')
      .single();
    
    if (error && error.code !== 'PGRST116') { // Ignore "not found" error
      console.error('Error fetching last updated:', error);
    }
    
    return data?.value || null;
  },
};

/**
 * LIV Roster API
 * Stores LIV Golf roster in Supabase for cross-device sync
 */
export const livRosterApi = {
  /**
   * Get all LIV players
   */
  async getAll() {
    const { data, error } = await supabase
      .from('liv_roster')
      .select('player_name')
      .order('player_name', { ascending: true });
    
    if (error) {
      console.error('Error fetching LIV roster:', error);
      throw error;
    }
    
    return (data || []).map(row => row.player_name);
  },

  /**
   * Replace entire LIV roster
   */
  async setAll(players) {
    try {
      // Delete all existing players
      const { error: deleteError } = await supabase
        .from('liv_roster')
        .delete()
        .neq('id', '00000000-0000-0000-0000-000000000000');
      
      if (deleteError) throw deleteError;
      
      // Insert new roster
      const rows = players.map(name => ({ player_name: name }));
      
      const { data, error: insertError } = await supabase
        .from('liv_roster')
        .insert(rows)
        .select();
      
      if (insertError) throw insertError;
      
      return data;
    } catch (error) {
      console.error('Error updating LIV roster:', error);
      throw error;
    }
  },

  /**
   * Add a single player
   */
  async addPlayer(playerName) {
    const { data, error } = await supabase
      .from('liv_roster')
      .insert({ player_name: playerName })
      .select();
    
    if (error) throw error;
    return data;
  },

  /**
   * Remove a single player
   */
  async removePlayer(playerName) {
    const { error } = await supabase
      .from('liv_roster')
      .delete()
      .eq('player_name', playerName);
    
    if (error) throw error;
  },
};

/**
 * Teams API
 */
export const teamsApi = {
  async getAll() {
    const { data, error } = await supabase
      .from('teams')
      .select('*')
      .order('name');
    if (error) throw error;
    return data || [];
  },

  async setAll(teams) {
    // Delete and recreate
    await supabase.from('teams').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    const { data, error } = await supabase.from('teams').insert(teams).select();
    if (error) throw error;
    return data;
  },

  async update(teamId, updates) {
    const { data, error } = await supabase
      .from('teams')
      .update(updates)
      .eq('id', teamId)
      .select();
    if (error) throw error;
    return data;
  },
};

/**
 * Tournaments API
 */
export const tournamentsApi = {
  async getAll() {
    const { data, error } = await supabase
      .from('tournaments')
      .select('*')
      .order('start_date');
    if (error) throw error;
    return data || [];
  },

  async setAll(tournaments) {
    await supabase.from('tournaments').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    const { data, error } = await supabase.from('tournaments').insert(tournaments).select();
    if (error) throw error;
    return data;
  },

  async update(tournamentName, updates) {
    const { data, error } = await supabase
      .from('tournaments')
      .update(updates)
      .eq('name', tournamentName)
      .select();
    if (error) throw error;
    return data;
  },
};

/**
 * Transactions API
 */
export const transactionsApi = {
  async getAll() {
    const { data, error } = await supabase
      .from('transactions')
      .select('*')
      .order('timestamp', { ascending: false });
    if (error) throw error;
    return data || [];
  },

  async add(transaction) {
    const { data, error } = await supabase
      .from('transactions')
      .insert(transaction)
      .select();
    if (error) throw error;
    return data;
  },

  async setAll(transactions) {
    await supabase.from('transactions').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    const { data, error } = await supabase.from('transactions').insert(transactions).select();
    if (error) throw error;
    return data;
  },
};

/**
 * Settings API
 */
export const settingsApi = {
  async get(key) {
    const { data, error } = await supabase
      .from('league_settings')
      .select('value')
      .eq('key', key)
      .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data?.value;
  },

  async set(key, value) {
    const { data, error } = await supabase
      .from('league_settings')
      .upsert({ key, value })
      .select();
    if (error) throw error;
    return data;
  },

  async getAll() {
    const { data, error } = await supabase
      .from('league_settings')
      .select('*');
    if (error) throw error;
    
    const settings = {};
    data?.forEach(row => {
      settings[row.key] = row.value;
    });
    return settings;
  },
};

/**
 * Global Player Stats API
 */
export const playerStatsApi = {
  async getAll() {
    const { data, error } = await supabase
      .from('global_player_stats')
      .select('*');
    if (error) throw error;
    
    const stats = {};
    data?.forEach(row => {
      stats[row.player_name] = row.stats;
    });
    return stats;
  },

  async set(playerName, stats) {
    const { data, error } = await supabase
      .from('global_player_stats')
      .upsert({ player_name: playerName, stats })
      .select();
    if (error) throw error;
    return data;
  },

  async setAll(statsObject) {
    await supabase.from('global_player_stats').delete().neq('player_name', '');
    
    const rows = Object.entries(statsObject).map(([player_name, stats]) => ({
      player_name,
      stats,
    }));
    
    const { data, error } = await supabase
      .from('global_player_stats')
      .insert(rows)
      .select();
    if (error) throw error;
    return data;
  },
};

/**
 * Headshots API
 */
export const headshotsApi = {
  async getAll() {
    const { data, error } = await supabase
      .from('player_headshots')
      .select('*');
    if (error) throw error;
    
    const headshots = {};
    data?.forEach(row => {
      headshots[row.player_name] = row.url;
    });
    return headshots;
  },

  async setAll(headshotsObject) {
    await supabase.from('player_headshots').delete().neq('player_name', '');
    
    const rows = Object.entries(headshotsObject).map(([player_name, url]) => ({
      player_name,
      url,
    }));
    
    const { data, error } = await supabase
      .from('player_headshots')
      .insert(rows)
      .select();
    if (error) throw error;
    return data;
  },
};
