// Explicit /index.js rather than the bare directory: Vite resolves both, but
// Node's ESM loader does not do directory resolution, and that difference was
// enough to make this whole module chain — utils, sharedHelpers, and every
// piece of league math in it — impossible to import from a test script.
import { TEAM_ABBREVIATIONS } from '../constants/index.js';
import { nameKey } from '../../api/_playerNames.js';
import {
  getETNow as _getETNow,
  fmtWaiverCutoff,
  waiverCutoff,
  abbreviateName as _abbreviateName,
} from '../../api/_league.js';

// ============================================================================
// PLAYER / NAME UTILITIES
// ============================================================================
export const makePlayer = (name, limited = false, stars = 0, unlimited = false, yearsOfService = 1) => ({
  name,
  limited,
  stars: limited ? (stars || 1) : 0,
  unlimited,
  yearsOfService,
  starts: 0,
  eventsPlayed: 0,
  cutsMade: 0,
  pgaTourEarnings: 0,
  sfglEarnings: 0,
  headshot: '',
});

/**
 * Normalize a player name to its match key.
 *
 * Delegates to nameKey() in api/_playerNames.js — the single source of truth.
 * The previous hand-rolled body lowercased, folded a hand-listed CHAR_MAP of
 * accents, and turned `.` and `-` into spaces. nameKey does all of that plus
 * the cases this one missed: æ/ø/ł/ð folding, apostrophes, "Last, First"
 * order, OWGR's "(Am)" qualifiers, and Jr/III suffixes.
 *
 * ⚠ For "are these the same golfer?", prefer namesMatch / NameSet from
 * api/_playerNames.js. Comparing two nameKey() values is an EXACT-key test —
 * it cannot see that 'Nico Echavarria' and 'Nicolas Echavarria' are one
 * player, because that equivalence lives in the variant tiers, not the key.
 * Key equality is fine for deduping and for map lookups you built yourself.
 */
export const normalizePlayerName = nameKey;

// REMOVED: resolvePlayerName — an OWGR-name → roster-name resolver with zero
// call sites in the codebase. It was the only consumer of the contradictory
// PLAYER_NAME_ALIASES table (see the note in src/constants/index.js), and its
// last-name + first-initial fallback is the kind of fuzzy guess that pairs
// 'Alex Fitzpatrick' with 'Matt Fitzpatrick'.
//
// Use NameSet from api/_playerNames.js to resolve a name against a known list:
//   new NameSet(knownNames).resolve(owgrName)   // → matched name, or null
// It applies the same alias/nickname/initials equivalence used everywhere
// else, and returns null on ambiguity rather than picking a candidate.

export const shortName = (fullName) => {
  if (!fullName) return '';
  const parts = fullName.split(' ');
  return parts[parts.length - 1];
};

/**
 * "First Last" → "F. Last"
 * Used by TransactionsView and RostersView (mobile) to abbreviate player names.
 * Single-word names are returned unchanged.
 *
 * Implementation lives in api/_league.js so the cron's email builder can share
 * it; RostersView also carried a byte-identical private copy called
 * `displayName`, now gone.
 */
export const abbreviateName = _abbreviateName;

export const getSortedRoster = (roster) => {
  const limited   = roster.filter(p => p.limited);
  const unlimited = roster.filter(p => !p.limited);
  return [...limited, ...unlimited];
};

// ============================================================================
// TEAM UTILITIES
// ============================================================================
// ── Team abbreviations ───────────────────────────────────────────────────────
// Every call site has a team NAME to hand, not an id — TeamName renders from a
// name, the ownership map is keyed by name, the transactions table stores one.
// Threading ids through all of them to look up an abbreviation would be a large
// change for a display string.
//
// So the teams array is registered once (useLeague does it on every teams
// update) and the lookup resolves name -> team -> abbreviation. Same singleton
// pattern as setPlayerRegistry in sharedHelpers.js, and for the same reason.
//
// The point is that the ANSWER no longer depends on the name: it comes from
// `team.abbr` on the document, or from the id-keyed seed table. A rename
// carries the abbreviation with it instead of dropping it.
let _teamRegistry = [];
export const setTeamRegistry = (teams) => { _teamRegistry = Array.isArray(teams) ? teams : []; };
export const getTeamRegistry = () => _teamRegistry;

// Initials of the name, for a team that has no abbreviation from either source.
const initialsOf = (teamName) =>
  String(teamName || '').split(/\s+/).filter(Boolean)
    .map(w => w[0]).join('').slice(0, 3).toUpperCase();

/**
 * Display abbreviation for a team, given its name (or the team object).
 *
 * Resolution order:
 *   1. `team.abbr` — what the manager set
 *   2. TEAM_ABBREVIATIONS[team.id] — the seed, for teams that never set one
 *   3. initials of the current name
 */
export const getTeamAbbreviation = (teamOrName) => {
  const isObject = teamOrName && typeof teamOrName === 'object';
  const name = isObject ? teamOrName.name : teamOrName;
  const team = isObject
    ? teamOrName
    : _teamRegistry.find(t => t?.name === name);

  const abbr = team?.abbr?.trim();
  if (abbr) return abbr;
  if (team?.id && TEAM_ABBREVIATIONS[team.id]) return TEAM_ABBREVIATIONS[team.id];
  return initialsOf(name);
};

// JS counterpart to the .sfgl-team-full/.sfgl-team-abbr CSS swap, for places
// CSS can't reach the text — native <select><option> labels. Non-reactive
// (read at render); fine for the commissioner-only desktop surfaces that use
// it. Keep the 360px breakpoint in sync with app-global.css.
export const compactTeamName = (name) =>
  (typeof window !== 'undefined' && window.matchMedia('(max-width: 360px)').matches)
    ? getTeamAbbreviation(name)
    : name;

// ============================================================================
// DATE / TIME (ET-aware)
// ============================================================================

/**
 * Returns the current wall-clock time expressed as a Date object whose
 * year/month/day/hour/minute fields reflect Eastern Time (handles DST).
 *
 * Re-exported from api/_league.js, which is now the only implementation. There
 * were four: this one (Intl.formatToParts) plus three that round-tripped
 * through `new Date(new Date().toLocaleString('en-US', { timeZone }))` — in
 * sharedHelpers, inline in RostersView, and in api/cron.js. See the note in
 * _league.js for why the parsing variant is the one that had to go.
 */
export const getETNow = _getETNow;

// ── Segment resolution ───────────────────────────────────────────────────────
// Moved to api/_rules.js so api/cron.js runs this code rather than its own
// getSegmentForTournamentServer, which had at one point mapped Jan-Mar to
// 'Spring Swing' and Aug-Sep to a 'Fall Swing' that exists nowhere else in the
// codebase. Re-exported so existing importers are unchanged.
export { getSegmentByDate, getSegmentForTournament, segmentSource, seedSegments } from '../../api/_rules.js';

// ============================================================================
// TOURNAMENT TIMEZONE / LOCK LOGIC
// ============================================================================
// Moved to api/_league.js for the same reason as the segment helpers above:
// api/cron.js cannot import from src/, so while this lived here the cron had no
// way to share it. It didn't copy the logic — it invented a field name,
// `activeTourney.lockHourET`, that nothing in the app has ever written. The
// lineup-lock reminder therefore told every manager "7am" regardless of the
// real lock, which is two hours early for a California event and five for
// Hawaii. Re-exported so existing importers are unchanged.
// Imported as well as re-exported: `export ... from` forwards the binding
// without introducing it into this module's scope, and isTournamentLocked /
// getRoundLockTime below call it directly.
import {
  getTournamentLockHourET, getTeeTimeLockMs, getTournamentStartDate,
} from '../../api/_league.js';
export {
  getTournamentTimezone, getTournamentLockHourET, getTeeTimeLockMs,
  // Moved for api/cron.js's benefit — the results cron had no way to ask
  // whether an event had been played, and scored one that had not. Re-exported
  // so every existing importer here is unchanged.
  getTournamentStartDate, resolveTournamentStart, tournamentWeekEnd, isTournamentWeekOver,
} from '../../api/_league.js';

/**
 * Locks at the published first tee time when one is known, otherwise at the
 * timezone-derived hour on Thursday.
 *
 * The tee-time branch compares ABSOLUTE instants. The fallback below works in
 * getETNow()'s shifted wall-clock space, where a Date's local fields spell out
 * ET — fine for "Thursday at 9", but the wrong frame for an instant that
 * already carries a UTC offset. Mixing the two would shift the lock by the
 * runtime's offset from ET.
 */
export const isTournamentLocked = (tournament) => {
  if (!tournament) return false;

  const teeMs = getTeeTimeLockMs(tournament);
  if (teeMs !== null) return Date.now() >= teeMs;

  const et       = getETNow();
  const startDate = getTournamentStartDate(tournament);
  if (!startDate) return false;

  // Find the Thursday of the tournament week
  let thursday = new Date(startDate);
  while (thursday.getDay() !== 4) thursday.setDate(thursday.getDate() + 1);

  const lockHour = getTournamentLockHourET(tournament);
  const lockTime = new Date(thursday);
  lockTime.setHours(lockHour, 0, 0, 0);
  return et >= lockTime;
};

export const isLineupEditingOpen = (tournament) => {
  if (isTournamentLocked(tournament)) return false;
  const et      = getETNow();
  const day     = et.getDay();
  const timeVal = et.getHours() * 60 + et.getMinutes();
  // Sun 9pm ET through Thursday lock
  if (day === 0 && timeVal >= 21 * 60) return true;
  if (day >= 1 && day <= 4) return true;
  return false;
};

export const isFreeAgentWindowOpen = (tournament, settings) => {
  if (!tournament) return false;
  // Wave 7: also coordinate with tournament lock — once first-tee Thursday
  // arrives, FA closes regardless of day-of-week math below.
  if (isTournamentLocked(tournament)) return false;

  // Free agency opens after waiver cutoff (when waiver period ends) through Thursday lock
  const { day: wDay, hour: wHour, minute: wMin } = waiverCutoff(settings);
  const cutoff = wDay * 24 * 60 + wHour * 60 + wMin;
  const et      = getETNow();
  const day     = et.getDay();
  const timeVal = et.getHours() * 60 + et.getMinutes();
  const nowVal  = day * 24 * 60 + timeVal;
  // Open from waiver cutoff through Thursday lock
  // Must be past the cutoff and before tournament locks (Thu)
  if (day === 4 || day === 3) return true;
  if (day === wDay && timeVal >= wHour * 60 + wMin) return true;
  // If waiver day is before Wed and we're between cutoff and Thu
  if (nowVal >= cutoff && day < 4) return true;
  return false;
};

export const isWaiverWindowOpen = (tournament, settings) => {
  if (!tournament) return false;
  // Waiver window: tournament start through configurable cutoff (default Tue 8pm ET)
  const { day: wDay, hour: wHour, minute: wMin } = waiverCutoff(settings);
  const et      = getETNow();
  const day     = et.getDay();
  const timeVal = et.getHours() * 60 + et.getMinutes();
  // Before waiver cutoff day: open on Thu(4), Fri(5), Sat(6), Sun(0), Mon(1), and any day before cutoff day
  // On waiver cutoff day: open only before the cutoff time
  // After cutoff through Wed: closed (free agency takes over)
  if (day === wDay) return timeVal < wHour * 60 + wMin;
  // Days after cutoff but before Thursday are closed
  // We need to check if current day is between cutoff day and Thu
  // Thu(4) Fri(5) Sat(6) Sun(0) Mon(1) are always open (tournament active, before cutoff)
  if (day >= 4) return true; // Thu, Fri, Sat
  if (day === 0 || day === 1) return true; // Sun, Mon
  // Day 2 (Tue) or 3 (Wed): only open if before the cutoff
  if (day < wDay) return true;
  return false;
};

/** Returns true if the round-start cut-off has passed for a given round number.
 *  NOTE: anchored to the actual tournament Thursday, not raw day-of-week,
 *  so it handles weather-delay scenarios correctly. */
export const isPastRoundStart = (tournament, roundNum) => {
  if (!tournament) return false;
  const startDate = getTournamentStartDate(tournament);
  if (!startDate) return false;

  // Find Thursday
  let thursday = new Date(startDate);
  while (thursday.getDay() !== 4) thursday.setDate(thursday.getDate() + 1);

  const lockHour = getTournamentLockHourET(tournament);
  const roundDate = new Date(thursday);
  // R1=Thu, R2=Fri, R3=Sat, R4=Sun
  roundDate.setDate(roundDate.getDate() + (roundNum - 1));
  roundDate.setHours(lockHour, 0, 0, 0);

  return getETNow() >= roundDate;
};

// ============================================================================
// CURRENT TOURNAMENT — date-based "which tournament are we in this week"
// ============================================================================
// Wave C.5 consolidation. Replaces THREE separate implementations: RostersView's
// `getAddDropTournamentIndex` and two inline copies in TransactionsView (the
// option list and the type-change handler). Each previous implementation
// parsed `tournament.dates` itself with slightly different regex/window math
// — RostersView used a Sun–Sat week; TransactionsView used a 14-day window.
// We standardize on the Sun–Sat week here because that's the natural
// "tournament week" boundary; the 14-day window only differed at edges and
// both fell through to the same `next non-completed` fallback.
//
// Returns the tournament index whose Sun–Sat week contains `now`. If none
// match, falls back to the next non-completed tournament, and finally to the
// last tournament. Returns -1 only if the array is empty.
export const getCurrentTournamentIndex = (tournaments, refDate = null) => {
  if (!tournaments?.length) return -1;
  const now = refDate || getETNow();

  let best = -1;
  let bestDist = Infinity;
  tournaments.forEach((t, i) => {
    const start = getTournamentStartDate(t);
    if (!start) return;
    // Sun-Sat week containing the tournament's start
    const sun = new Date(start);
    sun.setDate(sun.getDate() - sun.getDay()); // back to Sunday
    sun.setHours(0, 0, 0, 0);
    const sat = new Date(sun);
    sat.setDate(sat.getDate() + 6);
    sat.setHours(23, 59, 59, 999);
    if (now >= sun && now <= sat) {
      const dist = Math.abs(now - start);
      if (dist < bestDist) { best = i; bestDist = dist; }
    }
  });
  if (best >= 0) return best;

  // Fallback: next non-completed tournament
  const upcomingIdx = tournaments.findIndex(t => !t.completed);
  if (upcomingIdx >= 0) return upcomingIdx;

  // Final fallback: last tournament
  return Math.max(0, tournaments.length - 1);
};

// ============================================================================
// STATUS LABELS
// ============================================================================
const lockStr = (hour) =>
  hour > 12 ? `${hour - 12}pm` : hour === 12 ? '12pm' : `${hour}am`;

export const getLineupStatus = (tournament) => {
  if (!tournament)                     return { open: false, label: '🔴 No active tournament' };
  if (isTournamentLocked(tournament))  return { open: false, label: '🔴 Locked' };
  if (isLineupEditingOpen(tournament)) {
    const h = getTournamentLockHourET(tournament);
    return { open: true, label: `🟢 until Thu ${lockStr(h)} ET` };
  }
  return { open: false, label: '🔴 until Sun 9pm ET' };
};

export const getFreeAgentWindowStatus = (tournament, settings) => {
  if (isFreeAgentWindowOpen(tournament, settings)) {
    const h = getTournamentLockHourET(tournament);
    return { open: true, label: `Open until Thu ${lockStr(h)} ET` };
  }
  if (isWaiverWindowOpen(tournament, settings)) return { open: false, label: `Opens after waivers · ${fmtWaiverCutoff(settings)} ET` };
  if (isTournamentLocked(tournament)) return { open: false, label: 'Locked' };
  return { open: false, label: 'Opens after waivers processed' };
};

export const getWaiverWindowStatus = (tournament, settings) =>
  isWaiverWindowOpen(tournament, settings)
    ? { open: true,  label: `Open — closes ${fmtWaiverCutoff(settings)} ET` }
    : { open: false, label: 'Closed' };

// Wave C.5: removed the API FETCH section (slashGolfFetch + fetchFirstTeeTime).
// Both were dead code — slashGolfFetch was only used by the deleted
// ScheduleImportModal (Wave B) and by fetchFirstTeeTime, which itself was
// never called from App.jsx. The `firstTeeTime` prop that RostersView and
// TournamentsView destructure was always undefined in production.
//
// If you ever need first-tee-time data again, source it from /api/field
// (which already returns teeTimes for the current week's tournament) rather
// than reintroducing the RapidAPI dependency.

