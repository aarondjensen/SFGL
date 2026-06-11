// src/utils/swingAward.js
// ============================================================================
// Single source of truth for the "award swing winner" logic. Used by both:
//   • TournamentResultsPanel (auto-fires after manual process/reprocess)
//   • SwingWinnerPanel        (the manual override button — same logic)
//   • api/cron.js             (inlines a server-side copy — keep them in sync)
//
// `computeSwingAward({ segment, allTournaments, transactions, teams })` returns
// null (no award due) or `{ segment, winnerTeam, winnerEarnings, pot, newTx,
// updatedTeams }`. Caller is responsible for persisting the new tx and the
// updated teams.
// ============================================================================

import { getSegmentForTournament } from './index.js';
import { getSwingPot, getSwingLeader } from './sharedHelpers.js';

/**
 * Returns the swing-award payload if all of the following are true:
 *   • The segment has at least one non-alternate tournament.
 *   • Every non-alternate tournament in the segment is `completed`.
 *   • No `swing_winner` transaction exists yet for this segment.
 *   • The pot (sum of fees collected during the swing) is > 0.
 *   • A clear leader exists.
 *
 * Otherwise returns null. Idempotent: safe to call repeatedly — once a
 * swing_winner tx exists for the segment, this returns null forever.
 */
export const computeSwingAward = ({ segment, allTournaments, transactions, teams }) => {
  if (!segment) return null;

  // Idempotent guard
  const alreadyAwarded = (transactions || []).some(
    tx => tx.type === 'swing_winner' && tx.segment === segment
  );
  if (alreadyAwarded) return null;

  // All non-alternate tournaments in this swing must be completed
  const swingTourneys = (allTournaments || []).filter(t =>
    getSegmentForTournament(t) === segment && !t.isAlternate
  );
  if (swingTourneys.length === 0) return null;
  if (!swingTourneys.every(t => t.completed)) return null;

  // Pot must be > 0
  const pot = getSwingPot(transactions, allTournaments, segment);
  if (pot === 0) return null;

  // Determine winner
  const leader = getSwingLeader(allTournaments, segment);
  if (!leader) return null;
  const winnerTeam = (teams || []).find(t => t.id === leader.teamId);
  if (!winnerTeam) return null;

  // Anchor the tx to the last tournament of the swing for ordering purposes
  const lastTourney = swingTourneys[swingTourneys.length - 1];
  const tournamentIndex = (allTournaments || []).indexOf(lastTourney);

  // Wave J Round 6 follow-up: swing_winner txs were missing txId and
  // timestamp, which caused two bugs:
  //   1. transactionsApi.getAll uses orderBy('timestamp', 'desc') which
  //      silently drops documents missing the field — the swing_winner tx
  //      WAS being persisted but was invisible to TransactionsView.
  //   2. Without txId, the dedup logic in _dedupeTransactions had to fall
  //      back to a composite key, making cross-session matching fragile.
  // Both issues are now fixed by including txId + timestamp here, mirroring
  // the server-side maybeAutoAwardSwingServer in api/cron.js.
  const newTx = {
    txId: `swing-${segment}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    team: winnerTeam.name,
    type: 'swing_winner',
    player: winnerTeam.owner,
    fee: 0,
    amount: pot,
    segment,
    date: new Date().toLocaleDateString(),
    timestamp: Date.now(),
    status: 'completed',
    tournamentIndex: tournamentIndex >= 0 ? tournamentIndex : undefined,
    tournament: tournamentIndex >= 0 ? (allTournaments[tournamentIndex]?.name || undefined) : undefined,
    note: `${segment} winner pot`,
  };

  const updatedTeams = (teams || []).map(t =>
    t.id === leader.teamId
      ? { ...t, earnings: (t.earnings || 0) + pot }
      : t
  );

  return {
    segment,
    winnerTeam,
    winnerEarnings: leader.earnings,
    pot,
    newTx,
    updatedTeams,
  };
};

/**
 * Convenience for the "tournament just got processed" case. Resolves the
 * segment from the tournament and delegates to computeSwingAward. Returns
 * null if the segment is unknown or no award is due.
 */
export const maybeAwardForCompletedTournament = ({
  justProcessedTournament,
  allTournaments,
  transactions,
  teams,
}) => {
  if (!justProcessedTournament) return null;
  const segment = getSegmentForTournament(justProcessedTournament);
  return computeSwingAward({ segment, allTournaments, transactions, teams });
};
