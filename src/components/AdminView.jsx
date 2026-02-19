import React, { useState, useEffect } from 'react';
import { Settings, X } from 'lucide-react';
import { useDialog } from './DialogContext';
import { slashGolfFetch, processTournamentData, makePlayer, resolvePlayerName } from '../utils';
import { PGA_TOUR_IDS, FALLBACK_SCHEDULE_DATA, LIV_GOLF_ROSTER } from '../constants';
import { storage } from '../api';
import { ScheduleImportModal } from './ScheduleImportModal';
import { DraftModal } from './DraftModal';
import { managerAuthApi } from '../api/supabase';

// Expose resolvePlayerName globally for CSV upload handler
if (typeof window !== 'undefined') {
  window.resolvePlayerName = resolvePlayerName;
}

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
  const [playerSearch, setPlayerSearch] = useState('');
  const [owgrLastSynced, setOwgrLastSynced] = useState(null);
  const [showPlayerIdInput, setShowPlayerIdInput] = useState(false);
  const [playerIdSearch, setPlayerIdSearch] = useState('');
  const [playerIdValue, setPlayerIdValue] = useState('');
  const [showLivManager, setShowLivManager] = useState(false);
  const [livRoster, setLivRoster] = useState([]);
  const [livPlayerInput, setLivPlayerInput] = useState('');
  const [seedingManagers, setSeedingManagers] = useState(false);
  const dialog = useDialog();
  const activeTournament = tournaments.find(t => t.playing);

  useEffect(() => {
    const loadTimestamp = async () => {
      try {
        const timestamp = await storage.get(STORAGE_KEYS.OWGR_LAST_SYNCED);
        if (timestamp) setOwgrLastSynced(parseInt(timestamp));
      } catch (e) {
        console.error('Failed to load OWGR timestamp:', e);
      }
    };
    loadTimestamp();
  }, [STORAGE_KEYS.OWGR_LAST_SYNCED]);

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
        if (data.teams)             updateTeams(data.teams);
        if (data.tournaments)       setTournaments(data.tournaments);
        if (data.transactions)      setTransactions(data.transactions);
        if (data.settings)        { setSettings(data.settings);            await storage.set(STORAGE_KEYS.SETTINGS,           data.settings); }
        if (data.globalPlayerStats){ setGlobalPlayerStats(data.globalPlayerStats); await storage.set(STORAGE_KEYS.GLOBAL_PLAYER_STATS, data.globalPlayerStats); }
        if (data.headshots)       { setHeadshots(data.headshots);          await storage.set(STORAGE_KEYS.HEADSHOTS,           data.headshots); }
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
      let data = await slashGolfFetch('leaderboard', { tournId: t.slashGolfId, year: '2026' });
      let apiPlayers = data.leaderboardRows || data.leaderboard || data.results || [];

      if (apiPlayers.length === 0) {
        dialog.showToast('No results found in API yet.', 'error'); return;
      }

      try {
        const earningsData = await slashGolfFetch('earnings', { tournId: t.slashGolfId, year: '2026' });
        const earningsPlayers = earningsData.leaderboard || earningsData.earnings || earningsData.results || [];
        if (earningsPlayers.length > 0) {
          apiPlayers = apiPlayers.map(lp => {
            const ep = earningsPlayers.find(e => e.playerId === lp.playerId);
            return { ...lp, earnings: ep?.earnings || 0 };
          });
        }
      } catch (e) {
        console.log('Earnings endpoint not available:', e.message);
      }

      const rosteredNames = teams.flatMap(team => team.roster.map(p => p.name));
      const { newTeams, newStats, resultsData } = processTournamentData(
        t, apiPlayers, teams, globalPlayerStats, rosteredNames,
      );

      const newTournaments = tournaments.map((nt, idx) => {
        if (idx === tournIndex) return { ...nt, completed: true, playing: false, results: resultsData };
        return nt;
      });

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

  // ── CSV Upload Handler ────────────────────────────────────────────────────
  const handleCsvUpload = async (file) => {
    if (!file) return;
    try {
      dialog.showToast('Processing CSV...', 'info');
      const text = await file.text();
      const lines = text.split('\n').slice(1);
      const knownNames = allPlayers.length > 0 ? allPlayers.map(p => p.name) : Object.keys(PGA_TOUR_IDS);
      const { livRosterApi } = await import('../api/supabase');
      const livPlayersArray = await livRosterApi.getAll().catch(() => []);
      const livPlayers = new Set(livPlayersArray);
      const csvPlayers = [];
      const resolvedNames = new Set();

      for (const line of lines) {
        if (!line.trim()) continue;
        const match = line.match(/(?:^|,)("(?:[^"]+|"")*"|[^,]*)/g);
        if (!match || match.length < 7) continue;
        const fields = match.map(f => f.replace(/^,?"?|"?$/g, '').replace(/""/g, '"'));
        const rank = parseInt(fields[1]) || 999;
        const csvName = fields[5]?.trim();
        if (!csvName) continue;
        const resolvedName = window.resolvePlayerName(csvName, knownNames);
        const finalName = resolvedName || csvName;
        if (resolvedNames.has(finalName) || livPlayers.has(finalName) || csvPlayers.length >= 250) continue;
        const pgaTourId = PGA_TOUR_IDS[finalName] || null;
        csvPlayers.push({ name: finalName, worldRank: rank, pgaTourId });
        resolvedNames.add(finalName);
        if (resolvedName && resolvedName !== csvName) console.log(`Resolved: "${csvName}" → "${resolvedName}"`);
      }

      if (csvPlayers.length > 0) {
        const withIds = csvPlayers.filter(p => p.pgaTourId).length;
        const now = Date.now();
        await storage.set(STORAGE_KEYS.OWGR_LAST_SYNCED, now.toString());
        setOwgrLastSynced(now);
        updateRankings(csvPlayers);
        dialog.showToast(`✓ Loaded ${csvPlayers.length} players from CSV (${withIds} with PGA Tour IDs)!`, 'success');
      } else {
        dialog.showToast('No valid players found in CSV', 'error');
      }
    } catch (err) {
      console.error('CSV parse error:', err);
      dialog.showToast(`Failed to parse CSV: ${err.message}`, 'error');
    }
  };

  const handleSyncCsv = async () => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.csv';
    input.onchange = async (e) => await handleCsvUpload(e.target.files[0]);
    input.click();
  };

  // ── Player Sync ───────────────────────────────────────────────────────────
  const handleSyncPlayers = async () => {
    const now = Date.now();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    if (owgrLastSynced && (now - owgrLastSynced < sevenDays)) {
      const daysSince = Math.floor((now - owgrLastSynced) / (24 * 60 * 60 * 1000));
      const warning = await dialog.showConfirm(
        '⚠️ Recent Sync Detected',
        `OWGR was synced ${daysSince} day${daysSince === 1 ? '' : 's'} ago.\n\nSyncing frequently uses API calls (~3 calls). OWGR rankings don't change much week-to-week.\n\nRecommendation: Sync every 2-3 weeks, or use CSV upload (0 API calls).\n\nContinue with API sync anyway?`,
        { type: 'warning', confirmText: 'Sync Anyway' }
      );
      if (!warning) return;
    }

    const ok = await dialog.showConfirm(
      'Sync OWGR Players via API',
      'Fetch the current Top 250 OWGR players?\n\nThis will also fetch the LIV Golf roster to filter them out.\n\nAPI Calls: ~3 calls',
      { confirmText: 'Fetch Players' },
    );
    if (!ok) return;

    try {
      dialog.showToast('Fetching LIV Golf Roster...', 'info');
      const livPlayers = new Set();
      const { livRosterApi } = await import('../api/supabase');
      try {
        const supabaseLivPlayers = await livRosterApi.getAll();
        if (supabaseLivPlayers.length > 0) {
          supabaseLivPlayers.forEach(name => livPlayers.add(name));
          await storage.set('fantasy-golf-liv-cache', JSON.stringify(supabaseLivPlayers));
          await storage.set('fantasy-golf-liv-cache-timestamp', now.toString());
        }
      } catch (supabaseError) {
        const cached = await storage.get('fantasy-golf-liv-cache');
        if (cached) JSON.parse(cached).forEach(name => livPlayers.add(name));
      }

      if (livPlayers.size === 0) {
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
              if (livPlayers.size > 0) break;
            }
          } catch { /* try next year */ }
        }
      }

      dialog.showToast('Fetching World Rankings...', 'info');
      let rankings = [];
      try {
        const owgrData = await slashGolfFetch('worldranking', { year: '2026' });
        rankings = owgrData?.rankings || [];
        if (rankings.length) dialog.showToast(`Loaded OWGR data from 2026 season`, 'info');
      } catch (e) {
        console.log('World ranking endpoint failed:', e.message);
      }

      const newPlayers = [];
      if (rankings.length > 0) {
        rankings.forEach(p => {
          const name = p.fullName || `${p.firstName || ''} ${p.lastName || ''}`.trim();
          const rankVal = parseInt(p.rank) || 999;
          if (name && !livPlayers.has(name) && newPlayers.length < 250) {
            newPlayers.push({ name, worldRank: rankVal });
          }
        });
      }

      if (newPlayers.length === 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
        const uploadChoice = await dialog.showConfirm(
          'API Data Unavailable',
          '2026 OWGR data is not available via API yet.\n\nDownload the latest rankings CSV from:\nhttps://www.owgr.com/current-world-ranking\n\nThen click "Upload CSV" to import it.\n\nOr click "Use Fallback" to use the fallback list.',
          { confirmText: 'Upload CSV', cancelText: 'Use Fallback' }
        );
        if (uploadChoice) {
          const input = document.createElement('input');
          input.type = 'file'; input.accept = '.csv';
          input.onchange = async (e) => await handleCsvUpload(e.target.files[0]);
          input.click();
          return;
        } else {
          Object.keys(PGA_TOUR_IDS).forEach((name, i) => {
            if (newPlayers.length < 250) newPlayers.push({ name, worldRank: i + 1 });
          });
          dialog.showToast(`Using fallback player list (${newPlayers.length} players). Upload CSV later for current rankings.`, 'warning');
        }
      } else {
        await storage.set(STORAGE_KEYS.OWGR_LAST_SYNCED, now.toString());
        setOwgrLastSynced(now);
        dialog.showToast(`✓ Loaded ${newPlayers.length} PGA Tour players with live OWGR rankings!`, 'success');
      }
      updateRankings(newPlayers);
    } catch (error) {
      console.error('Player Sync Error:', error);
      dialog.showToast(`API Error: ${error.message}`, 'error');
    }
  };

  // ── Add PGA Tour ID ───────────────────────────────────────────────────────
  const handleAddPlayerId = async () => {
    if (!playerIdSearch || !playerIdValue) {
      dialog.showToast('Please enter both player name and PGA Tour ID', 'error'); return;
    }
    try {
      const player = allPlayers.find(p => p.name.toLowerCase().includes(playerIdSearch.toLowerCase()));
      if (!player) { dialog.showToast('Player not found in rankings', 'error'); return; }
      const { supabase } = await import('../api/supabase');
      const { error } = await supabase.from('player_rankings').update({ pga_tour_id: playerIdValue }).eq('name', player.name);
      if (error) throw error;
      const updatedPlayers = allPlayers.map(p => p.name === player.name ? { ...p, pgaTourId: playerIdValue } : p);
      updateRankings(updatedPlayers);
      dialog.showToast(`✓ Added PGA Tour ID ${playerIdValue} for ${player.name}`, 'success');
      setPlayerIdSearch(''); setPlayerIdValue(''); setShowPlayerIdInput(false);
    } catch (error) {
      dialog.showToast(`Failed to add ID: ${error.message}`, 'error');
    }
  };

  // ── LIV Roster Management ─────────────────────────────────────────────────
  const handleOpenLivManager = async () => {
    try {
      dialog.showToast('Loading LIV roster...', 'info');
      const { livRosterApi } = await import('../api/supabase');
      try {
        const players = await livRosterApi.getAll();
        if (players.length > 0) {
          setLivRoster(players);
        } else {
          const cached = await storage.get('fantasy-golf-liv-cache');
          setLivRoster(cached ? JSON.parse(cached).sort() : []);
        }
      } catch {
        const cached = await storage.get('fantasy-golf-liv-cache');
        setLivRoster(cached ? JSON.parse(cached).sort() : []);
      }
      setShowLivManager(true);
    } catch (error) {
      setLivRoster([]); setShowLivManager(true);
    }
  };

  const handleFetchLivRoster = async () => {
    try {
      const sortedPlayers = [...LIV_GOLF_ROSTER].sort();
      setLivRoster(sortedPlayers);
      dialog.showToast(`✓ Loaded ${sortedPlayers.length} LIV players (2026 season)`, 'success');
    } catch (error) {
      dialog.showToast('Failed to load LIV roster', 'error');
    }
  };

  const handleAddLivPlayer = () => {
    const playerName = livPlayerInput.trim();
    if (!playerName) return;
    if (livRoster.includes(playerName)) { dialog.showToast('Player already in LIV roster', 'error'); return; }
    setLivRoster([...livRoster, playerName].sort());
    setLivPlayerInput('');
  };

  const handleRemoveLivPlayer = (playerName) => setLivRoster(livRoster.filter(p => p !== playerName));

  const handleSaveLivRoster = async () => {
    try {
      const { livRosterApi } = await import('../api/supabase');
      await livRosterApi.setAll(livRoster);
      await storage.set('fantasy-golf-liv-cache', JSON.stringify(livRoster));
      await storage.set('fantasy-golf-liv-cache-timestamp', Date.now().toString());
      dialog.showToast(`✓ Saved ${livRoster.length} LIV players (synced to all devices)`, 'success');
      setShowLivManager(false);
    } catch (error) {
      dialog.showToast('Failed to save LIV roster', 'error');
    }
  };

  // ── Seed Manager Credentials ───────────────────────────────────────────────
  const handleSeedManagers = async () => {
    const confirmed = await dialog.showConfirm(
      'Set Manager Passwords',
      `This will set login credentials for all ${teams.length} managers:\n\n` +
      teams.map(t => `• ${t.owner} → password: "${t.owner.toLowerCase()}"`).join('\n') +
      '\n\nManagers can log in immediately after. Safe to run again if needed.',
      { confirmText: 'Set Passwords' }
    );
    if (!confirmed) return;

    setSeedingManagers(true);
    try {
      const results = await managerAuthApi.seedAllManagers(teams);
      const failed = results.filter(r => !r.success);
      if (failed.length > 0) {
        dialog.showToast(`⚠ ${failed.length} failed: ${failed.map(r => r.owner).join(', ')}`, 'error');
      } else {
        dialog.showToast(`✓ All ${results.length} manager passwords set! They can now log in.`, 'success');
      }
    } catch (error) {
      dialog.showToast(`Failed: ${error.message}`, 'error');
    } finally {
      setSeedingManagers(false);
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
      'This will DELETE:\n• All tournament results and stats\n• All transactions\n• All rosters and lineups\n• All player data\n\nThis action CANNOT be undone.',
      { type: 'danger', confirmText: 'Continue' }
    );
    if (!confirm1) return;

    const confirm2 = await dialog.showConfirm(
      '⚠️ FINAL WARNING',
      'Are you ABSOLUTELY SURE? This will wipe EVERYTHING including all rosters.',
      { type: 'danger', confirmText: 'Yes, Reset Everything' }
    );
    if (!confirm2) return;

    const resetTeams = teams.map(team => ({
      ...team, earnings: 0, segmentEarnings: 0,
      lineup: [], roster: [], mulligans: { signatureMajor: 1, regular: 1 },
    }));
    const resetTournaments = tournaments.map((t, idx) => ({
      ...t, completed: false, playing: idx === 0, results: null,
    }));
    setTransactions([]);
    setGlobalPlayerStats({});
    updateTeams(resetTeams);
    setTournaments(resetTournaments);
    dialog.showToast('Season reset complete! All rosters cleared.', 'success');
  };

  // ── Draft ─────────────────────────────────────────────────────────────────
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
    if (team.roster.some(p => p.name === playerName)) { dialog.showToast('Player already on roster', 'error'); return; }
    const player = allPlayers.find(p => p.name === playerName);
    if (!player) { dialog.showToast('Player not found', 'error'); return; }
    const newPlayer = makePlayer(player.name, player.worldRank);
    updateTeams(teams.map(t => t.id === teamId ? { ...t, roster: [...t.roster, newPlayer] } : t));
    dialog.showToast(`Added ${playerName} to ${team.name}`, 'success');
  };

  const handleDropPlayer = async (teamId, playerName) => {
    const team = teams.find(t => t.id === teamId);
    if (!team) return;
    const confirm = await dialog.showConfirm('Drop Player', `Remove ${playerName} from ${team.name}?`, { type: 'danger', confirmText: 'Drop Player' });
    if (!confirm) return;
    updateTeams(teams.map(t => t.id === teamId ? { ...t, roster: t.roster.filter(p => p.name !== playerName) } : t));
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

      {/* ── Manager Login Setup ──────────────────────────────────────────── */}
      <div className="bg-green-900/20 border border-green-700/50 p-4 rounded-xl">
        <h3 className="font-bold text-green-400 flex items-center gap-2 mb-2">🔑 Manager Login Setup</h3>
        <p className="text-xs text-gray-400 mb-3">
          Run this once to set passwords for all managers. Each manager's password will be their name in lowercase.
        </p>

        {/* Credentials table */}
        <div className="bg-gray-900/60 rounded-lg border border-gray-700 mb-3 overflow-hidden">
          <div className="grid grid-cols-3 px-3 py-1.5 border-b border-gray-700 text-[10px] font-bold text-gray-500 uppercase tracking-wider">
            <span>Team</span><span>Name (login)</span><span>Password</span>
          </div>
          {teams.map(t => (
            <div key={t.id} className="grid grid-cols-3 px-3 py-2 border-b border-gray-700/50 last:border-0 text-xs">
              <span className="text-gray-300 truncate">{t.name}</span>
              <span className="text-white font-medium">{t.owner}</span>
              <span className="text-green-400 font-mono">{t.owner.toLowerCase()}</span>
            </div>
          ))}
        </div>

        <button
          onClick={handleSeedManagers}
          disabled={seedingManagers}
          className="w-full py-2.5 bg-green-600 hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-sm font-bold transition-colors flex items-center justify-center gap-2"
        >
          {seedingManagers ? (
            <><span className="animate-spin">⏳</span> Setting passwords…</>
          ) : (
            <><span>🔑</span> Set All Manager Passwords</>
          )}
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

      {/* Player Management */}
      <div className="bg-teal-900/10 border border-teal-700/50 p-4 rounded-xl">
        <h3 className="font-bold text-teal-400 flex items-center gap-2 mb-4">👤 Player Management</h3>
        <div className="grid grid-cols-2 gap-2 mb-2">
          <button onClick={handleSyncPlayers} className="bg-teal-600 hover:bg-teal-700 py-2 rounded-lg text-xs font-bold transition-colors" title="Uses ~3 API calls">
            Sync via API
          </button>
          <button onClick={handleSyncCsv} className="bg-green-600 hover:bg-green-700 py-2 rounded-lg text-xs font-bold transition-colors" title="0 API calls - upload from owgr.com">
            Sync via CSV
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2 mb-2">
          <button onClick={() => setShowPlayerIdInput(true)} className="bg-blue-600 hover:bg-blue-700 py-2 rounded-lg text-xs font-bold transition-colors">
            Add PGA Tour ID
          </button>
          <button onClick={handleOpenLivManager} className="bg-gray-700 hover:bg-gray-600 py-2 rounded text-xs font-bold transition-colors">
            Manage LIV Roster
          </button>
        </div>
        <div className="mt-2 space-y-1">
          {rankingsLastUpdated && (
            <p className="text-[10px] text-gray-500 text-center">
              Rankings last updated: {new Date(rankingsLastUpdated).toLocaleDateString()}
            </p>
          )}
          {owgrLastSynced && (
            <p className="text-[10px] text-teal-400 text-center font-medium">
              Last OWGR sync: {new Date(owgrLastSynced).toLocaleDateString()} at {new Date(owgrLastSynced).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </p>
          )}
        </div>
      </div>

      {/* Roster Management with Mulligans */}
      <div className="bg-purple-900/20 border border-purple-700/50 p-4 rounded-xl">
        <h3 className="font-bold text-purple-400 flex items-center gap-2 mb-4">👥 Roster Management</h3>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-bold text-gray-400 block mb-1">Select Team</label>
            <select
              value={rosterMgmtTeam}
              onChange={e => { setRosterMgmtTeam(e.target.value); setPlayerSearch(''); }}
              className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm"
            >
              <option value="">-- Choose Team --</option>
              {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>

          {rosterMgmtTeam && (() => {
            const team = teams.find(t => t.id === rosterMgmtTeam);
            return (
              <div className="bg-gray-800/30 border border-gray-600 rounded-lg p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-bold text-gray-400">Mulligan Management</span>
                  <div className="text-[10px] text-gray-500">
                    Sig: {team.mulligans?.signatureMajor ?? 0} · Reg: {team.mulligans?.regular ?? 0}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => resetMulligan(team.id, 'sig')} className="flex-1 px-2 py-1.5 bg-purple-700 hover:bg-purple-600 rounded text-xs font-bold transition-colors">
                    Reset Signature
                  </button>
                  <button onClick={() => resetMulligan(team.id, 'reg')} className="flex-1 px-2 py-1.5 bg-gray-600 hover:bg-gray-500 rounded text-xs font-bold transition-colors">
                    Reset Regular
                  </button>
                </div>
              </div>
            );
          })()}

          {rosterMgmtTeam && (() => {
            const team = teams.find(t => t.id === rosterMgmtTeam);
            const searchResults = playerSearch.trim()
              ? allPlayers.filter(p => p.name.toLowerCase().includes(playerSearch.toLowerCase())).filter(p => !team.roster.some(r => r.name === p.name)).slice(0, 20)
              : [];

            return (
              <div className="mt-3">
                <div className="mb-2 text-sm font-bold text-gray-300">{team.name} Roster ({team.roster.length} players)</div>
                <div className="max-h-60 overflow-y-auto bg-gray-800/50 rounded-lg border border-gray-700 mb-3">
                  {team.roster.map(player => (
                    <div key={player.name} className="flex items-center justify-between px-3 py-2 border-b border-gray-700/50 last:border-0">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <img
                          src={`https://pga-tour-res.cloudflare.com/resources/photoplayer/${headshots[player.name] || 'default'}.jpg`}
                          onError={e => { e.target.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(player.name)}&background=1f2937&color=9ca3af&size=32`; }}
                          alt="" className="w-7 h-7 rounded-full object-cover border border-gray-600 flex-shrink-0"
                        />
                        <span className="text-sm truncate">{player.name}</span>
                      </div>
                      <button onClick={() => handleDropPlayer(team.id, player.name)} className="px-2 py-1 bg-red-600/80 hover:bg-red-600 rounded text-xs font-bold flex-shrink-0">
                        Drop
                      </button>
                    </div>
                  ))}
                </div>

                <div className="bg-gray-900/50 rounded-lg border border-gray-700 p-3">
                  <div className="mb-2">
                    <label className="text-xs font-bold text-gray-400 block mb-1">Search Players</label>
                    <input type="text" placeholder="Type player name..." value={playerSearch}
                      onChange={e => setPlayerSearch(e.target.value)}
                      className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-sm"
                    />
                  </div>
                  {playerSearch.trim() && (
                    <div className="max-h-48 overflow-y-auto bg-gray-800 rounded border border-gray-700">
                      {searchResults.length > 0 ? searchResults.map(player => (
                        <button key={player.name}
                          onClick={() => { handleAddPlayer(team.id, player.name); setPlayerSearch(''); }}
                          className="w-full flex items-center justify-between px-3 py-2 hover:bg-gray-700 border-b border-gray-700/50 last:border-0 text-left transition-colors"
                        >
                          <div className="flex items-center gap-2 min-w-0 flex-1">
                            <img
                              src={`https://pga-tour-res.cloudflare.com/resources/photoplayer/${headshots[player.name] || 'default'}.jpg`}
                              onError={e => { e.target.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(player.name)}&background=1f2937&color=9ca3af&size=32`; }}
                              alt="" className="w-7 h-7 rounded-full object-cover border border-gray-600 flex-shrink-0"
                            />
                            <div className="min-w-0">
                              <div className="text-sm font-medium truncate">{player.name}</div>
                              <div className="text-xs text-gray-500">Rank: {player.worldRank === 999 ? 'NR' : player.worldRank}</div>
                            </div>
                          </div>
                          <span className="text-green-400 font-bold text-xs flex-shrink-0">Add</span>
                        </button>
                      )) : (
                        <div className="text-center py-4 text-gray-500 text-xs">No players found</div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })()}
        </div>
      </div>

      {/* Backup & Restore */}
      <div className="bg-gray-800/50 border border-gray-700 p-4 rounded-xl">
        <h3 className="font-bold text-gray-300 mb-3 flex items-center gap-2">💾 Backup &amp; Restore</h3>
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

      {/* Schedule Import */}
      <div className="bg-purple-900/20 border border-purple-700/50 p-4 rounded-xl">
        <h3 className="font-bold text-purple-400 flex items-center gap-2 mb-3">📅 Tournament Schedule</h3>
        <button onClick={() => setShowScheduleImporter(true)} className="w-full py-2 bg-purple-600 hover:bg-purple-700 rounded-lg text-sm font-bold transition-colors">
          Import 2026 Schedule
        </button>
      </div>

      {/* Draft */}
      <div className="bg-orange-900/20 border border-orange-700/50 p-4 rounded-xl">
        <h3 className="font-bold text-orange-400 flex items-center gap-2 mb-3">🎯 Start New Draft</h3>
        <p className="text-xs text-gray-400 mb-3">This will clear all rosters and begin keeper selection.</p>
        <button onClick={handleDraft} className="w-full py-2.5 bg-orange-600 hover:bg-orange-700 rounded-lg text-sm font-bold transition-colors">
          Start Draft
        </button>
      </div>

      {/* Danger Zone */}
      <div className="bg-red-900/20 border border-red-700/50 p-4 rounded-xl">
        <h3 className="font-bold text-red-400 flex items-center gap-2 mb-3">⚠️ DANGER ZONE</h3>
        <p className="text-xs text-gray-400 mb-3">This will permanently delete all tournament results, transactions, lineups, rosters, and player stats. Team names and schedule will be preserved.</p>
        <button onClick={handleSeasonReset} className="w-full py-2.5 bg-red-600 hover:bg-red-700 rounded-lg text-sm font-bold transition-colors">
          🔥 Reset Entire Season
        </button>
      </div>

      {/* Schedule Import Modal */}
      {showScheduleImporter && (
        <ScheduleImportModal onImport={handleImportSchedule} onCancel={() => setShowScheduleImporter(false)} />
      )}

      {/* Player ID Input Modal */}
      {showPlayerIdInput && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50">
          <div className="bg-gray-800 rounded-xl p-6 max-w-md w-full border border-blue-600">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-bold">Add PGA Tour ID</h3>
              <button onClick={() => { setShowPlayerIdInput(false); setPlayerIdSearch(''); setPlayerIdValue(''); }} className="text-gray-400 hover:text-white">
                <X className="w-6 h-6" />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="text-xs font-bold text-gray-400 block mb-1">Search Player</label>
                <input type="text" placeholder="Player name..." value={playerIdSearch} onChange={e => setPlayerIdSearch(e.target.value)}
                  className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-sm" autoFocus />
                {playerIdSearch && (
                  <div className="mt-2 max-h-32 overflow-y-auto bg-gray-900 rounded border border-gray-700">
                    {allPlayers.filter(p => p.name.toLowerCase().includes(playerIdSearch.toLowerCase())).slice(0, 5).map(player => (
                      <button key={player.name} onClick={() => setPlayerIdSearch(player.name)}
                        className="w-full text-left px-3 py-2 hover:bg-gray-700 border-b border-gray-700/50 last:border-0">
                        <div className="font-medium text-sm">{player.name}</div>
                        <div className="text-xs text-gray-400">Rank: #{player.worldRank}{player.pgaTourId && ` • ID: ${player.pgaTourId}`}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <label className="text-xs font-bold text-gray-400 block mb-1">PGA Tour ID</label>
                <input type="text" placeholder="e.g., 46046" value={playerIdValue} onChange={e => setPlayerIdValue(e.target.value)}
                  className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-sm" />
                <p className="text-xs text-gray-500 mt-1">Find player IDs on pgatour.com or from API responses</p>
              </div>
              <div className="flex gap-3 pt-2">
                <button onClick={() => { setShowPlayerIdInput(false); setPlayerIdSearch(''); setPlayerIdValue(''); }}
                  className="flex-1 px-4 py-2 bg-gray-600 hover:bg-gray-500 rounded-lg font-bold transition-colors">Cancel</button>
                <button onClick={handleAddPlayerId} className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg font-bold transition-colors">Add ID</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* LIV Roster Management Modal */}
      {showLivManager && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50">
          <div className="bg-gray-800 rounded-xl p-6 max-w-lg w-full border border-orange-600">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-bold">Manage LIV Golf Roster</h3>
              <button onClick={() => setShowLivManager(false)} className="text-gray-400 hover:text-white"><X className="w-6 h-6" /></button>
            </div>
            <p className="text-sm text-gray-400 mb-4">Players in this list will be filtered out during OWGR sync.</p>
            <button onClick={handleFetchLivRoster} className="w-full mb-4 py-2 bg-purple-600 hover:bg-purple-700 rounded-lg text-sm font-bold transition-colors">
              📋 Load 2026 LIV Roster (52 players)
            </button>
            <div className="mb-4">
              <label className="text-xs font-bold text-gray-400 block mb-1">Add LIV Player</label>
              <div className="flex gap-2">
                <input type="text" placeholder="Player name (e.g., Brooks Koepka)" value={livPlayerInput}
                  onChange={e => setLivPlayerInput(e.target.value)} onKeyPress={e => e.key === 'Enter' && handleAddLivPlayer()}
                  className="flex-1 bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-sm" />
                <button onClick={handleAddLivPlayer} className="px-4 py-2 bg-green-600 hover:bg-green-500 rounded-lg font-bold text-sm transition-colors">Add</button>
              </div>
            </div>
            <div className="bg-gray-900 rounded-lg border border-gray-700 max-h-64 overflow-y-auto mb-4">
              {livRoster.length > 0 ? (
                <div className="divide-y divide-gray-700">
                  {livRoster.map(player => (
                    <div key={player} className="flex items-center justify-between px-3 py-2 hover:bg-gray-800">
                      <span className="text-sm">{player}</span>
                      <button onClick={() => handleRemoveLivPlayer(player)} className="text-red-400 hover:text-red-300 text-xs font-bold">Remove</button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8 text-gray-500 text-sm">No LIV players in roster.</div>
              )}
            </div>
            <div className="text-xs text-gray-500 mb-4">Total: {livRoster.length} player{livRoster.length !== 1 ? 's' : ''}</div>
            <div className="flex gap-3">
              <button onClick={() => setShowLivManager(false)} className="flex-1 px-4 py-2 bg-gray-600 hover:bg-gray-500 rounded-lg font-bold transition-colors">Cancel</button>
              <button onClick={handleSaveLivRoster} className="flex-1 px-4 py-2 bg-orange-600 hover:bg-orange-500 rounded-lg font-bold transition-colors">Save Roster</button>
            </div>
          </div>
        </div>
      )}

      {/* Draft Modal */}
      {showDraftModal && (
        <DraftModal teams={teams} allPlayers={allPlayers} updateTeams={updateTeams} onClose={() => setShowDraftModal(false)} headshots={headshots} />
      )}
    </div>
  );
};
