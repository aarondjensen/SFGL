// src/pages/admin/processTournamentData.js
// ============================================================================
// Core tournament-result processing. Extracted from AdminView's monolith.
// Used by both the "Process" and "Reprocess" flows.
// ============================================================================

import { namesMatch } from '../../../api/_playerNames.js';
import { BONUSES_REGULAR, BONUSES_MAJOR } from '../../constants';
import { txBelongsToTeam } from '../../utils/sharedHelpers';
import { scoringStarters, lineupFor, cutRuleForfeit } from '../../../api/_rules.js';

// Are these two strings the same golfer? Delegates to the shared identity
// module (api/_playerNames.js), which is what /api/field, /api/cron and the
// roster page all use — so a player's earnings and their ⛳ flag can never
// disagree about who they are.
//
// The previous body compared normalizePlayerName keys and fell back to an
// any-order word-set match. That handled 'Kim Si Woo' vs 'Si Woo Kim' (still
// handled) but could not see that 'Nico Echavarria' and 'Nicolas Echavarria'
// are one player. This function decides how much a lineup earns: a starter
// whose roster spelling differed from the results feed's scored $0 for the
// week, silently, with no error anywhere.
export const matchPlayerName = namesMatch;

// REMOVED: getRosterForTournament — a sixth hand-rolled roster replay. It was
// exported but had no callers (only a stale mention in a sharedHelpers
// comment), and it carried a bug the others didn't: it filtered on
// `status !== 'pending'`, which meant FAILED waiver claims were replayed onto
// the roster as if they had succeeded.
//
// Use buildEffectiveRoster(team, transactions, { tournaments,
// upToTournamentIndex }) from utils/sharedHelpers instead — it resolves each
// transaction's position from the stable tournament name, sorts
// chronologically, and counts only processed/completed rows.

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
  const bonuses = tournament.isMajor ? BONUSES_MAJOR : BONUSES_REGULAR;

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
    // Unfiltered round leaders (every golfer who led a round, not just those in
    // a lineup at process time). roundLeaders is filtered to started players for
    // display; roundLeadersAll preserves the full list so a mulligan added later
    // can credit an IN player who led a round despite not having been started.
    // Falls back to the filtered set when a caller doesn't supply the full one.
    roundLeadersAll: tournamentData.roundLeadersAll || tournamentData.roundLeaders || {},
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
    // The lineup frozen at lock when there is one — see lineupFor.
    let effectiveLineup = [...lineupFor(tournament, team)];
    const teamMulligans = (transactions || []).filter(tx =>
      tx.type === 'mulligan' &&
      txBelongsToTeam(tx, team) &&
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

    const starterResults = effectiveLineup.map(playerName => {
      let earnings = earningsMap[playerName];
      if (earnings === undefined) {
        const mk = Object.keys(earningsMap).find(k => matchPlayerName(k, playerName));
        earnings = mk !== undefined ? earningsMap[mk] : 0;
      }
      return { playerName, earnings: earnings || 0 };
    });

    // Scores the STARTING LINEUP, not the best five — see scoringStarters.
    const { starters: topStarters, oversized, lineupSize } = scoringStarters(starterResults, settings);
    if (oversized) {
      console.warn(`[processTournament] ${team.name} has ${topStarters.length} starters for a `
        + `lineup size of ${lineupSize} — scoring all of them. Check this team's mulligan for `
        + `${tournament.name}.`);
    }
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
          const actual = effectiveLineup.find(pn => matchPlayerName(pn, leaderName));
          if (actual) {
            bonusEarnings[round] += bonuses[round];
            totalEarnings += bonuses[round];
            if (!playersWithBonuses[actual]) playersWithBonuses[actual] = { total: 0, rounds: [] };
            playersWithBonuses[actual].total  += bonuses[round];
            playersWithBonuses[actual].rounds.push({ round: round.replace('round', ''), bonus: bonuses[round] });
          }
        });
      });
    }

    // The cut rule, applied after bonuses because it zeroes the whole week —
    // a forfeited team keeps no round-leader money either. Individual
    // sfglEarnings below are deliberately NOT zeroed: the sheet's per-team
    // grid still credits the lone earner his winnings in a forfeited week, and
    // only the figure the standings add up goes to zero.
    const forfeit = cutRuleForfeit({ starters: topStarters, earningsMap, settings });
    if (forfeit) {
      console.log(`[processTournament] ${team.name} forfeits ${tournament.name}: only `
        + `${forfeit.player} made the cut (${forfeit.starters} started`
        + `${forfeit.won ? '' : ', and he did not win'})`);
      totalEarnings = 0;
    }

    resultsData.teams[team.id] = {
      totalEarnings,
      cutRuleForfeit: forfeit || null,
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
