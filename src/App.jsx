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
  // If the manager logged in within the last 60 days, they'll be auto-logged in
  useEffect(() => {
    managerAuthApi.getCurrentSession().then(session => {
      if (!session) return;
      if (session.is_commissioner) {
        setIsCommissioner(true);
      } else if (session.managers) {
        setLoggedInUser(session.managers.name); // e.g. "Jensen"
      }
    }).catch(() => {
      // Session check failed silently — user just won't be auto-logged in
    });
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

  // ── Manager login (called by LoginPage on success) ─────────────────────────
  const handleManagerLogin = (result) => {
    // result = { manager, sessionToken } from managerAuthApi.login()
    setLoggedInUser(result.manager.name); // e.g. "Jensen"
    setShowLoginModal(false);
  };

  // ── Logout ─────────────────────────────────────────────────────────────────
  const handleLogout = async () => {
    await managerAuthApi.logout(); // deletes session from Supabase + clears localStorage
    setLoggedInUser(null);
    setIsCommissioner(false);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-900 via-green-900 to-gray-900 flex flex-col items-center justify-center gap-3">
        <div className="text-white text-xl animate-pulse">Loading Season...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-green-900 to-gray-900 text-white pb-20">
      {/* Header */}
      <header className="bg-black/40 backdrop-blur-sm border-b border-green-700/30 sticky top-0 z-50">
        <div className="max-w-3xl mx-auto px-3 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-11 h-11 rounded-full overflow-hidden flex-shrink-0 flex items-center justify-center bg-white">
                <img src={sfglLogo} alt="SFGL" className="w-full h-full object-cover scale-[2.5]" />
              </div>
              <div className="flex flex-col">
                <span className="text-xl font-bold text-green-400 leading-none">2026</span>
              </div>
            </div>
            {loggedInUser
              ? <button onClick={handleLogout} className="text-xs bg-red-600/20 px-3 py-1 rounded border border-red-600/50">Logout</button>
              : <button onClick={() => setShowLoginModal(true)} className="text-xs bg-green-600/20 px-3 py-1 rounded border border-green-600/50">Login</button>
            }
          </div>
        </div>
      </header>

      {/* Segment / active tournament banner */}
      <div className="max-w-3xl mx-auto px-3 mt-4 mb-2 flex items-center gap-4">
        <div className="font-bold text-white text-sm sm:text-base">{getSegmentByDate()}</div>
        {currentTournament && (
          <div className="font-bold text-yellow-400 text-sm sm:text-base flex items-center gap-1.5">
            <span className="text-green-400">⛳</span> {currentTournament.name}
          </div>
        )}
        {isSyncing && <span className="text-[10px] text-gray-500 animate-pulse ml-auto">Saving…</span>}
      </div>

      {/* Navigation */}
      <nav className="max-w-3xl mx-auto px-3 mt-2 relative">
        <div className="flex gap-1 pb-2 overflow-x-auto">
          {TABS.map(tab => (
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
              className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-2.5 rounded-lg text-xs font-medium transition-colors ${
                activeTab === tab.id ? 'bg-green-600 text-white' : 'bg-gray-800/50 text-gray-400 hover:text-gray-200'
              } ${tab.id === 'admin' && showAdminLoginPopover ? 'bg-gray-700 text-white' : ''}`}
            >
              <tab.Icon className="w-4 h-4" />
              <span className="hidden sm:inline">{tab.label}</span>
            </button>
          ))}
        </div>

        {/* Admin login popover */}
        {showAdminLoginPopover && !isCommissioner && (
          <div className="absolute right-3 top-full mt-1 bg-gray-800 p-2.5 rounded-xl shadow-2xl border border-green-600/50 z-50 flex gap-2 animate-[scaleIn_0.15s_ease-out]">
            <input
              type="password"
              autoFocus
              placeholder="Password..."
              value={adminPassword}
              onChange={e => setAdminPassword(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleAdminLogin(); }}
              className="bg-gray-900 border border-gray-600 rounded-lg px-3 py-1.5 text-sm w-32 text-white focus:outline-none focus:border-green-500"
            />
            <button onClick={handleAdminLogin} className="bg-green-600 hover:bg-green-500 px-3 py-1.5 rounded-lg text-sm font-bold transition-colors">
              Go
            </button>
          </div>
        )}
      </nav>

      {/* Main content */}
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

      {/* Manager Login Modal — replaced old team-picker with full LoginPage */}
      {showLoginModal && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <LoginPage onLogin={handleManagerLogin} />
          <button
            onClick={() => setShowLoginModal(false)}
            className="fixed top-4 right-4 text-white/50 hover:text-white text-3xl z-50 leading-none"
            aria-label="Close login"
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
