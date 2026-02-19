import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

/**
 * ============================================================================
 * PLAYERS API - Consolidated player data (rankings, headshots, stats)
 * ============================================================================
 */
export const playersApi = {
  /**
   * Get all players
   */
  async getAll() {
    const { data, error } = await supabase
      .from('players')
      .select('*')
      .order('world_rank', { ascending: true, nullsLast: true });
    
    if (error) throw error;
    return data || [];
  },

  /**
   * Get single player by name
   */
  async getByName(name) {
    const { data, error } = await supabase
      .from('players')
      .select('*')
      .eq('name', name)
      .single();
    
    if (error && error.code !== 'PGRST116') throw error;
    return data;
  },

  /**
   * Upsert multiple players (used for OWGR sync)
   */
  async upsertMany(players) {
    const rows = players.map(p => ({
      name: p.name,
      world_rank: p.worldRank || null,
      pga_tour_id: p.pgaTourId || null,
      headshot_url: p.headshotUrl || null,
      career_stats: p.stats || {},
      is_liv: p.isLiv || false,
    }));

    const { data, error } = await supabase
      .from('players')
      .upsert(rows, { onConflict: 'name' })
      .select();
    
    if (error) throw error;
    
    // Update metadata timestamp
    const timestamp = Date.now();
    await supabase
      .from('app_metadata')
      .upsert({ 
        key: 'players_last_updated', 
        value: timestamp.toString() 
      });
    
    return data;
  },

  /**
   * Update single player
   */
  async update(name, updates) {
    const updateData = {};
    if (updates.worldRank !== undefined) updateData.world_rank = updates.worldRank;
    if (updates.pgaTourId !== undefined) updateData.pga_tour_id = updates.pgaTourId;
    if (updates.headshotUrl !== undefined) updateData.headshot_url = updates.headshotUrl;
    if (updates.stats !== undefined) updateData.career_stats = updates.stats;
    if (updates.isLiv !== undefined) updateData.is_liv = updates.isLiv;

    const { data, error } = await supabase
      .from('players')
      .update(updateData)
      .eq('name', name)
      .select();
    
    if (error) throw error;
    return data;
  },

  /**
   * Get players formatted for app (backward compatible with old format)
   */
  async getAllForApp() {
    const players = await this.getAll();
    return players.map(p => ({
      name: p.name,
      worldRank: p.world_rank,
      pgaTourId: p.pga_tour_id,
      headshotUrl: p.headshot_url,
      stats: p.career_stats,
      isLiv: p.is_liv,
    }));
  },

  /**
   * Get headshots map (for backward compatibility)
   */
  async getHeadshotsMap() {
    const players = await this.getAll();
    const map = {};
    players.forEach(p => {
      if (p.headshot_url) {
        map[p.name] = p.headshot_url;
      } else if (p.pga_tour_id) {
        // Try ESPN CDN URL format
        map[p.name] = `https://a.espncdn.com/combiner/i?img=/i/headshots/golf/players/full/${p.pga_tour_id}.png&w=96&h=96`;
      }
    });
    return map;
  },

  /**
   * Get stats map (for backward compatibility)
   */
  async getStatsMap() {
    const players = await this.getAll();
    const map = {};
    players.forEach(p => {
      if (p.career_stats && Object.keys(p.career_stats).length > 0) {
        map[p.name] = p.career_stats;
      }
    });
    return map;
  },

  /**
   * Get last updated timestamp
   */
  async getLastUpdated() {
    const { data } = await supabase
      .from('app_metadata')
      .select('value')
      .eq('key', 'players_last_updated')
      .single();
    return data?.value || null;
  },

  /**
   * Set last updated timestamp
   */
  async setLastUpdated(timestamp) {
    await supabase
      .from('app_metadata')
      .upsert({ key: 'players_last_updated', value: timestamp });
  },
};

/**
 * ============================================================================
 * LEGACY APIs - Backward compatibility wrappers
 * These delegate to the new consolidated playersApi
 * ============================================================================
 */
export const playerRankingsApi = {
  async getAll() {
    return await playersApi.getAllForApp();
  },
  async updateAll(players) {
    return await playersApi.upsertMany(players);
  },
  async getLastUpdated() {
    return await playersApi.getLastUpdated();
  },
};

export const headshotsApi = {
  async getAll() {
    return await playersApi.getHeadshotsMap();
  },
  async setAll(headshotsObject) {
    console.warn('headshotsApi.setAll is deprecated - headshots are now part of players table');
  },
};

export const playerStatsApi = {
  async getAll() {
    return await playersApi.getStatsMap();
  },
  async set(playerName, stats) {
    return await playersApi.update(playerName, { stats });
  },
  async setAll(statsObject) {
    console.warn('playerStatsApi.setAll is deprecated - stats are now part of players table');
  },
};

/**
 * ============================================================================
 * LIV ROSTER API
 * ============================================================================
 */
export const livRosterApi = {
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

  async setAll(players) {
    try {
      const { error: deleteError } = await supabase
        .from('liv_roster')
        .delete()
        .neq('id', '00000000-0000-0000-0000-000000000000');
      
      if (deleteError) throw deleteError;
      
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

  async addPlayer(playerName) {
    const { data, error } = await supabase
      .from('liv_roster')
      .insert({ player_name: playerName })
      .select();
    
    if (error) throw error;
    return data;
  },

  async removePlayer(playerName) {
    const { error } = await supabase
      .from('liv_roster')
      .delete()
      .eq('player_name', playerName);
    
    if (error) throw error;
  },
};

/**
 * ============================================================================
 * TEAMS API
 * ============================================================================
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
 * ============================================================================
 * TOURNAMENTS API
 * ============================================================================
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
 * ============================================================================
 * TRANSACTIONS API
 * ============================================================================
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
 * ============================================================================
 * SETTINGS API
 * ============================================================================
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
 * ============================================================================
 * DRAFT STATE API
 * ============================================================================
 */
export const draftStateApi = {
  async get() {
    const { data, error} = await supabase
      .from('draft_state')
      .select('*')
      .eq('league_id', 'default')
      .single();
    
    if (error && error.code !== 'PGRST116') throw error;
    return data;
  },

  async save(state) {
    const { data, error } = await supabase
      .from('draft_state')
      .upsert({
        league_id: 'default',
        phase: state.phase,
        draft_order: state.draftOrder,
        keeper_team_index: state.keeperTeamIndex,
        keepers: state.keepers,
        current_team_index: state.currentTeamIndex,
        current_round: state.currentRound,
        drafted_players: state.draftedPlayers,
        is_complete: state.isComplete || false,
      }, { onConflict: 'league_id' })
      .select();
    
    if (error) throw error;
    return data;
  },

  async clear() {
    const { error } = await supabase
      .from('draft_state')
      .delete()
      .eq('league_id', 'default');
    
    if (error) throw error;
  },
};
