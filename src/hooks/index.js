import { useState, useCallback, useEffect, useRef } from 'react';
import { storage } from '../api';
import { playerRankingsApi } from '../api/supabase';
import { isTournamentLocked, isLineupEditingOpen, isFreeAgentWindowOpen, isWaiverWindowOpen } from '../utils';

// ============================================================================
// usePersistentState
// Keeps a state value in sync with a storage backend.
// If the storage write fails, the error is surfaced via onError rather than
// silently diverging from in-memory state.
// ============================================================================
export const usePersistentState = (storageKey, initialValue, onError) => {
  const [value, setValue] = useState(initialValue);
  const keyRef = useRef(storageKey);

  const setPersistent = useCallback(
    async (updater) => {
      setValue(prev => {
        const next = typeof updater === 'function' ? updater(prev) : updater;
        // Fire-and-forget write; errors surfaced via onError
        storage.set(keyRef.current, next).catch(err => {
          console.error(`[usePersistentState] Failed to write "${keyRef.current}":`, err);
          onError?.(err);
        });
        return next;
      });
    },
    [onError],
  );

  return [value, setValue, setPersistent];
};

// ============================================================================
// useLeague
// Central state manager for all league data. Replaces the god-component
// pattern by keeping related state together and exposing clean updaters.
// ============================================================================
export const useLeague = (STORAGE_KEYS) => {
  const [teams,             setTeams]            = useState([]);
  const [tournaments,       setTournaments]       = useState([]);
  const [transactions,      setTransactions]      = useState([]);
  const [settings,          setSettings]          = useState({ commissioner: 'Detroit Rock City', currentSegment: 'West Coast Swing' });
  const [globalPlayerStats, setGlobalPlayerStats] = useState({});
  const [allPlayers,        setAllPlayers]        = useState([]);
  const [rankingsLastUpdated, setRankingsLastUpdated] = useState(null);
  const [headshots,         setHeadshots]         = useState({});
  const [loading,           setLoading]           = useState(true);
  const [isSyncing,         setIsSyncing]         = useState(false);

  // ── Loader ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      try {
        // Import all APIs
        const { 
          teamsApi, 
          tournamentsApi, 
          transactionsApi, 
          settingsApi, 
          playerStatsApi, 
          headshotsApi,
          playerRankingsApi 
        } = await import('../api/supabase');

        console.log('[useLeague] Loading all data from Supabase...');

        // Try to load everything from Supabase first
        try {
          const [
            supabaseTeams,
            supabaseTournaments,
            supabaseTransactions,
            supabaseSettings,
            supabaseStats,
            supabaseHeadshots,
            supabaseRankings,
          ] = await Promise.all([
            teamsApi.getAll().catch(() => null),
            tournamentsApi.getAll().catch(() => null),
            transactionsApi.getAll().catch(() => null),
            settingsApi.getAll().catch(() => null),
            playerStatsApi.getAll().catch(() => null),
            headshotsApi.getAll().catch(() => null),
            playerRankingsApi.getAll().catch(() => []),
          ]);

          // Set data from Supabase (with localStorage fallback)
          if (supabaseTeams?.length > 0) {
            setTeams(supabaseTeams);
            console.log(`✓ Loaded ${supabaseTeams.length} teams from Supabase`);
          } else {
            const localTeams = await storage.get(STORAGE_KEYS.TEAMS, null);
            if (localTeams) setTeams(localTeams);
          }

          if (supabaseTournaments?.length > 0) {
            setTournaments(supabaseTournaments);
            console.log(`✓ Loaded ${supabaseTournaments.length} tournaments from Supabase`);
          } else {
            const localTournaments = await storage.get(STORAGE_KEYS.TOURNAMENTS, null);
            if (localTournaments) setTournaments(localTournaments);
          }

          if (supabaseTransactions?.length > 0) {
            setTransactions(supabaseTransactions);
            console.log(`✓ Loaded ${supabaseTransactions.length} transactions from Supabase`);
          } else {
            const localTransactions = await storage.get(STORAGE_KEYS.TRANSACTIONS, null);
            if (localTransactions) setTransactions(localTransactions);
          }

          if (supabaseSettings && Object.keys(supabaseSettings).length > 0) {
            setSettings(supabaseSettings);
            console.log(`✓ Loaded settings from Supabase`);
          } else {
            const localSettings = await storage.get(STORAGE_KEYS.SETTINGS, null);
            if (localSettings) setSettings(localSettings);
          }

          if (supabaseStats && Object.keys(supabaseStats).length > 0) {
            setGlobalPlayerStats(supabaseStats);
            console.log(`✓ Loaded ${Object.keys(supabaseStats).length} player stats from Supabase`);
          } else {
            const localStats = await storage.get(STORAGE_KEYS.GLOBAL_PLAYER_STATS, null);
            if (localStats) setGlobalPlayerStats(localStats);
          }

          if (supabaseHeadshots && Object.keys(supabaseHeadshots).length > 0) {
            setHeadshots(supabaseHeadshots);
            console.log(`✓ Loaded ${Object.keys(supabaseHeadshots).length} headshots from Supabase`);
          } else {
            const localHeadshots = await storage.get(STORAGE_KEYS.HEADSHOTS, null);
            if (localHeadshots) setHeadshots(localHeadshots);
          }

          if (supabaseRankings.length > 0) {
            setAllPlayers(supabaseRankings);
            const lastUpdated = await playerRankingsApi.getLastUpdated();
            setRankingsLastUpdated(lastUpdated);
            console.log(`✓ Loaded ${supabaseRankings.length} players from Supabase`);
          } else {
            const localRankings = await storage.get(STORAGE_KEYS.PLAYER_RANKINGS, null);
            if (localRankings?.players) {
              setAllPlayers(localRankings.players);
              setRankingsLastUpdated(localRankings.lastUpdated);
            }
          }

          console.log('[useLeague] ✓ All data loaded successfully');
        } catch (supabaseError) {
          console.error('[useLeague] Supabase load failed, using localStorage:', supabaseError);
          
          // Complete fallback to localStorage
          const [teamsData, tournamentsData, transactionsData, settingsData, statsData, headshotsData, rankingsData] =
            await Promise.all([
              storage.get(STORAGE_KEYS.TEAMS, null),
              storage.get(STORAGE_KEYS.TOURNAMENTS, null),
              storage.get(STORAGE_KEYS.TRANSACTIONS, null),
              storage.get(STORAGE_KEYS.SETTINGS, null),
              storage.get(STORAGE_KEYS.GLOBAL_PLAYER_STATS, null),
              storage.get(STORAGE_KEYS.HEADSHOTS, null),
              storage.get(STORAGE_KEYS.PLAYER_RANKINGS, null),
            ]);

          if (teamsData) setTeams(teamsData);
          if (tournamentsData) setTournaments(tournamentsData);
          if (transactionsData) setTransactions(transactionsData);
          if (settingsData) setSettings(settingsData);
          if (statsData) setGlobalPlayerStats(statsData);
          if (headshotsData) setHeadshots(headshotsData);
          if (rankingsData?.players) {
            setAllPlayers(rankingsData.players);
            setRankingsLastUpdated(rankingsData.lastUpdated);
          }
        }
      } catch (e) {
        console.error('[useLeague] Load error:', e);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Refs for stable callback dependencies ───────────────────────────────
  const teamsRef        = useRef(teams);
  const tournamentsRef  = useRef(tournaments);
  const transactionsRef = useRef(transactions);
  const settingsRef     = useRef(settings);
  const statsRef        = useRef(globalPlayerStats);
  const headshotsRef    = useRef(headshots);
  useEffect(() => { teamsRef.current = teams; }, [teams]);
  useEffect(() => { tournamentsRef.current = tournaments; }, [tournaments]);
  useEffect(() => { transactionsRef.current = transactions; }, [transactions]);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  useEffect(() => { statsRef.current = globalPlayerStats; }, [globalPlayerStats]);
  useEffect(() => { headshotsRef.current = headshots; }, [headshots]);

  // ── Persisted updaters ────────────────────────────────────────────────────
  const updateTeams = useCallback(async (next) => {
    const resolved = typeof next === 'function' ? next(teamsRef.current) : next;
    setTeams(resolved);
    try {
      setIsSyncing(true);
      const { teamsApi } = await import('../api/supabase');
      await teamsApi.setAll(resolved);
      await storage.set(STORAGE_KEYS.TEAMS, resolved);
    } catch (e) {
      console.error('[useLeague] teams write failed:', e);
      try { await storage.set(STORAGE_KEYS.TEAMS, resolved); } catch {}
    } finally {
      setIsSyncing(false);
    }
  }, [STORAGE_KEYS.TEAMS]);

  const updateTournaments = useCallback(async (next) => {
    const resolved = typeof next === 'function' ? next(tournamentsRef.current) : next;
    setTournaments(resolved);
    try {
      setIsSyncing(true);
      const { tournamentsApi } = await import('../api/supabase');
      await tournamentsApi.setAll(resolved);
      await storage.set(STORAGE_KEYS.TOURNAMENTS, resolved);
    } catch (e) {
      console.error('[useLeague] tournaments write failed:', e);
      try { await storage.set(STORAGE_KEYS.TOURNAMENTS, resolved); } catch {}
    } finally {
      setIsSyncing(false);
    }
  }, [STORAGE_KEYS.TOURNAMENTS]);

  const updateTransactions = useCallback(async (next) => {
    const resolved = typeof next === 'function' ? next(transactionsRef.current) : next;
    setTransactions(resolved);
    const { transactionsApi } = await import('../api/supabase');
    transactionsApi.setAll(resolved).catch(e =>
      console.error('[useLeague] transactions write failed:', e)
    );
    storage.set(STORAGE_KEYS.TRANSACTIONS, resolved).catch(e =>
      console.error('[useLeague] transactions backup failed:', e)
    );
  }, [STORAGE_KEYS.TRANSACTIONS]);

  const updateSettings = useCallback(async (next) => {
    const resolved = typeof next === 'function' ? next(settingsRef.current) : next;
    setSettings(resolved);
    try {
      const { settingsApi } = await import('../api/supabase');
      for (const [key, value] of Object.entries(resolved)) {
        await settingsApi.set(key, value);
      }
      await storage.set(STORAGE_KEYS.SETTINGS, resolved);
    } catch (e) {
      console.error('[useLeague] settings write failed:', e);
      try { await storage.set(STORAGE_KEYS.SETTINGS, resolved); } catch {}
    }
  }, [STORAGE_KEYS.SETTINGS]);

  const updateGlobalStats = useCallback(async (next) => {
    const resolved = typeof next === 'function' ? next(statsRef.current) : next;
    setGlobalPlayerStats(resolved);
    try {
      const { playerStatsApi } = await import('../api/supabase');
      await playerStatsApi.setAll(resolved);
      await storage.set(STORAGE_KEYS.GLOBAL_PLAYER_STATS, resolved);
    } catch (e) {
      console.error('[useLeague] stats write failed:', e);
      try { await storage.set(STORAGE_KEYS.GLOBAL_PLAYER_STATS, resolved); } catch {}
    }
  }, [STORAGE_KEYS.GLOBAL_PLAYER_STATS]);

  const updateHeadshots = useCallback(async (next) => {
    const resolved = typeof next === 'function' ? next(headshotsRef.current) : next;
    setHeadshots(resolved);
    try {
      const { headshotsApi } = await import('../api/supabase');
      await headshotsApi.setAll(resolved);
      await storage.set(STORAGE_KEYS.HEADSHOTS, resolved);
    } catch (e) {
      console.error('[useLeague] headshots write failed:', e);
      try { await storage.set(STORAGE_KEYS.HEADSHOTS, resolved); } catch {}
    }
  }, [STORAGE_KEYS.HEADSHOTS]);

  const updateRankings = useCallback(async (players) => {
    setAllPlayers(players);
    const timestamp = new Date().toISOString();
    setRankingsLastUpdated(timestamp);
    
    try {
      await playerRankingsApi.updateAll(players);
      console.log(`Saved ${players.length} players to Supabase`);
      const payload = { players, lastUpdated: timestamp };
      await storage.set(STORAGE_KEYS.PLAYER_RANKINGS, payload);
    } catch (e) {
      console.error('[useLeague] rankings write failed:', e);
      try {
        const payload = { players, lastUpdated: timestamp };
        await storage.set(STORAGE_KEYS.PLAYER_RANKINGS, payload);
        console.log('Saved to localStorage as fallback');
      } catch (localErr) {
        console.error('localStorage save also failed:', localErr);
      }
    }
  }, [STORAGE_KEYS.PLAYER_RANKINGS]);

  return {
    // state
    teams, tournaments, transactions, settings, globalPlayerStats,
    allPlayers, rankingsLastUpdated, headshots, loading, isSyncing,
    // raw setters (for bulk import)
    setTeams, setTournaments, setTransactions, setSettings,
    setGlobalPlayerStats, setHeadshots, setAllPlayers, setRankingsLastUpdated,
    // persisted updaters
    updateTeams, updateTournaments, updateTransactions,
    updateSettings, updateGlobalStats, updateHeadshots, updateRankings,
  };
};

// ============================================================================
// useRoster
// Computes a team's effective current roster by replaying approved transactions
// on top of the base roster. Returns a stable memoised array.
// ============================================================================
export const useRoster = (team, transactions, activeTournamentIndex) => {
  if (!team) return [];
  let roster = [...team.roster];
  if (activeTournamentIndex >= 0) {
    const teamTx = transactions
      .filter(tx =>
        tx.team === team.name &&
        tx.type !== 'mulligan' &&
        tx.tournamentIndex !== undefined &&
        tx.tournamentIndex <= activeTournamentIndex &&
        tx.status === 'processed', // ← FIX: was '!== pending', which included failed transactions
      )
      .sort((a, b) => a.tournamentIndex - b.tournamentIndex);

    teamTx.forEach(tx => {
      if (tx.droppedPlayer) roster = roster.filter(p => p.name !== tx.droppedPlayer);
      if (!roster.some(p => p.name === tx.player)) {
        roster.push({ name: tx.player, limited: false, stars: 0, unlimited: false, yearsOfService: 1, starts: 0, eventsPlayed: 0, cutsMade: 0, pgaTourEarnings: 0, sfglEarnings: 0, headshot: '' });
      }
    });
  }
  return roster;
};

// ============================================================================
// useWindowStatus
// Returns live-computed window open/closed status, re-evaluated every minute.
// ============================================================================
export const useWindowStatus = (tournament) => {
  const compute = useCallback(() => ({
    lineupOpen:     isLineupEditingOpen(tournament),
    tournamentLocked: isTournamentLocked(tournament),
    faOpen:         isFreeAgentWindowOpen(tournament),
    waiverOpen:     isWaiverWindowOpen(),
  }), [tournament]);

  const [status, setStatus] = useState(compute);

  useEffect(() => {
    setStatus(compute());
    const id = setInterval(() => setStatus(compute()), 60_000);
    return () => clearInterval(id);
  }, [compute]);

  return status;
};
