import React, { useState } from 'react';
import { useDialog } from './DialogContext';
import { normalizePlayerName, getSegmentForTournament } from '../utils';
import { storage } from '../api';
import { DraftModal } from './DraftModal';
import { managerAuthApi, sfglDataApi, playersApi, playerRankingsApi, teamsApi } from '../api/firebase';
import { theme, colors, fonts, fontSize, getSwingColor } from '../theme.js';
import { BONUSES_REGULAR, BONUSES_MAJOR, LIV_GOLF_ROSTER, SWINGS } from '../constants';


// ── Tournament processing helpers ────────────────────────────────────────────

const matchPlayerName = (a, b) => {
  const na = normalizePlayerName(a);
  const nb = normalizePlayerName(b);
  if (na === nb) return true;
  const wa = na.split(' '); const wb = nb.split(' ');
  if (wa.length === wb.length) return wa.every(w => wb.includes(w));
  return false;
};

const getRosterForTournament = (team, tournamentIndex, allTransactions) => {
  let roster = [...team.roster];
  allTransactions
    .filter(tx => tx.team === team.name && tx.tournamentIndex !== undefined && tx.tournamentIndex <= tournamentIndex && tx.status !== 'pending')
    .sort((a, b) => a.tournamentIndex - b.tournamentIndex)
    .forEach(tx => {
      if (tx.droppedPlayer) roster = roster.filter(p => p.name !== tx.droppedPlayer);
      if (tx.player && !roster.some(p => p.name === tx.player)) roster.push({ name: tx.player });
    });
  return roster;
};

/**
 * Core tournament processing. Mirrors the original processTournamentResults logic.
 * Returns { newTeams, newStats, resultsData }.
 */
const processTournamentData = (tournament, tournamentData, teams, globalPlayerStats, _unusedNames, transactions = []) => {
  const bonuses = tournament.isMajor ? BONUSES_MAJOR : BONUSES_REGULAR;

  // Build earningsMap from the tournamentData
  const earningsMap = {};
  if (tournamentData.earningsMap instanceof Map) {
    tournamentData.earningsMap.forEach((earnings, name) => { earningsMap[name] = earnings; });
  } else if (tournamentData.earningsMap && typeof tournamentData.earningsMap === 'object') {
    Object.assign(earningsMap, tournamentData.earningsMap);
  } else if (Array.isArray(tournamentData.competitors)) {
    tournamentData.competitors.forEach(p => {
      const name = p.athlete?.displayName;
      const earn = p.earnings || 0;
      if (name && earn > 0) earningsMap[name] = earn;
    });
  }

  // Update global stats
  const newStats = { ...globalPlayerStats };
  Object.entries(earningsMap).forEach(([playerName, earnings]) => {
    if (!newStats[playerName]) newStats[playerName] = { eventsPlayed: 0, cutsMade: 0, pgaTourEarnings: 0 };
    newStats[playerName] = {
      ...newStats[playerName],
      eventsPlayed: newStats[playerName].eventsPlayed + 1,
      cutsMade:     newStats[playerName].cutsMade + (earnings > 0 ? 1 : 0),
      pgaTourEarnings: newStats[playerName].pgaTourEarnings + earnings,
    };
  });

  const tournamentIndex = -1; // used only for getRosterForTournament; -1 = ignore tx filtering
  const resultsData = { teams: {}, earningsMap: { ...earningsMap }, roundLeaders: tournamentData.roundLeaders || {}, fullLineups: {} };

  const newTeams = teams.map(team => {
    if (!team.lineup || team.lineup.length === 0) return team;

    resultsData.fullLineups[team.id] = [...team.lineup];

    const starterResults = team.lineup.map(playerName => {
      let earnings = earningsMap[playerName];
      if (earnings === undefined) {
        const mk = Object.keys(earningsMap).find(k => matchPlayerName(k, playerName));
        earnings = mk !== undefined ? earningsMap[mk] : 0;
      }
      return { playerName, earnings: earnings || 0 };
    });

    const topStarters = [...starterResults].sort((a, b) => b.earnings - a.earnings).slice(0, 5);
    let totalEarnings = topStarters.reduce((s, p) => s + p.earnings, 0);
    const bonusEarnings = { round1: 0, round2: 0, round3: 0 };
    const playersWithBonuses = {};

    if (tournamentData.roundLeaders) {
      ['round1', 'round2', 'round3'].forEach(round => {
        const leaders = Array.isArray(tournamentData.roundLeaders[round])
          ? tournamentData.roundLeaders[round]
          : (tournamentData.roundLeaders[round] ? [tournamentData.roundLeaders[round]] : []);
        leaders.forEach(leaderName => {
          if (!leaderName) return;
          const actual = team.lineup.find(pn => normalizePlayerName(pn) === normalizePlayerName(leaderName));
          if (actual) {
            bonusEarnings[round] = bonuses[round];
            totalEarnings += bonuses[round];
            if (!playersWithBonuses[actual]) playersWithBonuses[actual] = { total: 0, rounds: [] };
            playersWithBonuses[actual].total  += bonuses[round];
            playersWithBonuses[actual].rounds.push({ round: round.replace('round', ''), bonus: bonuses[round] });
          }
        });
      });
    }

    resultsData.teams[team.id] = {
      totalEarnings,
      bonuses: bonusEarnings,
      players: topStarters.map(s => ({
        name: s.playerName,
        earnings: s.earnings,
        limited: team.roster.find(p => p.name === s.playerName)?.limited || false,
        bonus: playersWithBonuses[s.playerName]?.total || 0,
        roundsLed: playersWithBonuses[s.playerName]?.rounds || [],
        wasRoundLeader: (playersWithBonuses[s.playerName]?.total || 0) > 0,
      })),
    };

    const updatedRoster = team.roster.map(player => {
      if (!team.lineup.includes(player.name)) return player;
      let pe = earningsMap[player.name];
      if (pe === undefined) { const mk = Object.keys(earningsMap).find(k => matchPlayerName(k, player.name)); if (mk) pe = earningsMap[mk]; }
      return { ...player, starts: (player.starts || 0) + 1, sfglEarnings: (player.sfglEarnings || 0) + (pe || 0) };
    });

    return {
      ...team,
      roster: updatedRoster,
      earnings: (team.earnings || 0) + totalEarnings,
      segmentEarnings: (team.segmentEarnings || 0) + totalEarnings,
      lineup: [],
    };
  });

  return { newTeams, newStats, resultsData };
};

// ── Admin group: collapsible top-level container ────────────────────────────
// Wave 2: AdminView regrouped from 12 flat sections into 4 collapsible groups.
// Open/closed state persists per-group in localStorage so the commish doesn't
// re-collapse on every visit.
//
// IMPORTANT: children are always rendered (display: none when closed) so any
// internal state (settingsDraft, emailDraft, MergePlayersPanel search inputs)
// survives a collapse without being thrown away.
const AdminGroup = ({ id, title, icon, badge, defaultOpen = false, children }) => {
  const storageKey = `sfgl-admin-group-${id}`;
  const [open, setOpen] = useState(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      return saved === null ? defaultOpen : saved === 'true';
    } catch { return defaultOpen; }
  });
  const toggle = () => {
    setOpen(o => {
      const next = !o;
      try { localStorage.setItem(storageKey, String(next)); } catch {}
      return next;
    });
  };
  return (
    <div style={{ marginBottom: 14 }}>
      <button
        onClick={toggle}
        aria-expanded={open}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          width: '100%',
          padding: '14px 18px',
          minHeight: 56,
          background: open ? 'rgba(100,160,255,0.07)' : 'rgba(255,255,255,0.025)',
          border: `1px solid ${open ? 'rgba(100,160,255,0.3)' : colors.border}`,
          borderRadius: 4,
          cursor: 'pointer',
          transition: 'background 0.15s, border-color 0.15s',
          textAlign: 'left',
        }}
        onMouseEnter={e => {
          if (!open) e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
        }}
        onMouseLeave={e => {
          if (!open) e.currentTarget.style.background = 'rgba(255,255,255,0.025)';
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flex: 1 }}>
          <span style={{ fontSize: fontSize.lg, lineHeight: 1, flexShrink: 0 }}>{icon}</span>
          <span style={{
            fontFamily: fonts.sans,
            fontSize: fontSize.base, fontWeight: 700, letterSpacing: '1.5px',
            textTransform: 'uppercase',
            color: open ? colors.sectionHeaderBlue : colors.textPrimary,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{title}</span>
          {badge}
        </div>
        <span style={{
          fontFamily: fonts.sans,
          fontSize: fontSize.base,
          color: open ? colors.sectionHeaderBlue : colors.textMuted,
          letterSpacing: 1,
          flexShrink: 0,
        }}>
          {open ? '▲' : '▼'}
        </span>
      </button>
      <div style={{
        display: open ? 'block' : 'none',
        marginTop: 8,
      }}>
        {children}
      </div>
    </div>
  );
};

// ── Tiny "unsaved changes" pulse dot ────────────────────────────────────────
const UnsavedDot = () => (
  <span title="Unsaved changes" style={{
    width: 8, height: 8, borderRadius: '50%',
    background: 'rgba(220,170,60,0.85)',
    boxShadow: '0 0 8px rgba(220,170,60,0.5)',
    flexShrink: 0,
  }} />
);

const MergePlayersPanel = ({
  allPlayers, teams, transactions,
  dialog, updateTeams, setTransactions,
  theme, colors, fonts, S, sfglDataApi, playersApi, STORAGE_KEYS, disabledBtn,
}) => {
  const [search1, setSearch1] = React.useState('');
  const [search2, setSearch2] = React.useState('');
  const [player1, setPlayer1] = React.useState(null);
  const [player2, setPlayer2] = React.useState(null);
  const [status,  setStatus]  = React.useState('');
  const [error,   setError]   = React.useState('');

  const allNames = React.useMemo(() =>
    [...new Set([...allPlayers.map(p => p.name), ...teams.flatMap(t => (t.roster||[]).map(p => p.name))])].sort(),
    [allPlayers, teams]
  );
  const f1 = search1.length >= 2 ? allNames.filter(n => n.toLowerCase().includes(search1.toLowerCase())).slice(0, 8) : [];
  const f2 = search2.length >= 2 ? allNames.filter(n => n.toLowerCase().includes(search2.toLowerCase())).slice(0, 8) : [];
  const iStyle = (sel) => ({ ...theme.input, width: '100%', fontSize: fontSize.md, border: sel ? `1px solid ${colors.textGold}` : undefined });
  const dStyle = { position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50, background: '#0f1d35', border: `1px solid ${colors.border}`, borderRadius: 3, boxShadow: '0 8px 24px rgba(0,0,0,0.5)', overflow: 'hidden' };
  const oStyle = { display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', background: 'none', border: 'none', fontFamily: fonts.sans, fontSize: fontSize.base, color: colors.textPrimary, cursor: 'pointer', borderBottom: `1px solid ${colors.borderSubtle}` };

  const doMerge = async () => {
    if (!player1 || !player2 || player1 === player2) { setError('Select two different players'); return; }
    if (!await dialog.showConfirm('Merge Players', `Rename "${player1}" → "${player2}" everywhere?`, { type: 'danger', confirmText: 'Merge' })) return;
    setStatus('merging'); setError('');
    try {
      const uTeams = teams.map(t => ({ ...t, roster: (t.roster||[]).map(p => p.name===player1?{...p,name:player2}:p), lineup: (t.lineup||[]).map(n=>n===player1?player2:n) }));
      const uTx = transactions.map(tx => ({ ...tx, ...(tx.player===player1&&{player:player2}), ...(tx.droppedPlayer===player1&&{droppedPlayer:player2}) }));
      await Promise.all([...uTeams.map(t=>teamsApi.update(t.id,t)), sfglDataApi.set(STORAGE_KEYS.TRANSACTIONS,uTx), playersApi.addAlias(player2,player1).catch(()=>{}), playersApi.delete(player1).catch(()=>{})]);
      updateTeams(uTeams); setTransactions(uTx); setStatus('done');
      dialog.showToast(`Merged "${player1}" → "${player2}"`, 'success');
      setPlayer1(null); setPlayer2(null); setSearch1(''); setSearch2('');
    } catch (err) { setStatus('error'); setError(err.message||'Merge failed'); }
  };

  return (
    <>
      <div style={{ ...theme.smallText, color: colors.textSecondary, marginBottom: 12 }}>Fix name mismatches — renames a player everywhere in rosters, transactions and Firebase.</div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <label style={S.lbl}>Rename this player...</label>
          <div style={{ position: 'relative' }}>
            <input value={player1||search1} onChange={e=>{setSearch1(e.target.value);setPlayer1(null);}} placeholder="Search..." style={iStyle(player1)} />
            {!player1&&f1.length>0&&<div style={dStyle}>{f1.map(n=><button key={n} onClick={()=>{setPlayer1(n);setSearch1(n);}} style={oStyle} onMouseEnter={e=>e.currentTarget.style.background='rgba(255,255,255,0.07)'} onMouseLeave={e=>e.currentTarget.style.background='none'}>{n}</button>)}</div>}
          </div>
          {player1&&<button onClick={()=>{setPlayer1(null);setSearch1('');}} style={{...theme.btnSecondary,marginTop:4,padding:'2px 8px',fontSize:10}}>✕ Clear</button>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', paddingTop: 20, color: colors.textMuted, fontSize: fontSize.lg }}>→</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <label style={S.lbl}>...to this name</label>
          <div style={{ position: 'relative' }}>
            <input value={player2||search2} onChange={e=>{setSearch2(e.target.value);setPlayer2(null);}} placeholder="Search..." style={iStyle(player2)} />
            {!player2&&f2.length>0&&<div style={dStyle}>{f2.map(n=><button key={n} onClick={()=>{setPlayer2(n);setSearch2(n);}} style={oStyle} onMouseEnter={e=>e.currentTarget.style.background='rgba(255,255,255,0.07)'} onMouseLeave={e=>e.currentTarget.style.background='none'}>{n}</button>)}</div>}
          </div>
          {player2&&<button onClick={()=>{setPlayer2(null);setSearch2('');}} style={{...theme.btnSecondary,marginTop:4,padding:'2px 8px',fontSize:10}}>✕ Clear</button>}
        </div>
      </div>
      {error&&<div style={{...theme.smallText,color:colors.danger,marginBottom:8}}>{error}</div>}
      <button onClick={doMerge} disabled={!player1||!player2||status==='merging'}
        style={{...S.btn,background:'rgba(180,100,100,0.15)',border:'1px solid rgba(200,80,80,0.4)',color:'rgba(220,120,120,0.95)',...disabledBtn(!player1||!player2||status==='merging')}}>
        {status==='merging'?'⏳ Merging…':'🔀 Merge Players'}
      </button>
    </>
  );
};

export const AdminView = ({
  isCommissioner, setIsCommissioner, setActiveTab,
  settings, setSettings,
  teams, updateTeams,
  tournaments, setTournaments,
  transactions, setTransactions,
  allPlayers, setAllPlayers, globalPlayerStats, setGlobalPlayerStats,
  headshots, setHeadshots,
  updateRankings, rankingsLastUpdated,
  STORAGE_KEYS,
}) => {
  const [selectedTourney, setSelectedTourney] = useState('');
  const [manualEntry, setManualEntry] = useState({ round1Leaders: [''], round2Leaders: [''], round3Leaders: [''], playerEarnings: '', teamLineups: {} });
  const [mgCredTeam, setMgCredTeam] = useState('');


  const [mgCredName, setMgCredName] = useState('');
  const [mgCredPass, setMgCredPass] = useState('');
  const [mgCredSaving, setMgCredSaving] = useState(false);
  const [showDraftModal, setShowDraftModal] = useState(false);
  const [swingAwardSeg, setSwingAwardSeg]   = useState('');
  const [waiverRevealed, setWaiverRevealed] = useState(false);
  const [livSearch, setLivSearch] = useState('');
  const [livSaving, setLivSaving] = useState({});
  const [pgaFetching, setPgaFetching] = useState(false);
  const dialog = useDialog();

  React.useEffect(() => {
    const active = tournaments.find(t => t.playing);
    if (active && !selectedTourney) setSelectedTourney(active.name);
  }, [tournaments, selectedTourney]);

  const S = {
    section: { background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 4, padding: '16px 18px', marginBottom: 12 },
    title: { fontFamily: fonts.sans, fontSize: fontSize.base, fontWeight: 700, letterSpacing: '1.8px', textTransform: 'uppercase', color: colors.sectionHeaderBlue, marginBottom: 12 },
    btn: { ...theme.btnPrimary, width: '100%', padding: '10px 16px', textAlign: 'center', display: 'block', cursor: 'pointer' },
    btnSec: { ...theme.btnSecondary, width: '100%', padding: '10px 16px', textAlign: 'center', display: 'block', cursor: 'pointer' },
    btnDgr: { ...theme.btnDanger, width: '100%', padding: '10px 16px', textAlign: 'center', display: 'block', cursor: 'pointer' },
    input: { ...theme.input, marginBottom: 8 },
    select: { ...theme.select, marginBottom: 8, color: colors.textPrimary, backgroundColor: '#0d1b2e', appearance: 'none', WebkitAppearance: 'none' },
    lbl: { ...theme.label, display: 'block', marginBottom: 6 },
  };
  const disabledBtn = (disabled) => disabled ? { opacity: 0.4, cursor: 'not-allowed', pointerEvents: 'none' } : {};



  // ── Results: PGA Tour fetch ───────────────────────────────────────
  const handleFetchPGAResults = async () => {
    if (!selectedTourney) { dialog.showToast('Select a tournament first', 'error'); return; }
    const ti = tournaments.findIndex(t => t.name === selectedTourney);
    const t = tournaments[ti];

    const params = new URLSearchParams({ name: t.name, year: '2026' });

    setPgaFetching(true);
    try {
      dialog.showToast('Fetching results…', 'info');
      const resp = await fetch(`/api/pga-results?${params.toString()}`);
      const data = await resp.json();

      if (!resp.ok) {
        dialog.showToast(data.error || 'Fetch failed', 'error');
        return;
      }

      const { players, roundLeaders } = data;

      // Pre-fill earnings textarea and round leaders
      const earningsLines = players
        .sort((a, b) => b.earnings - a.earnings)
        .map(p => `${p.name}, ${p.earnings}`)
        .join('\n');

      // Only keep leaders who were actually in an SFGL starting lineup —
      // same rule as the manual dropdown. Wave 8: when reprocessing a completed
      // tournament, team.lineup has been cleared (set to []), so deriving from
      // current state gives an empty set and filters out every leader. Pull
      // from the tournament's stored fullLineups snapshot instead, falling
      // back to current lineups for first-time processing.
      const storedFullLineups = t.results?.fullLineups;
      const startedPlayers = storedFullLineups && Object.keys(storedFullLineups).length > 0
        ? new Set(Object.values(storedFullLineups).flat())
        : new Set(teams.flatMap(t2 => t2.lineup || []));
      const filterToStarted = (names) => {
        if (!names?.length) return [''];
        const filtered = names.filter(n => startedPlayers.has(n));
        return filtered.length ? filtered : [''];
      };

      const rl = roundLeaders || {};
      setManualEntry(prev => ({
        ...prev,
        playerEarnings: earningsLines,
        round1Leaders: filterToStarted(rl.round1),
        round2Leaders: filterToStarted(rl.round2),
        round3Leaders: filterToStarted(rl.round3),
      }));

      dialog.showToast(`✓ ${players.length} players loaded`, 'success');
    } catch (err) {
      dialog.showToast('Error: ' + err.message, 'error');
    } finally {
      setPgaFetching(false);
    }
  };

  // ── Results: manual entry ────────────────────────────────────────────────
  const handleManualEntry = async () => {
    try {
      if (!selectedTourney) { dialog.showToast('Select a tournament first', 'error'); return; }
      const tournament = tournaments.find(t => t.name === selectedTourney);
      if (!tournament) { dialog.showToast('Tournament not found', 'error'); return; }
      if (tournament.completed) {
        const ok = await dialog.showConfirm('Already Processed', 'Re-entering will ADD earnings again (doubling them). Continue?', { type: 'danger', confirmText: 'Re-enter Results' });
        if (!ok) return;
      }
      // Parse earnings lines: "Player Name, 123456" or "Player Name, 1,234,567"
      const earningsMap = new Map();
      manualEntry.playerEarnings.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (!trimmed) return;
        const m = trimmed.match(/^(.+?),\s*([\d,]+)$/);
        if (m) {
          const amt = parseInt(m[2].replace(/,/g, ''));
          if (!isNaN(amt) && amt >= 0) earningsMap.set(m[1].trim(), amt);
        }
      });
      if (!earningsMap.size) {
        dialog.showToast('No valid earnings lines found. Format: "Player Name, 123456"', 'error');
        return;
      }
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
      const { newTeams, newStats, resultsData } = processTournamentData(tournament, manualData, teams, globalPlayerStats, names, transactions);
      // Mark tournament completed, advance playing to next non-alternate
      const newT = tournaments.map((nt, i) => i === ti ? { ...nt, completed: true, playing: false, results: resultsData } : nt);
      const nx = newT.findIndex((nt, i) => i > ti && !nt.completed && !nt.isAlternate);
      if (nx !== -1) { newT.forEach(nt => { nt.playing = false; }); newT[nx].playing = true; }
      updateTeams(newTeams); setGlobalPlayerStats(newStats); setTournaments(newT);
      await storage.set(STORAGE_KEYS.TOURNAMENTS, newT);
      await storage.set(STORAGE_KEYS.GLOBAL_PLAYER_STATS, newStats);
      sfglDataApi.set(STORAGE_KEYS.TOURNAMENTS, newT).catch(() => {});
      sfglDataApi.set(STORAGE_KEYS.GLOBAL_PLAYER_STATS, newStats).catch(() => {});
      dialog.showToast('Results processed! ' + earningsMap.size + ' players · ' + Object.keys(resultsData.teams).length + ' teams scored', 'success');
      // Send results email to all managers
      try {
        // Wave 8: send richer payload — include ALL teams (even those that
        // didn't submit a lineup), and per-team lineup with player earnings
        // and round-leader info so the email can render details.
        const teamResultsForEmail = newTeams.map(t => ({
          team: t.name,
          totalEarnings: resultsData.teams[t.id]?.totalEarnings || 0,
          players: resultsData.teams[t.id]?.players || [],
          submitted: !!resultsData.teams[t.id],
        }));
        // Wave 8: corrected URL — was '/api/notify-results' which 404s silently
        // because that endpoint doesn't exist. The notify-results action is
        // routed inside /api/cron.js. Also added response.ok check so a 404
        // surfaces instead of showing a fake success toast.
        const resp = await fetch('/api/cron?action=notify-results', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tournamentName: selectedTourney, teamResults: teamResultsForEmail }),
        });
        if (resp.ok) {
          const body = await resp.json().catch(() => ({}));
          dialog.showToast(`📧 Results emails sent (${body.emailsSent || 0})`, 'success');
        } else {
          const body = await resp.json().catch(() => ({}));
          console.warn('Results email failed:', resp.status, body);
          dialog.showToast(`Results emails failed (${resp.status}) — ${body.message || 'unknown'}`, 'error');
        }
      } catch (emailErr) {
        console.warn('Results email failed:', emailErr);
        dialog.showToast('Results emails failed — see console', 'error');
      }
      setManualEntry({ round1Leaders: [''], round2Leaders: [''], round3Leaders: [''], playerEarnings: '', teamLineups: {} });
    } catch (err) {
      console.error('handleManualEntry error:', err);
      dialog.showToast('Error processing results: ' + err.message, 'error');
    }
  };

  // ── Results: reprocess completed tournament ─────────────────────────────
  const handleReprocess = async () => {
    if (!selectedTourney) { dialog.showToast('Select a tournament first', 'error'); return; }
    const tournament = tournaments.find(t => t.name === selectedTourney);
    if (!tournament?.completed) { dialog.showToast('Tournament is not yet completed', 'error'); return; }
    const ti = tournaments.findIndex(t => t.name === selectedTourney);

    const ok = await dialog.showConfirm(
      'Reprocess Tournament',
      'This will reverse the existing results for ' + selectedTourney + ' and apply the corrected earnings below. Team scores, player stats, and standings will all update.',
      { confirmText: 'Reprocess' }
    );
    if (!ok) return;

    try {
      // Parse corrected earnings
      const earningsMap = new Map();
      manualEntry.playerEarnings.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (!trimmed) return;
        const m = trimmed.match(/^(.+?),\s*([\d,]+)$/);
        if (m) {
          const amt = parseInt(m[2].replace(/,/g, ''));
          if (!isNaN(amt) && amt >= 0) earningsMap.set(m[1].trim(), amt);
        }
      });
      if (!earningsMap.size) { dialog.showToast('No valid earnings lines found', 'error'); return; }

      // Step 1: Reverse old results from all teams
      const oldResults = tournament.results;
      let reversedTeams = teams.map(team => {
        const oldTeamResult = oldResults?.teams?.[team.id];
        if (!oldTeamResult) return team;
        // Reverse team earnings
        const earningsDelta = -(oldTeamResult.totalEarnings || 0);
        // Reverse per-player sfglEarnings and starts
        // Use fullLineups for start reversal (all starters), players list for earnings
        const oldLineup = new Set(oldResults.fullLineups?.[team.id] || (oldTeamResult.players || []).map(p => p.name || p));
        const oldEarningsByPlayer = {};
        (oldTeamResult.players || []).forEach(p => { oldEarningsByPlayer[p.name || p] = p.earnings || 0; });
        const newRoster = team.roster.map(p => {
          const wasInLineup = oldLineup.has(p.name);
          if (!wasInLineup) return p;
          return {
            ...p,
            sfglEarnings: Math.max(0, (p.sfglEarnings || 0) - (oldEarningsByPlayer[p.name] || 0)),
            starts: Math.max(0, (p.starts || 0) - 1),
          };
        });
        return {
          ...team,
          roster: newRoster,
          earnings: Math.max(0, (team.earnings || 0) + earningsDelta),
          segmentEarnings: Math.max(0, (team.segmentEarnings || 0) + earningsDelta),
          lineup: (manualEntry.teamLineups[team.id] || oldResults.fullLineups?.[team.id] || []),
        };
      });

      // Reverse global stats from old earningsMap
      const oldEarningsMap = oldResults?.earningsMap || {};
      const reversedStats = { ...globalPlayerStats };
      Object.entries(oldEarningsMap).forEach(([playerName, earnings]) => {
        if (!reversedStats[playerName]) return;
        reversedStats[playerName] = {
          ...reversedStats[playerName],
          eventsPlayed: Math.max(0, (reversedStats[playerName].eventsPlayed || 0) - 1),
          cutsMade: Math.max(0, (reversedStats[playerName].cutsMade || 0) - (earnings > 0 ? 1 : 0)),
          pgaTourEarnings: Math.max(0, (reversedStats[playerName].pgaTourEarnings || 0) - earnings),
        };
      });

      // Step 2: Apply corrected results
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
      const { newTeams, newStats, resultsData } = processTournamentData(tournament, manualData, reversedTeams, reversedStats, names, transactions);

      // Mark tournament with new results (keep completed, don't change playing)
      const newT = tournaments.map((nt, i) => i === ti ? { ...nt, results: resultsData } : nt);

      updateTeams(newTeams); setGlobalPlayerStats(newStats); setTournaments(newT);
      await storage.set(STORAGE_KEYS.TOURNAMENTS, newT);
      await storage.set(STORAGE_KEYS.GLOBAL_PLAYER_STATS, newStats);
      sfglDataApi.set(STORAGE_KEYS.TOURNAMENTS, newT).catch(() => {});
      sfglDataApi.set(STORAGE_KEYS.GLOBAL_PLAYER_STATS, newStats).catch(() => {});
      dialog.showToast('✓ Reprocessed ' + selectedTourney + ' with corrected earnings', 'success');

      // Wave 8: notify managers about the reprocessed results — same flow as
      // handleManualEntry. Previously reprocess silently updated earnings
      // without telling anyone, which made testing the email pipeline via
      // reprocess impossible.
      try {
        const teamResultsForEmail = newTeams.map(t => ({
          team: t.name,
          totalEarnings: resultsData.teams[t.id]?.totalEarnings || 0,
          players: resultsData.teams[t.id]?.players || [],
          submitted: !!resultsData.teams[t.id],
        }));
        const resp = await fetch('/api/cron?action=notify-results', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tournamentName: selectedTourney, teamResults: teamResultsForEmail }),
        });
        if (resp.ok) {
          const body = await resp.json().catch(() => ({}));
          dialog.showToast(`📧 Results emails sent (${body.emailsSent || 0})`, 'success');
        } else {
          const body = await resp.json().catch(() => ({}));
          console.warn('Reprocess email failed:', resp.status, body);
          dialog.showToast(`Results emails failed (${resp.status}) — ${body.message || 'unknown'}`, 'error');
        }
      } catch (emailErr) {
        console.warn('Reprocess email failed:', emailErr);
        dialog.showToast('Results emails failed — see console', 'error');
      }

      setManualEntry({ round1Leaders: [''], round2Leaders: [''], round3Leaders: [''], playerEarnings: '', teamLineups: {} });
    } catch (err) {
      console.error('handleReprocess error:', err);
      dialog.showToast('Error reprocessing: ' + err.message, 'error');
    }
  };

    const RoundLeaderSelect = ({ label, leaders, onChange, round }) => {
    // Use the stored tournament lineups (manualEntry.teamLineups) instead of current live lineups.
    // This ensures we show players who were actually in the lineup for that tournament.
    const teamLineups = manualEntry.teamLineups || {};

    // Build mulligan map for the selected tournament
    const selectedTIdx = tournaments.findIndex(t => t.name === selectedTourney);
    const tourneyMulligans = transactions.filter(tx =>
      tx.type === 'mulligan' && tx.tournamentIndex === selectedTIdx && tx.status === 'processed'
    );

    const players = teams.flatMap(team => {
      const lineup = teamLineups[team.id] || team.lineup || [];
      let names = [...lineup];

      // For R3+, include mulliganed-in players (they replace someone mid-tournament)
      if (round >= 3) {
        tourneyMulligans
          .filter(tx => tx.team === team.name && tx.player)
          .forEach(tx => {
            if (!names.includes(tx.player)) names.push(tx.player);
          });
      }

      return names.map(name => ({ name, team: team.name }));
    }).sort((a, b) => a.name.localeCompare(b.name));

    return (
      <div style={{ flex: 1 }}>
        <div style={S.lbl}>{label}</div>
        {leaders.map((leader, idx) => (
          <div key={idx} style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
            <select value={leader} onChange={e => { const n = [...leaders]; n[idx] = e.target.value; onChange(n); }}
              style={{ ...theme.select, flex: 1, marginBottom: 0, fontSize: fontSize.base, padding: '7px 8px' }}>
              <option value="">(none)</option>
              {players.map(p => <option key={p.name + p.team} value={p.name}>{p.name} — {p.team}</option>)}
            </select>
            {idx > 0 && <button onClick={() => onChange(leaders.filter((_, i) => i !== idx))}
              style={{ background: 'none', border: `1px solid ${colors.dangerBorder}`, color: colors.danger, borderRadius: 2, padding: '4px 7px', cursor: 'pointer', fontSize: fontSize.base }}>✕</button>}
          </div>
        ))}
        <button onClick={() => onChange([...leaders, ''])}
          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: fontSize.base, color: colors.textGoldDim, padding: 0 }}>+ co-leader</button>
      </div>
    );
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
    const allRostered = new Set(); teams.forEach(t => t.roster.forEach(p => allRostered.add(p.name)));
    if (allRostered.has(w.player)) {
      const tx2 = transactions.map((tx, i) => i === w._idx ? { ...tx, status: 'failed', failReason: 'Player already rostered', processedDate: new Date().toLocaleDateString() } : tx);
      setTransactions(tx2); await storage.set(STORAGE_KEYS.TRANSACTIONS, tx2); sfglDataApi.set(STORAGE_KEYS.TRANSACTIONS, tx2).catch(() => {});
      dialog.showToast(w.player + ' already rostered', 'error'); return;
    }
    if (w.droppedPlayer && !teams.find(t => t.name === w.team)?.roster.some(p => p.name === w.droppedPlayer)) {
      const tx2 = transactions.map((tx, i) => i === w._idx ? { ...tx, status: 'failed', failReason: w.droppedPlayer + ' already dropped', processedDate: new Date().toLocaleDateString() } : tx);
      setTransactions(tx2); await storage.set(STORAGE_KEYS.TRANSACTIONS, tx2); sfglDataApi.set(STORAGE_KEYS.TRANSACTIONS, tx2).catch(() => {});
      dialog.showToast(w.droppedPlayer + ' already dropped', 'error'); return;
    }

    // Check for competing pending claims from other teams on the same player
    const competing = transactions
      .map((tx, i) => ({ ...tx, _idx: i }))
      .filter(tx => tx.status === 'pending' && tx.type === 'waiver' && tx.player === w.player && tx.team !== w.team);

    // Determine tiebreaker: lowest earnings wins
    const earningsMap = {}; teams.forEach(t => { earningsMap[t.name] = t.earnings || 0; });
    const allClaims = [w, ...competing].sort((a, b) => (earningsMap[a.team] || 0) - (earningsMap[b.team] || 0));
    const winner = allClaims[0];
    const losers = allClaims.slice(1);

    let tx2 = [...transactions];
    // Mark winner as processed
    tx2[winner._idx] = { ...tx2[winner._idx], status: 'processed', processedDate: new Date().toLocaleDateString() };
    // Mark losers as blocked
    losers.forEach(l => {
      const winEarn = '$' + (earningsMap[winner.team] || 0).toLocaleString();
      const loseEarn = '$' + (earningsMap[l.team] || 0).toLocaleString();
      tx2[l._idx] = { ...tx2[l._idx], status: 'failed', failReason: `Lost tiebreaker to ${winner.team} (${winEarn} vs ${loseEarn})`, processedDate: new Date().toLocaleDateString() };
    });

    // Only apply the winner's roster change
    const t2 = teams.map(t => applyWaiver(t, winner));
    setTransactions(tx2); updateTeams(t2);
    await storage.set(STORAGE_KEYS.TRANSACTIONS, tx2);
    sfglDataApi.set(STORAGE_KEYS.TRANSACTIONS, tx2).catch(() => {});
    if (losers.length) {
      dialog.showToast(winner.team + ' wins claim · ' + losers.map(l => l.team).join(', ') + ' blocked', 'success');
    } else {
      dialog.showToast(winner.team + ' adds ' + winner.player + (winner.droppedPlayer ? ' / drops ' + winner.droppedPlayer : ''), 'success');
    }
  };
  const handleProcessAll = async (pending) => {
    if (!pending.length) return;
    if (!await dialog.showConfirm('Process All Waivers', 'Process ' + pending.length + ' pending claim' + (pending.length !== 1 ? 's' : '') + '?\n\nTie-breaker: reverse standings (lowest earnings = highest priority). Winners move to back of the line for subsequent claims.', { confirmText: 'Process All' })) return;
    const em = {}; teams.forEach(t => { em[t.name] = t.earnings || 0; });
    const pm = {}; [...teams].sort((a, b) => (a.earnings || 0) - (b.earnings || 0)).forEach((t, i) => { pm[t.name] = i; });
    let nextLastPlace = teams.length; // counter for pushing winners to back of priority
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
        pm[w.tn] = nextLastPlace++; // winner moves to back of priority line
        const winEarn = '$' + (em[w.tn] || 0).toLocaleString();
        cs.slice(1).forEach(l => {
          const loseEarn = '$' + (em[l.tn] || 0).toLocaleString();
          failed.add(l.claim._idx); tx2[l.claim._idx] = { ...tx2[l.claim._idx], status: 'failed', failReason: `Lost tiebreaker to ${w.tn} (${winEarn} vs ${loseEarn})`, processedDate: new Date().toLocaleDateString() }; f++;
        }); more = true;
      });
    }
    let t2 = [...teams]; applied.forEach(w => { t2 = t2.map(t => applyWaiver(t, w)); });
    setTransactions(tx2); updateTeams(t2);
    await storage.set(STORAGE_KEYS.TRANSACTIONS, tx2); await storage.set(STORAGE_KEYS.TEAMS, t2);
    sfglDataApi.set(STORAGE_KEYS.TRANSACTIONS, tx2).catch(() => {}); sfglDataApi.set(STORAGE_KEYS.TEAMS, t2).catch(() => {});
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

  // ── Award Swing Winner ──────────────────────────────────────────────────
  // Wave 7: SWINGS now imported from ../constants (single source of truth).
  // Local copy removed.

  // Wave 7: getTournamentSegment removed — now uses canonical getSegmentForTournament
  // imported from ../utils (single source of truth for the 4-swing mapping).

  const handleSwingWinner = async () => {
    if (!swingAwardSeg) return;

    // Sum all transaction fees for this swing using tournamentIndex range,
    // matching the same logic as TransactionsView's fee counter.
    const swingTournaments = tournaments.filter(t => t.completed && getSegmentForTournament(t) === swingAwardSeg && t.results?.teams);
    if (!swingTournaments.length) {
      dialog.showToast('No completed results found for ' + swingAwardSeg, 'error');
      return;
    }
    const swingIndexes = new Set(swingTournaments.map(t => tournaments.indexOf(t)));
    const pot = transactions
      .filter(tx => {
        if ((tx.fee || 0) <= 0) return false;
        if (tx.status === 'failed') return false;
        if (tx.type === 'swing_winner') return false;
        // Match by tournamentIndex if available, fall back to segment string
        return tx.tournamentIndex !== undefined
          ? swingIndexes.has(tx.tournamentIndex)
          : tx.segment === swingAwardSeg;
      })
      .reduce((sum, tx) => sum + tx.fee, 0);

    if (pot === 0) {
      dialog.showToast('No fees collected for ' + swingAwardSeg, 'error');
      return;
    }

    const byTeam = {};
    swingTournaments.forEach(t => {
      Object.entries(t.results.teams).forEach(([id, tr]) => {
        byTeam[id] = (byTeam[id] || 0) + (tr.totalEarnings || 0);
      });
    });

    // Wave 5: gate debug logs to dev mode only — production console stays quiet.
    if (import.meta.env?.DEV) {
      console.log('[SwingWinner] Swing:', swingAwardSeg);
      console.log('[SwingWinner] Tournaments found:', swingTournaments.map(t => t.name + ' (segment=' + t.segment + ', dates=' + t.dates + ')'));
      console.log('[SwingWinner] Earnings by team:', Object.entries(byTeam).map(([id, e]) => { const t = teams.find(x => x.id === id); return (t?.name || id) + ': $' + e.toLocaleString(); }));
    }

    const winnerEntry = Object.entries(byTeam).sort((a, b) => b[1] - a[1])[0];
    if (!winnerEntry) { dialog.showToast('Could not determine winner', 'error'); return; }
    const [winnerId, winnerEarnings] = winnerEntry;
    const winnerTeam = teams.find(t => t.id === winnerId);
    if (!winnerTeam) { dialog.showToast('Winner team not found', 'error'); return; }

    const msg = swingAwardSeg + ' complete. Winner: ' + winnerTeam.name + ' (' + winnerTeam.owner + '). Swing: $' + winnerEarnings.toLocaleString() + '. Pot: $' + pot.toLocaleString() + '. Award pot?';
    const ok = await dialog.showConfirm('Award Swing Winner', msg, { confirmText: 'Award $' + pot.toLocaleString() });
    if (!ok) return;

    const lastSwingTournament = swingTournaments.reduce((last, t) => {
      const idx = tournaments.indexOf(t);
      return idx > (last?.idx ?? -1) ? { t, idx } : last;
    }, null);

    const newTx = {
      team: winnerTeam.name, type: 'swing_winner', player: winnerTeam.owner,
      fee: 0, amount: pot, segment: swingAwardSeg,
      date: new Date().toLocaleDateString(), status: 'completed',
      tournamentIndex: lastSwingTournament?.idx ?? undefined,
      note: swingAwardSeg + ' winner pot',
    };

    const newTeams = teams.map(t =>
      t.id === winnerId
        ? { ...t, earnings: (t.earnings || 0) + pot }
        : t
    );

    updateTeams(newTeams);
    setTransactions(prev => [...prev, newTx]);
    await storage.set(STORAGE_KEYS.TRANSACTIONS, [...transactions, newTx]);
    await sfglDataApi.set(STORAGE_KEYS.TRANSACTIONS, [...transactions, newTx]).catch(e => console.error('sfgl tx:', e));

    dialog.showToast('🏆 ' + winnerTeam.name + ' awarded $' + pot.toLocaleString() + ' for ' + swingAwardSeg, 'success');
    setSwingAwardSeg('');
  };

  // ── Combined OWGR + LIV sync ─────────────────────────────────────────────
  const [owgrStatus, setOwgrStatus] = useState(null);
  const [owgrSummary, setOwgrSummary] = useState('');
  const [owgrLastSynced, setOwgrLastSynced] = useState(null);

  // ── Merge Players ─────────────────────────────────────────────────────────
  const [mergeOpen, setMergeOpen] = useState(false);

  // ── Season Settings ────────────────────────────────────────────────────────
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsOpen,   setSettingsOpen]   = useState(false);
  const [settingsDraft,  setSettingsDraft]  = useState(null);

  const getSettingsDraft = () => ({
    bonusR1Regular:   settings?.bonusR1Regular   ?? 20000,
    bonusR2Regular:   settings?.bonusR2Regular   ?? 40000,
    bonusR3Regular:   settings?.bonusR3Regular   ?? 60000,
    bonusR1Major:     settings?.bonusR1Major     ?? 40000,
    bonusR2Major:     settings?.bonusR2Major     ?? 80000,
    bonusR3Major:     settings?.bonusR3Major     ?? 120000,
    feeFA:            settings?.feeFA            ?? 1,
    feeWaiver:        settings?.feeWaiver        ?? 2,
    rosterLimit:      settings?.rosterLimit      ?? 13,
    lineupSize:       settings?.lineupSize       ?? 5,
    maxLimitedStarts: settings?.maxLimitedStarts ?? 12,
  });

  const handleSaveSettings = async () => {
    if (!settingsDraft) return;
    setSettingsSaving(true);
    try {
      await setSettings({ ...settings, ...settingsDraft });
      setSettingsDraft(null);
      dialog.showToast('✓ Season settings saved', 'success');
    } catch (err) {
      dialog.showToast('Error: ' + err.message, 'error');
    } finally { setSettingsSaving(false); }
  };

  // ── Waiver Schedule ────────────────────────────────────────────────────────
  const [waiverDay,    setWaiverDay]    = useState(() => settings?.waiverDay    ?? 2); // 0=Sun…6=Sat, default Tue=2
  const [waiverHour,   setWaiverHour]   = useState(() => settings?.waiverHour   ?? 20); // 24h ET, default 20=8pm
  const [waiverMinute, setWaiverMinute] = useState(() => settings?.waiverMinute ?? 0);  // 0–59, default :00
  const [waiverSaving, setWaiverSaving] = useState(false);
  const [emailDraft,   setEmailDraft]   = useState(null); // { teamId: 'email@...' } — null = no unsaved changes

  const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const fmtWaiverTime = (h, m) => {
    const hr = h % 12 || 12;
    const ampm = h < 12 ? 'AM' : 'PM';
    const min = String(m).padStart(2, '0');
    return `${hr}:${min} ${ampm}`;
  };

  const handleSaveWaiverSchedule = async () => {
    setWaiverSaving(true);
    try {
      await setSettings({ ...settings, waiverDay, waiverHour, waiverMinute });
      dialog.showToast(`✓ Waivers process ${DAY_NAMES[waiverDay]} at ${fmtWaiverTime(waiverHour, waiverMinute)} ET`, 'success');
    } catch (err) {
      dialog.showToast('Error: ' + err.message, 'error');
    } finally { setWaiverSaving(false); }
  };

  const handleSyncOwgr = async () => {
    setOwgrStatus('fetching');
    setOwgrSummary('');
    try {
      const resp = await fetch('/api/owgr');
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'OWGR fetch failed');
      const cleanName = n => n.replace(/\s*\([^)]*\)\s*$/, '').trim();
      const fetched = (data.players || [])
        .map(({ name, worldRank }) => ({ name: cleanName(name), worldRank }))
        .filter(p => p.name && p.name.includes(' '));
      if (!fetched.length) throw new Error('No ranking data returned');

      let updatedPlayers = [...allPlayers];
      let updated = 0, added = 0;
      fetched.forEach(({ name, worldRank }) => {
        const idx = updatedPlayers.findIndex(p => p.name.toLowerCase() === name.toLowerCase());
        if (idx >= 0) { updatedPlayers[idx] = { ...updatedPlayers[idx], worldRank }; updated++; }
        else { updatedPlayers.push({ name, worldRank }); added++; }
      });
      await playersApi.upsertMany(fetched.map(({ name, worldRank }) => ({ name, worldRank })));

      // Fetch ESPN IDs for all rostered players and save them
      try {
        const allRostered = [...new Set(teams.flatMap(t => (t.roster || []).map(p => p.name)))];
        if (allRostered.length) {
          const hsResp = await fetch(`/api/headshots?names=${allRostered.map(n => encodeURIComponent(n)).join(',')}`);
          if (hsResp.ok) {
            const hsData = await hsResp.json();
            const toSave = Object.entries(hsData.results || {}).map(([name, espnId]) => ({ name, espnId }));
            if (toSave.length) await playersApi.upsertMany(toSave);
          }
        }
      } catch (_) { /* non-critical */ }

      setAllPlayers(updatedPlayers);
      await playerRankingsApi.setLastUpdated(new Date().toISOString()).catch(() => {});
      await playerRankingsApi.invalidateCache().catch(() => {});
      setOwgrLastSynced(new Date().toISOString());
      setOwgrStatus('done');
      setOwgrSummary(`✓ ${fetched.length} rankings synced · ${updated} updated · ${added} new`);
    } catch (err) {
      setOwgrStatus('error');
      setOwgrSummary(err.message || 'OWGR sync failed');
    }
  };

  // ── LIV roster sync ───────────────────────────────────────────────────────
  const [livSyncStatus, setLivSyncStatus] = useState(null);
  const [livSyncSummary, setLivSyncSummary] = useState('');
  const [livLastSynced, setLivLastSynced] = useState(() => settings?.livRosterLastSynced || null);

  const handleSyncLiv = async () => {
    setLivSyncStatus('fetching');
    setLivSyncSummary('');
    try {
      const livRosterLower = new Set(LIV_GOLF_ROSTER.map(n => n.toLowerCase()));
      const toFlag = LIV_GOLF_ROSTER.filter(name =>
        !allPlayers.find(p => p.name.toLowerCase() === name.toLowerCase())?.isLiv
      );
      const toUnflag = allPlayers.filter(p =>
        p.isLiv && !livRosterLower.has(p.name.toLowerCase())
      );
      if (toFlag.length === 0 && toUnflag.length === 0) {
        setLivSyncStatus('done');
        setLivSyncSummary('✓ LIV roster already matches DB — no changes needed');
        return;
      }
      const livWrites = [
        ...toFlag.map(name => ({ name, isLiv: true })),
        ...toUnflag.map(p => ({ name: p.name, isLiv: false })),
      ];
      await playersApi.upsertMany(livWrites);
      setAllPlayers(prev => {
        const updated = [...prev];
        toFlag.forEach(name => {
          const idx = updated.findIndex(p => p.name.toLowerCase() === name.toLowerCase());
          if (idx >= 0) updated[idx] = { ...updated[idx], isLiv: true };
          else updated.push({ name, isLiv: true, worldRank: null });
        });
        toUnflag.forEach(u => {
          const idx = updated.findIndex(p => p.name === u.name);
          if (idx >= 0) updated[idx] = { ...updated[idx], isLiv: false };
        });
        return updated;
      });
      const parts = [
        toFlag.length   > 0 ? `${toFlag.length} tagged` : '',
        toUnflag.length > 0 ? `${toUnflag.length} unflagged` : '',
      ].filter(Boolean).join(' · ');
      const livTs = new Date().toISOString();
      setLivLastSynced(livTs);
      setSettings({ ...settings, livRosterLastSynced: livTs }).catch(() => {});
      setLivSyncStatus('done');
      setLivSyncSummary(`✓ LIV roster synced · ${parts}`);
    } catch (err) {
      setLivSyncStatus('error');
      setLivSyncSummary(err.message || 'LIV sync failed');
    }
  };

  const pending = transactions.map((tx, i) => ({ ...tx, _idx: i })).filter(tx => tx.status === 'pending' && tx.type === 'waiver');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingBottom: 40 }}>

      {/* ─────────────── 1. TOURNAMENT OPERATIONS ─────────────── */}
      <AdminGroup
        id="tournament-ops"
        title="Tournament Operations"
        icon="🏆"
        defaultOpen
        badge={pending.length > 0
          ? <span style={{ ...theme.badge, ...theme.badgeWarning }}>{pending.length} pending</span>
          : null
        }
      >
        <div style={S.section}>
          <div style={S.title}>🏆 Tournament Results</div>
          <label style={S.lbl}>Tournament</label>
          <select value={selectedTourney} onChange={e => {
            const name = e.target.value;
            setSelectedTourney(name);
            const t = tournaments.find(t => t.name === name);
            if (t?.completed && t.results) {
              const lines = t.results.earningsMap
                ? Object.entries(t.results.earningsMap).sort((a,b) => b[1]-a[1]).map(([p,a]) => `${p}, ${a}`).join('\n')
                : '';
              const teamLineups = {};
              if (t.results.fullLineups) Object.entries(t.results.fullLineups).forEach(([id, lu]) => { teamLineups[id] = [...lu]; });
              setManualEntry(prev => ({
                ...prev, playerEarnings: lines, teamLineups,
                round1Leaders: t.results.roundLeaders?.round1?.length ? t.results.roundLeaders.round1 : [''],
                round2Leaders: t.results.roundLeaders?.round2?.length ? t.results.roundLeaders.round2 : [''],
                round3Leaders: t.results.roundLeaders?.round3?.length ? t.results.roundLeaders.round3 : [''],
              }));
            } else {
              setManualEntry({ round1Leaders: [''], round2Leaders: [''], round3Leaders: [''], playerEarnings: '', teamLineups: {} });
            }
          }} style={S.select}>
            <option value="">Choose tournament...</option>
            {tournaments.map(t => <option key={t.name} value={t.name}>{t.completed ? '✓ ' : t.playing ? '▶ ' : ''}{t.name}</option>)}
          </select>

          {/* Fetch button — auto-fills earnings + round leaders */}
          <button onClick={handleFetchPGAResults} disabled={pgaFetching || !selectedTourney}
            style={{ ...S.btn, marginBottom: 14, ...(!selectedTourney || pgaFetching ? { opacity: 0.4, cursor: 'not-allowed' } : {}) }}>
            {pgaFetching ? '⏳ Fetching…' : selectedTourney ? `⛳ Get ${selectedTourney} Results` : '⛳ Get Tournament Results'}
          </button>

          {/* Round leader overrides — auto-filled by fetch, commish can correct */}
          {manualEntry.playerEarnings.trim() && (
            <>
              <div style={{ ...theme.smallText, color: colors.textSecondary, marginBottom: 8 }}>
                Round leaders auto-detected — override if incorrect:
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
                <RoundLeaderSelect label="R1 Leader" round={1} leaders={manualEntry.round1Leaders} onChange={r => setManualEntry({ ...manualEntry, round1Leaders: r })} />
                <RoundLeaderSelect label="R2 Leader" round={2} leaders={manualEntry.round2Leaders} onChange={r => setManualEntry({ ...manualEntry, round2Leaders: r })} />
                <RoundLeaderSelect label="R3 Leader" round={3} leaders={manualEntry.round3Leaders} onChange={r => setManualEntry({ ...manualEntry, round3Leaders: r })} />
              </div>

              {/* Process / Reprocess */}
              {!tournaments.find(t => t.name === selectedTourney)?.completed ? (
                <button onClick={handleManualEntry} disabled={!selectedTourney}
                  style={{ ...S.btn, ...disabledBtn(!selectedTourney) }}>
                  ✅ Process Results
                </button>
              ) : (
                <button onClick={handleReprocess} disabled={!selectedTourney}
                  style={{ ...S.btn, background: 'rgba(220,150,50,0.12)', border: '1px solid rgba(220,150,50,0.4)', color: 'rgba(220,180,80,0.9)', ...disabledBtn(!selectedTourney) }}>
                  ✏️ Reprocess Tournament
                </button>
              )}
            </>
          )}
        </div>

        <div style={S.section}>
          {/* Waiver processing reminder — uses configurable schedule */}
          {(() => {
            const now = new Date();
            const etOffset = -4;
            const etHour = (now.getUTCHours() + 24 + etOffset) % 24;
            const etMin  = now.getUTCMinutes();
            const etDay  = new Date(now.getTime() + etOffset * 3600 * 1000).getUTCDay();
            const wd = waiverDay ?? 2;
            const wh = waiverHour ?? 20;
            const wm = waiverMinute ?? 0;
            const isReadyToProcess = etDay === wd && (etHour * 60 + etMin) >= (wh * 60 + wm) && pending.length > 0;
            if (!isReadyToProcess) return null;
            return (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', marginBottom: 10, borderRadius: 3,
                background: 'rgba(220,170,60,0.1)', border: '1px solid rgba(220,170,60,0.45)',
              }}>
                <span style={{ fontSize: fontSize.md }}>⏰</span>
                <div style={{ flex: 1, fontFamily: fonts.sans, fontSize: fontSize.base, color: 'rgba(220,190,80,0.9)', fontWeight: 600 }}>
                  Past {fmtWaiverTime(wh, wm)} ET {DAY_NAMES[wd]} — process now!
                </div>
              </div>
            );
          })()}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={S.title}>⏰ Process Waivers</div>
            {pending.length > 0 && <span style={{ ...theme.badge, ...theme.badgeWarning }}>{pending.length} pending</span>}
          </div>
          {pending.length === 0 ? (
            <div style={{ ...theme.smallText, textAlign: 'center', padding: '8px 0', color: colors.success }}>✓ No pending waiver claims</div>
          ) : !waiverRevealed ? (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
                {pending.map(w => (
                  <div key={w._idx} style={{ display: 'flex', alignItems: 'center', gap: 8, background: colors.inputBg, border: `1px solid ${colors.borderSubtle}`, borderRadius: 3, padding: '6px 12px' }}>
                    <div style={{ width: 18, height: 18, borderRadius: '50%', background: 'rgba(220,170,60,0.1)', border: '1px solid rgba(220,170,60,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: fontSize.xs, fontWeight: 700, color: colors.warning, flexShrink: 0 }}>{w.priority || '?'}</div>
                    <div style={{ fontFamily: fonts.sans, fontSize: fontSize.base, fontWeight: 600, color: colors.textPrimary }}>{w.team}</div>
                    <div style={{ flex: 1 }} />
                    <span style={{ fontFamily: fonts.sans, fontSize: fontSize.sm, color: colors.textMuted }}>claim pending</span>
                  </div>
                ))}
              </div>
              {(() => {
                const now = new Date();
                const etOffset = -4;
                const etHour = (now.getUTCHours() + 24 + etOffset) % 24;
                const etMin  = now.getUTCMinutes();
                const etDay  = new Date(now.getTime() + etOffset * 3600 * 1000).getUTCDay();
                const wd = waiverDay ?? 2;
                const wh = waiverHour ?? 20;
                const wm = waiverMinute ?? 0;
                const ready = etDay === wd && (etHour * 60 + etMin) >= (wh * 60 + wm);
                return (
                  <button onClick={() => setWaiverRevealed(true)} style={ready
                    ? { ...S.btn, fontSize: fontSize.md, fontWeight: 700, padding: '12px 20px', background: 'rgba(220,170,60,0.2)', border: '2px solid rgba(220,170,60,0.7)', color: 'rgba(255,220,80,1)', boxShadow: '0 0 12px rgba(220,170,60,0.25)' }
                    : { ...S.btnSec, fontSize: fontSize.base }
                  }>
                    {ready ? `⚡ Process Claims (${pending.length})` : `Process Claims (${pending.length})`}
                  </button>
                );
              })()}
            </>
          ) : (
            <>
              {/* Tiebreaker summary — show competing claims */}
              {(() => {
                // Group claims by player to find conflicts
                const byPlayer = {};
                pending.forEach(w => {
                  if (!byPlayer[w.player]) byPlayer[w.player] = [];
                  byPlayer[w.player].push(w);
                });
                const conflicts = Object.entries(byPlayer).filter(([, claims]) => claims.length > 1);
                if (conflicts.length === 0) return null;

                const earningsMap = {};
                teams.forEach(t => { earningsMap[t.name] = t.earnings || 0; });
                const fmtEarnings = (n) => '$' + (n || 0).toLocaleString();

                return (
                  <div style={{
                    background: 'rgba(220,100,60,0.08)', border: '1px solid rgba(220,100,60,0.35)',
                    borderRadius: 3, padding: '10px 14px', marginBottom: 10,
                  }}>
                    <div style={{ fontFamily: fonts.sans, fontSize: fontSize.base, fontWeight: 700, letterSpacing: '1.5px', textTransform: 'uppercase', color: 'rgba(220,140,80,0.9)', marginBottom: 8 }}>
                      ⚠️ Competing Claims ({conflicts.length})
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {conflicts.map(([player, claims]) => {
                        const sorted = [...claims].sort((a, b) => (earningsMap[a.team] || 0) - (earningsMap[b.team] || 0));
                        return (
                          <div key={player} style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 2, padding: '8px 10px' }}>
                            <div style={{ fontFamily: fonts.sans, fontSize: fontSize.base, fontWeight: 600, color: colors.textPrimary, marginBottom: 4 }}>
                              {player} — {claims.length} teams competing
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                              {sorted.map((c, i) => (
                                <div key={c.team} style={{ fontFamily: fonts.sans, fontSize: fontSize.base, display: 'flex', alignItems: 'center', gap: 6 }}>
                                  <span style={{
                                    fontSize: fontSize.xs, fontWeight: 700, width: 14, textAlign: 'center',
                                    color: i === 0 ? colors.earningsGreen : colors.textMuted,
                                  }}>{i + 1}.</span>
                                  <span style={{ color: i === 0 ? colors.textPrimary : colors.textMuted, fontWeight: i === 0 ? 600 : 400 }}>
                                    {c.team}
                                  </span>
                                  <span style={{ color: colors.textMuted, fontSize: fontSize.sm }}>
                                    {fmtEarnings(earningsMap[c.team])}
                                  </span>
                                  {i === 0 && <span style={{ color: colors.earningsGreen, fontSize: fontSize.sm, fontWeight: 600 }}>← wins</span>}
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <div style={{ ...theme.smallText, color: colors.textMuted, marginTop: 6 }}>
                      Tiebreaker: lowest total SFGL earnings wins. Winner moves to back of line.
                    </div>
                  </div>
                );
              })()}
              <button
                onClick={() => handleProcessAll(pending)}
                className={pending.length > 0 ? 'sfgl-pulse-ready' : undefined}
                style={{ ...S.btn, marginBottom: 8 }}
              >
                ⚡ Process All ({pending.length})
              </button>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {pending.map(w => (
                  <div key={w._idx} style={{ display: 'flex', alignItems: 'center', gap: 10, background: colors.inputBg, border: `1px solid ${colors.borderSubtle}`, borderRadius: 3, padding: '8px 12px' }}>
                    <div style={{ width: 20, height: 20, borderRadius: '50%', background: 'rgba(220,170,60,0.1)', border: '1px solid rgba(220,170,60,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: fontSize.sm, fontWeight: 700, color: colors.warning, flexShrink: 0 }}>{w.priority || '?'}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: fonts.sans, fontSize: fontSize.base, fontWeight: 600, color: colors.textPrimary }}>{w.team}</div>
                      <div style={{ fontSize: fontSize.base }}>
                        <span style={{ color: colors.earningsGreen }}>+{w.player}</span>
                        {w.droppedPlayer && <span style={{ color: colors.danger }}> / -{w.droppedPlayer}</span>}
                      </div>
                    </div>
                    <button onClick={() => handleProcessSingle(w)} style={{ ...theme.btnSecondary, padding: '5px 10px', fontSize: fontSize.base, flexShrink: 0 }}>Process</button>
                  </div>
                ))}
              </div>
              <button onClick={() => setWaiverRevealed(false)} style={{ ...theme.btnSecondary, marginTop: 8, fontSize: fontSize.sm, padding: '4px 12px', width: 'auto', display: 'inline-block' }}>Hide Claims</button>
            </>
          )}
        </div>

        <div style={S.section}>
          <div style={S.title}>🏆 Award Swing Winner</div>
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
            const swingTourneys = tournaments.filter(t => t.completed && getSegmentForTournament(t) === swingAwardSeg && t.results?.teams);
            const byTeam = {};
            swingTourneys.forEach(t => Object.entries(t.results.teams).forEach(([id, tr]) => { byTeam[id] = (byTeam[id] || 0) + (tr.totalEarnings || 0); }));
            const topEntry = Object.entries(byTeam).sort((a, b) => b[1] - a[1])[0];
            const leader = topEntry ? teams.find(t => t.id === topEntry[0]) : null;
            return (
              <div style={{ ...theme.smallText, marginBottom: 10, padding: '8px 10px', background: colors.inputBg, borderRadius: 3, border: `1px solid ${colors.borderSubtle}` }}>
                {leader
                  ? <span>🏆 Leader: <span style={{ color: colors.textGold, fontWeight: 600 }}>{leader.name}</span> · ${(topEntry[1] || 0).toLocaleString()} · <span style={{ color: getSwingColor(swingAwardSeg) }}>Pot: ${pot.toLocaleString()}</span></span>
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

        <div style={S.section}>
          <div style={S.title}>🎯 Draft</div>
          <button onClick={() => setShowDraftModal(true)} style={S.btn}>Open Draft Room</button>
        </div>
      </AdminGroup>

      {/* ─────────────── 2. DATA SYNC ─────────────── */}
      <AdminGroup
        id="data-sync"
        title="Data Sync"
        icon="🔄"
      >
        <div style={S.section}>
          <div style={S.title}>🌍 Update OWGR Rankings</div>
          {(owgrLastSynced || rankingsLastUpdated) && (
            <div style={{ ...theme.smallText, color: colors.textGoldDim, marginBottom: 10 }}>
              Last synced: {new Date(owgrLastSynced || rankingsLastUpdated).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </div>
          )}
          <button
            onClick={handleSyncOwgr}
            disabled={owgrStatus === 'fetching'}
            style={{ ...S.btn, ...(owgrStatus === 'fetching' ? { opacity: 0.5, cursor: 'not-allowed' } : {}) }}
          >
            {owgrStatus === 'fetching' ? '⏳ Fetching…' : '🔄 Sync OWGR Rankings'}
          </button>
          {owgrSummary && (
            <div style={{
              marginTop: 10, padding: '8px 12px', borderRadius: 3, fontSize: fontSize.base, fontFamily: fonts.sans,
              background: owgrStatus === 'error' ? colors.dangerBg : 'rgba(80,160,100,0.1)',
              border: `1px solid ${owgrStatus === 'error' ? colors.dangerBorder : 'rgba(80,160,100,0.3)'}`,
              color: owgrStatus === 'error' ? colors.danger : colors.success,
            }}>
              {owgrSummary}
            </div>
          )}
        </div>

        <div style={S.section}>
          <div style={S.title}>🚫 LIV Golf — Sync Roster</div>
          {(livLastSynced || settings?.livRosterLastSynced) && (
            <div style={{ ...theme.smallText, color: colors.textGoldDim, marginBottom: 10 }}>
              Last synced: {new Date(livLastSynced || settings?.livRosterLastSynced).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </div>
          )}
          <button
            onClick={handleSyncLiv}
            disabled={livSyncStatus === 'fetching'}
            style={{ ...S.btn, ...(livSyncStatus === 'fetching' ? { opacity: 0.5, cursor: 'not-allowed' } : {}) }}
          >
            {livSyncStatus === 'fetching' ? '⏳ Syncing…' : '🔄 Sync LIV Roster'}
          </button>
          {livSyncSummary && (
            <div style={{
              marginTop: 10, padding: '8px 12px', borderRadius: 3, fontSize: fontSize.base, fontFamily: fonts.sans,
              background: livSyncStatus === 'error' ? colors.dangerBg : 'rgba(80,160,100,0.1)',
              border: `1px solid ${livSyncStatus === 'error' ? colors.dangerBorder : 'rgba(80,160,100,0.3)'}`,
              color: livSyncStatus === 'error' ? colors.danger : colors.success,
            }}>
              {livSyncSummary}
            </div>
          )}
        </div>

        <div style={S.section}>
          <div style={S.title}>🚫 LIV Golf — Ineligible Players</div>
          <div style={{ ...theme.smallText, marginBottom: 10, color: colors.textSecondary }}>
            Players flagged as LIV are hidden from the add/drop modal and waiver system.
          </div>
          <input type="text" placeholder="Search players to add/remove LIV flag…"
            value={livSearch} onChange={e => setLivSearch(e.target.value)}
            style={{ ...theme.input, marginBottom: 10, fontSize: fontSize.base }}
          />
          {(() => {
            const livPlayers = allPlayers.filter(p => p.isLiv).sort((a, b) => a.name.localeCompare(b.name));
            // Search: show non-LIV players from allPlayers, plus LIV_GOLF_ROSTER names not yet in DB
            const searchResults = livSearch.trim().length >= 2
              ? (() => {
                  const q = livSearch.toLowerCase();
                  const livNames = new Set(allPlayers.filter(p => p.isLiv).map(p => p.name));
                  // Players in allPlayers that aren't LIV
                  const fromAll = allPlayers
                    .filter(p => p.name && p.name.toLowerCase().includes(q) && !p.isLiv)
                    .map(p => ({ name: p.name, worldRank: p.worldRank }));
                  // LIV_GOLF_ROSTER names not yet in allPlayers at all
                  const existingNames = new Set(allPlayers.map(p => p.name));
                  const fromConst = LIV_GOLF_ROSTER
                    .filter(name => name.toLowerCase().includes(q) && !existingNames.has(name) && !livNames.has(name))
                    .map(name => ({ name, worldRank: null }));
                  return [...fromAll, ...fromConst].slice(0, 10);
                })()
              : [];
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {/* Search results — players to add to LIV list */}
                {searchResults.length > 0 && (
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ fontFamily: fonts.sans, fontSize: fontSize.sm, color: colors.textMuted, letterSpacing: '0.5px', textTransform: 'uppercase', marginBottom: 4 }}>
                      Add to LIV list
                    </div>
                    {searchResults.map(p => (
                      <div key={p.name} style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        padding: '6px 10px', marginBottom: 2, borderRadius: 3,
                        background: 'rgba(80,180,120,0.06)', border: `1px solid rgba(80,180,120,0.2)`,
                      }}>
                        <span style={{ fontFamily: fonts.sans, fontSize: fontSize.base, color: colors.textPrimary }}>
                          {p.name}
                          {p.worldRank && <span style={{ color: colors.textMuted, fontSize: fontSize.sm, marginLeft: 6 }}>#{p.worldRank}</span>}
                        </span>
                        <button
                          disabled={livSaving[p.name]}
                          onClick={async () => {
                            setLivSaving(prev => ({ ...prev, [p.name]: true }));
                            try {
                              await playersApi.upsertMany([{ name: p.name, isLiv: true }]);
                              setAllPlayers(prev => {
                                const exists = prev.some(x => x.name === p.name);
                                if (exists) return prev.map(x => x.name === p.name ? { ...x, isLiv: true } : x);
                                return [...prev, { name: p.name, worldRank: p.worldRank || null, isLiv: true }];
                              });
                              dialog.showToast('Flagged ' + p.name + ' as LIV', 'success');
                              setLivSearch('');
                            } catch(err) { dialog.showToast('Error: ' + err.message, 'error'); }
                            finally { setLivSaving(prev => ({ ...prev, [p.name]: false })); }
                          }}
                          style={{ fontFamily: fonts.sans, fontSize: fontSize.sm, padding: '3px 8px', background: 'rgba(220,60,60,0.15)', border: '1px solid rgba(220,60,60,0.35)', color: colors.danger, borderRadius: 2, cursor: 'pointer' }}
                        >
                          {livSaving[p.name] ? '…' : '+ Flag LIV'}
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Current LIV roster */}
                <div style={{ fontFamily: fonts.sans, fontSize: fontSize.sm, color: colors.textMuted, letterSpacing: '0.5px', textTransform: 'uppercase', marginBottom: 4 }}>
                  {livPlayers.length} flagged player{livPlayers.length !== 1 ? 's' : ''}
                </div>
                {livPlayers.length === 0 ? (
                  <div style={{ ...theme.smallText, textAlign: 'center', padding: '8px 0', color: colors.textMuted }}>No LIV players flagged</div>
                ) : (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {livPlayers.map(p => (
                      <div key={p.name} style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6,
                        padding: '4px 8px', borderRadius: 3,
                        background: 'rgba(220,60,60,0.08)', border: `1px solid rgba(220,60,60,0.2)`,
                        fontSize: fontSize.base, fontFamily: fonts.sans, color: colors.textSecondary,
                      }}>
                        {p.name}
                        <button
                          disabled={livSaving[p.name]}
                          onClick={async () => {
                            setLivSaving(prev => ({ ...prev, [p.name]: true }));
                            try {
                              await playersApi.update(p.name, { isLiv: false });
                              setAllPlayers(prev => prev.map(x => x.name === p.name ? { ...x, isLiv: false } : x));
                              dialog.showToast('Removed LIV flag from ' + p.name, 'success');
                            } catch(err) { dialog.showToast('Error: ' + err.message, 'error'); }
                            finally { setLivSaving(prev => ({ ...prev, [p.name]: false })); }
                          }}
                          style={{ background: 'none', border: 'none', color: 'rgba(220,100,80,0.7)', cursor: 'pointer', fontSize: fontSize.base, padding: 0, lineHeight: 1 }}
                          title={'Remove LIV flag from ' + p.name}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}
        </div>

        <div style={S.section}>
          <button onClick={() => setMergeOpen(o => !o)}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
            <div style={S.title}>🔀 Merge Players</div>
            <span style={{ fontFamily: fonts.sans, fontSize: fontSize.base, color: colors.textMuted, paddingBottom: 12 }}>{mergeOpen ? '▲' : '▼'}</span>
          </button>
          {mergeOpen && <MergePlayersPanel
            allPlayers={allPlayers} teams={teams} transactions={transactions}
            dialog={dialog} updateTeams={updateTeams} setTransactions={setTransactions}
            theme={theme} colors={colors} fonts={fonts} S={S}
            sfglDataApi={sfglDataApi} playersApi={playersApi}
            STORAGE_KEYS={STORAGE_KEYS} disabledBtn={disabledBtn}
          />}
        </div>
      </AdminGroup>

      {/* ─────────────── 3. LEAGUE SETTINGS ─────────────── */}
      <AdminGroup
        id="league-settings"
        title="League Settings"
        icon="⚙️"
        badge={
          (settingsDraft
            || waiverDay    !== (settings?.waiverDay    ?? 2)
            || waiverHour   !== (settings?.waiverHour   ?? 20)
            || waiverMinute !== (settings?.waiverMinute ?? 0))
          ? <UnsavedDot />
          : null
        }
      >
        <div style={S.section}>
          <button onClick={() => { setSettingsOpen(o => !o); setSettingsDraft(null); }}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
            <div style={S.title}>⚙️ Season Settings</div>
            <span style={{ fontFamily: fonts.sans, fontSize: fontSize.base, color: colors.textMuted, paddingBottom: 12 }}>{settingsOpen ? '▲ close' : '▼ edit'}</span>
          </button>
          {settingsOpen && (() => {
            const isEditing = settingsDraft !== null && typeof settingsDraft === 'object';
            const draft = settingsDraft || getSettingsDraft();
            const set = (key, val) => setSettingsDraft({ ...(settingsDraft || getSettingsDraft()), [key]: val });
            const numInput = (key, label, min = 0, dollar = false) => (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <label style={{ fontFamily: fonts.sans, fontSize: fontSize.sm, color: colors.textMuted, letterSpacing: '0.5px', textTransform: 'uppercase' }}>{label}</label>
                <div style={{ position: 'relative' }}>
                  {dollar && <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', fontFamily: fonts.mono, fontSize: fontSize.md, color: colors.textMuted, pointerEvents: 'none' }}>$</span>}
                  <input type="number" min={min} value={draft[key]} onChange={e => set(key, Number(e.target.value))}
                    style={{ ...theme.input, marginBottom: 0, fontSize: fontSize.md, textAlign: dollar ? 'right' : 'center', paddingLeft: dollar ? 18 : undefined, width: '100%', border: isEditing ? '1px solid rgba(220,170,60,0.5)' : undefined }} />
                </div>
              </div>
            );
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 4 }}>
                <div style={{ ...theme.smallText, color: colors.textMuted }}>⚠️ Changes apply immediately to all league calculations.</div>
                <div>
                  <div style={{ fontFamily: fonts.sans, fontSize: fontSize.sm, fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', color: colors.textGold, marginBottom: 8 }}>Round Leader Bonuses</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 8 }}>
                    {numInput('bonusR1Regular', 'R1 — Regular', 0, true)}
                    {numInput('bonusR2Regular', 'R2 — Regular', 0, true)}
                    {numInput('bonusR3Regular', 'R3 — Regular', 0, true)}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                    {numInput('bonusR1Major', 'R1 — Major', 0, true)}
                    {numInput('bonusR2Major', 'R2 — Major', 0, true)}
                    {numInput('bonusR3Major', 'R3 — Major', 0, true)}
                  </div>
                </div>
                <div>
                  <div style={{ fontFamily: fonts.sans, fontSize: fontSize.sm, fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', color: colors.textGold, marginBottom: 8 }}>Transaction Fees ($)</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    {numInput('feeFA', 'Free Agent', 0, true)}
                    {numInput('feeWaiver', 'Waiver Claim', 0, true)}
                  </div>
                </div>
                <div>
                  <div style={{ fontFamily: fonts.sans, fontSize: fontSize.sm, fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', color: colors.textGold, marginBottom: 8 }}>Roster Rules</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                    {numInput('rosterLimit', 'Roster Size', 1)}
                    {numInput('lineupSize', 'Lineup Size', 1)}
                    {numInput('maxLimitedStarts', 'Max ★ Starts', 1)}
                  </div>
                </div>
                {isEditing && (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={async () => { const ok = await dialog.showConfirm('Save Season Settings', 'These changes affect all league calculations immediately. Are you sure?', { confirmText: 'Yes, Save', type: 'warning' }); if (ok) handleSaveSettings(); }}
                      disabled={settingsSaving} style={{ ...S.btn, flex: 1, ...(settingsSaving ? { opacity: 0.5, cursor: 'not-allowed' } : {}) }}>
                      {settingsSaving ? '⏳ Saving…' : '✓ Save Season Settings'}
                    </button>
                    <button onClick={() => setSettingsDraft(null)} style={{ ...theme.btnSecondary, flex: 0, padding: '10px 16px', whiteSpace: 'nowrap' }}>Discard</button>
                  </div>
                )}
              </div>
            );
          })()}
        </div>

        <div style={S.section}>
          <div style={S.title}>🗓️ Waiver Schedule</div>
          <div style={{ ...theme.smallText, color: colors.textSecondary, marginBottom: 12 }}>
            Set the day and time (ET) that waiver claims are processed each week. Default is Tuesday at 8:00 PM ET.
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginBottom: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={S.lbl}>Day</label>
              <select value={waiverDay} onChange={e => setWaiverDay(Number(e.target.value))} style={S.select}>
                {DAY_NAMES.map((d, i) => <option key={i} value={i}>{d}</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label style={S.lbl}>Hour (ET)</label>
              <select value={waiverHour} onChange={e => setWaiverHour(Number(e.target.value))} style={S.select}>
                {Array.from({ length: 24 }, (_, i) => (
                  <option key={i} value={i}>{i === 0 ? '12 AM' : i < 12 ? `${i} AM` : i === 12 ? '12 PM' : `${i - 12} PM`}</option>
                ))}
              </select>
            </div>
            <div style={{ flex: '0 0 80px' }}>
              <label style={S.lbl}>Minute</label>
              <select value={waiverMinute} onChange={e => setWaiverMinute(Number(e.target.value))} style={S.select}>
                {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map(m => (
                  <option key={m} value={m}>:{String(m).padStart(2, '0')}</option>
                ))}
              </select>
            </div>
          </div>
          <div style={{ ...theme.smallText, color: colors.textGoldDim, marginBottom: 10 }}>
            Current: waivers process {DAY_NAMES[waiverDay]} at {fmtWaiverTime(waiverHour, waiverMinute)} ET
            {settings?.waiverDay !== undefined && (settings.waiverDay !== waiverDay || settings.waiverHour !== waiverHour || (settings.waiverMinute ?? 0) !== waiverMinute) && (
              <span style={{ color: colors.warning }}> · unsaved changes</span>
            )}
          </div>
          <button onClick={handleSaveWaiverSchedule} disabled={waiverSaving}
            style={{ ...S.btn, ...(waiverSaving ? { opacity: 0.5, cursor: 'not-allowed' } : {}) }}>
            {waiverSaving ? '⏳ Saving…' : '💾 Save Waiver Schedule'}
          </button>
        </div>
      </AdminGroup>

      {/* ─────────────── 4. MANAGER ACCOUNTS ─────────────── */}
      <AdminGroup
        id="manager-accounts"
        title="Manager Accounts"
        icon="👥"
        badge={emailDraft ? <UnsavedDot /> : null}
      >
        <div style={S.section}>
          <div style={S.title}>🔑 Manager Login Credentials</div>
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

        <div style={S.section}>
          <div style={S.title}>📧 Manager Emails</div>
          <div style={{ ...theme.smallText, color: colors.textSecondary, marginBottom: 12 }}>
            Set email addresses for each manager. Used for waiver results, tournament results, and lineup reminders.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
            {teams.map(t => {
              const currentEmail = (settings.managerEmails || {})[t.id] || '';
              const draftValue   = emailDraft?.[t.id] ?? currentEmail;
              // Email regex: simple format check — catches obvious typos
              const isValid = !draftValue.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draftValue.trim());
              return (
                <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontFamily: fonts.sans, fontSize: fontSize.base, fontWeight: 600, color: colors.textPrimary, width: 120, flexShrink: 0 }}>{t.name}</span>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <input
                      type="email"
                      placeholder="email@example.com"
                      value={draftValue}
                      onChange={e => setEmailDraft(prev => ({ ...(prev || {}), [t.id]: e.target.value }))}
                      style={{
                        ...theme.input, fontSize: fontSize.base, padding: '7px 10px',
                        borderColor: !isValid ? colors.dangerBorder : colors.borderInput,
                      }}
                    />
                    {!isValid && (
                      <span style={{ fontFamily: fonts.sans, fontSize: fontSize.sm, color: colors.danger, paddingLeft: 2 }}>
                        ⚠ Invalid email
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {(() => {
            // Disable Save if any draft email fails validation
            const allValid = !emailDraft || Object.values(emailDraft).every(v =>
              !v.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())
            );
            const canSave = !!emailDraft && allValid;
            return (
              <button
                onClick={async () => {
                  if (!canSave) return;
                  const merged = { ...(settings.managerEmails || {}), ...emailDraft };
                  try {
                    await setSettings({ ...settings, managerEmails: merged });
                    dialog.showToast('✓ Manager emails saved', 'success');
                    setEmailDraft(null);
                  } catch (err) {
                    dialog.showToast('Error: ' + err.message, 'error');
                  }
                }}
                disabled={!canSave}
                style={{ ...S.btn, ...(!canSave ? { opacity: 0.4, cursor: 'not-allowed' } : {}) }}
              >
                {!emailDraft ? '💾 Save Emails' : !allValid ? '⚠ Fix invalid emails to save' : '💾 Save Emails'}
              </button>
            );
          })()}
        </div>
      </AdminGroup>

      {showDraftModal && <DraftModal teams={teams} allPlayers={allPlayers} updateTeams={updateTeams} onClose={() => setShowDraftModal(false)} headshots={headshots} />}
    </div>
  );
};
