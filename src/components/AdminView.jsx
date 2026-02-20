import React, { useState, useEffect } from 'react';
import { Settings, X } from 'lucide-react';
import { useDialog } from './DialogContext';
import { slashGolfFetch, processTournamentData, makePlayer, resolvePlayerName } from '../utils';
import { PGA_TOUR_IDS, FALLBACK_SCHEDULE_DATA, LIV_GOLF_ROSTER } from '../constants';
import { storage, draftStateApi } from '../api';
import { ScheduleImportModal } from './ScheduleImportModal';
import { DraftModal } from './DraftModal';
import { managerAuthApi, tournamentResultsApi, teamsApi, tournamentsApi } from '../api/supabase';
import { theme, colors, fonts } from '../theme.js';

if (typeof window !== 'undefined') {
  window.resolvePlayerName = resolvePlayerName;
}

// ── Shared section wrapper ────────────────────────────────────────────────────
const Section = ({ children, style }) => (
  <div style={{ ...theme.card, ...style }}>{children}</div>
);

const SectionHeader = ({ icon, title, color }) => (
  <div style={theme.cardHeader}>
    <span style={{ fontSize: 15 }}>{icon}</span>
    <h3 style={{ ...theme.h2, color: color || colors.sectionHeaderBlue }}>{title}</h3>
  </div>
);

const SectionBody = ({ children }) => (
  <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
    {children}
  </div>
);

// ── Themed button ─────────────────────────────────────────────────────────────
const Btn = ({ onClick, children, variant = 'primary', style, disabled, title }) => {
  const base = variant === 'danger'    ? theme.btnDanger
             : variant === 'secondary' ? theme.btnSecondary
             : { ...theme.btnPrimary, background: colors.actionButtonBlue, border: `1px solid rgba(100,160,255,0.2)` };
  return (
    <button onClick={onClick} disabled={disabled} title={title} style={{
      ...base, width: '100%', padding: '10px 16px',
      opacity: disabled ? 0.45 : 1, ...style,
    }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.opacity = '0.8'; }}
      onMouseLeave={e => { e.currentTarget.style.opacity = disabled ? '0.45' : '1'; }}
    >
      {children}
    </button>
  );
};

const FieldLabel = ({ children }) => (
  <label style={{ ...theme.label, display: 'block', marginBottom: 6 }}>{children}</label>
);

const ThemedInput = ({ value, onChange, placeholder, type = 'text', onKeyPress, autoFocus, style }) => (
  <input type={type} value={value} onChange={onChange}
    placeholder={placeholder} onKeyPress={onKeyPress} autoFocus={autoFocus}
    style={{ ...theme.input, ...style }}
    onFocus={e => { e.target.style.borderColor = colors.borderFocus; e.target.style.background = colors.inputBgFocus; }}
    onBlur={e => { e.target.style.borderColor = colors.borderInput; e.target.style.background = colors.inputBg; }}
  />
);

const ThemedSelect = ({ value, onChange, children, style }) => (
  <select value={value} onChange={onChange}
    className="sfgl-admin-select"
    style={{ ...theme.select, colorScheme: 'dark', ...style }}
    onFocus={e => { e.target.style.borderColor = colors.borderFocus; }}
    onBlur={e => { e.target.style.borderColor = colors.borderInput; }}
  >
    {children}
  </select>
);

const Modal = ({ title, onClose, children, borderColor }) => (
  <div style={{
    position: 'fixed', inset: 0,
    background: 'rgba(5,10,25,0.85)', backdropFilter: 'blur(4px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 16, zIndex: 50,
  }}>
    <div style={{
      background: '#0d1e38',
      border: `1px solid ${borderColor || colors.border}`,
      borderRadius: 3, padding: 28,
      maxWidth: 480, width: '100%',
      maxHeight: '85vh', overflowY: 'auto',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h3 style={theme.h2}>{title}</h3>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.textSecondary }}>
          <X style={{ width: 18, height: 18 }} />
        </button>
      </div>
      {children}
    </div>
  </div>
);

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
  const [showScheduleImporter, setShowScheduleImporter]           = useState(false);
  const [showDraftModal, setShowDraftModal]                       = useState(false);
  const [rosterMgmtTeam, setRosterMgmtTeam]                       = useState('');
  const [playerSearch, setPlayerSearch]                           = useState('');
  const [owgrLastSynced, setOwgrLastSynced]                       = useState(null);
  const [showPlayerIdInput, setShowPlayerIdInput]                 = useState(false);
  const [playerIdSearch, setPlayerIdSearch]                       = useState('');
  const [playerIdValue, setPlayerIdValue]                         = useState('');
  const [showLivManager, setShowLivManager]                       = useState(false);
  const [livRoster, setLivRoster]                                 = useState([]);
  const [livPlayerInput, setLivPlayerInput]                       = useState('');
  const [hasSavedDraft, setHasSavedDraft]                         = useState(false);
  const [draftInitialPhase, setDraftInitialPhase]                 = useState('resume_prompt');
  const [manualEntry, setManualEntry]                             = useState({ round1Leaders: [''], round2Leaders: [''], round3Leaders: [''], playerEarnings: '' });
  const [manualEntryOpen, setManualEntryOpen]                     = useState(false);
  const [historyTourney, setHistoryTourney]                       = useState('');
  const [historyData, setHistoryData]                             = useState(null);  // loaded from Supabase
  const [historyLoading, setHistoryLoading]                       = useState(false);
  const [historyEdits, setHistoryEdits]                           = useState({});    // { [teamId]: [playerName, ...] }
  const dialog = useDialog();
  const activeTournament = tournaments.find(t => t.playing);

  useEffect(() => {
    const checkSavedDraft = async () => {
      try {
        const saved = await draftStateApi.get();
        setHasSavedDraft(!!(saved && saved.draft_order?.length === teams.length && saved.phase !== 'order'));
      } catch { setHasSavedDraft(false); }
    };
    checkSavedDraft();
  }, []);

  useEffect(() => {
    const loadTimestamp = async () => {
      try {
        const timestamp = await storage.get(STORAGE_KEYS.OWGR_LAST_SYNCED);
        if (timestamp) setOwgrLastSynced(parseInt(timestamp));
      } catch (e) { console.error('Failed to load OWGR timestamp:', e); }
    };
    loadTimestamp();
  }, [STORAGE_KEYS.OWGR_LAST_SYNCED]);

  useEffect(() => {
    if (!selectedTourneyForResults && activeTournament) {
      setSelectedTourneyForResults(activeTournament.name);
    }
  }, [activeTournament, selectedTourneyForResults]);

  const handleExport = () => {
    const data = { teams, tournaments, transactions, settings, globalPlayerStats, headshots };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `sfgl-backup-${new Date().toISOString().split('T')[0]}.json`; a.click();
    URL.revokeObjectURL(url);
    dialog.showToast('Data exported successfully', 'success');
  };

  const handleImport = (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const data = JSON.parse(event.target.result);
        if (data.teams)             updateTeams(data.teams);
        if (data.tournaments)       setTournaments(data.tournaments);
        if (data.transactions)      setTransactions(data.transactions);
        if (data.settings)        { setSettings(data.settings); await storage.set(STORAGE_KEYS.SETTINGS, data.settings); }
        if (data.globalPlayerStats){ setGlobalPlayerStats(data.globalPlayerStats); await storage.set(STORAGE_KEYS.GLOBAL_PLAYER_STATS, data.globalPlayerStats); }
        if (data.headshots)       { setHeadshots(data.headshots); await storage.set(STORAGE_KEYS.HEADSHOTS, data.headshots); }
        dialog.showToast('Data imported successfully!', 'success');
      } catch { dialog.showToast('Failed to parse backup file.', 'error'); }
    };
    reader.readAsText(file); e.target.value = null;
  };

  const handleImportSchedule = (importedTournaments) => {
    setTournaments(importedTournaments); setShowScheduleImporter(false);
    dialog.showToast(`Imported ${importedTournaments.length} tournaments!`, 'success');
  };

  const handleFetchApiResults = async () => {
    if (!selectedTourneyForResults) { dialog.showToast('Please select a tournament first', 'error'); return; }
    const tournIndex = tournaments.findIndex(t => t.name === selectedTourneyForResults);
    if (tournIndex === -1) return;
    const t = tournaments[tournIndex];
    if (!t.slashGolfId) { dialog.showToast('No API ID found. Import 2026 Schedule first.', 'error'); return; }
    if (t.completed) {
      const ok = await dialog.showConfirm('Already Processed', 'This tournament was already processed. Re-fetching will OVERWRITE the existing results and recalculate all earnings from scratch.\n\nAre you sure?', { type: 'danger', confirmText: 'Force Re-Fetch' });
      if (!ok) return;
    }
    try {
      dialog.showToast(`Fetching leaderboard for ${t.name}...`, 'info');
      let data = await slashGolfFetch('leaderboard', { tournId: t.slashGolfId, year: '2026' });
      let apiPlayers = data.leaderboardRows || data.leaderboard || data.results || [];
      if (apiPlayers.length === 0) { dialog.showToast('No results found in API yet.', 'error'); return; }
      try {
        const earningsData = await slashGolfFetch('earnings', { tournId: t.slashGolfId, year: '2026' });
        const earningsPlayers = earningsData.leaderboard || earningsData.earnings || earningsData.results || [];
        if (earningsPlayers.length > 0) apiPlayers = apiPlayers.map(lp => { const ep = earningsPlayers.find(e => e.playerId === lp.playerId); return { ...lp, earnings: ep?.earnings || 0 }; });
      } catch (e) { console.log('Earnings endpoint not available:', e.message); }
      const rosteredNames = teams.flatMap(team => team.roster.map(p => p.name));
      const { fullLineups, rosterSnapshots } = buildSnapshots(tournIndex);
      const { newTeams, newStats, resultsData } = processTournamentData(t, apiPlayers, teams, globalPlayerStats, rosteredNames);
      const nextIdx = tournaments.findIndex((nt, idx) => idx > tournIndex && !nt.completed && !nt.isAlternate);
      const newTournaments = tournaments.map((nt, idx) => {
        if (idx === tournIndex) return { ...nt, completed: true, playing: false, results: resultsData };
        if (nextIdx !== -1 && idx === nextIdx) return { ...nt, playing: true };
        return { ...nt, playing: false };
      });
      updateTeams(newTeams); setGlobalPlayerStats(newStats); setTournaments(newTournaments);
      // Persist to Supabase so all managers see results
      try {
        await tournamentResultsApi.save({
          tournamentName: t.name,
          teamResults: resultsData.teams,
          earningsMap: resultsData.earningsMap,
          roundLeaders: t.roundLeaders || {},
          fullLineups,
          rosterSnapshots,
          isManualEntry: false,
        });
      } catch (e) { console.warn('Supabase tournament_results save failed (non-fatal):', e.message); }
      // Explicitly persist teams and tournament state to Supabase
      try {
        await teamsApi.setAll(newTeams);
      } catch (e) { console.warn('Supabase teams save failed (non-fatal):', e.message); }
      try {
        await tournamentsApi.update(t.name, { completed: true, playing: false });
        if (nextIdx !== -1) {
          await tournamentsApi.update(newTournaments[nextIdx].name, { playing: true });
        }
      } catch (e) { console.warn('Supabase tournaments save failed (non-fatal):', e.message); }
      dialog.showToast(`Results processed for ${t.name}!`, 'success');
    } catch (error) { console.error('Results Sync Error:', error); dialog.showToast(`API Error: ${error.message}`, 'error'); }
  };

  const handleManualEntry = async () => {
    if (!selectedTourneyForResults) { dialog.showToast('Select a tournament first', 'error'); return; }
    const tournIndex = tournaments.findIndex(t => t.name === selectedTourneyForResults);
    if (tournIndex === -1) return;
    const tournament = tournaments[tournIndex];

    if (tournament.completed) {
      const ok = await dialog.showConfirm('Already Processed', 'This tournament was already processed. Re-processing will OVERWRITE the existing results and recalculate all earnings from scratch.\n\nAre you sure?', { type: 'danger', confirmText: 'Process Anyway' });
      if (!ok) return;
    }

    // ── 1. Parse earnings textarea → plain object { playerName: earnings }
    const earningsMap = {};
    manualEntry.playerEarnings.split('\n').forEach(line => {
      const match = line.match(/^(.+?),\s*([\d,]+)$/);
      if (match) {
        const name = match[1].trim();
        const earnings = parseInt(match[2].replace(/,/g, '').trim());
        if (name && !isNaN(earnings)) earningsMap[name] = earnings;
      }
    });
    if (Object.keys(earningsMap).length === 0) {
      dialog.showToast('No valid entries. Format: Player Name, 123456', 'error'); return;
    }

    // ── 2. Name normalisation helpers (mirrors utils) ─────────────────────
    const CHAR_MAP = { 'ø':'o','ö':'o','ó':'o','ô':'o','õ':'o','å':'a','ä':'a','á':'a','à':'a','â':'a','ã':'a','ü':'u','ú':'u','ù':'u','û':'u','é':'e','è':'e','ê':'e','ë':'e','í':'i','ì':'i','î':'i','ï':'i','ñ':'n','ç':'c','ß':'ss' };
    const normName = (n) => {
      if (!n) return '';
      let s = n.toLowerCase().trim();
      Object.keys(CHAR_MAP).forEach(c => { s = s.split(c).join(CHAR_MAP[c]); });
      return s.replace(/[.-]/g, ' ').replace(/\s+/g, ' ').trim();
    };
    const matchNames = (a, b) => {
      const na = normName(a), nb = normName(b);
      if (na === nb) return true;
      const wa = na.split(' '), wb = nb.split(' ');
      return wa.length === wb.length && wa.every(w => wb.includes(w));
    };
    // Lookup earnings with fuzzy name matching
    const getEarnings = (playerName) => {
      if (earningsMap[playerName] !== undefined) return earningsMap[playerName];
      const key = Object.keys(earningsMap).find(k => matchNames(k, playerName));
      return key !== undefined ? earningsMap[key] : 0;
    };

    // ── 3. Round leaders & bonuses ─────────────────────────────────────────
    const roundLeaders = {
      round1: manualEntry.round1Leaders.filter(l => l.trim()),
      round2: manualEntry.round2Leaders.filter(l => l.trim()),
      round3: manualEntry.round3Leaders.filter(l => l.trim()),
    };
    const BONUSES = tournament.isMajor
      ? { round1: 40000, round2: 80000, round3: 120000 }
      : { round1: 20000, round2: 40000, round3: 60000 };

    // ── 4. Snapshot lineups & rosters BEFORE any mutations ─────────────────
    const { fullLineups, rosterSnapshots } = buildSnapshots(tournIndex);

    // ── 5. Calculate per-team results ──────────────────────────────────────
    const tournamentResults = { teams: {}, earningsMap: { ...earningsMap } };
    const updatedGlobalStats = { ...globalPlayerStats };

    // Update global stats for every player with earnings
    Object.entries(earningsMap).forEach(([playerName, earnings]) => {
      if (!updatedGlobalStats[playerName]) updatedGlobalStats[playerName] = { eventsPlayed: 0, cutsMade: 0, pgaTourEarnings: 0 };
      updatedGlobalStats[playerName] = {
        ...updatedGlobalStats[playerName],
        eventsPlayed: updatedGlobalStats[playerName].eventsPlayed + 1,
        cutsMade: updatedGlobalStats[playerName].cutsMade + (earnings > 0 ? 1 : 0),
        pgaTourEarnings: updatedGlobalStats[playerName].pgaTourEarnings + earnings,
      };
    });

    const updatedTeams = teams.map(team => {
      const rosterAtTime = getRosterAtTournament(team, tournIndex);

      // Score each starter
      const starterResults = team.lineup.map(playerName => {
        const earnings = getEarnings(playerName);
        const player = rosterAtTime.find(p => p.name === playerName) || rosterAtTime.find(p => matchNames(p.name, playerName));
        return { player, playerName, earnings };
      });

      // Best 5 (or fewer if lineup is short)
      const topStarters = [...starterResults].sort((a, b) => b.earnings - a.earnings).slice(0, 5);
      let totalEarnings = topStarters.reduce((sum, s) => sum + s.earnings, 0);
      const bonusEarnings = { round1: 0, round2: 0, round3: 0 };
      const playersWithBonuses = {};

      // Round leader bonuses
      ['round1', 'round2', 'round3'].forEach(round => {
        (roundLeaders[round] || []).forEach(leaderName => {
          if (!leaderName) return;
          const actualName = team.lineup.find(pn => normName(pn) === normName(leaderName));
          if (actualName) {
            bonusEarnings[round] = BONUSES[round];
            totalEarnings += BONUSES[round];
            if (!playersWithBonuses[actualName]) playersWithBonuses[actualName] = { total: 0, rounds: [] };
            playersWithBonuses[actualName].total += BONUSES[round];
            playersWithBonuses[actualName].rounds.push({ round: round.replace('round', ''), bonus: BONUSES[round] });
          }
        });
      });

      tournamentResults.teams[team.id] = {
        totalEarnings,
        bonuses: bonusEarnings,
        players: topStarters.map(s => ({
          name: s.playerName,
          earnings: s.earnings,
          limited: s.player?.limited || false,
          bonus: playersWithBonuses[s.playerName]?.total || 0,
          roundsLed: playersWithBonuses[s.playerName]?.rounds || [],
          wasRoundLeader: (playersWithBonuses[s.playerName]?.total || 0) > 0,
        })),
      };

      // Update roster starts + sfglEarnings
      const updatedRoster = team.roster.map(player => {
        if (team.lineup.includes(player.name)) {
          const pe = getEarnings(player.name);
          return { ...player, starts: player.starts + 1, sfglEarnings: (player.sfglEarnings || 0) + pe };
        }
        return player;
      });

      return {
        ...team,
        roster: updatedRoster,
        earnings: team.earnings + totalEarnings,
        segmentEarnings: (team.segmentEarnings || 0) + totalEarnings,
        lineup: [],
      };
    });

    // ── 6. Advance tournaments ─────────────────────────────────────────────
    // Find the next non-completed, non-alternate tournament to mark as playing
    const nextIdx = tournaments.findIndex((nt, idx) => idx > tournIndex && !nt.completed && !nt.isAlternate);
    const newTournaments = tournaments.map((nt, idx) => {
      if (idx === tournIndex) return { ...nt, completed: true, playing: false, results: tournamentResults };
      if (nextIdx !== -1 && idx === nextIdx) return { ...nt, playing: true };
      // Clear playing from any other tournament (including previously active ones)
      return { ...nt, playing: false };
    });

    updateTeams(updatedTeams);
    setGlobalPlayerStats(updatedGlobalStats);
    setTournaments(newTournaments);

    // ── 7. Persist to Supabase ─────────────────────────────────────────────
    try {
      await tournamentResultsApi.save({
        tournamentName: selectedTourneyForResults,
        teamResults: tournamentResults.teams,
        earningsMap: tournamentResults.earningsMap,
        roundLeaders,
        fullLineups,
        rosterSnapshots,
        isManualEntry: true,
      });
    } catch (e) { console.warn('Supabase tournament_results save failed (non-fatal):', e.message); }

    // Explicitly persist teams (earnings, roster stats) and tournament completion
    // to Supabase so all managers see updated standings immediately — don't rely
    // on updateTeams/setTournaments hooks which may only write locally.
    try {
      await teamsApi.setAll(updatedTeams);
    } catch (e) { console.warn('Supabase teams save failed (non-fatal):', e.message); }
    try {
      const completedTourn = newTournaments[tournIndex];
      await tournamentsApi.update(completedTourn.name, { completed: true, playing: false });
      if (nextIdx !== -1) {
        await tournamentsApi.update(newTournaments[nextIdx].name, { playing: true });
      }
    } catch (e) { console.warn('Supabase tournaments save failed (non-fatal):', e.message); }

    dialog.showToast(`Processed ${Object.keys(earningsMap).length} players for ${selectedTourneyForResults}!`, 'success');
    setManualEntry({ round1Leaders: [''], round2Leaders: [''], round3Leaders: [''], playerEarnings: '' });
    setManualEntryOpen(false);
  };

  // ── Roster reconstruction (mirrors utils getRosterForTournament) ──────────
  // Replays transactions up to tournamentIndex to get the roster as it existed
  // during that tournament week, regardless of subsequent adds/drops.
  const getRosterAtTournament = (team, tournamentIndex) => {
    let roster = [...team.roster];
    const relevant = transactions
      .filter(tx => tx.team === team.name && tx.tournamentIndex !== undefined && tx.tournamentIndex <= tournamentIndex && tx.status !== 'pending')
      .sort((a, b) => a.tournamentIndex - b.tournamentIndex);
    relevant.forEach(tx => {
      if (tx.droppedPlayer) roster = roster.filter(p => p.name !== tx.droppedPlayer);
      if (tx.player && !roster.some(p => p.name === tx.player)) roster.push(makePlayer(tx.player));
    });
    return roster;
  };

  // ── Build lineup/roster snapshots before processing ─────────────────────
  // Call this immediately before processTournamentData so we capture the
  // state of every team's lineup and roster at the moment of processing,
  // before the lineup is cleared and before future adds/drops overwrite the roster.
  const buildSnapshots = (tournIndex) => {
    const fullLineups = {};
    const rosterSnapshots = {};
    teams.forEach(team => {
      fullLineups[team.id] = [...(team.lineup || [])];
      try {
        rosterSnapshots[team.id] = getRosterAtTournament(team, tournIndex);
      } catch {
        rosterSnapshots[team.id] = [...team.roster];
      }
    });
    return { fullLineups, rosterSnapshots };
  };

  // ── Load historical lineup data from Supabase ──────────────────────────────
  const handleLoadHistory = async () => {
    if (!historyTourney) return;
    setHistoryLoading(true); setHistoryData(null); setHistoryEdits({});
    try {
      const data = await tournamentResultsApi.getByName(historyTourney);
      if (!data) { dialog.showToast('No Supabase record for this tournament yet', 'error'); setHistoryLoading(false); return; }
      setHistoryData(data);
      // Pre-populate edits with the saved lineups
      const edits = {};
      Object.entries(data.fullLineups || {}).forEach(([teamId, lineup]) => { edits[teamId] = [...lineup]; });
      setHistoryEdits(edits);
    } catch (e) { dialog.showToast(`Failed to load: ${e.message}`, 'error'); }
    setHistoryLoading(false);
  };

  // ── Save corrected lineups back to Supabase (no reprocessing) ─────────────
  // For a full re-process, the commissioner uses the main "Enter Results" section.
  const handleSaveHistoryEdits = async () => {
    if (!historyData) return;
    const ok = await dialog.showConfirm(
      'Save Corrected Lineups',
      'Save these corrected lineups to the historical record?\n\nThis updates the Supabase snapshot only — it does NOT recalculate earnings or update standings. To recalculate, use the main results section.',
      { confirmText: 'Save Lineup Record' }
    );
    if (!ok) return;
    try {
      await tournamentResultsApi.save({
        tournamentName: historyData.tournamentName,
        teamResults: historyData.teamResults,
        earningsMap: historyData.earningsMap,
        roundLeaders: historyData.roundLeaders,
        fullLineups: historyEdits,
        rosterSnapshots: historyData.rosterSnapshots,
        isManualEntry: historyData.isManualEntry,
      });
      setHistoryData({ ...historyData, fullLineups: historyEdits });
      dialog.showToast('✓ Corrected lineups saved to history', 'success');
    } catch (e) { dialog.showToast(`Save failed: ${e.message}`, 'error'); }
  };

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
      const csvPlayers = []; const resolvedNames = new Set();
      for (const line of lines) {
        if (!line.trim()) continue;
        const match = line.match(/(?:^|,)("(?:[^"]+|"")*"|[^,]*)/g);
        if (!match || match.length < 7) continue;
        const fields = match.map(f => f.replace(/^,?"?|"?$/g, '').replace(/""/g, '"'));
        const rank = parseInt(fields[1]) || 999; const csvName = fields[5]?.trim(); if (!csvName) continue;
        const resolvedName = window.resolvePlayerName(csvName, knownNames);
        const finalName = resolvedName || csvName;
        if (resolvedNames.has(finalName) || livPlayers.has(finalName) || csvPlayers.length >= 250) continue;
        csvPlayers.push({ name: finalName, worldRank: rank, pgaTourId: PGA_TOUR_IDS[finalName] || null });
        resolvedNames.add(finalName);
        if (resolvedName && resolvedName !== csvName) console.log(`Resolved: "${csvName}" → "${resolvedName}"`);
      }
      if (csvPlayers.length > 0) {
        const now = Date.now();
        await storage.set(STORAGE_KEYS.OWGR_LAST_SYNCED, now.toString()); setOwgrLastSynced(now);
        updateRankings(csvPlayers);
        dialog.showToast(`✓ Loaded ${csvPlayers.length} players from CSV!`, 'success');
      } else { dialog.showToast('No valid players found in CSV', 'error'); }
    } catch (err) { dialog.showToast(`Failed to parse CSV: ${err.message}`, 'error'); }
  };

  const handleSyncCsv = async () => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.csv';
    input.onchange = async (e) => await handleCsvUpload(e.target.files[0]); input.click();
  };

  const handleSyncPlayers = async () => {
    const now = Date.now(); const sevenDays = 7 * 24 * 60 * 60 * 1000;
    if (owgrLastSynced && (now - owgrLastSynced < sevenDays)) {
      const daysSince = Math.floor((now - owgrLastSynced) / (24 * 60 * 60 * 1000));
      const warning = await dialog.showConfirm('⚠️ Recent Sync Detected', `OWGR was synced ${daysSince} day${daysSince === 1 ? '' : 's'} ago.\n\nContinue anyway?`, { type: 'warning', confirmText: 'Sync Anyway' });
      if (!warning) return;
    }
    const ok = await dialog.showConfirm('Sync OWGR Players via API', 'Fetch the current Top 250 OWGR players? (~3 API calls)', { confirmText: 'Fetch Players' });
    if (!ok) return;
    try {
      dialog.showToast('Fetching LIV Golf Roster...', 'info');
      const livPlayers = new Set(); const { livRosterApi } = await import('../api/supabase');
      try {
        const supabaseLivPlayers = await livRosterApi.getAll();
        if (supabaseLivPlayers.length > 0) { supabaseLivPlayers.forEach(name => livPlayers.add(name)); }
      } catch { const cached = await storage.get('fantasy-golf-liv-cache'); if (cached) JSON.parse(cached).forEach(name => livPlayers.add(name)); }
      dialog.showToast('Fetching World Rankings...', 'info');
      let rankings = [];
      try { const owgrData = await slashGolfFetch('worldranking', { year: '2026' }); rankings = owgrData?.rankings || []; } catch (e) { console.log('World ranking endpoint failed:', e.message); }
      const newPlayers = [];
      rankings.forEach(p => { const name = p.fullName || `${p.firstName || ''} ${p.lastName || ''}`.trim(); const rankVal = parseInt(p.rank) || 999; if (name && !livPlayers.has(name) && newPlayers.length < 250) newPlayers.push({ name, worldRank: rankVal }); });
      if (newPlayers.length === 0) {
        const uploadChoice = await dialog.showConfirm('API Data Unavailable', '2026 OWGR data not available via API yet.\n\nUpload CSV from owgr.com, or use fallback list.', { confirmText: 'Upload CSV', cancelText: 'Use Fallback' });
        if (uploadChoice) { const input = document.createElement('input'); input.type = 'file'; input.accept = '.csv'; input.onchange = async (e) => await handleCsvUpload(e.target.files[0]); input.click(); return; }
        else { Object.keys(PGA_TOUR_IDS).forEach((name, i) => { if (newPlayers.length < 250) newPlayers.push({ name, worldRank: i + 1 }); }); }
      } else { await storage.set(STORAGE_KEYS.OWGR_LAST_SYNCED, now.toString()); setOwgrLastSynced(now); dialog.showToast(`✓ Loaded ${newPlayers.length} players!`, 'success'); }
      updateRankings(newPlayers);
    } catch (error) { dialog.showToast(`API Error: ${error.message}`, 'error'); }
  };

  const handleAddPlayerId = async () => {
    if (!playerIdSearch || !playerIdValue) { dialog.showToast('Please enter both player name and PGA Tour ID', 'error'); return; }
    try {
      const player = allPlayers.find(p => p.name.toLowerCase().includes(playerIdSearch.toLowerCase()));
      if (!player) { dialog.showToast('Player not found in rankings', 'error'); return; }
      const { supabase } = await import('../api/supabase');
      const { error } = await supabase.from('players').update({ pga_tour_id: playerIdValue }).eq('name', player.name);
      if (error) throw error;
      updateRankings(allPlayers.map(p => p.name === player.name ? { ...p, pgaTourId: playerIdValue } : p));
      dialog.showToast(`✓ Added ID ${playerIdValue} for ${player.name}`, 'success');
      setPlayerIdSearch(''); setPlayerIdValue(''); setShowPlayerIdInput(false);
    } catch (error) { dialog.showToast(`Failed to add ID: ${error.message}`, 'error'); }
  };

  const handleOpenLivManager = async () => {
    try {
      const { livRosterApi } = await import('../api/supabase');
      try { const players = await livRosterApi.getAll(); setLivRoster(players.length > 0 ? players : []); }
      catch { const cached = await storage.get('fantasy-golf-liv-cache'); setLivRoster(cached ? JSON.parse(cached).sort() : []); }
      setShowLivManager(true);
    } catch { setLivRoster([]); setShowLivManager(true); }
  };

  const handleFetchLivRoster = () => {
    const sortedPlayers = [...LIV_GOLF_ROSTER].sort();
    setLivRoster(sortedPlayers);
    dialog.showToast(`✓ Loaded ${sortedPlayers.length} LIV players`, 'success');
  };

  const handleAddLivPlayer = () => {
    const playerName = livPlayerInput.trim(); if (!playerName) return;
    if (livRoster.includes(playerName)) { dialog.showToast('Player already in LIV roster', 'error'); return; }
    setLivRoster([...livRoster, playerName].sort()); setLivPlayerInput('');
  };

  const handleRemoveLivPlayer = (playerName) => setLivRoster(livRoster.filter(p => p !== playerName));

  const handleSaveLivRoster = async () => {
    try {
      const { livRosterApi } = await import('../api/supabase');
      await livRosterApi.setAll(livRoster);
      await storage.set('fantasy-golf-liv-cache', JSON.stringify(livRoster));
      dialog.showToast(`✓ Saved ${livRoster.length} LIV players`, 'success');
      setShowLivManager(false);
    } catch (error) { dialog.showToast('Failed to save LIV roster', 'error'); }
  };

  const resetMulligan = (teamId, type) => {
    const team = teams.find(t => t.id === teamId); if (!team) return;
    const key = type === 'sig' ? 'signatureMajor' : 'regular';
    updateTeams(teams.map(t => t.id === teamId ? { ...t, mulligans: { ...t.mulligans, [key]: 1 } } : t));
    dialog.showToast(`Reset ${type} mulligan for ${team.name}`, 'success');
  };

  // Fix unlimited flags: each team should have exactly 1 unlimited player (keeper).
  // Any non-limited player beyond the first alphabetically-first gets unlimited: false.
  // This repairs rosters drafted before the unlimited: false bug was fixed.
  const handleRepairRosterFlags = async () => {
    const ok = await dialog.showConfirm(
      '🔧 Repair Roster Flags',
      'This will fix the Unlimited (blue) flag on all rosters.\n\nEach team keeps exactly 1 Unlimited player (their keeper). All other non-limited players will show White.\n\nThis is safe to run and does not affect earnings or stats.',
      { confirmText: 'Repair Rosters' }
    );
    if (!ok) return;

    const repairedTeams = teams.map(team => {
      let unlimitedAssigned = false;
      // Preserve the existing unlimited keeper if one exists, otherwise promote first non-limited
      const existingUnlimited = team.roster.find(p => p.unlimited);
      const repairedRoster = team.roster.map(p => {
        if (p.limited) return p; // limited players unchanged
        if (existingUnlimited) {
          // Keep the designated unlimited, clear all others
          return { ...p, unlimited: p.name === existingUnlimited.name };
        } else {
          // No keeper was set — promote the first non-limited player (shouldn't happen but safe)
          if (!unlimitedAssigned) { unlimitedAssigned = true; return { ...p, unlimited: true }; }
          return { ...p, unlimited: false };
        }
      });
      return { ...team, roster: repairedRoster };
    });

    updateTeams(repairedTeams);
    dialog.showToast('✓ Roster flags repaired — Limited=Yellow, 1 Unlimited=Blue, rest=White', 'success');
  };

  const handleSeasonReset = async () => {
    const c1 = await dialog.showConfirm('⚠️ DANGER: Reset Entire Season', 'This will DELETE all results, transactions, rosters, and stats. Cannot be undone.', { type: 'danger', confirmText: 'Continue' });
    if (!c1) return;
    const c2 = await dialog.showConfirm('⚠️ FINAL WARNING', 'Are you ABSOLUTELY SURE?', { type: 'danger', confirmText: 'Yes, Reset Everything' });
    if (!c2) return;
    const resetTeams = teams.map(team => ({ ...team, earnings: 0, segmentEarnings: 0, lineup: [], roster: [], mulligans: { signatureMajor: 1, regular: 1 } }));
    const resetTournaments = tournaments.map((t, idx) => ({ ...t, completed: false, playing: idx === 0, results: null }));
    setTransactions([]); setGlobalPlayerStats({}); updateTeams(resetTeams); setTournaments(resetTournaments);
    try { await tournamentResultsApi.deleteAllForSeason(); } catch (e) { console.warn('Supabase reset failed (non-fatal):', e.message); }
    dialog.showToast('Season reset complete!', 'success');
  };

  const handleNewDraft = async () => {
    const confirm = await dialog.showConfirm(
      '🎯 New Draft',
      'This will clear all rosters and delete any in-progress draft. Are you sure?',
      { type: 'danger', confirmText: 'Start New Draft' },
    );
    if (!confirm) return;
    try { await draftStateApi.clear(); } catch {}
    updateTeams(teams.map(t => ({ ...t, roster: [], lineup: [] })));
    setHasSavedDraft(false);
    setDraftInitialPhase('order');
    setShowDraftModal(true);
  };

  const handleResumeDraft = () => {
    setDraftInitialPhase('resume_prompt');
    setShowDraftModal(true);
  };

  const handleAddPlayer = async (teamId, playerName) => {
    const team = teams.find(t => t.id === teamId); if (!team) return;
    if (team.roster.some(p => p.name === playerName)) { dialog.showToast('Player already on roster', 'error'); return; }
    const player = allPlayers.find(p => p.name === playerName);
    if (!player) { dialog.showToast('Player not found', 'error'); return; }
    updateTeams(teams.map(t => t.id === teamId ? { ...t, roster: [...t.roster, makePlayer(player.name, player.worldRank)] } : t));
    dialog.showToast(`Added ${playerName} to ${team.name}`, 'success');
  };

  const handleDropPlayer = async (teamId, playerName) => {
    const team = teams.find(t => t.id === teamId); if (!team) return;
    const confirm = await dialog.showConfirm('Drop Player', `Remove ${playerName} from ${team.name}?`, { type: 'danger', confirmText: 'Drop Player' });
    if (!confirm) return;
    updateTeams(teams.map(t => t.id === teamId ? { ...t, roster: t.roster.filter(p => p.name !== playerName) } : t));
    dialog.showToast(`Dropped ${playerName}`, 'success');
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      <style>{`
        .sfgl-admin-select option {
          background: #0d1e38 !important;
          color: rgba(255,255,255,0.9) !important;
        }
        .sfgl-admin-select option:hover,
        .sfgl-admin-select option:checked {
          background: rgba(26,51,102,0.95) !important;
        }
      `}</style>

      {/* Header */}
      <div style={{ ...theme.card, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Settings style={{ width: 16, height: 16, color: colors.textGold }} />
          <h2 style={theme.h2}>Commissioner Controls</h2>
        </div>
        <button onClick={() => { setIsCommissioner(false); setActiveTab('standings'); }}
          style={{ ...theme.btnDanger, padding: '7px 16px' }}>
          Exit
        </button>
      </div>

      {/* Results Entry */}
      <Section>
        <SectionHeader icon="✏️" title="Enter Tournament Results" />
        <SectionBody>
          {/* Tournament selector */}
          <div>
            <FieldLabel>Select Tournament</FieldLabel>
            <ThemedSelect value={selectedTourneyForResults} onChange={e => setSelectedTourneyForResults(e.target.value)}>
              <option value="">Choose tournament…</option>
              {tournaments.map(t => <option key={t.name} value={t.name}>{t.name}{t.completed ? ' ✓' : t.playing ? ' ▶' : ''}</option>)}
            </ThemedSelect>
          </div>

          {/* API fetch */}
          <Btn onClick={handleFetchApiResults}>⚡ Fetch Results from API</Btn>

          {/* Divider */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ flex: 1, height: 1, background: colors.borderSubtle }} />
            <span style={{ ...theme.smallText, letterSpacing: '1px', textTransform: 'uppercase' }}>or</span>
            <div style={{ flex: 1, height: 1, background: colors.borderSubtle }} />
          </div>

          {/* Manual entry toggle */}
          <button
            onClick={() => setManualEntryOpen(o => !o)}
            style={{
              ...theme.btnSecondary, width: '100%', padding: '10px 16px',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              borderColor: manualEntryOpen ? colors.borderFocus : colors.borderInput,
            }}
          >
            <span>✏️ Enter Results Manually</span>
            <span style={{ fontSize: 10 }}>{manualEntryOpen ? '▲' : '▼'}</span>
          </button>

          {/* Manual entry form */}
          {manualEntryOpen && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '16px 20px', background: 'rgba(255,255,255,0.02)', border: `1px solid ${colors.borderSubtle}`, borderRadius: 2 }}>
              {/* Round leaders */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                {[
                  { label: 'Round 1 Leaders', key: 'round1Leaders' },
                  { label: 'Round 2 Leaders', key: 'round2Leaders' },
                  { label: 'Round 3 Leaders', key: 'round3Leaders' },
                ].map(({ label, key }) => (
                  <div key={key}>
                    <FieldLabel>{label}</FieldLabel>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {manualEntry[key].map((leader, idx) => (
                        <div key={idx} style={{ display: 'flex', gap: 4 }}>
                          <ThemedSelect
                            value={leader}
                            onChange={e => {
                              const next = [...manualEntry[key]];
                              next[idx] = e.target.value;
                              setManualEntry({ ...manualEntry, [key]: next });
                            }}
                            style={{ flex: 1, fontSize: 11, padding: '6px 8px' }}
                          >
                            <option value="">(optional)</option>
                            {selectedTourneyForResults && teams.flatMap(team =>
                              team.lineup.map(pName => (
                                <option key={`${team.name}-${pName}`} value={pName}>{pName}</option>
                              ))
                            ).sort((a, b) => a.props.value.localeCompare(b.props.value))}
                          </ThemedSelect>
                          {idx > 0 && (
                            <button
                              onClick={() => setManualEntry({ ...manualEntry, [key]: manualEntry[key].filter((_, i) => i !== idx) })}
                              style={{ ...theme.btnDanger, padding: '4px 8px', fontSize: 10 }}
                            >✕</button>
                          )}
                        </div>
                      ))}
                      <button
                        onClick={() => setManualEntry({ ...manualEntry, [key]: [...manualEntry[key], ''] })}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.textGoldDim, fontFamily: fonts.sans, fontSize: 11, textAlign: 'left', padding: '2px 0' }}
                      >+ co-leader</button>
                    </div>
                  </div>
                ))}
              </div>

              {/* Earnings textarea */}
              <div>
                <FieldLabel>Player Earnings — one per line: Player Name, 123456</FieldLabel>
                <textarea
                  value={manualEntry.playerEarnings}
                  onChange={e => setManualEntry({ ...manualEntry, playerEarnings: e.target.value })}
                  placeholder={"Scottie Scheffler, 3600000\nRory McIlroy, 2160000\nBrooks Koepka, 1368000"}
                  rows={8}
                  style={{
                    ...theme.input,
                    fontFamily: fonts.mono,
                    fontSize: 12,
                    resize: 'vertical',
                    lineHeight: 1.6,
                  }}
                />
                {manualEntry.playerEarnings.trim() && (
                  <p style={{ ...theme.smallText, marginTop: 4, color: colors.textGoldDim }}>
                    {manualEntry.playerEarnings.split('\n').filter(l => l.match(/^.+?,\s*[\d,]+$/)).length} valid entries detected
                  </p>
                )}
              </div>

              {/* Submit */}
              <Btn
                onClick={handleManualEntry}
                disabled={!selectedTourneyForResults || !manualEntry.playerEarnings.trim()}
              >
                Process Manual Results
              </Btn>
            </div>
          )}
        </SectionBody>
      </Section>

      {/* Historical Lineups */}
      <Section>
        <SectionHeader icon="📋" title="Historical Lineup Viewer" />
        <SectionBody>
          <p style={{ ...theme.smallText, marginBottom: 4 }}>
            View and correct the lineups submitted for any completed tournament. Lineups are frozen at processing time — roster adds/drops after the fact don't affect the snapshot.
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'end' }}>
            <div>
              <FieldLabel>Select Completed Tournament</FieldLabel>
              <ThemedSelect value={historyTourney} onChange={e => { setHistoryTourney(e.target.value); setHistoryData(null); setHistoryEdits({}); }}>
                <option value="">Choose tournament…</option>
                {tournaments.filter(t => t.completed).map(t => <option key={t.name} value={t.name}>{t.name}</option>)}
              </ThemedSelect>
            </div>
            <Btn onClick={handleLoadHistory} disabled={!historyTourney || historyLoading}>
              {historyLoading ? 'Loading…' : 'Load'}
            </Btn>
          </div>

          {historyData && (() => {
            const completedTeams = teams.filter(t => historyData.fullLineups?.[t.id] !== undefined || historyData.teamResults?.[t.id] !== undefined);
            if (completedTeams.length === 0) return (
              <div style={{ ...theme.smallText, textAlign: 'center', padding: 16 }}>
                No lineup data in this record — it was processed before snapshots were added.
              </div>
            );
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ ...theme.smallText, color: colors.textGoldDim }}>
                  Processed: {new Date(historyData.processedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  {historyData.isManualEntry && ' · Manual entry'}
                </div>

                {teams.map(team => {
                  const savedLineup   = historyData.fullLineups?.[team.id] || [];
                  const rosterSnap    = historyData.rosterSnapshots?.[team.id] || team.roster;
                  const editedLineup  = historyEdits[team.id] || savedLineup;
                  const teamResult    = historyData.teamResults?.[team.id];
                  const hasData       = savedLineup.length > 0 || teamResult;
                  if (!hasData) return null;

                  return (
                    <div key={team.id} style={{ background: 'rgba(255,255,255,0.02)', border: `1px solid ${colors.borderSubtle}`, borderRadius: 2, padding: '12px 16px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                        <span style={{ fontFamily: fonts.serif, fontSize: 13, fontWeight: 700, color: colors.textPrimary }}>{team.name}</span>
                        {teamResult && (
                          <span style={{ ...theme.statNum, fontSize: 12, color: colors.textGold }}>
                            ${(teamResult.totalEarnings || 0).toLocaleString()}
                          </span>
                        )}
                      </div>

                      {/* Saved lineup pills */}
                      {savedLineup.length > 0 ? (
                        <div style={{ marginBottom: 10 }}>
                          <p style={{ ...theme.smallText, marginBottom: 6 }}>
                            Submitted lineup ({savedLineup.length} player{savedLineup.length !== 1 ? 's' : ''}):
                          </p>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                            {savedLineup.map(name => {
                              const player = rosterSnap.find(p => p.name === name) || { name, limited: false };
                              const inEdit = editedLineup.includes(name);
                              return (
                                <span key={name} style={{
                                  padding: '3px 8px', borderRadius: 2, fontSize: 11,
                                  fontFamily: fonts.sans, cursor: 'pointer',
                                  background: inEdit ? (player.limited ? 'rgba(180,160,100,0.2)' : 'rgba(100,140,220,0.15)') : 'rgba(255,255,255,0.04)',
                                  border: `1px solid ${inEdit ? (player.limited ? 'rgba(180,160,100,0.5)' : 'rgba(100,140,220,0.4)') : colors.borderSubtle}`,
                                  color: inEdit ? (player.limited ? colors.textGold : 'rgba(160,190,255,0.9)') : colors.textMuted,
                                  textDecoration: inEdit ? 'none' : 'line-through',
                                }}
                                  onClick={() => {
                                    const next = inEdit ? editedLineup.filter(n => n !== name) : [...editedLineup, name];
                                    setHistoryEdits(prev => ({ ...prev, [team.id]: next }));
                                  }}
                                  title={inEdit ? 'Click to remove from corrected lineup' : 'Click to restore to corrected lineup'}
                                >
                                  {name}
                                </span>
                              );
                            })}
                          </div>
                        </div>
                      ) : (
                        <p style={{ ...theme.smallText, marginBottom: 10, color: colors.textMuted }}>No lineup snapshot — processed before this feature was added.</p>
                      )}

                      {/* Roster snapshot for adding missed players */}
                      {rosterSnap.length > 0 && (() => {
                        const notInLineup = rosterSnap.filter(p => !savedLineup.includes(p.name));
                        if (notInLineup.length === 0) return null;
                        return (
                          <div>
                            <p style={{ ...theme.smallText, marginBottom: 6, color: colors.textGoldDim }}>Roster that week (click to add to corrected lineup):</p>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                              {notInLineup.map(player => {
                                const inEdit = editedLineup.includes(player.name);
                                return (
                                  <span key={player.name} style={{
                                    padding: '3px 8px', borderRadius: 2, fontSize: 11,
                                    fontFamily: fonts.sans, cursor: 'pointer',
                                    background: inEdit ? 'rgba(80,180,120,0.15)' : 'rgba(255,255,255,0.03)',
                                    border: `1px solid ${inEdit ? 'rgba(80,180,120,0.4)' : colors.borderSubtle}`,
                                    color: inEdit ? colors.success : colors.textMuted,
                                  }}
                                    onClick={() => {
                                      const next = inEdit ? editedLineup.filter(n => n !== player.name) : [...editedLineup, player.name];
                                      setHistoryEdits(prev => ({ ...prev, [team.id]: next }));
                                    }}
                                  >
                                    {player.name}
                                    {player.limited && <span style={{ marginLeft: 3, color: colors.textGoldDim }}>L</span>}
                                  </span>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  );
                })}

                <Btn onClick={handleSaveHistoryEdits}>💾 Save Corrected Lineups to History</Btn>
              </div>
            );
          })()}
        </SectionBody>
      </Section>

      {/* Player Management */}
      <Section>
        <SectionHeader icon="👤" title="Player Management" />
        <SectionBody>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <Btn onClick={handleSyncPlayers} title="Uses ~3 API calls">Sync via API</Btn>
            <Btn onClick={handleSyncCsv} title="0 API calls">Sync via CSV</Btn>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <Btn onClick={() => setShowPlayerIdInput(true)} variant="secondary">Add PGA Tour ID</Btn>
            <Btn onClick={handleOpenLivManager} variant="secondary">Manage LIV Roster</Btn>
          </div>
          {(rankingsLastUpdated || owgrLastSynced) && (
            <div style={{ textAlign: 'center' }}>
              {rankingsLastUpdated && <p style={{ ...theme.smallText, fontSize: 10 }}>Rankings updated: {new Date(rankingsLastUpdated).toLocaleDateString()}</p>}
              {owgrLastSynced && <p style={{ ...theme.smallText, fontSize: 10, color: colors.textGoldDim, marginTop: 2 }}>OWGR sync: {new Date(owgrLastSynced).toLocaleDateString()} at {new Date(owgrLastSynced).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>}
            </div>
          )}
        </SectionBody>
      </Section>

      {/* Roster Management */}
      <Section>
        <SectionHeader icon="👥" title="Roster Management" />
        <SectionBody>
          <Btn onClick={handleRepairRosterFlags} variant="secondary">
            🔧 Repair Roster Flags (Limited / Unlimited / White)
          </Btn>
          <div>
            <FieldLabel>Select Team</FieldLabel>
            <ThemedSelect value={rosterMgmtTeam} onChange={e => { setRosterMgmtTeam(e.target.value); setPlayerSearch(''); }}>
              <option value="">— Choose Team —</option>
              {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </ThemedSelect>
          </div>

          {rosterMgmtTeam && (() => {
            const team = teams.find(t => t.id === rosterMgmtTeam);
            const searchResults = playerSearch.trim()
              ? allPlayers.filter(p => p.name.toLowerCase().includes(playerSearch.toLowerCase())).filter(p => !team.roster.some(r => r.name === p.name)).slice(0, 20)
              : [];
            return (
              <>
                {/* Mulligans */}
                <div style={{ background: 'rgba(255,255,255,0.03)', border: `1px solid ${colors.borderSubtle}`, borderRadius: 2, padding: '10px 14px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <span style={theme.label}>Mulligan Management</span>
                    <span style={{ ...theme.smallText, fontSize: 10 }}>Sig: {team.mulligans?.signatureMajor ?? 0} · Reg: {team.mulligans?.regular ?? 0}</span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <Btn onClick={() => resetMulligan(team.id, 'sig')} style={{ fontSize: 10, padding: '7px 10px' }}>Reset Signature</Btn>
                    <Btn onClick={() => resetMulligan(team.id, 'reg')} variant="secondary" style={{ fontSize: 10, padding: '7px 10px' }}>Reset Regular</Btn>
                  </div>
                </div>

                {/* Roster list */}
                <div style={{ ...theme.label, marginBottom: 4 }}>{team.name} — {team.roster.length} players</div>
                <div style={{ maxHeight: 240, overflowY: 'auto', border: `1px solid ${colors.borderSubtle}`, borderRadius: 2, marginBottom: 8 }}>
                  {team.roster.map(player => (
                    <div key={player.name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderBottom: `1px solid ${colors.borderSubtle}` }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <img src={`https://pga-tour-res.cloudflare.com/resources/photoplayer/${headshots[player.name] || 'default'}.jpg`}
                          onError={e => { e.target.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(player.name)}&background=0d1e38&color=6b7280&size=32`; }}
                          alt="" style={{ width: 28, height: 28, borderRadius: '50%', objectFit: 'cover', border: `1px solid ${colors.borderSubtle}` }} />
                        <span style={{ ...theme.bodyText, fontSize: 13 }}>{player.name}</span>
                      </div>
                      <button onClick={() => handleDropPlayer(team.id, player.name)} style={{ ...theme.btnDanger, padding: '4px 10px', fontSize: 10 }}>Drop</button>
                    </div>
                  ))}
                  {team.roster.length === 0 && <div style={theme.emptyState}>No players on roster</div>}
                </div>

                {/* Add player search */}
                <FieldLabel>Add Player</FieldLabel>
                <ThemedInput value={playerSearch} onChange={e => setPlayerSearch(e.target.value)} placeholder="Search by name…" />
                {playerSearch.trim() && (
                  <div style={{ marginTop: 6, maxHeight: 200, overflowY: 'auto', border: `1px solid ${colors.borderSubtle}`, borderRadius: 2, background: 'rgba(0,0,0,0.2)' }}>
                    {searchResults.length > 0 ? searchResults.map(player => (
                      <button key={player.name}
                        onClick={() => { handleAddPlayer(team.id, player.name); setPlayerSearch(''); }}
                        style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: 'none', border: 'none', cursor: 'pointer', borderBottom: `1px solid ${colors.borderSubtle}` }}
                        onMouseEnter={e => e.currentTarget.style.background = colors.rowHover}
                        onMouseLeave={e => e.currentTarget.style.background = 'none'}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <img src={`https://pga-tour-res.cloudflare.com/resources/photoplayer/${headshots[player.name] || 'default'}.jpg`}
                            onError={e => { e.target.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(player.name)}&background=0d1e38&color=6b7280&size=32`; }}
                            alt="" style={{ width: 28, height: 28, borderRadius: '50%', objectFit: 'cover', border: `1px solid ${colors.borderSubtle}` }} />
                          <div>
                            <div style={{ ...theme.bodyText, fontSize: 13 }}>{player.name}</div>
                            <div style={theme.smallText}>Rank: {player.worldRank === 999 ? 'NR' : `#${player.worldRank}`}</div>
                          </div>
                        </div>
                        <span style={{ ...theme.label, color: colors.textGold }}>Add</span>
                      </button>
                    )) : <div style={theme.emptyState}>No players found</div>}
                  </div>
                )}
              </>
            );
          })()}
        </SectionBody>
      </Section>

      {/* Backup & Restore */}
      <Section>
        <SectionHeader icon="💾" title="Backup & Restore" />
        <SectionBody>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <Btn onClick={handleExport} variant="secondary">Export JSON</Btn>
            <label style={{ ...theme.btnSecondary, width: '100%', padding: '10px 16px', textAlign: 'center', cursor: 'pointer', display: 'block' }}>
              Import JSON
              <input type="file" accept=".json" onChange={handleImport} style={{ display: 'none' }} />
            </label>
          </div>
        </SectionBody>
      </Section>

      {/* Schedule */}
      <Section>
        <SectionHeader icon="📅" title="Tournament Schedule" />
        <SectionBody>
          <Btn onClick={() => setShowScheduleImporter(true)}>Import 2026 Schedule</Btn>
        </SectionBody>
      </Section>

      {/* Draft */}
      <Section>
        <SectionHeader icon="🎯" title="Draft" />
        <SectionBody>
          {hasSavedDraft && (
            <div style={{ background: 'rgba(100,160,255,0.08)', border: '1px solid rgba(100,160,255,0.2)', borderRadius: 2, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13 }}>💾</span>
              <span style={{ ...theme.smallText, color: 'rgba(100,160,255,0.8)' }}>A draft is in progress</span>
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: hasSavedDraft ? '1fr 1fr' : '1fr', gap: 8 }}>
            <Btn onClick={handleNewDraft} variant="danger">🗑 New Draft</Btn>
            {hasSavedDraft && <Btn onClick={handleResumeDraft}>▶ Resume Draft</Btn>}
          </div>
        </SectionBody>
      </Section>

      {/* Danger Zone */}
      <Section style={{ border: `1px solid ${colors.dangerBorder}` }}>
        <div style={{ ...theme.cardHeader, background: 'rgba(180,60,60,0.08)' }}>
          <span style={{ fontSize: 15 }}>⚠️</span>
          <h3 style={{ ...theme.h2, color: colors.danger }}>Danger Zone</h3>
        </div>
        <SectionBody>
          <p style={theme.bodyText}>Permanently deletes all tournament results, transactions, lineups, rosters, and player stats. Team names and schedule are preserved.</p>
          <Btn onClick={handleSeasonReset} variant="danger">🔥 Reset Entire Season</Btn>
        </SectionBody>
      </Section>

      {/* ── Modals ── */}
      {showScheduleImporter && (
        <ScheduleImportModal onImport={handleImportSchedule} onCancel={() => setShowScheduleImporter(false)} />
      )}

      {showPlayerIdInput && (
        <Modal title="Add PGA Tour ID" onClose={() => { setShowPlayerIdInput(false); setPlayerIdSearch(''); setPlayerIdValue(''); }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <FieldLabel>Search Player</FieldLabel>
              <ThemedInput value={playerIdSearch} onChange={e => setPlayerIdSearch(e.target.value)} placeholder="Player name…" autoFocus />
              {playerIdSearch && (
                <div style={{ marginTop: 6, maxHeight: 140, overflowY: 'auto', border: `1px solid ${colors.borderSubtle}`, borderRadius: 2 }}>
                  {allPlayers.filter(p => p.name.toLowerCase().includes(playerIdSearch.toLowerCase())).slice(0, 5).map(player => (
                    <button key={player.name} onClick={() => setPlayerIdSearch(player.name)}
                      style={{ width: '100%', textAlign: 'left', padding: '8px 12px', background: 'none', border: 'none', cursor: 'pointer', borderBottom: `1px solid ${colors.borderSubtle}` }}
                      onMouseEnter={e => e.currentTarget.style.background = colors.rowHover}
                      onMouseLeave={e => e.currentTarget.style.background = 'none'}
                    >
                      <div style={{ ...theme.bodyText, fontSize: 13 }}>{player.name}</div>
                      <div style={theme.smallText}>Rank: #{player.worldRank}{player.pgaTourId && ` · ID: ${player.pgaTourId}`}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div>
              <FieldLabel>PGA Tour ID</FieldLabel>
              <ThemedInput value={playerIdValue} onChange={e => setPlayerIdValue(e.target.value)} placeholder="e.g. 46046" />
              <p style={{ ...theme.smallText, marginTop: 4 }}>Find IDs on pgatour.com or from API responses</p>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <Btn variant="secondary" onClick={() => { setShowPlayerIdInput(false); setPlayerIdSearch(''); setPlayerIdValue(''); }}>Cancel</Btn>
              <Btn onClick={handleAddPlayerId}>Add ID</Btn>
            </div>
          </div>
        </Modal>
      )}

      {showLivManager && (
        <Modal title="Manage LIV Golf Roster" onClose={() => setShowLivManager(false)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <p style={theme.bodyText}>Players in this list are filtered out during OWGR sync.</p>
            <Btn onClick={handleFetchLivRoster}>📋 Load 2026 LIV Roster (52 players)</Btn>
            <div>
              <FieldLabel>Add LIV Player</FieldLabel>
              <div style={{ display: 'flex', gap: 8 }}>
                <ThemedInput value={livPlayerInput} onChange={e => setLivPlayerInput(e.target.value)}
                  placeholder="e.g. Brooks Koepka"
                  onKeyPress={e => e.key === 'Enter' && handleAddLivPlayer()}
                  style={{ flex: 1 }} />
                <button onClick={handleAddLivPlayer} style={{ ...theme.btnPrimary, padding: '10px 16px', whiteSpace: 'nowrap' }}>Add</button>
              </div>
            </div>
            <div style={{ border: `1px solid ${colors.borderSubtle}`, borderRadius: 2, maxHeight: 240, overflowY: 'auto' }}>
              {livRoster.length > 0 ? livRoster.map(player => (
                <div key={player} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderBottom: `1px solid ${colors.borderSubtle}` }}
                  onMouseEnter={e => e.currentTarget.style.background = colors.rowHover}
                  onMouseLeave={e => e.currentTarget.style.background = 'none'}
                >
                  <span style={{ ...theme.bodyText, fontSize: 13 }}>{player}</span>
                  <button onClick={() => handleRemoveLivPlayer(player)} style={{ ...theme.btnDanger, padding: '3px 10px', fontSize: 10 }}>Remove</button>
                </div>
              )) : <div style={theme.emptyState}>No LIV players in roster.</div>}
            </div>
            <p style={{ ...theme.smallText, textAlign: 'right' }}>{livRoster.length} player{livRoster.length !== 1 ? 's' : ''}</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <Btn variant="secondary" onClick={() => setShowLivManager(false)}>Cancel</Btn>
              <Btn onClick={handleSaveLivRoster}>Save Roster</Btn>
            </div>
          </div>
        </Modal>
      )}

      {showDraftModal && (
        <DraftModal
          teams={teams} allPlayers={allPlayers} updateTeams={updateTeams}
          onClose={() => { setShowDraftModal(false); draftStateApi.get().then(s => setHasSavedDraft(!!(s && s.phase !== 'order'))).catch(() => {}); }}
          headshots={headshots}
          initialPhase={draftInitialPhase}
        />
      )}
    </div>
  );
};
