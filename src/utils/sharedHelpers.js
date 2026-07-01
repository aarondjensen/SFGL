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

// ── Name normalization (Nordic + diacritics + hyphens) ───────────────────────
// Normalizes Nordic and other diacritics, plus hyphens and whitespace, so
// roster names match field/leaderboard names regardless of source format.
//   • Diacritics: NFD decompose + strip combining marks (Höjgaard → Hojgaard)
//   • Nordic special letters: ø/Ø → o/O, æ/Æ → ae/Ae, ß → ss
//   • Hyphens to spaces ("Si-Woo Kim" → "Si Woo Kim")
//   • Collapse whitespace so the hyphen→space replacement doesn't leave
//     double spaces.
//
// IMPORTANT: api/field.js has its own copy of this function (different deploy
// target). When you change this, mirror the changes there.
export const normalizeNordic = (s) => (s || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/ø/g, 'o').replace(/Ø/g, 'O')
  .replace(/æ/g, 'ae').replace(/Æ/g, 'Ae')
  .replace(/ß/g, 'ss')
  .replace(/-/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// ── ET timezone helpers ──────────────────────────────────────────────────────
// Returns a Date object set to the current Eastern Time wall clock.
// Uses the Intl API so it correctly handles DST (EST=-5, EDT=-4) automatically.
// The previous hand-rolled `etOffset = -4` math was wrong for ~half the year.
export const getETDate = () => {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
};

// Returns { day: 0-6, hour: 0-23, minute: 0-59, totalMinutes: 0-1439 } for now in ET.
export const getETClock = () => {
  const et = getETDate();
  const day = et.getDay();
  const hour = et.getHours();
  const minute = et.getMinutes();
  return { day, hour, minute, totalMinutes: hour * 60 + minute };
};

// Format a 24h hour + minute as "h:mm AM/PM" — e.g. fmtETTime(20, 0) → "8:00 PM"
export const fmtETTime = (hour, minute = 0) => {
  const hr = hour % 12 || 12;
  const ampm = hour < 12 ? 'AM' : 'PM';
  const min = String(minute).padStart(2, '0');
  return `${hr}:${min} ${ampm}`;
};

export const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
export const DAY_ABBRS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

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
export const getSwingPot = (transactions, tournaments, segment, settings) => {
  if (!segment) return 0;
  // Build the set of swing tournament indexes — all in-segment events,
  // regardless of completion. Exclude alternates to match the
  // computeSwingAward gate (alternate-tournament fees are tracked
  // separately in the season-level totals but not in the swing pot).
  // Build BOTH a name set and an index set for in-segment, non-alternate
  // events. New transactions carry a stable `tournament` name (reorder-proof);
  // legacy ones only have a positional `tournamentIndex`, so match by name when
  // present and fall back to the index otherwise.
  const swingNames = new Set();
  const swingIndexes = new Set();
  (tournaments || []).forEach((t, i) => {
    if (getSegmentForTournament(t) === segment && !t.isAlternate) {
      if (t?.name) swingNames.add(t.name);
      swingIndexes.add(i);
    }
  });
  const inSwing = (tx) => {
    if (tx.tournament) return swingNames.has(tx.tournament);
    if (tx.tournamentIndex !== undefined) return swingIndexes.has(tx.tournamentIndex);
    return tx.segment === segment;
  };
  // Effective fee: trust a stored fee when present (preserves any custom
  // amount), else derive from type — recovers legacy rows saved with fee 0 by
  // the old FA type-string mismatch so they count toward the pot.
  const effFee = (tx) => {
    const stored = tx.fee || 0;
    return stored > 0 ? stored : getTransactionFee(tx.type, settings, tx.status);
  };
  return (transactions || [])
    .filter(tx => {
      if (tx.status === 'failed') return false;
      if (tx.type === 'swing_winner') return false;
      if (effFee(tx) <= 0) return false;
      return inSwing(tx);
    })
    .reduce((sum, tx) => sum + effFee(tx), 0);
};

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
// Returns a Set<string> of player names. Pass `asArray: true` to get an
// ordered array of {name} player objects instead.
export const buildEffectiveRoster = (team, transactions, opts = {}) => {
  if (!team) return opts.asArray ? [] : new Set();
  const rosterSet = new Set((team.roster || []).map(p => p.name));
  (transactions || [])
    .filter(tx =>
      tx.team === team.name &&
      tx.type !== 'mulligan' &&
      // swing_winner.player is the MANAGER's owner name, not a golfer —
      // replaying it would inject the manager's name into the roster set.
      // Mirrors the exclusion in the useRoster hook.
      tx.type !== 'swing_winner' &&
      (tx.status === 'processed' || tx.status === 'completed')
    )
    .forEach(tx => {
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
export const buildOwnershipMap = (teams, transactions) => {
  const map = new Map();
  (teams || []).forEach(t => {
    buildEffectiveRoster(t, transactions).forEach(name => map.set(name, t.name));
  });
  return map;
};
