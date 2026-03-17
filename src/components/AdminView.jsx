import React, { useState } from 'react';
import { useDialog } from './DialogContext';
import { getSegmentByDate, normalizePlayerName } from '../utils';
import { storage } from '../api';
import { DraftModal } from './DraftModal';
import { managerAuthApi, tournamentResultsApi, sfglDataApi, playersApi } from '../api/firebase';
import { theme, colors, fonts } from '../theme.js';
import { BONUSES_REGULAR, BONUSES_MAJOR, LIV_GOLF_ROSTER } from '../constants';


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
  const [hsSearch,   setHsSearch]   = useState('');
  const [hsSaving,   setHsSaving]   = useState({});
  const [hsFetching, setHsFetching] = useState(false);

  const handleAutoFetchHeadshots = async (namesToLookup) => {
    if (!namesToLookup?.length) return;
    setHsFetching(true);
    try {
      const resp = await fetch('/api/headshots?names=' + encodeURIComponent(namesToLookup.join(',')));
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Fetch failed');

      const { results, notFound } = data;
      if (!Object.keys(results).length) {
        dialog.showToast('No IDs found automatically', 'error');
        return;
      }

      // Save each found ID
      const newHeadshots = { ...headshots };
      let saved = 0;
      for (const [name, id] of Object.entries(results)) {
        if (id && !headshots[name]) {
          try {
            await playersApi.update(name, { pgaTourId: parseInt(id) || id });
            newHeadshots[name] = String(id);
            saved++;
          } catch (_) {}
        }
      }
      setHeadshots(newHeadshots);
      const msg = `✓ Found ${saved} IDs` + (notFound.length ? ` · ${notFound.length} not found: ${notFound.slice(0,3).join(', ')}${notFound.length > 3 ? '…' : ''}` : '');
      dialog.showToast(msg, saved > 0 ? 'success' : 'error');
    } catch (err) {
      dialog.showToast('Error: ' + err.message, 'error');
    } finally {
      setHsFetching(false);
    }
  };
  const [mgCredName, setMgCredName] = useState('');
  const [mgCredPass, setMgCredPass] = useState('');
  const [mgCredSaving, setMgCredSaving] = useState(false);
  const [showDraftModal, setShowDraftModal] = useState(false);
  const [swingAwardSeg, setSwingAwardSeg]   = useState('');
  const [waiverRevealed, setWaiverRevealed] = useState(false);
  const [livSearch, setLivSearch] = useState('');
  const [livSaving, setLivSaving] = useState({});
  const [pgaFetching, setPgaFetching] = useState(false);
  const [pgaTourUrlInput, setPgaTourUrlInput] = useState('');
  const [pgaTourIdInput, setPgaTourIdInput] = useState('');
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
  const disabledBtn = (disabled) => disabled ? { opacity: 0.4, cursor: 'not-allowed', pointerEvents: 'none' } : {};



  // ── Results: PGA Tour fetch ───────────────────────────────────────
  const handleFetchPGAResults = async () => {
    if (!selectedTourney) { dialog.showToast('Select a tournament first', 'error'); return; }
    const ti = tournaments.findIndex(t => t.name === selectedTourney);
    const t = tournaments[ti];

    // Build query params — try all three strategies in order
    const params = new URLSearchParams();
    const savedUrl = pgaTourUrlInput.trim() || t.pgaTourUrl || '';
    const savedId  = pgaTourIdInput.trim()  || t.pgaTourId  || '';

    if (savedUrl) {
      params.set('url', savedUrl);
    } else if (savedId) {
      params.set('pgaTourId', savedId);
      params.set('name', t.name);
      params.set('year', '2026');
    } else {
      params.set('name', t.name);
      params.set('year', '2026');
    }

    setPgaFetching(true);
    try {
      dialog.showToast('Fetching from PGA Tour…', 'info');
      const resp = await fetch(`/api/pga-results?${params.toString()}`);
      const data = await resp.json();

      if (!resp.ok) {
        dialog.showToast(data.error || 'Fetch failed', 'error');
        return;
      }

      const { players, roundLeaders, resolvedUrl } = data;

      // Auto-save the resolved URL onto the tournament for future use
      const urlToSave = savedUrl || resolvedUrl || '';
      if (urlToSave && urlToSave !== t.pgaTourUrl) {
        const newT = tournaments.map((nt, i) => i === ti ? { ...nt, pgaTourUrl: urlToSave } : nt);
        setTournaments(newT);
        sfglDataApi.set(STORAGE_KEYS.TOURNAMENTS, newT).catch(() => {});
      }
      if (savedId && savedId !== t.pgaTourId) {
        const newT = tournaments.map((nt, i) => i === ti ? { ...nt, pgaTourId: savedId } : nt);
        setTournaments(newT);
        sfglDataApi.set(STORAGE_KEYS.TOURNAMENTS, newT).catch(() => {});
      }

      // Pre-fill earnings textarea and round leaders
      const earningsLines = players
        .sort((a, b) => b.earnings - a.earnings)
        .map(p => `${p.name}, ${p.earnings}`)
        .join('\n');

      // Only keep leaders who were actually in an SFGL starting lineup —
      // same rule as the manual dropdown. Filter against current team lineups.
      const startedPlayers = new Set(teams.flatMap(t => t.lineup || []));
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

      dialog.showToast(`✓ Fetched ${players.length} players from PGA Tour`, 'success');
    } catch (err) {
      console.error('[handleFetchPGAResults]', err);
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
      tx2[l._idx] = { ...tx2[l._idx], status: 'failed', failReason: 'Waiver blocked — lost tiebreaker to ' + winner.team, processedDate: new Date().toLocaleDateString() };
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
        cs.slice(1).forEach(l => { failed.add(l.claim._idx); tx2[l.claim._idx] = { ...tx2[l.claim._idx], status: 'failed', failReason: 'Waiver blocked — lost tiebreaker to ' + w.tn, processedDate: new Date().toLocaleDateString() }; f++; }); more = true;
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
  const SWINGS = ['West Coast Swing', 'Spring Swing', 'Summer Swing', 'Fall Finish'];

  // Get the swing a tournament belongs to, using t.segment if set,
  // otherwise infer from the tournament's own dates field (not today's date)
  const getTournamentSegment = (t) => {
    if (t.segment) return t.segment;
    // Parse month from dates: "Feb 9-15" → month=2
    if (t.dates) {
      const m = t.dates.match(/^([A-Za-z]+)/);
      if (m) {
        const months = {Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12};
        const mo = months[m[1]];
        if (mo) {
          if (mo >= 1 && mo <= 3) return 'West Coast Swing';
          if (mo >= 4 && mo <= 6) return 'Spring Swing';
          if (mo >= 7 && mo <= 9) return 'Summer Swing';
          return 'Fall Finish';
        }
      }
    }
    return null;
  };

  const handleSwingWinner = async () => {
    if (!swingAwardSeg) return;

    // Sum all transaction fees for this swing using tournamentIndex range,
    // matching the same logic as TransactionsView's fee counter.
    const swingTournaments = tournaments.filter(t => t.completed && getTournamentSegment(t) === swingAwardSeg && t.results?.teams);
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

    // Debug: log what we found so issues are visible in console
    console.log('[SwingWinner] Swing:', swingAwardSeg);
    console.log('[SwingWinner] Tournaments found:', swingTournaments.map(t => t.name + ' (segment=' + t.segment + ', dates=' + t.dates + ')'));
    console.log('[SwingWinner] Earnings by team:', Object.entries(byTeam).map(([id, e]) => { const t = teams.find(x => x.id === id); return (t?.name || id) + ': $' + e.toLocaleString(); }));

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

  // ── OWGR auto-fetch handler ───────────────────────────────────────────────
  const [owgrStatus, setOwgrStatus] = useState(null); // null | 'fetching' | 'done' | 'error'
  const [owgrSummary, setOwgrSummary] = useState('');

  const handleFetchOwgr = async () => {
    setOwgrStatus('fetching');
    setOwgrSummary('');
    try {
      const resp = await fetch('/api/owgr');
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Fetch failed');

      const { players: fetched } = data;
      if (!fetched?.length) throw new Error('No ranking data returned');

      // Merge into allPlayers — update worldRank for matches, add new entries
      const updatedPlayers = [...allPlayers];
      let updated = 0, added = 0;

      fetched.forEach(({ name, worldRank }) => {
        const idx = updatedPlayers.findIndex(p => p.name.toLowerCase() === name.toLowerCase());
        if (idx >= 0) {
          updatedPlayers[idx] = { ...updatedPlayers[idx], worldRank };
          updated++;
        } else {
          updatedPlayers.push({ name, worldRank });
          added++;
        }
      });

      updatedPlayers.sort((a, b) => (a.worldRank || 9999) - (b.worldRank || 9999));

      await updateRankings(updatedPlayers);
      setOwgrStatus('done');
      setOwgrSummary(`✓ ${fetched.length} players loaded · ${updated} updated · ${added} new`);
    } catch (err) {
      setOwgrStatus('error');
      setOwgrSummary(err.message || 'Failed to fetch rankings');
    }
  };

  const pending = transactions.map((tx, i) => ({ ...tx, _idx: i })).filter(tx => tx.status === 'pending' && tx.type === 'waiver');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 40 }}>

      {/* ── 1. Tournament Results ── */}
      <div style={S.section}>
        <div style={S.title}>🏆 Tournament Results</div>
        <label style={S.lbl}>Tournament</label>
        <select value={selectedTourney} onChange={e => {
          const name = e.target.value;
          setSelectedTourney(name);
          const t = tournaments.find(t => t.name === name);
          // Pre-fill PGA Tour URL/ID inputs from saved tournament data
          setPgaTourUrlInput(t?.pgaTourUrl || '');
          setPgaTourIdInput(t?.pgaTourId || '');
          if (t?.completed && t.results?.earningsMap) {
            const lines = Object.entries(t.results.earningsMap)
              .sort((a, b) => b[1] - a[1])
              .map(([player, amt]) => player + ', ' + amt)
              .join('\n');
            const teamLineups = {};
            if (t.results.fullLineups) {
              Object.entries(t.results.fullLineups).forEach(([teamId, lineup]) => {
                teamLineups[teamId] = [...lineup];
              });
            }
            setManualEntry(prev => ({ ...prev, playerEarnings: lines,
              round1Leaders: t.results.roundLeaders?.round1?.length ? t.results.roundLeaders.round1 : [''],
              round2Leaders: t.results.roundLeaders?.round2?.length ? t.results.roundLeaders.round2 : [''],
              round3Leaders: t.results.roundLeaders?.round3?.length ? t.results.roundLeaders.round3 : [''],
              teamLineups,
            }));
          } else {
            setManualEntry({ round1Leaders: [''], round2Leaders: [''], round3Leaders: [''], playerEarnings: '', teamLineups: {} });
          }
        }} style={S.select}>
          <option value="">Choose tournament...</option>
          {tournaments.map(t => <option key={t.name} value={t.name}>{t.completed ? '✓ ' : t.playing ? '▶ ' : ''}{t.name}</option>)}
        </select>
        {/* PGA Tour fetch — URL / pgaTourId / name fallback */}
        {(() => {
          const t = tournaments.find(t => t.name === selectedTourney);
          const savedUrl = t?.pgaTourUrl || '';
          const savedId  = t?.pgaTourId  || '';
          return (
            <div style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                <input
                  value={pgaTourUrlInput || savedUrl}
                  onChange={e => setPgaTourUrlInput(e.target.value)}
                  placeholder="PGA Tour past-results URL (paste once, auto-saved)…"
                  style={{ ...theme.input, flex: 1, fontSize: 11, marginBottom: 0 }}
                />
              </div>
              <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                <input
                  value={pgaTourIdInput || savedId}
                  onChange={e => setPgaTourIdInput(e.target.value)}
                  placeholder="PGA Tour ID (e.g. R2026011) — optional"
                  style={{ ...theme.input, flex: 1, fontSize: 11, marginBottom: 0 }}
                />
              </div>
              <button
                onClick={handleFetchPGAResults}
                disabled={pgaFetching || !selectedTourney}
                style={{ ...S.btn, marginBottom: 4, ...(!selectedTourney || pgaFetching ? { opacity: 0.4, cursor: 'not-allowed' } : {}) }}
              >
                {pgaFetching ? 'Fetching…' : '⛳ Fetch from PGA Tour'}
              </button>
              <div style={{ textAlign: 'center', fontSize: 10, color: colors.textMuted, marginBottom: 6 }}>
                Auto-fills earnings + round leaders below for review before processing
              </div>
            </div>
          );
        })()}

        <div style={{ borderTop: `1px solid ${colors.borderSubtle}`, paddingTop: 12 }}>
          <div style={{ ...S.lbl, color: colors.textMuted, textAlign: 'center', marginBottom: 10 }}>— or enter manually —</div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <RoundLeaderSelect label="R1 Leader" round={1} leaders={manualEntry.round1Leaders} onChange={r => setManualEntry({ ...manualEntry, round1Leaders: r })} />
            <RoundLeaderSelect label="R2 Leader" round={2} leaders={manualEntry.round2Leaders} onChange={r => setManualEntry({ ...manualEntry, round2Leaders: r })} />
            <RoundLeaderSelect label="R3 Leader" round={3} leaders={manualEntry.round3Leaders} onChange={r => setManualEntry({ ...manualEntry, round3Leaders: r })} />
          </div>

          {/* Lineup overrides (only for completed tournaments being reprocessed) */}
          {tournaments.find(t => t.name === selectedTourney)?.completed && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ ...S.lbl, marginBottom: 6 }}>
                Starting Lineups
                <span style={{ ...theme.smallText, textTransform: 'none', letterSpacing: 0, marginLeft: 6 }}>— correct if roster was edited</span>
              </div>
              {teams.map(team => {
                const currentLineup = manualEntry.teamLineups[team.id] || [];
                return (
                  <div key={team.id} style={{ marginBottom: 10, background: colors.inputBg, border: `1px solid ${colors.borderSubtle}`, borderRadius: 3, padding: '8px 12px' }}>
                    <div style={{ fontFamily: fonts.sans, fontSize: 11, fontWeight: 700, color: colors.textGold, marginBottom: 6, letterSpacing: '0.5px' }}>
                      {team.name}
                      <span style={{ color: colors.textMuted, fontWeight: 400, marginLeft: 8 }}>{currentLineup.length}/5 starters</span>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px' }}>
                      {team.roster.map(p => {
                        const inLineup = currentLineup.includes(p.name);
                        return (
                          <label key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', userSelect: 'none' }}>
                            <input type="checkbox" checked={inLineup}
                              onChange={e => {
                                const updated = e.target.checked ? [...currentLineup, p.name] : currentLineup.filter(n => n !== p.name);
                                setManualEntry(prev => ({ ...prev, teamLineups: { ...prev.teamLineups, [team.id]: updated } }));
                              }}
                              style={{ accentColor: colors.textGold, width: 13, height: 13 }}
                            />
                            <span style={{ fontFamily: fonts.sans, fontSize: 11, color: inLineup ? colors.textPrimary : colors.textMuted }}>
                              {p.name}{p.limited && <span style={{ color: colors.textGoldDim, marginLeft: 3 }}>★</span>}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <label style={S.lbl}>Player Earnings <span style={{ ...theme.smallText, textTransform: 'none', letterSpacing: 0 }}>— one per line: Player Name, 123456</span></label>
          <textarea value={manualEntry.playerEarnings} onChange={e => setManualEntry({ ...manualEntry, playerEarnings: e.target.value })}
            placeholder={'Scottie Scheffler, 3600000\nRory McIlroy, 2160000'} rows={6}
            style={{ ...theme.input, fontFamily: fonts.mono, fontSize: 12, resize: 'vertical', marginBottom: 8 }} />
          <div style={{ display: 'flex', gap: 8 }}>
            {!tournaments.find(t => t.name === selectedTourney)?.completed && (
              <button onClick={handleManualEntry} disabled={!selectedTourney || !manualEntry.playerEarnings.trim()}
                style={{ ...S.btn, flex: 1, ...disabledBtn(!selectedTourney || !manualEntry.playerEarnings.trim()) }}>
                Process Manual Entry
              </button>
            )}
            {tournaments.find(t => t.name === selectedTourney)?.completed && (
              <button onClick={handleReprocess} disabled={!selectedTourney || !manualEntry.playerEarnings.trim()}
                style={{ ...S.btn, flex: 1, background: 'rgba(220,150,50,0.12)', border: '1px solid rgba(220,150,50,0.4)', color: 'rgba(220,180,80,0.9)', ...disabledBtn(!selectedTourney || !manualEntry.playerEarnings.trim()) }}>
                ✏️ Reprocess Tournament
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── 2. Process Waivers ── */}
      <div style={S.section}>
        {/* Tuesday night reminder */}
        {(() => {
          const now = new Date();
          const etOffset = -4;
          const etHour = (now.getUTCHours() + 24 + etOffset) % 24;
          const etDay  = new Date(now.getTime() + etOffset * 3600 * 1000).getUTCDay();
          const isReadyToProcess = etDay === 2 && etHour >= 20 && pending.length > 0;
          if (!isReadyToProcess) return null;
          return (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', marginBottom: 10, borderRadius: 3,
              background: 'rgba(220,170,60,0.1)', border: '1px solid rgba(220,170,60,0.45)',
            }}>
              <span style={{ fontSize: 14 }}>⏰</span>
              <div style={{ flex: 1, fontFamily: fonts.sans, fontSize: 11, color: 'rgba(220,190,80,0.9)', fontWeight: 600 }}>
                Past 8pm ET Tuesday — process now!
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
                  <div style={{ width: 18, height: 18, borderRadius: '50%', background: 'rgba(220,170,60,0.1)', border: '1px solid rgba(220,170,60,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700, color: colors.warning, flexShrink: 0 }}>{w.priority || '?'}</div>
                  <div style={{ fontFamily: fonts.sans, fontSize: 12, fontWeight: 600, color: colors.textPrimary }}>{w.team}</div>
                  <div style={{ flex: 1 }} />
                  <span style={{ fontFamily: fonts.sans, fontSize: 10, color: colors.textMuted }}>claim pending</span>
                </div>
              ))}
            </div>
            <button onClick={() => setWaiverRevealed(true)} style={{ ...S.btnSec, fontSize: 11 }}>Reveal Claims</button>
          </>
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
            <button onClick={() => setWaiverRevealed(false)} style={{ ...theme.btnSecondary, marginTop: 8, fontSize: 10, padding: '4px 12px', width: 'auto', display: 'inline-block' }}>Hide Claims</button>
          </>
        )}
      </div>

      {/* ── 3. Update OWGR ── */}
      <div style={S.section}>
        <div style={S.title}>🌍 Update OWGR Rankings</div>
        {rankingsLastUpdated && (
          <div style={{ ...theme.smallText, color: colors.textGoldDim, marginBottom: 10 }}>
            Last updated: {new Date(Number(rankingsLastUpdated)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
          </div>
        )}
        <button
          onClick={handleFetchOwgr}
          disabled={owgrStatus === 'fetching'}
          style={{ ...S.btn, ...(owgrStatus === 'fetching' ? { opacity: 0.5, cursor: 'not-allowed' } : {}) }}
        >
          {owgrStatus === 'fetching' ? '⏳ Fetching…' : '🌍 Fetch Latest Rankings'}
        </button>
        {owgrSummary && (
          <div style={{
            marginTop: 10, padding: '8px 12px', borderRadius: 3, fontSize: 12, fontFamily: fonts.sans,
            background: owgrStatus === 'error' ? colors.dangerBg : 'rgba(80,160,100,0.1)',
            border: `1px solid ${owgrStatus === 'error' ? colors.dangerBorder : 'rgba(80,160,100,0.3)'}`,
            color: owgrStatus === 'error' ? colors.danger : colors.success,
          }}>
            {owgrSummary}
          </div>
        )}
      </div>

      {/* ── 4. Award Swing Winner ── */}
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
          const swingTourneys = tournaments.filter(t => t.completed && getTournamentSegment(t) === swingAwardSeg && t.results?.teams);
          const byTeam = {};
          swingTourneys.forEach(t => Object.entries(t.results.teams).forEach(([id, tr]) => { byTeam[id] = (byTeam[id] || 0) + (tr.totalEarnings || 0); }));
          const topEntry = Object.entries(byTeam).sort((a, b) => b[1] - a[1])[0];
          const leader = topEntry ? teams.find(t => t.id === topEntry[0]) : null;
          return (
            <div style={{ ...theme.smallText, marginBottom: 10, padding: '8px 10px', background: colors.inputBg, borderRadius: 3, border: `1px solid ${colors.borderSubtle}` }}>
              {leader
                ? <span>🏆 Leader: <span style={{ color: colors.textGold, fontWeight: 600 }}>{leader.name}</span> · ${(topEntry[1] || 0).toLocaleString()} · <span style={{ color: colors.earningsGreen }}>Pot: ${pot.toLocaleString()}</span></span>
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

      {/* ── 5. Headshot Manager ── */}
      <div style={S.section}>
        <div style={S.title}>🖼 Headshot Manager</div>
        <div style={{ ...theme.smallText, marginBottom: 10, color: colors.textSecondary }}>
          Map rostered players to their ESPN athlete ID. Use Auto-Fetch to populate automatically, or find the ID in the ESPN URL: /golfer/rory-mcilroy/<strong style={{ color: colors.textPrimary }}>4696529</strong>/overview
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <input type="text" placeholder="Filter players…"
            value={hsSearch} onChange={e => setHsSearch(e.target.value)}
            style={{ ...theme.input, flex: 1, marginBottom: 0, fontSize: 12 }}
          />
          <button
            onClick={() => {
              const rosteredNames = [...new Set(teams.flatMap(t => {
                const rosterSet = new Set(t.roster.map(p => p.name));
                transactions.filter(tx => tx.team === t.name && tx.type !== 'mulligan' && tx.status === 'processed')
                  .forEach(tx => { if (tx.droppedPlayer) rosterSet.delete(tx.droppedPlayer); if (tx.player) rosterSet.add(tx.player); });
                return [...rosterSet];
              }))].filter(Boolean);
              const missing = rosteredNames.filter(n => !headshots[n]);
              handleAutoFetchHeadshots(missing.length ? missing : rosteredNames);
            }}
            disabled={hsFetching}
            style={{ ...S.btn, whiteSpace: 'nowrap', padding: '8px 12px', width: 'auto',
              ...(hsFetching ? { opacity: 0.5, cursor: 'not-allowed' } : {}) }}
          >
            {hsFetching ? '⏳ Looking up…' : '🔍 Auto-Fetch IDs'}
          </button>
        </div>
        <button
          onClick={async () => {
            const ok = await dialog.showConfirm('Clear All Headshot IDs', 'This will remove all stored headshot IDs. Run Auto-Fetch after to repopulate with ESPN IDs.', { type: 'danger', confirmText: 'Clear All' });
            if (!ok) return;
            const allNames = Object.keys(headshots);
            for (const name of allNames) {
              try { await playersApi.update(name, { pgaTourId: null }); } catch (_) {}
            }
            setHeadshots({});
            dialog.showToast('✓ Cleared ' + allNames.length + ' headshot IDs', 'success');
          }}
          style={{ ...S.btnDgr, marginBottom: 8, padding: '7px 12px', fontSize: 11 }}
        >
          🗑 Clear All IDs
        </button>
        {(() => {
          const rosteredNames = [...new Set(teams.flatMap(t => {
            const rosterSet = new Set(t.roster.map(p => p.name));
            transactions
              .filter(tx => tx.team === t.name && tx.type !== 'mulligan' && tx.status === 'processed')
              .forEach(tx => {
                if (tx.droppedPlayer) rosterSet.delete(tx.droppedPlayer);
                if (tx.player) rosterSet.add(tx.player);
              });
            return [...rosterSet];
          }))].filter(Boolean).sort();
          const missing = rosteredNames.filter(n => !headshots[n]);
          const filtered = hsSearch.trim()
            ? [...new Set([
                ...rosteredNames.filter(n => n.toLowerCase().includes(hsSearch.toLowerCase())),
                ...allPlayers
                  .filter(p => p.name && p.name.toLowerCase().includes(hsSearch.toLowerCase()))
                  .map(p => p.name),
              ])]
            : missing;
          const showingAll = hsSearch.trim().length > 0;
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ ...theme.smallText, marginBottom: 6, color: colors.textMuted }}>
                {showingAll
                  ? `Showing ${filtered.length} result${filtered.length !== 1 ? 's' : ''}`
                  : missing.length === 0
                    ? <span style={{ color: colors.success }}>✓ All rostered players have headshot IDs</span>
                    : `${missing.length} player${missing.length !== 1 ? 's' : ''} missing IDs`
                }
              </div>
              {filtered.map(name => {
                const currentId = headshots[name] || '';
                const hasSrc    = !!currentId;
                const saving    = hsSaving[name];
                return (
                  <div key={name} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    background: colors.inputBg, border: `1px solid ${hasSrc ? colors.borderSubtle : 'rgba(220,100,80,0.25)'}`,
                    borderRadius: 3, padding: '6px 10px',
                  }}>
                    <img
                      src={hasSrc
                        ? (currentId.startsWith('http') ? currentId : `https://a.espncdn.com/i/headshots/golf/players/full/${currentId}.png`)
                        : `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=1c3a5e&color=ffffff&size=96&bold=true&font-size=0.38`
                      }
                      onError={e => { e.target.onerror = null; e.target.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=1c3a5e&color=ffffff&size=96&bold=true&font-size=0.38`; }}
                      alt="" style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover', border: `1px solid ${colors.borderSubtle}`, flexShrink: 0 }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.textPrimary, fontWeight: 500 }}>{name}</div>
                      {!hasSrc && <div style={{ fontFamily: fonts.sans, fontSize: 10, color: 'rgba(220,100,80,0.8)' }}>No ID set</div>}
                    </div>
                    <input
                      type="text" defaultValue={currentId} placeholder="PGA Tour ID"
                      onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); }}
                      onBlur={async e => {
                        const val = e.target.value.trim();
                        if (val === currentId) return;
                        setHsSaving(prev => ({ ...prev, [name]: true }));
                        try {
                          await playersApi.update(name, { pgaTourId: val ? parseInt(val) || val : null });
                          setHeadshots({ ...headshots, [name]: val });
                          dialog.showToast('✓ Updated ' + name, 'success');
                        } catch(err) {
                          if (err.message?.includes('players_pga_tour_id_key')) {
                            const existing = Object.entries(headshots).find(([n, id]) => String(id) === String(val) && n !== name);
                            const who = existing ? ` — already assigned to "${existing[0]}"` : ' — already assigned to another player';
                            dialog.showToast(`ID ${val} is a duplicate${who}`, 'error');
                            e.target.value = currentId;
                          } else {
                            dialog.showToast('Error: ' + err.message, 'error');
                          }
                        } finally {
                          setHsSaving(prev => ({ ...prev, [name]: false }));
                        }
                      }}
                      style={{ ...theme.input, width: 100, fontSize: 12, padding: '5px 8px', marginBottom: 0,
                        textAlign: 'center', fontFamily: fonts.mono, opacity: saving ? 0.5 : 1 }}
                    />
                  </div>
                );
              })}
              {filtered.length === 0 && (
                <div style={{ ...theme.smallText, textAlign: 'center', padding: '12px 0' }}>No players found</div>
              )}
            </div>
          );
        })()}
      </div>

      {/* ── 6. LIV Golf Ineligible Players ── */}
      <div style={S.section}>
        <div style={S.title}>🚫 LIV Golf — Ineligible Players</div>
        <div style={{ ...theme.smallText, marginBottom: 10, color: colors.textSecondary }}>
          Players flagged as LIV are hidden from the add/drop modal and waiver system.
        </div>
        <input type="text" placeholder="Search players to add/remove LIV flag…"
          value={livSearch} onChange={e => setLivSearch(e.target.value)}
          style={{ ...theme.input, marginBottom: 10, fontSize: 12 }}
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
                  <div style={{ fontFamily: fonts.sans, fontSize: 10, color: colors.textMuted, letterSpacing: '0.5px', textTransform: 'uppercase', marginBottom: 4 }}>
                    Add to LIV list
                  </div>
                  {searchResults.map(p => (
                    <div key={p.name} style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '6px 10px', marginBottom: 2, borderRadius: 3,
                      background: 'rgba(80,180,120,0.06)', border: `1px solid rgba(80,180,120,0.2)`,
                    }}>
                      <span style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.textPrimary }}>
                        {p.name}
                        {p.worldRank && <span style={{ color: colors.textMuted, fontSize: 10, marginLeft: 6 }}>#{p.worldRank}</span>}
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
                        style={{ fontFamily: fonts.sans, fontSize: 10, padding: '3px 8px', background: 'rgba(220,60,60,0.15)', border: '1px solid rgba(220,60,60,0.35)', color: colors.danger, borderRadius: 2, cursor: 'pointer' }}
                      >
                        {livSaving[p.name] ? '…' : '+ Flag LIV'}
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Current LIV roster */}
              <div style={{ fontFamily: fonts.sans, fontSize: 10, color: colors.textMuted, letterSpacing: '0.5px', textTransform: 'uppercase', marginBottom: 4 }}>
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
                      fontSize: 11, fontFamily: fonts.sans, color: colors.textSecondary,
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
                        style={{ background: 'none', border: 'none', color: 'rgba(220,100,80,0.7)', cursor: 'pointer', fontSize: 12, padding: 0, lineHeight: 1 }}
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

      {/* ── 7. Manager Login Credentials ── */}
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

      {/* ── 7. Draft ── */}
      <div style={S.section}>
        <div style={S.title}>🎯 Draft</div>
        <button onClick={() => setShowDraftModal(true)} style={S.btn}>Open Draft Room</button>
      </div>

      {showDraftModal && <DraftModal teams={teams} allPlayers={allPlayers} updateTeams={updateTeams} onClose={() => setShowDraftModal(false)} headshots={headshots} />}
    </div>
  );
};

