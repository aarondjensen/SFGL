import React, { useState, useEffect } from 'react';
import { Settings, X } from 'lucide-react';
import { useDialog } from './DialogContext';
import { slashGolfFetch, processTournamentData, makePlayer, resolvePlayerName } from '../utils';
import { PGA_TOUR_IDS, FALLBACK_SCHEDULE_DATA, LIV_GOLF_ROSTER } from '../constants';
import { storage } from '../api';
import { ScheduleImportModal } from './ScheduleImportModal';
import { DraftModal } from './DraftModal';
import { managerAuthApi } from '../api/supabase';
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
    <h3 style={{ ...theme.h2, color: color || colors.textGold }}>{title}</h3>
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
             : theme.btnPrimary;
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
    style={{ ...theme.select, ...style }}
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
  const dialog = useDialog();
  const activeTournament = tournaments.find(t => t.playing);

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
      const ok = await dialog.showConfirm('Already Processed', 'This tournament was already processed. Re-fetching will ADD earnings again (doubling them).\n\nAre you sure?', { type: 'danger', confirmText: 'Force Re-Fetch' });
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
      const { newTeams, newStats, resultsData } = processTournamentData(t, apiPlayers, teams, globalPlayerStats, rosteredNames);
      const newTournaments = tournaments.map((nt, idx) => idx === tournIndex ? { ...nt, completed: true, playing: false, results: resultsData } : nt);
      const nextIdx = newTournaments.findIndex((nt, idx) => idx > tournIndex && !nt.completed && !nt.isAlternate);
      if (nextIdx !== -1) { newTournaments.forEach(nt => { nt.playing = false; }); newTournaments[nextIdx].playing = true; }
      updateTeams(newTeams); setGlobalPlayerStats(newStats); setTournaments(newTournaments);
      dialog.showToast(`Results processed for ${t.name}!`, 'success');
    } catch (error) { console.error('Results Sync Error:', error); dialog.showToast(`API Error: ${error.message}`, 'error'); }
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
      const { error } = await supabase.from('player_rankings').update({ pga_tour_id: playerIdValue }).eq('name', player.name);
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

  const handleSeasonReset = async () => {
    const c1 = await dialog.showConfirm('⚠️ DANGER: Reset Entire Season', 'This will DELETE all results, transactions, rosters, and stats. Cannot be undone.', { type: 'danger', confirmText: 'Continue' });
    if (!c1) return;
    const c2 = await dialog.showConfirm('⚠️ FINAL WARNING', 'Are you ABSOLUTELY SURE?', { type: 'danger', confirmText: 'Yes, Reset Everything' });
    if (!c2) return;
    const resetTeams = teams.map(team => ({ ...team, earnings: 0, segmentEarnings: 0, lineup: [], roster: [], mulligans: { signatureMajor: 1, regular: 1 } }));
    const resetTournaments = tournaments.map((t, idx) => ({ ...t, completed: false, playing: idx === 0, results: null }));
    setTransactions([]); setGlobalPlayerStats({}); updateTeams(resetTeams); setTournaments(resetTournaments);
    dialog.showToast('Season reset complete!', 'success');
  };

  const handleDraft = async () => {
    const confirm = await dialog.showConfirm('Start Draft', 'This will clear all rosters and open a draft interface. Continue?', { confirmText: 'Start Draft' });
    if (!confirm) return;
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
          <div>
            <FieldLabel>Select Tournament</FieldLabel>
            <ThemedSelect value={selectedTourneyForResults} onChange={e => setSelectedTourneyForResults(e.target.value)}>
              <option value="">Choose tournament…</option>
              {tournaments.map(t => <option key={t.name} value={t.name}>{t.name}{t.completed ? ' ✓' : t.playing ? ' ▶' : ''}</option>)}
            </ThemedSelect>
          </div>
          <Btn onClick={handleFetchApiResults}>⚡ Fetch Results from API</Btn>
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
        <SectionHeader icon="🎯" title="Start New Draft" />
        <SectionBody>
          <p style={theme.bodyText}>This will clear all rosters and begin keeper selection.</p>
          <Btn onClick={handleDraft}>Start Draft</Btn>
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
        <DraftModal teams={teams} allPlayers={allPlayers} updateTeams={updateTeams} onClose={() => setShowDraftModal(false)} headshots={headshots} />
      )}
    </div>
  );
};
