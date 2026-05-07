// src/pages/admin/TournamentResultsPanel.jsx
// ============================================================================
// Tournament results processing — covers all three flows:
//   1. Fetch live results from PGA Tour and pre-fill earnings textarea
//   2. Manual entry → process tournament, mark complete, advance "playing" pointer
//   3. Reprocess a completed tournament with corrected earnings
//
// Wave I extraction from AdminView.
// ============================================================================

import React from 'react';
import { useDialog } from '../DialogContext';
import { theme, colors, fonts } from '../../theme.js';
import { sfglDataApi } from '../../api/firebase';
import { processTournamentData } from './processTournamentData';
import { S, disabledBtn } from './adminStyles';

// ── Round-leader dropdown (uses stored tournament lineups + R3 mulligan additions) ──
const RoundLeaderSelect = ({
  label, leaders, onChange, round,
  selectedTourney, tournaments, transactions, teams, manualEntry,
}) => {
  const teamLineups = manualEntry.teamLineups || {};
  const selectedTIdx = tournaments.findIndex(t => t.name === selectedTourney);
  const tourneyMulligans = transactions.filter(tx =>
    tx.type === 'mulligan' && tx.tournamentIndex === selectedTIdx && tx.status === 'processed'
  );

  const players = teams.flatMap(team => {
    const lineup = teamLineups[team.id] || team.lineup || [];
    let names = [...lineup];
    if (round >= 3) {
      tourneyMulligans
        .filter(tx => tx.team === team.name && tx.player)
        .forEach(tx => { if (!names.includes(tx.player)) names.push(tx.player); });
    }
    return names.map(name => ({ name, team: team.name }));
  }).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div style={{ flex: 1 }}>
      <div style={S.lbl}>{label}</div>
      {leaders.map((leader, idx) => (
        <div key={idx} style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
          <select
            value={leader}
            onChange={e => { const n = [...leaders]; n[idx] = e.target.value; onChange(n); }}
            style={{ ...theme.select, flex: 1, marginBottom: 0, fontSize: 12, padding: '7px 8px' }}
          >
            <option value="">(none)</option>
            {players.map(p => <option key={p.name + p.team} value={p.name}>{p.name} — {p.team}</option>)}
          </select>
          {idx > 0 && (
            <button
              onClick={() => onChange(leaders.filter((_, i) => i !== idx))}
              style={{ background: 'none', border: `1px solid ${colors.dangerBorder}`, color: colors.danger, borderRadius: 2, padding: '4px 7px', cursor: 'pointer', fontSize: 11 }}
              aria-label="Remove leader"
            >
              ✕
            </button>
          )}
        </div>
      ))}
      <button
        onClick={() => onChange([...leaders, ''])}
        style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: colors.textGoldDim, padding: 0 }}
      >
        + co-leader
      </button>
    </div>
  );
};

const EMPTY_ENTRY = { round1Leaders: [''], round2Leaders: [''], round3Leaders: [''], playerEarnings: '', teamLineups: {} };

// Parse "Player Name, 1234567" lines into a Map<name, number>.
const parseEarningsLines = (text) => {
  const map = new Map();
  text.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const m = trimmed.match(/^(.+?),\s*([\d,]+)$/);
    if (m) {
      const amt = parseInt(m[2].replace(/,/g, ''));
      if (!isNaN(amt) && amt >= 0) map.set(m[1].trim(), amt);
    }
  });
  return map;
};

export const TournamentResultsPanel = ({
  tournaments, setTournaments,
  teams, updateTeams,
  transactions,
  globalPlayerStats, setGlobalPlayerStats,
  STORAGE_KEYS,
}) => {
  const dialog = useDialog();
  const [selectedTourney, setSelectedTourney] = React.useState('');
  const [manualEntry, setManualEntry] = React.useState(EMPTY_ENTRY);
  const [pgaFetching, setPgaFetching] = React.useState(false);

  // Auto-select active tournament on load
  React.useEffect(() => {
    const active = tournaments.find(t => t.playing);
    if (active && !selectedTourney) setSelectedTourney(active.name);
  }, [tournaments, selectedTourney]);

  const onTourneyChange = (name) => {
    setSelectedTourney(name);
    const t = tournaments.find(t => t.name === name);
    if (t?.completed && t.results) {
      const lines = t.results.earningsMap
        ? Object.entries(t.results.earningsMap).sort((a, b) => b[1] - a[1]).map(([p, a]) => `${p}, ${a}`).join('\n')
        : '';
      const teamLineups = {};
      if (t.results.fullLineups) Object.entries(t.results.fullLineups).forEach(([id, lu]) => { teamLineups[id] = [...lu]; });
      setManualEntry(prev => ({
        ...prev,
        playerEarnings: lines, teamLineups,
        round1Leaders: t.results.roundLeaders?.round1?.length ? t.results.roundLeaders.round1 : [''],
        round2Leaders: t.results.roundLeaders?.round2?.length ? t.results.roundLeaders.round2 : [''],
        round3Leaders: t.results.roundLeaders?.round3?.length ? t.results.roundLeaders.round3 : [''],
      }));
    } else {
      setManualEntry(EMPTY_ENTRY);
    }
  };

  const handleFetchPGAResults = async () => {
    if (!selectedTourney) { dialog.showToast('Select a tournament first', 'error'); return; }
    const t = tournaments.find(t => t.name === selectedTourney);
    const params = new URLSearchParams({ name: t.name, year: '2026' });

    setPgaFetching(true);
    try {
      dialog.showToast('Fetching results…', 'info');
      const resp = await fetch(`/api/pga-results?${params.toString()}`);
      const data = await resp.json();
      if (!resp.ok) { dialog.showToast(data.error || 'Fetch failed', 'error'); return; }

      const { players, roundLeaders } = data;
      const earningsLines = players
        .sort((a, b) => b.earnings - a.earnings)
        .map(p => `${p.name}, ${p.earnings}`)
        .join('\n');

      // Only keep leaders who were actually in an SFGL starting lineup.
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

      dialog.showToast(`✓ ${players.length} players loaded`, 'success');
    } catch (err) {
      dialog.showToast('Error: ' + err.message, 'error');
    } finally {
      setPgaFetching(false);
    }
  };

  const handleManualEntry = async () => {
    try {
      if (!selectedTourney) { dialog.showToast('Select a tournament first', 'error'); return; }
      const tournament = tournaments.find(t => t.name === selectedTourney);
      if (!tournament) { dialog.showToast('Tournament not found', 'error'); return; }
      if (tournament.completed) {
        const ok = await dialog.showConfirm('Already Processed', 'Re-entering will ADD earnings again (doubling them). Continue?', { type: 'danger', confirmText: 'Re-enter Results' });
        if (!ok) return;
      }
      const earningsMap = parseEarningsLines(manualEntry.playerEarnings);
      if (!earningsMap.size) { dialog.showToast('No valid earnings lines found. Format: "Player Name, 123456"', 'error'); return; }

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

      // Mark tournament completed, advance playing to next non-alternate.
      const newT = tournaments.map((nt, i) => i === ti ? { ...nt, completed: true, playing: false, results: resultsData } : nt);
      const nx = newT.findIndex((nt, i) => i > ti && !nt.completed && !nt.isAlternate);
      if (nx !== -1) { newT.forEach(nt => { nt.playing = false; }); newT[nx].playing = true; }

      updateTeams(newTeams);
      setGlobalPlayerStats(newStats);
      setTournaments(newT);
      sfglDataApi.set(STORAGE_KEYS.TOURNAMENTS, newT).catch(() => {});
      sfglDataApi.set(STORAGE_KEYS.GLOBAL_PLAYER_STATS, newStats).catch(() => {});

      dialog.showToast('Results processed! ' + earningsMap.size + ' players · ' + Object.keys(resultsData.teams).length + ' teams scored', 'success');

      // Notify managers via email
      try {
        const teamResultsForEmail = newTeams.filter(t => resultsData.teams[t.id]).map(t => ({
          team: t.name,
          totalEarnings: resultsData.teams[t.id].totalEarnings || 0,
        }));
        await fetch('/api/notify-results', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tournamentName: selectedTourney, teamResults: teamResultsForEmail }),
        });
        dialog.showToast('📧 Results emails sent', 'success');
      } catch (emailErr) {
        console.warn('Results email failed:', emailErr);
      }

      setManualEntry(EMPTY_ENTRY);
    } catch (err) {
      console.error('handleManualEntry error:', err);
      dialog.showToast('Error processing results: ' + err.message, 'error');
    }
  };

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
      const earningsMap = parseEarningsLines(manualEntry.playerEarnings);
      if (!earningsMap.size) { dialog.showToast('No valid earnings lines found', 'error'); return; }

      // Step 1: Reverse old results
      const oldResults = tournament.results;
      let reversedTeams = teams.map(team => {
        const oldTeamResult = oldResults?.teams?.[team.id];
        if (!oldTeamResult) return team;
        const earningsDelta = -(oldTeamResult.totalEarnings || 0);
        const oldLineup = new Set(oldResults.fullLineups?.[team.id] || (oldTeamResult.players || []).map(p => p.name || p));
        const oldEarningsByPlayer = {};
        (oldTeamResult.players || []).forEach(p => { oldEarningsByPlayer[p.name || p] = p.earnings || 0; });
        const newRoster = team.roster.map(p => {
          if (!oldLineup.has(p.name)) return p;
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

      const newT = tournaments.map((nt, i) => i === ti ? { ...nt, results: resultsData } : nt);
      updateTeams(newTeams);
      setGlobalPlayerStats(newStats);
      setTournaments(newT);
      sfglDataApi.set(STORAGE_KEYS.TOURNAMENTS, newT).catch(() => {});
      sfglDataApi.set(STORAGE_KEYS.GLOBAL_PLAYER_STATS, newStats).catch(() => {});

      dialog.showToast('✓ Reprocessed ' + selectedTourney + ' with corrected earnings', 'success');
      setManualEntry(EMPTY_ENTRY);
    } catch (err) {
      console.error('handleReprocess error:', err);
      dialog.showToast('Error reprocessing: ' + err.message, 'error');
    }
  };

  const isCompleted = !!tournaments.find(t => t.name === selectedTourney)?.completed;

  return (
    <div style={S.section}>
      <div style={S.title}>🏆 Tournament Results</div>
      <label style={S.lbl}>Tournament</label>
      <select value={selectedTourney} onChange={e => onTourneyChange(e.target.value)} style={S.select}>
        <option value="">Choose tournament...</option>
        {tournaments.map(t => <option key={t.name} value={t.name}>{t.completed ? '✓ ' : t.playing ? '▶ ' : ''}{t.name}</option>)}
      </select>

      <button
        onClick={handleFetchPGAResults}
        disabled={pgaFetching || !selectedTourney}
        style={{ ...S.btn, marginBottom: 14, ...disabledBtn(!selectedTourney || pgaFetching) }}
      >
        {pgaFetching ? '⏳ Fetching…' : selectedTourney ? `⛳ Get ${selectedTourney} Results` : '⛳ Get Tournament Results'}
      </button>

      {manualEntry.playerEarnings.trim() && (
        <>
          <div style={{ ...theme.smallText, color: colors.textSecondary, marginBottom: 8 }}>
            Round leaders auto-detected — override if incorrect:
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            {[1, 2, 3].map(round => (
              <RoundLeaderSelect
                key={round}
                label={`R${round} Leader`}
                round={round}
                leaders={manualEntry[`round${round}Leaders`]}
                onChange={r => setManualEntry({ ...manualEntry, [`round${round}Leaders`]: r })}
                selectedTourney={selectedTourney}
                tournaments={tournaments}
                transactions={transactions}
                teams={teams}
                manualEntry={manualEntry}
              />
            ))}
          </div>

          {!isCompleted ? (
            <button
              onClick={handleManualEntry}
              disabled={!selectedTourney}
              style={{ ...S.btn, ...disabledBtn(!selectedTourney) }}
            >
              ✅ Process Results
            </button>
          ) : (
            <button
              onClick={handleReprocess}
              disabled={!selectedTourney}
              style={{
                ...S.btn,
                background: 'rgba(220,150,50,0.12)',
                border: '1px solid rgba(220,150,50,0.4)',
                color: 'rgba(220,180,80,0.9)',
                ...disabledBtn(!selectedTourney),
              }}
            >
              ✏️ Reprocess Tournament
            </button>
          )}
        </>
      )}
    </div>
  );
};
