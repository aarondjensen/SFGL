// api/_league.js — league domain constants + wall-clock helpers.
// ============================================================================
// SHARED BY BOTH DEPLOY TARGETS.
//
// The leading underscore tells Vercel not to treat this as a routable
// serverless function, so it doesn't count against the Hobby-plan function cap.
// It lives under api/ rather than src/ for the same reason api/_playerNames.js
// does: Vite can bundle a module from api/ into the browser build, but the
// serverless functions cannot import from src/ — they are deployed separately
// and src/ is never uploaded. api/ is therefore the only directory both sides
// can reach, which makes it the only place a genuinely shared module can live.
//
// Client imports it as:  import { SEASON } from '../../api/_playerNames.js'-style
//                        relative paths, e.g. '../../api/_league.js'
//
// Everything here is pure data or pure functions with no Firebase, no DOM and
// no Node built-ins, so it is safe in a browser bundle and in a Vercel function
// alike. Keep it that way — the moment this file imports firebase-admin it stops
// being importable from src/.
// ============================================================================

// ── Season ───────────────────────────────────────────────────────────────────
// The year the app is currently operating in. Previously hardcoded as a literal
// `2026` in eleven places across both deploy targets — five default parameters
// in tournamentResultsApi, a `new Date(2026, ...)` in getTournamentStartDate,
// two spots in api/cron.js, the results-fetch URL in TournamentResultsPanel, the
// loading splash, and the document title. Rolling the league to a new season
// meant finding all of them.
//
// NOTE this is deliberately a constant and not `new Date().getFullYear()`. The
// SFGL season is not the calendar year: the schedule runs into the autumn and
// the commish processes results, awards swings and reconciles rosters well past
// New Year. Deriving it from the clock would silently repoint every
// tournament_results document ID at 1 January, orphaning the season that is
// still being finished. Bump it deliberately, when the league is ready.
export const SEASON = 2026;

// ── Swings ───────────────────────────────────────────────────────────────────
// SFGL splits the year into four swings of three months each. This array is the
// canonical list and its ORDER is chronological — StandingsView relies on that
// to pick the most recent swing with results.
//
// Previously declared twice with identical contents (src/constants/index.js and
// src/theme.js), spelled out a third time as <option> literals in the
// TransactionsView filter, and encoded a fourth time as a month map in
// api/cron.js. Renaming a swing used to require finding all four.
export const SWINGS = [
  'West Coast Swing',
  'Spring Swing',
  'Summer Swing',
  'Fall Finish',
];

// Month (1-12) → swing. Derived from SWINGS so the two can't drift: months
// 1-3 are SWINGS[0], 4-6 are SWINGS[1], and so on.
//
// Returns null for anything outside 1-12, including the NaN an Invalid Date
// produces. The client's previous getSegmentByDate ended in an unconditional
// `return 'Fall Finish'`, so an unparseable tournament date was silently
// reported as a real swing rather than as "unknown" — null matches what
// getSegmentForTournament already returns when it can't tell, and every caller
// of that already handles it.
export const swingForMonth = (month) => {
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  return SWINGS[Math.floor((month - 1) / 3)];
};

// ── Days ─────────────────────────────────────────────────────────────────────
// Indexed to match JavaScript's Date.getDay() (0 = Sunday), which is also how
// the commish's configured waiver/results/reminder days are stored in settings.
// Previously three copies of the abbreviations (src/utils/index.js,
// src/utils/sharedHelpers.js, and an inline one in RostersView's waiver queue)
// plus a fourth inside a since-deleted TournamentsView helper.
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const DAY_ABBRS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ── Eastern Time wall clock ──────────────────────────────────────────────────
// Every deadline in SFGL is expressed in ET — lineup lock, the waiver cutoff,
// the free-agency window, results processing — so "what time is it in ET right
// now" is the single most load-bearing helper in the app.
//
// There used to be FOUR implementations across two algorithms:
//
//   Intl.formatToParts   src/utils/index.js        (getETNow)
//   toLocaleString+parse src/utils/sharedHelpers.js (getETDate)
//   toLocaleString+parse src/pages/RostersView.jsx  (inline, waiver queue)
//   toLocaleString+parse api/cron.js                (getETNow)
//
// The toLocaleString variant round-trips through a formatted string and re-parses
// it — `new Date(new Date().toLocaleString('en-US', { timeZone: ... }))`. That
// relies on Date's parser accepting whatever the runtime's ICU build produces
// for the en-US locale, which is not something the spec guarantees; on a runtime
// whose en-US format Date can't parse it yields Invalid Date, and every window
// check silently reads false. formatToParts asks for the fields directly and
// never round-trips through parsing, so it is the one kept here.
//
// This mattered beyond tidiness: the client evaluated waiver windows with the
// robust version while the cron that actually PROCESSES those waivers used the
// fragile one.

// Numeric ET field values for an instant (defaults to now).
export function getETParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    hour12: false,
  }).formatToParts(date);

  const get = (type) => parseInt(parts.find(p => p.type === type)?.value ?? '0', 10);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    // hour12:false yields 24 for midnight in some ICU versions — normalise.
    hour: get('hour') === 24 ? 0 : get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/**
 * The current ET wall clock, as a Date whose LOCAL fields read as Eastern Time.
 *
 * The returned Date does not represent the correct instant — it is a wall-clock
 * carrier. Read .getDay()/.getHours()/.getMinutes() off it and compare it
 * against other values built the same way (which is what every window check in
 * the app does). Do not use it for durations or serialise it.
 */
export function getETNow() {
  const p = getETParts();
  return new Date(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

/**
 * { day: 0-6, hour: 0-23, minute: 0-59, totalMinutes: 0-1439 } for now in ET.
 *
 * Derives the weekday from a single getETParts() read rather than calling
 * getETNow() for it separately — two Intl reads could straddle a midnight
 * boundary and report an hour from one day with the weekday of another.
 */
export function getETClock() {
  const { year, month, day, hour, minute } = getETParts();
  return {
    day: new Date(year, month - 1, day).getDay(),
    hour,
    minute,
    totalMinutes: hour * 60 + minute,
  };
}

// ── Waiver cutoff ────────────────────────────────────────────────────────────
// Fallbacks when league_settings carries no explicit cutoff: Tuesday 8:00 PM ET.
// Previously repeated as `?? 2` / `?? 20` / `?? 0` at every call site that read
// the cutoff — six of them across the client and the cron.
export const DEFAULT_WAIVER_CUTOFF = { day: 2, hour: 20, minute: 0 };

/** The configured cutoff as {day, hour, minute}, with defaults applied. */
export const waiverCutoff = (settings) => ({
  day: settings?.waiverDay ?? DEFAULT_WAIVER_CUTOFF.day,
  hour: settings?.waiverHour ?? DEFAULT_WAIVER_CUTOFF.hour,
  minute: settings?.waiverMinute ?? DEFAULT_WAIVER_CUTOFF.minute,
});

// ── Time formatting ──────────────────────────────────────────────────────────

/** fmtETTime(20, 0) → "8:00 PM" — used by the admin settings + waiver panels. */
export const fmtETTime = (hour, minute = 0) => {
  const hr = hour % 12 || 12;
  const ampm = hour < 12 ? 'AM' : 'PM';
  return `${hr}:${String(minute).padStart(2, '0')} ${ampm}`;
};

/**
 * The commish's configured waiver cutoff as a compact label — "Tue 8pm",
 * "Tue 8:30pm". Minutes are omitted when zero.
 *
 * Replaces three separate formatters that read the same three settings keys and
 * produced three different strings: a module-private fmtWaiverCutoff in
 * src/utils/index.js, an inline block in RostersView's waiver queue, and
 * fmtETTime spelled out by hand at each admin call site.
 */
export const fmtWaiverCutoff = (settings) => {
  const { day, hour, minute } = waiverCutoff(settings);
  const hr = hour % 12 || 12;
  const ampm = hour < 12 ? 'am' : 'pm';
  const min = minute > 0 ? `:${String(minute).padStart(2, '0')}` : '';
  return `${DAY_ABBRS[day]} ${hr}${min}${ampm}`;
};

// ── Transaction → team matching ──────────────────────────────────────────────
// Transactions identify their team by NAME (tx.team). Managers can rename their
// own team from the Account sheet, and before teamsApi.rename existed that cut
// a team loose from its entire history: roster replay stopped applying its
// add/drops, its fees dropped out of the swing pot, and its pending waiver
// claims vanished from the Rosters page AND from the cron that processes them.
//
// Every transaction written from here on also carries a stable `teamId`. This
// matcher prefers that id and falls back to the name, and the fallback is
// EXACTLY the comparison it replaced — so rows written before teamId existed
// behave identically. There is no migration to wait on and no half-migrated
// state.
//
// Lives here rather than in src/utils so api/cron.js can use the same rule as
// the client; its waiver processing does this match too.
export const txBelongsToTeam = (tx, team) => {
  if (!tx || !team) return false;
  const teamId = team.id || team.name;
  if (tx.teamId) return tx.teamId === teamId;
  return tx.team === team.name;
};

// The inverse: which team does this transaction belong to? Returns null when
// nothing matches (an orphan predating teamsApi.rename, or a deleted team).
export const resolveTxTeam = (tx, teams) =>
  (teams || []).find(t => txBelongsToTeam(tx, t)) || null;

// ── Name display ─────────────────────────────────────────────────────────────
/**
 * "Rory McIlroy" → "R. McIlroy". Single-word names pass through unchanged.
 *
 * Was implemented twice, byte-identically: abbreviateName in src/utils/index.js
 * and a local `displayName` in RostersView that took an isMobile flag. There is
 * also a third copy in api/cron.js's email builder, which now imports this.
 */
export const abbreviateName = (name) => {
  if (!name) return '';
  const parts = String(name).trim().split(/\s+/);
  if (parts.length < 2) return name;
  return `${parts[0][0]}. ${parts[parts.length - 1]}`;
};
