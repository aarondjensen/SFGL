import { useState, useCallback, useEffect, useRef } from 'react';
import { storage } from '../api.js';
import { isTournamentLocked, isLineupEditingOpen, isFreeAgentWindowOpen, isWaiverWindowOpen } from '../utils/index.js';

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
        const [teamsData, tournamentsData, transactionsData, settingsData, statsData, rankingsData, headshotsData] =
          await Promise.all([
            storage.get(STORAGE_KEYS.TEAMS,              null),
            storage.get(STORAGE_KEYS.TOURNAMENTS,        null),
            storage.get(STORAGE_KEYS.TRANSACTIONS,       null),
            storage.get(STORAGE_KEYS.SETTINGS,           null),
            storage.get(STORAGE_KEYS.GLOBAL_PLAYER_STATS,null),
            storage.get(STORAGE_KEYS.PLAYER_RANKINGS,    null),
            storage.get(STORAGE_KEYS.HEADSHOTS,          null),
          ]);

        if (teamsData)        setTeams(teamsData);
        if (tournamentsData)  setTournaments(tournamentsData);
        if (transactionsData) setTransactions(transactionsData);
        if (settingsData)     setSettings(settingsData);
        if (statsData)        setGlobalPlayerStats(statsData);
        if (headshotsData)    setHeadshots(headshotsData);
        if (rankingsData?.players?.length > 0) {
          setAllPlayers(rankingsData.players);
          setRankingsLastUpdated(rankingsData.lastUpdated);
        }
      } catch (e) {
        console.error('[useLeague] Load error:', e);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Persisted updaters ────────────────────────────────────────────────────
  const updateTeams = useCallback(async (next) => {
    const resolved = typeof next === 'function' ? next(teams) : next;
    setTeams(resolved);
    try {
      setIsSyncing(true);
      await storage.set(STORAGE_KEYS.TEAMS, resolved);
    } catch (e) {
      console.error('[useLeague] teams write failed:', e);
    } finally {
      setIsSyncing(false);
    }
  }, [teams, STORAGE_KEYS.TEAMS]);

  const updateTournaments = useCallback(async (next) => {
    const resolved = typeof next === 'function' ? next(tournaments) : next;
    setTournaments(resolved);
    try {
      setIsSyncing(true);
      await storage.set(STORAGE_KEYS.TOURNAMENTS, resolved);
    } catch (e) {
      console.error('[useLeague] tournaments write failed:', e);
    } finally {
      setIsSyncing(false);
    }
  }, [tournaments, STORAGE_KEYS.TOURNAMENTS]);

  const updateTransactions = useCallback(async (next) => {
    setTransactions(prev => {
      const resolved = typeof next === 'function' ? next(prev) : next;
      storage.set(STORAGE_KEYS.TRANSACTIONS, resolved).catch(e =>
        console.error('[useLeague] transactions write failed:', e),
      );
      return resolved;
    });
  }, [STORAGE_KEYS.TRANSACTIONS]);

  const updateSettings = useCallback(async (next) => {
    const resolved = typeof next === 'function' ? next(settings) : next;
    setSettings(resolved);
    try { await storage.set(STORAGE_KEYS.SETTINGS, resolved); }
    catch (e) { console.error('[useLeague] settings write failed:', e); }
  }, [settings, STORAGE_KEYS.SETTINGS]);

  const updateGlobalStats = useCallback(async (next) => {
    const resolved = typeof next === 'function' ? next(globalPlayerStats) : next;
    setGlobalPlayerStats(resolved);
    try { await storage.set(STORAGE_KEYS.GLOBAL_PLAYER_STATS, resolved); }
    catch (e) { console.error('[useLeague] stats write failed:', e); }
  }, [globalPlayerStats, STORAGE_KEYS.GLOBAL_PLAYER_STATS]);

  const updateHeadshots = useCallback(async (next) => {
    const resolved = typeof next === 'function' ? next(headshots) : next;
    setHeadshots(resolved);
    try { await storage.set(STORAGE_KEYS.HEADSHOTS, resolved); }
    catch (e) { console.error('[useLeague] headshots write failed:', e); }
  }, [headshots, STORAGE_KEYS.HEADSHOTS]);

  const updateRankings = useCallback(async (players) => {
    setAllPlayers(players);
    const payload = { players, lastUpdated: new Date().toISOString() };
    try { await storage.set(STORAGE_KEYS.PLAYER_RANKINGS, payload); }
    catch (e) { console.error('[useLeague] rankings write failed:', e); }
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
        tx.status !== 'pending',
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
