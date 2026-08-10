// src/utils/sharedHelpers.js
// ============================================================================
// SHARED HELPERS — single source of truth for utilities that were previously
// duplicated across views. Wave I cleanup.
//
// Replaces these duplicated implementations:
//   • normalizeNordic   — was in RostersView.jsx + a near-copy in api/field.js
//                         (api/field.js still has its own copy because it's a
//                          different deploy target)
//   • getETDate         — was hand-rolled with `etOffset = -4` in AdminView
//                          (broken for half the year due to DST)
//   • getSwingTournaments / getSwingEarningsByTeam
//                       — was inlined in StandingsView, ResultsView, and
//                         AdminView with subtle variations
//   • buildEffectiveRoster
//                       — was inlined 4 times across AddDropPlayerModal and
//                         AdminView
// ============================================================================

import { getSegmentForTournament } from './index.js';
import { nameKey } from '../../api/_playerNames.js';
import { txBelongsToTeam } from '../../api/_league.js';

// ── Name normalization ───────────────────────────────────────────────────────
// Delegates to nameKey() in api/_playerNames.js, the single source of truth.
//
// The old hand-rolled body folded diacritics and Nordic letters and turned
// hyphens into spaces, but did NOT lowercase and did NOT strip periods or
// apostrophes — so 'C.T. Pan' vs 'CT Pan' and "O'Toole" vs "OToole" were
// different keys, and api/field.js carried a near-copy that disagreed about
// which letters to fold. nameKey covers all of that, plus "Last, First" order,
// OWGR's "(Am)" qualifiers and Jr/III suffixes — and there is now exactly one
// copy of it across both deploy targets.
//
// ⚠ This is an EXACT-key normalizer. Comparing two normalizeNordic() values
// answers "are these the same string, modulo formatting?" — NOT "are these the
// same golfer?". It cannot see that 'Nico Echavarria' and 'Nicolas Echavarria'
// are one player, because that equivalence lives in the variant tiers, not in
// the key. For field membership, tee times, odds, live scores and earnings use
// NameSet / NameMap / namesMatch from api/_playerNames.js, which compare
// equivalence classes. Reaching for a bare key comparison in those places is
// precisely the bug this refactor fixed.
export const normalizeNordic = nameKey;

// ── ET timezone helpers ──────────────────────────────────────────────────────
// All re-exported from api/_league.js, the one module src/ and api/ can both
// import. This file used to own second implementations of getETDate and
// getETClock built on `new Date(new Date().toLocaleString('en-US', { timeZone
// }))` — a formatted-string round trip whose parseability the spec does not
// guarantee — while src/utils/index.js owned an Intl.formatToParts version of
// the same thing. Two algorithms, both live, answering "what time is it in ET"
// for different halves of the app; the cron used the fragile one to process the
// very waiver windows the client evaluated with the robust one.
//
// getETDate is kept as a name so existing call sites don't churn, but it is now
// the same function as getETNow.
export {
  getETNow,
  getETNow as getETDate,
  getETClock,
  fmtETTime,
  DAY_NAMES,
  DAY_ABBRS,
} from '../../api/_league.js';

// ── Backup lineup spot (optional 6th player) eligibility ─────────────────────
// The commish can enable the optional 6th "backup" lineup slot per event type
// via Season Settings. A backup is a player a manager designates in case one of
// their starters withdraws; the commish can promote them into the lineup.
//
// Defaults preserve the feature's launch behavior: Majors ON, Signature and
// Regular OFF. When `settings` is missing entirely, this still falls back to
// "Majors only" so any caller that hasn't been wired with settings yet does not
// regress.
//
// isMajor is checked first so a major that is also flagged signature is always
// treated as a major.
export const isBackupSpotEnabled = (tournament, settings) => {
  if (!tournament) return false;
  if (tournament.isMajor)     return settings?.backupSpotMajor     ?? true;
  if (tournament.isSignature) return settings?.backupSpotSignature ?? false;
  return settings?.backupSpotRegular ?? false;
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
// here doesn't break the award eligibility logic.
// ── Transaction → team matching ──────────────────────────────────────────────
// Transactions identify their team by NAME (tx.team). Managers can rename their
// own team, which used to sever a team from its entire transaction history —
// roster replay, fees, the swing pot and pending waivers all match on that
// string. teamsApi.rename now re-keys the existing rows, and every transaction
// written from here on also carries a stable `teamId`.
//
// This matcher prefers the id and falls back to the name. The fallback is
// EXACTLY the old comparison, so rows written before teamId existed behave
// identically — there is no migration to wait for and no half-migrated state.
//
// Pass the team object (it needs both id and name).
// Implementation lives in api/_league.js so api/cron.js — which does this same
// match when processing waivers — shares the rule rather than mirroring it.
// Imported as well as re-exported: `export ... from` forwards the binding
// without introducing it into this module's scope, and buildEffectiveRoster and
// the per-team fee helpers below call it directly.
export { txBelongsToTeam, resolveTxTeam } from '../../api/_league.js';

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
  const swingNames = new Set();
  const swingIndexes = new Set();
  (tournaments || []).forEach((t, i) => {
    if (getSegmentForTournament(t) === segment && !t.isAlternate) {
      if (t?.name) swingNames.add(t.name);
      swingIndexes.add(i);
    }
  });
  return (tx) => {
    if (tx.tournament) return swingNames.has(tx.tournament);
    if (tx.tournamentIndex !== undefined) return swingIndexes.has(tx.tournamentIndex);
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
// ⚠ KEEP IN SYNC with the same helper in api/cron.js (separate deploy target,
// can't import from src/).
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

// ── Durable player attributes ────────────────────────────────────────────────
// Module-level cache of the persisted player registry (sfgl_data/player-registry).
// useLeague populates it at load and refreshes it on every team save, so
// buildPlayerAttributeIndex can consult the durable single-source-of-truth
// WITHOUT threading the registry through every component. Client-only singleton.
let _playerRegistryCache = {};
export const setPlayerRegistry = (reg) => { _playerRegistryCache = reg || {}; };
export const getPlayerRegistry = () => _playerRegistryCache;

// A player's SFGL identity (limited/unlimited/stars/yearsOfService) and career
// tallies (starts/sfglEarnings/eventsPlayed/cutsMade/pgaTourEarnings) must
// survive a drop → re-add. They used to live ONLY on the roster-array entry, so
// dropping a player destroyed them and a re-add rebuilt them as a fresh,
// UNLIMITED player with zeroed stats. League rule: a limited player can never
// come back unlimited, and their data must be preserved.
//
// buildPlayerAttributeIndex assembles a durable name→attributes lookup from the
// two already-persisted sources:
//   1. current roster entries across every team (the fullest attributes), and
//   2. tournament results snapshots, which record `limited` for anyone who ever
//      started — so a currently-dropped limited player is still known limited.
// Merge rule: once limited, ALWAYS limited (no source can downgrade), and
// numeric tallies take the max so a stale zero can't wipe a real value.
export const buildPlayerAttributeIndex = (teams = [], tournaments = [], registry = _playerRegistryCache) => {
  const idx = {};
  const upsert = (name, attrs = {}) => {
    if (!name) return;
    const cur = idx[name] || {};
    const limited = !!(cur.limited || attrs.limited);
    idx[name] = {
      ...cur,
      ...attrs,
      limited,
      unlimited: limited ? false : !!(attrs.unlimited ?? cur.unlimited),
      stars:           Math.max(cur.stars ?? 0, attrs.stars ?? 0),
      yearsOfService:  Math.max(cur.yearsOfService ?? 0, attrs.yearsOfService ?? 0),
      starts:          Math.max(cur.starts ?? 0, attrs.starts ?? 0),
      eventsPlayed:    Math.max(cur.eventsPlayed ?? 0, attrs.eventsPlayed ?? 0),
      cutsMade:        Math.max(cur.cutsMade ?? 0, attrs.cutsMade ?? 0),
      pgaTourEarnings: Math.max(cur.pgaTourEarnings ?? 0, attrs.pgaTourEarnings ?? 0),
      sfglEarnings:    Math.max(cur.sfglEarnings ?? 0, attrs.sfglEarnings ?? 0),
      headshot: attrs.headshot || cur.headshot || '',
    };
  };
  // Durable registry first (lowest precedence — a player who has vanished from
  // every current roster and from results history is still recovered here).
  Object.entries(registry || {}).forEach(([name, a]) => upsert(name, a));
  // Then current rosters (fullest live attributes) and results history.
  (teams || []).forEach(t => (t.roster || []).forEach(p => upsert(p.name, p)));
  (tournaments || []).forEach(t => {
    const teamsRes = t?.results?.teams;
    if (!teamsRes) return;
    Object.values(teamsRes).forEach(tr =>
      (tr.players || []).forEach(pl => upsert(pl.name || pl, { limited: !!pl.limited })));
  });
  return idx;
};

// Build a complete roster-entry for `name`, hydrated from the durable index.
// Unknown players (genuinely new to the league) get safe unlimited defaults.
export const hydratePlayer = (name, attrIndex = {}, headshot = '') => {
  const a = attrIndex[name] || {};
  const limited = !!a.limited;
  return {
    name,
    limited,
    unlimited: limited ? false : !!a.unlimited,
    stars:           a.stars ?? 0,
    yearsOfService:  a.yearsOfService ?? 1,
    starts:          a.starts ?? 0,
    eventsPlayed:    a.eventsPlayed ?? 0,
    cutsMade:        a.cutsMade ?? 0,
    pgaTourEarnings: a.pgaTourEarnings ?? 0,
    sfglEarnings:    a.sfglEarnings ?? 0,
    headshot: headshot || a.headshot || '',
  };
};

// Returns a Map<playerName, teamName> showing which team currently owns each
// rostered player across the entire league. Used by AddDropPlayerModal to
// label players as "Unavailable / on Team X" without re-running the same
// roster-rebuild logic.
export const buildOwnershipMap = (teams, transactions, tournaments = []) => {
  const map = new Map();
  (teams || []).forEach(t => {
    buildEffectiveRoster(t, transactions, { tournaments }).forEach(name => map.set(name, t.name));
  });
  return map;
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
