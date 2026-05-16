// src/pages/admin/TournamentResultsPanel.jsx
// ============================================================================
// Tournament results processing — covers all three flows:
//   1. Fetch live results from PGA Tour and pre-fill earnings textarea
//   2. Manual entry → process tournament, mark complete, advance "playing"
//      pointer, auto-award the swing pot if this completes the swing
//   3. Reprocess a completed tournament with corrected earnings, with full
//      "swing cascade": if a swing_winner tx already exists for this segment
//      and the recalculation shifts the winner, the cascade reverses the old
//      tx and emits a new one — keeping the swing winner tx consistent with
//      the freshly-reprocessed tournament results.
//   4. Resend Results Email — fires the notify-results endpoint again
//      without touching any data. Useful after correcting a wrong email
//      template render.
//
// Wave I.2: after process/reprocess, automatically check whether the just-
// processed tournament completes a swing. If so, award the pot to the leader
// in the same write — keeps the manual SwingWinnerPanel as a safety-net only.
//
// Batch 3g (fix-only pass): absorbs the production logic that was in the
// inline AdminView handlers and never made it into this file at extraction
// time. AdminView is NOT yet swapped to use this panel — see the audit
// trail comment in AdminView. The features below should now match the
// deployed behavior 1:1 so a future swap is a clean drop-in.
// ============================================================================

import React from 'react';
import { useDialog } from '../DialogContext';
import { theme, colors, fonts } from '../../theme.js';
import { sfglDataApi } from '../../api/firebase';
import { processTournamentData } from './processTournamentData';
import {
  computeSwingAward,
  maybeAwardForCompletedTournament,
} from '../../utils/swingAward';
import { getSegmentForTournament } from '../../utils';
import { getSwingPot } from '../../utils/sharedHelpers';
import { S, disabledBtn } from './adminStyles';
import { TeamLineupsEditor } from './TeamLineupsEditor';

// ── Round-leader dropdown ───────────────────────────────────────────────────
// Uses stored tournament lineups (manualEntry.teamLineups) + R3 mulligan
// additions so the dropdown reflects who was actually playing for each team
// during the tournament — not the team's current live lineup (which can have
// been edited since).
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

// Parse "Player Name, 123456" or "Player Name, 1,234,567" lines → Map
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
  settings,
  rostersByTeamId,        // { teamId: [{name, limited, ...}] } — transactions-aware roster snapshot
  STORAGE_KEYS,
}) => {
  const dialog = useDialog();
  const [selectedTourney, setSelectedTourney] = React.useState('');
  const [manualEntry, setManualEntry] = React.useState(EMPTY_ENTRY);
  const [pgaFetching, setPgaFetching] = React.useState(false);

  // Default the dropdown to the currently-playing tournament on mount.
  React.useEffect(() => {
    const active = tournaments.find(t => t.playing);
    if (active && !selectedTourney) setSelectedTourney(active.name);
  }, [tournaments, selectedTourney]);

  // ── Tournament select handler ────────────────────────────────────────────
  // Pre-fills the manual entry form with the existing earnings/lineups if
  // this tournament has already been processed. Lets the commish reprocess
  // without re-typing everything.
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

  // ── Fetch from PGA Tour endpoint ─────────────────────────────────────────
  // Pre-fills earnings + round leaders from the live API. Round leaders are
  // filtered to actual SFGL starters (live + saved lineups), so a leader who
  // wasn't started by any team doesn't pollute the dropdown.
  const handleFetchPGAResults = async () => {
    if (!selectedTourney) { dialog.showToast('Select a tournament first', 'error'); return; }
    const t = tournaments.find(t => t.name === selectedTourney);
    if (!t) { dialog.showToast('Tournament not found', 'error'); return; }

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
      // For active tournaments, that's team.lineup. For already-completed
      // ones, team.lineup is cleared by processing — so fall back to the
      // lineups the commish has set in the Team Lineups editor, then to the
      // saved tournament fullLineups, so refreshing PGA data on an old
      // tournament doesn't strip all the round leaders.
      const tCurrent = tournaments.find(tt => tt.name === selectedTourney);
      const lineupNamesFromManualEntry = new Set(Object.values(manualEntry.teamLineups || {}).flat());
      const lineupNamesFromHistory = new Set(Object.values(tCurrent?.results?.fullLineups || {}).flat());
      const lineupNamesFromLive = new Set(teams.flatMap(t => t.lineup || []));
      const startedPlayers = new Set([
        ...lineupNamesFromLive,
        ...lineupNamesFromManualEntry,
        ...lineupNamesFromHistory,
      ]);
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

  // ── Process Results (first time) ──────────────────────────────────────────
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

      // ── Auto-award swing winner if this was the final event in its swing ──
      // After marking the tournament complete, see if every other tournament
      // in this swing is also complete. If so, the swing is over — award
      // the pot now instead of requiring a separate manual click. The
      // manual button in SwingWinnerPanel still exists as a backup for
      // re-awarding after corrections.
      const award = maybeAwardForCompletedTournament({
        justProcessedTournament: newT[ti],
        allTournaments: newT,
        transactions,
        teams: newTeams,
      });
      // Pot does NOT add to team.earnings — award.updatedTeams is unchanged
      // from newTeams (see swingAward.js design note).
      const finalTeams = award ? award.updatedTeams : newTeams;
      const finalTransactions = award ? [...transactions, award.newTx] : transactions;

      updateTeams(finalTeams);
      setGlobalPlayerStats(newStats);
      setTournaments(newT);
      if (award) {
        setTransactions(prev => [...prev, award.newTx]);
        sfglDataApi.set(STORAGE_KEYS.TRANSACTIONS, finalTransactions).catch(() => {});
      }
      // Persistence (Firestore) is handled by the updaters above. The
      // sfglDataApi writes below are belt-and-suspenders backups to the
      // key-value fallback path that useLeague's cascade loader checks.
      sfglDataApi.set(STORAGE_KEYS.TOURNAMENTS, newT).catch(() => {});
      sfglDataApi.set(STORAGE_KEYS.GLOBAL_PLAYER_STATS, newStats).catch(() => {});

      dialog.showToast('Results processed! ' + earningsMap.size + ' players · ' + Object.keys(resultsData.teams).length + ' teams scored', 'success');
      if (award) {
        dialog.showToast('🏆 ' + award.summary, 'success');
      }

      // Send results email to all managers — include swing-award banner if
      // one fired so the email leads with the celebration. Without this,
      // the swing win would only appear in the next month's standings
      // refresh.
      try {
        const teamResultsForEmail = finalTeams.filter(t => resultsData.teams[t.id]).map(t => ({
          team: t.name,
          totalEarnings: resultsData.teams[t.id].totalEarnings || 0,
          players: (resultsData.teams[t.id].players || []).map(p => ({
            name: p.name,
            earnings: p.earnings || 0,
            bonus: p.bonus || 0,
            limited: !!p.limited,
            unlimited: !!p.unlimited,
            roundsLed: Array.isArray(p.roundsLed) ? p.roundsLed : [],
          })),
        }));
        const swingWinnerInfo = award ? {
          segment: award.segment,
          team: award.winnerTeam.name,
          pot: award.pot,
        } : undefined;
        await fetch('/api/cron?action=notify-results', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tournamentName: selectedTourney, teamResults: teamResultsForEmail, swingWinnerInfo }),
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

  // ── Reprocess Tournament (correction of an already-processed tournament) ──
  // Reverses the prior results from each team's earnings + roster, then
  // re-runs processTournamentData with the corrected earnings. Includes a
  // "swing cascade": when a swing_winner tx exists for this segment and
  // the recalc shifts the winner, drops the old tx and emits a new one.
  const handleReprocess = async () => {
    if (!selectedTourney) { dialog.showToast('Select a tournament first', 'error'); return; }
    const tournament = tournaments.find(t => t.name === selectedTourney);
    if (!tournament?.completed) { dialog.showToast('Tournament is not yet completed', 'error'); return; }
    const ti = tournaments.findIndex(t => t.name === selectedTourney);

    // Count teams without a usable lineup. Teams either need an entry in
    // manualEntry.teamLineups (set via the Team Lineups editor) or in
    // oldResults.fullLineups (carried over from the original processing).
    // Without one of these, the team will score $0 for this tournament.
    const oldResultsForCheck = tournament.results;
    const teamsMissingLineups = teams.filter(team => {
      const fromEditor = manualEntry.teamLineups?.[team.id];
      const fromOldResults = oldResultsForCheck?.fullLineups?.[team.id];
      const lineup = (fromEditor && fromEditor.length > 0)
        ? fromEditor
        : (fromOldResults && fromOldResults.length > 0)
          ? fromOldResults
          : [];
      return lineup.length === 0;
    });

    // Will reprocessing this tournament cascade into a swing-winner change?
    const tSegment = getSegmentForTournament(tournament);
    const existingSwingTx = transactions.find(tx => tx.type === 'swing_winner' && tx.segment === tSegment);
    const swingCascade = !!existingSwingTx;

    // Build confirm message — lead with the lineup warning if any teams
    // are missing entries, so the commish sees it before committing.
    const lineupWarning = teamsMissingLineups.length > 0
      ? `⚠ ${teamsMissingLineups.length} team${teamsMissingLineups.length === 1 ? '' : 's'} ${teamsMissingLineups.length === 1 ? 'has' : 'have'} no lineup set (${teamsMissingLineups.map(t => t.name).join(', ')}) — ${teamsMissingLineups.length === 1 ? 'it' : 'they'} will score $0 for this tournament.\n\n`
      : '';

    const confirmMsg = lineupWarning + (swingCascade
      ? 'This will reverse the existing results for ' + selectedTourney + ' and apply the corrected earnings below. Team scores, player stats, and standings will all update.\n\nThe ' + tSegment + ' swing winner ($' + (existingSwingTx.amount || 0).toLocaleString() + ' to ' + existingSwingTx.team + ') will be automatically recalculated and re-awarded based on the new totals.'
      : 'This will reverse the existing results for ' + selectedTourney + ' and apply the corrected earnings below. Team scores, player stats, and standings will all update.');

    const ok = await dialog.showConfirm(
      'Reprocess Tournament',
      confirmMsg,
      { confirmText: 'Reprocess', type: teamsMissingLineups.length > 0 ? 'warning' : undefined }
    );
    if (!ok) return;

    try {
      const earningsMap = parseEarningsLines(manualEntry.playerEarnings);
      if (!earningsMap.size) { dialog.showToast('No valid earnings lines found', 'error'); return; }

      // Step 1: Reverse old results from all teams AND attach the new lineup
      // that will be scored in Step 2. Important: every team needs the
      // lineup attached, including teams that had no prior result — without
      // this, processTournamentData skips them (no lineup → no score) and
      // resultsData.teams comes back empty.
      const oldResults = tournament.results;
      let reversedTeams = teams.map(team => {
        // New lineup precedence: explicit edit > carried-over from prior
        // processing > empty.
        const newLineup = manualEntry.teamLineups[team.id]
          || oldResults?.fullLineups?.[team.id]
          || [];

        const oldTeamResult = oldResults?.teams?.[team.id];
        if (!oldTeamResult) {
          // No prior result to reverse — just attach the new lineup so this
          // team gets scored when processTournamentData runs.
          return { ...team, lineup: newLineup };
        }

        // Has a prior result — reverse earnings, decrement starts, etc.
        const earningsDelta = -(oldTeamResult.totalEarnings || 0);
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
          lineup: newLineup,
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

      // ── Diagnostic logging ──
      // If a reprocess produces unexpected results (empty team standings,
      // missing detail rows), the console output here is the fastest path
      // to seeing what actually happened. Each line corresponds to one
      // logical step of the pipeline.
      console.log('[handleReprocess] selectedTourney:', selectedTourney);
      console.log('[handleReprocess] manualEntry.teamLineups:',
        Object.fromEntries(Object.entries(manualEntry.teamLineups || {}).map(([k, v]) => {
          const t = teams.find(tt => tt.id === k);
          return [t?.name || k, v];
        }))
      );
      console.log('[handleReprocess] reversedTeams lineups:',
        reversedTeams.map(t => ({ name: t.name, lineup: t.lineup || [] }))
      );
      console.log('[handleReprocess] earningsMap entries:', earningsMap.size);
      console.log('[handleReprocess] resultsData.teams keys:',
        Object.keys(resultsData.teams || {}).map(id => {
          const t = teams.find(tt => tt.id === id);
          return t?.name || id;
        })
      );
      console.log('[handleReprocess] resultsData.fullLineups keys:',
        Object.keys(resultsData.fullLineups || {}).map(id => {
          const t = teams.find(tt => tt.id === id);
          return t?.name || id;
        })
      );

      // Mark tournament with new results (keep completed, don't change playing)
      const newT = tournaments.map((nt, i) => i === ti ? { ...nt, results: resultsData } : nt);

      // ── Swing winner cascade ──
      // When the segment already had its swing_winner awarded, the recalculated
      // tournament earnings may shift the winner. Same workflow the commish
      // would otherwise do manually: reverse old credit, recompute, re-award.
      // All wrapped into this single Reprocess action so it's never out of sync.
      //
      // The cascade is its own try/catch — if anything in here fails we log a
      // warning, skip the swing recalc, and let the base reprocess still
      // persist. Better to have correct tournament results + a stale swing
      // award than a half-applied write that corrupts state.
      let finalTeams = newTeams;
      let finalTransactions = transactions;
      let swingRecalcSummary = null;

      if (swingCascade) {
        try {
          // Swing pot is a side-prize that does NOT affect team.earnings,
          // so the cascade only needs to swap the swing_winner tx — no
          // reversal of credits, no new credit. Determine the new winner
          // by ranking against the freshly-reprocessed tournament results.
          const rankedSegmentTournaments = newT.filter(tt => tt.completed && getSegmentForTournament(tt) === tSegment && tt.results?.teams);
          const byTeam = {};
          rankedSegmentTournaments.forEach(tt => {
            Object.entries(tt.results.teams).forEach(([id, tr]) => {
              byTeam[id] = (byTeam[id] || 0) + (tr.totalEarnings || 0);
            });
          });
          const winnerEntry = Object.entries(byTeam).sort((a, b) => b[1] - a[1])[0];

          if (winnerEntry) {
            const [winnerId] = winnerEntry;
            const newWinnerTeam = finalTeams.find(t => t.id === winnerId);

            // Recompute pot via the canonical helper — matches what the
            // dropdown, leader panel, and TransactionsView all display.
            const newPot = getSwingPot(transactions, newT, tSegment);

            // Drop the old swing_winner tx, append the new one. Tag
            // tournamentIndex to the last ranked tournament so the tx
            // sorts naturally with other transactions in TransactionsView.
            const lastSegTourney = rankedSegmentTournaments.reduce((last, tt) => {
              const idx = newT.indexOf(tt);
              return idx > (last?.idx ?? -1) ? { t: tt, idx } : last;
            }, null);

            const newSwingTx = {
              txId: `swing-${tSegment}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              team: newWinnerTeam?.name || existingSwingTx.team,
              type: 'swing_winner',
              player: newWinnerTeam?.owner || existingSwingTx.player,
              fee: 0,
              amount: newPot,
              segment: tSegment,
              date: new Date().toLocaleDateString(),
              timestamp: Date.now(),
              status: 'completed',
              tournamentIndex: lastSegTourney?.idx ?? existingSwingTx.tournamentIndex,
              note: tSegment + ' winner pot (auto-recalculated)',
            };
            finalTransactions = transactions
              .filter(tx => !(tx.type === 'swing_winner' && tx.segment === tSegment))
              .concat(newSwingTx);

            // For the toast — surface whether the winner actually changed
            const sameWinner = newWinnerTeam?.name === existingSwingTx.team;
            swingRecalcSummary = sameWinner
              ? `${tSegment}: ${newWinnerTeam.name} retains $${newPot.toLocaleString()}`
              : `${tSegment}: ${existingSwingTx.team} → ${newWinnerTeam?.name} ($${newPot.toLocaleString()})`;
          }
        } catch (cascadeErr) {
          // Cascade failed — log, but keep going so the base reprocess
          // still applies. Reverts finalTeams/finalTransactions to the
          // pre-cascade state so we don't persist half-applied changes.
          console.error('[handleReprocess] Swing cascade failed:', cascadeErr);
          finalTeams = newTeams;
          finalTransactions = transactions;
          swingRecalcSummary = '(swing recalc skipped — see console)';
        }
      } else {
        // No prior swing_winner tx — but the reprocess may have just made
        // this the FINAL completed event in its swing (or fixed up the
        // results that were missing the last time the swing tried to
        // auto-award). Run the same conditions check that handleManualEntry
        // does and award if applicable.
        try {
          const award = computeSwingAward({
            segment: tSegment,
            allTournaments: newT,
            transactions: finalTransactions,
            teams: finalTeams,
          });
          if (award) {
            finalTeams = award.updatedTeams;
            finalTransactions = [...finalTransactions, award.newTx];
            swingRecalcSummary = award.summary;
          }
        } catch (awardErr) {
          console.error('[handleReprocess] Auto-award failed:', awardErr);
          swingRecalcSummary = '(swing auto-award skipped — see console)';
        }
      }

      // Persist — sequenced and individually try/caught so a single failure
      // in one writer doesn't leave us in a half-applied state where some
      // state is updated and the rest isn't. Each writer is fired and we
      // continue even if one fails, surfacing the error in the toast.
      const writerErrors = [];
      try { updateTeams(finalTeams); }       catch (e) { writerErrors.push('teams: ' + e.message); }
      try { setGlobalPlayerStats(newStats); } catch (e) { writerErrors.push('stats: ' + e.message); }
      try { setTournaments(newT); }          catch (e) { writerErrors.push('tournaments: ' + e.message); }
      if (finalTransactions !== transactions) {
        try {
          setTransactions(finalTransactions);
          sfglDataApi.set(STORAGE_KEYS.TRANSACTIONS, finalTransactions).catch(e => console.warn('tx backup failed:', e));
        } catch (e) { writerErrors.push('transactions: ' + e.message); }
      }
      sfglDataApi.set(STORAGE_KEYS.TOURNAMENTS, newT).catch(e => console.warn('tournaments backup failed:', e));
      sfglDataApi.set(STORAGE_KEYS.GLOBAL_PLAYER_STATS, newStats).catch(e => console.warn('stats backup failed:', e));

      if (writerErrors.length > 0) {
        console.error('[handleReprocess] Persistence errors:', writerErrors);
        dialog.showToast('Reprocessed with warnings — see console for details', 'warning');
      } else {
        dialog.showToast(
          swingRecalcSummary
            ? '✓ Reprocessed ' + selectedTourney + ' · ' + swingRecalcSummary
            : '✓ Reprocessed ' + selectedTourney + ' with corrected earnings',
          'success'
        );
      }
      setManualEntry(EMPTY_ENTRY);
    } catch (err) {
      console.error('handleReprocess error:', err);
      dialog.showToast('Error reprocessing: ' + err.message, 'error');
    }
  };

  // ── Resend Results Email ──────────────────────────────────────────────────
  // Re-fires the notify-results endpoint without modifying any data.
  // Useful after correcting a broken email template render, or for testing
  // template changes without waiting for next Monday. Doesn't touch any
  // data — only re-sends the email via the notify-results endpoint, which
  // has no same-day lockout.
  const handleResendResultsEmail = async () => {
    if (!selectedTourney) { dialog.showToast('Select a tournament first', 'error'); return; }
    const t = tournaments.find(tt => tt.name === selectedTourney);
    if (!t?.completed || !t?.results?.teams) {
      dialog.showToast('Tournament must be completed and have results', 'error');
      return;
    }
    const ok = await dialog.showConfirm(
      'Resend Results Email',
      `Send the ${selectedTourney} results email to all managers? This does not modify any data — only re-sends the email.`,
      { confirmText: 'Send Email', type: 'warning' }
    );
    if (!ok) return;
    try {
      const teamResultsForEmail = teams
        .filter(team => t.results.teams[team.id])
        .map(team => ({
          team: team.name,
          totalEarnings: t.results.teams[team.id].totalEarnings || 0,
          // Include the full player breakdown so the email template can
          // render player names with the right color, round-leader badges,
          // and bonus-inclusive earnings totals.
          players: (t.results.teams[team.id].players || []).map(p => ({
            name: p.name,
            earnings: p.earnings || 0,
            bonus: p.bonus || 0,
            limited: !!p.limited,
            unlimited: !!p.unlimited,
            roundsLed: Array.isArray(p.roundsLed) ? p.roundsLed : [],
          })),
        }));
      // If this tournament was the final event of its swing AND a
      // swing_winner tx exists for that segment, include the celebration
      // banner in the resend too — keeps the email faithful to what would
      // have been sent at the original processing time.
      const tSegment = getSegmentForTournament(t);
      const swingTx = transactions.find(tx => tx.type === 'swing_winner' && tx.segment === tSegment);
      const swingTournaments = tournaments.filter(tt => getSegmentForTournament(tt) === tSegment);
      const isFinalEventOfSwing = swingTournaments.every(tt => tt.completed)
        && swingTournaments[swingTournaments.length - 1]?.name === selectedTourney;
      const swingWinnerInfo = (swingTx && isFinalEventOfSwing) ? {
        segment: tSegment,
        team: swingTx.team,
        pot: swingTx.amount || 0,
      } : undefined;
      const resp = await fetch('/api/cron?action=notify-results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tournamentName: selectedTourney, teamResults: teamResultsForEmail, swingWinnerInfo }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || 'Resend failed');
      dialog.showToast(`📧 Sent to ${data.emailsSent || 0} manager${data.emailsSent === 1 ? '' : 's'}`, 'success');
    } catch (err) {
      console.error('handleResendResultsEmail error:', err);
      dialog.showToast('Error: ' + err.message, 'error');
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

          {/* Team Lineups editor — sets the lineup that will be scored for
              each team. Saved into manualEntry.teamLineups which both the
              process and reprocess handlers consume. Especially important
              for old tournaments whose live lineups have since been edited;
              this lets the commish enter the historical lineup. Collapsed
              by default to keep the panel compact; expand to edit. */}
          <TeamLineupsEditor
            teams={teams}
            manualEntry={manualEntry}
            setManualEntry={setManualEntry}
            lineupSize={settings?.lineupSize ?? 5}
            rostersByTeamId={rostersByTeamId}
            tournament={tournaments.find(t => t.name === selectedTourney)}
          />

          {/* Process / Reprocess */}
          {!isCompleted ? (
            <button
              onClick={handleManualEntry}
              disabled={!selectedTourney}
              style={{ ...S.btn, ...disabledBtn(!selectedTourney) }}
            >
              ✅ Process Results
            </button>
          ) : (
            <>
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
              {/* Resend the email without touching any data — useful for
                  re-sending after a broken template render, or testing
                  template changes without waiting for next Monday. */}
              <button
                onClick={handleResendResultsEmail}
                disabled={!selectedTourney}
                style={{
                  ...S.btn,
                  marginTop: 6,
                  background: 'rgba(80,140,200,0.10)',
                  border: '1px solid rgba(80,140,200,0.35)',
                  color: 'rgba(150,200,255,0.9)',
                  ...disabledBtn(!selectedTourney),
                }}
              >
                📧 Resend Results Email
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
};
