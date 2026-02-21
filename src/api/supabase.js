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
        map[p.name] = `https://pga-tour-res.cloudinary.com/image/upload/c_thumb,g_face,z_0.7,q_auto,f_auto,dpr_2.0,w_96,h_96/headshots_${p.pga_tour_id}`;
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
 * GLOBAL PLAYER STATS API
 * Stores { [playerName]: { eventsPlayed, cutsMade, pgaTourEarnings } }
 * as a single JSON blob in league_settings under key 'global_player_stats'.
 * This ensures Tour $ column data is visible to all managers.
 * ============================================================================
 */
export const globalPlayerStatsApi = {
  async get() {
    const { data, error } = await supabase
      .from('league_settings')
      .select('value')
      .eq('key', 'global_player_stats')
      .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data?.value || {};
  },

  async set(statsObject) {
    const { data, error } = await supabase
      .from('league_settings')
      .upsert({ key: 'global_player_stats', value: statsObject })
      .select();
    if (error) throw error;
    return data;
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
export const managerAuthApi = {
  async login(email, password) {
    const { data: team, error: teamError } = await supabase
      .from('teams')
      .select('*')
      .eq('manager_email', email)
      .single();
    
    if (teamError || !team) throw new Error('Invalid email or password');
    if (team.manager_password_hash !== password) throw new Error('Invalid email or password');

    const sessionToken = crypto.randomUUID();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 60);

    const { data: session, error: sessionError } = await supabase
      .from('manager_sessions')
      .insert({
        team_id: team.id,
        session_token: sessionToken,
        is_commissioner: false,
        expires_at: expiresAt.toISOString(),
      })
      .select()
      .single();

    if (sessionError) throw sessionError;

    localStorage.setItem('manager_session', sessionToken);
    localStorage.setItem('manager_team_id', team.id);

    return { team, sessionToken };
  },

  async loginCommissioner(password) {
    const { data } = await supabase
      .from('league_settings')
      .select('value')
      .eq('key', 'commissioner_password')
      .single();

    if (!data || data.value !== password) throw new Error('Invalid commissioner password');

    const sessionToken = crypto.randomUUID();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 60);

    await supabase
      .from('manager_sessions')
      .insert({
        team_id: null,
        session_token: sessionToken,
        is_commissioner: true,
        expires_at: expiresAt.toISOString(),
      });

    localStorage.setItem('manager_session', sessionToken);
    localStorage.setItem('is_commissioner', 'true');

    return { isCommissioner: true, sessionToken };
  },

  async getCurrentSession() {
    const sessionToken = localStorage.getItem('manager_session');
    if (!sessionToken) return null;

    const { data, error } = await supabase
      .from('manager_sessions')
      .select('*, teams(*)')
      .eq('session_token', sessionToken)
      .gt('expires_at', new Date().toISOString())
      .single();

    if (error || !data) {
      localStorage.removeItem('manager_session');
      localStorage.removeItem('manager_team_id');
      localStorage.removeItem('is_commissioner');
      return null;
    }

    return data;
  },

  async logout() {
    const sessionToken = localStorage.getItem('manager_session');
    if (sessionToken) {
      await supabase.from('manager_sessions').delete().eq('session_token', sessionToken);
    }
    localStorage.removeItem('manager_session');
    localStorage.removeItem('manager_team_id');
    localStorage.removeItem('is_commissioner');
  },

  async assignManagerToTeam(teamId, email, password) {
    const { data, error } = await supabase
      .from('teams')
      .update({ manager_email: email, manager_password_hash: password })
      .eq('id', teamId)
      .select();
    if (error) throw error;
    return data;
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

/**
 * ============================================================================
 * TOURNAMENT RESULTS API
 * Stores processed tournament results in Supabase so all managers can access
 * historical data without relying on localStorage.
 *
 * Table: tournament_results
 *   id              uuid primary key default gen_random_uuid()
 *   tournament_name text not null
 *   season          int  not null default 2026
 *   processed_at    timestamptz not null default now()
 *   is_manual_entry boolean not null default false
 *   team_results    jsonb not null   -- { [teamId]: { totalEarnings, rank, players[], bonuses } }
 *   earnings_map    jsonb not null   -- { [playerName]: earnings } full field
 *   round_leaders   jsonb not null   -- { round1: [], round2: [], round3: [] }
 *   meta            jsonb            -- future use
 *
 * SQL to create (run in Supabase SQL editor):
 *
 *   create table tournament_results (
 *     id              uuid primary key default gen_random_uuid(),
 *     tournament_name text not null,
 *     season          int  not null default 2026,
 *     processed_at    timestamptz not null default now(),
 *     is_manual_entry boolean not null default false,
 *     team_results    jsonb not null default '{}'::jsonb,
 *     earnings_map    jsonb not null default '{}'::jsonb,
 *     round_leaders   jsonb not null default '{}'::jsonb,
 *     meta            jsonb,
 *     unique (tournament_name, season)
 *   );
 *
 *   -- Allow all authenticated and anon reads; restrict writes to service role
 *   alter table tournament_results enable row level security;
 *   create policy "Public read" on tournament_results for select using (true);
 *   create policy "Service write" on tournament_results for all using (true);
 * ============================================================================
 */
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
