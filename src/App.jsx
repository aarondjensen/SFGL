import React, { useState, useEffect, useRef, Suspense } from 'react';
import { Trophy, Award, Users, DollarSign, Calendar, Settings } from 'lucide-react';

// ── ?reset=1 cache flush ──
if (typeof window !== 'undefined') {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.has('reset')) {
      Object.keys(localStorage)
        .filter(k => k.startsWith('sfgl-') || k.startsWith('fantasy-golf-'))
        .forEach(k => localStorage.removeItem(k));
      console.log('[?reset=1] Cleared SFGL localStorage');
      window.location.replace(window.location.pathname);
    }
  } catch (e) {
    console.warn('Cache reset failed:', e);
  }
}

import { DialogProvider } from './pages/DialogContext';
import { ErrorBoundary }  from './pages/ErrorBoundary';
import { PullToRefresh }  from './pages/PullToRefresh';

// ── Eagerly loaded views ──
import { StandingsView }  from './pages/StandingsView';
import { ResultsView }    from './pages/ResultsView';
import { RostersView }    from './pages/RostersView';
import { TournamentsView }  from './pages/TournamentsView';

// ── Lazy-loaded views ──
const LazyAdminView        = React.lazy(() => import('./pages/AdminView').then(m => ({ default: m.AdminView })));
const LazyTransactionsView = React.lazy(() => import('./pages/TransactionsView').then(m => ({ default: m.TransactionsView })));
const LazyLoginPage        = React.lazy(() => import('./pages/LoginPage'));

import { useLeague }       from './hooks';
import { getSegmentByDate } from './utils';
import { theme, colors, fonts, fontSize, getSwingColor } from './theme.js';
// COMMISSIONER_PASSWORD_HASH no longer imported — admin access is now derived
// from settings.adminTeamIds (managed via the ManagerAccountsPanel UI). Safe
// to leave the constant exported elsewhere; nothing reads it anymore.
import { STORAGE_KEYS, INITIAL_TEAMS, PGA_TOUR_IDS } from './constants';
import { managerAuthApi, tournamentResultsApi } from './api/firebase';


// ── Lazy-load fallback spinner ──
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

// ── User-facing tabs ──
const TABS = [
  { id: 'standings',    label: 'Standings',    Icon: Trophy     },
  { id: 'rosters',      label: 'Rosters',      Icon: Users      },
  { id: 'results',      label: 'Results',      Icon: Award      },
  { id: 'transactions', label: 'Transactions', Icon: DollarSign },
  { id: 'tournaments',  label: 'Schedule',     Icon: Calendar   },
];

// ── App shell ───────────────────────────────────────────────────────────────
const FantasyGolfLeague = () => {
  const [activeTab,             setActiveTab]             = useState('standings');
  const [selectedTeam,          setSelectedTeam]          = useState(null);
  const [loggedInUser,          setLoggedInUser]          = useState(null);
  const [loggedInTeamId,        setLoggedInTeamId]        = useState(null);
  const [showLoginModal,        setShowLoginModal]        = useState(false);
  const [resultsHydrated,       setResultsHydrated]       = useState(false);

  const league = useLeague(STORAGE_KEYS);

  const {
    teams, tournaments, transactions, settings, globalPlayerStats,
    allPlayers, rankingsLastUpdated, headshots, loading, isSyncing,
    loadErrors,
    setTournaments, setAllPlayers,
    updateTeams, updateTournaments, updateTransactions, updateSettings,
    updateGlobalStats, updateHeadshots, updateRankings,
    refetch,
  } = league;

  const safeTeams        = Array.isArray(teams)        ? teams        : [];
  const safeTournaments  = Array.isArray(tournaments)  ? tournaments  : [];
  const safeTransactions = Array.isArray(transactions) ? transactions : [];
  const safeHeadshots    = headshots && typeof headshots === 'object' ? headshots : {};

  const resolvedTeams     = safeTeams.length > 0 ? safeTeams : INITIAL_TEAMS;
  const resolvedHeadshots = Object.keys(safeHeadshots).length > 0 ? safeHeadshots : PGA_TOUR_IDS;
  const currentTournament = safeTournaments.find(t => t.playing);

  // ── Derive isCommissioner from settings.adminTeamIds ─────────────────────
  // Replaces the old standalone-password admin login. Admin access is now
  // a property of which manager you logged in as, so:
  //   • Not signed in → never commish
  //   • Signed in, your team is in settings.adminTeamIds → commish
  //   • Signed in, no admin team IDs configured yet (transition period
  //     after first deploy) → any signed-in manager gets commish access.
  //     Once anyone is tagged, this fallback no longer applies.
  //
  // The fallback exists so the very first deploy isn't locked out before
  // an admin can be tagged. Tag yourself as admin via the Manager Accounts
  // panel and the fallback stops mattering.
  const adminTeamIds = Array.isArray(settings?.adminTeamIds) ? settings.adminTeamIds : [];
  const noAdminsConfiguredYet = adminTeamIds.length === 0;
  const isCommissioner = !!loggedInTeamId && (
    noAdminsConfiguredYet || adminTeamIds.includes(loggedInTeamId)
  );

  // ── Restore session on page load ──
  useEffect(() => {
    managerAuthApi.getCurrentSession().then(session => {
      if (!session) return;
      const teamId = localStorage.getItem('manager_team_id');
      if (teamId) {
        const team = resolvedTeams.find(t => t.id === teamId);
        if (team) {
          setLoggedInUser(team.owner || team.name);
          setLoggedInTeamId(team.id);
        }
      }
    }).catch(() => {});
  }, [resolvedTeams]);

  // ── Hydrate tournament results from Firebase ──
  useEffect(() => {
    if (loading || resultsHydrated) return;
    if (tournaments.length === 0) return;
    tournamentResultsApi.getAllForSeason().then(remoteResults => {
      if (!remoteResults || remoteResults.length === 0) { setResultsHydrated(true); return; }
      setTournaments(prev => prev.map(t => {
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

  // ── Tournament recovery ──
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


  // ── Auto-fetch headshots ──
  const fetchAttemptsRef = useRef(new Map());
  const HEADSHOT_RETRY_MS = 60 * 1000;
  useEffect(() => {
    if (loading) return;
    const allRostered = [...new Set(
      resolvedTeams.flatMap(t => (t.roster || []).map(p => p.name))
    )].filter(Boolean);
    if (!allRostered.length) return;

    const now = Date.now();
    const missing = allRostered.filter(n => {
      if (safeHeadshots[n]) return false;
      if (PGA_TOUR_IDS[n]) return false;
      const lastAttempt = fetchAttemptsRef.current.get(n);
      if (lastAttempt && (now - lastAttempt) < HEADSHOT_RETRY_MS) return false;
      return true;
    });
    if (!missing.length) return;

    missing.forEach(n => fetchAttemptsRef.current.set(n, now));

    const encoded = missing.map(n => encodeURIComponent(n)).join(',');
    fetch(`/api/headshots?names=${encoded}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.results && Object.keys(data.results).length > 0) {
          updateHeadshots(prev => ({ ...(prev || {}), ...data.results }));
          const found = Object.keys(data.results).length;
          const notFound = missing.length - found;
          console.log(`✓ Auto-fetched ${found} headshot IDs, ${notFound} not found (will retry in ${HEADSHOT_RETRY_MS / 1000}s if still missing)`);
          import('./api/firebase').then(({ playersApi }) => {
            const toSave = Object.entries(data.results).map(([name, espnId]) => ({ name, espnId }));
            if (toSave.length) playersApi.upsertMany(toSave).catch(() => {});
          }).catch(() => {});
        }
      })
      .catch(() => {});
  }, [loading, resolvedTeams]); // eslint-disable-line react-hooks/exhaustive-deps


  // ── Surface load failures ──
  const [failureToastShown, setFailureToastShown] = useState(false);
  useEffect(() => {
    if (loading) return;
    if (failureToastShown) return;
    if (!loadErrors || loadErrors.length === 0) return;
    const userVisible = ['tournaments', 'teams', 'transactions', 'settings'];
    const visibleFailures = loadErrors.filter(f => userVisible.includes(f));
    if (visibleFailures.length === 0) {
      setFailureToastShown(true);
      return;
    }
    setFailureToastShown(true);
    console.warn(`[App] Couldn't reach Firebase for: ${visibleFailures.join(', ')}. Pull to refresh to retry.`);
  }, [loading, loadErrors, failureToastShown]);


  // ── Admin gear icon click handler ─────────────────────────────────────────
  // The gear icon only renders for users who are commish (see render below),
  // so this handler only deals with the "navigate" or "exit" cases. There
  // is no longer a "log in as commish" path through the gear — admin status
  // flows from the manager login.
  const handleAdminGearClick = () => {
    if (activeTab === 'admin') {
      // Already on admin → return to standings (treat as "leave admin view")
      setActiveTab('standings');
    } else {
      setActiveTab('admin');
    }
  };

  // ── Manager login ──
  const handleManagerLogin = (result) => {
    const team = resolvedTeams.find(t => t.id === result.teamId);
    if (document.activeElement) document.activeElement.blur();
    const mv = document.querySelector('meta[name=viewport]');
    if (mv) {
      mv.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1');
      setTimeout(() => mv.setAttribute('content', 'width=device-width, initial-scale=1'), 300);
    }
    setLoggedInUser(team ? (team.owner || team.name) : result.teamId);
    setLoggedInTeamId(team ? team.id : result.teamId);
    setShowLoginModal(false);
  };

  const handleLogout = async () => {
    await managerAuthApi.logout();
    setLoggedInUser(null);
    setLoggedInTeamId(null);
    // If commish was on the admin tab, return them to standings on logout —
    // the admin tab won't render once isCommissioner flips to false anyway,
    // but explicit nav avoids a blank-content frame.
    if (activeTab === 'admin') setActiveTab('standings');
  };

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 24, background: '#111d2e', fontFamily: "'Raleway', system-ui, sans-serif" }}>
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
    <PullToRefresh>
    <div style={{ minHeight: '100vh', color: '#fff', background: '#111d2e', fontFamily: "'Raleway', system-ui, sans-serif", fontVariantNumeric: 'tabular-nums lining-nums' }}>

      {/* ── Sticky shell: header + tournament context strip ── */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 50,
        background: 'rgba(8, 18, 40, 0.97)',
        backdropFilter: 'blur(12px)',
        borderBottom: '1px solid rgba(180,160,100,0.15)',
      }}>

        {/* ── Header ── */}
        <header style={{ position: 'relative' }}>
          <div style={{ maxWidth: 1100, margin: "0 auto", padding: "12px 16px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>

              {/* Logo */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span
                  onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
                  style={{
                    fontFamily: "'Raleway', system-ui, sans-serif",
                    fontSize: fontSize.xl, fontWeight: 600, letterSpacing: 5,
                    color: 'rgba(255,255,255,0.93)',
                    whiteSpace: 'nowrap', userSelect: 'none', cursor: 'pointer',
                  }}
                >SFGL</span>
                <div style={{ width: 1, height: 22, background: 'rgba(180,160,100,0.25)' }} />
                <span style={{
                  fontFamily: "'Raleway', system-ui, sans-serif",
                  fontSize: fontSize.lg,
                  fontWeight: 400,
                  color: 'rgba(255,255,255,0.7)',
                  letterSpacing: 4,
                }}>2026</span>
              </div>

              {/* Right side: user · admin gear · sign in/out */}
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {loggedInUser && (
                  <span style={{
                    fontSize: fontSize.base,
                    color: 'rgba(255,255,255,0.45)',
                    letterSpacing: 1,
                    textTransform: 'uppercase',
                    fontFamily: "'Raleway', system-ui, sans-serif",
                  }}>
                    {loggedInUser}
                  </span>
                )}

                {/* Admin gear icon — only visible to signed-in admins.
                    Replaces the old password popover. Tapping toggles
                    between the admin tab and standings. */}
                {isCommissioner && (
                  <button
                    onClick={handleAdminGearClick}
                    aria-label={activeTab === 'admin' ? 'Leave admin panel' : 'Open admin panel'}
                    title={activeTab === 'admin' ? 'Leave admin panel' : 'Admin'}
                    style={{
                      background: activeTab === 'admin' ? 'rgba(245,197,24,0.18)' : 'rgba(245,197,24,0.10)',
                      border: '1px solid rgba(245,197,24,0.55)',
                      borderRadius: 2,
                      padding: 7,
                      color: 'rgba(245,197,24,0.95)',
                      cursor: 'pointer',
                      transition: 'all 0.15s',
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      minWidth: 32, minHeight: 32,
                    }}
                  >
                    <Settings style={{ width: 14, height: 14 }} />
                  </button>
                )}

                {loggedInUser && (
                  <button onClick={handleLogout} aria-label="Sign out of your account" style={{
                    fontFamily: "'Raleway', system-ui, sans-serif",
                    fontSize: fontSize.sm,
                    letterSpacing: 1.5,
                    textTransform: 'uppercase',
                    padding: '8px 14px',
                    background: 'rgba(180,60,60,0.12)',
                    border: '1px solid rgba(180,60,60,0.3)',
                    borderRadius: 1,
                    color: 'rgba(220,120,120,0.8)',
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                  }}>
                    Sign Out
                  </button>
                )}
                {!loggedInUser && (
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

        {/* ── Tournament context strip — swing + active tournament ── */}
        <div style={{ maxWidth: 1100, margin: "0 auto", padding: "4px 16px 8px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: "'Raleway', system-ui, sans-serif", fontSize: fontSize.md, letterSpacing: 1, fontWeight: 400, whiteSpace: 'nowrap' }}>
              {(() => {
                const active = safeTournaments.find(t => t.playing);
                const seg = active?.segment || safeTournaments.find(t => !t.completed && !t.playing)?.segment || [...safeTournaments].reverse().find(t => t.completed)?.segment || getSegmentByDate();
                return <span style={{ color: getSwingColor(seg) }}>{seg}</span>;
              })()}
            </div>
            {currentTournament && (
              <div className="sfgl-tournament-desktop" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: fontSize.md, color: '#f5c518', fontFamily: "'Raleway', system-ui, sans-serif", fontWeight: 400, letterSpacing: 0.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <span>⛳</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{currentTournament.name}</span>
              </div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {currentTournament && (
              <div className="sfgl-tournament-mobile" style={{ display: "none", alignItems: "center", gap: 6, fontSize: fontSize.md, color: '#f5c518', fontFamily: "'Raleway', system-ui, sans-serif", fontWeight: 400, letterSpacing: 0.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <span>⛳</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{currentTournament.name}</span>
              </div>
            )}
            {isSyncing && (
              <span style={{ fontSize: fontSize.sm, color: 'rgba(255,255,255,0.25)', letterSpacing: 1 }} className="sfgl-text-pulse">
                Saving…
              </span>
            )}
          </div>
        </div>

      </div>{/* end sticky shell */}

      {/* ── Main content ── */}
      <main className="sfgl-main-content" style={{ maxWidth: 1100, margin: "0 auto", padding: "16px 16px 100px" }}>

        <ErrorBoundary key={activeTab} tabName={activeTab}>
          {activeTab === 'standings' && (
            <StandingsView teams={resolvedTeams} tournaments={safeTournaments} transactions={safeTransactions} />
          )}
          {activeTab === 'results' && (
            <ResultsView teams={resolvedTeams} tournaments={safeTournaments} transactions={safeTransactions} />
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
                STORAGE_KEYS={STORAGE_KEYS}
                settings={settings}
              />
            </Suspense>
          )}
          {activeTab === 'tournaments' && (
            <TournamentsView
              tournaments={safeTournaments}
              isCommissioner={isCommissioner}
              setTournaments={updateTournaments}
            />
          )}
          {activeTab === 'admin' && isCommissioner && (
            <Suspense fallback={<LazyFallback />}>
              <LazyAdminView
                isCommissioner={isCommissioner}
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
                STORAGE_KEYS={STORAGE_KEYS}
              />
            </Suspense>
          )}
        </ErrorBoundary>
      </main>

      {/* ── Bottom Navigation ── */}
      <nav
        className="sfgl-bottom-nav"
        aria-label="Primary"
        style={{
          position: 'fixed',
          left: 0, right: 0, bottom: 0,
          zIndex: 50,
          background: 'rgba(8, 18, 40, 0.96)',
          backdropFilter: 'blur(14px)',
          WebkitBackdropFilter: 'blur(14px)',
          borderTop: '1px solid rgba(180,160,100,0.18)',
        }}
      >
        <div style={{
          maxWidth: 1100, margin: '0 auto',
          display: 'flex', alignItems: 'stretch',
          padding: '0 4px',
        }}>
          {TABS.map(tab => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                aria-label={tab.label}
                aria-current={isActive ? 'page' : undefined}
                className="sfgl-tab"
                style={{
                  flex: 1,
                  position: 'relative',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                  gap: 3,
                  padding: '10px 4px 8px',
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  // Active = white, inactive = light gray. Avoiding gold here
                  // so the nav doesn't compete with the gold Standings card or
                  // the gold gear icon in the header.
                  color: isActive ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.45)',
                  transition: 'color 0.15s',
                  minHeight: 56,
                }}
              >
                {isActive && (
                  <div style={{
                    position: 'absolute',
                    top: 0, left: '20%', right: '20%',
                    height: 2,
                    background: 'rgba(255,255,255,0.95)',
                    borderRadius: '0 0 2px 2px',
                  }} />
                )}
                <tab.Icon style={{ width: 18, height: 18, strokeWidth: isActive ? 2.4 : 2 }} />
                <span style={{
                  fontFamily: "'Raleway', system-ui, sans-serif",
                  fontSize: 10,
                  fontWeight: isActive ? 700 : 500,
                  letterSpacing: 0.4,
                  whiteSpace: 'nowrap',
                }}>
                  {tab.label}
                </span>
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
                color: 'rgba(255,255,255,0.3)',
                fontSize: 20, cursor: 'pointer',
                lineHeight: 1, zIndex: 51,
                transition: 'color 0.2s',
                padding: 10,
                minWidth: 44, minHeight: 44,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
              onMouseEnter={e => e.currentTarget.style.color = 'rgba(255,255,255,0.7)'}
              onMouseLeave={e => e.currentTarget.style.color = 'rgba(255,255,255,0.3)'}
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
    </PullToRefresh>
  );
};

// ── Root with providers ──
const App = () => (
  <DialogProvider>
    <FantasyGolfLeague />
  </DialogProvider>
);

export default App;
