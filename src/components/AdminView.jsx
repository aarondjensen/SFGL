import React, { useState, useEffect } from 'react';
import { Settings, Edit2, Save } from 'lucide-react';
import { useDialog } from './DialogContext';
import { slashGolfFetch, processTournamentData, makePlayer } from '../utils';
import { PGA_TOUR_IDS, FALLBACK_SCHEDULE_DATA } from '../constants';
import { storage } from '../api';
import { ScheduleImportModal } from './ScheduleImportModal';
import { DraftModal } from './DraftModal';

export const AdminView = ({
  isCommissioner, setIsCommissioner, setActiveTab,
  settings, setSettings,
  teams, updateTeams,
  tournaments, setTournaments,
  transactions, setTransactions,
  allPlayers, globalPlayerStats, setGlobalPlayerStats,
  updateRankings, rankingsLastUpdated,
  headshots, setHeadshots,
  STORAGE_KEYS,
}) => {
  const [selectedTourneyForResults, setSelectedTourneyForResults] = useState('');
  const [showScheduleImporter, setShowScheduleImporter] = useState(false);
  const [showDraftModal, setShowDraftModal] = useState(false);
  const [showRosterManager, setShowRosterManager] = useState(false);
  const [rosterMgmtTeam, setRosterMgmtTeam] = useState('');
  const dialog = useDialog();
  const activeTournament = tournaments.find(t => t.playing);

  useEffect(() => {
    if (!selectedTourneyForResults && activeTournament) {
      setSelectedTourneyForResults(activeTournament.name);
    }
  }, [activeTournament, selectedTourneyForResults]);

  // ── Export / Import ────────────────────────────────────────────────────────
  const handleExport = () => {
    const data = { teams, tournaments, transactions, settings, globalPlayerStats, headshots };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `sfgl-backup-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    dialog.showToast('Data exported successfully', 'success');
  };

  const handleImport = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const data = JSON.parse(event.target.result);
        if (data.teams)            updateTeams(data.teams);
        if (data.tournaments)      setTournaments(data.tournaments);
        if (data.transactions)     setTransactions(data.transactions);
        if (data.settings)       { setSettings(data.settings);           await storage.set(STORAGE_KEYS.SETTINGS,           data.settings); }
        if (data.globalPlayerStats){ setGlobalPlayerStats(data.globalPlayerStats); await storage.set(STORAGE_KEYS.GLOBAL_PLAYER_STATS, data.globalPlayerStats); }
        if (data.headshots)      { setHeadshots(data.headshots);         await storage.set(STORAGE_KEYS.HEADSHOTS,           data.headshots); }
        dialog.showToast('Data imported successfully!', 'success');
      } catch {
        dialog.showToast('Failed to parse backup file.', 'error');
      }
    };
    reader.readAsText(file);
    e.target.value = null;
  };

  // ── Schedule Sync ─────────────────────────────────────────────────────────
  const handleImportSchedule = (importedTournaments) => {
    setTournaments(importedTournaments);
    setShowScheduleImporter(false);
    dialog.showToast(`Imported ${importedTournaments.length} tournaments!`, 'success');
  };

  // ── Results Fetch ─────────────────────────────────────────────────────────
  const handleFetchApiResults = async () => {
    if (!selectedTourneyForResults) {
      dialog.showToast('Please select a tournament first', 'error'); return;
    }
    const tournIndex = tournaments.findIndex(t => t.name === selectedTourneyForResults);
    if (tournIndex === -1) return;
    const t = tournaments[tournIndex];

    if (!t.slashGolfId) {
      dialog.showToast('No API ID found. Import 2026 Schedule first.', 'error'); return;
    }
    if (t.completed) {
      const ok = await dialog.showConfirm(
        'Already Processed',
        'This tournament was already processed. Re-fetching will ADD earnings again (doubling them).\n\nAre you sure?',
        { type: 'danger', confirmText: 'Force Re-Fetch' },
      );
      if (!ok) return;
    }

    try {
      dialog.showToast(`Fetching leaderboard for ${t.name}...`, 'info');
      
      // Fetch leaderboard (scores and positions)
      let data = await slashGolfFetch('leaderboard', { tournId: t.slashGolfId, year: '2026' });
      let apiPlayers = data.leaderboardRows || data.leaderboard || data.results || [];

      if (apiPlayers.length === 0) {
        dialog.showToast('No results found in API yet.', 'error'); return;
      }

      // Fetch earnings separately
      try {
        const earningsData = await slashGolfFetch('earnings', { tournId: t.slashGolfId, year: '2026' });
        const earningsPlayers = earningsData.leaderboard || earningsData.earnings || earningsData.results || [];
        
        if (earningsPlayers.length > 0) {
          // Merge earnings into leaderboard data by matching playerId
          apiPlayers = apiPlayers.map(lp => {
            const ep = earningsPlayers.find(e => e.playerId === lp.playerId);
            return { ...lp, earnings: ep?.earnings || 0 };
          });
          console.log('Merged earnings from /earnings endpoint');
        }
      } catch (e) {
        console.log('Earnings endpoint not available:', e.message);
      }

      // Build list of all rostered player names for fuzzy matching
      const rosteredNames = teams.flatMap(team => team.roster.map(p => p.name));

      const { newTeams, newStats, resultsData } = processTournamentData(
        t, apiPlayers, teams, globalPlayerStats, rosteredNames,
      );

      const newTournaments = tournaments.map((nt, idx) => {
        if (idx === tournIndex) return { ...nt, completed: true, playing: false, results: resultsData };
        return nt;
      });

      // Advance active tournament
      const nextIdx = newTournaments.findIndex((nt, idx) => idx > tournIndex && !nt.completed && !nt.isAlternate);
      if (nextIdx !== -1) {
        newTournaments.forEach(nt => { nt.playing = false; });
        newTournaments[nextIdx].playing = true;
      }

      updateTeams(newTeams);
      setGlobalPlayerStats(newStats);
      setTournaments(newTournaments);
      dialog.showToast(`Results processed for ${t.name}!`, 'success');
    } catch (error) {
      console.error('Results Sync Error:', error);
      dialog.showToast(`API Error: ${error.message}`, 'error');
    }
  };

  // ── Player Sync ───────────────────────────────────────────────────────────
  const handleSyncPlayers = async () => {
    const ok = await dialog.showConfirm(
      'Sync OWGR Players',
      'Fetch the current Top 250 OWGR players?\n\nThis will also fetch the LIV Golf roster to filter them out.',
      { confirmText: 'Fetch Players' },
    );
    if (!ok) return;

    try {
      dialog.showToast('Fetching LIV Golf Roster...', 'info');
      const livPlayers = new Set();
      for (const yr of ['2026', '2025']) {
        try {
          const livData = await slashGolfFetch('schedule', { orgId: '2', year: yr });
          if (livData?.schedule?.length > 0) {
            const firstLivId = livData.schedule[0].tournId;
            const livTourney = await slashGolfFetch('tournament', { orgId: '2', tournId: firstLivId, year: yr });
            livTourney.players?.forEach(p => {
              const pObj = p?.player || p || {};
              const name = `${pObj.firstName || ''} ${pObj.lastName || ''}`.trim();
              if (name) livPlayers.add(name);
            });
            break;
          }
        } catch { /* try next year */ }
      }

      dialog.showToast('Fetching World Rankings...', 'info');
      let details = [];
      for (const yr of ['2026', '2025', '2024']) {
        try {
          const owgrData = await slashGolfFetch('rankings', { statId: '186', year: yr });
          details = owgrData?.rankings?.[0]?.details || owgrData?.details || owgrData?.rankings || [];
          if (!details.length) {
            const statsData = await slashGolfFetch('stats', { statId: '186', year: yr });
            details = statsData?.stats?.[0]?.details || statsData?.details || [];
          }
          if (details.length) break;
        } catch { /* try next year */ }
      }

      const newPlayers = [];
      if (details.length > 0) {
        details.forEach(p => {
          const pObj    = p?.player || p || {};
          let name      = pObj?.fullName || pObj?.displayName || pObj?.name || '';
          if (!name) name = `${pObj.firstName || ''} ${pObj.lastName || ''}`.trim();
          const rankVal = parseInt(p?.rankValue || p?.rank || p?.curRank || pObj?.rank) || 999;
          if (name && !livPlayers.has(name) && newPlayers.length < 250) {
            newPlayers.push({ name, worldRank: rankVal });
          }
        });
      }

      if (newPlayers.length === 0) {
        Object.keys(PGA_TOUR_IDS).forEach((name, i) => {
          if (newPlayers.length < 250) newPlayers.push({ name, worldRank: i + 1 });
        });
        dialog.showToast(`API parsed 0 players. Fallback: ${newPlayers.length} players loaded.`, 'info');
      } else {
        dialog.showToast(`Success! Loaded ${newPlayers.length} players.`, 'success');
      }
      updateRankings(newPlayers);
    } catch (error) {
      console.error('Player Sync Error:', error);
      dialog.showToast(`API Error: ${error.message}`, 'error');
    }
  };

  // ── Mulligan reset ────────────────────────────────────────────────────────
  const resetMulligan = (teamId, type) => {
    const team = teams.find(t => t.id === teamId);
    if (!team) return;
    const key = type === 'sig' ? 'signatureMajor' : 'regular';
    updateTeams(teams.map(t => t.id === teamId ? { ...t, mulligans: { ...t.mulligans, [key]: 1 } } : t));
    dialog.showToast(`Reset ${type} mulligan for ${team.name}`, 'success');
  };

  // ── Season Reset ──────────────────────────────────────────────────────────
  const handleSeasonReset = async () => {
    const confirm1 = await dialog.showConfirm(
      '⚠️ DANGER: Reset Entire Season',
      'This will DELETE all tournament results, transactions, lineups, and player stats. Teams and rosters will be preserved.\n\nThis action CANNOT be undone.',
      { type: 'danger', confirmText: 'Continue' }
    );
    if (!confirm1) return;

    const confirm2 = await dialog.showConfirm(
      '⚠️ FINAL WARNING',
      'Are you ABSOLUTELY SURE you want to reset the entire season? This will wipe all progress.',
      { type: 'danger', confirmText: 'Yes, Reset Everything' }
    );
    if (!confirm2) return;

    // Reset teams
    const resetTeams = teams.map(team => ({
      ...team,
      earnings: 0,
      segmentEarnings: 0,
      lineup: [],
      mulligans: { signatureMajor: 1, regular: 1 },
      roster: team.roster.map(p => ({
        ...p,
        starts: 0,
        eventsPlayed: 0,
        cutsMade: 0,
        sfglEarnings: 0,
        pgaTourEarnings: 0,
      }))
    }));

    // Reset tournaments
    const resetTournaments = tournaments.map((t, idx) => ({
      ...t,
      completed: false,
      playing: idx === 0,
      results: null,
    }));

    // Clear transactions and player stats
    setTransactions([]);
    setGlobalPlayerStats({});
    updateTeams(resetTeams);
    setTournaments(resetTournaments);
    
    dialog.showToast('Season reset complete!', 'success');
  };

  // ── Draft Modal ───────────────────────────────────────────────────────────
  const handleDraft = async () => {
    const confirm = await dialog.showConfirm(
      'Start Draft',
      'This will clear all rosters and open a draft interface. Continue?',
      { confirmText: 'Start Draft' }
    );
    if (!confirm) return;
    setShowDraftModal(true);
  };

  // ── Roster Management ─────────────────────────────────────────────────────
  const handleAddPlayer = async (teamId, playerName) => {
    const team = teams.find(t => t.id === teamId);
    if (!team) return;
    
    if (team.roster.some(p => p.name === playerName)) {
      dialog.showToast('Player already on roster', 'error');
      return;
    }

    const player = allPlayers.find(p => p.name === playerName);
    if (!player) {
      dialog.showToast('Player not found', 'error');
      return;
    }

    const newPlayer = makePlayer(player.name, player.worldRank);
    const updatedTeams = teams.map(t => 
      t.id === teamId ? { ...t, roster: [...t.roster, newPlayer] } : t
    );
    
    updateTeams(updatedTeams);
    dialog.showToast(`Added ${playerName} to ${team.name}`, 'success');
  };

  const handleDropPlayer = async (teamId, playerName) => {
    const team = teams.find(t => t.id === teamId);
    if (!team) return;

    const confirm = await dialog.showConfirm(
      'Drop Player',
      `Remove ${playerName} from ${team.name}?`,
      { type: 'danger', confirmText: 'Drop Player' }
    );
    if (!confirm) return;

    const updatedTeams = teams.map(t =>
      t.id === teamId ? { ...t, roster: t.roster.filter(p => p.name !== playerName) } : t
    );

    updateTeams(updatedTeams);
    dialog.showToast(`Dropped ${playerName}`, 'success');
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center bg-gray-800/50 p-4 rounded-xl border border-gray-700">
        <h2 className="text-xl font-bold flex items-center gap-2">
          <Settings className="w-5 h-5 text-gray-400" /> Commissioner Controls
        </h2>
        <button
          onClick={() => { setIsCommissioner(false); setActiveTab('standings'); }}
          className="bg-red-600 hover:bg-red-700 px-4 py-1.5 rounded-lg text-sm font-bold transition-colors"
        >
          Logout
        </button>
      </div>

      {/* Results entry */}
      <div className="bg-blue-900/20 border border-blue-700/50 p-4 rounded-xl">
        <h3 className="font-bold text-blue-400 flex items-center gap-2 mb-4">✏️ Enter Tournament Results</h3>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-bold text-gray-400 block mb-1">Select Tournament</label>
            <select
              value={selectedTourneyForResults}
              onChange={e => setSelectedTourneyForResults(e.target.value)}
              className="w-full bg-gray-800 border border-gray-600 rounded p-2 text-sm"
            >
              <option value="">Choose tournament...</option>
              {tournaments.map(t => <option key={t.name} value={t.name}>{t.name}</option>)}
            </select>
          </div>
          <button
            onClick={handleFetchApiResults}
            className="w-full py-2.5 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm font-bold border border-gray-600 transition-colors flex items-center justify-center gap-2"
          >
            <span className="text-orange-500">⚡</span> Fetch Results from API
          </button>
        </div>
      </div>

      {/* Schedule + Player sync */}
      <div className="bg-teal-900/10 border border-teal-700/50 p-4 rounded-xl">
        <h3 className="font-bold text-teal-400 flex items-center gap-2 mb-4">🌎 World Rankings &amp; Schedule Sync</h3>
        <div className="flex gap-2">
          <button onClick={() => setShowScheduleImporter(true)} className="flex-1 bg-purple-600 hover:bg-purple-700 py-2 rounded text-sm font-bold transition-colors">
            Import 2026 Schedule
          </button>
          <button onClick={handleSyncPlayers} className="flex-1 bg-teal-600 hover:bg-teal-700 py-2 rounded-lg text-sm font-bold transition-colors">
            Sync OWGR Top 250
          </button>
        </div>
        {rankingsLastUpdated && (
          <p className="text-[10px] text-gray-500 mt-2 text-center">
            Rankings last updated: {new Date(rankingsLastUpdated).toLocaleDateString()}
          </p>
        )}
      </div>

      {/* Mulligan resets */}
      <div className="bg-gray-800/50 border border-gray-700 p-4 rounded-xl">
        <h3 className="font-bold text-gray-300 mb-3">🚨 Reset Mulligans</h3>
        <div className="space-y-2">
          {teams.map(team => (
            <div key={team.id} className="flex items-center justify-between bg-gray-700/30 rounded-lg px-3 py-2">
              <span className="text-sm font-medium">{team.name}</span>
              <div className="flex gap-2">
                <div className="text-[10px] text-gray-500 self-center">
                  Sig: {team.mulligans?.signatureMajor ?? 0} · Reg: {team.mulligans?.regular ?? 0}
                </div>
                <button onClick={() => resetMulligan(team.id, 'sig')} className="px-2 py-1 bg-purple-700 hover:bg-purple-600 rounded text-[10px] font-bold">Reset Sig</button>
                <button onClick={() => resetMulligan(team.id, 'reg')} className="px-2 py-1 bg-gray-600 hover:bg-gray-500 rounded text-[10px] font-bold">Reset Reg</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Roster Management */}
      <div className="bg-purple-900/20 border border-purple-700/50 p-4 rounded-xl">
        <h3 className="font-bold text-purple-400 flex items-center gap-2 mb-4">👥 Roster Management</h3>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-bold text-gray-400 block mb-1">Select Team</label>
            <select
              value={rosterMgmtTeam}
              onChange={e => setRosterMgmtTeam(e.target.value)}
              className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm"
            >
              <option value="">-- Choose Team --</option>
              {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          {rosterMgmtTeam && (() => {
            const team = teams.find(t => t.id === rosterMgmtTeam);
            return (
              <div className="mt-3">
                <div className="mb-2 text-sm font-bold text-gray-300">
                  {team.name} Roster ({team.roster.length} players)
                </div>
                <div className="max-h-60 overflow-y-auto bg-gray-800/50 rounded-lg border border-gray-700">
                  {team.roster.map(player => (
                    <div key={player.name} className="flex items-center justify-between px-3 py-2 border-b border-gray-700/50 last:border-0">
                      <span className="text-sm">{player.name}</span>
                      <button
                        onClick={() => handleDropPlayer(team.id, player.name)}
                        className="px-2 py-1 bg-red-600/80 hover:bg-red-600 rounded text-xs font-bold"
                      >
                        Drop
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  onClick={() => {
                    const playerName = prompt('Enter player name to add:');
                    if (playerName) handleAddPlayer(team.id, playerName.trim());
                  }}
                  className="w-full mt-2 py-2 bg-purple-600 hover:bg-purple-700 rounded-lg text-sm font-bold transition-colors"
                >
                  + Add Player
                </button>
              </div>
            );
          })()}
        </div>
      </div>

      {/* Draft & Season Reset */}
      <div className="bg-red-900/20 border border-red-700/50 p-4 rounded-xl">
        <h3 className="font-bold text-red-400 flex items-center gap-2 mb-4">⚠️ Dangerous Actions</h3>
        <div className="space-y-2">
          <button
            onClick={handleDraft}
            className="w-full py-2 bg-orange-600 hover:bg-orange-700 rounded-lg text-sm font-bold transition-colors"
          >
            🎯 Start Draft (clears all rosters)
          </button>
          <button
            onClick={handleSeasonReset}
            className="w-full py-2 bg-red-600 hover:bg-red-700 rounded-lg text-sm font-bold transition-colors"
          >
            🔥 Reset Entire Season
          </button>
        </div>
      </div>

      {/* Export / Import */}
      <div className="bg-gray-800/50 border border-gray-700 p-4 rounded-xl">
        <h3 className="font-bold text-gray-300 mb-3">💾 Backup &amp; Restore</h3>
        <div className="flex gap-2">
          <button onClick={handleExport} className="flex-1 py-2 bg-gray-600 hover:bg-gray-500 rounded-lg text-sm font-bold transition-colors">
            Export JSON
          </button>
          <label className="flex-1 py-2 bg-gray-600 hover:bg-gray-500 rounded-lg text-sm font-bold transition-colors text-center cursor-pointer">
            Import JSON
            <input type="file" accept=".json" onChange={handleImport} className="hidden" />
          </label>
        </div>
      </div>

      {/* Schedule Import Modal */}
      {showScheduleImporter && (
        <ScheduleImportModal
          onImport={handleImportSchedule}
          onCancel={() => setShowScheduleImporter(false)}
        />
      )}

      {/* Draft Modal */}
      {showDraftModal && (
        <DraftModal
          teams={teams}
          allPlayers={allPlayers}
          updateTeams={updateTeams}
          onClose={() => setShowDraftModal(false)}
        />
      )}
    </div>
  );
};
