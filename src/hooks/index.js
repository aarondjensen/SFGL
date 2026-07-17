import { useState, useCallback, useEffect, useRef } from 'react';
import { storage } from '../api';
import { playerRankingsApi } from '../api/firebase';
import { isTournamentLocked, isLineupEditingOpen, isFreeAgentWindowOpen, isWaiverWindowOpen } from '../utils';
import { buildPlayerAttributeIndex, setPlayerRegistry, getPlayerRegistry, resolveTxTournamentIndex } from '../utils/sharedHelpers';

// ============================================================================
// useLeague — central state manager for all league data
// ============================================================================
//
// This is the original pre-Wave-7 implementation, with two purely additive
// changes:
//   1. `refetch()` — exposed via the hook return so PullToRefresh can re-pull
//      from Firebase without a full page reload. Original didn't have this.
//   2. `loadErrors` — array of collection names that failed to load. Purely
//      informational; doesn't change loading behaviour.
//
// What this version DELIBERATELY DOES NOT have (after Wave 7 rollback):
//   - Per-call timeouts → caused mobile to fail-fast on slow but working
//     fetches; reverted
//   - Retry-on-null → only useful with timeouts which were the bug; reverted
//   - 20-second watchdog → cut off legit slow loads; reverted
//   - visibilitychange refetch → can be re-added separately later; for now we
//     stay close to the original to be sure we have a working baseline
//   - usePersistentState export → was unused
//
// Cascade still works: Firebase → sfgl_data → localStorage.
// Each Firebase call has no timeout — if it takes 30 seconds, we wait. If it
// errors, we fall through to the next tier. This is the original contract.
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
  const [loadErrors,          setLoadErrors]          = useState([]);

  // Core loader. Extracted as useCallback so refetch() can call it.
  // No timeouts. No retries. No watchdog. Original behaviour.
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
        playerRegistryApi,
      } = await import('../api/firebase');

      console.log(`[useLeague] ${isRefetch ? 'Refetching' : 'Loading'} from Firebase...`);

      // Each call has .catch that logs the error and returns null. No timeout.
      // If a call hangs, we wait. If it rejects, we fall through to fallbacks.
      const [
        firebaseTeams,
        firebaseTournaments,
        firebaseTransactions,
        firebaseSettings,
        firebaseStats,
        firebaseHeadshots,
        firebaseRankings,
      ] = await Promise.all([
        teamsApi.getAll().catch((e)        => { console.error('[useLeague] teams:', e);        errors.push('teams');        return null; }),
        tournamentsApi.getAll().catch((e)  => { console.error('[useLeague] tournaments:', e);  errors.push('tournaments');  return null; }),
        transactionsApi.getAll().catch((e) => { console.error('[useLeague] transactions:', e); errors.push('transactions'); return null; }),
        settingsApi.getAll().catch((e)     => { console.error('[useLeague] settings:', e);     errors.push('settings');     return null; }),
        playerStatsApi.getAll().catch((e)  => { console.error('[useLeague] stats:', e);        return null; }),
        headshotsApi.getAll().catch((e)    => { console.error('[useLeague] headshots:', e);    return null; }),
        prApi.getAll().catch((e)           => { console.error('[useLeague] rankings:', e);     return null; }),
      ]);

      const firebaseRegistry = await playerRegistryApi.get().catch(() => null);

      const sfglFallback = await sfglDataApi.getMany([
        STORAGE_KEYS.TEAMS,
        STORAGE_KEYS.TOURNAMENTS,
        STORAGE_KEYS.TRANSACTIONS,
        STORAGE_KEYS.SETTINGS,
        STORAGE_KEYS.GLOBAL_PLAYER_STATS,
      ]).catch(() => ({}));

      // Cascade for each collection: Firebase → sfgl_data → localStorage

      if (firebaseTeams?.length > 0) {
        setTeams(firebaseTeams);
        console.log(`✓ Loaded ${firebaseTeams.length} teams from Firebase`);
      } else if (sfglFallback[STORAGE_KEYS.TEAMS]?.length > 0) {
        setTeams(sfglFallback[STORAGE_KEYS.TEAMS]);
        console.log(`✓ Loaded ${sfglFallback[STORAGE_KEYS.TEAMS].length} teams from sfgl_data`);
      } else {
        const localTeams = await storage.get(STORAGE_KEYS.TEAMS, null);
        if (localTeams && !isRefetch) setTeams(localTeams);
      }

      if (firebaseTournaments?.length > 0) {
        setTournaments(firebaseTournaments);
        console.log(`✓ Loaded ${firebaseTournaments.length} tournaments from Firebase`);
      } else if (sfglFallback[STORAGE_KEYS.TOURNAMENTS]?.length > 0) {
        setTournaments(sfglFallback[STORAGE_KEYS.TOURNAMENTS]);
        console.log(`✓ Loaded ${sfglFallback[STORAGE_KEYS.TOURNAMENTS].length} tournaments from sfgl_data`);
      } else {
        const localTournaments = await storage.get(STORAGE_KEYS.TOURNAMENTS, null);
        if (localTournaments && !isRefetch) setTournaments(localTournaments);
      }

      if (firebaseTransactions?.length > 0) {
        setTransactions(firebaseTransactions);
        console.log(`✓ Loaded ${firebaseTransactions.length} transactions from Firebase`);
      } else if (sfglFallback[STORAGE_KEYS.TRANSACTIONS]?.length > 0) {
        setTransactions(sfglFallback[STORAGE_KEYS.TRANSACTIONS]);
        console.log(`✓ Loaded ${sfglFallback[STORAGE_KEYS.TRANSACTIONS].length} transactions from sfgl_data`);
      } else {
        const localTransactions = await storage.get(STORAGE_KEYS.TRANSACTIONS, null);
        if (localTransactions && !isRefetch) setTransactions(localTransactions);
      }

      if (firebaseSettings && Object.keys(firebaseSettings).length > 0) {
        setSettings(firebaseSettings);
        console.log(`✓ Loaded settings from Firebase`);
      } else if (sfglFallback[STORAGE_KEYS.SETTINGS] && Object.keys(sfglFallback[STORAGE_KEYS.SETTINGS]).length > 0) {
        setSettings(sfglFallback[STORAGE_KEYS.SETTINGS]);
        console.log(`✓ Loaded settings from sfgl_data`);
      } else {
        const localSettings = await storage.get(STORAGE_KEYS.SETTINGS, null);
        if (localSettings && !isRefetch) setSettings(localSettings);
      }

      if (firebaseStats && Object.keys(firebaseStats).length > 0) {
        setGlobalPlayerStats(firebaseStats);
        console.log(`✓ Loaded ${Object.keys(firebaseStats).length} player stats from Firebase`);
      } else if (sfglFallback[STORAGE_KEYS.GLOBAL_PLAYER_STATS] && Object.keys(sfglFallback[STORAGE_KEYS.GLOBAL_PLAYER_STATS]).length > 0) {
        setGlobalPlayerStats(sfglFallback[STORAGE_KEYS.GLOBAL_PLAYER_STATS]);
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

      // ── Durable player registry (single source of truth for SFGL attributes) ──
      // Merge the persisted registry with the just-loaded rosters + results
      // history, then cache it (for hydration everywhere) and persist the union.
      // The merge only ever adds/corrects (limited never downgrades; tallies take
      // the max), so it's monotonic and safe — a player is captured the first
      // time they're seen on any roster and never lost afterward.
      try {
        const regTeams = (firebaseTeams?.length > 0)
          ? firebaseTeams
          : (sfglFallback[STORAGE_KEYS.TEAMS] || []);
        const regTournaments = (firebaseTournaments?.length > 0)
          ? firebaseTournaments
          : (sfglFallback[STORAGE_KEYS.TOURNAMENTS] || []);
        const mergedRegistry = buildPlayerAttributeIndex(regTeams, regTournaments, firebaseRegistry || {});
        setPlayerRegistry(mergedRegistry);
        playerRegistryApi.set(mergedRegistry).catch((e) => console.warn('[useLeague] registry persist skipped:', e));
      } catch (e) {
        console.warn('[useLeague] registry seed skipped:', e);
      }

      setLoadErrors(errors);

      if (errors.length === 0) {
        console.log('[useLeague] ✓ All data loaded successfully');
      } else {
        console.warn(`[useLeague] ⚠ Failed to load from Firebase: ${errors.join(', ')} (used local fallback)`);
      }
    } catch (e) {
      console.error('[useLeague] Catastrophic load error:', e);
      // Complete fallback to localStorage on initial load only
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
          setLoadErrors(['teams', 'tournaments', 'transactions', 'settings']);
        } catch (innerErr) {
          console.error('[useLeague] localStorage fallback failed:', innerErr);
        }
      }
    }
  }, [STORAGE_KEYS]);

  // Initial load
  useEffect(() => {
    loadFromFirebase(false).finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Manual refetch — for PullToRefresh
  const refetch = useCallback(() => loadFromFirebase(true), [loadFromFirebase]);

  // Wave 8: real-time Firestore subscriptions. After initial cascade load
  // completes, attach onSnapshot listeners so any server-side change (cron
  // processing waivers, results processing, settings change from another
  // device, etc.) shows up immediately without a page refresh. Initial load
  // path (Firebase → sfgl_data → localStorage) is unchanged — this is purely
  // additive. If the initial Firebase load failed and we're showing local
  // fallback data, the subscription will quietly start populating fresh data
  // as soon as Firebase becomes reachable.
  useEffect(() => {
    if (loading) return; // wait until initial cascade load resolves

    let cancelled = false;
    const unsubs = [];

    (async () => {
      try {
        const { teamsApi, transactionsApi, tournamentsApi, settingsApi } = await import('../api/firebase');
        if (cancelled) return;

        unsubs.push(teamsApi.subscribe(next => {
          // Defensive: only update if next is a non-empty array. Firestore
          // can briefly emit an empty snapshot during reconnect; we don't
          // want that to wipe local state.
          if (Array.isArray(next) && next.length > 0) setTeams(next);
        }));

        unsubs.push(transactionsApi.subscribe(next => {
          if (Array.isArray(next)) setTransactions(next);
        }));

        unsubs.push(tournamentsApi.subscribe(next => {
          if (Array.isArray(next) && next.length > 0) setTournaments(next);
        }));

        unsubs.push(settingsApi.subscribe(next => {
          if (next && typeof next === 'object' && Object.keys(next).length > 0) setSettings(next);
        }));

        console.log('[useLeague] ✓ Real-time subscriptions active');
      } catch (e) {
        console.error('[useLeague] subscription setup failed:', e);
      }
    })();

    return () => {
      cancelled = true;
      unsubs.forEach(u => { try { u && u(); } catch {} });
    };
  }, [loading]);

  // ── Refs for stable updater dependencies ──────────────────────────────
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

  // ── Persisted updaters ─────────────────────────────────────────────────
  const updateTeams = useCallback(async (next, registryOverrides = null) => {
    const resolved = typeof next === 'function' ? next(teamsRef.current) : next;
    setTeams(resolved);
    // Keep the durable registry fresh at the single team-save chokepoint, so a
    // player's attributes are captured before they can ever be dropped. Monotonic
    // merge (limited never downgrades; tallies take the max).
    try {
      const merged = buildPlayerAttributeIndex(resolved, tournamentsRef.current, getPlayerRegistry());
      // Authoritative overrides: some operations must DECREASE a monotonic tally
      // (e.g. reversing a mulligan pulls a player's start/earnings back). The
      // max-merge above would re-inflate it, so force-set the corrected values
      // here. Callers pass { playerName: { starts, sfglEarnings, ... } }. Because
      // the roster is corrected to the same value in `resolved`, future saves
      // stay put (max(corrected, corrected) === corrected). Works for off-roster
      // players too — their durable registry record is corrected in place.
      if (registryOverrides) {
        for (const [name, attrs] of Object.entries(registryOverrides)) {
          merged[name] = { ...(merged[name] || {}), ...attrs };
        }
      }
      setPlayerRegistry(merged);
      const { playerRegistryApi } = await import('../api/firebase');
      playerRegistryApi.set(merged).catch(() => {});
    } catch (e) {
      console.warn('[useLeague] registry upkeep skipped:', e);
    }
    // Returns true when the authoritative Firebase write succeeded, false
    // otherwise — callers await this to decide between a success and an
    // error toast instead of announcing success for a write that failed.
    let ok = true;
    try {
      setIsSyncing(true);
      const { teamsApi } = await import('../api/firebase');
      await teamsApi.setAll(resolved);
      await storage.set(STORAGE_KEYS.TEAMS, resolved);
    } catch (e) {
      ok = false;
      console.error('[useLeague] teams write failed:', e);
      try { await storage.set(STORAGE_KEYS.TEAMS, resolved); } catch {}
    } finally {
      setIsSyncing(false);
    }
    return ok;
  }, [STORAGE_KEYS.TEAMS]);

  const updateTournaments = useCallback(async (next) => {
    const resolved = typeof next === 'function' ? next(tournamentsRef.current) : next;
    setTournaments(resolved);
    let ok = true;
    try {
      setIsSyncing(true);
      const { tournamentsApi } = await import('../api/firebase');
      await tournamentsApi.setAll(resolved);
      await storage.set(STORAGE_KEYS.TOURNAMENTS, resolved);
    } catch (e) {
      ok = false;
      console.error('[useLeague] tournaments write failed:', e);
      try { await storage.set(STORAGE_KEYS.TOURNAMENTS, resolved); } catch {}
    } finally {
      setIsSyncing(false);
    }
    return ok;
  }, [STORAGE_KEYS.TOURNAMENTS]);

  const updateTransactions = useCallback(async (next) => {
    const resolved = typeof next === 'function' ? next(transactionsRef.current) : next;
    setTransactions(resolved);
    let ok = true;
    try {
      const { transactionsApi } = await import('../api/firebase');
      const merged = await transactionsApi.sync(resolved);
      if (merged && merged.length > resolved.length) {
        setTransactions(merged);
      }
    } catch (e) {
      ok = false;
      console.error('[useLeague] transactions sync failed:', e);
    }
    storage.set(STORAGE_KEYS.TRANSACTIONS, resolved).catch(e =>
      console.error('[useLeague] transactions backup failed:', e)
    );
    return ok;
  }, [STORAGE_KEYS.TRANSACTIONS]);

  const updateSettings = useCallback(async (next) => {
    const resolved = typeof next === 'function' ? next(settingsRef.current) : next;
    setSettings(resolved);
    try {
      const { settingsApi } = await import('../api/firebase');
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
    loadErrors,
    // raw setters (for bulk import)
    setTeams, setTournaments, setTransactions, setSettings,
    setGlobalPlayerStats, setHeadshots, setAllPlayers, setRankingsLastUpdated,
    // persisted updaters
    updateTeams, updateTournaments, updateTransactions,
    updateSettings, updateGlobalStats, updateHeadshots, updateRankings,
    // refetch
    refetch,
  };
};

// ============================================================================
// useRoster
// Computes a team's effective current roster by replaying approved transactions
// on top of the base roster. Returns a stable memoised array.
//
// Skips:
//   • mulligan — affects a single tournament's lineup, not the long-term
//     roster.
//   • swing_winner — tx.player on these is the manager's owner name (used
//     for "Jensen won the West Coast Swing pot" display), NOT an actual
//     golfer. Replaying it would pollute the roster with the manager's name.
// ============================================================================
export const useRoster = (team, transactions, activeTournamentIndex, tournaments = null) => {
  if (!team) return [];
  let roster = [...team.roster];
  if (activeTournamentIndex >= 0) {
    // Resolve each tx's tournament position FRESH from its stable name (falling
    // back to the stored index for legacy rows), so a schedule reorder can never
    // misalign the cutoff again. Compute the position once per tx.
    const teamTx = transactions
      .filter(tx =>
        tx.team === team.name &&
        tx.type !== 'mulligan' &&
        tx.type !== 'swing_winner' &&
        (tx.status === 'processed' || tx.status === 'completed'),
      )
      .map(tx => ({ tx, pos: resolveTxTournamentIndex(tx, tournaments) }))
      .filter(x => x.pos !== undefined && x.pos <= activeTournamentIndex)
      .sort((a, b) => a.pos - b.pos)
      .map(x => x.tx);

    teamTx.forEach(tx => {
      if (tx.droppedPlayer) roster = roster.filter(p => p.name !== tx.droppedPlayer);
      // Guard: only push when tx.player is defined. Without this, any tx
      // missing a player field (e.g., a future tx shape) would inject a
      // {name: undefined} ghost into the roster.
      if (tx.player && !roster.some(p => p.name === tx.player)) {
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
