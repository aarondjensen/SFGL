import React, { useState, useEffect, useRef, Suspense } from 'react';
import { Trophy, Users, DollarSign, Calendar, Settings } from 'lucide-react';

// ── Wave 6/7: ?reset=1 cache flush ────────────────────────────────────────
// Mobile devices can get stuck on stale localStorage data while desktop has
// fresh state from Firebase. Visiting any URL with ?reset=1 (e.g.
// https://sfglgolf.com/?reset=1) clears all SFGL-namespaced localStorage keys
// and reloads. This runs at module-load time so it fires BEFORE any useState
// initializers read from localStorage.
//
// Wave 7 fix: previously this only matched 'sfgl-' prefix keys, but the actual
// data keys in this app use 'fantasy-golf-' as their prefix (only the
// logged-in-user key uses 'sfgl-'). The old filter only signed users out and
// did not reset cache. Now matches both.
if (typeof window !== 'undefined') {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.has('reset')) {
      Object.keys(localStorage)
        .filter(k => k.startsWith('sfgl-') || k.startsWith('fantasy-golf-'))
        .forEach(k => localStorage.removeItem(k));
      console.log('[?reset=1] Cleared SFGL localStorage');
      // Navigate to the URL without ?reset — replace() also reloads
      window.location.replace(window.location.pathname);
    }
  } catch (e) {
    console.warn('Cache reset failed:', e);
  }
}

import { DialogProvider } from './pages/DialogContext';
import { ErrorBoundary, addGlobalErrorReporters }  from './pages/ErrorBoundary';
import { PullToRefresh }  from './pages/PullToRefresh';
import { UserSettingsModal } from './components/UserSettingsModal';
import { NotificationNudge } from './components/NotificationNudge';

// ── Eagerly loaded views (shown on first visit / lightweight) ──────────────
import { StandingsView }  from './pages/StandingsView';
// ResultsView merged into TournamentsView — completed events expand inline
// to show team standings + player breakdowns. The standalone tab is gone.
import { RostersView }    from './pages/RostersView';
import { TournamentsView }  from './pages/TournamentsView';

// ── Lazy-loaded views (heavy, rarely visited on initial load) ──────────────
// AdminView and TransactionsView (and their transitive deps like DraftModal)
// are deferred until the user actually navigates to those tabs. This removes
// thousands of lines of JS from the initial bundle.
// LoginPage was added to this list in Wave 5 — most users browse anonymously
// and never click Sign In, so the LoginPage component + its CSS shouldn't be
// in the initial bundle.
const LazyAdminView        = React.lazy(() => import('./pages/AdminView').then(m => ({ default: m.AdminView })));
const LazyTransactionsView = React.lazy(() => import('./pages/TransactionsView').then(m => ({ default: m.TransactionsView })));
const LazyLoginPage        = React.lazy(() => import('./pages/LoginPage'));

import { useLeague }       from './hooks';
import { getSegmentByDate } from './utils';
import { theme, colors, fonts, fontSize, getSwingColor } from './theme.js';
import { STORAGE_KEYS, INITIAL_TEAMS, PGA_TOUR_IDS } from './constants';
import { managerAuthApi, tournamentResultsApi, teamsApi } from './api/firebase';


// ── Lazy-load fallback spinner ─────────────────────────────────────────────
const LazyFallback = () => (
  <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
    <div style={{
      fontSize: fontSize.sm, letterSpacing: 3, textTransform: 'uppercase',
      color: 'rgba(255,255,255,0.2)', fontWeight: 400,
      fontFamily: "'Raleway', system-ui, sans-serif",
    }}>
      Loading…
    </div>
  </div>
);

// ── Tabs ────────────────────────────────────────────────────────────────────
const TABS = [
  { id: 'standings',    label: 'Standings',    Icon: Trophy     },
  { id: 'rosters',      label: 'Rosters',      Icon: Users      },
  { id: 'transactions', label: 'Transactions', Icon: DollarSign },
  { id: 'tournaments',  label: 'Tournaments',  Icon: Calendar   },
  { id: 'admin',        label: 'Commish',      Icon: Settings   },
];

// Valid tab IDs as a Set — used to validate URL hash values before applying
// them to state (so `#foo` or `#anythingrandom` doesn't crash the app or
// leave it in a no-tab-rendered limbo). Defined at module level so the
// Set isn't recreated on every render.
const VALID_TAB_IDS = new Set(TABS.map(t => t.id));

// Read the current URL hash and return the corresponding valid tab ID, or
// null if the hash is empty / invalid. Browser hashes include the leading
// '#' character, which we strip before lookup.
const getTabFromHash = () => {
  if (typeof window === 'undefined') return null;
  const raw = (window.location.hash || '').replace(/^#/, '').trim().toLowerCase();
  return VALID_TAB_IDS.has(raw) ? raw : null;
};

// ── App shell ───────────────────────────────────────────────────────────────
const FantasyGolfLeague = () => {
  // Initial tab: read the URL hash (#rosters, #admin, etc) on first mount so
  // deep links / page refreshes land on the right tab. Falls back to
  // 'standings' for empty / invalid hashes. Lazy initializer ensures this
  // runs exactly once on mount, not on every render.
  const [activeTab, setActiveTab] = useState(() => getTabFromHash() || 'standings');

  // ── URL hash routing ────────────────────────────────────────────────────
  // Two-way sync between activeTab and window.location.hash so the browser
  // back/forward buttons navigate tabs, deep links work, and refresh keeps
  // the user on the same tab.
  //
  //   • activeTab change → write '#tab' to URL (creates a history entry)
  //   • hashchange event → read URL and update state (browser back/forward)
  //
  // Both sides guard against echo loops by checking whether the new value
  // actually differs from the current one before triggering an update.
  //
  // The 'standings' default tab does NOT write a hash to the URL — keeps
  // the homepage URL clean (sfglgolf.com instead of sfglgolf.com/#standings).
  // The hashchange listener still treats empty hash as 'standings'.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const current = (window.location.hash || '').replace(/^#/, '').toLowerCase();
    if (activeTab === 'standings') {
      // Strip the hash for the default tab — cosmetic, keeps URLs clean.
      // Use pushState so back/forward still navigates between tabs
      // (replaceState would erase history). Skipping the bare-already case.
      if (current && current !== '') {
        history.pushState(null, '', window.location.pathname + window.location.search);
        // pushState doesn't fire hashchange; manually dispatch so any other
        // listeners (none currently, but future-safe) see the navigation.
        // Note: not strictly needed for our own state since activeTab is
        // already 'standings' — included for completeness.
      }
    } else if (current !== activeTab) {
      // Non-default tab — sync URL. This creates a history entry, which is
      // what we want: each tab switch becomes browser back/forward-navigable.
      window.location.hash = activeTab;
    }
  }, [activeTab]);

  // Listen for browser back/forward navigation. The hashchange event fires
  // when the URL's hash changes — either from our setActiveTab effect above
  // (echo, guarded by the equality check) or from a user-driven nav action.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = () => {
      const next = getTabFromHash() || 'standings';
      // Only update if it actually differs — prevents an infinite loop with
      // the writer effect above. React would no-op anyway but skipping the
      // call is cleaner.
      setActiveTab(prev => prev === next ? prev : next);
    };
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);

  const [selectedTeam,          setSelectedTeam]          = useState(null);
  const [isCommissioner,        setIsCommissioner]        = useState(false);
  // Tagged via team.isCommissioner. Determines whether the user is *allowed*
  // to enter commish mode. Active commish mode (isCommissioner) is toggled
  // by tapping the user's name in the header.
  const [taggedCommissioner,    setTaggedCommissioner]    = useState(false);
  const [loggedInUser,          setLoggedInUser]          = useState(null);
  const [showLoginModal,        setShowLoginModal]        = useState(false);
  const [showUserSettings,      setShowUserSettings]      = useState(false);
  // (Password popover state removed — commish access is granted by team tag,
  // not by password. See handleManagerLogin and the AdminView Manager Accounts
  // panel for how the tag is set.)
  const [resultsHydrated,       setResultsHydrated]       = useState(false);

  const league = useLeague(STORAGE_KEYS);

  const {
    teams, tournaments, transactions, settings, globalPlayerStats,
    allPlayers, rankingsLastUpdated, headshots, loading, isSyncing,
    loadErrors, // Wave 7: surfaces Firebase failures to the UI
    setTournaments, setAllPlayers,
    updateTeams, updateTournaments, updateTransactions, updateSettings,
    updateGlobalStats, updateHeadshots, updateRankings,
    refetch, // Wave 7: lets PullToRefresh do a real refetch instead of window.location.reload()
  } = league;

  // Guard against useLeague returning null/undefined when Firebase load fails
  const safeTeams        = Array.isArray(teams)        ? teams        : [];
  const safeTournaments  = Array.isArray(tournaments)  ? tournaments  : [];
  const safeTransactions = Array.isArray(transactions) ? transactions : [];
  const safeHeadshots    = headshots && typeof headshots === 'object' ? headshots : {};

  const resolvedTeams     = safeTeams.length > 0 ? safeTeams : INITIAL_TEAMS;
  const resolvedHeadshots = Object.keys(safeHeadshots).length > 0 ? safeHeadshots : PGA_TOUR_IDS;
  const currentTournament = safeTournaments.find(t => t.playing);

  // ── Google Fonts is now loaded statically from index.html (Wave 1 cleanup) ──
  // Loading-screen styles + body font are in app-global.css.

  // ── Production error reporting ────────────────────────────────────────────
  // Wires window-level error + unhandledrejection listeners to POST sanitized
  // reports to /api/log-error. The reporter is rate-limited (5/session, 60s
  // dedupe) so a render-loop error can't spam the commish's inbox. React
  // errors are already covered by the ErrorBoundary in the JSX below — this
  // effect catches the async/event-handler errors React can't see.
  useEffect(() => {
    return addGlobalErrorReporters();
  }, []);

  // ── Clear the home-screen badge when the app is visible ───────────────────
  // The service worker calls navigator.setAppBadge() when a background push
  // arrives, which shows a red dot on the installed PWA's home-screen icon
  // (iOS 16.4+ for Add-to-Home-Screen installs; Android Chrome). Once the
  // user has the app open, the dot should clear — they're already here, the
  // "unread" state is moot.
  //
  // Cleared in two places:
  //   1. On mount  — covers fresh app opens (cold start from icon tap).
  //   2. On visibilitychange → 'visible' — covers tab-switch returns where
  //      the React tree was never unmounted (still resident from earlier).
  //
  // Feature-detected with the 'in' check because the Badging API isn't
  // implemented on every browser/version. Best-effort: a clear failure
  // shouldn't break anything else.
  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    const clearBadge = () => {
      if ('clearAppBadge' in navigator) {
        navigator.clearAppBadge().catch(() => {});
      }
    };
    const onVisChange = () => {
      if (document.visibilityState === 'visible') clearBadge();
    };
    clearBadge(); // initial mount — clear whatever the SW had set
    document.addEventListener('visibilitychange', onVisChange);
    return () => document.removeEventListener('visibilitychange', onVisChange);
  }, []);

  // ── Restore session on page load ──────────────────────────────────────────
  // Originally this effect re-ran on every resolvedTeams update (because
  // resolvedTeams was a dependency). That caused two problems:
  //
  //   1. Every updateTeams call (e.g. saving a lineup) triggered a
  //      subscription update → effect re-ran → setIsCommissioner(false) →
  //      kicked the commish out of commish mode mid-session.
  //
  //   2. If the initial run latched against stale localStorage data where
  //      team.isCommissioner was false, taggedCommissioner stayed false for
  //      the rest of the session even after fresh Firebase data arrived
  //      with isCommissioner=true. The "commish toggle disappears" bug —
  //      only fixable by clearing site data and re-logging in.
  //
  // Fix is two effects:
  //
  //   • This one (sessionRestoredRef-latched): runs ONCE, sets loggedInUser
  //     and resets isCommissioner. Latches so updateTeams calls can't reset
  //     the commish-mode toggle.
  //
  //   • The follow-up effect (below): runs continuously, keeps
  //     taggedCommissioner in sync with the CURRENT team document. Self-
  //     heals stale-data races and propagates real-time changes (e.g.
  //     another commish promoting/demoting via ManagerAccountsPanel).
  //
  // The sessionRestoredRef latches once we've SUCCESSFULLY completed the
  // restoration (or confirmed there's nothing to restore). Crucially we
  // don't latch when the team isn't yet found — on first mount,
  // `resolvedTeams` is the INITIAL_TEAMS placeholder (fake IDs) and the
  // find() returns nothing; we must keep retrying until real teams arrive.
  const sessionRestoredRef = useRef(false);
  useEffect(() => {
    if (sessionRestoredRef.current) return;
    managerAuthApi.getCurrentSession().then(session => {
      if (!session) {
        // No session → nothing to restore. Latch.
        sessionRestoredRef.current = true;
        return;
      }
      const teamId = localStorage.getItem('manager_team_id');
      if (!teamId) {
        // Session but no team ID stored → nothing further to do. Latch.
        sessionRestoredRef.current = true;
        return;
      }
      const team = resolvedTeams.find(t => t.id === teamId);
      if (!team) {
        // Team not found yet (placeholder INITIAL_TEAMS still in resolvedTeams).
        // Do NOT latch — let the effect retry when real teams arrive.
        return;
      }
      setLoggedInUser(team.owner || team.name);
      // taggedCommissioner is intentionally NOT set here — the sync effect
      // below owns that and keeps it accurate as data arrives/changes.
      // Active commish mode (isCommissioner) starts off; tagged commissioners
      // opt in by tapping their name in the header.
      setIsCommissioner(false);
      sessionRestoredRef.current = true;
    }).catch(() => {
      // Auth fetch error → latch to avoid infinite retries.
      sessionRestoredRef.current = true;
    });
  }, [resolvedTeams]);

  // ── Last-active heartbeat ───────────────────────────────────────────────
  // Records when each manager last used the app, so the commish console can
  // show real engagement ("Hip Happens — active 2h ago") rather than just
  // explicit logins (which are rare, since managers stay logged in via
  // localStorage for weeks).
  //
  // Writes lastActiveAt to the manager's OWN team doc via teamsApi.update
  // (single-field updateDoc — non-destructive, no subscription flicker, and
  // the three-state taggedCommissioner sync below ignores it). Fire-and-
  // forget; failures are logged but don't disrupt the user.
  //
  // Throttled to at most once per hour per device via localStorage. Fires on:
  //   • loggedInUser change (login / session restore)
  //   • document visibility flip to "visible" (PWA-reopen, tab-foreground)
  //
  // The visibility trigger is critical for PWAs: when iOS resumes the app
  // from background, no useEffect re-runs (loggedInUser is unchanged), but
  // a `visibilitychange` event fires. Without this, "active 2h ago" never
  // updates for someone who reopens the app every day.
  useEffect(() => {
    const sendHeartbeat = (trigger) => {
      if (!loggedInUser) {
        console.log('[heartbeat] skip — not logged in');
        return;
      }
      const teamId = localStorage.getItem('manager_team_id');
      if (!teamId) {
        console.log('[heartbeat] skip — no team id in localStorage');
        return;
      }

      const HEARTBEAT_THROTTLE_MS = 60 * 60 * 1000; // 1 hour
      const KEY = 'sfgl.lastHeartbeat';
      let lastBeat = 0;
      try { lastBeat = parseInt(localStorage.getItem(KEY) || '0', 10) || 0; } catch {}
      const now = Date.now();
      const elapsed = now - lastBeat;
      if (elapsed < HEARTBEAT_THROTTLE_MS) {
        console.log(`[heartbeat] throttled (${Math.round(elapsed / 60000)} min since last beat, need ≥60)`);
        return;
      }

      // Record the attempt time first so a slow/failed write doesn't cause a
      // tight retry loop on rapid re-renders.
      try { localStorage.setItem(KEY, String(now)); } catch {}

      const iso = new Date().toISOString();
      console.log(`[heartbeat] writing lastActiveAt=${iso} for team=${teamId} (trigger=${trigger})`);
      teamsApi.update(teamId, { lastActiveAt: iso })
        .then(() => console.log('[heartbeat] write OK'))
        .catch(err => console.warn('[heartbeat] write failed:', err?.message));
    };

    // Immediate fire on login / mount
    sendHeartbeat('mount');

    // Also fire when the tab becomes visible (PWA-resume, tab-foreground).
    const onVisible = () => {
      if (document.visibilityState === 'visible') sendHeartbeat('visibility');
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [loggedInUser]);
  // Runs every time resolvedTeams updates (Firebase subscription pushes a
  // new value, useLeague's initial load resolves, etc) or the user logs in
  // / out. Reads team.isCommissioner from the CURRENT team document and
  // mirrors it into local React state.
  //
  // THREE-STATE SEMANTICS (critical — this is the "commish toggle disappears
  // every time anything writes" bug fix):
  //
  //   • team.isCommissioner === true  → promote (set taggedCommissioner true)
  //   • team.isCommissioner === false → demote  (set taggedCommissioner false)
  //   • team.isCommissioner is undefined → NO-OP (preserve current state)
  //
  // The previous implementation used `!!team.isCommissioner`, which collapsed
  // undefined and false into the same downgrade path. Any momentary state
  // where the field was missing — an optimistic update with partial team
  // data, a stale Firestore snapshot before reconciliation, the 90s lineup
  // poll returning a team without the field — would silently downgrade
  // taggedCommissioner to false. Once Firebase eventually delivered the
  // canonical doc, the effect would re-run and restore it, but if the
  // subscription didn't re-fire (no actual DB change), local state stayed
  // wrong indefinitely. Clearing site data and re-logging in was the only
  // recovery because the login handler reads team.isCommissioner directly
  // from a fresh Firestore .get().
  //
  // Three-state handling preserves the real-time-update benefits (explicit
  // promotion/demotion via ManagerAccountsPanel still propagates live) while
  // never accidentally demoting a user from "undefined" data.
  //
  // Doesn't touch isCommissioner (current commish-mode toggle, separate
  // from being eligible). The session-restore latch above protects that.
  useEffect(() => {
    if (!loggedInUser) return;
    const teamId = localStorage.getItem('manager_team_id');
    if (!teamId) return;
    const team = resolvedTeams.find(t => t.id === teamId);
    if (!team) return;
    if (team.isCommissioner === true) {
      setTaggedCommissioner(true);
    } else if (team.isCommissioner === false) {
      setTaggedCommissioner(false);
    }
    // else: undefined → no-op, preserve current taggedCommissioner state
  }, [resolvedTeams, loggedInUser]);

  // ── Hydrate tournament results from Firebase ──────────────────────────────
  // Hydrate tournament results from Firebase once after load.
  // MERGE only — never overwrites a tournament that already has local results.
  // Remote results win only when the local tournament has none.
  //
  // Wave 6 hotfix: previously this effect would set `resultsHydrated = true`
  // even when `tournaments.length === 0` (e.g. when ?reset=1 had cleared
  // localStorage and the tournament-recovery effect hadn't seeded state yet).
  // That meant once recovery DID populate tournaments, this effect never
  // re-ran — leaving every team's earnings at $0 because results were never
  // merged in. Fix: bail without latching when tournaments is empty.
  useEffect(() => {
    if (loading || resultsHydrated) return;
    if (tournaments.length === 0) return; // wait for tournaments to populate, don't latch
    tournamentResultsApi.getAllForSeason().then(remoteResults => {
      if (!remoteResults || remoteResults.length === 0) { setResultsHydrated(true); return; }
      setTournaments(prev => prev.map(t => {
        // Keep local results if they already exist — don't overwrite with remote
        if (t.completed && t.results) return t;
        const remote = remoteResults.find(r => r.tournamentName === t.name);
        if (!remote) return t;
        return { ...t, completed: true, results: remote.results };
      }));
      setResultsHydrated(true);
    }).catch(e => {
      console.warn('Could not load results from Firebase:', e.message);
      setResultsHydrated(true);
    });
  }, [loading, tournaments.length, resultsHydrated]);


  // ── Wave 7-rollback: defensive direct-from-Firebase tournament recovery ──
  // After useLeague finishes its initial load, if `tournaments` is still
  // empty we try once more to fetch directly from Firebase. This is a
  // belt-and-suspenders backup for the case where useLeague's main loader
  // failed silently. It does NOT use any timeout — it waits as long as the
  // call needs and applies the result if successful.
  //
  // This was originally added in Wave 6 to recover mobile from a wedged
  // state. Wave 7 removed it under the (incorrect) assumption that the
  // rewritten useLeague would handle the case. After Wave 7's timeouts
  // proved harmful, we reverted useLeague to its original behaviour and
  // restored this effect as a safety net.
  const [tournamentsRecovered, setTournamentsRecovered] = useState(false);
  useEffect(() => {
    if (loading || tournamentsRecovered) return;
    if (tournaments.length > 0) {
      setTournamentsRecovered(true);
      return;
    }
    console.log('[App] tournaments empty after load — recovering from Firebase');
    import('./api/firebase').then(({ tournamentsApi }) => {
      tournamentsApi.getAll().then(remote => {
        if (remote && remote.length > 0) {
          console.log(`[App] recovered ${remote.length} tournaments from Firebase`);
          setTournaments(remote);
        } else {
          console.warn('[App] Firebase tournaments fetch returned empty — Firebase data may be missing');
        }
        setTournamentsRecovered(true);
      }).catch(err => {
        console.error('[App] Firebase tournaments fetch failed:', err);
        setTournamentsRecovered(true);
      });
    }).catch(err => {
      console.error('[App] Firebase module import failed:', err);
      setTournamentsRecovered(true);
    });
  }, [loading, tournaments.length, tournamentsRecovered]);


  // ── Auto-fetch headshots for all rostered players ────────────────────────
  // Runs whenever the roster set changes. Calls /api/headshots with every
  // rostered player name (subject to a 60s TTL to dedupe rapid renders).
  // The returned ESPN IDs get merged into the headshots map.
  //
  // Wave 8 (post Adam-Scott bug): previously used a permanent Set to dedupe,
  // which meant ANY single transient failure (ESPN 5xx, network blip, name
  // not yet indexed) blocked that player from being retried until full page
  // reload. Replaced with a Map of name→timestamp with a 60-second TTL.
  //
  // Wave 9 (post Alex-Fitzpatrick bug): the filter was also skipping players
  // who had a CACHED value, which prevented stale wrong mappings (like
  // Matt Fitzpatrick's ID being incorrectly cached for Alex) from ever
  // being corrected. Now every rostered player is subject to the TTL
  // refresh — cached, miscached, and uncached all get re-fetched after
  // the TTL expires. Static PGA_TOUR_IDS still take precedence and aren't
  // re-fetched (they're hard-coded fallbacks).
  const fetchAttemptsRef = useRef(new Map()); // name → timestamp of last attempt
  const HEADSHOT_RETRY_MS = 60 * 1000;
  useEffect(() => {
    if (loading) return;
    const allRostered = [...new Set(
      resolvedTeams.flatMap(t => (t.roster || []).map(p => p.name))
    )].filter(Boolean);
    if (!allRostered.length) return;

    // Skip names with a static PGA_TOUR_IDS fallback (hard-coded, never wrong)
    // and names attempted within the retry window. CACHED entries get
    // refreshed after the TTL so wrong mappings can self-heal.
    const now = Date.now();
    const toFetch = allRostered.filter(n => {
      if (PGA_TOUR_IDS[n]) return false;
      const lastAttempt = fetchAttemptsRef.current.get(n);
      if (lastAttempt && (now - lastAttempt) < HEADSHOT_RETRY_MS) return false;
      return true;
    });
    if (!toFetch.length) return;

    // Stamp attempt time BEFORE the fetch so a quick second roster change
    // doesn't trigger a duplicate in-flight request for the same names.
    toFetch.forEach(n => fetchAttemptsRef.current.set(n, now));

    const encoded = toFetch.map(n => encodeURIComponent(n)).join(',');
    fetch(`/api/headshots?names=${encoded}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.results && Object.keys(data.results).length > 0) {
          // CRITICAL: merge into headshots map — this OVERWRITES any stale
          // wrong values with the freshly-fetched correct ID. The
          // strict-matching in /api/headshots ensures we never overwrite
          // with a wrong relative's ID; if the player can't be uniquely
          // identified, they're absent from results (preserving any
          // existing value, but at least not making it worse).
          updateHeadshots(prev => ({ ...(prev || {}), ...data.results }));
          const found = Object.keys(data.results).length;
          const notFound = toFetch.length - found;
          console.log(`✓ Auto-fetched ${found} headshot IDs, ${notFound} not found (will retry in ${HEADSHOT_RETRY_MS / 1000}s if still missing)`);
          // Persist to player documents for future loads
          import('./api/firebase').then(({ playersApi }) => {
            const toSave = Object.entries(data.results).map(([name, espnId]) => ({ name, espnId }));
            if (toSave.length) playersApi.upsertMany(toSave).catch(() => {});
          }).catch(() => {});
        }
      })
      .catch(() => {});
  }, [loading, resolvedTeams]); // eslint-disable-line react-hooks/exhaustive-deps


  // ── Wave 7: surface Firebase load failures to user via toast ──────────────
  // The previous behavior (silently falling back to localStorage) is the root
  // cause of the May 2026 mobile-vs-desktop divergence. Now, if any collection
  // fails to load from Firebase on initial load OR on a refresh, show a toast.
  // ── Wave 7: Surface load failures so silent Firebase failures stop being silent
  // useLeague tracks which collections failed to load. We log a warning here
  // and (in a future wave) will surface a toast via DialogProvider.
  // The user can pull-to-refresh to retry.
  const [failureToastShown, setFailureToastShown] = useState(false);
  useEffect(() => {
    if (loading) return;
    if (failureToastShown) return;
    if (!loadErrors || loadErrors.length === 0) return;
    // Only mention the user-visible collections — silent failures of
    // 'rankings' / 'headshots' aren't worth distracting the user with.
    const userVisible = ['tournaments', 'teams', 'transactions', 'settings'];
    const visibleFailures = loadErrors.filter(f => userVisible.includes(f));
    if (visibleFailures.length === 0) {
      setFailureToastShown(true);
      return;
    }
    setFailureToastShown(true);
    // Plain console for now; a future wave will route this through DialogContext.
    console.warn(`[App] Couldn't reach Firebase for: ${visibleFailures.join(', ')}. Pull to refresh to retry.`);
  }, [loading, loadErrors, failureToastShown]);


  // ── Manager login ──────────────────────────────────────────────────────────
  const handleManagerLogin = (result) => {
    // result = { teamId } — resolve display name from loaded teams
    const team = resolvedTeams.find(t => t.id === result.teamId);
    // Blur any focused input and reset iOS viewport zoom
    if (document.activeElement) document.activeElement.blur();
    const mv = document.querySelector('meta[name=viewport]');
    if (mv) {
      mv.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1');
      setTimeout(() => mv.setAttribute('content', 'width=device-width, initial-scale=1'), 300);
    }
    setLoggedInUser(team ? (team.owner || team.name) : result.teamId);
    // Tagged commissioners can opt into commish mode by tapping their name
    // in the header. Login itself doesn't activate commish mode.
    setTaggedCommissioner(team ? !!team.isCommissioner : false);
    setIsCommissioner(false);
    setShowLoginModal(false);
  };

  // ── Logout ─────────────────────────────────────────────────────────────────
  const handleLogout = async () => {
    await managerAuthApi.logout();
    setLoggedInUser(null);
    setIsCommissioner(false);
    setTaggedCommissioner(false);
  };

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 24, background: '#111d2e', fontFamily: "'Raleway', system-ui, sans-serif" }}>
        {/* Loading-screen animations are now in app-global.css (Wave 1 cleanup) */}
        <div className="sfgl-logo-load" style={{ fontSize: fontSize.xxl, fontWeight: 600, letterSpacing: 10, color: 'rgba(255,255,255,0.9)' }}>SFGL</div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span className="sfgl-dot" />
          <span className="sfgl-dot" />
          <span className="sfgl-dot" />
        </div>
        <div style={{ fontSize: fontSize.sm, letterSpacing: 3, textTransform: 'uppercase', color: 'rgba(255,255,255,0.2)', fontWeight: 400 }}>Loading 2026 League</div>
      </div>
    );
  }

  return (
    <PullToRefresh onRefresh={refetch}>
    <div style={{ minHeight: '100vh', color: '#fff', background: '#111d2e', fontFamily: "'Raleway', system-ui, sans-serif", fontVariantNumeric: 'tabular-nums lining-nums' }}>

      {/* ── Sticky shell: header + banner + nav ──
          Background tints gold when commish mode is active — a full-header
          signal that complements the gold name button on the right side. */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 50,
        background: isCommissioner
          ? 'rgba(58, 47, 12, 0.97)'
          : 'rgba(8, 18, 40, 0.97)',
        backdropFilter: 'blur(12px)',
        borderBottom: isCommissioner
          ? '1px solid rgba(245,197,24,0.55)'
          : '1px solid rgba(180,160,100,0.15)',
        transition: 'background 0.25s, border-color 0.25s',
      }}>

        {/* ── Header ── */}
        <header>
          <div style={{ maxWidth: 1100, margin: "0 auto", padding: "12px 16px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>

              {/* Logo */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{
                  fontFamily: "'Raleway', system-ui, sans-serif",
                  fontSize: fontSize.xl, fontWeight: 600, letterSpacing: 5,
                  color: 'rgba(255,255,255,0.93)',
                  whiteSpace: 'nowrap', userSelect: 'none',
                }}>SFGL</span>
                <div style={{ width: 1, height: 22, background: 'rgba(180,160,100,0.25)' }} />
                <span style={{
                  fontFamily: "'Raleway', system-ui, sans-serif",
                  fontSize: fontSize.lg,
                  fontWeight: 400,
                  color: 'rgba(255,255,255,0.7)',
                  letterSpacing: 4,
                }}>2026</span>
              </div>

              {/* Right side: user + login/logout */}
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                {loggedInUser && (() => {
                  // Last name only — matches the visual weight of "2026" on
                  // the left side of the header. Splits on whitespace and
                  // takes the final token; works for "Aaron Jensen" →
                  // "Jensen" and for single-word usernames.
                  const lastName = String(loggedInUser).trim().split(/\s+/).pop();
                  // 2026 styling — used for the button so the layout doesn't
                  // shift when commish mode flips on/off.
                  const baseNameStyle = {
                    fontFamily: "'Raleway', system-ui, sans-serif",
                    fontSize: fontSize.lg,
                    letterSpacing: 4,
                    whiteSpace: 'nowrap',
                  };

                  // Wave J Round 6 batch 2: name-tap now opens the user
                  // settings modal for ALL logged-in users (not just
                  // commissioners). The modal contains commish-mode toggle
                  // (for tagged users), push notification subscription
                  // controls, and logout. Previously this button only
                  // existed for tagged commissioners and only toggled
                  // commish mode — now it's a proper user menu.
                  //
                  // Commissioners in active commish mode keep the gold
                  // tint as a visual indicator that mode is engaged.
                  return (
                    <button
                      onClick={() => setShowUserSettings(true)}
                      title="Open account settings"
                      aria-label="Open account settings"
                      style={{
                        ...baseNameStyle,
                        fontWeight: isCommissioner ? 700 : 400,
                        color: isCommissioner ? 'rgba(245,197,24,0.95)' : 'rgba(255,255,255,0.7)',
                        background: 'transparent',
                        border: 'none',
                        padding: 0,
                        cursor: 'pointer',
                        transition: 'color 0.2s, font-weight 0.2s',
                      }}
                    >
                      {lastName}
                    </button>
                  );
                })()}
                {!loggedInUser && !isCommissioner && (
                    <button onClick={() => setShowLoginModal(true)} aria-label="Open sign-in dialog" style={{
                      fontFamily: "'Raleway', system-ui, sans-serif",
                      fontSize: fontSize.sm,
                      letterSpacing: 1.5,
                      textTransform: 'uppercase',
                      padding: '8px 14px',
                      background: 'rgba(40,120,80,0.15)',
                      border: '1px solid rgba(80,195,120,0.35)',
                      borderRadius: 1,
                      color: 'rgba(80,195,120,0.9)',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                    }}>
                      Sign In
                    </button>
                )}
              </div>
            </div>
          </div>
        </header>

        {/* (Old full-width yellow Commissioner banner removed in Wave 3 — replaced
            by the gold "⚙ Commish" pill in the header right side above. Saves
            ~30px of vertical real-estate on every commish screen.) */}
        <div style={{ maxWidth: 1100, margin: "0 auto", padding: "4px 16px 12px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flex: 1 }}>
            <div style={{ fontFamily: "'Raleway', system-ui, sans-serif", fontSize: fontSize.md, letterSpacing: 1, fontWeight: 400, whiteSpace: 'nowrap' }}>
              {(() => {
                const active = safeTournaments.find(t => t.playing);
                const seg = active?.segment || safeTournaments.find(t => !t.completed && !t.playing)?.segment || [...safeTournaments].reverse().find(t => t.completed)?.segment || getSegmentByDate();
                return <span style={{ color: getSwingColor(seg) }}>{seg}</span>;
              })()}
            </div>
            {currentTournament && (
              <div className="sfgl-tournament-desktop" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: fontSize.md, color: '#f5c518', fontFamily: "'Raleway', system-ui, sans-serif", fontWeight: 400, letterSpacing: 0.5 }}>
                <span>⛳</span> {currentTournament.name}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {currentTournament && (
              <div className="sfgl-tournament-mobile" style={{ display: "none", alignItems: "center", gap: 6, fontSize: fontSize.md, color: '#f5c518', fontFamily: "'Raleway', system-ui, sans-serif", fontWeight: 400, letterSpacing: 0.5 }}>
                <span>⛳</span> {currentTournament.name}
              </div>
            )}
            {isSyncing && (
              <span style={{ fontSize: fontSize.sm, color: 'rgba(255,255,255,0.25)', letterSpacing: 1 }} className="sfgl-text-pulse">
                Saving…
              </span>
            )}
          </div>
        </div>

        {/* Nav moved to fixed bottom bar (see below the <main> element). */}
      </div>{/* end sticky shell */}

      {/* Smart "turn on notifications" nudge — self-gating (only shows to
          logged-in users on push-capable devices who haven't subscribed and
          haven't dismissed within the 1-day cooldown). Tapping opens settings
          where the subscribe toggle lives. */}
      <NotificationNudge
        loggedInUser={loggedInUser}
        onOpenSettings={() => setShowUserSettings(true)}
      />

      {/* ── Main content ── */}
      <main className="sfgl-main-content" style={{ maxWidth: 1100, margin: "0 auto", paddingTop: 16, paddingLeft: 16, paddingRight: 16 }}>

        <ErrorBoundary key={activeTab} tabName={activeTab}>
          {activeTab === 'standings' && (
            <StandingsView teams={resolvedTeams} tournaments={safeTournaments} transactions={safeTransactions} />
          )}
          {activeTab === 'rosters' && (
            <RostersView
              teams={resolvedTeams}
              selectedTeam={selectedTeam}
              setSelectedTeam={setSelectedTeam}
              updateTeams={updateTeams}
              tournaments={safeTournaments}
              allPlayers={allPlayers}
              transactions={safeTransactions}
              setTransactions={updateTransactions}
              settings={settings}
              loggedInUser={loggedInUser}
              isCommissioner={isCommissioner}
              globalPlayerStats={globalPlayerStats}
              headshots={resolvedHeadshots}
              updateHeadshots={updateHeadshots}
            />
          )}
          {activeTab === 'transactions' && (
            <Suspense fallback={<LazyFallback />}>
              <LazyTransactionsView
                transactions={safeTransactions}
                tournaments={safeTournaments}
                teams={resolvedTeams}
                allPlayers={allPlayers}
                setTransactions={updateTransactions}
                updateTeams={updateTeams}
                setTournaments={updateTournaments}
                isCommissioner={isCommissioner}
                settings={settings}
                loggedInUser={loggedInUser}
              />
            </Suspense>
          )}
          {activeTab === 'tournaments' && (
            <TournamentsView
              tournaments={safeTournaments}
              isCommissioner={isCommissioner}
              setTournaments={updateTournaments}
              teams={resolvedTeams}
              transactions={safeTransactions}
            />
          )}
          {activeTab === 'admin' && isCommissioner && (
            <Suspense fallback={<LazyFallback />}>
              <LazyAdminView
                isCommissioner={isCommissioner}
                setIsCommissioner={setIsCommissioner}
                setActiveTab={setActiveTab}
                settings={settings}
                setSettings={updateSettings}
                teams={resolvedTeams}
                updateTeams={updateTeams}
                tournaments={safeTournaments}
                setTournaments={updateTournaments}
                transactions={safeTransactions}
                setTransactions={updateTransactions}
                allPlayers={allPlayers}
                setAllPlayers={setAllPlayers}
                globalPlayerStats={globalPlayerStats}
                setGlobalPlayerStats={updateGlobalStats}
                headshots={resolvedHeadshots}
                setHeadshots={updateHeadshots}
                updateRankings={updateRankings}
                rankingsLastUpdated={rankingsLastUpdated}
                loggedInUser={loggedInUser}
              />
            </Suspense>
          )}
        </ErrorBoundary>
      </main>

      {/* ── Bottom Navigation (fixed) ──
          Mobile-first: nav lives at the bottom of the viewport. Generous
          paddingBottom (24px base + safe-area-inset) keeps tap targets well
          clear of the iOS home indicator / Siri activation zone, which on
          iPhone X+ extends ~34px up from the screen edge. */}
      <nav
        style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          zIndex: 50,
          background: 'rgba(8, 18, 40, 0.97)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          borderTop: '1px solid rgba(180,160,100,0.15)',
          paddingTop: 6,
          paddingBottom: 'calc(24px + env(safe-area-inset-bottom))',
        }}
      >
        <div
          style={{
            maxWidth: 600,
            margin: '0 auto',
            padding: '0 4px',
            display: 'flex',
            gap: 0,
            position: 'relative',
          }}
        >
          {TABS.filter(tab => tab.id !== 'admin' || isCommissioner).map(tab => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                className="sfgl-tab"
                onClick={() => setActiveTab(tab.id)}
                aria-current={isActive ? 'page' : undefined}
                style={{
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 3,
                  // Active state is colour-only — icon + label brighten to
                  // pure white. Inactive tabs sit at ~45% white (light gray).
                  // No border, no background fill, no layout shift.
                  border: 'none',
                  padding: '6px 4px 8px',
                  minHeight: 48,
                  background: 'transparent',
                  borderRadius: 6,
                  color: isActive
                    ? '#ffffff'
                    : 'rgba(255,255,255,0.45)',
                  cursor: 'pointer',
                  transition: 'color 0.18s',
                  outline: 'none',
                }}
              >
                <tab.Icon style={{ width: 20, height: 20 }} />
                <span style={{
                  fontFamily: "'Raleway', system-ui, sans-serif",
                  fontSize: fontSize.xs,
                  fontWeight: 500,
                  letterSpacing: 0.5,
                  whiteSpace: 'nowrap',
                }}>{tab.label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* ── Manager Login Modal ── */}
      {showLoginModal && (
        <div style={{
          position: 'fixed', inset: 0,
          background: 'rgba(5, 10, 25, 0.88)',
          backdropFilter: 'blur(6px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 60, padding: 16,
        }}>
          <div style={{ position: 'relative' }}>
            <Suspense fallback={<LazyFallback />}>
              <LazyLoginPage onLogin={handleManagerLogin} />
            </Suspense>
            <button
              onClick={() => setShowLoginModal(false)}
              aria-label="Close"
              style={{
                position: 'absolute', top: 12, right: 12,
                background: 'none', border: 'none',
                color: 'rgba(255,255,255,0.55)',
                fontSize: fontSize.xl, cursor: 'pointer',
                lineHeight: 1, zIndex: 51,
                transition: 'color 0.2s',
                padding: 10,
                minWidth: 44, minHeight: 44,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
              onMouseEnter={e => e.currentTarget.style.color = 'rgba(255,255,255,0.85)'}
              onMouseLeave={e => e.currentTarget.style.color = 'rgba(255,255,255,0.55)'}
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* ── User Settings Modal (Wave J Round 6 batch 2) ── */}
      {/* Opened by tapping the user's name in the header. Replaces the
          previous tap-to-toggle-commish behavior — that toggle is now an
          option inside the modal, alongside push notifications. */}
      <UserSettingsModal
        isOpen={showUserSettings}
        onClose={() => setShowUserSettings(false)}
        loggedInUser={loggedInUser}
        teams={resolvedTeams}
        updateTeams={updateTeams}
        isCommissioner={isCommissioner}
        setIsCommissioner={setIsCommissioner}
        taggedCommissioner={taggedCommissioner}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
      />
    </div>
    </PullToRefresh>
  );
};

// ── Root with providers ──────────────────────────────────────────────────────
const App = () => (
  <DialogProvider>
    <FantasyGolfLeague />
  </DialogProvider>
);

export default App;
