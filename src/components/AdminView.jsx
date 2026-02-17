import React, { useState, useEffect } from 'react';
import { Settings, Edit2, Save } from 'lucide-react';
import { useDialog } from './DialogContext.jsx';
import { slashGolfFetch, processTournamentData, makePlayer } from '../utils/index.js';
import { PGA_TOUR_IDS, FALLBACK_SCHEDULE_DATA } from '../constants/index.js';
import { storage } from '../api.js';

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
  const handleSyncSchedule = async () => {
    const ok = await dialog.showConfirm(
      'Sync Schedule',
      'This will attach API tournament IDs to your existing schedule so results can be fetched.\n\nYour existing tournament names, dates, and results will NOT be changed.',
      { confirmText: 'Sync IDs Only' },
    );
    if (!ok) return;

    try {
      dialog.showToast('Fetching PGA Schedule...', 'info');
      
      let pgaData = null;
      for (const yr of ['2026', '2025']) {
        try {
          const data = await slashGolfFetch('schedule', { orgId: '1', year: yr });
          if (data?.schedule?.length > 0) { pgaData = data; break; }
        } catch (e) { /* try next year */ }
      }

      if (!pgaData?.schedule?.length) {
        dialog.showToast('Could not fetch schedule from API.', 'error');
        return;
      }

      const normalizeForMatch = (str) =>
        (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');

      // For each existing tournament, try to find its matching API entry
      // and ONLY copy the slashGolfId across. Everything else stays as-is.
      let matchCount = 0;
      const updatedTournaments = tournaments.map(existingT => {
        const existingNorm = normalizeForMatch(existingT.name);

        const apiMatch = pgaData.schedule.find(apiEvent => {
          const apiNorm = normalizeForMatch(apiEvent.name || '');
          return apiNorm === existingNorm ||
                 apiNorm.includes(existingNorm) ||
                 existingNorm.includes(apiNorm);
        });

        if (apiMatch) {
          const newId = apiMatch.tournId || apiMatch.id || '';
          if (newId && newId !== existingT.slashGolfId) {
            matchCount++;
            return { ...existingT, slashGolfId: newId };
          }
        }
        return existingT;
      });

      setTournaments(updatedTournaments);
      dialog.showToast(
        `Done! Matched ${matchCount} tournament${matchCount !== 1 ? 's' : ''} with API IDs. Your schedule data is unchanged.`,
        'success'
      );

    } catch (error) {
      console.error('Schedule Sync Error:', error);
      dialog.showToast(`API Error: ${error.message}`, 'error');
    }
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
      dialog.showToast('No API ID found. Click "Sync Schedule" first.', 'error'); return;
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
      const data       = await slashGolfFetch('leaderboard', { tournId: t.slashGolfId, year: '2026' });
      const apiPlayers = data.leaderboardRows || data.leaderboard || data.results || [];

      if (apiPlayers.length === 0) {
        dialog.showToast('No results found in API yet.', 'error'); return;
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
          <button onClick={handleSyncSchedule} className="flex-1 bg-purple-600 hover:bg-purple-700 py-2 rounded text-sm font-bold transition-colors">
            Sync Schedule
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
    </div>
  );
};
