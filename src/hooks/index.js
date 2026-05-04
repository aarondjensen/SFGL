import { useState, useCallback, useEffect, useRef } from 'react';
import { storage } from '../api';
import { playerRankingsApi } from '../api/firebase';
import { isTournamentLocked, isLineupEditingOpen, isFreeAgentWindowOpen, isWaiverWindowOpen } from '../utils';

// ============================================================================
// useLeague — central state manager for all league data
// ============================================================================
//
// Wave 7 architecture (compared to original):
//
// 1. INITIAL LOAD with retry: each Firebase call retries once on null before
//    falling through to the local fallback chain. This catches transient
//    cold-start Firestore failures (especially common on mobile Safari) that
//    used to silently leave a client on stale localStorage.
//
// 2. REFETCH on focus: when the tab becomes visible after >5 minutes of being
//    hidden, we re-pull all collections from Firebase. Fixes the mobile/
//    desktop divergence where one client modifies state and the other never
//    sees it until reload.
//
// 3. EXPLICIT refetch(): exposed via the hook return so consumers (e.g. the
//    pull-to-refresh gesture, or a manual "refresh" button) can force a
//    reload without window.location.reload().
//
// 4. PARTIAL-FAILURE TRACKING: loadErrors state tracks which collections
//    failed to load from Firebase, so the UI can surface a banner instead of
//    silently masking the failure.
//
// What we deliberately did NOT change:
//   - localStorage cascade still exists as a third-tier fallback
//   - sfgl_data middle tier (Firestore key-value) still queried
//   - update*() writers still write Firebase + localStorage
//
// What we removed:
//   - usePersistentState (was exported but not used anywhere)
// ============================================================================
export const useLeague = (STORAGE_KEYS) => {
  const [teams,               setTeams]               = useState([]);
  const [tournaments,         setTournaments]         = useState([]);
  const [transactions,        setTransactions]        = useState([]);
  const [settings,            setSettings]            = useState({ commissioner: 'Detroit Rock City', currentSegment: 'West Coast Swing' });
  const [globalPlayerStats,   setGlobalPlayerStats]   = useState({});
  const [allPlayers,          setAllPlayers]          = useState([]);
  const [rankingsLastUpdated, setRankingsLastUpdated] = useState(null);
  const [headshots,           setHeadshots]           = useState({});
  const [loading,             setLoading]             = useState(true);
  const [isSyncing,           setIsSyncing]           = useState(false);
  const [loadErrors,          setLoadErrors]          = useState([]); // Wave 7: list of collection names that failed

  // Track visibility for refetch-on-focus
  const lastFetchTimeRef = useRef(Date.now());
  const REFETCH_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

  // ── Load helper with one retry on null ──────────────────────────────────
  // Wave 7: retries Firebase calls once with a 1s delay before declaring
  // failure. Mobile Safari Firestore SDK has known cold-start race conditions
  // that resolve with a brief retry.
  // Wave 7.1: each attempt is wrapped in an 8-second timeout so a hung
  // network connection on mobile cellular doesn't stall the whole loader.
  const fetchWithRetry = useCallback(async (apiCall, label, timeoutMs = 8000) => {
    const withTimeout = (p) => Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)),
    ]);
    try {
      const first = await withTimeout(apiCall());
      if (first !== null && first !== undefined) {
        // Treat empty arrays/objects as valid responses (collection exists, just empty)
        if (Array.isArray(first) && first.length === 0) return first;
        if (typeof first === 'object' && Object.keys(first).length === 0) return first;
        return first;
      }
      // Null result — retry once
      console.warn(`[useLeague] ${label} returned null on first try, retrying...`);
      await new Promise(r => setTimeout(r, 1000));
      return await withTimeout(apiCall());
    } catch (err) {
      console.error(`[useLeague] ${label} threw:`, err.message || err);
      // One retry on exception too
      try {
        await new Promise(r => setTimeout(r, 1000));
        return await withTimeout(apiCall());
      } catch (err2) {
        console.error(`[useLeague] ${label} also failed on retry:`, err2.message || err2);
        return null;
      }
    }
  }, []);

  // ── Core loader (extracted as useCallback so refetch() can call it) ──────
  const loadFromFirebase = useCallback(async (isRefetch = false) => {
    const errors = [];
    try {
      const {
        teamsApi,
        tournamentsApi,
        transactionsApi,
        settingsApi,
        playerStatsApi,
        headshotsApi,
        playerRankingsApi: prApi,
        sfglDataApi,
      } = await import('../api/firebase');

      console.log(`[useLeague v7.1] ${isRefetch ? 'Refetching' : 'Loading'} from Firebase...`);

      const [
        firebaseTeams,
        firebaseTournaments,
        firebaseTransactions,
        firebaseSettings,
        firebaseStats,
        firebaseHeadshots,
        firebaseRankings,
      ] = await Promise.all([
        fetchWithRetry(() => teamsApi.getAll(),         'teams'),
        fetchWithRetry(() => tournamentsApi.getAll(),   'tournaments'),
        fetchWithRetry(() => transactionsApi.getAll(),  'transactions'),
        fetchWithRetry(() => settingsApi.getAll(),      'settings'),
        fetchWithRetry(() => playerStatsApi.getAll(),   'playerStats'),
        fetchWithRetry(() => headshotsApi.getAll(),     'headshots'),
        fetchWithRetry(() => prApi.getAll(),            'rankings'),
      ]);

      // sfgl_data middle tier — kept for backward compatibility with older
      // installations that wrote there. New writes go to dedicated collections only.
      // Wave 7.1: also wrapped in a timeout so a hung sfgl_data query doesn't
      // stall the loader.
      const sfglFallback = await Promise.race([
        sfglDataApi.getMany([
          STORAGE_KEYS.TEAMS,
          STORAGE_KEYS.TOURNAMENTS,
          STORAGE_KEYS.TRANSACTIONS,
          STORAGE_KEYS.SETTINGS,
          STORAGE_KEYS.GLOBAL_PLAYER_STATS,
        ]),
        new Promise((_, rej) => setTimeout(() => rej(new Error('sfgl_data timed out')), 5000)),
      ]).catch((e) => {
        console.warn('[useLeague] sfgl_data fallback unavailable:', e.message || e);
        return {};
      });

      // ── Apply each collection with cascade: Firebase → sfgl_data → localStorage ──

      if (firebaseTeams?.length > 0) {
        setTeams(firebaseTeams);
        console.log(`✓ Loaded ${firebaseTeams.length} teams from Firebase`);
      } else if (sfglFallback[STORAGE_KEYS.TEAMS]?.length > 0) {
        setTeams(sfglFallback[STORAGE_KEYS.TEAMS]);
        console.log(`✓ Loaded ${sfglFallback[STORAGE_KEYS.TEAMS].length} teams from sfgl_data`);
        if (firebaseTeams === null) errors.push('teams');
      } else {
        const localTeams = await storage.get(STORAGE_KEYS.TEAMS, null);
        if (localTeams) {
          // Only apply localStorage on initial load. On refetch, an empty Firebase
          // result probably means a real network failure and we shouldn't overwrite
          // current good state with potentially stale localStorage.
          if (!isRefetch) setTeams(localTeams);
          if (firebaseTeams === null) errors.push('teams');
        }
      }

      if (firebaseTournaments?.length > 0) {
        setTournaments(firebaseTournaments);
        console.log(`✓ Loaded ${firebaseTournaments.length} tournaments from Firebase`);
      } else if (sfglFallback[STORAGE_KEYS.TOURNAMENTS]?.length > 0) {
        setTournaments(sfglFallback[STORAGE_KEYS.TOURNAMENTS]);
        console.log(`✓ Loaded ${sfglFallback[STORAGE_KEYS.TOURNAMENTS].length} tournaments from sfgl_data`);
        if (firebaseTournaments === null) errors.push('tournaments');
      } else {
        const localTournaments = await storage.get(STORAGE_KEYS.TOURNAMENTS, null);
        if (localTournaments) {
          if (!isRefetch) setTournaments(localTournaments);
          if (firebaseTournaments === null) errors.push('tournaments');
        }
      }

      if (firebaseTransactions?.length > 0) {
        setTransactions(firebaseTransactions);
        console.log(`✓ Loaded ${firebaseTransactions.length} transactions from Firebase`);
      } else if (sfglFallback[STORAGE_KEYS.TRANSACTIONS]?.length > 0) {
        setTransactions(sfglFallback[STORAGE_KEYS.TRANSACTIONS]);
        console.log(`✓ Loaded ${sfglFallback[STORAGE_KEYS.TRANSACTIONS].length} transactions from sfgl_data`);
        if (firebaseTransactions === null) errors.push('transactions');
      } else {
        const localTransactions = await storage.get(STORAGE_KEYS.TRANSACTIONS, null);
        if (localTransactions) {
          if (!isRefetch) setTransactions(localTransactions);
          if (firebaseTransactions === null) errors.push('transactions');
        }
      }

      if (firebaseSettings && Object.keys(firebaseSettings).length > 0) {
        setSettings(firebaseSettings);
        console.log(`✓ Loaded settings from Firebase`);
      } else if (sfglFallback[STORAGE_KEYS.SETTINGS] && Object.keys(sfglFallback[STORAGE_KEYS.SETTINGS]).length > 0) {
        setSettings(sfglFallback[STORAGE_KEYS.SETTINGS]);
        console.log(`✓ Loaded settings from sfgl_data`);
        if (firebaseSettings === null) errors.push('settings');
      } else {
        const localSettings = await storage.get(STORAGE_KEYS.SETTINGS, null);
        if (localSettings) {
          if (!isRefetch) setSettings(localSettings);
          if (firebaseSettings === null) errors.push('settings');
        }
      }

      if (firebaseStats && Object.keys(firebaseStats).length > 0) {
        setGlobalPlayerStats(firebaseStats);
        console.log(`✓ Loaded ${Object.keys(firebaseStats).length} player stats from Firebase`);
      } else if (sfglFallback[STORAGE_KEYS.GLOBAL_PLAYER_STATS] && Object.keys(sfglFallback[STORAGE_KEYS.GLOBAL_PLAYER_STATS]).length > 0) {
        setGlobalPlayerStats(sfglFallback[STORAGE_KEYS.GLOBAL_PLAYER_STATS]);
        console.log(`✓ Loaded player stats from sfgl_data`);
      } else {
        const localStats = await storage.get(STORAGE_KEYS.GLOBAL_PLAYER_STATS, null);
        if (localStats && !isRefetch) setGlobalPlayerStats(localStats);
      }

      if (firebaseHeadshots && Object.keys(firebaseHeadshots).length > 0) {
        setHeadshots(firebaseHeadshots);
        console.log(`✓ Loaded ${Object.keys(firebaseHeadshots).length} headshots from Firebase`);
      } else {
        const localHeadshots = await storage.get(STORAGE_KEYS.HEADSHOTS, null);
        if (localHeadshots && !isRefetch) setHeadshots(localHeadshots);
      }

      if (firebaseRankings?.length > 0) {
        setAllPlayers(firebaseRankings);
        const lastUpdated = await prApi.getLastUpdated().catch(() => null);
        setRankingsLastUpdated(lastUpdated);
        console.log(`✓ Loaded ${firebaseRankings.length} players from Firebase`);
      } else {
        const localRankings = await storage.get(STORAGE_KEYS.PLAYER_RANKINGS, null);
        if (localRankings?.players && !isRefetch) {
          setAllPlayers(localRankings.players);
          setRankingsLastUpdated(localRankings.lastUpdated);
        }
      }

      setLoadErrors(errors);
      lastFetchTimeRef.current = Date.now();

      if (errors.length === 0) {
        console.log('[useLeague] ✓ All data loaded successfully');
      } else {
        console.warn(`[useLeague] ⚠ Failed to load from Firebase: ${errors.join(', ')} (used local fallback)`);
      }
    } catch (e) {
      console.error('[useLeague] Catastrophic load error:', e);
      // Complete fallback to localStorage — only on initial load, not refetch
      if (!isRefetch) {
        try {
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

          if (teamsData)        setTeams(teamsData);
          if (tournamentsData)  setTournaments(tournamentsData);
          if (transactionsData) setTransactions(transactionsData);
          if (settingsData)     setSettings(settingsData);
          if (statsData)        setGlobalPlayerStats(statsData);
          if (headshotsData)    setHeadshots(headshotsData);
          if (rankingsData?.players) {
            setAllPlayers(rankingsData.players);
            setRankingsLastUpdated(rankingsData.lastUpdated);
          }
          // Mark all as failed since we couldn't reach Firebase at all
          setLoadErrors(['teams', 'tournaments', 'transactions', 'settings']);
        } catch (innerErr) {
          console.error('[useLeague] localStorage fallback also failed:', innerErr);
        }
      }
    }
  }, [STORAGE_KEYS, fetchWithRetry]);

  // ── Initial load ──────────────────────────────────────────────────────────
  // Wave 7.1: hard 20-second watchdog so the loading spinner can never hang
  // forever even if every Firebase call stalls. After 20s we force the
  // loading flag off; views render with whatever data we have (even if empty)
  // and the user can pull-to-refresh to retry.
  useEffect(() => {
    let watchdogFired = false;
    const watchdog = setTimeout(() => {
      watchdogFired = true;
      console.warn('[useLeague] Load watchdog fired after 20s — forcing loading=false');
      setLoading(false);
      setLoadErrors(prev => prev.includes('timeout') ? prev : [...prev, 'timeout']);
    }, 20000);
    loadFromFirebase(false).finally(() => {
      clearTimeout(watchdog);
      if (!watchdogFired) setLoading(false);
    });
    return () => clearTimeout(watchdog);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Refetch on tab focus after >5 min hidden ─────────────────────────────
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden) return;
      const elapsed = Date.now() - lastFetchTimeRef.current;
      if (elapsed > REFETCH_THRESHOLD_MS) {
        console.log(`[useLeague] Tab visible after ${Math.round(elapsed / 1000)}s — refetching from Firebase`);
        loadFromFirebase(true);
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [loadFromFirebase]);

  // ── Manual refetch — exposed via hook return for pull-to-refresh etc. ────
  const refetch = useCallback(() => loadFromFirebase(true), [loadFromFirebase]);

  // ── Refs for stable callback dependencies ───────────────────────────────
  const teamsRef        = useRef(teams);
  const tournamentsRef  = useRef(tournaments);
  const transactionsRef = useRef(transactions);
  const settingsRef     = useRef(settings);
  const statsRef        = useRef(globalPlayerStats);
  const headshotsRef    = useRef(headshots);
  useEffect(() => { teamsRef.current = teams; },               [teams]);
  useEffect(() => { tournamentsRef.current = tournaments; },   [tournaments]);
  useEffect(() => { transactionsRef.current = transactions; }, [transactions]);
  useEffect(() => { settingsRef.current = settings; },         [settings]);
  useEffect(() => { statsRef.current = globalPlayerStats; },   [globalPlayerStats]);
  useEffect(() => { headshotsRef.current = headshots; },       [headshots]);

  // ── Persisted updaters ────────────────────────────────────────────────────
  const updateTeams = useCallback(async (next) => {
    const resolved = typeof next === 'function' ? next(teamsRef.current) : next;
    setTeams(resolved);
    try {
      setIsSyncing(true);
      const { teamsApi } = await import('../api/firebase');
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
      const { tournamentsApi } = await import('../api/firebase');
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
    try {
      const { transactionsApi } = await import('../api/firebase');
      const merged = await transactionsApi.sync(resolved);
      if (merged && merged.length > resolved.length) {
        setTransactions(merged);
      }
    } catch (e) {
      console.error('[useLeague] transactions sync failed:', e);
    }
    storage.set(STORAGE_KEYS.TRANSACTIONS, resolved).catch(e =>
      console.error('[useLeague] transactions backup failed:', e)
    );
  }, [STORAGE_KEYS.TRANSACTIONS]);

  const updateSettings = useCallback(async (next) => {
    const resolved = typeof next === 'function' ? next(settingsRef.current) : next;
    setSettings(resolved);
    try {
      const { settingsApi } = await import('../api/firebase');
      // Wave 7 still writes one key at a time (no batch API in settingsApi).
      // TODO future: add settingsApi.setMany() for batched writes.
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
      const { playerStatsApi } = await import('../api/firebase');
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
      const { headshotsApi } = await import('../api/firebase');
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
      console.log(`Saved ${players.length} players to Firebase`);
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
    loadErrors, // Wave 7: list of collection names that failed to load
    // raw setters (for bulk import)
    setTeams, setTournaments, setTransactions, setSettings,
    setGlobalPlayerStats, setHeadshots, setAllPlayers, setRankingsLastUpdated,
    // persisted updaters
    updateTeams, updateTournaments, updateTransactions,
    updateSettings, updateGlobalStats, updateHeadshots, updateRankings,
    // Wave 7: explicit refetch
    refetch,
  };
};

// ============================================================================
// useRoster
// Computes a team's effective current roster by replaying approved transactions
// on top of the base roster. Returns a stable memoised array.
// Mulligans are intentionally excluded — they affect a single tournament's
// lineup, not the long-term roster.
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
        (tx.status === 'processed' || tx.status === 'completed'),
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
// IMPORTANT: callers must pass `settings` as the second argument or the
// configured waiver/FA cutoffs will be ignored (defaults to Tue 8pm ET).
// ============================================================================
export const useWindowStatus = (tournament, settings) => {
  const compute = useCallback(() => ({
    lineupOpen:       isLineupEditingOpen(tournament),
    tournamentLocked: isTournamentLocked(tournament),
    faOpen:           isFreeAgentWindowOpen(tournament, settings),
    waiverOpen:       isWaiverWindowOpen(tournament, settings),
  }), [tournament, settings]);

  const [status, setStatus] = useState(compute);

  useEffect(() => {
    setStatus(compute());
    const id = setInterval(() => setStatus(compute()), 60_000);
    return () => clearInterval(id);
  }, [compute]);

  return status;
};
