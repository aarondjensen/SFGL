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
// The recompute delegates to the SHARED scoring engine (api/_scoring.js) —
// the same module the live process paths (client + cron) use — so a reversal
// always recomputes the exact totals the original processing produced.
// ============================================================================
import { getPlayerRegistry } from './sharedHelpers';
import {
  matchPlayerName,
  lookupPlayerEarnings,
  getBonusAmounts,
  computeTeamTournamentResult,
} from '../../api/_scoring.js';

const lookupEarnings = (name, earningsMap) => lookupPlayerEarnings(name, earningsMap);

// Recompute a team's tournament result for an effective lineup — same math as
// the live engines (top-5 by earnings + full round-leader bonus per co-leader),
// settings-aware for custom bonus amounts.
export const recomputeTeamTournamentResult = (lineup, earningsMap, roundLeaders, isMajor, roster, settings = {}) => {
  const { teamResult } = computeTeamTournamentResult({
    lineup,
    earningsMap,
    roundLeaders,
    bonuses: getBonusAmounts(isMajor, settings),
    roster,
  });
  return teamResult;
};

// Compute the complete reversal of a mulligan tx.
// Returns { newTeams, newTournaments, registryOverrides, processed, summary }
// or { error } if it can't be reversed safely.
export const computeMulliganReversal = (tx, teams, tournaments, settings = {}) => {
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

  const newTeamRes = recomputeTeamTournamentResult(newFull, earningsMap, roundLeaders, isMajor, team.roster, settings);
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
