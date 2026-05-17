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

// Returns the leader of a swing as { teamId, earnings } | null
export const getSwingLeader = (tournaments, segment) => {
  const byTeam = getSwingEarningsByTeam(tournaments, segment);
  const top = Object.entries(byTeam).sort((a, b) => b[1] - a[1])[0];
  return top ? { teamId: top[0], earnings: top[1] } : null;
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
export const getSwingPot = (transactions, tournaments, segment) => {
  if (!segment) return 0;
  // Build the set of swing tournament indexes — all in-segment events,
  // regardless of completion. Exclude alternates to match the
  // computeSwingAward gate (alternate-tournament fees are tracked
  // separately in the season-level totals but not in the swing pot).
  const swingIndexes = new Set(
    (tournaments || [])
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => getSegmentForTournament(t) === segment && !t.isAlternate)
      .map(({ i }) => i)
  );
  return (transactions || [])
    .filter(tx => {
      if ((tx.fee || 0) <= 0) return false;
      if (tx.status === 'failed') return false;
      if (tx.type === 'swing_winner') return false;
      return tx.tournamentIndex !== undefined
        ? swingIndexes.has(tx.tournamentIndex)
        : tx.segment === segment;
    })
    .reduce((sum, tx) => sum + tx.fee, 0);
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
