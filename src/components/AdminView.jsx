import React, { useState } from 'react';
import { Settings } from 'lucide-react';
import { useDialog } from './DialogContext';
import { slashGolfFetch, processTournamentData, getSegmentByDate } from '../utils';
import { storage } from '../api';
import { DraftModal } from './DraftModal';
import { managerAuthApi, tournamentResultsApi, sfglDataApi } from '../api/supabase';
import { theme, colors, fonts } from '../theme.js';

export const AdminView = ({
  isCommissioner, setIsCommissioner, setActiveTab,
  settings, setSettings,
  teams, updateTeams,
  tournaments, setTournaments,
  transactions, setTransactions,
  allPlayers, globalPlayerStats, setGlobalPlayerStats,
  headshots,
  STORAGE_KEYS,
}) => {
  const [selectedTourney, setSelectedTourney] = useState('');
  const [manualEntry, setManualEntry] = useState({ round1Leaders: [''], round2Leaders: [''], round3Leaders: [''], playerEarnings: '' });
  const [rosterMgmtTeam, setRosterMgmtTeam] = useState('');
  const [playerSearch, setPlayerSearch] = useState('');
  const [mgCredTeam, setMgCredTeam] = useState('');
  const [mgCredName, setMgCredName] = useState('');
  const [mgCredPass, setMgCredPass] = useState('');
  const [mgCredSaving, setMgCredSaving] = useState(false);
  const [showDraftModal, setShowDraftModal] = useState(false);
  const [swingAwardSeg, setSwingAwardSeg]   = useState('');
  // Apply mulligan (live, inside Roster Management)
  const [mulliganMode, setMulliganMode]     = useState(false);
  const [mulliganOut,  setMulliganOut]      = useState('');
  const [mulliganIn,   setMulliganIn]       = useState('');
  const [mulliganRound, setMulliganRound]   = useState('2');
  // Retroactive mulligan
  const [retMulTeam, setRetMulTeam] = useState('');
  const [retMulTourney, setRetMulTourney] = useState('');
  const [retMulOut, setRetMulOut] = useState('');
  const [retMulIn, setRetMulIn] = useState('');
  const [retMulType, setRetMulType] = useState('regular');
  const [retMulRound, setRetMulRound] = useState('2');
  const dialog = useDialog();

  React.useEffect(() => {
    const active = tournaments.find(t => t.playing);
    if (active && !selectedTourney) setSelectedTourney(active.name);
  }, [tournaments, selectedTourney]);

  const S = {
    section: { background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 4, padding: '16px 18px', marginBottom: 12 },
    title: { fontFamily: fonts.sans, fontSize: 11, fontWeight: 700, letterSpacing: '1.8px', textTransform: 'uppercase', color: colors.sectionHeaderBlue, marginBottom: 12 },
    btn: { ...theme.btnPrimary, width: '100%', padding: '10px 16px', textAlign: 'center', display: 'block', cursor: 'pointer' },
    btnSec: { ...theme.btnSecondary, width: '100%', padding: '10px 16px', textAlign: 'center', display: 'block', cursor: 'pointer' },
    btnDgr: { ...theme.btnDanger, width: '100%', padding: '10px 16px', textAlign: 'center', display: 'block', cursor: 'pointer' },
    input: { ...theme.input, marginBottom: 8 },
    select: { ...theme.select, marginBottom: 8, color: colors.textPrimary, backgroundColor: '#0d1b2e', appearance: 'none', WebkitAppearance: 'none' },
    lbl: { ...theme.label, display: 'block', marginBottom: 6 },
  };

  // ── Results: API fetch ───────────────────────────────────────────────────
  const handleFetchApiResults = async () => {
    if (!selectedTourney) { dialog.showToast('Select a tournament first', 'error'); return; }
    const ti = tournaments.findIndex(t => t.name === selectedTourney);
    const t = tournaments[ti];
    if (!t?.slashGolfId) { dialog.showToast('No API ID for this tournament', 'error'); return; }
    if (t.completed) {
      const ok = await dialog.showConfirm('Already Processed', 'Re-fetching will ADD earnings again (doubling them). Continue?', { type: 'danger', confirmText: 'Force Re-Fetch' });
      if (!ok) return;
    }
    try {
      dialog.showToast('Fetching ' + t.name + '...', 'info');
      let data = await slashGolfFetch('leaderboard', { tournId: t.slashGolfId, year: '2026' });
      let ap = data.leaderboardRows || data.leaderboard || data.results || [];
      if (!ap.length) { dialog.showToast('No results found in API yet.', 'error'); return; }
      try {
        const ed = await slashGolfFetch('earnings', { tournId: t.slashGolfId, year: '2026' });
        const ep = ed.leaderboard || ed.earnings || ed.results || [];
        if (ep.length) ap = ap.map(lp => ({ ...lp, earnings: ep.find(e => e.playerId === lp.playerId)?.earnings || 0 }));
      } catch (_) {}
      const names = teams.flatMap(t => t.roster.map(p => p.name));
      const { newTeams, newStats, resultsData } = processTournamentData(t, ap, teams, globalPlayerStats, names);
      const newT = tournaments.map((nt, i) => i === ti ? { ...nt, completed: true, playing: false, results: resultsData } : nt);
      const nx = newT.findIndex((nt, i) => i > ti && !nt.completed && !nt.isAlternate);
      if (nx !== -1) { newT.forEach(nt => { nt.playing = false; }); newT[nx].playing = true; }
      // Also apply sfglEarnings from resultsData.teams directly onto roster
      const teamsWithSfgl = newTeams.map(team => {
        const teamResult = resultsData?.teams?.[team.id];
        if (!teamResult?.players) return team;
        const earningsByName = {};
        teamResult.players.forEach(p => { earningsByName[p.name || p] = (p.earnings || 0); });
        return { ...team, roster: team.roster.map(p => earningsByName[p.name] !== undefined ? { ...p, sfglEarnings: (p.sfglEarnings || 0) + earningsByName[p.name] } : p) };
      });
      updateTeams(teamsWithSfgl); setGlobalPlayerStats(newStats); setTournaments(newT);
      await storage.set(STORAGE_KEYS.TEAMS, teamsWithSfgl);
      await storage.set(STORAGE_KEYS.TOURNAMENTS, newT);
      await storage.set(STORAGE_KEYS.GLOBAL_PLAYER_STATS, newStats);
      sfglDataApi.set(STORAGE_KEYS.TEAMS, teamsWithSfgl).catch(() => {});
      dialog.showToast('Results processed for ' + t.name + '!', 'success');
    } catch (err) { dialog.showToast('API Error: ' + err.message, 'error'); }
  };

  // ── Results: manual entry ────────────────────────────────────────────────
  const handleManualEntry = async () => {
    if (!selectedTourney) { dialog.showToast('Select a tournament first', 'error'); return; }
    const tournament = tournaments.find(t => t.name === selectedTourney);
    if (!tournament) return;
    if (tournament.completed) {
      const ok = await dialog.showConfirm('Already Processed', 'Re-entering will ADD earnings again (doubling them). Continue?', { type: 'danger', confirmText: 'Re-enter Results' });
      if (!ok) return;
    }
    const earningsMap = new Map();
    manualEntry.playerEarnings.split('\n').forEach(line => {
      const m = line.match(/^(.+?),\s*([\d,]+)$/);
      if (m) { const amt = parseInt(m[2].replace(/,/g, '')); if (!isNaN(amt)) earningsMap.set(m[1].trim(), amt); }
    });
    if (!earningsMap.size) { dialog.showToast('No valid earnings lines. Format: "Player Name, 123456"', 'error'); return; }
    const ti = tournaments.findIndex(t => t.name === selectedTourney);
    const manualData = {
      name: selectedTourney, status: 'post', competitors: [],
      roundLeaders: {
        round1: manualEntry.round1Leaders.filter(l => l.trim()),
        round2: manualEntry.round2Leaders.filter(l => l.trim()),
        round3: manualEntry.round3Leaders.filter(l => l.trim()),
      },
      earningsMap, isManualEntry: true,
    };
    const names = teams.flatMap(t => t.roster.map(p => p.name));
    const { newTeams, newStats, resultsData } = processTournamentData(tournament, manualData, teams, globalPlayerStats, names);
    const newT = tournaments.map((nt, i) => i === ti ? { ...nt, completed: true, playing: false, results: resultsData } : nt);
    const nx = newT.findIndex((nt, i) => i > ti && !nt.completed && !nt.isAlternate);
    if (nx !== -1) { newT.forEach(nt => { nt.playing = false; }); newT[nx].playing = true; }
    // Also apply sfglEarnings from resultsData.teams directly onto roster
    const teamsWithSfgl = newTeams.map(team => {
      const teamResult = resultsData?.teams?.[team.id];
      if (!teamResult?.players) return team;
      const earningsByName = {};
      teamResult.players.forEach(p => { earningsByName[p.name || p] = (p.earnings || 0); });
      return { ...team, roster: team.roster.map(p => earningsByName[p.name] !== undefined ? { ...p, sfglEarnings: (p.sfglEarnings || 0) + earningsByName[p.name] } : p) };
    });
    updateTeams(teamsWithSfgl); setGlobalPlayerStats(newStats); setTournaments(newT);
    await storage.set(STORAGE_KEYS.TEAMS, teamsWithSfgl);
    await storage.set(STORAGE_KEYS.TOURNAMENTS, newT);
    await storage.set(STORAGE_KEYS.GLOBAL_PLAYER_STATS, newStats);
    sfglDataApi.set(STORAGE_KEYS.TEAMS, teamsWithSfgl).catch(() => {});
    dialog.showToast('Results processed! ' + earningsMap.size + ' players with earnings', 'success');
    setManualEntry({ round1Leaders: [''], round2Leaders: [''], round3Leaders: [''], playerEarnings: '' });
  };

  const RoundLeaderSelect = ({ label, leaders, onChange }) => {
    const players = teams.flatMap(team => (team.lineup || []).map(name => ({ name, team: team.name }))).sort((a, b) => a.name.localeCompare(b.name));
    return (
      <div style={{ flex: 1 }}>
        <div style={S.lbl}>{label}</div>
        {leaders.map((leader, idx) => (
          <div key={idx} style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
            <select value={leader} onChange={e => { const n = [...leaders]; n[idx] = e.target.value; onChange(n); }}
              style={{ ...theme.select, flex: 1, marginBottom: 0, fontSize: 12, padding: '7px 8px' }}>
              <option value="">(none)</option>
              {players.map(p => <option key={p.name + p.team} value={p.name}>{p.name} — {p.team}</option>)}
            </select>
            {idx > 0 && <button onClick={() => onChange(leaders.filter((_, i) => i !== idx))}
              style={{ background: 'none', border: `1px solid ${colors.dangerBorder}`, color: colors.danger, borderRadius: 2, padding: '4px 7px', cursor: 'pointer', fontSize: 11 }}>✕</button>}
          </div>
        ))}
        <button onClick={() => onChange([...leaders, ''])}
          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: colors.textGoldDim, padding: 0 }}>+ co-leader</button>
      </div>
    );
  };

  // ── Roster Management ────────────────────────────────────────────────────
  const handleAddPlayer = (teamId, name) => {
    updateTeams(teams.map(t => t.id === teamId ? { ...t, roster: [...t.roster, { name, limited: false, unlimited: false, stars: 0, starts: 0, eventsPlayed: 0, cutsMade: 0, pgaTourEarnings: 0, sfglEarnings: 0, headshot: '' }] } : t));
    dialog.showToast('Added ' + name, 'success');
  };
  const handleDropPlayer = async (teamId, name) => {
    const team = teams.find(t => t.id === teamId);
    if (!await dialog.showConfirm('Drop Player', 'Remove ' + name + ' from ' + team.name + '?', { type: 'danger', confirmText: 'Drop' })) return;
    updateTeams(teams.map(t => t.id === teamId ? { ...t, roster: t.roster.filter(p => p.name !== name) } : t));
    dialog.showToast('Dropped ' + name, 'success');
  };
  const resetMulligan = (teamId, type) => {
    const team = teams.find(t => t.id === teamId);
    updateTeams(teams.map(t => t.id === teamId ? { ...t, mulligans: { ...t.mulligans, [type === 'sig' ? 'signatureMajor' : 'regular']: 1 } } : t));
    dialog.showToast('Reset ' + type + ' mulligan for ' + team.name, 'success');
  };

  // ── Waivers ──────────────────────────────────────────────────────────────
  const buildRoster = (team) => {
    let r = team.roster.map(p => p.name);
    transactions.filter(tx => tx.team === team.name && tx.status === 'processed' && tx.type !== 'mulligan').forEach(tx => {
      if (tx.droppedPlayer) r = r.filter(n => n !== tx.droppedPlayer);
      if (!r.includes(tx.player)) r.push(tx.player);
    });
    return new Set(r);
  };
  const applyWaiver = (t, w) => {
    if (t.name !== w.team) return t;
    let r = [...t.roster];
    if (w.droppedPlayer) r = r.filter(p => p.name !== w.droppedPlayer);
    if (!r.some(p => p.name === w.player)) r.push({ name: w.player, limited: false, unlimited: false, stars: 0, starts: 0, eventsPlayed: 0, cutsMade: 0, pgaTourEarnings: 0, sfglEarnings: 0, headshot: '' });
    return { ...t, roster: r };
  };
  const handleProcessSingle = async (w) => {
    const allRostered = new Set(); teams.forEach(t => buildRoster(t).forEach(n => allRostered.add(n)));
    if (allRostered.has(w.player)) { dialog.showToast(w.player + ' already rostered', 'error'); return; }
    if (w.droppedPlayer && !buildRoster(teams.find(t => t.name === w.team) || {}).has(w.droppedPlayer)) {
      const tx2 = transactions.map((tx, i) => i === w._idx ? { ...tx, status: 'failed', failReason: w.droppedPlayer + ' already dropped', processedDate: new Date().toLocaleDateString() } : tx);
      setTransactions(tx2); await storage.set(STORAGE_KEYS.TRANSACTIONS, tx2);
      dialog.showToast(w.droppedPlayer + ' already dropped', 'error'); return;
    }
    const tx2 = transactions.map((tx, i) => i === w._idx ? { ...tx, status: 'processed', processedDate: new Date().toLocaleDateString() } : tx);
    const t2 = teams.map(t => applyWaiver(t, w));
    setTransactions(tx2); updateTeams(t2);
    await storage.set(STORAGE_KEYS.TRANSACTIONS, tx2); await storage.set(STORAGE_KEYS.TEAMS, t2);
    dialog.showToast(w.team + ' adds ' + w.player + (w.droppedPlayer ? ' / drops ' + w.droppedPlayer : ''), 'success');
  };
  const handleProcessAll = async (pending) => {
    if (!pending.length) return;
    if (!await dialog.showConfirm('Process All Waivers', 'Process ' + pending.length + ' pending claim' + (pending.length !== 1 ? 's' : '') + '?\n\nTie-breaker: reverse standings (lowest earnings = highest priority).', { confirmText: 'Process All' })) return;
    const pm = {}; [...teams].sort((a, b) => (a.earnings || 0) - (b.earnings || 0)).forEach((t, i) => { pm[t.name] = i; });
    const byTeam = {}; pending.forEach(w => { if (!byTeam[w.team]) byTeam[w.team] = []; byTeam[w.team].push(w); });
    Object.values(byTeam).forEach(c => c.sort((a, b) => (a.priority || 999) - (b.priority || 999)));
    const allR = new Set(); teams.forEach(t => buildRoster(t).forEach(n => allR.add(n)));
    const dropped = new Set(), done = new Set(), failed = new Set(), applied = [];
    const tx2 = [...transactions]; let p = 0, f = 0, more = true;
    while (more) {
      more = false;
      const round = []; Object.entries(byTeam).forEach(([tn, claims]) => { const top = claims.find(c => !done.has(c._idx) && !failed.has(c._idx)); if (top) round.push({ tn, claim: top, o: pm[tn] ?? 999 }); });
      if (!round.length) break;
      const byP = {}; round.forEach(rc => { if (!byP[rc.claim.player]) byP[rc.claim.player] = []; byP[rc.claim.player].push(rc); });
      Object.entries(byP).forEach(([player, cs]) => {
        cs.sort((a, b) => a.o - b.o); const w = cs[0];
        if (allR.has(player)) { cs.forEach(c => { failed.add(c.claim._idx); tx2[c.claim._idx] = { ...tx2[c.claim._idx], status: 'failed', failReason: 'Player already rostered', processedDate: new Date().toLocaleDateString() }; f++; }); more = true; return; }
        if (w.claim.droppedPlayer && (dropped.has(w.claim.droppedPlayer) || !allR.has(w.claim.droppedPlayer))) { failed.add(w.claim._idx); tx2[w.claim._idx] = { ...tx2[w.claim._idx], status: 'failed', failReason: w.claim.droppedPlayer + ' already dropped', processedDate: new Date().toLocaleDateString() }; f++; more = true; return; }
        if (w.claim.droppedPlayer) { allR.delete(w.claim.droppedPlayer); dropped.add(w.claim.droppedPlayer); }
        allR.add(player); done.add(w.claim._idx); tx2[w.claim._idx] = { ...tx2[w.claim._idx], status: 'processed', processedDate: new Date().toLocaleDateString() }; applied.push(w.claim); p++;
        cs.slice(1).forEach(l => { failed.add(l.claim._idx); tx2[l.claim._idx] = { ...tx2[l.claim._idx], status: 'failed', failReason: 'Lost tiebreaker to ' + w.tn, processedDate: new Date().toLocaleDateString() }; f++; }); more = true;
      });
    }
    let t2 = [...teams]; applied.forEach(w => { t2 = t2.map(t => applyWaiver(t, w)); });
    setTransactions(tx2); updateTeams(t2);
    await storage.set(STORAGE_KEYS.TRANSACTIONS, tx2); await storage.set(STORAGE_KEYS.TEAMS, t2);
    dialog.showToast('Processed ' + p + (f ? ' · ' + f + ' failed' : ''), p > 0 ? 'success' : 'error');
  };

  // ── Manager Login ────────────────────────────────────────────────────────
  const handleSetLogin = async () => {
    if (!mgCredTeam || !mgCredName || !mgCredPass) return;
    setMgCredSaving(true);
    try { await managerAuthApi.setCredentials(mgCredTeam, mgCredName, mgCredPass); dialog.showToast('Login set for ' + mgCredName, 'success'); setMgCredTeam(''); setMgCredName(''); setMgCredPass(''); }
    catch (e) { dialog.showToast('Failed: ' + e.message, 'error'); }
    setMgCredSaving(false);
  };

  // ── Push to Supabase ─────────────────────────────────────────────────────
  const handlePush = async () => {
    if (!await dialog.showConfirm('Push to Supabase', 'Overwrite the shared database with data from this device. All other devices update on next refresh.', { confirmText: 'Push' })) return;
    dialog.showToast('Pushing...', 'info');
    try {
      await Promise.all([sfglDataApi.set(STORAGE_KEYS.TEAMS, teams), sfglDataApi.set(STORAGE_KEYS.TOURNAMENTS, tournaments), sfglDataApi.set(STORAGE_KEYS.TRANSACTIONS, transactions), sfglDataApi.set(STORAGE_KEYS.SETTINGS, settings), sfglDataApi.set(STORAGE_KEYS.GLOBAL_PLAYER_STATS, globalPlayerStats)]);
      await Promise.all(tournaments.filter(t => t.completed && t.results).map(t => tournamentResultsApi.save({ tournamentName: t.name, teamResults: t.results.teams || {}, earningsMap: t.results.earningsMap || {}, roundLeaders: t.results.roundLeaders || {}, fullLineups: t.results.fullLineups || {} }).catch(() => {})));
      dialog.showToast('Pushed! Refresh mobile to sync.', 'success');
    } catch (e) { dialog.showToast('Push failed: ' + e.message, 'error'); }
  };

  // ── Recalculate Earnings ─────────────────────────────────────────────────
  const handleRecalc = async () => {
    const done = tournaments.filter(t => t.completed && t.results?.teams);
    if (!done.length) { dialog.showToast('No completed results found', 'error'); return; }
    if (!await dialog.showConfirm('Recalculate Earnings', 'Recompute all team earnings from completed results and fix the current tournament indicator.', { confirmText: 'Recalculate' })) return;
    const byTeam = {}; done.forEach(t => Object.entries(t.results.teams).forEach(([id, tr]) => { byTeam[id] = (byTeam[id] || 0) + (tr.totalEarnings || 0); }));
    const ut = teams.map(team => ({ ...team, earnings: byTeam[team.id] || 0, segmentEarnings: (() => { const sw = typeof getSegmentByDate === 'function' ? getSegmentByDate() : null; return done.filter(t => !sw || t.segment === sw).reduce((s, t) => s + (t.results?.teams?.[team.id]?.totalEarnings || 0), 0); })() }));
    const li = [...tournaments].map((t, i) => ({ t, i })).filter(({ t }) => t.completed).pop()?.i ?? -1;
    const nx = tournaments.findIndex((t, i) => i > li && !t.completed && !t.isAlternate);
    const ft = tournaments.map((t, i) => ({ ...t, playing: i === nx }));
    updateTeams(ut); setTournaments(ft);
    await storage.set(STORAGE_KEYS.TEAMS, ut); await storage.set(STORAGE_KEYS.TOURNAMENTS, ft);
    dialog.showToast('Recalculated · next up: ' + (ft[nx]?.name || 'none'), 'success');
  };

  // ── Season Reset ─────────────────────────────────────────────────────────
  const handleReset = async () => {
    if (!await dialog.showConfirm('Reset Entire Season', 'DELETE all results, transactions, rosters, lineups, and stats. Cannot be undone.', { type: 'danger', confirmText: 'Continue' })) return;
    if (!await dialog.showConfirm('Final Warning', 'Are you absolutely sure? This wipes everything.', { type: 'danger', confirmText: 'Yes, Reset Everything' })) return;
    updateTeams(teams.map(t => ({ ...t, earnings: 0, segmentEarnings: 0, lineup: [], roster: [], mulligans: { signatureMajor: 1, regular: 1 } })));
    setTournaments(tournaments.map((t, i) => ({ ...t, completed: false, playing: i === 0, results: null })));
    setTransactions([]); setGlobalPlayerStats({});
    dialog.showToast('Season reset complete.', 'success');
  };

  // ── Apply Mulligan (live, from Roster Management) ───────────────────────
  const handleApplyMulligan = async (teamId) => {
    if (!mulliganOut || !mulliganIn) return;
    const team = teams.find(t => t.id === teamId);
    const activeTournament = tournaments.find(t => t.playing);
    if (!team || !activeTournament) { dialog.showToast('No active tournament', 'error'); return; }

    const isSignatureOrMajor = activeTournament.isSignature || activeTournament.isMajor;
    const mulliganKey = isSignatureOrMajor ? 'signatureMajor' : 'regular';
    const remaining = team.mulligans?.[mulliganKey] ?? 0;
    if (remaining < 1) { dialog.showToast('No ' + (isSignatureOrMajor ? 'signature/major' : 'regular') + ' mulligans remaining', 'error'); return; }

    const ok = await dialog.showConfirm('Apply Mulligan',
      team.name + ': swap ' + mulliganOut + ' OUT → ' + mulliganIn + ' IN (after Round ' + mulliganRound + ')?\n\nDeducts one ' + (isSignatureOrMajor ? 'signature/major' : 'regular') + ' mulligan.',
      { confirmText: 'Apply Mulligan' });
    if (!ok) return;

    const newLineup = team.lineup.map(p => p === mulliganOut ? mulliganIn : p);
    const updatedRoster = team.roster.map(p => {
      if (p.name === mulliganOut && p.limited) return { ...p, starts: Math.max(0, p.starts - 1) };
      if (p.name === mulliganIn  && p.limited) return { ...p, starts: p.starts + 1 };
      return p;
    });
    const newMulligans = { ...team.mulligans, [mulliganKey]: remaining - 1 };
    const tournamentIndex = tournaments.findIndex(t => t.playing);
    const newTx = {
      team: team.name, type: 'mulligan', player: mulliganIn, droppedPlayer: mulliganOut,
      fee: 0, segment: activeTournament.segment || '', date: new Date().toLocaleDateString(),
      tournamentIndex, status: 'completed',
      mulliganType: isSignatureOrMajor ? 'signature/major' : 'regular',
      afterRound: parseInt(mulliganRound), tournament: activeTournament.name,
    };
    const newTeams = teams.map(t => t.id === teamId ? { ...t, lineup: newLineup, roster: updatedRoster, mulligans: newMulligans } : t);
    updateTeams(newTeams);
    setTransactions(prev => [...prev, newTx]);
    await storage.set(STORAGE_KEYS.TEAMS, newTeams);
    sfglDataApi.set(STORAGE_KEYS.TEAMS, newTeams).catch(() => {});
    await storage.set(STORAGE_KEYS.TRANSACTIONS, [...transactions, newTx]);

    dialog.showToast('Mulligan applied: ' + mulliganOut + ' → ' + mulliganIn, 'success');
    setMulliganMode(false); setMulliganOut(''); setMulliganIn(''); setMulliganRound('2');
  };

  // ── Retroactive Mulligan ────────────────────────────────────────────────
  const handleRetroMulligan = async () => {
    if (!retMulTeam || !retMulTourney || !retMulOut || !retMulIn) return;
    const team = teams.find(t => t.id === retMulTeam);
    const tournament = tournaments.find(t => t.name === retMulTourney);
    const tournamentIndex = tournaments.findIndex(t => t.name === retMulTourney);
    if (!team || !tournament) return;

    const mulliganKey = retMulType === 'sig' ? 'signatureMajor' : 'regular';
    const ok = await dialog.showConfirm('Apply Retroactive Mulligan',
      'Apply mulligan for ' + team.name + ' at ' + retMulTourney + '?\n\n' +
      retMulOut + ' OUT → ' + retMulIn + ' IN (after Round ' + retMulRound + ')\n\n' +
      'This will record the mulligan transaction and deduct one ' + retMulType + ' mulligan.',
      { confirmText: 'Apply Mulligan' });
    if (!ok) return;

    // Record transaction
    const newTx = {
      team: team.name, type: 'mulligan', player: retMulIn, droppedPlayer: retMulOut,
      fee: 0, segment: tournament.segment || '', date: new Date().toLocaleDateString(),
      tournamentIndex, status: 'completed',
      mulliganType: retMulType === 'sig' ? 'signature/major' : 'regular',
      afterRound: parseInt(retMulRound),
      tournament: retMulTourney,
      retroactive: true,
    };

    // Deduct mulligan from team
    const newMulligans = { ...team.mulligans, [mulliganKey]: Math.max(0, (team.mulligans?.[mulliganKey] || 1) - 1) };
    const updatedTeams = teams.map(t => t.id === team.id ? { ...t, mulligans: newMulligans } : t);

    updateTeams(updatedTeams);
    setTransactions(prev => [...prev, newTx]);
    await storage.set(STORAGE_KEYS.TEAMS, updatedTeams);

    dialog.showToast('Retroactive mulligan applied: ' + retMulOut + ' → ' + retMulIn, 'success');
    setRetMulTeam(''); setRetMulTourney(''); setRetMulOut(''); setRetMulIn(''); setRetMulType('regular'); setRetMulRound('2');
  };

  // ── Award Swing Winner ──────────────────────────────────────────────────
  const SWINGS = ['West Coast Swing', 'Spring Swing', 'Summer Swing', 'Fall Finish'];

  const handleSwingWinner = async () => {
    if (!swingAwardSeg) return;

    // Sum all transaction fees for this swing
    const pot = transactions
      .filter(tx => tx.segment === swingAwardSeg && (tx.fee || 0) > 0)
      .reduce((sum, tx) => sum + (tx.fee || 0), 0);

    if (pot === 0) {
      dialog.showToast('No fees collected for ' + swingAwardSeg, 'error');
      return;
    }

    // Find winner = highest segmentEarnings for this swing
    // segmentEarnings is calculated from completed tournaments in this swing
    const swingTournaments = tournaments.filter(t => t.completed && t.segment === swingAwardSeg && t.results?.teams);
    if (!swingTournaments.length) {
      dialog.showToast('No completed results found for ' + swingAwardSeg, 'error');
      return;
    }

    const byTeam = {};
    swingTournaments.forEach(t => {
      Object.entries(t.results.teams).forEach(([id, tr]) => {
        byTeam[id] = (byTeam[id] || 0) + (tr.totalEarnings || 0);
      });
    });

    const winnerEntry = Object.entries(byTeam).sort((a, b) => b[1] - a[1])[0];
    if (!winnerEntry) { dialog.showToast('Could not determine winner', 'error'); return; }
    const [winnerId, winnerEarnings] = winnerEntry;
    const winnerTeam = teams.find(t => t.id === winnerId);
    if (!winnerTeam) { dialog.showToast('Winner team not found', 'error'); return; }

    const msg = swingAwardSeg + ' complete. Winner: ' + winnerTeam.name + ' (' + winnerTeam.owner + '). Swing: $' + winnerEarnings.toLocaleString() + '. Pot: $' + pot.toLocaleString() + '. Award pot?';
    const ok = await dialog.showConfirm('Award Swing Winner', msg, { confirmText: 'Award $' + pot.toLocaleString() });
    if (!ok) return;

    const newTx = {
      team: winnerTeam.name, type: 'swing_winner', player: winnerTeam.owner,
      fee: 0, amount: pot, segment: swingAwardSeg,
      date: new Date().toLocaleDateString(), status: 'completed',
      note: swingAwardSeg + ' winner pot',
    };

    const newTeams = teams.map(t =>
      t.id === winnerId
        ? { ...t, earnings: (t.earnings || 0) + pot }
        : t
    );

    updateTeams(newTeams);
    setTransactions(prev => [...prev, newTx]);
    await storage.set(STORAGE_KEYS.TEAMS, newTeams);
    await storage.set(STORAGE_KEYS.TRANSACTIONS, [...transactions, newTx]);
    sfglDataApi.set(STORAGE_KEYS.TEAMS, newTeams).catch(() => {});

    dialog.showToast('🏆 ' + winnerTeam.name + ' awarded $' + pot.toLocaleString() + ' for ' + swingAwardSeg, 'success');
    setSwingAwardSeg('');
  };

  // ── Recalculate Starts from History ────────────────────────────────────
  const handleRecalcStarts = async () => {
    const completed = tournaments.filter(t => t.completed && t.results?.teams);
    if (!completed.length) { dialog.showToast('No completed tournaments to calculate from', 'error'); return; }

    const ok = await dialog.showConfirm(
      'Recalculate Limited Player Starts',
      'Rebuild each limited player start count from completed tournament history. This is the source of truth and overrides any manual counts.',
      { confirmText: 'Recalculate' }
    );
    if (!ok) return;

    // Build starts map: teamId → playerName → count
    const startsMap = {};
    teams.forEach(t => { startsMap[t.id] = {}; });

    completed.forEach(tourney => {
      Object.entries(tourney.results.teams).forEach(([teamId, teamResult]) => {
        if (!startsMap[teamId]) return;
        // results.teams[id].players contains the players who contributed to the score
        const players = teamResult.players || [];
        players.forEach(p => {
          const name = p.name || p;
          if (!startsMap[teamId][name]) startsMap[teamId][name] = 0;
          startsMap[teamId][name] += 1;
        });
      });
    });

    // Apply mulligan corrections:
    // A mulligan-OUT means that player was replaced mid-tournament —
    // processTournamentData uses the post-mulligan lineup, so playerOut is NOT
    // in results.players and doesn't need a deduction.
    // A mulligan-IN means the replacement IS in results.players → already counted.
    // So the results.players list IS already the post-mulligan truth. No correction needed.

    const newTeams = teams.map(team => {
      const tMap = startsMap[team.id] || {};
      const newRoster = team.roster.map(p => {
        if (!p.limited) return p;
        const computedStarts = tMap[p.name] || 0;
        return { ...p, starts: computedStarts };
      });
      return { ...team, roster: newRoster };
    });

    updateTeams(newTeams);
    await storage.set(STORAGE_KEYS.TEAMS, newTeams);
    sfglDataApi.set(STORAGE_KEYS.TEAMS, newTeams).catch(() => {});

    const totalFixed = teams.reduce((sum, team) => {
      return sum + team.roster.filter(p => p.limited).length;
    }, 0);
    dialog.showToast('Starts recalculated for ' + totalFixed + ' limited players across ' + completed.length + ' tournaments', 'success');
  };

  // ── Recalculate All Player Stats from History ──────────────────────────
  const handleRecalcAllStats = async () => {
    const completed = tournaments.filter(t => t.completed && t.results?.teams);
    if (!completed.length) { dialog.showToast('No completed tournaments found', 'error'); return; }

    const ok = await dialog.showConfirm(
      'Recalculate All Player Stats',
      'Rebuild Events, Cuts, Tour$, SFGL$, and Starts for every rostered player from completed tournament history.',
      { confirmText: 'Recalculate' }
    );
    if (!ok) return;

    // --- globalPlayerStats: {playerName: {eventsPlayed, cutsMade, pgaTourEarnings}}
    // sourced from results.earningsMap which has ALL players who made the cut
    const newGlobalStats = {};

    // --- per-roster sfglEarnings & starts: sourced from results.teams[id].players
    // {teamId: {playerName: {sfglEarnings, starts}}}
    const rosterStats = {};
    teams.forEach(t => { rosterStats[t.id] = {}; });

    completed.forEach(tourney => {
      const earningsMap = tourney.results.earningsMap || {};

      // PGA Tour stats from earningsMap (all players who earned money)
      Object.entries(earningsMap).forEach(([playerName, pgaEarnings]) => {
        if (!newGlobalStats[playerName]) {
          newGlobalStats[playerName] = { eventsPlayed: 0, cutsMade: 0, pgaTourEarnings: 0 };
        }
        newGlobalStats[playerName].eventsPlayed += 1;
        if (pgaEarnings > 0) newGlobalStats[playerName].cutsMade += 1;
        newGlobalStats[playerName].pgaTourEarnings += pgaEarnings;
      });

      // SFGL earnings & starts from each team result
      Object.entries(tourney.results.teams).forEach(([teamId, teamResult]) => {
        if (!rosterStats[teamId]) return;
        const players = teamResult.players || [];
        players.forEach(p => {
          const name = p.name || p;
          const sfgl = p.earnings || 0;
          if (!rosterStats[teamId][name]) rosterStats[teamId][name] = { sfglEarnings: 0, starts: 0 };
          rosterStats[teamId][name].sfglEarnings += sfgl;
          rosterStats[teamId][name].starts += 1;
        });
      });
    });

    // Apply to teams — update roster sfglEarnings and starts
    const newTeams = teams.map(team => {
      const tStats = rosterStats[team.id] || {};
      const newRoster = team.roster.map(p => {
        const ps = tStats[p.name] || { sfglEarnings: 0, starts: 0 };
        return {
          ...p,
          sfglEarnings: ps.sfglEarnings,
          starts: p.limited ? ps.starts : p.starts,
        };
      });
      return { ...team, roster: newRoster };
    });

    updateTeams(newTeams);
    setGlobalPlayerStats(newGlobalStats);
    await storage.set(STORAGE_KEYS.TEAMS, newTeams);
    await storage.set(STORAGE_KEYS.GLOBAL_PLAYER_STATS, newGlobalStats);
    sfglDataApi.set(STORAGE_KEYS.TEAMS, newTeams).catch(() => {});
    sfglDataApi.set(STORAGE_KEYS.GLOBAL_PLAYER_STATS, newGlobalStats).catch(() => {});

    const playerCount = Object.keys(newGlobalStats).length;
    dialog.showToast('Stats rebuilt from ' + completed.length + ' tournaments · ' + playerCount + ' players updated', 'success');
  };

  const pending = transactions.map((tx, idx) => ({ ...tx, _idx: idx })).filter(tx => tx.type === 'waiver' && tx.status === 'pending');
  const disabledBtn = (cond) => cond ? { opacity: 0.4, cursor: 'not-allowed' } : {};

  return (
    <div style={{ paddingBottom: 40 }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 18px', background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 4, marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Settings size={14} style={{ color: colors.textGoldDim }} />
          <span style={{ fontFamily: fonts.sans, fontSize: 11, fontWeight: 700, letterSpacing: '2px', textTransform: 'uppercase', color: colors.textGold }}>Commissioner</span>
        </div>
        <button onClick={() => { setIsCommissioner(false); setActiveTab('standings'); }} style={{ ...theme.btnDanger, padding: '6px 14px', fontSize: 11 }}>Logout</button>
      </div>

      {/* Tournament Results */}
      <div style={S.section}>
        <div style={S.title}>🏆 Tournament Results</div>
        <label style={S.lbl}>Tournament</label>
        <select value={selectedTourney} onChange={e => setSelectedTourney(e.target.value)} style={S.select}>
          <option value="">Choose tournament...</option>
          {tournaments.map(t => <option key={t.name} value={t.name}>{t.completed ? '✓ ' : t.playing ? '▶ ' : ''}{t.name}</option>)}
        </select>
        <button onClick={handleFetchApiResults} style={{ ...S.btn, marginBottom: 10 }}>⚡ Fetch from API</button>

        <div style={{ borderTop: `1px solid ${colors.borderSubtle}`, paddingTop: 12 }}>
          <div style={{ ...S.lbl, color: colors.textMuted, textAlign: 'center', marginBottom: 10 }}>— or enter manually —</div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <RoundLeaderSelect label="R1 Leader" leaders={manualEntry.round1Leaders} onChange={r => setManualEntry({ ...manualEntry, round1Leaders: r })} />
            <RoundLeaderSelect label="R2 Leader" leaders={manualEntry.round2Leaders} onChange={r => setManualEntry({ ...manualEntry, round2Leaders: r })} />
            <RoundLeaderSelect label="R3 Leader" leaders={manualEntry.round3Leaders} onChange={r => setManualEntry({ ...manualEntry, round3Leaders: r })} />
          </div>
          <label style={S.lbl}>Player Earnings <span style={{ ...theme.smallText, textTransform: 'none', letterSpacing: 0 }}>— one per line: Player Name, 123456</span></label>
          <textarea value={manualEntry.playerEarnings} onChange={e => setManualEntry({ ...manualEntry, playerEarnings: e.target.value })}
            placeholder={'Scottie Scheffler, 3600000\nRory McIlroy, 2160000'} rows={6}
            style={{ ...theme.input, fontFamily: fonts.mono, fontSize: 12, resize: 'vertical', marginBottom: 8 }} />
          <button onClick={handleManualEntry} disabled={!selectedTourney || !manualEntry.playerEarnings.trim()}
            style={{ ...S.btn, ...disabledBtn(!selectedTourney || !manualEntry.playerEarnings.trim()) }}>
            Process Manual Entry
          </button>
        </div>
      </div>

      {/* Waivers */}
      <div style={S.section}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={S.title}>⏰ Process Waivers</div>
          {pending.length > 0 && <span style={{ ...theme.badge, ...theme.badgeWarning }}>{pending.length} pending</span>}
        </div>
        {pending.length === 0 ? (
          <div style={{ ...theme.smallText, textAlign: 'center', padding: '8px 0', color: colors.success }}>✓ No pending waiver claims</div>
        ) : (
          <>
            <button onClick={() => handleProcessAll(pending)} style={{ ...S.btn, marginBottom: 8 }}>⚡ Process All ({pending.length})</button>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {pending.map(w => (
                <div key={w._idx} style={{ display: 'flex', alignItems: 'center', gap: 10, background: colors.inputBg, border: `1px solid ${colors.borderSubtle}`, borderRadius: 3, padding: '8px 12px' }}>
                  <div style={{ width: 20, height: 20, borderRadius: '50%', background: 'rgba(220,170,60,0.1)', border: '1px solid rgba(220,170,60,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, color: colors.warning, flexShrink: 0 }}>{w.priority || '?'}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: fonts.sans, fontSize: 12, fontWeight: 600, color: colors.textPrimary }}>{w.team}</div>
                    <div style={{ fontSize: 11 }}>
                      <span style={{ color: colors.earningsGreen }}>+{w.player}</span>
                      {w.droppedPlayer && <span style={{ color: colors.danger }}> / -{w.droppedPlayer}</span>}
                    </div>
                  </div>
                  <button onClick={() => handleProcessSingle(w)} style={{ ...theme.btnSecondary, padding: '5px 10px', fontSize: 11, flexShrink: 0 }}>Process</button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Roster Management */}
      <div style={S.section}>
        <div style={S.title}>👥 Roster Management</div>
        <label style={S.lbl}>Team</label>
        <select value={rosterMgmtTeam} onChange={e => { setRosterMgmtTeam(e.target.value); setPlayerSearch(''); }} style={S.select}>
          <option value="">Choose team...</option>
          {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        {rosterMgmtTeam && (() => {
          const team = teams.find(t => t.id === rosterMgmtTeam);
          const results = playerSearch.trim() ? allPlayers.filter(p => p.name.toLowerCase().includes(playerSearch.toLowerCase()) && !team.roster.some(r => r.name === p.name)).slice(0, 15) : [];
          return (
            <div>
              <div style={{ background: colors.inputBg, border: `1px solid ${colors.borderSubtle}`, borderRadius: 3, padding: '10px 12px', marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={S.lbl}>Mulligans</span>
                  <span style={{ ...theme.smallText }}>Sig: {team.mulligans?.signatureMajor ?? 0} · Reg: {team.mulligans?.regular ?? 0}</span>
                </div>
                <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                  <button onClick={() => resetMulligan(team.id, 'sig')} style={{ ...theme.btnSecondary, flex: 1, padding: '7px 10px', fontSize: 11 }}>Reset Sig</button>
                  <button onClick={() => resetMulligan(team.id, 'reg')} style={{ ...theme.btnSecondary, flex: 1, padding: '7px 10px', fontSize: 11 }}>Reset Reg</button>
                </div>
                {/* Apply Mulligan */}
                {(() => {
                  const activeTournament = tournaments.find(t => t.playing);
                  if (!activeTournament) return (
                    <div style={{ ...theme.smallText, color: colors.textMuted, textAlign: 'center', paddingTop: 4 }}>No active tournament — can't apply mulligan</div>
                  );
                  const isSignatureOrMajor = activeTournament.isSignature || activeTournament.isMajor;
                  const mulliganKey = isSignatureOrMajor ? 'signatureMajor' : 'regular';
                  const remaining = team.mulligans?.[mulliganKey] ?? 0;
                  const lineupPlayers = team.lineup || [];
                  const benchPlayers = (team.roster || []).map(p => p.name).filter(n => !lineupPlayers.includes(n));
                  return (
                    <div>
                      <button
                        onClick={() => { setMulliganMode(!mulliganMode); setMulliganOut(''); setMulliganIn(''); setMulliganRound('2'); }}
                        style={{ ...theme.btnSecondary, width: '100%', padding: '7px 10px', fontSize: 11, marginBottom: mulliganMode ? 8 : 0,
                          borderColor: mulliganMode ? colors.border : colors.borderInput,
                          color: mulliganMode ? colors.textGold : colors.textSecondary }}>
                        🚨 {mulliganMode ? 'Cancel Mulligan' : 'Apply Mulligan'} ({remaining} {isSignatureOrMajor ? 'sig' : 'reg'} left)
                      </button>
                      {mulliganMode && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <select value={mulliganOut} onChange={e => setMulliganOut(e.target.value)} style={{ ...S.select, marginBottom: 0 }}>
                            <option value="">Player OUT (from lineup)...</option>
                            {lineupPlayers.map(n => <option key={n} value={n}>{n}</option>)}
                          </select>
                          <select value={mulliganIn} onChange={e => setMulliganIn(e.target.value)} style={{ ...S.select, marginBottom: 0 }}>
                            <option value="">Player IN (from bench)...</option>
                            {benchPlayers.map(n => <option key={n} value={n}>{n}</option>)}
                          </select>
                          <div style={{ display: 'flex', gap: 4 }}>
                            {['1','2','3'].map(r => (
                              <button key={r} onClick={() => setMulliganRound(r)}
                                style={{ flex: 1, padding: '6px 0', borderRadius: 2, fontSize: 11, fontFamily: fonts.sans, fontWeight: 600, cursor: 'pointer',
                                  background: mulliganRound === r ? colors.buttonNavy : 'transparent',
                                  border: `1px solid ${mulliganRound === r ? colors.border : colors.borderInput}`,
                                  color: mulliganRound === r ? colors.textGold : colors.textSecondary }}>
                                R{r}
                              </button>
                            ))}
                          </div>
                          <button
                            onClick={() => handleApplyMulligan(team.id)}
                            disabled={!mulliganOut || !mulliganIn || remaining < 1}
                            style={{ ...theme.btnPrimary, padding: '8px 10px', fontSize: 11,
                              opacity: (!mulliganOut || !mulliganIn || remaining < 1) ? 0.4 : 1,
                              cursor: (!mulliganOut || !mulliganIn || remaining < 1) ? 'not-allowed' : 'pointer' }}>
                            Confirm Mulligan
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
              <div style={{ maxHeight: 200, overflowY: 'auto', border: `1px solid ${colors.borderSubtle}`, borderRadius: 3, marginBottom: 8 }}>
                {!team.roster.length
                  ? <div style={theme.emptyState}>No players on roster</div>
                  : team.roster.map(p => (
                    <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: `1px solid ${colors.borderSubtle}` }}>
                      <img src={'https://pga-tour-res.cloudflare.com/resources/photoplayer/' + (headshots[p.name] || 'default') + '.jpg'}
                        onError={e => { e.target.src = 'https://ui-avatars.com/api/?name=' + encodeURIComponent(p.name) + '&background=111d2e&color=9ca3af&size=28'; }}
                        alt="" style={{ width: 28, height: 28, borderRadius: '50%', objectFit: 'cover', border: `1px solid ${colors.borderSubtle}`, flexShrink: 0 }} />
                      <span style={{ fontFamily: fonts.sans, fontSize: 13, color: colors.textPrimary, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                      <button onClick={() => handleDropPlayer(team.id, p.name)} style={{ ...theme.btnDanger, padding: '4px 10px', fontSize: 11 }}>Drop</button>
                    </div>
                  ))
                }
              </div>
              <input type="text" placeholder="Search to add player..." value={playerSearch} onChange={e => setPlayerSearch(e.target.value)} style={S.input} />
              {results.length > 0 && (
                <div style={{ border: `1px solid ${colors.borderSubtle}`, borderRadius: 3, maxHeight: 160, overflowY: 'auto' }}>
                  {results.map(p => (
                    <button key={p.name} onClick={() => { handleAddPlayer(team.id, p.name); setPlayerSearch(''); }}
                      style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: 'none', border: 'none', borderBottom: `1px solid ${colors.borderSubtle}`, cursor: 'pointer', textAlign: 'left' }}
                      onMouseEnter={e => e.currentTarget.style.background = colors.rowHover}
                      onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                      <span style={{ fontFamily: fonts.sans, fontSize: 13, color: colors.textPrimary }}>{p.name}</span>
                      <span style={{ fontSize: 11, color: colors.earningsGreen, fontWeight: 700 }}>Add</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })()}
      </div>

      {/* Manager Login */}
      <div style={S.section}>
        <div style={S.title}>🔑 Manager Login</div>
        <label style={S.lbl}>Team</label>
        <select value={mgCredTeam} onChange={e => { setMgCredTeam(e.target.value); setMgCredName(teams.find(x => x.id === e.target.value)?.owner || ''); }} style={S.select}>
          <option value="">Select team...</option>
          {teams.map(t => <option key={t.id} value={t.id}>{t.name} — {t.owner}</option>)}
        </select>
        <input value={mgCredName} onChange={e => setMgCredName(e.target.value)} placeholder="Login name" style={S.input} />
        <input type="password" value={mgCredPass} onChange={e => setMgCredPass(e.target.value)} placeholder="Password" style={S.input} />
        <button onClick={handleSetLogin} disabled={mgCredSaving || !mgCredTeam || !mgCredName || !mgCredPass}
          style={{ ...S.btn, ...disabledBtn(mgCredSaving || !mgCredTeam || !mgCredName || !mgCredPass) }}>
          {mgCredSaving ? 'Saving...' : 'Set Login'}
        </button>
      </div>

      {/* Retroactive Mulligan */}
      <div style={S.section}>
        <div style={S.title}>🚨 Retroactive Mulligan</div>
        <div style={{ ...theme.smallText, marginBottom: 12 }}>
          Apply a missed mulligan to a completed tournament. Records the transaction and deducts one mulligan.
        </div>

        <label style={S.lbl}>Team</label>
        <select value={retMulTeam} onChange={e => { setRetMulTeam(e.target.value); setRetMulOut(''); setRetMulIn(''); }} style={S.select}>
          <option value="">Select team...</option>
          {teams.map(t => <option key={t.id} value={t.id}>{t.name} — {t.owner}</option>)}
        </select>

        <label style={S.lbl}>Tournament</label>
        <select value={retMulTourney} onChange={e => { setRetMulTourney(e.target.value); setRetMulOut(''); setRetMulIn(''); }} style={S.select}>
          <option value="">Select tournament...</option>
          {tournaments.filter(t => t.completed).map(t => (
            <option key={t.name} value={t.name}>✓ {t.name}</option>
          ))}
        </select>

        {retMulTeam && retMulTourney && (() => {
          const team = teams.find(t => t.id === retMulTeam);
          const tournament = tournaments.find(t => t.name === retMulTourney);
          // Try to pull lineup from that tournament's saved results; fall back to current roster
          const savedLineup = tournament?.results?.fullLineups?.[retMulTeam] || [];
          const lineupPlayers = savedLineup.length > 0 ? savedLineup : (team?.lineup || []);
          const rosterPlayers = team?.roster?.map(p => p.name) || [];
          // Bench = rostered players not in lineup
          const benchPlayers = rosterPlayers.filter(n => !lineupPlayers.includes(n));

          return (
            <div>
              <label style={S.lbl}>Player OUT <span style={{ ...theme.smallText, textTransform: 'none', letterSpacing: 0 }}>(was in lineup)</span></label>
              <select value={retMulOut} onChange={e => setRetMulOut(e.target.value)} style={S.select}>
                <option value="">Select player out...</option>
                {lineupPlayers.length > 0
                  ? lineupPlayers.map(name => <option key={name} value={name}>{name}</option>)
                  : rosterPlayers.map(name => <option key={name} value={name}>{name}</option>)
                }
              </select>

              <label style={S.lbl}>Player IN <span style={{ ...theme.smallText, textTransform: 'none', letterSpacing: 0 }}>(was on bench)</span></label>
              <select value={retMulIn} onChange={e => setRetMulIn(e.target.value)} style={S.select}>
                <option value="">Select player in...</option>
                {benchPlayers.length > 0
                  ? benchPlayers.map(name => <option key={name} value={name}>{name}</option>)
                  : rosterPlayers.filter(n => n !== retMulOut).map(name => <option key={name} value={name}>{name}</option>)
                }
              </select>
            </div>
          );
        })()}

        <label style={S.lbl}>Mulligan Type</label>
        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          {[['regular', 'Regular'], ['sig', 'Signature / Major']].map(([val, label]) => (
            <button key={val} onClick={() => setRetMulType(val)}
              style={{ flex: 1, padding: '8px 10px', borderRadius: 2, fontSize: 12, fontFamily: fonts.sans, fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s',
                background: retMulType === val ? colors.buttonNavy : 'transparent',
                border: `1px solid ${retMulType === val ? colors.border : colors.borderInput}`,
                color: retMulType === val ? colors.textGold : colors.textSecondary }}>
              {label}
            </button>
          ))}
        </div>

        <label style={S.lbl}>Takes effect after round</label>
        <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
          {['1', '2', '3'].map(r => (
            <button key={r} onClick={() => setRetMulRound(r)}
              style={{ flex: 1, padding: '8px 10px', borderRadius: 2, fontSize: 12, fontFamily: fonts.sans, fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s',
                background: retMulRound === r ? colors.buttonNavy : 'transparent',
                border: `1px solid ${retMulRound === r ? colors.border : colors.borderInput}`,
                color: retMulRound === r ? colors.textGold : colors.textSecondary }}>
              Round {r}
            </button>
          ))}
        </div>

        <button onClick={handleRetroMulligan}
          disabled={!retMulTeam || !retMulTourney || !retMulOut || !retMulIn}
          style={{ ...S.btn, ...disabledBtn(!retMulTeam || !retMulTourney || !retMulOut || !retMulIn) }}>
          Apply Retroactive Mulligan
        </button>
      </div>

      {/* Draft */}
      <div style={S.section}>
        <div style={S.title}>🎯 Draft</div>
        <button onClick={() => setShowDraftModal(true)} style={S.btn}>Open Draft Room</button>
      </div>

      {/* Data & Sync */}
      <div style={S.section}>
        <div style={S.title}>☁️ Data & Sync</div>
        <button onClick={handlePush} style={{ ...S.btn, marginBottom: 8 }}>☁️ Push to Supabase (sync all devices)</button>
        <button onClick={handleRecalc} style={{ ...S.btnSec, marginBottom: 8 }}>📊 Recalculate Earnings from Results</button>
        <button onClick={handleRecalcAllStats} style={{ ...S.btnSec, marginBottom: 8 }}>📈 Recalculate All Player Stats (Events/Cuts/Tour$/SFGL$)</button>
        <button onClick={handleRecalcStarts} style={S.btnSec}>⭐ Recalculate Limited Player Starts</button>
      </div>

      {/* Swing Winner */}
      <div style={S.section}>
        <div style={S.title}>🏆 Award Swing Winner</div>
        <div style={{ ...theme.smallText, marginBottom: 10 }}>
          When a swing is complete, award the fee pot to the swing leader.
        </div>
        <label style={S.lbl}>Swing</label>
        <select value={swingAwardSeg} onChange={e => setSwingAwardSeg(e.target.value)} style={S.select}>
          <option value="">Select swing...</option>
          {SWINGS.map(s => {
            const pot = transactions.filter(tx => tx.segment === s && (tx.fee || 0) > 0).reduce((sum, tx) => sum + tx.fee, 0);
            const alreadyAwarded = transactions.some(tx => tx.type === 'swing_winner' && tx.segment === s);
            return (
              <option key={s} value={s} disabled={alreadyAwarded}>
                {s}{pot > 0 ? ' · $' + pot.toLocaleString() + ' pot' : ''}{alreadyAwarded ? ' ✓ awarded' : ''}
              </option>
            );
          })}
        </select>
        {swingAwardSeg && (() => {
          const pot = transactions.filter(tx => tx.segment === swingAwardSeg && (tx.fee || 0) > 0).reduce((sum, tx) => sum + tx.fee, 0);
          const swingTourneys = tournaments.filter(t => t.completed && t.segment === swingAwardSeg && t.results?.teams);
          const byTeam = {};
          swingTourneys.forEach(t => Object.entries(t.results.teams).forEach(([id, tr]) => { byTeam[id] = (byTeam[id] || 0) + (tr.totalEarnings || 0); }));
          const topEntry = Object.entries(byTeam).sort((a, b) => b[1] - a[1])[0];
          const leader = topEntry ? teams.find(t => t.id === topEntry[0]) : null;
          return (
            <div style={{ ...theme.smallText, marginBottom: 10, padding: '8px 10px', background: colors.inputBg, borderRadius: 3, border: `1px solid ${colors.borderSubtle}` }}>
              {leader
                ? <span>🏆 Leader: <span style={{ color: colors.textGold, fontWeight: 600 }}>{leader.name}</span> · ${(topEntry[1] || 0).toLocaleString()} swing earnings · <span style={{ color: colors.earningsGreen }}>Pot: ${pot.toLocaleString()}</span></span>
                : <span style={{ color: colors.textMuted }}>No completed results for this swing yet</span>
              }
            </div>
          );
        })()}
        <button onClick={handleSwingWinner} disabled={!swingAwardSeg}
          style={{ ...S.btn, ...disabledBtn(!swingAwardSeg) }}>
          🏆 Award Swing Winner
        </button>
      </div>

      {/* Danger Zone */}
      <div style={{ ...S.section, borderColor: colors.dangerBorder, background: colors.dangerBg }}>
        <div style={{ ...S.title, color: colors.danger }}>⚠ Danger Zone</div>
        <div style={{ ...theme.smallText, marginBottom: 12 }}>Permanently deletes all results, rosters, transactions, and stats.</div>
        <button onClick={handleReset} style={S.btnDgr}>🔥 Reset Entire Season</button>
      </div>

      {showDraftModal && <DraftModal teams={teams} allPlayers={allPlayers} updateTeams={updateTeams} onClose={() => setShowDraftModal(false)} headshots={headshots} />}
    </div>
  );
};
