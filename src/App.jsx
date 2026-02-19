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
import { managerAuthApi }  from './api/supabase';

import sfglLogo from './assets/logo.png';

// ── Tabs ────────────────────────────────────────────────────────────────────
const TABS = [
  { id: 'standings',    label: 'Standings',    Icon: BarChart3  },
  { id: 'results',      label: 'Results',      Icon: Trophy     },
  { id: 'rosters',      label: 'Rosters',      Icon: Users      },
  { id: 'transactions', label: 'Transactions', Icon: DollarSign },
  { id: 'tournaments',  label: 'Tournaments',  Icon: Calendar   },
  { id: 'admin',        label: 'Admin',        Icon: Settings   },
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
        style={{ background: '#0a1628' }}>
        <img src={sfglLogo} alt="SFGL"
          style={{ width: 100, filter: 'brightness(0) invert(1)', opacity: 0.6 }} />
        <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 13, letterSpacing: 2, textTransform: 'uppercase', fontFamily: 'serif' }}>
          Loading Season…
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-20 text-white" style={{ background: '#0a1628' }}>

      {/* ── Header ── */}
      <header style={{
        background: 'rgba(8, 18, 40, 0.95)',
        borderBottom: '1px solid rgba(180,160,100,0.15)',
        backdropFilter: 'blur(12px)',
        position: 'sticky', top: 0, zIndex: 50,
      }}>
        <div className="max-w-3xl mx-auto px-3 py-3">
          <div className="flex items-center justify-between">

            {/* Logo */}
            <div className="flex items-center gap-3">
              <img src={sfglLogo} alt="SFGL" style={{
                height: 28,
                width: 'auto',
                filter: 'brightness(0) invert(1)',
                opacity: 0.9,
              }} />
              <div style={{
                width: 1,
                height: 20,
                background: 'rgba(180,160,100,0.25)',
              }} />
              <span style={{
                fontFamily: 'Georgia, serif',
                fontSize: 13,
                color: 'rgba(255,255,255,0.4)',
                letterSpacing: 1,
              }}>2026</span>
            </div>

            {/* Right side: user + login/logout */}
            <div className="flex items-center gap-3">
              {loggedInUser && (
                <span style={{
                  fontSize: 11,
                  color: 'rgba(180,160,100,0.7)',
                  letterSpacing: 1,
                  textTransform: 'uppercase',
                  fontFamily: 'serif',
                }}>
                  {loggedInUser}
                </span>
              )}
              {loggedInUser
                ? (
                  <button onClick={handleLogout} style={{
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
                    fontSize: 10,
                    letterSpacing: 1.5,
                    textTransform: 'uppercase',
                    padding: '5px 12px',
                    background: 'rgba(26,51,102,0.5)',
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
      <div className="max-w-3xl mx-auto px-3 mt-4 mb-2 flex items-center gap-4">
        <div style={{ fontFamily: 'Georgia, serif', fontSize: 13, color: 'rgba(255,255,255,0.5)', letterSpacing: 0.5 }}>
          {getSegmentByDate()}
        </div>
        {currentTournament && (
          <div style={{ fontSize: 13, color: 'rgba(180,160,100,0.85)', fontFamily: 'Georgia, serif' }}
            className="flex items-center gap-1.5">
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
      <nav className="max-w-3xl mx-auto px-3 mt-2 relative">
        <div className="flex gap-1 pb-2 overflow-x-auto">
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
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  padding: '10px 8px',
                  borderRadius: 2,
                  fontSize: 11,
                  fontWeight: 400,
                  letterSpacing: 0.5,
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                  border: isActive
                    ? '1px solid rgba(180,160,100,0.3)'
                    : '1px solid transparent',
                  background: isActive
                    ? 'rgba(26,51,102,0.7)'
                    : isAdminPopover
                      ? 'rgba(255,255,255,0.06)'
                      : 'rgba(255,255,255,0.04)',
                  color: isActive
                    ? 'rgba(180,160,100,0.9)'
                    : 'rgba(255,255,255,0.4)',
                  boxShadow: isActive ? 'inset 0 1px 0 rgba(180,160,100,0.1)' : 'none',
                }}
              >
                <tab.Icon style={{ width: 13, height: 13 }} />
                <span className="hidden sm:inline" style={{
                  fontFamily: 'Georgia, serif',
                  fontSize: 11,
                  letterSpacing: '0.8px',
                }}>{tab.label}</span>
              </button>
            );
          })}
        </div>

        {/* Admin password popover */}
        {showAdminLoginPopover && !isCommissioner && (
          <div style={{
            position: 'absolute', right: 12, top: '100%', marginTop: 4,
            background: '#0f1f3d',
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
              background: '#1a3366',
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
      <main className="max-w-3xl mx-auto px-3 mt-4">
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
          <LoginPage onLogin={handleManagerLogin} />
          <button
            onClick={() => setShowLoginModal(false)}
            aria-label="Close"
            style={{
              position: 'fixed', top: 16, right: 16,
              background: 'none', border: 'none',
              color: 'rgba(255,255,255,0.3)',
              fontSize: 24, cursor: 'pointer',
              lineHeight: 1, zIndex: 51,
              transition: 'color 0.2s',
            }}
          >
            ✕
          </button>
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
