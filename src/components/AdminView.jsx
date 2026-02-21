import React, { useState, useEffect } from 'react';
import { Settings, X } from 'lucide-react';
import { useDialog } from './DialogContext';
import { slashGolfFetch, processTournamentData, makePlayer, resolvePlayerName } from '../utils';
import { PGA_TOUR_IDS, FALLBACK_SCHEDULE_DATA, LIV_GOLF_ROSTER } from '../constants';
import { storage } from '../api';
import { ScheduleImportModal } from './ScheduleImportModal';
import { DraftModal } from './DraftModal';
import { managerAuthApi, tournamentResultsApi, sfglDataApi } from '../api/supabase';

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
  // Manager credentials (individual login setup)
  const [mgCredTeam, setMgCredTeam] = useState('');
  const [mgCredName, setMgCredName] = useState('');
  const [mgCredPass, setMgCredPass] = useState('');
  const [mgCredSaving, setMgCredSaving] = useState(false);
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


  // ── handleSetManagerCredentials ──────────────────────────────────────────
  const handleSetManagerCredentials = async () => {
    if (!mgCredTeam || !mgCredName || !mgCredPass) return;
    setMgCredSaving(true);
    try {
      await managerAuthApi.setCredentials(mgCredTeam, mgCredName, mgCredPass);
      dialog.showToast('Login set for ' + mgCredName, 'success');
      setMgCredTeam(''); setMgCredName(''); setMgCredPass('');
    } catch (e) {
      dialog.showToast('Failed: ' + e.message, 'error');
    }
    setMgCredSaving(false);
  };

  // ── handlePushToSupabase ─────────────────────────────────────────────────
  const handlePushToSupabase = async () => {
    const ok = await dialog.showConfirm(
      'Push All Data to Supabase',
      'This will overwrite the shared Supabase database with the data currently loaded on this device.\n\nAll other devices will see this data on next refresh.',
      { confirmText: 'Push to Supabase' }
    );
    if (!ok) return;
    dialog.showToast('Pushing to Supabase...', 'info');
    try {
      await Promise.all([
        sfglDataApi.set(STORAGE_KEYS.TEAMS,               teams),
        sfglDataApi.set(STORAGE_KEYS.TOURNAMENTS,         tournaments),
        sfglDataApi.set(STORAGE_KEYS.TRANSACTIONS,        transactions),
        sfglDataApi.set(STORAGE_KEYS.SETTINGS,            settings),
        sfglDataApi.set(STORAGE_KEYS.GLOBAL_PLAYER_STATS, globalPlayerStats),
      ]);
      // Also push completed tournament results to tournament_results table
      const completedTournaments = tournaments.filter(t => t.completed && t.results);
      if (completedTournaments.length > 0) {
        await Promise.all(completedTournaments.map(t =>
          tournamentResultsApi.save({
            tournamentName: t.name,
            teamResults:    t.results.teams || {},
            earningsMap:    t.results.earningsMap || {},
            roundLeaders:   t.results.roundLeaders || {},
            fullLineups:    t.results.fullLineups || {},
          }).catch(() => {})
        ));
      }
      dialog.showToast('Pushed! Refresh the page on mobile to see results.', 'success');
    } catch (e) {
      dialog.showToast('Push failed: ' + e.message, 'error');
    }
  };

  // ── handleRepairRosterFlags ──────────────────────────────────────────────
  const handleRepairRosterFlags = async () => {
    const ok = await dialog.showConfirm(
      'Repair Roster Flags',
      'This will fix the Unlimited (blue) flag on all rosters.\n\nEach team keeps exactly 1 Unlimited player (their keeper). All other non-limited players will show White.\n\nThis is safe to run and does not affect earnings or stats.',
      { confirmText: 'Repair Rosters' }
    );
    if (!ok) return;
    const updatedTeams = teams.map(team => {
      const keeperName = team.keeper || null;
      const newRoster = team.roster.map(p => {
        if (p.limited) return { ...p, unlimited: false };
        if (keeperName && p.name === keeperName) return { ...p, unlimited: true };
        return { ...p, unlimited: false };
      });
      return { ...team, roster: newRoster };
    });
    updateTeams(updatedTeams);
    await storage.set(STORAGE_KEYS.TEAMS, updatedTeams);
    dialog.showToast('Roster flags repaired', 'success');
  };

  // ── handleSyncRostersFromTransactions ────────────────────────────────────
  const handleSyncRostersFromTransactions = async () => {
    const ok = await dialog.showConfirm(
      'Sync Rosters from Transactions',
      'This will replay all processed transactions against each team's draft roster to fix any add/drop drift.\n\nSafe to run - does not affect earnings or Limited/Unlimited flags.',
      { confirmText: 'Sync Rosters' }
    );
    if (!ok) return;
    const updatedTeams = teams.map(team => {
      const processedTx = transactions
        .filter(tx => tx.team === team.name && tx.status === 'processed' && tx.type !== 'mulligan')
        .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      const addedViaTransaction = new Set(processedTx.map(tx => tx.player).filter(Boolean));
      const droppedViaTransaction = new Set(processedTx.map(tx => tx.droppedPlayer).filter(Boolean));
      let roster = team.roster.filter(p => !addedViaTransaction.has(p.name) && !droppedViaTransaction.has(p.name));
      processedTx.forEach(tx => {
        if (tx.droppedPlayer) roster = roster.filter(p => p.name !== tx.droppedPlayer);
        if (tx.player && !roster.some(p => p.name === tx.player)) {
          const existing = team.roster.find(p => p.name === tx.player);
          roster.push(existing || { name: tx.player, limited: false, unlimited: false, stars: 0, starts: 0, eventsPlayed: 0, cutsMade: 0, pgaTourEarnings: 0, sfglEarnings: 0, headshot: '' });
        }
      });
      return { ...team, roster };
    });
    updateTeams(updatedTeams);
    await storage.set(STORAGE_KEYS.TEAMS, updatedTeams);
    dialog.showToast('Rosters synced from transaction history', 'success');
  };

  // ── Waiver processing helpers ────────────────────────────────────────────
  const buildEffectiveRoster = (team) => {
    let roster = team.roster.map(p => p.name);
    transactions
      .filter(tx => tx.team === team.name && tx.status === 'processed' && tx.type !== 'mulligan')
      .forEach(tx => {
        if (tx.droppedPlayer) roster = roster.filter(n => n !== tx.droppedPlayer);
        if (!roster.includes(tx.player)) roster.push(tx.player);
      });
    return new Set(roster);
  };

  const applyWaiverToTeam = (t, waiver) => {
    if (t.name !== waiver.team) return t;
    let newRoster = [...t.roster];
    if (waiver.droppedPlayer) newRoster = newRoster.filter(p => p.name !== waiver.droppedPlayer);
    if (!newRoster.some(p => p.name === waiver.player)) {
      newRoster.push({ name: waiver.player, limited: false, unlimited: false, stars: 0, starts: 0, eventsPlayed: 0, cutsMade: 0, pgaTourEarnings: 0, sfglEarnings: 0, headshot: '' });
    }
    return { ...t, roster: newRoster };
  };

  const handleProcessSingleWaiver = async (waiver) => {
    const allRostered = new Set();
    teams.forEach(t => buildEffectiveRoster(t).forEach(n => allRostered.add(n)));
    if (allRostered.has(waiver.player)) {
      dialog.showToast(waiver.player + ' already rostered', 'error'); return;
    }
    if (waiver.droppedPlayer) {
      const teamRoster = buildEffectiveRoster(teams.find(t => t.name === waiver.team) || {});
      if (!teamRoster.has(waiver.droppedPlayer)) {
        const updatedTx = transactions.map((tx, i) =>
          i === waiver._idx ? { ...tx, status: 'failed', failReason: waiver.droppedPlayer + ' already dropped', processedDate: new Date().toLocaleDateString() } : tx
        );
        setTransactions(updatedTx);
        await storage.set(STORAGE_KEYS.TRANSACTIONS, updatedTx);
        dialog.showToast(waiver.droppedPlayer + ' already dropped - claim failed', 'error'); return;
      }
    }
    const updatedTx = transactions.map((tx, i) =>
      i === waiver._idx ? { ...tx, status: 'processed', processedDate: new Date().toLocaleDateString() } : tx
    );
    const updatedTeams = teams.map(t => applyWaiverToTeam(t, waiver));
    setTransactions(updatedTx);
    updateTeams(updatedTeams);
    await storage.set(STORAGE_KEYS.TRANSACTIONS, updatedTx);
    await storage.set(STORAGE_KEYS.TEAMS, updatedTeams);
    dialog.showToast('Processed: ' + waiver.team + ' adds ' + waiver.player + (waiver.droppedPlayer ? ' / drops ' + waiver.droppedPlayer : ''), 'success');
  };

  const handleProcessAllWaivers = async (allPendingWaivers) => {
    if (allPendingWaivers.length === 0) return;
    const ok = await dialog.showConfirm(
      'Process All Waivers',
      'Process ' + allPendingWaivers.length + ' pending waiver claim' + (allPendingWaivers.length !== 1 ? 's' : '') + '?\n\nTie-breaker: reverse standings order (lowest season earnings = highest priority).',
      { confirmText: 'Process ' + allPendingWaivers.length + ' Waiver' + (allPendingWaivers.length !== 1 ? 's' : '') }
    );
    if (!ok) return;
    const standingsOrder = [...teams].sort((a, b) => (a.earnings || 0) - (b.earnings || 0));
    const teamPriorityMap = {};
    standingsOrder.forEach((t, i) => { teamPriorityMap[t.name] = i; });
    const waiversByTeam = {};
    allPendingWaivers.forEach(w => {
      if (!waiversByTeam[w.team]) waiversByTeam[w.team] = [];
      waiversByTeam[w.team].push(w);
    });
    Object.values(waiversByTeam).forEach(claims => claims.sort((a, b) => (a.priority || 999) - (b.priority || 999)));
    const allRostered = new Set();
    teams.forEach(t => buildEffectiveRoster(t).forEach(n => allRostered.add(n)));
    const alreadyDropped = new Set();
    let processedCount = 0, failedCount = 0;
    const updatedTx = [...transactions];
    const processedIdxs = new Set(), failedIdxs = new Set();
    let appliedWaivers = [];
    let moreToProcess = true;
    while (moreToProcess) {
      moreToProcess = false;
      const roundClaims = [];
      Object.entries(waiversByTeam).forEach(([teamName, claims]) => {
        const top = claims.find(c => !processedIdxs.has(c._idx) && !failedIdxs.has(c._idx));
        if (top) roundClaims.push({ teamName, claim: top, waiverOrder: teamPriorityMap[teamName] ?? 999 });
      });
      if (roundClaims.length === 0) break;
      const byPlayer = {};
      roundClaims.forEach(rc => {
        if (!byPlayer[rc.claim.player]) byPlayer[rc.claim.player] = [];
        byPlayer[rc.claim.player].push(rc);
      });
      Object.entries(byPlayer).forEach(([playerName, contestants]) => {
        contestants.sort((a, b) => a.waiverOrder - b.waiverOrder);
        const winner = contestants[0];
        if (allRostered.has(playerName)) {
          contestants.forEach(c => {
            failedIdxs.add(c.claim._idx);
            updatedTx[c.claim._idx] = { ...updatedTx[c.claim._idx], status: 'failed', failReason: 'Player already rostered', processedDate: new Date().toLocaleDateString() };
            failedCount++;
          });
          moreToProcess = true; return;
        }
        if (winner.claim.droppedPlayer && (alreadyDropped.has(winner.claim.droppedPlayer) || !allRostered.has(winner.claim.droppedPlayer))) {
          failedIdxs.add(winner.claim._idx);
          updatedTx[winner.claim._idx] = { ...updatedTx[winner.claim._idx], status: 'failed', failReason: winner.claim.droppedPlayer + ' already dropped', processedDate: new Date().toLocaleDateString() };
          failedCount++; moreToProcess = true; return;
        }
        if (winner.claim.droppedPlayer) { allRostered.delete(winner.claim.droppedPlayer); alreadyDropped.add(winner.claim.droppedPlayer); }
        allRostered.add(playerName);
        processedIdxs.add(winner.claim._idx);
        updatedTx[winner.claim._idx] = { ...updatedTx[winner.claim._idx], status: 'processed', processedDate: new Date().toLocaleDateString() };
        appliedWaivers.push(winner.claim);
        processedCount++;
        contestants.slice(1).forEach(loser => {
          failedIdxs.add(loser.claim._idx);
          updatedTx[loser.claim._idx] = { ...updatedTx[loser.claim._idx], status: 'failed', failReason: 'Lost tiebreaker to ' + winner.teamName, processedDate: new Date().toLocaleDateString() };
          failedCount++;
        });
        moreToProcess = true;
      });
    }
    let updatedTeams = [...teams];
    appliedWaivers.forEach(waiver => { updatedTeams = updatedTeams.map(t => applyWaiverToTeam(t, waiver)); });
    setTransactions(updatedTx);
    updateTeams(updatedTeams);
    await storage.set(STORAGE_KEYS.TRANSACTIONS, updatedTx);
    await storage.set(STORAGE_KEYS.TEAMS, updatedTeams);
    dialog.showToast('Processed ' + processedCount + ' waiver' + (processedCount !== 1 ? 's' : '') + (failedCount > 0 ? ' - ' + failedCount + ' failed' : ''), processedCount > 0 ? 'success' : 'error');
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

      {/* Process Waivers */}
      {(() => {
        const allPendingWaivers = transactions
          .map((tx, idx) => ({ ...tx, _idx: idx }))
          .filter(tx => tx.type === 'waiver' && tx.status === 'pending');
        return (
          <div className="bg-yellow-900/20 border border-yellow-700/50 p-4 rounded-xl">
            <h3 className="font-bold text-yellow-400 flex items-center gap-2 mb-3">⏰ Process Waivers</h3>
            {allPendingWaivers.length === 0 ? (
              <div className="text-center py-4 text-green-400 text-sm">✅ No pending waiver claims</div>
            ) : (
              <>
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm text-yellow-300 font-semibold">{allPendingWaivers.length} pending claim{allPendingWaivers.length !== 1 ? 's' : ''}</span>
                  <button onClick={() => handleProcessAllWaivers(allPendingWaivers)}
                    className="px-3 py-1.5 bg-yellow-600/30 hover:bg-yellow-600/50 border border-yellow-500/40 rounded-lg text-xs font-bold text-yellow-300 transition-colors">
                    ⚡ Process All ({allPendingWaivers.length})
                  </button>
                </div>
                <div className="space-y-2">
                  {allPendingWaivers.map(waiver => (
                    <div key={waiver._idx} className="flex items-center gap-2 bg-gray-900/50 border border-gray-700/50 rounded-lg px-3 py-2">
                      <div className="w-6 h-6 rounded-full bg-yellow-900/50 border border-yellow-600/40 flex items-center justify-center text-yellow-300 text-xs font-bold flex-shrink-0">
                        {waiver.priority || '?'}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold text-white">{waiver.team}</span>
                          <span className="text-xs text-green-400">+ {waiver.player}</span>
                          {waiver.droppedPlayer && <span className="text-xs text-red-400">- {waiver.droppedPlayer}</span>}
                        </div>
                        <div className="text-xs text-gray-500">{waiver.date} · {waiver.segment || 'West Coast Swing'}</div>
                      </div>
                      <button onClick={() => handleProcessSingleWaiver(waiver)}
                        className="flex-shrink-0 px-2.5 py-1 bg-green-700/30 hover:bg-green-700/50 border border-green-600/40 rounded text-xs font-bold text-green-300 transition-colors">
                        Process
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        );
      })()}

      {/* Individual Manager Login Setup */}
      <div className="bg-blue-900/20 border border-blue-700/30 p-4 rounded-xl">
        <h3 className="font-bold text-blue-400 flex items-center gap-2 mb-3">🔑 Set Manager Login</h3>
        <div className="space-y-2">
          <div>
            <label className="text-xs font-bold text-gray-400 block mb-1">Team</label>
            <select value={mgCredTeam} onChange={e => { setMgCredTeam(e.target.value); const t = teams.find(x => x.id === e.target.value); setMgCredName(t?.owner || ''); }}
              className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-sm">
              <option value="">— Select Team —</option>
              {teams.map(t => <option key={t.id} value={t.id}>{t.name} ({t.owner})</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-bold text-gray-400 block mb-1">Login Name</label>
            <input value={mgCredName} onChange={e => setMgCredName(e.target.value)} placeholder="manager name"
              className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="text-xs font-bold text-gray-400 block mb-1">Password</label>
            <input type="password" value={mgCredPass} onChange={e => setMgCredPass(e.target.value)} placeholder="password"
              className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-sm" />
          </div>
          <button onClick={handleSetManagerCredentials} disabled={mgCredSaving || !mgCredTeam || !mgCredName || !mgCredPass}
            className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-sm font-bold transition-colors">
            {mgCredSaving ? 'Saving...' : 'Set Login'}
          </button>
        </div>
      </div>

      {/* Backup & Restore */}
      <div className="bg-gray-800/50 border border-gray-700 p-4 rounded-xl">
        <h3 className="font-bold text-gray-300 mb-3 flex items-center gap-2">💾 Backup &amp; Restore</h3>
        <div className="flex gap-2 mb-2">
          <button onClick={handleExport} className="flex-1 py-2 bg-gray-600 hover:bg-gray-500 rounded-lg text-sm font-bold transition-colors">
            Export JSON
          </button>
          <label className="flex-1 py-2 bg-gray-600 hover:bg-gray-500 rounded-lg text-sm font-bold transition-colors text-center cursor-pointer">
            Import JSON
            <input type="file" accept=".json" onChange={handleImport} className="hidden" />
          </label>
        </div>
        <button onClick={handlePushToSupabase} className="w-full py-2.5 mb-2 bg-green-800/40 hover:bg-green-700/50 border border-green-600/40 rounded-lg text-sm font-bold text-green-300 transition-colors">
          ☁️ Push Current Data to Supabase (sync all devices)
        </button>
        <button onClick={async () => {
          dialog.showToast('Re-fetching results...', 'info');
          try {
            const supabaseResults = await tournamentResultsApi.getAllForSeason();
            if (!supabaseResults || supabaseResults.length === 0) { dialog.showToast('No results found in Supabase', 'error'); return; }
            setTournaments(prev => prev.map(t => {
              const remote = supabaseResults.find(r => r.tournamentName === t.name);
              if (!remote) return t;
              return { ...t, completed: true, results: remote.results };
            }));
            dialog.showToast('Results refreshed (' + supabaseResults.length + ' tournaments)', 'success');
          } catch (e) { dialog.showToast('Fetch failed: ' + e.message, 'error'); }
        }} className="w-full py-2 mb-2 bg-blue-800/30 hover:bg-blue-700/40 border border-blue-600/30 rounded-lg text-sm font-bold text-blue-300 transition-colors">
          🔄 Re-fetch Results from Supabase
        </button>
        <button onClick={handleRepairRosterFlags} className="w-full py-2 mb-2 bg-gray-700/50 hover:bg-gray-600/50 rounded-lg text-sm font-bold text-gray-300 transition-colors">
          🔧 Repair Roster Flags (Limited / Unlimited)
        </button>
        <button onClick={handleSyncRostersFromTransactions} className="w-full py-2 bg-gray-700/50 hover:bg-gray-600/50 rounded-lg text-sm font-bold text-gray-300 transition-colors">
          🔄 Sync Rosters from Transactions (fix add/drop drift)
        </button>
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
