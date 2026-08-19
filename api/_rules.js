// api/_rules.js — SFGL league rules, shared by the app and the cron.
// ============================================================================
// SHARED BY BOTH DEPLOY TARGETS. See api/_league.js for why a shared module has
// to live under api/ (short version: api/ cannot import from src/, but Vite can
// bundle api/ into the browser build, so api/ is the only directory both sides
// reach).
//
// _league.js holds constants and the wall clock. This file holds the RULES: how
// a tournament maps to a swing, what a transaction owes, what is in the pot,
// who is on a roster, and who wins a swing.
//
// Everything here used to exist twice. api/cron.js carried its own
// getSegmentForTournamentServer, getTransactionFeeServer, computeSwingPotServer
// and maybeAutoAwardSwingServer, plus an inline copy of the effective-roster
// replay and its own bonus tables — each under a "⚠ KEEP IN SYNC with
// src/utils/..." comment. Those comments were honest about the hazard and
// powerless against it, and the copies had already diverged more than once:
//
//   • getSegmentForTournamentServer once mapped Jan-Mar to 'Spring Swing' and
//     Aug-Sep to a 'Fall Swing' that exists nowhere else in the codebase, and
//     returned null for Oct-Dec entirely — so every server-side pot and
//     auto-award keyed off wrong segments;
//   • computeSwingPotServer did not exclude alternate events and summed only
//     the stored tx.fee, so the cron's pot disagreed with the figure managers
//     saw in the app;
//   • the roster replay drifted on ordering, which is the bug that let a
//     same-week add-then-flip leave both players on a roster.
//
// The cron now imports these. There is one copy.
//
// Constraints, same as _league.js: no Firebase, no DOM, no Node built-ins. This
// file must stay importable from a browser bundle and a serverless function
// alike.
// ============================================================================

import { SWINGS, swingForMonth, txBelongsToTeam } from './_league.js';

// ── Round-leader bonuses ─────────────────────────────────────────────────────
// Defaults; the commish can override each via league_settings (bonusR1Major
// etc). api/cron.js declared its own BONUSES_REG/BONUSES_MAJ inline.
export const BONUSES_REGULAR = { round1: 20000, round2: 40000, round3: 60000 };
export const BONUSES_MAJOR   = { round1: 40000, round2: 80000, round3: 120000 };

/** Effective round bonuses for a tournament, honouring commish overrides. */
export const bonusesFor = (tournament, settings = {}) => {
  const isMajor = !!(tournament?.isMajor);
  const d = isMajor ? BONUSES_MAJOR : BONUSES_REGULAR;
  return isMajor
    ? {
        round1: settings.bonusR1Major ?? d.round1,
        round2: settings.bonusR2Major ?? d.round2,
        round3: settings.bonusR3Major ?? d.round3,
      }
    : {
        round1: settings.bonusR1Regular ?? d.round1,
        round2: settings.bonusR2Regular ?? d.round2,
        round3: settings.bonusR3Regular ?? d.round3,
      };
};

// ── Lineups ──────────────────────────────────────────────────────────────────

/**
 * The lineup a team should be SCORED on for a given tournament.
 *
 * Prefers the snapshot frozen at lock (`tournament.lockedLineups[teamId]`) over
 * the team's live `lineup`.
 *
 * Reading the live lineup is a real scoring bug, not a theoretical one. Lineup
 * editing re-opens Sunday 9pm ET while results process Monday 9am ET by
 * default, so for twelve hours a manager can set NEXT week's five and the
 * just-finished tournament gets scored with them. Three team-events in the 2026
 * season were scored on the wrong five that way, worth $1.1M — each time a
 * different player from the same roster, which is exactly what a next-week
 * lineup looks like.
 *
 * Falls back to the live lineup when no snapshot exists, so events processed
 * before this existed behave as they always did.
 */
export const lineupFor = (tournament, team) => {
  const frozen = tournament?.lockedLineups?.[team?.id];
  if (Array.isArray(frozen) && frozen.length) return frozen;
  return Array.isArray(team?.lineup) ? team.lineup : [];
};

/**
 * The lineup a PAST tournament was actually scored with, and where that answer
 * came from.
 *
 * The near-twin of lineupFor, and the distinction matters enough to be worth
 * two functions. lineupFor answers "what SHOULD this event score" and is right
 * to end at team.lineup — for a live event that is the manager's current five.
 * This answers "what DID it score", where falling through to team.lineup is
 * almost always wrong: the live lineup is next week's, and reading it for a
 * finished event is the drift that put three 2026 events on the wrong five in
 * the first place.
 *
 * So it prefers, in order:
 *   locked     the snapshot frozen at lineup lock
 *   processed  results.fullLineups — what the processor recorded scoring
 *   scored     the names on the stored per-player rows, for results written
 *              before fullLineups existed
 *   live       team.lineup, which is a guess, and is reported as one
 *
 * Callers get the source so they can refuse to act on a guess. Both correction
 * scripts need exactly this precedence, and the first copy of it that lived
 * only in a comment was reproduced wrongly the very next time it was needed.
 */
export const scoredLineupFor = (tournament, team) => {
  const id = team?.id;
  const locked = tournament?.lockedLineups?.[id];
  if (Array.isArray(locked) && locked.length) return { lineup: [...locked], source: 'locked' };

  const processed = tournament?.results?.fullLineups?.[id];
  if (Array.isArray(processed) && processed.length) return { lineup: [...processed], source: 'processed' };

  const players = tournament?.results?.teams?.[id]?.players;
  if (Array.isArray(players) && players.length) {
    const names = players.map(p => p?.name || p).filter(Boolean);
    if (names.length) return { lineup: names, source: 'scored' };
  }

  const live = Array.isArray(team?.lineup) ? team.lineup : [];
  return { lineup: [...live], source: live.length ? 'live' : 'none' };
};

// ── Scoring starters ─────────────────────────────────────────────────────────

export const DEFAULT_LINEUP_SIZE = 5;

/**
 * The starters that score for a team in one tournament.
 *
 * A team scores THE PLAYERS IN ITS STARTING LINEUP — usually five, sometimes
 * fewer. Not "the best five".
 *
 * This replaces three byte-identical copies of
 *
 *     [...starterResults].sort((a, b) => b.earnings - a.earnings).slice(0, 5)
 *
 * in processTournamentData.js, api/cron.js and src/utils/mulliganReversal.js —
 * the last of which described itself as "same math as processTournamentData",
 * which is the comment this repo has learned to distrust.
 *
 * Two things were wrong with that line:
 *
 *   1. `.slice(0, 5)` after a descending sort silently keeps the five
 *      HIGHEST-EARNING names. For a normal five-player lineup that is the same
 *      set, so it looks harmless. It stops being harmless when the mulligan
 *      handler's fallback branch pushes an IN player onto a lineup it could not
 *      find the OUT player in: the lineup becomes six, and the team is quietly
 *      scored on its best five. An oversized lineup is a data error, and paying
 *      out the most generous reading of it hides the error instead of showing
 *      it. `oversized` is returned so callers can say so out loud.
 *
 *   2. The 5 was hardcoded in all three, while the commissioner has a
 *      `lineupSize` setting that SeasonSettingsPanel writes and RostersView
 *      honours. Changing it moved what managers could submit but not what the
 *      scorer counted.
 *
 * Order is descending by earnings, preserving how results have always been
 * displayed. Nothing is dropped.
 */
export const scoringStarters = (starterResults, settings = {}) => {
  const list = (Array.isArray(starterResults) ? starterResults : []).filter(Boolean);
  const configured = settings?.lineupSize;
  const lineupSize = (Number.isInteger(configured) && configured > 0)
    ? configured
    : DEFAULT_LINEUP_SIZE;

  return {
    starters: [...list].sort((a, b) => (b.earnings || 0) - (a.earnings || 0)),
    lineupSize,
    oversized: list.length > lineupSize,
  };
};

// ── The cut rule ─────────────────────────────────────────────────────────────
/**
 * Does this team forfeit its earnings for the event?
 *
 * THE RULE, as the commissioner states it: if only ONE of a team's starters
 * makes the cut, the team's earnings for that week do not count — unless the
 * manager started a full lineup AND that lone survivor WINS the tournament.
 *
 * ── Why this is being added back ──────────────────────────────────────────
 * A version of this once existed here and was DELETED, on the reasoning that
 * the rule could not be found written down anywhere and every observed case
 * happened to have one earner, which made a coincidence look like a rule. The
 * reasoning was sound and the conclusion was wrong. The rule is real; it simply
 * lives in the commissioner's head and in three hand-typed zeros on the sheet.
 *
 * It reproduces the 2026 sheet exactly: three team-events have exactly one
 * earner, all three are zeroed on the sheet, and no other zeroed block exists
 * to explain. No 2026 event exercises the winner exception, so that branch is
 * carried on the commissioner's word alone and is covered by tests rather than
 * by data.
 *
 * ── What forfeiting does and does not touch ───────────────────────────────
 * The TEAM's event total goes to zero. The individual player keeps his money:
 * the sheet's own per-team player grid still shows the lone earner's winnings
 * in the week his team forfeited, so sfglEarnings and the player's season stats
 * are unaffected. Only the number the standings add up is zeroed.
 *
 * "Makes the cut" is read as "earned money", because earnings are the only
 * per-player fact a result carries — no finishing position is stored. The two
 * come apart for an amateur or a non-member, who can place well and be paid
 * nothing; such a player counts as having missed the cut here, which is a
 * limitation worth knowing rather than a decision worth defending.
 *
 * Returns null when there is no forfeit, or a reason object when there is, so
 * callers can say WHY a team shows $0 rather than leaving it unexplained.
 */
export const cutRuleForfeit = ({ starters, earningsMap, settings } = {}) => {
  // The commissioner can switch it off; absent a setting it is ON, because it
  // is the league's rule and the season's results already assume it.
  if (settings?.cutRuleEnabled === false) return null;

  const list = (Array.isArray(starters) ? starters : []).filter(Boolean);
  const cutMakers = list.filter(s => (s.earnings || 0) > 0);
  if (cutMakers.length !== 1) return null;

  const lone = cutMakers[0];
  const configured = settings?.lineupSize;
  const lineupSize = (Number.isInteger(configured) && configured > 0)
    ? configured
    : DEFAULT_LINEUP_SIZE;

  // "Started five" — a manager who started short does not get the exception,
  // which is the whole point of it: the escape hatch rewards fielding a full
  // lineup and getting a winner out of it, not fielding one man who wins.
  const startedFull = list.length >= lineupSize;

  // The winner is the biggest cheque in the field. No finishing position is
  // stored anywhere in a result, so this is the only derivation available —
  // and it is exact, since the champion is always the top earner.
  const purses = Object.values(earningsMap || {}).map(v => Number(v) || 0);
  const top = purses.length ? Math.max(...purses) : 0;
  const won = top > 0 && (lone.earnings || 0) >= top;

  if (startedFull && won) return null;

  return {
    player: lone.playerName || lone.name || null,
    earnings: lone.earnings || 0,
    starters: list.length,
    lineupSize,
    startedFull,
    won,
  };
};

// ── Limited players: the start limit ─────────────────────────────────────────
/**
 * A LIMITED player may be started a fixed number of times per season — twelve
 * by default, whatever the commish sets `maxLimitedStarts` to otherwise.
 * UNLIMITED players (and plain rostered players) have no cap.
 *
 * The limit was previously enforced against `player.starts` alone while the
 * roster badge beside the player's name displayed a DIFFERENT number, derived
 * from tournament results. The two disagree in both directions — a stored
 * tally that never got its increment leaves a maxed player addable while the
 * badge reads 12/12; a derived count scoped to one team misses starts a player
 * spent on a previous roster — so the rule now reads BOTH and takes the higher.
 * Every caller goes through here, so the number that blocks a lineup is the
 * same number the manager was shown.
 *
 * Blocking the ADD is the whole enforcement, and deliberately so: processing
 * an event increments `starts` and clears `team.lineup` in the same write (see
 * the returns in api/cron.js and src/pages/admin/processTournamentData.js), so
 * a player cannot cross the cap while sitting in a lineup — every lineup is
 * re-entered from empty, through the block, after each event. There is nothing
 * left for a lock-time or scoring-time check to catch.
 */
export const DEFAULT_MAX_LIMITED_STARTS = 12;

/** The configured cap, falling back to the league default. */
export const maxLimitedStarts = (settings = {}) => {
  const n = Number(settings?.maxLimitedStarts);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_LIMITED_STARTS;
};

/**
 * Where a limited player stands against the cap.
 *
 *   player        a roster entry — `limited` and the durable `starts` tally
 *   derivedStarts starts derived from completed results for the team asking,
 *                 which is the number the roster badge renders (optional)
 *   settings      league_settings, for the commish's maxLimitedStarts
 *
 * Returns `{ limited, used, max, remaining, outOfStarts }`. `outOfStarts` is
 * the only thing a caller should gate a starting lineup on: it is false for
 * anyone who isn't limited, so the caller needs no `player.limited` test of
 * its own.
 */
export const limitedStartsStatus = (player, { derivedStarts, settings } = {}) => {
  const max = maxLimitedStarts(settings);
  const limited = !!player?.limited;
  const used = Math.max(Number(player?.starts) || 0, Number(derivedStarts) || 0);
  return {
    limited,
    used,
    max,
    remaining: Math.max(0, max - used),
    outOfStarts: limited && used >= max,
  };
};

// ── Segment resolution ───────────────────────────────────────────────────────

/**
 * Returns the segment name for a given date (defaults to today).
 * Accepts an optional Date object so callers like StandingsView can
 * resolve the segment for a specific tournament start date rather than
 * relying on the current wall-clock month.
 */
export const getSegmentByDate = (date) =>
  swingForMonth((date || new Date()).getMonth() + 1);

const MONTH_ABBRS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

/**
 * Returns the segment for a tournament: an explicit `segment` (set by the
 * schedule importer), then the legacy `swing` field, then date inference.
 *
 * ── Merged from two implementations that each got something wrong ─────────
 * The client's version and api/cron.js's getSegmentForTournamentServer both
 * lived here, and they disagreed on two points that mattered:
 *
 *   1. FIELD NAME. Firestore stores the ordering date as `start_date`
 *      (snake_case) — see _ensureStartDates in src/api/firebase.js. The cron
 *      read `start_date || startDate`; the CLIENT only ever read `startDate`.
 *      So for any tournament carrying only start_date and no segment/dates
 *      string, the client returned null — no swing at all — while the cron
 *      resolved it correctly. Both spellings are accepted now.
 *
 *   2. ISO PARSING. The client did `new Date('2026-03-01').getMonth()`. That
 *      string parses as UTC midnight and getMonth() reads LOCAL time, so
 *      anywhere west of Greenwich it is still 28 February — and the first
 *      event of a month lands in the previous swing. The cron sliced the month
 *      out of the string instead, which has no timezone to get wrong. That is
 *      the approach kept here.
 */
export const getSegmentForTournament = (tournament) => {
  if (!tournament) return null;
  if (tournament.segment) return tournament.segment;
  if (tournament.swing)   return tournament.swing;

  // ISO ordering date, either spelling. Sliced rather than Date-parsed.
  const iso = tournament.start_date || tournament.startDate;
  if (typeof iso === 'string' && /^\d{4}-\d{2}/.test(iso)) {
    const seg = swingForMonth(parseInt(iso.slice(5, 7), 10));
    if (seg) return seg;
  }
  // A real Date object (or anything else Date understands) in startDate.
  if (tournament.startDate && typeof tournament.startDate !== 'string') {
    const d = new Date(tournament.startDate);
    if (!Number.isNaN(d.getTime())) return getSegmentByDate(d);
  }
  // Finally the human `dates` string ("Apr 6-12").
  if (tournament.dates) {
    const m = String(tournament.dates).match(/^([A-Za-z]+)/);
    if (m) {
      const idx = MONTH_ABBRS.indexOf(m[1].slice(0, 3).toLowerCase());
      if (idx !== -1) return swingForMonth(idx + 1);
    }
  }
  return null;
};

/**
 * Where a tournament's swing actually came from: 'explicit' when a human set
 * it, 'derived' when only the month fallback produced one, 'none' when nothing
 * could resolve it.
 *
 * This exists because 'derived' is not a safe default here, and the UI needs to
 * say so. See seedSegments below for why.
 */
export const segmentSource = (tournament) => {
  if (!tournament) return 'none';
  if (tournament.segment || tournament.swing) return 'explicit';
  return getSegmentForTournament(tournament) ? 'derived' : 'none';
};

/**
 * Assign every league tournament to a swing, in contiguous blocks.
 *
 * ── WHY THE MONTH FALLBACK CANNOT BE THE SEED ────────────────────────────────
 * getSegmentForTournament falls back to swingForMonth, which maps calendar
 * quarters: Jan-Mar, Apr-Jun, Jul-Sep, Oct-Dec. The SFGL season runs January
 * to August, so months 10-12 never occur and that fallback is STRUCTURALLY
 * INCAPABLE of returning 'Fall Finish'.
 *
 * The consequence is asymmetric and it is the whole reason this function
 * exists: an untagged tournament can only ever defect OUT of Fall Finish (into
 * Summer, for anything in July or August), never into it. Fall Finish is the
 * one swing that exists solely because a human tagged it — and losing a member
 * silently is expensive, because computeSwingAward gates on "every member
 * completed". Drop Wyndham out of Fall and the remaining six may all be
 * complete, so the Fall pot pays out early.
 *
 * Checked against the real 2026 schedule, the quarter fallback disagreed with
 * the commissioner's tagging on 20 of 31 events and left Fall Finish empty.
 *
 * ── THE SEED ─────────────────────────────────────────────────────────────────
 * The league plays 30-32 events split into four swings of roughly eight. So
 * seed four contiguous, near-equal blocks and let the commissioner nudge the
 * boundaries — which is the actual shape of the season, unlike calendar
 * quarters. 31 events seeds 8/8/8/7.
 *
 * Ordering is by ARRAY POSITION, deliberately. `resolveTournamentStart` (now in
 * api/_league.js, so this file could reach it) answers null for any event with
 * no date at all, and `start_date` is an ordering field rather than a real
 * date — neither can order a whole schedule. The array's own order is what the
 * schedule view shows and what tournamentIndex already means, so it is the
 * right notion of "schedule order" here.
 *
 * Returns a new array; input is not mutated.
 */
export const seedSegments = (tournaments) => {
  const list = tournaments || [];
  const out = list.map(t => (t ? { ...t } : t));

  // Alternates are excluded from swing membership everywhere else
  // (makeSwingMembership, computeSwingAward), so seeding one would add a member
  // that can never satisfy the completion gate and would block the award.
  const seedable = [];
  list.forEach((t, i) => { if (t && !t.isAlternate) seedable.push(i); });

  const n = seedable.length;
  if (n === 0) return out;

  // Remainder goes to the earlier swings, so the last block is the short one.
  const base = Math.floor(n / SWINGS.length);
  const extra = n % SWINGS.length;

  let cursor = 0;
  SWINGS.forEach((swing, s) => {
    const size = base + (s < extra ? 1 : 0);
    for (let k = 0; k < size; k++) out[seedable[cursor++]].segment = swing;
  });
  return out;
};

// ── Swing helpers ────────────────────────────────────────────────────────────
// Returns all completed tournaments belonging to a given swing.
export const getSwingTournaments = (tournaments, segment) => {
  if (!segment) return [];
  return (tournaments || []).filter(t =>
    t.completed &&
    getSegmentForTournament(t) === segment &&
    t.results?.teams
  );
};

// Returns { teamId: totalEarnings } for a given swing across all completed tournaments.
export const getSwingEarningsByTeam = (tournaments, segment) => {
  const byTeam = {};
  getSwingTournaments(tournaments, segment).forEach(t => {
    Object.entries(t.results.teams).forEach(([teamId, tr]) => {
      byTeam[teamId] = (byTeam[teamId] || 0) + (tr.totalEarnings || 0);
    });
  });
  return byTeam;
};

// Returns { teamId: totalSeasonEarnings } derived from completed tournament
// results — the SAME summation StandingsView uses to render the season table
// and that cron uses for the waiver tie-breaker. This is the authoritative
// season-earnings figure; prefer it over the denormalized team.earnings field,
// which is a running tally that can drift (mulligan reprocessing, manual edits,
// swing-winner adjustments). Keeping every earnings consumer on this one
// derivation is what keeps standings, manual waivers, and cron waivers in
// agreement.
export const getSeasonEarningsByTeam = (tournaments) => {
  const byTeam = {};
  (tournaments || []).forEach(t => {
    if (!t.completed || !t.results?.teams) return;
    Object.entries(t.results.teams).forEach(([teamId, tr]) => {
      byTeam[teamId] = (byTeam[teamId] || 0) + (tr.totalEarnings || 0);
    });
  });
  return byTeam;
};

// Returns the leader of a swing as { teamId, earnings } | null
export const getSwingLeader = (tournaments, segment) => {
  const byTeam = getSwingEarningsByTeam(tournaments, segment);
  const top = Object.entries(byTeam).sort((a, b) => b[1] - a[1])[0];
  return top ? { teamId: top[0], earnings: top[1] } : null;
};
// ── Transaction fee — single source of truth ────────────────────────────
// Resolves the fee a transaction OWES from its type (+ league settings) so no
// caller hand-rolls per-type string checks. Those drifted: the free-agent type
// is stored as BOTH 'fa' (AddTransactionModal) and 'free agent'
// (AddDropPlayerModal), and a stale 'free agent'-only check in the former saved
// $0 fees. Normalizing both spellings here kills that whole class of bug.
// Failed/blocked claims and non-fee types (drop, mulligan, swing_winner) owe 0.
//   feeWaiver default 2  ('waiver')
//   feeFA     default 1  ('fa' | 'free agent')
export const getTransactionFee = (type, settings, status) => {
  if (status === 'failed') return 0;
  const t = String(type || '').trim().toLowerCase();
  if (t === 'waiver') return settings?.feeWaiver ?? 2;
  if (t === 'fa' || t === 'free agent') return settings?.feeFA ?? 1;
  return 0;
};

// Returns the swing-fee pot for a given segment from the transactions array.
// Uses the same rules as the swing-winner award:
//   • Skip swing_winner records themselves
//   • Skip failed waivers (no fee charged)
//   • Match by tournamentIndex when available, otherwise fall back to tx.segment
//
// IMPORTANT: counts fees from ALL non-alternate tournaments in the segment,
// not just completed ones. The pot is the running tally of all fees collected
// during the swing — when a manager paid a $2 waiver fee for a Spring event,
// that $2 is in the pot the moment the transaction completes, regardless of
// whether that specific tournament has played out yet.
//
// Wave J Round 6 follow-up: previously this filtered tournaments by
// `t.completed && t.results?.teams` (via getSwingTournaments), which caused
// a discrepancy with the TransactionsView "Transaction Fees" panel — that
// panel correctly counts ALL segment-matched fees, but getSwingPot was
// dropping fees tied to in-progress tournaments. The two displays showed
// different totals for the same swing. The completion gate is enforced
// independently inside computeSwingAward (at lines 38-42), so dropping it
// The fee a transaction actually contributes. Trusts a stored fee when present
// (preserving any custom amount a commissioner entered), else derives it from
// the type — which recovers legacy rows saved with fee 0 by the old
// FA type-string mismatch so they still count.
export const effectiveTransactionFee = (tx, settings) => {
  const stored = tx?.fee || 0;
  return stored > 0 ? stored : getTransactionFee(tx?.type, settings, tx?.status);
};

// Does this transaction contribute a fee at all? Failed claims were never
// charged, and swing_winner rows carry a payout in `amount`, not a fee.
const isFeeBearing = (tx) => !!tx && tx.status !== 'failed' && tx.type !== 'swing_winner';

// Returns a predicate: "does this transaction belong to `segment`?"
//
// Builds BOTH a name set and an index set for in-segment, non-alternate events.
// New transactions carry a stable `tournament` name (reorder-proof); legacy ones
// only have a positional `tournamentIndex`, so match by name when present and
// fall back to the index, then to the row's own `segment` tag.
//
// Alternates are excluded to match the computeSwingAward gate — alternate-event
// fees count toward season totals but not the swing pot.
export const makeSwingMembership = (tournaments, segment) => {
  const list = tournaments || [];
  const swingNames = new Set();
  const swingIndexes = new Set();
  // Every name in the schedule, not just this swing's — see tier 1 below.
  const knownNames = new Set();

  list.forEach((t, i) => {
    if (t?.name) knownNames.add(t.name);
    if (getSegmentForTournament(t) === segment && !t.isAlternate) {
      if (t?.name) swingNames.add(t.name);
      swingIndexes.add(i);
    }
  });

  return (tx) => {
    // Each tier DECIDES when it can identify the tournament, and falls through
    // only when the reference is unresolvable. Tiers must stay mutually
    // exclusive: if a miss fell through instead of deciding, a transaction
    // whose name sits in one swing and whose stale index points at another
    // would answer true for BOTH and be counted twice.
    //
    // Tier 1 previously read `return swingNames.has(tx.tournament)`, which
    // decided on a name this swing didn't recognise — including names no
    // tournament anywhere recognised. Such a row answered false for EVERY
    // swing, so its fee silently vanished from all four pots while still
    // counting in getSeasonFeesByTeam; season totals and the sum of the swings
    // stopped reconciling with nothing on screen to explain it.
    //
    // Not hypothetical: tournamentsApi.setAll uses the tournament NAME as the
    // Firestore document id, so renaming an event rewrites its identity and
    // orphans every transaction already tagged with the old name.
    if (tx.tournament && knownNames.has(tx.tournament)) return swingNames.has(tx.tournament);

    if (tx.tournamentIndex !== undefined &&
        tx.tournamentIndex >= 0 && tx.tournamentIndex < list.length) {
      return swingIndexes.has(tx.tournamentIndex);
    }

    return tx.segment === segment;
  };
};

// { teamName: feesOwedThisSwing }. The per-team breakdown behind both the
// TransactionsView fee panel and the swing pot, so the cards and the pot can no
// longer disagree — the pot is literally the sum of the cards.
//
// NOTE keyed by team NAME, because that is what transactions store in tx.team.
export const getSwingFeesByTeam = (transactions, tournaments, segment, settings) => {
  if (!segment) return {};
  const inSwing = makeSwingMembership(tournaments, segment);
  const byTeam = {};
  (transactions || []).forEach(tx => {
    if (!isFeeBearing(tx)) return;
    const fee = effectiveTransactionFee(tx, settings);
    if (fee <= 0) return;
    if (!inSwing(tx)) return;
    byTeam[tx.team] = (byTeam[tx.team] || 0) + fee;
  });
  return byTeam;
};

/** Fees owed by ONE team this swing, matched by stable id where available. */
export const getSwingFeesForTeam = (transactions, tournaments, segment, settings, team) => {
  if (!segment || !team) return 0;
  const inSwing = makeSwingMembership(tournaments, segment);
  return (transactions || []).reduce((sum, tx) => {
    if (!isFeeBearing(tx) || !txBelongsToTeam(tx, team) || !inSwing(tx)) return sum;
    return sum + effectiveTransactionFee(tx, settings);
  }, 0);
};

/** Fees owed by ONE team all season, matched by stable id where available. */
export const getSeasonFeesForTeam = (transactions, settings, team) => {
  if (!team) return 0;
  return (transactions || []).reduce((sum, tx) => {
    if (!isFeeBearing(tx) || !txBelongsToTeam(tx, team)) return sum;
    return sum + effectiveTransactionFee(tx, settings);
  }, 0);
};

// { teamName: feesOwedAllSeason } — every fee-bearing transaction regardless of
// segment or alternate status.
export const getSeasonFeesByTeam = (transactions, settings) => {
  const byTeam = {};
  (transactions || []).forEach(tx => {
    if (!isFeeBearing(tx)) return;
    const fee = effectiveTransactionFee(tx, settings);
    if (fee <= 0) return;
    byTeam[tx.team] = (byTeam[tx.team] || 0) + fee;
  });
  return byTeam;
};

// Total swing-fee pot for a segment — what the swing winner is paid.
//
// Now derived from getSwingFeesByTeam rather than re-walking the transactions
// with its own copy of the membership test and fee derivation. TransactionsView
// had a separate implementation of exactly this walk for its fee panel; the two
// had already drifted once (see the Wave J note above) and were the reason the
// panel and the pot could show different totals for the same swing.
export const getSwingPot = (transactions, tournaments, segment, settings) =>
  Object.values(getSwingFeesByTeam(transactions, tournaments, segment, settings))
    .reduce((sum, n) => sum + n, 0);
// ── Effective roster ─────────────────────────────────────────────────────────
// Given a base team.roster and the global transactions array, replays all
// processed/completed FA/waiver transactions to produce the team's effective
// CURRENT roster. This is the single source of truth used by every consumer
// that needs to know "who is on this team right now" for display purposes.
//
// Used previously in (with subtle variations):
//   • useRoster hook
//   • AddDropPlayerModal — rosteredPlayers + ownerMap
//   • AdminView.jsx — buildRoster + getRosterForTournament
//
// ORDERING IS LOAD-BEARING. Replaying an add/drop history is order-dependent:
// "add A in week 1, drop A for B in week 3" nets to {B}, but applying those
// two transactions in the reverse order nets to {A, B} — the drop removes an
// A that hasn't been added yet, then week 1 adds A back.
//
// This function used to have NO sort at all. The `transactions` array it is
// handed comes from transactionsApi.getAll(), which sorts NEWEST FIRST — so
// every caller was replaying history backwards and resurrecting dropped
// players. Positions are resolved from each tx's stable tournament NAME
// (resolveTxTournamentIndex), so a schedule reorder can't misalign them
// either; legacy rows carrying only a positional index still work.
//
// Sorting by tournament position ALONE did not finish the job: two moves in
// the SAME event tie, Array.prototype.sort is stable, and the input is
// newest-first — so same-week history still replayed backwards. A manager who
// picked a player up and then flipped him for someone else in one week ended
// up holding BOTH of them:
//
//   3M Open: add J. Poston, drop A. Smalley   (happened first)
//   3M Open: add L. Glover,  drop J. Poston   (happened second)
//
// Replayed newest-first, the Glover move's drop hit a Poston who was not on
// the roster yet — a silent no-op — and the Poston move then added him right
// back. Net: Glover AND Poston, with Smalley correctly gone. A same-event
// add-then-flip is completely ordinary (it is one free-agent window), so this
// was not an edge case.
//
// The tiebreaker is `timestamp`, which every transaction written by
// AddDropPlayerModal / AddTransactionModal carries.
//
// Options:
//   asArray: true            — return an ordered array of player objects
//                              (hydrated from team.roster) instead of a Set.
//   upToTournamentIndex: n   — only replay transactions at or before
//                              tournament position n, i.e. "the roster as it
//                              stood for event n". Omit for the current roster.
//
// Returns a Set<string> of player names by default.

// When a transaction happened, in ms, or null if it carries nothing usable.
// `timestamp` is a Date.now() number on everything written since the field was
// introduced; older rows may hold an ISO string, and older ones still only a
// `date` (day resolution — good enough to order across days, useless within
// one, which is why it is the fallback and not the key).
//
// (This carried a "⚠ KEEP IN SYNC with api/cron.js" note when it lived in
// src/. cron.js imports it now, so there is nothing left to keep in sync.)
const txTimeMs = (tx) => {
  const t = tx?.timestamp;
  if (typeof t === 'number') return Number.isFinite(t) ? t : null;
  if (t) {
    const ms = new Date(t).getTime();
    if (Number.isFinite(ms)) return ms;
  }
  if (tx?.date) {
    const ms = new Date(tx.date).getTime();
    if (Number.isFinite(ms)) return ms;
  }
  return null;
};

export const buildEffectiveRoster = (team, transactions, opts = {}) => {
  if (!team) return opts.asArray ? [] : new Set();
  const { tournaments = [], upToTournamentIndex } = opts;
  const rosterSet = new Set((team.roster || []).map(p => p.name));

  (transactions || [])
    .filter(tx =>
      txBelongsToTeam(tx, team) &&
      tx.type !== 'mulligan' &&
      // swing_winner.player is the MANAGER's owner name, not a golfer —
      // replaying it would inject the manager's name into the roster set.
      // Mirrors the exclusion in the useRoster hook.
      tx.type !== 'swing_winner' &&
      (tx.status === 'processed' || tx.status === 'completed')
    )
    .map((tx, i) => ({ tx, i, pos: resolveTxTournamentIndex(tx, tournaments), ms: txTimeMs(tx) }))
    .filter(({ pos }) =>
      upToTournamentIndex === undefined || (pos !== undefined && pos <= upToTournamentIndex))
    // Chronological, oldest first:
    //   1. tournament position — transactions with no resolvable position sort
    //      last so a legacy row missing both name and index can't jump ahead
    //      of dated ones;
    //   2. timestamp — orders two moves made in the SAME event, which is what
    //      keeps an add-then-flip from resurrecting the flipped player;
    //   3. reversed input order — the last resort for rows carrying no
    //      chronological data at all. The input arrives newest-first from
    //      transactionsApi.getAll, so reversing it is the closest thing to
    //      oldest-first available. Undated rows predate the timestamp field,
    //      so they sort ahead of dated ones inside the same event.
    .sort((a, b) => {
      const pa = a.pos ?? Number.MAX_SAFE_INTEGER;
      const pb = b.pos ?? Number.MAX_SAFE_INTEGER;
      if (pa !== pb) return pa - pb;
      if (a.ms !== null && b.ms !== null) return (a.ms - b.ms) || (b.i - a.i);
      if (a.ms === null && b.ms !== null) return -1;
      if (a.ms !== null && b.ms === null) return 1;
      return b.i - a.i;
    })
    .forEach(({ tx }) => {
      if (tx.droppedPlayer) rosterSet.delete(tx.droppedPlayer);
      if (tx.player) rosterSet.add(tx.player);
    });

  if (opts.asArray) {
    return [...rosterSet].map(name => {
      const existing = (team.roster || []).find(p => p.name === name);
      return existing || { name };
    });
  }
  return rosterSet;
};
// ── Transaction → tournament resolution ─────────────────────────────────────
// Maps a transaction to the tournament it belongs to. Mirrors the resolution
// in mulliganReversal.js: prefer a live name lookup (so a schedule reorder
// can't misalign anything), then fall back to the stored legacy index for
// older rows that only carry tournamentIndex. Transactions carry the name in
// either `tournament` or `tournamentName` depending on when they were written,
// so both are checked.
export const resolveTxTournamentIndex = (tx, tournaments = []) => {
  if (!tx) return undefined;
  const name = tx.tournament ?? tx.tournamentName;
  if (name) {
    const idx = tournaments.findIndex(t => t && t.name === name);
    if (idx !== -1) return idx;
  }
  if (tx.tournamentIndex != null) return tx.tournamentIndex;
  return undefined;
};

// Same resolution, returning the tournament object (or null). Callers that
// need the tournament itself use this; those that need its array position use
// resolveTxTournamentIndex above.
export const resolveTxTournament = (tx, tournaments = []) => {
  const idx = resolveTxTournamentIndex(tx, tournaments);
  return idx == null ? null : (tournaments[idx] || null);
};
// ── Swing award ──────────────────────────────────────────────────────────────
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
export const computeSwingAward = ({ segment, allTournaments, transactions, teams, settings }) => {
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

  // Pot must be > 0.
  // `settings` is REQUIRED for the fee derivation to honor the commish's
  // configured feeWaiver/feeFA — omitting it (as this call used to) silently
  // fell back to the hard-coded 2/1 defaults, so the pot computed here could
  // disagree with the figure TransactionsView shows for the same swing.
  const pot = getSwingPot(transactions, allTournaments, segment, settings);
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
    // Stable key alongside the editable name — see txBelongsToTeam.
    teamId: winnerTeam.id || winnerTeam.name,
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

  // The pot is a SIDE PRIZE, tracked solely on the swing_winner transaction
  // (tx.amount). It is deliberately NOT added to team.earnings:
  //   • Standings derive from tournament.results.teams[].totalEarnings
  //     (getSeasonEarningsByTeam), so adding it there changes no display; and
  //   • team.earnings is the drift-prone denormalized tally that
  //     sharedHelpers explicitly warns against trusting — folding a fee pot
  //     into a field that otherwise holds tournament winnings makes it mean
  //     two different things.
  // The server path (maybeAutoAwardSwingServer in api/cron.js) has always
  // behaved this way; this client copy used to add the pot, so which number a
  // team ended up with depended on whether the cron or the commish's browser
  // awarded the swing. teams is returned unchanged so existing call sites
  // that persist `updatedTeams` stay valid.
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
  settings,
}) => {
  if (!justProcessedTournament) return null;
  const segment = getSegmentForTournament(justProcessedTournament);
  return computeSwingAward({ segment, allTournaments, transactions, teams, settings });
};
