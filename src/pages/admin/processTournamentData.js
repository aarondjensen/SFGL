// src/pages/admin/processTournamentData.js
// ============================================================================
// Core tournament-result processing. Extracted from AdminView's monolith.
// Used by both the "Process" and "Reprocess" flows.
//
// The per-team scoring math (top-5 + full-bonus-per-co-leader) lives in the
// SHARED engine at api/_scoring.js — the same module api/cron.js uses for the
// weekly auto-process — so the manual and automatic paths can never drift.
// This file owns the client-side orchestration around it: mulligan replay,
// global stat updates, and roster/team mutations.
// ============================================================================

import {
  matchPlayerName,
  getBonusAmounts,
  computeTeamTournamentResult,
} from '../../../api/_scoring.js';

// Re-exported for existing consumers (alias-aware word-set name match).
export { matchPlayerName };

// Replay transactions to reconstruct a team's roster as it existed at the time
// of a given tournament. Used during result processing where we need each
// team's effective roster at that point in the season (post earlier add/drops).
//
// Skips:
//   • mulligan — restores a previously-dropped player; the original add/drop
//     pair already accounts for the roster movement.
//   • swing_winner — `tx.player` on these is the manager's owner name (used
//     for "Jensen won the West Coast Swing pot" display), NOT an actual
//     golfer. Replaying it would pollute the roster with the manager's name.
export const getRosterForTournament = (team, tournamentIndex, allTransactions) => {
  let roster = [...team.roster];
  allTransactions
    .filter(tx =>
      tx.team === team.name &&
      tx.type !== 'mulligan' &&
      tx.type !== 'swing_winner' &&
      tx.tournamentIndex !== undefined &&
      tx.tournamentIndex <= tournamentIndex &&
      tx.status !== 'pending'
    )
    .sort((a, b) => a.tournamentIndex - b.tournamentIndex)
    .forEach(tx => {
      if (tx.droppedPlayer) roster = roster.filter(p => p.name !== tx.droppedPlayer);
      if (tx.player && !roster.some(p => p.name === tx.player)) roster.push({ name: tx.player });
    });
  return roster;
};

/**
 * Core tournament processing.
 *
 * Returns { newTeams, newStats, resultsData }:
 *   newTeams    — teams array updated with sfglEarnings/starts/totals
 *   newStats    — global per-player stat map updated with eventsPlayed/cutsMade/etc.
 *   resultsData — the structure stored on tournament.results: per-team breakdown,
 *                 earningsMap, roundLeaders, fullLineups
 */
export const processTournamentData = (tournament, tournamentData, teams, globalPlayerStats, _unusedNames, transactions = [], settings = {}) => {
  // Settings-aware bonuses (SeasonSettingsPanel bonusR{1,2,3}{Regular,Major})
  // with league defaults as fallback — same resolution the cron path uses.
  const bonuses = getBonusAmounts(tournament.isMajor, settings);

  // Build earningsMap from the tournamentData (Map | object | competitor array).
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

  const resultsData = {
    teams: {},
    earningsMap: { ...earningsMap },
    roundLeaders: tournamentData.roundLeaders || {},
    fullLineups: {},
    // Snapshot pre-process backups too, so undo can restore them. Without
    // this, undoing a processed tournament leaves backup=null on every team
    // because handleManualEntry / process-results cron both set backup=null
    // unconditionally after processing. Empty/missing here is fine — undo
    // tolerates missing entries by leaving backup=null.
    fullBackups: {},
  };

  // Resolve this tournament's index so we can find mulligan transactions
  // that target it. tournament.name is the stable identity here.
  const thisTournamentIndex = tournament.tournamentIndex !== undefined
    ? tournament.tournamentIndex
    : null;

  const newTeams = teams.map(team => {
    if (!team.lineup || team.lineup.length === 0) return team;

    // ── Apply mulligans to the lineup (re-process-safe) ──────────────────
    // A mulligan swaps one lineup player (OUT) for another (IN) for a single
    // tournament. When the mulligan is created, AddTransactionModal performs
    // the swap imperatively on stored results. But a re-process recomputes
    // everything from team.lineup — which still holds the ORIGINAL player —
    // so without this step the mulligan is silently undone on re-process
    // (the exact "Scheffler shows $0" bug).
    //
    // Here we replay this team's mulligan transactions for THIS tournament
    // against the lineup so the recompute honors them. We match the tournament
    // by index when available, else fall back to name match. The swap mirrors
    // AddTransactionModal: replace OUT with IN in the lineup array.
    //
    // Idempotent: if the lineup already contains IN (not OUT), the swap is a
    // no-op. Safe to run on every process/re-process.
    let effectiveLineup = [...team.lineup];
    const teamMulligans = (transactions || []).filter(tx =>
      tx.type === 'mulligan' &&
      tx.team === team.name &&
      tx.status !== 'pending' &&
      tx.status !== 'failed' &&
      tx.player &&            // IN player
      tx.droppedPlayer &&     // OUT player
      (
        // Prefer index match; fall back to name match if index unavailable
        (thisTournamentIndex !== null && tx.tournamentIndex === thisTournamentIndex) ||
        (tx.tournamentName && tx.tournamentName === tournament.name)
      )
    );
    teamMulligans.forEach(mull => {
      const outName = mull.droppedPlayer;
      const inName  = mull.player;
      const idx = effectiveLineup.findIndex(p => p === outName);
      if (idx !== -1) {
        console.log(`[processTournament] mulligan swap for ${team.name}: ${outName} → ${inName}`);
        effectiveLineup[idx] = inName;
      } else if (!effectiveLineup.includes(inName)) {
        // OUT player not in lineup but IN player also absent — unusual, but
        // honor the mulligan by adding IN (avoids dropping the swap entirely).
        console.warn(`[processTournament] mulligan for ${team.name}: OUT player "${outName}" not in lineup; adding IN "${inName}"`);
        effectiveLineup.push(inName);
      }
      // else: IN already present (idempotent re-process) — no-op
    });

    resultsData.fullLineups[team.id] = [...effectiveLineup];
    if (team.backup) resultsData.fullBackups[team.id] = team.backup;

    // ── Score the team via the shared engine (api/_scoring.js) ───────────
    const { teamResult, starterResults } = computeTeamTournamentResult({
      lineup: effectiveLineup,
      earningsMap,
      roundLeaders: tournamentData.roundLeaders || {},
      bonuses,
      roster: team.roster,
    });
    const totalEarnings = teamResult.totalEarnings;

    resultsData.teams[team.id] = teamResult;

    // Build lineup-name → earnings map from starterResults so the roster
    // update below uses the EXACT same numbers as what's stored in
    // resultsData.teams[id].players. Previously, the roster update did
    // its own independent earningsMap lookup which could resolve to a
    // different value (e.g. if name normalization or fuzzy matching
    // produced different results on the second pass). When the two
    // diverged, we'd see a player credited in results.teams but with
    // $0 sfglEarnings on the roster — exactly the bug observed for
    // Alex Fitzpatrick on Truist 2026 reprocess.
    const earningsByLineupName = {};
    starterResults.forEach(({ playerName, earnings }) => {
      earningsByLineupName[playerName] = earnings;
    });

    const updatedRoster = team.roster.map(player => {
      if (!effectiveLineup.includes(player.name)) return player;
      const pe = earningsByLineupName[player.name] || 0;
      return { ...player, starts: (player.starts || 0) + 1, sfglEarnings: (player.sfglEarnings || 0) + pe };
    });

    return {
      ...team,
      roster: updatedRoster,
      earnings: (team.earnings || 0) + totalEarnings,
      segmentEarnings: (team.segmentEarnings || 0) + totalEarnings,
      lineup: [],
      // Clear backup designation alongside lineup so the field is fresh for
      // the next tournament. The backup was only meaningful for THIS event;
      // it shouldn't carry over.
      backup: null,
    };
  });

  return { newTeams, newStats, resultsData };
};
