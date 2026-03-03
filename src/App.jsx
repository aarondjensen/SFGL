import React, { useState, useEffect } from 'react';
import { Trophy, Award, Users, DollarSign, Calendar, Settings } from 'lucide-react';

import { DialogProvider } from './components/DialogContext';
import { ErrorBoundary }  from './components/ErrorBoundary';
import { StandingsView }  from './components/StandingsView';
import { ResultsView }    from './components/ResultsView';
import { RostersView }    from './components/RostersView';
import { TransactionsView } from './components/TransactionsView';
import { TournamentsView }  from './components/TournamentsView';
import { AdminView }        from './components/AdminView';
import LoginPage            from './components/LoginPage';

import { useLeague }       from './hooks';
import { hashPassword, getSegmentByDate, fetchFirstTeeTime } from './utils';
import { getSwingColor } from './theme.js';
import { STORAGE_KEYS, INITIAL_TEAMS, COMMISSIONER_PASSWORD_HASH, PGA_TOUR_IDS } from './constants';
import { managerAuthApi, tournamentResultsApi } from './api/supabase';



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
  const [firstTeeTime,          setFirstTeeTime]          = useState(null);
  const [resultsHydrated,       setResultsHydrated]       = useState(false);

  const league = useLeague(STORAGE_KEYS);

  const {
    teams, tournaments, transactions, settings, globalPlayerStats,
    allPlayers, rankingsLastUpdated, headshots, loading, isSyncing,
    setTeams, setTournaments, setTransactions, setSettings, setGlobalPlayerStats, setHeadshots, setAllPlayers,
    updateTeams, updateTournaments, updateTransactions, updateSettings,
    updateGlobalStats, updateHeadshots, updateRankings,
  } = league;

  // Guard against useLeague returning null/undefined when Supabase load fails
  const safeTeams        = Array.isArray(teams)        ? teams        : [];
  const safeTournaments  = Array.isArray(tournaments)  ? tournaments  : [];
  const safeTransactions = Array.isArray(transactions) ? transactions : [];
  const safeHeadshots    = headshots && typeof headshots === 'object' ? headshots : {};

  const resolvedTeams     = safeTeams.length > 0 ? safeTeams : INITIAL_TEAMS;
  const resolvedHeadshots = Object.keys(safeHeadshots).length > 0 ? safeHeadshots : PGA_TOUR_IDS;
  const currentTournament = safeTournaments.find(t => t.playing);

  // ── Inject Google Fonts (Raleway only) once on mount ────────────────────────
  useEffect(() => {
    if (document.getElementById('sfgl-google-fonts')) return; // already injected
    const link = document.createElement('link');
    link.id   = 'sfgl-google-fonts';
    link.rel  = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Raleway:wght@300;400;500;600;700&display=swap';
    document.head.appendChild(link);
    // Set Raleway on body so everything inherits it — overrides Tailwind preflight
    document.body.style.fontFamily = "'Raleway', system-ui, sans-serif";
    document.body.style.fontVariantNumeric = 'tabular-nums lining-nums';
    // Responsive tab styles
    const style = document.createElement('style');
    style.id = 'sfgl-tab-styles';
    if (!document.getElementById('sfgl-tab-styles')) {
      style.textContent = `
        .sfgl-nav-row { justify-content: space-between; }
        .sfgl-tab { flex: 1; }
        .sfgl-tab-label { display: none; }
        .sfgl-tournament-desktop { display: none !important; }
        .sfgl-tournament-mobile { display: flex !important; }
        @media (min-width: 640px) {
          .sfgl-nav-row { justify-content: flex-start; }
          .sfgl-tab { flex: 1; }
          .sfgl-tab-label { display: inline; }
          .sfgl-tournament-desktop { display: flex !important; }
          .sfgl-tournament-mobile { display: none !important; }
        }
      `;
      document.head.appendChild(style);
    }
    // Force dark background on all select dropdowns — browser default is white
    if (!document.getElementById('sfgl-select-styles')) {
      const selStyle = document.createElement('style');
      selStyle.id = 'sfgl-select-styles';
      selStyle.textContent = `
        select { color-scheme: dark; }
        select option {
          background: #1a2744;
          color: rgba(255,255,255,0.88);
        }
        select option:checked,
        select option:hover {
          background: #243660;
        }
      `;
      document.head.appendChild(selStyle);
    }
  }, []);

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

  // ── Hydrate tournament results from Supabase ─────────────────────────────
  // Hydrate tournament results from Supabase once after load.
  // MERGE only — never overwrites a tournament that already has local results.
  // Remote results win only when the local tournament has none.
  useEffect(() => {
    if (loading || resultsHydrated || tournaments.length === 0) return;
    tournamentResultsApi.getAllForSeason().then(supabaseResults => {
      if (!supabaseResults || supabaseResults.length === 0) { setResultsHydrated(true); return; }
      setTournaments(prev => prev.map(t => {
        // Keep local results if they already exist — don't overwrite with remote
        if (t.completed && t.results) return t;
        const remote = supabaseResults.find(r => r.tournamentName === t.name);
        if (!remote) return t;
        return { ...t, completed: true, results: remote.results };
      }));
      setResultsHydrated(true);
    }).catch(e => {
      console.warn('Could not load results from Supabase:', e.message);
      setResultsHydrated(true);
    });
  }, [loading, tournaments.length, resultsHydrated]);


  // ── Admin login ────────────────────────────────────────────────────────────
  const handleAdminLogin = async () => {
    const hashed = await hashPassword(adminPassword);
    if (hashed === COMMISSIONER_PASSWORD_HASH) {
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
        <style>{`
          @keyframes sfgl-pulse {
            0%, 100% { opacity: 0.9; transform: scale(1); }
            50% { opacity: 0.4; transform: scale(0.97); }
          }
          @keyframes sfgl-dot {
            0%, 80%, 100% { opacity: 0.15; transform: translateY(0); }
            40% { opacity: 1; transform: translateY(-5px); }
          }
          .sfgl-logo-load { animation: sfgl-pulse 2s ease-in-out infinite; }
          .sfgl-dot { display: inline-block; animation: sfgl-dot 1.2s ease-in-out infinite; }
          .sfgl-dot:nth-child(2) { animation-delay: 0.2s; }
          .sfgl-dot:nth-child(3) { animation-delay: 0.4s; }
        `}</style>
        <div className="sfgl-logo-load" style={{ fontSize: 32, fontWeight: 600, letterSpacing: 10, color: 'rgba(255,255,255,0.9)' }}>SFGL</div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span className="sfgl-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: 'rgba(245,197,24,0.8)', display: 'inline-block' }} />
          <span className="sfgl-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: 'rgba(245,197,24,0.8)', display: 'inline-block' }} />
          <span className="sfgl-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: 'rgba(245,197,24,0.8)', display: 'inline-block' }} />
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
                  fontWeight: 300,
                  color: 'rgba(255,255,255,0.45)',
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
                {loggedInUser && !isCommissioner && (
                    <button onClick={handleLogout} style={{
                      fontFamily: "'Raleway', system-ui, sans-serif",
                      fontSize: 10,
                      letterSpacing: 1.5,
                      textTransform: 'uppercase',
                      padding: '5px 12px',
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
                    <button onClick={() => setShowLoginModal(true)} style={{
                      fontFamily: "'Raleway', system-ui, sans-serif",
                      fontSize: 10,
                      letterSpacing: 1.5,
                      textTransform: 'uppercase',
                      padding: '5px 12px',
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

        {/* ── Commissioner banner ── */}
        {isCommissioner && (
          <div style={{
            background: 'rgba(245,197,24,0.85)',
            padding: '4px 16px',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
          }}>
            <span style={{ fontSize: 11, letterSpacing: '0.15em', fontWeight: 700, fontFamily: "'Raleway', system-ui, sans-serif", color: '#0a1628', textTransform: 'uppercase' }}>
              ⚙ Commissioner Mode
            </span>
            <button onClick={() => setIsCommissioner(false)} style={{
              fontFamily: "'Raleway', system-ui, sans-serif",
              fontSize: 9,
              letterSpacing: 1.5,
              textTransform: 'uppercase',
              padding: '3px 10px',
              background: '#dc2626',
              border: '1px solid #b91c1c',
              borderRadius: 2,
              color: '#fff',
              cursor: 'pointer',
              fontWeight: 700,
            }}>
              Sign Out
            </button>
          </div>
        )}
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
                fontSize: 13,
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
      <main style={{ maxWidth: 1100, margin: "0 auto", padding: "16px 16px 80px" }}>

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
              firstTeeTime={firstTeeTime}
            />
          )}
          {activeTab === 'transactions' && (
            <TransactionsView
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
          )}
          {activeTab === 'tournaments' && (
            <TournamentsView
              tournaments={safeTournaments}
              isCommissioner={isCommissioner}
              setTournaments={updateTournaments}
              firstTeeTime={firstTeeTime}
            />
          )}
          {activeTab === 'admin' && isCommissioner && (
            <AdminView
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
          zIndex: 50, padding: 16,
        }}>
          <div style={{ position: 'relative' }}>
            <LoginPage onLogin={handleManagerLogin} />
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
                padding: 4,
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
    <FantasyGolfLeague />
  </DialogProvider>
);

export default App;
