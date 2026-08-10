// src/utils/sharedHelpers.js
// ============================================================================
// CLIENT-SIDE SHARED HELPERS.
//
// What is left here is the part of the app's shared logic that is genuinely
// browser-only: the player-registry singleton and the attribute index built on
// top of it. Everything else this file used to own has moved to a module both
// deploy targets can import, and is re-exported below so no call site changed:
//
//   api/_league.js  constants + the ET wall clock + transaction→team matching
//   api/_rules.js   league rules — segments, fees, the pot, roster replay,
//                   the swing award
//
// Prefer importing from here; the re-exports keep this file the one place a
// view needs to reach for.
// ============================================================================

import { nameKey } from '../../api/_playerNames.js';
// Imported as well as re-exported below: `export ... from` forwards a binding
// without introducing it into this module's scope, and buildOwnershipMap calls it.
import { buildEffectiveRoster } from '../../api/_rules.js';

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

// ── League rules ─────────────────────────────────────────────────────────────
// Moved to api/_rules.js so api/cron.js runs the SAME code rather than its own
// mirror of it. The cron used to carry hand-copied versions of the swing
// helpers, the fee resolver, the pot calculation, the effective-roster replay
// and the swing award, each under a "⚠ KEEP IN SYNC" comment — and each had
// drifted at least once. Re-exported here so existing import sites are
// unchanged.
export {
  BONUSES_REGULAR, BONUSES_MAJOR, bonusesFor,
  getSegmentByDate, getSegmentForTournament,
  getSwingTournaments, getSwingEarningsByTeam, getSeasonEarningsByTeam, getSwingLeader,
  getTransactionFee, effectiveTransactionFee, makeSwingMembership,
  getSwingFeesByTeam, getSwingFeesForTeam, getSeasonFeesByTeam, getSeasonFeesForTeam,
  getSwingPot,
  buildEffectiveRoster,
  resolveTxTournamentIndex, resolveTxTournament,
} from '../../api/_rules.js';

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

// ── Transaction → team matching ──────────────────────────────────────────────
// Implementation in api/_league.js; see the note there. Re-exported so call
// sites can keep importing it from this module alongside everything else.
export { txBelongsToTeam, resolveTxTeam } from '../../api/_league.js';


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

