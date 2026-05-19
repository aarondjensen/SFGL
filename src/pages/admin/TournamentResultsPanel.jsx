// src/pages/admin/TournamentResultsPanel.jsx
// ============================================================================
// Tournament results processing — covers all three flows:
//   1. Fetch live results from PGA Tour and pre-fill earnings textarea
//   2. Manual entry → process tournament, mark complete, advance "playing" pointer
//   3. Reprocess a completed tournament with corrected earnings
//
// Wave I.2: after process/reprocess, automatically check whether the just-
// processed tournament completes a swing. If so, award the pot to the leader
// in the same write — keeps the manual SwingWinnerPanel as a safety-net only.
// ============================================================================

import React from 'react';
import { useDialog } from '../DialogContext';
import { colors, fonts } from '../../theme.js';
import { sfglDataApi } from '../../api/firebase';
import { sendCommishPush } from '../../api/pushNotifications';
import { processTournamentData } from './processTournamentData';
import { maybeAwardForCompletedTournament } from '../../utils/swingAward';
import { S, M, disabledBtn } from './adminStyles';
import { STORAGE_KEYS } from '../../constants';

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
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={M.eyebrow}>{label}</div>
      {leaders.map((leader, idx) => (
        <div key={idx} style={{ display: 'flex', gap: 4 }}>
          <select
            value={leader}
            onChange={e => { const n = [...leaders]; n[idx] = e.target.value; onChange(n); }}
            style={{ ...M.select, flex: 1, fontSize: 12, padding: '7px 8px' }}
          >
            <option value="">(none)</option>
            {players.map(p => <option key={p.name + p.team} value={p.name}>{p.name} — {p.team}</option>)}
          </select>
          {idx > 0 && (
            <button
              onClick={() => onChange(leaders.filter((_, i) => i !== idx))}
              style={{
                background: 'rgba(220,80,80,0.08)',
                border: '1px solid rgba(220,80,80,0.3)',
                color: colors.danger,
                borderRadius: 6,
                padding: '4px 8px',
                cursor: 'pointer',
                fontSize: 11,
                flexShrink: 0,
              }}
              aria-label="Remove leader"
            >
              ✕
            </button>
          )}
        </div>
      ))}
      <button
        onClick={() => onChange([...leaders, ''])}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          fontSize: 11,
          color: colors.textGoldDim,
          padding: '2px 0',
          textAlign: 'left',
          alignSelf: 'flex-start',
        }}
      >
        + co-leader
      </button>
    </div>
  );
};

const EMPTY_ENTRY = { round1Leaders: [''], round2Leaders: [''], round3Leaders: [''], playerEarnings: '', teamLineups: {} };

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
  transactions, setTransactions,
  globalPlayerStats, setGlobalPlayerStats,
  loggedInUser,
}) => {
  const dialog = useDialog();
  const [selectedTourney, setSelectedTourney] = React.useState('');
  const [manualEntry, setManualEntry] = React.useState(EMPTY_ENTRY);
  const [pgaFetching, setPgaFetching] = React.useState(false);
  const [resending, setResending] = React.useState(false);

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

      // ── Wave I.2: auto-award if this completes a swing ──
      // Computed BEFORE we call updateTeams/setTransactions so the award
      // updates can be merged into a single write.
      const award = maybeAwardForCompletedTournament({
        justProcessedTournament: newT[ti],
        allTournaments: newT,
        transactions,
        teams: newTeams,
      });
      const finalTeams = award ? award.updatedTeams : newTeams;
      const finalTransactions = award ? [...transactions, award.newTx] : transactions;

      updateTeams(finalTeams);
      setGlobalPlayerStats(newStats);
      setTournaments(newT);
      if (award) {
        setTransactions(finalTransactions);  // array form — useLeague.updateTransactions expects an array, not a callback
        await sfglDataApi.set(STORAGE_KEYS.TRANSACTIONS, finalTransactions).catch(() => {});
      }
      sfglDataApi.set(STORAGE_KEYS.TOURNAMENTS, newT).catch(() => {});
      sfglDataApi.set(STORAGE_KEYS.GLOBAL_PLAYER_STATS, newStats).catch(() => {});

      dialog.showToast('Results processed! ' + earningsMap.size + ' players · ' + Object.keys(resultsData.teams).length + ' teams scored', 'success');

      if (award) {
        dialog.showToast(
          `🏆 ${award.segment} complete! ${award.winnerTeam.name} (${award.winnerTeam.owner}) wins the $${award.pot.toLocaleString()} pot`,
          'success'
        );
      }

      // Notify managers via email — include swing-award banner if one fired
      try {
        const teamResultsForEmail = finalTeams.filter(t => resultsData.teams[t.id]).map(t => ({
          team: t.name,
          totalEarnings: resultsData.teams[t.id].totalEarnings || 0,
        }));
        const body = { tournamentName: selectedTourney, teamResults: teamResultsForEmail };
        if (award) {
          body.swingAward = {
            segment: award.segment,
            winnerTeamName: award.winnerTeam.name,
            pot: award.pot,
          };
        }
        await fetch('/api/notify-results', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        dialog.showToast('📧 Results emails sent', 'success');
      } catch (emailErr) {
        console.warn('Results email failed:', emailErr);
      }

      // ── Push notification (Wave J Round 6 batch 4) ──────────────────────
      // Manual results processing path — broadcast a 'results' push to all
      // managers with each team's personalized earnings line. The cron auto-
      // process path also pushes (in api/cron.js handleProcessResults), but
      // these two paths are mutually exclusive (cron skips tournaments
      // already marked completed). No double-push risk.
      //
      // Best-effort: failures here don't roll back the results commit.
      const commishTeam = finalTeams.find(t => t.owner === loggedInUser);
      if (commishTeam?.id) {
        for (const t of finalTeams) {
          if (!t.id) continue;
          const teamResult = resultsData.teams[t.id];
          const earnings = teamResult ? (teamResult.totalEarnings || 0) : 0;
          const pushBody = teamResult
            ? `${selectedTourney}: you earned $${earnings.toLocaleString()}`
            : `Results are in for ${selectedTourney}`;
          sendCommishPush({
            event: 'results',
            commishTeamId: commishTeam.id,
            recipients: [t.id],
            title: '🏆 Results processed',
            body: pushBody,
            deepLink: '#standings',
          }).catch(err => console.warn(`[push] results send failed for ${t.name}:`, err.message));
        }
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

      // ── Wave I.2: auto-award if reprocess somehow completes a swing ──
      // Almost always a no-op for reprocess (already-awarded swings are
      // idempotently skipped) but covers the edge case of correcting a
      // tournament that had been incompletely processed.
      const award = maybeAwardForCompletedTournament({
        justProcessedTournament: newT[ti],
        allTournaments: newT,
        transactions,
        teams: newTeams,
      });
      const finalTeams = award ? award.updatedTeams : newTeams;
      const finalTransactions = award ? [...transactions, award.newTx] : transactions;

      updateTeams(finalTeams);
      setGlobalPlayerStats(newStats);
      setTournaments(newT);
      if (award) {
        setTransactions(finalTransactions);  // array form — useLeague.updateTransactions expects an array, not a callback
        await sfglDataApi.set(STORAGE_KEYS.TRANSACTIONS, finalTransactions).catch(() => {});
      }
      sfglDataApi.set(STORAGE_KEYS.TOURNAMENTS, newT).catch(() => {});
      sfglDataApi.set(STORAGE_KEYS.GLOBAL_PLAYER_STATS, newStats).catch(() => {});

      dialog.showToast('✓ Reprocessed ' + selectedTourney + ' with corrected earnings', 'success');
      if (award) {
        dialog.showToast(
          `🏆 ${award.segment} complete! ${award.winnerTeam.name} wins the $${award.pot.toLocaleString()} pot`,
          'success'
        );
      }
      setManualEntry(EMPTY_ENTRY);
    } catch (err) {
      console.error('handleReprocess error:', err);
      dialog.showToast('Error reprocessing: ' + err.message, 'error');
    }
  };

  // Resend notifications for an already-processed tournament.
  // Used when the original processing succeeded but the email/push step
  // failed (e.g. the STORAGE_KEYS crash on May 18 that left PGA Championship
  // processed but un-notified). Pulls earnings from the stored tournament
  // results — no recompute, no risk of double-applying earnings.
  const handleResendNotifications = async () => {
    if (!selectedTourney) { dialog.showToast('Select a tournament first', 'error'); return; }
    const t = tournaments.find(t => t.name === selectedTourney);
    if (!t?.completed || !t?.results) {
      dialog.showToast('Tournament has no stored results to notify on', 'error');
      return;
    }
    const ok = await dialog.showConfirm(
      'Resend notifications?',
      `Resend results email + broadcast push for ${selectedTourney} to all managers. Use this only if the original notifications failed.`,
      { type: 'warning', confirmText: 'Send', cancelText: 'Cancel' }
    );
    if (!ok) return;

    setResending(true);
    try {
      const resultsData = t.results || {};
      const resultsTeams = resultsData.teams || {};

      // Email — uses the stored per-team totalEarnings
      try {
        const teamResultsForEmail = teams
          .filter(team => resultsTeams[team.id])
          .map(team => ({
            team: team.name,
            totalEarnings: resultsTeams[team.id].totalEarnings || 0,
          }));
        if (teamResultsForEmail.length === 0) {
          dialog.showToast('No team results in this tournament — nothing to email', 'error');
        } else {
          const resp = await fetch('/api/notify-results', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              tournamentName: selectedTourney,
              teamResults: teamResultsForEmail,
            }),
          });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          dialog.showToast('📧 Results emails sent', 'success');
        }
      } catch (emailErr) {
        console.warn('Resend email failed:', emailErr);
        dialog.showToast('Email send failed: ' + emailErr.message, 'error');
      }

      // Push — per-team personalized body, mirrors the manual-process path
      const commishTeam = teams.find(team => team.owner === loggedInUser);
      if (!commishTeam?.id) {
        dialog.showToast('Could not send push — commish team not found', 'error');
        return;
      }
      let pushesQueued = 0;
      for (const team of teams) {
        if (!team.id) continue;
        const teamResult = resultsTeams[team.id];
        const earnings = teamResult ? (teamResult.totalEarnings || 0) : 0;
        const pushBody = teamResult
          ? `${selectedTourney}: you earned $${earnings.toLocaleString()}`
          : `Results are in for ${selectedTourney}`;
        sendCommishPush({
          event: 'results',
          commishTeamId: commishTeam.id,
          recipients: [team.id],
          title: '🏆 Results processed',
          body: pushBody,
          deepLink: '#standings',
        }).catch(err => console.warn(`[push] resend failed for ${team.name}:`, err.message));
        pushesQueued++;
      }
      dialog.showToast(`📲 Push notifications queued for ${pushesQueued} teams`, 'success');
    } catch (err) {
      console.error('handleResendNotifications error:', err);
      dialog.showToast('Error resending: ' + err.message, 'error');
    } finally {
      setResending(false);
    }
  };

  // ── Undo Tournament Results ──────────────────────────────────────────────
  // TEMPORARY testing tool. Reverts a processed tournament back to
  // "playing/not-completed" and reverses every state change the processing
  // applied:
  //   • Per-team:
  //       lineup        ← results.fullLineups[id]   (was [] after process)
  //       backup        ← results.fullBackups[id]   (was null after process)
  //       earnings      −= results.teams[id].totalEarnings
  //       segmentEarnings −= results.teams[id].totalEarnings
  //       roster[player].starts     −= 1 for each lineup player
  //       roster[player].sfglEarnings −= per-player earnings
  //   • Global stats: eventsPlayed, cutsMade, pgaTourEarnings reversed for
  //     every player in results.earningsMap
  //   • Tournament: completed=false, playing=true, results=null
  //   • The next tournament that was advanced to playing=true gets reset
  //   • Any auto-awarded swing_winner transaction created at this tournament
  //     index is deleted
  //
  // Designed to be SAFE to run on the most recent completed tournament. If a
  // later tournament has already been processed on top, that's flagged and
  // refused (rolling back would invalidate the subsequent results).
  //
  // Once we're confident processing works correctly, this button can be
  // removed — see the Aaron-only "remove when stable" tag in the JSX below.
  const handleUndoResults = async () => {
    if (!selectedTourney) { dialog.showToast('Select a tournament first', 'error'); return; }
    const ti = tournaments.findIndex(t => t.name === selectedTourney);
    if (ti === -1) { dialog.showToast('Tournament not found', 'error'); return; }
    const t = tournaments[ti];
    if (!t.completed) { dialog.showToast('Tournament is not completed — nothing to undo', 'error'); return; }
    if (!t.results) { dialog.showToast('Tournament has no stored results — cannot undo cleanly', 'error'); return; }

    // Refuse to undo if a LATER tournament has already been processed on
    // top. Rolling back would silently invalidate that one's earnings
    // baseline. Commish would have to undo from latest-back-to-earliest.
    const laterCompleted = tournaments.find((tt, i) => i > ti && tt.completed);
    if (laterCompleted) {
      dialog.showToast(`Cannot undo — "${laterCompleted.name}" has already been processed after this one. Undo that first.`, 'error');
      return;
    }

    const ok = await dialog.showConfirm(
      'Undo Tournament Results?',
      `This will REVERT "${selectedTourney}" back to playing state and reverse all earnings, stats, and roster updates from this processing. Lineups will be restored. Any auto-awarded swing winner will be removed. This is for testing — use with care.`,
      { type: 'danger', confirmText: 'Undo Results', cancelText: 'Cancel' }
    );
    if (!ok) return;

    try {
      const resultsData = t.results || {};
      const resultsTeams = resultsData.teams || {};
      const fullLineups  = resultsData.fullLineups || {};
      const fullBackups  = resultsData.fullBackups || {};
      const earningsMap  = resultsData.earningsMap || {};

      // ── Reverse team-level changes ──
      const newTeams = teams.map(team => {
        const stored = resultsTeams[team.id];
        if (!stored) return team; // team wasn't scored — nothing to reverse

        const totalEarnings = stored.totalEarnings || 0;
        const restoreLineup = fullLineups[team.id] ? [...fullLineups[team.id]] : [];
        const restoreBackup = fullBackups[team.id] || null;

        // Reverse per-player roster updates (starts -1, sfglEarnings -= earnings).
        // Use the same earningsMap-lookup logic as processTournamentData so the
        // numbers match exactly.
        const restoredRoster = (team.roster || []).map(player => {
          if (!restoreLineup.includes(player.name)) return player;
          let pe = earningsMap[player.name];
          if (pe === undefined) {
            // Fuzzy match — same approach as processTournamentData's matchPlayerName
            const mk = Object.keys(earningsMap).find(k =>
              k.toLowerCase().trim() === player.name.toLowerCase().trim()
            );
            pe = mk !== undefined ? earningsMap[mk] : 0;
          }
          return {
            ...player,
            starts: Math.max(0, (player.starts || 0) - 1),
            sfglEarnings: Math.max(0, (player.sfglEarnings || 0) - (pe || 0)),
          };
        });

        return {
          ...team,
          roster: restoredRoster,
          earnings: Math.max(0, (team.earnings || 0) - totalEarnings),
          segmentEarnings: Math.max(0, (team.segmentEarnings || 0) - totalEarnings),
          lineup: restoreLineup,
          backup: restoreBackup,
        };
      });

      // ── Reverse global player stats ──
      const restoredStats = { ...(globalPlayerStats || {}) };
      Object.entries(earningsMap).forEach(([playerName, earnings]) => {
        const cur = restoredStats[playerName];
        if (!cur) return; // never tracked — nothing to reverse
        restoredStats[playerName] = {
          ...cur,
          eventsPlayed:    Math.max(0, (cur.eventsPlayed || 0) - 1),
          cutsMade:        Math.max(0, (cur.cutsMade || 0) - ((earnings || 0) > 0 ? 1 : 0)),
          pgaTourEarnings: Math.max(0, (cur.pgaTourEarnings || 0) - (earnings || 0)),
        };
      });

      // ── Reverse tournament state ──
      // The processed tournament: completed→false, playing→true, results→null.
      // Any tournament that was advanced to playing=true after this one's
      // completion: revert to playing=false.
      const newTournaments = tournaments.map((tt, i) => {
        if (i === ti) {
          const { results: _omit, ...rest } = tt;
          return { ...rest, completed: false, playing: true };
        }
        // The processing path advances the next non-alternate uncompleted
        // tournament to playing=true. Reverse that.
        if (i > ti && tt.playing && !tt.completed) {
          return { ...tt, playing: false };
        }
        return tt;
      });

      // ── Remove auto-awarded swing_winner transaction for this tournament ──
      // The processing path appends a swing_winner tx when the tournament is
      // the final event of its swing. Identify by tournamentIndex match. If
      // the swing-winner was already there before this processing (manually
      // awarded), the tournamentIndex won't match and we leave it alone.
      const newTransactions = (transactions || []).filter(tx => {
        if (tx.type !== 'swing_winner') return true;
        return tx.tournamentIndex !== ti;
      });

      // Persist everything
      updateTeams(newTeams);
      setTournaments(newTournaments);
      if (setGlobalPlayerStats) setGlobalPlayerStats(restoredStats);
      if (newTransactions.length !== (transactions || []).length) {
        setTransactions(newTransactions);
      }

      dialog.showToast(`✓ Undid results for ${selectedTourney}. Tournament is back to playing state.`, 'success');
    } catch (err) {
      console.error('handleUndoResults error:', err);
      dialog.showToast('Error undoing: ' + err.message, 'error');
    }
  };

  const selectedTourneyObj = tournaments.find(t => t.name === selectedTourney);
  const isCompleted = !!selectedTourneyObj?.completed;
  const isPlaying   = !!selectedTourneyObj?.playing && !isCompleted;
  const hasData     = manualEntry.playerEarnings.trim().length > 0;

  return (
    <div style={M.page}>
      {/* Header description — replaces the bright S.title; BackBar already
          shows "Tournament Results" so this is just one-line context. */}
      <div style={M.descText}>
        Auto-process happens at the configured weekly time. Use this panel only when you need to manually trigger or correct results.
      </div>

      {/* Tournament selector group */}
      <div style={M.group}>
        <div style={M.eyebrow}>Tournament</div>
        <select
          value={selectedTourney}
          onChange={e => onTourneyChange(e.target.value)}
          style={M.select}
        >
          <option value="">Choose tournament...</option>
          {tournaments.map(t => (
            <option key={t.name} value={t.name}>
              {t.completed ? '✓ ' : t.playing ? '▶ ' : ''}{t.name}
            </option>
          ))}
        </select>

        {/* Status row — shows current state of the selected tournament.
            Only renders when something is selected, so the panel doesn't
            show a stale state pill in the default empty view. */}
        {selectedTourney && (
          <div style={M.statusRow}>
            <div style={M.statusDot(
              isCompleted ? colors.earningsGreen
              : isPlaying ? colors.textGold
              : colors.textMuted
            )} />
            <div style={{ flex: 1, fontFamily: fonts.sans, fontSize: 12, color: colors.textPrimary }}>
              {isCompleted ? 'This tournament has been processed'
               : isPlaying ? 'Tournament currently in progress'
               : 'Tournament not yet started'}
            </div>
          </div>
        )}
      </div>

      {/* Resend notifications — only meaningful for completed tournaments.
          Placed before the fetch button so it's the natural first action when
          a completed tournament is selected (e.g. for a tournament whose
          original notifications failed). */}
      {isCompleted && (
        <button
          onClick={handleResendNotifications}
          disabled={!selectedTourney || resending}
          className="modal-feel-lift"
          style={{ ...M.btnSecondary, ...disabledBtn(!selectedTourney || resending) }}
        >
          {resending ? '⏳ Sending…' : '📲 Resend Results Notifications'}
        </button>
      )}

      {/* Undo Tournament Results — TESTING-ONLY destructive action. Reverts
          a processed tournament back to playing state and reverses every
          earnings/stat/roster change from this processing. Only renders for
          completed tournaments. Remove this button once tournament
          processing is stable enough that we're confident bad fires won't
          happen (e.g., once we've gone several weeks without needing it). */}
      {isCompleted && (
        <button
          onClick={handleUndoResults}
          disabled={!selectedTourney}
          className="modal-feel-lift"
          style={{ ...M.btnDanger, ...disabledBtn(!selectedTourney) }}
        >
          ↩️ Undo Tournament Results (testing)
        </button>
      )}

      {/* Fetch results button */}
      <button
        onClick={handleFetchPGAResults}
        disabled={pgaFetching || !selectedTourney}
        className="modal-feel-lift modal-feel-primary"
        style={{ ...M.btnPrimary, ...disabledBtn(!selectedTourney || pgaFetching) }}
      >
        {pgaFetching ? '⏳ Fetching…' : selectedTourney ? `⛳ Get ${selectedTourney} Results` : '⛳ Get Tournament Results'}
      </button>

      {/* Round leaders + process action — only after fetch completes */}
      {hasData && (
        <>
          <div style={M.group}>
            <div style={M.eyebrow}>Round Leaders</div>
            <div style={M.descText}>
              Auto-detected from the field results. Override if any are incorrect.
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
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
          </div>

          {/* Process / Reprocess — primary action for the panel. Color
              shifts to warning when reprocessing a completed tournament,
              since that's a more destructive operation. */}
          {!isCompleted ? (
            <button
              onClick={handleManualEntry}
              disabled={!selectedTourney}
              className="modal-feel-lift modal-feel-primary"
              style={{ ...M.btnPrimary, ...disabledBtn(!selectedTourney) }}
            >
              ✅ Process Results
            </button>
          ) : (
            <button
              onClick={handleReprocess}
              disabled={!selectedTourney}
              className="modal-feel-lift modal-feel-warning"
              style={{ ...M.btnWarning, ...disabledBtn(!selectedTourney) }}
            >
              ✏️ Reprocess Tournament
            </button>
          )}
        </>
      )}
    </div>
  );
};
