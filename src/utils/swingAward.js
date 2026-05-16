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

  const newTx = {
    team: winnerTeam.name,
    type: 'swing_winner',
    player: winnerTeam.owner,
    fee: 0,
    amount: pot,
    segment,
    date: new Date().toLocaleDateString(),
    status: 'completed',
    tournamentIndex: tournamentIndex >= 0 ? tournamentIndex : undefined,
    note: `${segment} winner pot`,
  };

  // ── Design note: pot does NOT add to team.earnings ──────────────────────
  // The swing pot is real money collected from manager transactions (waiver
  // fees, etc.) and is tracked exclusively in the `transactions` collection.
  // `team.earnings`, by contrast, is the fantasy-golf total — the sum of
  // PGA Tour earnings of each team's starting-lineup players, derived from
  // `tournament.results`. The two are conceptually different ledgers and
  // must NEVER mix: adding the pot to team.earnings would inflate the
  // displayed standings AND the waiver-priority calculation that uses
  // team.earnings as input.
  //
  // We return `updatedTeams: teams` (unchanged) for backward compatibility
  // with callers that destructure `award.updatedTeams` — they get the same
  // teams array they passed in, no mutation.
  const updatedTeams = teams || [];

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
