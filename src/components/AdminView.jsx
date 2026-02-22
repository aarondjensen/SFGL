import React, { useState } from 'react';
import { Settings } from 'lucide-react';
import { useDialog } from './DialogContext';
import { slashGolfFetch, processTournamentData, getSegmentByDate } from '../utils';
import { storage } from '../api';
import { managerAuthApi, tournamentResultsApi, sfglDataApi } from '../api/supabase';

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
  const [rosterMgmtTeam, setRosterMgmtTeam] = useState('');
  const [playerSearch, setPlayerSearch] = useState('');
  const [mgCredTeam, setMgCredTeam] = useState('');
  const [mgCredName, setMgCredName] = useState('');
  const [mgCredPass, setMgCredPass] = useState('');
  const [mgCredSaving, setMgCredSaving] = useState(false);
  const dialog = useDialog();

  // Auto-select the active tournament
  React.useEffect(() => {
    const active = tournaments.find(t => t.playing);
    if (active && !selectedTourney) setSelectedTourney(active.name);
  }, [tournaments, selectedTourney]);

  // ── Tournament Results ───────────────────────────────────────────────────
  const handleFetchApiResults = async () => {
    if (!selectedTourney) { dialog.showToast('Select a tournament first', 'error'); return; }
    const tournIndex = tournaments.findIndex(t => t.name === selectedTourney);
    const t = tournaments[tournIndex];
    if (!t?.slashGolfId) { dialog.showToast('No API ID for this tournament. Check schedule.', 'error'); return; }
    if (t.completed) {
      const ok = await dialog.showConfirm('Already Processed',
        'Re-fetching will ADD earnings again (doubling them). Are you sure?',
        { type: 'danger', confirmText: 'Force Re-Fetch' });
      if (!ok) return;
    }
    try {
      dialog.showToast(`Fetching ${t.name}...`, 'info');
      let data = await slashGolfFetch('leaderboard', { tournId: t.slashGolfId, year: '2026' });
      let apiPlayers = data.leaderboardRows || data.leaderboard || data.results || [];
      if (apiPlayers.length === 0) { dialog.showToast('No results found in API yet.', 'error'); return; }
      try {
        const earningsData = await slashGolfFetch('earnings', { tournId: t.slashGolfId, year: '2026' });
        const ep = earningsData.leaderboard || earningsData.earnings || earningsData.results || [];
        if (ep.length > 0) apiPlayers = apiPlayers.map(lp => ({ ...lp, earnings: ep.find(e => e.playerId === lp.playerId)?.earnings || 0 }));
      } catch (e) { /* earnings endpoint optional */ }
      const rosteredNames = teams.flatMap(t => t.roster.map(p => p.name));
      const { newTeams, newStats, resultsData } = processTournamentData(t, apiPlayers, teams, globalPlayerStats, rosteredNames);
      const newTournaments = tournaments.map((nt, idx) =>
        idx === tournIndex ? { ...nt, completed: true, playing: false, results: resultsData } : nt
      );
      const nextIdx = newTournaments.findIndex((nt, idx) => idx > tournIndex && !nt.completed && !nt.isAlternate);
      if (nextIdx !== -1) { newTournaments.forEach(nt => { nt.playing = false; }); newTournaments[nextIdx].playing = true; }
      updateTeams(newTeams);
      setGlobalPlayerStats(newStats);
      setTournaments(newTournaments);
      dialog.showToast(`Results processed for ${t.name}!`, 'success');
    } catch (err) {
      dialog.showToast(`API Error: ${err.message}`, 'error');
    }
  };

  // ── Roster Management ────────────────────────────────────────────────────
  const handleAddPlayer = (teamId, playerName) => {
    updateTeams(teams.map(t => t.id === teamId ? {
      ...t, roster: [...t.roster, { name: playerName, limited: false, unlimited: false, stars: 0, starts: 0, eventsPlayed: 0, cutsMade: 0, pgaTourEarnings: 0, sfglEarnings: 0, headshot: '' }]
    } : t));
    dialog.showToast(`Added ${playerName}`, 'success');
  };

  const handleDropPlayer = async (teamId, playerName) => {
    const team = teams.find(t => t.id === teamId);
    const ok = await dialog.showConfirm('Drop Player', `Remove ${playerName} from ${team.name}?`, { type: 'danger', confirmText: 'Drop Player' });
    if (!ok) return;
    updateTeams(teams.map(t => t.id === teamId ? { ...t, roster: t.roster.filter(p => p.name !== playerName) } : t));
    dialog.showToast(`Dropped ${playerName}`, 'success');
  };

  const resetMulligan = (teamId, type) => {
    const team = teams.find(t => t.id === teamId);
    const key = type === 'sig' ? 'signatureMajor' : 'regular';
    updateTeams(teams.map(t => t.id === teamId ? { ...t, mulligans: { ...t.mulligans, [key]: 1 } } : t));
    dialog.showToast(`Reset ${type} mulligan for ${team.name}`, 'success');
  };

  // ── Waiver Processing ────────────────────────────────────────────────────
  const buildEffectiveRoster = (team) => {
    let roster = team.roster.map(p => p.name);
    transactions.filter(tx => tx.team === team.name && tx.status === 'processed' && tx.type !== 'mulligan')
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
    if (!newRoster.some(p => p.name === waiver.player))
      newRoster.push({ name: waiver.player, limited: false, unlimited: false, stars: 0, starts: 0, eventsPlayed: 0, cutsMade: 0, pgaTourEarnings: 0, sfglEarnings: 0, headshot: '' });
    return { ...t, roster: newRoster };
  };

  const handleProcessSingleWaiver = async (waiver) => {
    const allRostered = new Set();
    teams.forEach(t => buildEffectiveRoster(t).forEach(n => allRostered.add(n)));
    if (allRostered.has(waiver.player)) { dialog.showToast(waiver.player + ' already rostered', 'error'); return; }
    if (waiver.droppedPlayer) {
      const teamRoster = buildEffectiveRoster(teams.find(t => t.name === waiver.team) || {});
      if (!teamRoster.has(waiver.droppedPlayer)) {
        const updatedTx = transactions.map((tx, i) => i === waiver._idx
          ? { ...tx, status: 'failed', failReason: waiver.droppedPlayer + ' already dropped', processedDate: new Date().toLocaleDateString() } : tx);
        setTransactions(updatedTx);
        await storage.set(STORAGE_KEYS.TRANSACTIONS, updatedTx);
        dialog.showToast(waiver.droppedPlayer + ' already dropped — claim failed', 'error'); return;
      }
    }
    const updatedTx = transactions.map((tx, i) => i === waiver._idx
      ? { ...tx, status: 'processed', processedDate: new Date().toLocaleDateString() } : tx);
    const updatedTeams = teams.map(t => applyWaiverToTeam(t, waiver));
    setTransactions(updatedTx);
    updateTeams(updatedTeams);
    await storage.set(STORAGE_KEYS.TRANSACTIONS, updatedTx);
    await storage.set(STORAGE_KEYS.TEAMS, updatedTeams);
    dialog.showToast('Processed: ' + waiver.team + ' adds ' + waiver.player + (waiver.droppedPlayer ? ' / drops ' + waiver.droppedPlayer : ''), 'success');
  };

  const handleProcessAllWaivers = async (allPendingWaivers) => {
    if (!allPendingWaivers.length) return;
    const ok = await dialog.showConfirm('Process All Waivers',
      'Process ' + allPendingWaivers.length + ' pending claim' + (allPendingWaivers.length !== 1 ? 's' : '') + '?\n\nTie-breaker: reverse standings order (lowest earnings = highest priority).',
      { confirmText: 'Process ' + allPendingWaivers.length + ' Waiver' + (allPendingWaivers.length !== 1 ? 's' : '') });
    if (!ok) return;
    const standingsOrder = [...teams].sort((a, b) => (a.earnings || 0) - (b.earnings || 0));
    const teamPriorityMap = {};
    standingsOrder.forEach((t, i) => { teamPriorityMap[t.name] = i; });
    const waiversByTeam = {};
    allPendingWaivers.forEach(w => { if (!waiversByTeam[w.team]) waiversByTeam[w.team] = []; waiversByTeam[w.team].push(w); });
    Object.values(waiversByTeam).forEach(claims => claims.sort((a, b) => (a.priority || 999) - (b.priority || 999)));
    const allRostered = new Set();
    teams.forEach(t => buildEffectiveRoster(t).forEach(n => allRostered.add(n)));
    const alreadyDropped = new Set();
    let processedCount = 0, failedCount = 0;
    const updatedTx = [...transactions];
    const processedIdxs = new Set(), failedIdxs = new Set();
    const appliedWaivers = [];
    let moreToProcess = true;
    while (moreToProcess) {
      moreToProcess = false;
      const roundClaims = [];
      Object.entries(waiversByTeam).forEach(([teamName, claims]) => {
        const top = claims.find(c => !processedIdxs.has(c._idx) && !failedIdxs.has(c._idx));
        if (top) roundClaims.push({ teamName, claim: top, waiverOrder: teamPriorityMap[teamName] ?? 999 });
      });
      if (!roundClaims.length) break;
      const byPlayer = {};
      roundClaims.forEach(rc => { if (!byPlayer[rc.claim.player]) byPlayer[rc.claim.player] = []; byPlayer[rc.claim.player].push(rc); });
      Object.entries(byPlayer).forEach(([playerName, contestants]) => {
        contestants.sort((a, b) => a.waiverOrder - b.waiverOrder);
        const winner = contestants[0];
        if (allRostered.has(playerName)) {
          contestants.forEach(c => { failedIdxs.add(c.claim._idx); updatedTx[c.claim._idx] = { ...updatedTx[c.claim._idx], status: 'failed', failReason: 'Player already rostered', processedDate: new Date().toLocaleDateString() }; failedCount++; });
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
    dialog.showToast('Processed ' + processedCount + ' waiver' + (processedCount !== 1 ? 's' : '') + (failedCount > 0 ? ' · ' + failedCount + ' failed' : ''), processedCount > 0 ? 'success' : 'error');
  };

  // ── Manager Login ────────────────────────────────────────────────────────
  const handleSetManagerCredentials = async () => {
    if (!mgCredTeam || !mgCredName || !mgCredPass) return;
    setMgCredSaving(true);
    try {
      await managerAuthApi.setCredentials(mgCredTeam, mgCredName, mgCredPass);
      dialog.showToast('Login set for ' + mgCredName, 'success');
      setMgCredTeam(''); setMgCredName(''); setMgCredPass('');
    } catch (e) { dialog.showToast('Failed: ' + e.message, 'error'); }
    setMgCredSaving(false);
  };

  // ── Sync / Repair ────────────────────────────────────────────────────────
  const handlePushToSupabase = async () => {
    const ok = await dialog.showConfirm('Push to Supabase',
      'Overwrite the shared database with data from this device. All other devices will see it on next refresh.',
      { confirmText: 'Push to Supabase' });
    if (!ok) return;
    dialog.showToast('Pushing...', 'info');
    try {
      await Promise.all([
        sfglDataApi.set(STORAGE_KEYS.TEAMS, teams),
        sfglDataApi.set(STORAGE_KEYS.TOURNAMENTS, tournaments),
        sfglDataApi.set(STORAGE_KEYS.TRANSACTIONS, transactions),
        sfglDataApi.set(STORAGE_KEYS.SETTINGS, settings),
        sfglDataApi.set(STORAGE_KEYS.GLOBAL_PLAYER_STATS, globalPlayerStats),
      ]);
      const completed = tournaments.filter(t => t.completed && t.results);
      await Promise.all(completed.map(t =>
        tournamentResultsApi.save({ tournamentName: t.name, teamResults: t.results.teams || {}, earningsMap: t.results.earningsMap || {}, roundLeaders: t.results.roundLeaders || {}, fullLineups: t.results.fullLineups || {} }).catch(() => {})
      ));
      dialog.showToast('Pushed! Refresh mobile to see results.', 'success');
    } catch (e) { dialog.showToast('Push failed: ' + e.message, 'error'); }
  };

  const handleRecalcEarnings = async () => {
    const completedWithResults = tournaments.filter(t => t.completed && t.results?.teams);
    if (!completedWithResults.length) { dialog.showToast('No completed results found', 'error'); return; }
    const ok = await dialog.showConfirm('Recalculate Earnings',
      'Recompute all team earnings from completed results and fix the current tournament indicator.',
      { confirmText: 'Recalculate' });
    if (!ok) return;
    const earningsByTeam = {};
    completedWithResults.forEach(tourn => {
      Object.entries(tourn.results.teams).forEach(([id, tr]) => {
        earningsByTeam[id] = (earningsByTeam[id] || 0) + (tr.totalEarnings || 0);
      });
    });
    const updatedTeams = teams.map(team => ({
      ...team,
      earnings: earningsByTeam[team.id] || 0,
      segmentEarnings: (() => {
        const swing = typeof getSegmentByDate === 'function' ? getSegmentByDate() : null;
        return completedWithResults
          .filter(t => !swing || t.segment === swing)
          .reduce((sum, t) => sum + (t.results?.teams?.[team.id]?.totalEarnings || 0), 0);
      })(),
    }));
    const lastCompletedIdx = [...tournaments].map((t, i) => ({ t, i })).filter(({ t }) => t.completed).pop()?.i ?? -1;
    const nextIdx = tournaments.findIndex((t, i) => i > lastCompletedIdx && !t.completed && !t.isAlternate);
    const fixedTournaments = tournaments.map((t, i) => ({ ...t, playing: i === nextIdx }));
    updateTeams(updatedTeams);
    setTournaments(fixedTournaments);
    await storage.set(STORAGE_KEYS.TEAMS, updatedTeams);
    await storage.set(STORAGE_KEYS.TOURNAMENTS, fixedTournaments);
    dialog.showToast('Recalculated · next up: ' + (fixedTournaments[nextIdx]?.name || 'none'), 'success');
  };

  // ── Season Reset ─────────────────────────────────────────────────────────
  const handleSeasonReset = async () => {
    const c1 = await dialog.showConfirm('⚠️ Reset Entire Season',
      'This will DELETE all results, transactions, rosters, lineups, and stats. Cannot be undone.',
      { type: 'danger', confirmText: 'Continue' });
    if (!c1) return;
    const c2 = await dialog.showConfirm('⚠️ Final Warning',
      'Are you ABSOLUTELY SURE? This wipes everything.',
      { type: 'danger', confirmText: 'Yes, Reset Everything' });
    if (!c2) return;
    updateTeams(teams.map(t => ({ ...t, earnings: 0, segmentEarnings: 0, lineup: [], roster: [], mulligans: { signatureMajor: 1, regular: 1 } })));
    setTournaments(tournaments.map((t, i) => ({ ...t, completed: false, playing: i === 0, results: null })));
    setTransactions([]);
    setGlobalPlayerStats({});
    dialog.showToast('Season reset complete.', 'success');
  };

  // ── UI ───────────────────────────────────────────────────────────────────
  const pendingWaivers = transactions.map((tx, idx) => ({ ...tx, _idx: idx })).filter(tx => tx.type === 'waiver' && tx.status === 'pending');

  const Btn = ({ onClick, children, variant = 'default', disabled, className = '' }) => {
    const base = 'w-full py-2.5 rounded-lg text-sm font-bold transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
    const variants = {
      default:  'bg-gray-700 hover:bg-gray-600 text-white',
      primary:  'bg-blue-600 hover:bg-blue-500 text-white',
      green:    'bg-green-800/40 hover:bg-green-700/50 border border-green-600/40 text-green-300',
      amber:    'bg-amber-800/40 hover:bg-amber-700/50 border border-amber-600/40 text-amber-300',
      danger:   'bg-red-600 hover:bg-red-700 text-white',
    };
    return <button onClick={onClick} disabled={disabled} className={`${base} ${variants[variant]} ${className}`}>{children}</button>;
  };

  const Section = ({ title, children, color = 'gray' }) => {
    const borders = { gray: 'border-gray-700 bg-gray-800/40', blue: 'border-blue-700/40 bg-blue-900/10', yellow: 'border-yellow-700/40 bg-yellow-900/10', red: 'border-red-700/40 bg-red-900/10', purple: 'border-purple-700/40 bg-purple-900/10' };
    const titles = { gray: 'text-gray-300', blue: 'text-blue-400', yellow: 'text-yellow-400', red: 'text-red-400', purple: 'text-purple-400' };
    return (
      <div className={`border rounded-xl p-4 ${borders[color]}`}>
        <h3 className={`font-bold text-sm mb-3 ${titles[color]}`}>{title}</h3>
        {children}
      </div>
    );
  };

  return (
    <div className="space-y-4 pb-8">

      {/* Header */}
      <div className="flex justify-between items-center bg-gray-800/50 p-4 rounded-xl border border-gray-700">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <Settings className="w-4 h-4 text-gray-400" /> Commissioner
        </h2>
        <button onClick={() => { setIsCommissioner(false); setActiveTab('standings'); }}
          className="bg-red-600 hover:bg-red-700 px-3 py-1.5 rounded-lg text-sm font-bold transition-colors">
          Logout
        </button>
      </div>

      {/* Tournament Results */}
      <Section title="🏆 Tournament Results" color="blue">
        <select value={selectedTourney} onChange={e => setSelectedTourney(e.target.value)}
          className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-sm mb-2">
          <option value="">Select tournament...</option>
          {tournaments.map(t => (
            <option key={t.name} value={t.name}>
              {t.completed ? '✓ ' : t.playing ? '▶ ' : ''}{t.name}
            </option>
          ))}
        </select>
        <Btn onClick={handleFetchApiResults} variant="primary">⚡ Fetch Results from API</Btn>
      </Section>

      {/* Process Waivers */}
      <Section title={`⏰ Process Waivers${pendingWaivers.length > 0 ? ` (${pendingWaivers.length})` : ''}`} color={pendingWaivers.length > 0 ? 'yellow' : 'gray'}>
        {pendingWaivers.length === 0 ? (
          <p className="text-center text-green-400 text-sm py-2">✅ No pending claims</p>
        ) : (
          <>
            <Btn onClick={() => handleProcessAllWaivers(pendingWaivers)} variant="amber" className="mb-3">
              ⚡ Process All ({pendingWaivers.length})
            </Btn>
            <div className="space-y-2">
              {pendingWaivers.map(w => (
                <div key={w._idx} className="flex items-center gap-2 bg-gray-900/50 border border-gray-700/50 rounded-lg px-3 py-2">
                  <div className="w-5 h-5 rounded-full bg-yellow-900/50 border border-yellow-600/40 flex items-center justify-center text-yellow-300 text-[10px] font-bold flex-shrink-0">
                    {w.priority || '?'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold text-white">{w.team}</div>
                    <div className="text-[11px] text-gray-400">
                      <span className="text-green-400">+{w.player}</span>
                      {w.droppedPlayer && <span className="text-red-400"> / -{w.droppedPlayer}</span>}
                    </div>
                  </div>
                  <button onClick={() => handleProcessSingleWaiver(w)}
                    className="px-2 py-1 bg-green-700/30 hover:bg-green-700/50 border border-green-600/40 rounded text-[11px] font-bold text-green-300 transition-colors flex-shrink-0">
                    Process
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </Section>

      {/* Roster Management */}
      <Section title="👥 Roster Management" color="purple">
        <select value={rosterMgmtTeam} onChange={e => { setRosterMgmtTeam(e.target.value); setPlayerSearch(''); }}
          className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-sm mb-3">
          <option value="">Select team...</option>
          {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>

        {rosterMgmtTeam && (() => {
          const team = teams.find(t => t.id === rosterMgmtTeam);
          const searchResults = playerSearch.trim()
            ? allPlayers.filter(p => p.name.toLowerCase().includes(playerSearch.toLowerCase()) && !team.roster.some(r => r.name === p.name)).slice(0, 15)
            : [];
          return (
            <div className="space-y-3">
              {/* Mulligans */}
              <div className="bg-gray-900/40 rounded-lg p-3 border border-gray-700/50">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-bold text-gray-400">Mulligans</span>
                  <span className="text-[10px] text-gray-500">Sig: {team.mulligans?.signatureMajor ?? 0} · Reg: {team.mulligans?.regular ?? 0}</span>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => resetMulligan(team.id, 'sig')} className="flex-1 py-1.5 bg-purple-700 hover:bg-purple-600 rounded text-xs font-bold transition-colors">Reset Signature</button>
                  <button onClick={() => resetMulligan(team.id, 'reg')} className="flex-1 py-1.5 bg-gray-600 hover:bg-gray-500 rounded text-xs font-bold transition-colors">Reset Regular</button>
                </div>
              </div>

              {/* Roster list */}
              <div className="max-h-52 overflow-y-auto bg-gray-900/40 rounded-lg border border-gray-700/50">
                {team.roster.length === 0 ? (
                  <p className="text-center text-gray-500 text-xs py-4">No players on roster</p>
                ) : team.roster.map(player => (
                  <div key={player.name} className="flex items-center gap-2 px-3 py-2 border-b border-gray-700/40 last:border-0">
                    <img src={`https://pga-tour-res.cloudflare.com/resources/photoplayer/${headshots[player.name] || 'default'}.jpg`}
                      onError={e => { e.target.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(player.name)}&background=1f2937&color=9ca3af&size=28`; }}
                      alt="" className="w-7 h-7 rounded-full object-cover border border-gray-600 flex-shrink-0" />
                    <span className="text-sm flex-1 truncate">{player.name}</span>
                    <button onClick={() => handleDropPlayer(team.id, player.name)}
                      className="px-2 py-1 bg-red-600/70 hover:bg-red-600 rounded text-xs font-bold flex-shrink-0">Drop</button>
                  </div>
                ))}
              </div>

              {/* Add player */}
              <div>
                <input type="text" placeholder="Search to add player..." value={playerSearch}
                  onChange={e => setPlayerSearch(e.target.value)}
                  className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-sm" />
                {searchResults.length > 0 && (
                  <div className="mt-1 max-h-40 overflow-y-auto bg-gray-900 rounded-lg border border-gray-700">
                    {searchResults.map(player => (
                      <button key={player.name} onClick={() => { handleAddPlayer(team.id, player.name); setPlayerSearch(''); }}
                        className="w-full flex items-center justify-between px-3 py-2 hover:bg-gray-800 border-b border-gray-700/40 last:border-0 transition-colors text-left">
                        <span className="text-sm">{player.name}</span>
                        <span className="text-green-400 text-xs font-bold">Add</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })()}
      </Section>

      {/* Manager Logins */}
      <Section title="🔑 Manager Login" color="blue">
        <div className="space-y-2">
          <select value={mgCredTeam} onChange={e => { setMgCredTeam(e.target.value); const t = teams.find(x => x.id === e.target.value); setMgCredName(t?.owner || ''); }}
            className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-sm">
            <option value="">Select team...</option>
            {teams.map(t => <option key={t.id} value={t.id}>{t.name} — {t.owner}</option>)}
          </select>
          <input value={mgCredName} onChange={e => setMgCredName(e.target.value)} placeholder="Login name"
            className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-sm" />
          <input type="password" value={mgCredPass} onChange={e => setMgCredPass(e.target.value)} placeholder="Password"
            className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-sm" />
          <Btn onClick={handleSetManagerCredentials} disabled={mgCredSaving || !mgCredTeam || !mgCredName || !mgCredPass} variant="primary">
            {mgCredSaving ? 'Saving...' : 'Set Login'}
          </Btn>
        </div>
      </Section>

      {/* Data Tools */}
      <Section title="☁️ Data & Sync" color="gray">
        <div className="space-y-2">
          <Btn onClick={handlePushToSupabase} variant="green">☁️ Push to Supabase (sync all devices)</Btn>
          <Btn onClick={handleRecalcEarnings} variant="amber">📊 Recalculate Earnings from Results</Btn>
        </div>
      </Section>

      {/* Danger Zone */}
      <Section title="⚠️ Danger Zone" color="red">
        <p className="text-xs text-gray-400 mb-3">Permanently deletes all results, rosters, transactions, and stats.</p>
        <Btn onClick={handleSeasonReset} variant="danger">🔥 Reset Entire Season</Btn>
      </Section>

    </div>
  );
};
