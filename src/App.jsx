import React, { useState, useEffect, useRef, useMemo, Suspense } from 'react';
import { Trophy, Users, DollarSign, Calendar, Settings, MoreHorizontal, Bell, Shield, LogOut, LogIn } from 'lucide-react';
import { Capacitor } from '@capacitor/core';

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
import { managerAuthApi, tournamentResultsApi } from './api/firebase';
import { managerActivityApi } from './api/managerActivity';


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

// Shared style for rows in the bottom "More" (...) popup menu.
const MORE_MENU_ITEM_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  width: '100%',
  padding: '11px 14px',
  background: 'transparent',
  border: 'none',
  borderRadius: 7,
  color: 'rgba(255,255,255,0.88)',
  fontFamily: "'Raleway', system-ui, sans-serif",
  fontSize: 15,
  fontWeight: 500,
  letterSpacing: 0.3,
  textAlign: 'left',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

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

  // ── Native (Capacitor) status bar ──
  // On the iOS/Android app, use light status-bar icons so the clock and
  // battery stay readable on the navy header. No-op in the browser.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    import('@capacitor/status-bar')
      .then(({ StatusBar, Style }) => StatusBar.setStyle({ style: Style.Dark }))
      .catch(() => {});
  }, []);

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
  // taggedCommissioner is DERIVED below from the logged-in team (see useMemo
  // after resolvedTeams) so it can never be left stale or spuriously reset by
  // an effect re-run. Do not reintroduce it as imperative state.
  const [loggedInUser,          setLoggedInUser]          = useState(null);
  // Immutable identity of the team the manager authenticated into. Edit
  // permissions key off THIS (team id), never the editable owner string —
  // renaming a manager's login/owner name must never lock them out of their
  // own lineup. Sourced from the session (localStorage 'manager_team_id').
  const [loggedInTeamId,        setLoggedInTeamId]        = useState(null);
  const [showLoginModal,        setShowLoginModal]        = useState(false);
  const [showUserSettings,      setShowUserSettings]      = useState(false);
  const [showMoreMenu,          setShowMoreMenu]          = useState(false);
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

  // Whether the logged-in manager is *allowed* to enter commish mode. Derived
  // from the current team list + loggedInTeamId so it's always accurate: it
  // recomputes when teams finish loading (fixing the "team not found on first
  // paint" race) and can't be wiped by a stale session-restore re-run. Active
  // commish MODE (isCommissioner) remains separate, user-toggled state.
  const taggedCommissioner = useMemo(() => {
    if (!loggedInTeamId) return false;
    const team = resolvedTeams.find(t => t.id === loggedInTeamId);
    return !!team?.isCommissioner;
  }, [loggedInTeamId, resolvedTeams]);
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
  // ONE-SHOT. This effect lists `resolvedTeams` as a dependency because it
  // needs the team list loaded before it can resolve the logged-in team. But
  // `resolvedTeams` changes every time teams data updates — including when a
  // commissioner edits a manager's lineup. Without a guard, the effect re-ran
  // on every such edit and called setIsCommissioner(false), kicking the
  // commish out of commish mode mid-edit (one player pick = one logout).
  //
  // The ref latches as soon as we've resolved the logged-in team (or
  // confirmed there's no session), so the restore runs exactly once on load
  // and never resets commish mode again. Explicit login/logout still set
  // commish state directly via their own handlers — they don't go through here.
  const sessionRestoredRef = useRef(false);
  useEffect(() => {
    if (sessionRestoredRef.current) return;            // already restored — never re-run
    if (!resolvedTeams || resolvedTeams.length === 0) return; // wait for teams to load

    managerAuthApi.getCurrentSession().then(session => {
      if (!session) {
        sessionRestoredRef.current = true;             // no session — nothing to restore, latch
        return;
      }
      const teamId = localStorage.getItem('manager_team_id');
      if (!teamId) {
        sessionRestoredRef.current = true;             // session but no team id — latch
        return;
      }
      setLoggedInTeamId(teamId);
      const team = resolvedTeams.find(t => t.id === teamId);
      if (team) {
        setLoggedInUser(team.owner || team.name);
        // Record this session as a "login" for the Manager Activity panel.
        // Managers stay signed in via localStorage, so this session-restore
        // heartbeat — not managerAuthApi.login() — is what keeps last-login
        // accurate for daily-active users. Best-effort; never blocks restore.
        managerActivityApi.recordLogin(teamId);
        // taggedCommissioner is derived from loggedInTeamId — no need to set it
        // here. Start the session in normal-manager view; commissioners opt into
        // commish mode by tapping their name in the header.
        setIsCommissioner(false);
        sessionRestoredRef.current = true;             // resolved — latch, never reset again
      }
      // If the team wasn't found yet (teams still loading incrementally),
      // we intentionally do NOT latch — the effect re-runs on the next
      // resolvedTeams change and tries again until the team resolves.
    }).catch(() => {});
  }, [resolvedTeams]);

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

  // ── Publish sticky-header height as --sfgl-header-h ──────────────────
  // Lets sticky descendants (e.g. the RostersView lineup card) pin flush
  // beneath the header even as it grows/shrinks (long tournament names wrap).
  const headerRef = useRef(null);
  useEffect(() => {
    const el = headerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const publish = () => {
      document.documentElement.style.setProperty('--sfgl-header-h', `${el.offsetHeight}px`);
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => ro.disconnect();
  }, [loading]);
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
    setLoggedInTeamId(result.teamId);
    // Record the login for the Manager Activity panel.
    managerActivityApi.recordLogin(result.teamId);
    // taggedCommissioner derives from loggedInTeamId (set above). Login itself
    // doesn't activate commish mode — managers opt in via the header toggle.
    setIsCommissioner(false);
    setShowLoginModal(false);
  };

  // ── Logout ─────────────────────────────────────────────────────────────────
  const handleLogout = async () => {
    await managerAuthApi.logout();
    setLoggedInUser(null);
    setLoggedInTeamId(null);
    setIsCommissioner(false);
    // taggedCommissioner derives to false automatically once loggedInTeamId is null.
    setShowUserSettings(false);
    // The Commish tab renders nothing once commish mode is gone, so send the
    // now-signed-out user back to a safe public tab.
    setActiveTab(prev => (prev === 'admin' ? 'standings' : prev));
  };

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 24, background: '#111d2e', fontFamily: "'Raleway', system-ui, sans-serif" }}>
        {/* Loading-screen animations are now in app-global.css (Wave 1 cleanup) */}
        <div className="sfgl-logo-load" style={{ fontFamily: "'Raleway', system-ui, sans-serif", fontSize: fontSize.xl, fontWeight: 600, letterSpacing: 5, color: 'rgba(255,255,255,0.93)', userSelect: 'none' }}>SFGL</div>
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
    <>
    <PullToRefresh onRefresh={refetch}>
    <div style={{ minHeight: '100vh', color: '#fff', background: '#111d2e', fontFamily: "'Raleway', system-ui, sans-serif", fontVariantNumeric: 'tabular-nums lining-nums' }}>

      {/* ── Sticky shell: header + banner + nav ──
          Background tints gold when commish mode is active — a full-header
          signal that complements the gold name button on the right side. */}
      <div ref={headerRef} style={{
        position: 'sticky', top: 0, zIndex: 50,
        paddingTop: 'env(safe-area-inset-top)',
        background: isCommissioner
          ? 'rgba(58, 47, 12, 0.97)'
          : 'rgba(8, 18, 40, 0.97)',
        backdropFilter: 'blur(12px)',
        borderBottom: isCommissioner
          ? '1px solid rgba(245,197,24,0.55)'
          : '1px solid rgba(180,160,100,0.15)',
        transition: 'background 0.25s, border-color 0.25s',
      }}>

        {/* ── Header: current tournament (left) · SFGL (center) · current swing (right) ── */}
        <header>
          <div style={{ maxWidth: 720, margin: "0 auto", padding: "16px 16px 16px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto minmax(0, 1fr)", alignItems: "center", gap: 12 }}>

              {/* Left: current tournament (cell always rendered to hold the grid column) */}
              <div style={{ justifySelf: 'start', minWidth: 0, maxWidth: '100%' }}>
                {currentTournament && (
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: fontSize.md, fontWeight: 400, letterSpacing: 1, color: '#f5c518', fontFamily: "'Raleway', system-ui, sans-serif", minWidth: 0, lineHeight: 1.3 }}>
                    <span style={{ flexShrink: 0 }}>⛳</span>
                    <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{currentTournament.name}</span>
                  </div>
                )}
              </div>

              {/* Center: SFGL wordmark (the anchor) */}
              <span style={{ fontFamily: "'Raleway', system-ui, sans-serif", fontSize: fontSize.xl, fontWeight: 600, letterSpacing: 5, color: 'rgba(255,255,255,0.93)', whiteSpace: 'nowrap', userSelect: 'none', justifySelf: 'center' }}>SFGL</span>

              {/* Right: current swing */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, justifySelf: 'end', minWidth: 0, textAlign: 'right' }}>
                {(() => {
                  const active = safeTournaments.find(t => t.playing);
                  const seg = active?.segment || safeTournaments.find(t => !t.completed && !t.playing)?.segment || [...safeTournaments].reverse().find(t => t.completed)?.segment || getSegmentByDate();
                  return (
                    <span style={{ fontFamily: "'Raleway', system-ui, sans-serif", fontSize: fontSize.md, fontWeight: 500, letterSpacing: 1, whiteSpace: 'nowrap', color: getSwingColor(seg) }}>{seg}</span>
                  );
                })()}
                {isSyncing && (
                  <span style={{ fontSize: fontSize.sm, color: 'rgba(255,255,255,0.25)', letterSpacing: 1 }} className="sfgl-text-pulse">
                    Saving…
                  </span>
                )}
              </div>

            </div>
          </div>
        </header>

        {/* Nav moved to fixed bottom bar (see below the <main> element). */}
      </div>{/* end sticky shell */}

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
              loggedInTeamId={loggedInTeamId}
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
    </div>{/* end scrollable app shell */}
    </PullToRefresh>

      {/* ── Bottom Navigation (fixed) ──
          Mobile-first: nav lives at the bottom of the viewport. A small
          paddingBottom (8px base + safe-area-inset) keeps tap targets well
          clear of the iOS home indicator / Siri activation zone, which on
          iPhone X+ extends ~34px up from the screen edge.

          NOTE: this <nav> (and the modals below) MUST stay OUTSIDE
          <PullToRefresh>. PullToRefresh wraps its children in a div that
          carries a `transform` (and transform transition) for the pull
          gesture. On iOS Safari that wrapper becomes the containing block
          for any descendant `position: fixed`, which re-anchors the nav to
          the scrolling content instead of the viewport — making it "float"
          mid-page. Keeping it a sibling of PullToRefresh guarantees it stays
          pinned to the true viewport bottom. */}
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
          paddingBottom: 'calc(8px + env(safe-area-inset-bottom))',
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
                  // Active state is colour-only — the active tab turns bright
                  // bold white; the commish (admin) tab turns gold when active.
                  // No border, no background fill, no layout shift.
                  border: 'none',
                  padding: '6px 4px 8px',
                  minHeight: 48,
                  background: 'transparent',
                  borderRadius: 6,
                  color: isActive
                    ? (tab.id === 'admin' ? '#f5c518' : 'rgba(255,255,255,0.98)')
                    : 'rgba(255,255,255,0.55)',
                  cursor: 'pointer',
                  transition: 'color 0.18s',
                  outline: 'none',
                }}
              >
                <tab.Icon style={{ width: 20, height: 20 }} />
                <span style={{
                  fontFamily: "'Raleway', system-ui, sans-serif",
                  fontSize: fontSize.xs,
                  fontWeight: isActive ? 700 : 500,
                  letterSpacing: 0.5,
                  whiteSpace: 'nowrap',
                }}>{tab.label}</span>
              </button>
            );
          })}
            <button
              className="sfgl-tab"
              onClick={() => setShowMoreMenu(v => !v)}
              aria-haspopup="menu"
              aria-expanded={showMoreMenu}
              aria-label="More options"
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 3,
                border: 'none',
                padding: '6px 4px 8px',
                minHeight: 48,
                background: 'transparent',
                borderRadius: 6,
                color: showMoreMenu ? 'rgba(255,255,255,0.98)' : 'rgba(255,255,255,0.55)',
                cursor: 'pointer',
                transition: 'color 0.18s',
                outline: 'none',
              }}
            >
              <MoreHorizontal style={{ width: 20, height: 20 }} />
              <span style={{
                fontFamily: "'Raleway', system-ui, sans-serif",
                fontSize: fontSize.xs,
                fontWeight: 500,
                letterSpacing: 0.5,
                whiteSpace: 'nowrap',
              }}>More</span>
            </button>
        </div>
      </nav>

      {/* More / overflow menu (opened from the "..." nav tab) */}
      {showMoreMenu && (
        <>
          <div
            onClick={() => setShowMoreMenu(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 55, background: 'transparent' }}
            aria-hidden="true"
          />
          <div
            role="menu"
            style={{
              position: 'fixed',
              bottom: 'calc(76px + env(safe-area-inset-bottom))',
              right: 'max(8px, calc((100vw - 600px) / 2 + 8px))',
              zIndex: 60,
              minWidth: 210,
              background: 'rgba(12, 24, 48, 0.98)',
              backdropFilter: 'blur(12px)',
              WebkitBackdropFilter: 'blur(12px)',
              border: '1px solid rgba(180,160,100,0.22)',
              borderRadius: 10,
              boxShadow: '0 8px 28px rgba(0,0,0,0.45)',
              overflow: 'hidden',
              padding: 4,
            }}
          >
            {loggedInUser && (
            <button
              role="menuitem"
              onClick={() => { setShowMoreMenu(false); setShowUserSettings(true); }}
              style={MORE_MENU_ITEM_STYLE}
            >
              <Bell style={{ width: 18, height: 18, opacity: 0.85 }} />
              <span>Notifications</span>
            </button>
            )}

            {taggedCommissioner && (
              <button
                role="menuitem"
                onClick={() => {
                  setShowMoreMenu(false);
                  const next = !isCommissioner;
                  setIsCommissioner(next);
                  if (next) setActiveTab('admin');
                  else setActiveTab(t => (t === 'admin' ? 'standings' : t));
                }}
                style={{ ...MORE_MENU_ITEM_STYLE, color: isCommissioner ? '#f5c518' : MORE_MENU_ITEM_STYLE.color }}
              >
                <Shield style={{ width: 18, height: 18, opacity: 0.85 }} />
                <span>Admin</span>
              </button>
            )}

            {loggedInUser ? (
            <button
              role="menuitem"
              onClick={() => { setShowMoreMenu(false); handleLogout(); }}
              style={{ ...MORE_MENU_ITEM_STYLE, color: 'rgba(235,130,130,0.95)' }}
            >
              <LogOut style={{ width: 18, height: 18, opacity: 0.85 }} />
              <span>Sign Out</span>
            </button>
            ) : (
            <button
              role="menuitem"
              onClick={() => { setShowMoreMenu(false); setShowLoginModal(true); }}
              style={{ ...MORE_MENU_ITEM_STYLE, color: 'rgba(80,195,120,0.95)' }}
            >
              <LogIn style={{ width: 18, height: 18, opacity: 0.85 }} />
              <span>Sign In</span>
            </button>
            )}
          </div>
        </>
      )}

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
        onLogout={handleLogout}
        loggedInUser={loggedInUser}
        loggedInTeamId={loggedInTeamId}
        teams={resolvedTeams}
        updateTeams={updateTeams}
        isCommissioner={isCommissioner}
        setIsCommissioner={setIsCommissioner}
        taggedCommissioner={taggedCommissioner}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
      />
    </>
  );
};

// ── Root with providers ──────────────────────────────────────────────────────
const App = () => (
  <DialogProvider>
    <FantasyGolfLeague />
  </DialogProvider>
);

export default App;
