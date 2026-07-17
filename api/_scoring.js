// api/_scoring.js — THE tournament scoring engine.
// ============================================================================
// Single source of truth for how a team's tournament result is computed.
// Shared by BOTH deploy targets (plain JS, no React / Firebase deps):
//   • src/pages/admin/processTournamentData.js  (manual process / reprocess)
//   • src/utils/mulliganReversal.js             (mulligan undo recompute)
//   • api/cron.js handleProcessResults          (weekly auto-process)
// Previously each of those carried its own copy of this math and they had
// drifted (bonus splitting, settings-awareness, aggregation).
//
// League rules implemented here:
//   • A team's tournament earnings = sum of its TOP 5 starters' earnings.
//   • Round-leader bonus (R1–R3): if a team's lineup contains a round
//     co-leader, the team earns the FULL round bonus for EACH co-leader it
//     started — tied co-leaders are NOT split (commissioner ruling).
//   • Bonus amounts come from league settings when set (SeasonSettingsPanel:
//     bonusR{1,2,3}{Regular,Major}), else the league defaults below.
// ============================================================================

import { matchPlayerName, resolvePlayerName } from './_constants.js';

export { normalizePlayerName, matchPlayerName, resolvePlayerName, canonicalName } from './_constants.js';

export const DEFAULT_BONUSES_REGULAR = { round1: 20000, round2: 40000, round3: 60000 };
export const DEFAULT_BONUSES_MAJOR   = { round1: 40000, round2: 80000, round3: 120000 };

// Resolve the per-round bonus amounts for a tournament from league settings,
// falling back to the league defaults for any unset key.
export const getBonusAmounts = (isMajor, settings = {}) => isMajor
  ? {
      round1: settings?.bonusR1Major ?? DEFAULT_BONUSES_MAJOR.round1,
      round2: settings?.bonusR2Major ?? DEFAULT_BONUSES_MAJOR.round2,
      round3: settings?.bonusR3Major ?? DEFAULT_BONUSES_MAJOR.round3,
    }
  : {
      round1: settings?.bonusR1Regular ?? DEFAULT_BONUSES_REGULAR.round1,
      round2: settings?.bonusR2Regular ?? DEFAULT_BONUSES_REGULAR.round2,
      round3: settings?.bonusR3Regular ?? DEFAULT_BONUSES_REGULAR.round3,
    };

// Look up a player's earnings with fuzzy fallback: exact key → alias /
// normalized / word-set match → unique last-name + first-initial. The last
// step is what stops "Sam Stevens" silently scoring $0 when the results
// source lists him as "Samuel Stevens" (and vice versa).
export const lookupPlayerEarnings = (playerName, earningsMap = {}) => {
  if (earningsMap[playerName] !== undefined) return earningsMap[playerName] || 0;
  const keys = Object.keys(earningsMap);
  const k = keys.find(key => matchPlayerName(key, playerName));
  if (k !== undefined) return earningsMap[k] || 0;
  const resolved = resolvePlayerName(playerName, keys);
  return resolved !== null ? (earningsMap[resolved] || 0) : 0;
};

/**
 * Compute one team's result for one tournament.
 *
 * @param lineup       array of starter names (post-mulligan effective lineup)
 * @param earningsMap  { playerName: earnings } from the results source
 * @param roundLeaders { round1: [names], round2: [...], round3: [...] }
 *                     (a bare string per round is tolerated for legacy data)
 * @param bonuses      { round1, round2, round3 } dollar amounts — use
 *                     getBonusAmounts(tournament.isMajor, settings)
 * @param roster       team.roster, for limited/unlimited flags on players
 *
 * Returns:
 *   teamResult     — { totalEarnings, bonuses, players } — the exact shape
 *                    stored at tournament.results.teams[teamId]
 *   starterResults — [{ playerName, earnings }] for EVERY lineup player (not
 *                    just top 5), so callers update roster sfglEarnings with
 *                    the same numbers that produced the stored result
 */
export const computeTeamTournamentResult = ({ lineup, earningsMap = {}, roundLeaders = {}, bonuses, roster = [] }) => {
  const starterResults = (lineup || []).map(playerName => ({
    playerName,
    earnings: lookupPlayerEarnings(playerName, earningsMap),
  }));

  const topStarters = [...starterResults].sort((a, b) => b.earnings - a.earnings).slice(0, 5);
  let totalEarnings = topStarters.reduce((s, p) => s + p.earnings, 0);

  const bonusEarnings = { round1: 0, round2: 0, round3: 0 };
  const playersWithBonuses = {};
  ['round1', 'round2', 'round3'].forEach(round => {
    const raw = roundLeaders?.[round];
    const leaders = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    leaders.forEach(leaderName => {
      if (!leaderName) return;
      const actual = (lineup || []).find(pn => matchPlayerName(pn, leaderName));
      if (!actual) return;
      // Full bonus per co-leader, ACCUMULATED (+=): a team that started TWO
      // co-leaders of the same round is paid the bonus twice, and the
      // recorded per-round figure must match what was paid — display and
      // undo math depend on it. (The old engines paid twice via
      // totalEarnings but recorded once via `=`.)
      bonusEarnings[round] += bonuses[round];
      totalEarnings += bonuses[round];
      if (!playersWithBonuses[actual]) playersWithBonuses[actual] = { total: 0, rounds: [] };
      playersWithBonuses[actual].total += bonuses[round];
      playersWithBonuses[actual].rounds.push({ round: round.replace('round', ''), bonus: bonuses[round] });
    });
  });

  // Invariant: what we PAY equals what we RECORD —
  //   totalEarnings === sum(top-5 starter earnings) + sum(bonusEarnings)
  // This is exactly the property the old engines violated (`=` instead of
  // `+=` under-recorded the bonus when one team started two co-leaders of
  // the same round). Derived arithmetic should make a violation impossible;
  // warn loudly if a future edit breaks it — display and undo math depend
  // on the recorded figures matching the paid total.
  const recordedTotal = topStarters.reduce((s, p) => s + p.earnings, 0)
    + bonusEarnings.round1 + bonusEarnings.round2 + bonusEarnings.round3;
  if (recordedTotal !== totalEarnings) {
    console.warn(`[scoring] invariant violation: totalEarnings ${totalEarnings} !== top-5 earnings + bonuses ${recordedTotal}`);
  }

  const players = topStarters.map(s => {
    const rosterEntry = roster.find(p => p.name === s.playerName);
    return {
      name: s.playerName,
      earnings: s.earnings,
      limited: rosterEntry?.limited || false,
      unlimited: rosterEntry?.unlimited || false,
      bonus: playersWithBonuses[s.playerName]?.total || 0,
      roundsLed: playersWithBonuses[s.playerName]?.rounds || [],
      wasRoundLeader: (playersWithBonuses[s.playerName]?.total || 0) > 0,
    };
  });

  return {
    teamResult: { totalEarnings, bonuses: bonusEarnings, players },
    starterResults,
  };
};
