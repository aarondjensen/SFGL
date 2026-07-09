// src/utils/mulliganReversal.js
// ============================================================================
// Computes the complete reversal of a mulligan transaction — the exact inverse
// of the side-effects AddTransactionModal applies at creation:
//   • results.teams[team] + fullLineups[team]  (swap the wrongly-added IN back
//     to the real OUT starter, then RECOMPUTE the team total)
//   • team.earnings / segmentEarnings           (by the recomputed delta)
//   • roster starts + sfglEarnings              (IN −1/−$, OUT +1/+$)
//   • mulligan allowance counter                (restored)
//   • registry                                   (force-set via overrides so the
//                                                 monotonic max-merge can't
//                                                 re-inflate the decrements)
// The transaction-record removal (and thus the fee, which is derived from the
// transaction list) is handled by the caller.
//
// The recompute mirrors processTournamentData's top-5 + round-bonus math. It's
// kept standalone here rather than refactoring the core processing path
// mid-flight; matchPlayerName is a small pure mirror of the one there.
// ============================================================================
import { normalizePlayerName } from './index.js';
import { getPlayerRegistry } from './sharedHelpers';
import { BONUSES_REGULAR, BONUSES_MAJOR } from '../constants/index.js';

// Mirror of processTournamentData.matchPlayerName (word-set match).
const matchPlayerName = (a, b) => {
  const na = normalizePlayerName(a), nb = normalizePlayerName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const wa = na.split(' '), wb = nb.split(' ');
  if (wa.length === wb.length) return wa.every(w => wb.includes(w));
  return false;
};

const lookupEarnings = (name, earningsMap) => {
  if (earningsMap[name] !== undefined) return earningsMap[name] || 0;
  const k = Object.keys(earningsMap).find(key => matchPlayerName(key, name));
  return k !== undefined ? (earningsMap[k] || 0) : 0;
};

// Recompute a team's tournament result for an effective lineup — same math as
// processTournamentData (top-5 by earnings + round-leader bonuses).
export const recomputeTeamTournamentResult = (lineup, earningsMap, roundLeaders, isMajor, roster) => {
  const bonuses = isMajor ? BONUSES_MAJOR : BONUSES_REGULAR;
  const starterResults = (lineup || []).map(pn => ({ playerName: pn, earnings: lookupEarnings(pn, earningsMap) }));
  const topStarters = [...starterResults].sort((a, b) => b.earnings - a.earnings).slice(0, 5);
  let totalEarnings = topStarters.reduce((s, p) => s + p.earnings, 0);
  const bonusEarnings = { round1: 0, round2: 0, round3: 0 };
  const playersWithBonuses = {};
  ['round1', 'round2', 'round3'].forEach(round => {
    const leaders = Array.isArray(roundLeaders?.[round]) ? roundLeaders[round]
      : (roundLeaders?.[round] ? [roundLeaders[round]] : []);
    leaders.forEach(leaderName => {
      if (!leaderName) return;
      const actual = (lineup || []).find(pn => normalizePlayerName(pn) === normalizePlayerName(leaderName));
      if (actual) {
        bonusEarnings[round] = bonuses[round];
        totalEarnings += bonuses[round];
        if (!playersWithBonuses[actual]) playersWithBonuses[actual] = { total: 0, rounds: [] };
        playersWithBonuses[actual].total += bonuses[round];
        playersWithBonuses[actual].rounds.push({ round: round.replace('round', ''), bonus: bonuses[round] });
      }
    });
  });
  const players = topStarters.map(s => ({
    name: s.playerName,
    earnings: s.earnings,
    limited: (roster || []).find(p => p.name === s.playerName)?.limited || false,
    bonus: playersWithBonuses[s.playerName]?.total || 0,
    roundsLed: playersWithBonuses[s.playerName]?.rounds || [],
    wasRoundLeader: (playersWithBonuses[s.playerName]?.total || 0) > 0,
  }));
  return { totalEarnings, bonuses: bonusEarnings, players };
};

// Compute the complete reversal of a mulligan tx.
// Returns { newTeams, newTournaments, registryOverrides, processed, summary }
// or { error } if it can't be reversed safely.
export const computeMulliganReversal = (tx, teams, tournaments) => {
  const team = teams.find(t => t.name === tx.team);
  if (!team) return { error: `Team "${tx.team}" not found.` };
  const playerIn = tx.player;         // wrongly added — remove its credit
  const playerOut = tx.droppedPlayer;  // real starter — restore its credit
  if (!playerIn || !playerOut) return { error: 'Mulligan is missing player / droppedPlayer.' };

  // Resolve the target tournament (prefer stable name; index is array position).
  let tIndex = -1;
  if (tx.tournamentName) tIndex = tournaments.findIndex(t => t.name === tx.tournamentName);
  if (tIndex === -1 && tx.tournamentIndex != null) tIndex = tx.tournamentIndex;
  const tourney = tIndex >= 0 ? tournaments[tIndex] : null;

  const isSigOrMajor = tourney?.isSignature || tourney?.isMajor;
  const mullKey = isSigOrMajor ? 'signatureMajor' : 'regular';
  const processed = !!(tourney && tourney.completed && tourney.results?.teams?.[team.id]);

  // Restore this team's mulligan allowance (the swap never legitimately happened).
  const restoreCounter = (t) => ({
    ...t,
    mulligans: { ...t.mulligans, [mullKey]: (t.mulligans?.[mullKey] ?? 0) + 1 },
  });

  // ── Unprocessed: reverse the lineup swap + restore allowance. The fee drops
  //    out of standings automatically when the caller removes the tx. ─────────
  if (!processed) {
    const newTeams = teams.map(t => {
      if (t.id !== team.id) return t;
      const restored = restoreCounter(t);
      const lineup = (t.lineup || []).map(p => (p === playerIn ? playerOut : p));
      return { ...restored, lineup };
    });
    return {
      newTeams, newTournaments: tournaments, registryOverrides: null, processed: false,
      summary: { playerIn, playerOut, tournamentName: tourney?.name || '(unprocessed)', delta: 0 },
    };
  }

  // ── Processed: full reversal ────────────────────────────────────────────────
  const results = tourney.results;
  const earningsMap = results.earningsMap || {};
  const roundLeaders = results.roundLeaders || {};
  const isMajor = !!tourney.isMajor;
  const oldTeamRes = results.teams[team.id];
  const oldFull = results.fullLineups?.[team.id] || [];

  // Reverse the snapshot: swap the wrongly-added IN back to the OUT starter.
  const inPresent = oldFull.some(p => matchPlayerName(p, playerIn));
  const newFull = inPresent
    ? oldFull.map(p => (matchPlayerName(p, playerIn) ? playerOut : p))
    : oldFull; // defensive: IN not in snapshot — leave lineup, still fix tallies

  const newTeamRes = recomputeTeamTournamentResult(newFull, earningsMap, roundLeaders, isMajor, team.roster);
  const oldTotal = oldTeamRes.totalEarnings || 0;
  const newTotal = newTeamRes.totalEarnings || 0;
  const delta = newTotal - oldTotal;

  const inIndiv = lookupEarnings(playerIn, earningsMap);
  const outIndiv = lookupEarnings(playerOut, earningsMap);

  // Per-player tally corrections against durable records (roster when rostered,
  // registry always — a since-dropped real starter still gets his credit).
  const registry = getPlayerRegistry() || {};
  const regKeyFor = (name) => (registry[name] !== undefined) ? name
    : Object.keys(registry).find(k => matchPlayerName(k, name));
  const planFor = (name, dStarts, dSfgl) => {
    const rosterEntry = team.roster.find(p => matchPlayerName(p.name, name));
    const regKey = regKeyFor(name) || name;
    const regEntry = registry[regKey];
    const onRoster = !!rosterEntry;
    const hasRecord = onRoster || !!regEntry;
    const baseStarts = onRoster ? (rosterEntry.starts || 0) : (regEntry ? (regEntry.starts || 0) : 0);
    const baseSfgl = onRoster ? (rosterEntry.sfglEarnings || 0) : (regEntry ? (regEntry.sfglEarnings || 0) : 0);
    return {
      name, onRoster, regKey, hasRecord,
      newStarts: hasRecord ? Math.max(0, baseStarts + dStarts) : null,
      newSfgl: hasRecord ? Math.max(0, baseSfgl + dSfgl) : null,
    };
  };
  const inPlan = planFor(playerIn, -1, -inIndiv);    // remove wrongly-added credit
  const outPlan = planFor(playerOut, +1, +outIndiv);  // restore real starter's credit

  const newTeams = teams.map(t => {
    if (t.id !== team.id) return t;
    const roster = t.roster.map(p => {
      if (inPlan.onRoster && matchPlayerName(p.name, playerIn))
        return { ...p, starts: inPlan.newStarts, sfglEarnings: inPlan.newSfgl };
      if (outPlan.onRoster && matchPlayerName(p.name, playerOut))
        return { ...p, starts: outPlan.newStarts, sfglEarnings: outPlan.newSfgl };
      return p;
    });
    return {
      ...restoreCounter(t),
      roster,
      earnings: Math.max(0, (t.earnings || 0) + delta),
      segmentEarnings: Math.max(0, (t.segmentEarnings || 0) + delta),
    };
  });

  const newTournaments = tournaments.map((t, i) => {
    if (i !== tIndex) return t;
    return {
      ...t,
      results: {
        ...results,
        teams: { ...results.teams, [team.id]: newTeamRes },
        fullLineups: { ...results.fullLineups, [team.id]: newFull },
      },
    };
  });

  const registryOverrides = {};
  if (inPlan.hasRecord) registryOverrides[inPlan.regKey] = { starts: inPlan.newStarts, sfglEarnings: inPlan.newSfgl };
  if (outPlan.hasRecord) registryOverrides[outPlan.regKey] = { starts: outPlan.newStarts, sfglEarnings: outPlan.newSfgl };

  return {
    newTeams, newTournaments, registryOverrides, processed: true,
    summary: {
      playerIn, playerOut, tournamentName: tourney.name,
      delta, oldTotal, newTotal,
      inStarts: inPlan.newStarts, outStarts: outPlan.newStarts,
      outOffRoster: !outPlan.onRoster,
    },
  };
};
