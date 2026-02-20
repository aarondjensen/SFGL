import React, { useState, useEffect } from 'react';
import { BarChart3, Trophy, Users, DollarSign, Calendar, Settings } from 'lucide-react';

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
import { STORAGE_KEYS, INITIAL_TEAMS, COMMISSIONER_PASSWORD_HASH, PGA_TOUR_IDS } from './constants';
import { managerAuthApi, tournamentResultsApi } from './api/supabase';



// ── Tabs ────────────────────────────────────────────────────────────────────
const TABS = [
  { id: 'standings',    label: 'Standings',    Icon: BarChart3  },
  { id: 'results',      label: 'Results',      Icon: Trophy     },
  { id: 'rosters',      label: 'Rosters',      Icon: Users      },
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
    setTeams, setTournaments, setTransactions, setSettings, setGlobalPlayerStats, setHeadshots,
    updateTeams, updateTournaments, updateTransactions, updateSettings,
    updateGlobalStats, updateHeadshots, updateRankings,
  } = league;

  const resolvedTeams     = teams.length      > 0 ? teams     : INITIAL_TEAMS;
  const resolvedHeadshots = Object.keys(headshots).length > 0 ? headshots : PGA_TOUR_IDS;
  const currentTournament = tournaments.find(t => t.playing);

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
  }, []);

  // ── Restore session on page load ──────────────────────────────────────────
  useEffect(() => {
    managerAuthApi.getCurrentSession().then(session => {
      if (!session) return;
      if (session.is_commissioner) {
        setIsCommissioner(true);
      } else if (session.managers) {
        setLoggedInUser(session.managers.name);
      }
    }).catch(() => {});
  }, []);

  // ── Hydrate tournament results from Supabase ─────────────────────────────
  // Runs once after tournaments are loaded. Merges Supabase results into the
  // local tournaments array so ResultsView works for all managers, not just
  // the one who processed results on their device.
  useEffect(() => {
    if (loading || resultsHydrated || tournaments.length === 0) return;
    tournamentResultsApi.getAllForSeason().then(supabaseResults => {
      if (!supabaseResults || supabaseResults.length === 0) { setResultsHydrated(true); return; }
      setTournaments(prev => {
        const updated = prev.map(t => {
          // Only merge if local copy has no results (avoids overwriting fresher local data)
          if (t.results) return t;
          const remote = supabaseResults.find(r => r.tournamentName === t.name);
          if (!remote) return t;
          return { ...t, completed: true, results: remote.results };
        });
        return updated;
      });
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
    setLoggedInUser(result.manager.name);
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
      <div className="min-h-screen flex flex-col items-center justify-center gap-3"
        style={{ background: '#111d2e' }}>
        <div style={{ fontFamily: "'Raleway', system-ui, sans-serif", fontSize: 28, fontWeight: 600, letterSpacing: 8, color: 'rgba(255,255,255,0.5)' }}>
          SFGL
        </div>
        <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: 11, letterSpacing: 3, textTransform: 'uppercase', fontFamily: "'Raleway', system-ui, sans-serif" }}>
          Loading Season…
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-20 text-white" style={{ background: '#111d2e', fontFamily: "'Raleway', system-ui, sans-serif" }}>

      {/* ── Header ── */}
      <header style={{
        background: 'rgba(8, 18, 40, 0.95)',
        borderBottom: '1px solid rgba(180,160,100,0.15)',
        backdropFilter: 'blur(12px)',
        position: 'sticky', top: 0, zIndex: 50,
      }}>
        <div style={{ maxWidth: 1100, margin: "0 auto", padding: "12px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>

            {/* Logo */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {/* Try image first; if it loads show it, otherwise the text fallback stays */}
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
                  color: 'rgba(180,160,100,0.7)',
                  letterSpacing: 1,
                  textTransform: 'uppercase',
                  fontFamily: "'Raleway', system-ui, sans-serif",
                }}>
                  {loggedInUser}
                </span>
              )}
              {loggedInUser
                ? (
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
                ) : (
                  <button onClick={() => setShowLoginModal(true)} style={{
                    fontFamily: "'Raleway', system-ui, sans-serif",
                    fontSize: 10,
                    letterSpacing: 1.5,
                    textTransform: 'uppercase',
                    padding: '5px 12px',
                    background: 'rgba(18,46,82,0.5)',
                    border: '1px solid rgba(180,160,100,0.25)',
                    borderRadius: 1,
                    color: 'rgba(180,160,100,0.8)',
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                  }}>
                    Sign In
                  </button>
                )
              }
            </div>
          </div>
        </div>
      </header>

      {/* ── Segment / active tournament banner ── */}
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "12px 16px 4px", display: "flex", alignItems: "center", gap: 16 }}>
        <div style={{ fontFamily: "'Raleway', system-ui, sans-serif", fontSize: 'clamp(13px, 1.1vw, 15px)', color: 'rgba(255,255,255,0.82)', letterSpacing: 1, fontWeight: 400 }}>
          {getSegmentByDate()}
        </div>
        {currentTournament && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 'clamp(13px, 1.1vw, 15px)', color: 'rgba(210,190,130,0.95)', fontFamily: "'Raleway', system-ui, sans-serif", fontWeight: 400, letterSpacing: 0.5 }}>
            <span>⛳</span> {currentTournament.name}
          </div>
        )}
        {isSyncing && (
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.25)', letterSpacing: 1 }} className="ml-auto animate-pulse">
            Saving…
          </span>
        )}
      </div>

      {/* ── Navigation ── */}
      <nav style={{ maxWidth: 1100, margin: "0 auto", padding: "0 16px", position: "relative", marginTop: 8 }}>
        <div style={{ display: "flex", gap: 4, paddingBottom: 8, overflowX: "auto" }}>
          {TABS.map(tab => {
            const isActive = activeTab === tab.id;
            const isAdminPopover = tab.id === 'admin' && showAdminLoginPopover;
            return (
              <button
                key={tab.id}
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
                  padding: '10px 16px',
                  borderRadius: 2,
                  fontSize: 'clamp(12px, 1vw, 14px)',
                  fontWeight: 400,
                  letterSpacing: 0.5,
                  whiteSpace: 'nowrap',
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                  border: isActive
                    ? '1px solid rgba(180,160,100,0.3)'
                    : '1px solid transparent',
                  background: isActive
                    ? 'rgba(18,46,82,0.75)'
                    : isAdminPopover
                      ? 'rgba(255,255,255,0.06)'
                      : 'rgba(255,255,255,0.04)',
                  color: isActive
                    ? 'rgba(180,160,100,0.9)'
                    : 'rgba(255,255,255,0.78)',
                  boxShadow: isActive ? 'inset 0 1px 0 rgba(180,160,100,0.1)' : 'none',
                }}
              >
                <tab.Icon style={{ width: 13, height: 13 }} />
                <span style={{
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
              placeholder="Commissioner password…"
              value={adminPassword}
              onChange={e => setAdminPassword(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleAdminLogin(); }}
              style={{
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 1,
                padding: '7px 12px',
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

      {/* ── Main content ── */}
      <main style={{ maxWidth: 1100, margin: "0 auto", padding: "16px 16px 80px" }}>
        <ErrorBoundary>
          {activeTab === 'standings' && (
            <StandingsView teams={resolvedTeams} />
          )}
          {activeTab === 'results' && (
            <ResultsView teams={resolvedTeams} tournaments={tournaments} />
          )}
          {activeTab === 'rosters' && (
            <RostersView
              teams={resolvedTeams}
              selectedTeam={selectedTeam}
              setSelectedTeam={setSelectedTeam}
              updateTeams={updateTeams}
              tournaments={tournaments}
              allPlayers={allPlayers}
              transactions={transactions}
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
              transactions={transactions}
              teams={resolvedTeams}
              setTransactions={updateTransactions}
              updateTeams={updateTeams}
              isCommissioner={isCommissioner}
            />
          )}
          {activeTab === 'tournaments' && (
            <TournamentsView
              tournaments={tournaments}
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
              tournaments={tournaments}
              setTournaments={updateTournaments}
              transactions={transactions}
              setTransactions={updateTransactions}
              allPlayers={allPlayers}
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
