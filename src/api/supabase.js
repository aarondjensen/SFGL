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

/**
 * ============================================================================
 * MANAGER AUTH API
 * ============================================================================
 */
// ── Manager Auth ─────────────────────────────────────────────────────────────
// Credentials are stored in sfgl_data under key 'manager_credentials' as:
//   { [teamId]: { name: string, password: string } }
// Sessions are stored only in localStorage (no Supabase table needed).
const CREDS_KEY = 'manager_credentials';

export const managerAuthApi = {
  // Read all credentials from sfgl_data
  async _getCreds() {
    const creds = await sfglDataApi.get(CREDS_KEY);
    return creds || {};
  },

  // Set credentials for one team (called from AdminView → Manager Logins)
  async setCredentials(teamId, name, password) {
    const creds = await this._getCreds();
    creds[teamId] = { name: name.trim(), password: password.trim() };
    await sfglDataApi.set(CREDS_KEY, creds);
  },

  // Login: match name (case-insensitive) + password against stored credentials
  async login(name, password) {
    const creds = await this._getCreds();
    const entry = Object.entries(creds).find(([, c]) =>
      c.name.toLowerCase() === name.trim().toLowerCase() &&
      c.password === password.trim()
    );
    if (!entry) throw new Error('Invalid name or password');
    const [teamId] = entry;
    localStorage.setItem('manager_team_id', teamId);
    localStorage.removeItem('is_commissioner');
    return { teamId };
  },

  // Restore session from localStorage — returns teamId or null
  async getCurrentSession() {
    const teamId = localStorage.getItem('manager_team_id');
    if (!teamId) return null;
    return { teamId };
  },

  async logout() {
    localStorage.removeItem('manager_team_id');
    localStorage.removeItem('is_commissioner');
  },
};

/**
 * ============================================================================
 * DRAFT PICKS API
 * ============================================================================
 */
export const draftPicksApi = {
  async getAllForDraft(draftId = 'default') {
    const { data, error } = await supabase
      .from('draft_picks')
      .select('*')
      .eq('draft_id', draftId)
      .order('pick_number', { ascending: true });
    if (error) throw error;
    return data || [];
  },

  async addPick(pick) {
    const { data, error } = await supabase
      .from('draft_picks')
      .insert({
        draft_id: pick.draftId || 'default',
        pick_number: pick.pickNumber,
        round_number: pick.roundNumber,
        team_id: pick.teamId,
        team_name: pick.teamName,
        player_name: pick.playerName,
        player_type: pick.playerType,
        picked_by_manager: pick.pickedByManager !== false,
      })
      .select();
    if (error) throw error;
    return data;
  },

  async deleteLastPick(draftId = 'default') {
    const { data: picks } = await supabase
      .from('draft_picks')
      .select('*')
      .eq('draft_id', draftId)
      .order('pick_number', { ascending: false })
      .limit(1);
    if (!picks || picks.length === 0) return null;
    const lastPick = picks[0];
    await supabase.from('draft_picks').delete().eq('id', lastPick.id);
    return lastPick;
  },
};

export const tournamentResultsApi = {
  /**
   * Save (upsert) results for a single tournament.
   * Called immediately after processing results in AdminView.
   */
  async save({ tournamentName, season = 2026, teamResults, earningsMap, roundLeaders, fullLineups = {}, rosterSnapshots = {}, isManualEntry = false }) {
    // earningsMap may be a plain object or a JS Map — normalise to plain object
    const earningsObj = earningsMap instanceof Map
      ? Object.fromEntries(earningsMap)
      : (earningsMap || {});

    const { data, error } = await supabase
      .from('tournament_results')
      .upsert({
        tournament_name: tournamentName,
        season,
        processed_at: new Date().toISOString(),
        is_manual_entry: isManualEntry,
        team_results: teamResults || {},
        earnings_map: earningsObj,
        round_leaders: roundLeaders || {},
        full_lineups: fullLineups,       // { [teamId]: [playerName, ...] }
        roster_snapshots: rosterSnapshots, // { [teamId]: [playerObj, ...] }
      }, { onConflict: 'tournament_name,season' })
      .select();

    if (error) throw error;
    return data?.[0];
  },

  /**
   * Get results for a single tournament.
   */
  async getByName(tournamentName, season = 2026) {
    const { data, error } = await supabase
      .from('tournament_results')
      .select('*')
      .eq('tournament_name', tournamentName)
      .eq('season', season)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    if (!data) return null;
    return {
      tournamentName: data.tournament_name,
      season: data.season,
      processedAt: data.processed_at,
      isManualEntry: data.is_manual_entry,
      teamResults: data.team_results,
      earningsMap: data.earnings_map,
      roundLeaders: data.round_leaders,
      fullLineups: data.full_lineups || {},
      rosterSnapshots: data.roster_snapshots || {},
    };
  },

  /**
   * Get all results for a season, ordered by processed_at.
   * Returns in the shape ResultsView expects: { teams: {}, earningsMap: {} }
   */
  async getAllForSeason(season = 2026) {
    const { data, error } = await supabase
      .from('tournament_results')
      .select('*')
      .eq('season', season)
      .order('processed_at', { ascending: true });

    if (error) throw error;
    return (data || []).map(row => ({
      tournamentName: row.tournament_name,
      season: row.season,
      processedAt: row.processed_at,
      isManualEntry: row.is_manual_entry,
      // Shape matches tournament.results used throughout the app
      results: {
        teams: row.team_results,
        earningsMap: row.earnings_map,
        roundLeaders: row.round_leaders,
        fullLineups: row.full_lineups || {},
        rosterSnapshots: row.roster_snapshots || {},
      },
    }));
  },

  /**
   * Delete results for a tournament (used on season reset).
   */
  async deleteByName(tournamentName, season = 2026) {
    const { error } = await supabase
      .from('tournament_results')
      .delete()
      .eq('tournament_name', tournamentName)
      .eq('season', season);

    if (error) throw error;
  },

  /**
   * Delete all results for a season (used on full season reset).
   */
  async deleteAllForSeason(season = 2026) {
    const { error } = await supabase
      .from('tournament_results')
      .delete()
      .eq('season', season);

    if (error) throw error;
  },
};

/**
 * ============================================================================
 * SFGL DATA API
 * Reads/writes the sfgl_data key-value table — the same table that the app's
 * internal storage layer uses. This is the source of truth for teams,
 * tournaments, transactions, settings, and globalPlayerStats.
 * ============================================================================
 */


/**
 * ============================================================================
 * SFGL DATA API
 * Reads/writes the sfgl_data key-value table — the same table that the app's
 * internal storage layer uses. This is the source of truth for teams,
 * tournaments, transactions, settings, and globalPlayerStats.
 * ============================================================================
 */
export const sfglDataApi = {
  async get(key) {
    const { data, error } = await supabase
      .from('sfgl_data')
      .select('value')
      .eq('key', key)
      .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data?.value ?? null;
  },

  async set(key, value) {
    const { error } = await supabase
      .from('sfgl_data')
      .upsert({ key, value }, { onConflict: 'key' });
    if (error) throw error;
  },

  async getMany(keys) {
    const { data, error } = await supabase
      .from('sfgl_data')
      .select('key, value')
      .in('key', keys);
    if (error) throw error;
    const result = {};
    (data || []).forEach(row => { result[row.key] = row.value; });
    return result;
  },
};

// ── Compatibility stubs — exported for files that still import these ──────────
// The actual data now lives in sfgl_data via sfglDataApi.


/**
 * globalPlayerStatsApi - reads/writes global player stats via sfgl_data
 */
export const globalPlayerStatsApi = {
  async get() {
    const result = await sfglDataApi.get('fantasy-golf-global-stats');
    return result || {};
  },
  async set(stats) {
    await sfglDataApi.set('fantasy-golf-global-stats', stats);
  },
};
