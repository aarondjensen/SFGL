import React, { useState, useEffect, Suspense } from 'react';
import { Trophy,  Award, Users, DollarSign, Calendar, Settings } from 'lucide-react';

import { DialogProvider } from './pages/DialogContext';
import { ErrorBoundary }  from './pages/ErrorBoundary';
import { PullToRefresh }  from './pages/PullToRefresh';

// ── Eagerly loaded views (shown on first visit / lightweight) ──────────────
import { StandingsView }  from './pages/StandingsView';
import { ResultsView }    from './pages/ResultsView';
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
import { hashPassword, getSegmentByDate } from './utils';
import { getSwingColor } from './theme.js';
import { STORAGE_KEYS, INITIAL_TEAMS, COMMISSIONER_PASSWORD_HASH, PGA_TOUR_IDS } from './constants';
import { managerAuthApi, tournamentResultsApi } from './api/firebase';


// ── Lazy-load fallback spinner ─────────────────────────────────────────────
const LazyFallback = () => (
  <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
    <div style={{
      fontSize: 11, letterSpacing: 3, textTransform: 'uppercase',
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
  { id: 'results',      label: 'Results',      Icon: Award      },
  { id: 'transactions', label: 'Transactions', Icon: DollarSign },
  { id: 'tournaments',  label: 'Tournaments',  Icon: Calendar   },
  { id: 'admin',        label: 'Commish',      Icon: Settings   },
];

// ── App shell ───────────────────────────────────────────────────────────────
const FantasyGolfLeague = () => {
  const [activeTab,             setActiveTab]             = useState('standings');
  const [selectedTeam,          setSelectedTeam]          = useState(null);
  const [isCommissioner,        setIsCommissioner]        = useState(false);
  const [loggedInUser,          setLoggedInUser]          = useState(null);
  const [showLoginModal,        setShowLoginModal]        = useState(false);
  const [showAdminLoginPopover, setShowAdminLoginPopover] = useState(false);
  const [adminPassword,         setAdminPassword]         = useState('');
  const [resultsHydrated,       setResultsHydrated]       = useState(false);

  const league = useLeague(STORAGE_KEYS);

  const {
    teams, tournaments, transactions, settings, globalPlayerStats,
    allPlayers, rankingsLastUpdated, headshots, loading, isSyncing,
    setTournaments, setAllPlayers,
    updateTeams, updateTournaments, updateTransactions, updateSettings,
    updateGlobalStats, updateHeadshots, updateRankings,
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

  // ── Restore session on page load ──────────────────────────────────────────
  useEffect(() => {
    managerAuthApi.getCurrentSession().then(session => {
      if (!session) return;
      const teamId = localStorage.getItem('manager_team_id');
      if (teamId) {
        const team = resolvedTeams.find(t => t.id === teamId);
        if (team) setLoggedInUser(team.owner || team.name);
      }
    }).catch(() => {});
  }, [resolvedTeams]);

  // ── Hydrate tournament results from Firebase ──────────────────────────────
  // Hydrate tournament results from Firebase once after load.
  // MERGE only — never overwrites a tournament that already has local results.
  // Remote results win only when the local tournament has none.
  useEffect(() => {
    if (loading || resultsHydrated || tournaments.length === 0) return;
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


  // ── Auto-fetch headshots for all rostered players on app load ────────────
  // Runs once after league data loads. Calls /api/headshots with every rostered
  // player name, merges results into the headshots map so every component
  // (Rosters, AddDrop, etc.) has headshots immediately without its own fetch.
  // NOTE: RostersView's own duplicate fetch was removed in Wave 1.
  const [headshotsFetched, setHeadshotsFetched] = useState(false);
  useEffect(() => {
    if (loading || headshotsFetched) return;
    const allRostered = [...new Set(
      resolvedTeams.flatMap(t => (t.roster || []).map(p => p.name))
    )].filter(Boolean);
    if (!allRostered.length) { setHeadshotsFetched(true); return; }

    // Only fetch names not already in the headshots map
    const missing = allRostered.filter(n => !safeHeadshots[n] && !PGA_TOUR_IDS[n]);
    if (!missing.length) { setHeadshotsFetched(true); return; }

    const encoded = missing.map(n => encodeURIComponent(n)).join(',');
    fetch(`/api/headshots?names=${encoded}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.results && Object.keys(data.results).length > 0) {
          updateHeadshots(prev => ({ ...(prev || {}), ...data.results }));
          // Also persist to player documents for future loads
          import('./api/firebase').then(({ playersApi }) => {
            const toSave = Object.entries(data.results).map(([name, espnId]) => ({ name, espnId }));
            if (toSave.length) playersApi.upsertMany(toSave).catch(() => {});
          }).catch(() => {});
        }
      })
      .catch(() => {})
      .finally(() => setHeadshotsFetched(true));
  }, [loading, resolvedTeams]); // eslint-disable-line react-hooks/exhaustive-deps


  // ── Admin login ────────────────────────────────────────────────────────────
  const handleAdminLogin = async () => {
    const hashed = await hashPassword(adminPassword);
    if (hashed === COMMISSIONER_PASSWORD_HASH) {
      // Blur input to dismiss keyboard and reset iOS zoom
      if (document.activeElement) document.activeElement.blur();
      setIsCommissioner(true);
      setShowAdminLoginPopover(false);
      setAdminPassword('');
      setActiveTab('admin');
    } else {
      alert('Incorrect password');
      setAdminPassword('');
    }
  };

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
    setIsCommissioner(false);
    setShowLoginModal(false);
  };

  // ── Logout ─────────────────────────────────────────────────────────────────
  const handleLogout = async () => {
    await managerAuthApi.logout();
    setLoggedInUser(null);
    setIsCommissioner(false);
  };

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 24, background: '#111d2e', fontFamily: "'Raleway', system-ui, sans-serif" }}>
        {/* Loading-screen animations are now in app-global.css (Wave 1 cleanup) */}
        <div className="sfgl-logo-load" style={{ fontSize: 32, fontWeight: 600, letterSpacing: 10, color: 'rgba(255,255,255,0.9)' }}>SFGL</div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span className="sfgl-dot" />
          <span className="sfgl-dot" />
          <span className="sfgl-dot" />
        </div>
        <div style={{ fontSize: 11, letterSpacing: 3, textTransform: 'uppercase', color: 'rgba(255,255,255,0.2)', fontWeight: 400 }}>Loading 2026 League</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-20 text-white" style={{ background: '#111d2e', fontFamily: "'Raleway', system-ui, sans-serif", fontVariantNumeric: 'tabular-nums lining-nums' }}>

      {/* ── Sticky shell: header + banner + nav ── */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 50,
        background: 'rgba(8, 18, 40, 0.97)',
        backdropFilter: 'blur(12px)',
        borderBottom: '1px solid rgba(180,160,100,0.15)',
      }}>

        {/* ── Header ── */}
        <header>
          <div style={{ maxWidth: 1100, margin: "0 auto", padding: "12px 16px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>

              {/* Logo */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{
                  fontFamily: "'Raleway', system-ui, sans-serif",
                  fontSize: 22, fontWeight: 600, letterSpacing: 5,
                  color: 'rgba(255,255,255,0.93)',
                  whiteSpace: 'nowrap', userSelect: 'none',
                }}>SFGL</span>
                <div style={{ width: 1, height: 22, background: 'rgba(180,160,100,0.25)' }} />
                <span style={{
                  fontFamily: "'Raleway', system-ui, sans-serif",
                  fontSize: 16,
                  fontWeight: 400,
                  color: 'rgba(255,255,255,0.7)',
                  letterSpacing: 4,
                }}>2026</span>
              </div>

              {/* Right side: user + login/logout */}
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                {loggedInUser && (
                  <span style={{
                    fontSize: 11,
                    color: 'rgba(255,255,255,0.45)',
                    letterSpacing: 1,
                    textTransform: 'uppercase',
                    fontFamily: "'Raleway', system-ui, sans-serif",
                  }}>
                    {loggedInUser}
                  </span>
                )}
                {/* Commissioner pill — replaces the old full-width yellow banner.
                    Click signs out of commish mode and returns to standings. */}
                {isCommissioner && (
                  <button
                    onClick={() => { setIsCommissioner(false); setActiveTab('standings'); }}
                    title="Click to exit Commissioner mode"
                    style={{
                      fontFamily: "'Raleway', system-ui, sans-serif",
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: 1.5,
                      textTransform: 'uppercase',
                      padding: '8px 12px',
                      background: 'rgba(245,197,24,0.18)',
                      border: '1px solid rgba(245,197,24,0.55)',
                      borderRadius: 1,
                      color: 'rgba(245,197,24,0.95)',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'rgba(245,197,24,0.28)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'rgba(245,197,24,0.18)'; }}
                  >
                    <span style={{ fontSize: 11 }}>⚙</span>
                    <span>Commish</span>
                  </button>
                )}
                {loggedInUser && !isCommissioner && (
                    <button onClick={handleLogout} style={{
                      fontFamily: "'Raleway', system-ui, sans-serif",
                      fontSize: 10,
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
                {!loggedInUser && !isCommissioner && (
                    <button onClick={() => setShowLoginModal(true)} style={{
                      fontFamily: "'Raleway', system-ui, sans-serif",
                      fontSize: 10,
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
        <div style={{ maxWidth: 1100, margin: "0 auto", padding: "4px 16px 4px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flex: 1 }}>
            <div style={{ fontFamily: "'Raleway', system-ui, sans-serif", fontSize: 'clamp(13px, 1.1vw, 15px)', letterSpacing: 1, fontWeight: 400, whiteSpace: 'nowrap' }}>
              {(() => {
                const active = safeTournaments.find(t => t.playing);
                const seg = active?.segment || safeTournaments.find(t => !t.completed && !t.playing)?.segment || [...safeTournaments].reverse().find(t => t.completed)?.segment || getSegmentByDate();
                return <span style={{ color: getSwingColor(seg) }}>{seg}</span>;
              })()}
            </div>
            {currentTournament && (
              <div className="sfgl-tournament-desktop" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 'clamp(13px, 1.1vw, 15px)', color: '#f5c518', fontFamily: "'Raleway', system-ui, sans-serif", fontWeight: 400, letterSpacing: 0.5 }}>
                <span>⛳</span> {currentTournament.name}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {currentTournament && (
              <div className="sfgl-tournament-mobile" style={{ display: "none", alignItems: "center", gap: 6, fontSize: 'clamp(13px, 1.1vw, 15px)', color: '#f5c518', fontFamily: "'Raleway', system-ui, sans-serif", fontWeight: 400, letterSpacing: 0.5 }}>
                <span>⛳</span> {currentTournament.name}
              </div>
            )}
            {isSyncing && (
              <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.25)', letterSpacing: 1 }} className="animate-pulse">
                Saving…
              </span>
            )}
          </div>
        </div>

        {/* ── Navigation ── */}
        <nav style={{ maxWidth: 1100, margin: "0 auto", padding: "0 16px", position: "relative" }}>
        <div className="sfgl-nav-row" style={{ display: "flex", gap: 0, paddingBottom: 8, overflowX: "auto" }}>
          {TABS.map(tab => {
            const isActive = activeTab === tab.id;
            const isAdminPopover = tab.id === 'admin' && showAdminLoginPopover;
            return (
              <button
                key={tab.id}
                className="sfgl-tab"
                onClick={() => {
                  if (tab.id === 'admin' && !isCommissioner) {
                    setShowAdminLoginPopover(prev => !prev);
                    return;
                  }
                  setShowAdminLoginPopover(false);
                  setActiveTab(tab.id);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  padding: '10px 12px',
                  borderRadius: 2,
                  fontSize: 'clamp(12px, 1vw, 14px)',
                  fontWeight: 400,
                  letterSpacing: 0.5,
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                  border: isActive
                    ? '1px solid rgba(255,255,255,0.2)'
                    : '1px solid transparent',
                  background: isActive
                    ? 'rgba(255,255,255,0.08)'
                    : isAdminPopover
                      ? 'rgba(255,255,255,0.06)'
                      : 'rgba(255,255,255,0.04)',
                  color: isActive
                    ? 'rgba(255,255,255,0.95)'
                    : 'rgba(255,255,255,0.78)',
                  boxShadow: isActive ? 'inset 0 1px 0 rgba(255,255,255,0.08)' : 'none',
                  outline: 'none', // focus-visible handled by CSS class in app-global.css
                }}
              >
                <tab.Icon style={{ width: 13, height: 13 }} />
                <span className="sfgl-tab-label" style={{
                  fontFamily: "'Raleway', system-ui, sans-serif",
                  fontSize: 'clamp(12px, 1vw, 14px)',
                  fontWeight: 500,
                  letterSpacing: '1px',
                }}>{tab.label}</span>
              </button>
            );
          })}
        </div>

        {/* Admin password popover */}
        {showAdminLoginPopover && !isCommissioner && (
          <div style={{
            position: 'absolute', right: 12, top: '100%', marginTop: 4,
            background: '#0f1d35',
            border: '1px solid rgba(180,160,100,0.25)',
            borderRadius: 2,
            padding: 10,
            boxShadow: '0 16px 48px rgba(0,0,0,0.5)',
            zIndex: 50,
            display: 'flex',
            gap: 8,
          }}>
            <input
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              autoFocus
              autoComplete="current-password"
              placeholder="Password"
              value={adminPassword}
              onChange={e => setAdminPassword(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleAdminLogin(); }}
              style={{
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 1,
                padding: '7px 10px',
                fontSize: 16,
                width: 160,
                color: 'white',
                outline: 'none',
              }}
            />
            <button onClick={handleAdminLogin} style={{
              background: '#1c3a5e',
              border: '1px solid rgba(180,160,100,0.25)',
              borderRadius: 1,
              padding: '7px 14px',
              fontSize: 12,
              fontWeight: 600,
              color: 'rgba(180,160,100,0.9)',
              cursor: 'pointer',
              letterSpacing: 1,
            }}>
              Enter
            </button>
          </div>
        )}
        </nav>
      </div>{/* end sticky shell */}

      {/* ── Main content ── */}
      <main className="sfgl-main-content" style={{ maxWidth: 1100, margin: "0 auto", padding: "16px 16px 80px" }}>

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
                STORAGE_KEYS={STORAGE_KEYS}
              />
            </Suspense>
          )}
        </ErrorBoundary>
      </main>

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
  );
};

// ── Root with providers ──────────────────────────────────────────────────────
const App = () => (
  <DialogProvider>
    <PullToRefresh>
      <FantasyGolfLeague />
    </PullToRefresh>
  </DialogProvider>
);

export default App;
