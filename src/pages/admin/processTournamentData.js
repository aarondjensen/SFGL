// src/pages/admin/processTournamentData.js
// ============================================================================
// Core tournament-result processing. Extracted from AdminView's monolith.
// Used by both the "Process" and "Reprocess" flows.
// ============================================================================

import { normalizePlayerName } from '../../utils';
import { BONUSES_REGULAR, BONUSES_MAJOR } from '../../constants';

// Match two player names accounting for normalization variants.
export const matchPlayerName = (a, b) => {
  const na = normalizePlayerName(a);
  const nb = normalizePlayerName(b);
  if (na === nb) return true;
  const wa = na.split(' '); const wb = nb.split(' ');
  if (wa.length === wb.length) return wa.every(w => wb.includes(w));
  return false;
};

// Replay transactions to reconstruct a team's roster as it existed at the time
// of a given tournament. Used during result processing where we need each
// team's effective roster at that point in the season (post earlier add/drops).
export const getRosterForTournament = (team, tournamentIndex, allTransactions) => {
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
 * Core tournament processing.
 *
 * Returns { newTeams, newStats, resultsData }:
 *   newTeams    — teams array updated with sfglEarnings/starts/totals
 *   newStats    — global per-player stat map updated with eventsPlayed/cutsMade/etc.
 *   resultsData — the structure stored on tournament.results: per-team breakdown,
 *                 earningsMap, roundLeaders, fullLineups
 */
export const processTournamentData = (tournament, tournamentData, teams, globalPlayerStats, _unusedNames, transactions = []) => {
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
    fullLineups: {},
  };

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
      if (pe === undefined) {
        const mk = Object.keys(earningsMap).find(k => matchPlayerName(k, player.name));
        if (mk) pe = earningsMap[mk];
      }
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
