import { CHAR_MAP, PLAYER_NAME_ALIASES, PGA_TOUR_IDS, TEAM_ABBREVIATIONS, BONUSES_REGULAR, BONUSES_MAJOR, SWINGS } from '../constants';

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

export const normalizePlayerName = (name) => {
  if (!name) return '';
  let normalized = name.toLowerCase().trim();
  Object.keys(CHAR_MAP).forEach(char => {
    normalized = normalized.replace(new RegExp(char, 'g'), CHAR_MAP[char]);
  });
  return normalized.replace(/[.-]/g, ' ').replace(/\s+/g, ' ').trim();
};

export const resolvePlayerName = (owgrName, knownNames) => {
  if (!owgrName) return null;
  const lower = owgrName.toLowerCase().trim();
  if (PLAYER_NAME_ALIASES[lower]) return PLAYER_NAME_ALIASES[lower];

  const exact = knownNames.find(n => n.toLowerCase() === lower);
  if (exact) return exact;

  const normOwgr = normalizePlayerName(owgrName);
  const normMatch = knownNames.find(n => normalizePlayerName(n) === normOwgr);
  if (normMatch) return normMatch;

  // Last-name + first-initial fuzzy match — only if unique to avoid false positives
  const parts = lower.split(/\s+/);
  if (parts.length >= 2) {
    const lastName    = parts[parts.length - 1];
    const firstInitial = parts[0][0];
    const candidates = knownNames.filter(n => {
      const np = n.toLowerCase().split(/\s+/);
      return np[np.length - 1] === lastName && np[0][0] === firstInitial;
    });
    if (candidates.length === 1) return candidates[0];
    // Multiple matches → ambiguous, don't guess
  }
  return null;
};

export const shortName = (fullName) => {
  if (!fullName) return '';
  const parts = fullName.split(' ');
  return parts[parts.length - 1];
};

/**
 * "First Last" → "F. Last"
 * Used by TransactionsView and RostersView (mobile) to abbreviate player names.
 * Single-word names are returned unchanged.
 */
export const abbreviateName = (name) => {
  if (!name) return '';
  const parts = name.trim().split(' ');
  if (parts.length < 2) return name;
  return parts[0][0] + '. ' + parts[parts.length - 1];
};

export const getSortedRoster = (roster) => {
  const limited   = roster.filter(p => p.limited);
  const unlimited = roster.filter(p => !p.limited);
  return [...limited, ...unlimited];
};

// ============================================================================
// HEADSHOTS
// ============================================================================
// All headshots use ESPN CDN with ESPN athlete IDs.
// IDs come from three sources (checked in order):
//   1. headshotMap (database — set via AdminView Auto-Fetch or manual entry)
//   2. PGA_TOUR_IDS constant (static fallback for common tour regulars)
//   3. ui-avatars.com initials avatar (final fallback — always works)
//
// ESPN headshot URL: https://a.espncdn.com/i/headshots/golf/players/full/{espnId}.png
// Note: PGA_TOUR_IDS values are ESPN athlete IDs despite the constant name.

const ESPN_HEADSHOT_BASE = 'https://a.espncdn.com/i/headshots/golf/players/full';

// Returns an ordered array of URLs to try for a player.
export const getPlayerHeadshotUrls = (playerName, headshotMap = {}) => {
  const urls = [];
  // 1. Database value (may be a full URL override or an ESPN ID)
  const dbVal = headshotMap?.[playerName];
  if (dbVal) {
    if (typeof dbVal === 'string' && (dbVal.startsWith('http') || dbVal.startsWith('/'))) {
      urls.push(dbVal);
    } else {
      urls.push(`${ESPN_HEADSHOT_BASE}/${dbVal}.png`);
    }
  }
  // 2. Static constant fallback
  const staticId = PGA_TOUR_IDS[playerName];
  if (staticId && staticId !== dbVal) {
    urls.push(`${ESPN_HEADSHOT_BASE}/${staticId}.png`);
  }
  return urls;
};

export const getPlayerHeadshotFallback = (playerName, isLimited = false) => {
  const bg = isLimited ? '8B6914' : '1c3a5e';
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(playerName)}&background=${bg}&color=ffffff&size=96&bold=true&font-size=0.38`;
};

export const getPlayerHeadshot = (playerName, isLimited = false, headshotMap = {}) => {
  const urls = getPlayerHeadshotUrls(playerName, headshotMap);
  return urls.length > 0 ? urls[0] : getPlayerHeadshotFallback(playerName, isLimited);
};

// Returns an onError handler that walks through all fallback URLs before
// settling on the initials avatar. Use as: onError={makeHeadshotErrorHandler(...)}
export const makeHeadshotErrorHandler = (playerName, isLimited = false, headshotMap = {}) => {
  const urls = getPlayerHeadshotUrls(playerName, headshotMap);
  let attempt = 0;
  return function handler(e) {
    attempt++;
    if (attempt < urls.length) {
      e.target.src = urls[attempt];
      e.target.onerror = handler;
    } else {
      e.target.onerror = null;
      e.target.src = getPlayerHeadshotFallback(playerName, isLimited);
    }
  };
};

// ============================================================================
// TEAM UTILITIES
// ============================================================================
export const getTeamAbbreviation = (teamName) =>
  TEAM_ABBREVIATIONS[teamName] ||
  teamName.split(' ').map(w => w[0]).join('').slice(0, 3).toUpperCase();

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
 * Uses Intl.DateTimeFormat formatToParts for reliability across environments.
 */
export const getETNow = () => {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    hour12: false,
  }).formatToParts(now);

  const get = (type) => parseInt(parts.find(p => p.type === type)?.value ?? '0', 10);
  // hour12:false can return 24 for midnight — normalise
  const hour = get('hour') === 24 ? 0 : get('hour');

  return new Date(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
};

// ============================================================================
// SEGMENT — CANONICAL 4-SWING MAPPING (Wave 7)
// ============================================================================
// SFGL uses 4 swings, evenly distributed across the year:
//   West Coast Swing  Jan – Mar
//   Spring Swing      Apr – Jun
//   Summer Swing      Jul – Sep
//   Fall Finish       Oct – Dec
//
// Previously this codebase had SIX competing month-to-segment helpers that
// disagreed about whether May was "Florida Swing" or "Spring Swing" and about
// whether SWINGS was a 4-element or 5-element array. This is now the single
// source of truth — all consumers (AdminView, StandingsView, ResultsView,
// TransactionsView, App.jsx, etc.) import getSegmentByDate / getSegmentForTournament
// from here.
// ============================================================================

/**
 * Returns the segment name for a given date (defaults to today).
 * Accepts an optional Date object so callers like StandingsView can
 * resolve the segment for a specific tournament start date rather than
 * relying on the current wall-clock month.
 */
export const getSegmentByDate = (date) => {
  const month = (date || new Date()).getMonth() + 1;
  if (month >= 1  && month <= 3)  return 'West Coast Swing';
  if (month >= 4  && month <= 6)  return 'Spring Swing';
  if (month >= 7  && month <= 9)  return 'Summer Swing';
  return 'Fall Finish';
};

/**
 * Returns the segment for a tournament. Honors an explicit `tournament.segment`
 * field (set by AdminView when uploading the schedule) and falls back to
 * date-based inference. Replaces the local copies in AdminView, ResultsView,
 * TransactionsView, and StandingsView.
 */
export const getSegmentForTournament = (tournament) => {
  if (!tournament) return null;
  if (tournament.segment) return tournament.segment;
  if (tournament.swing)   return tournament.swing;
  // Try startDate first
  if (tournament.startDate) {
    return getSegmentByDate(new Date(tournament.startDate));
  }
  // Fall back to parsing dates string ("Apr 6-12")
  if (tournament.dates) {
    const m = tournament.dates.match(/^([A-Za-z]+)\s+(\d+)/);
    if (m) {
      const months = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
      const mo = months[m[1]];
      if (mo !== undefined) {
        return getSegmentByDate(new Date(new Date().getFullYear(), mo, parseInt(m[2])));
      }
    }
  }
  return null;
};

// ============================================================================
// TOURNAMENT TIMEZONE / LOCK LOGIC
// ============================================================================
export const getTournamentTimezone = (tournament) => {
  if (!tournament?.location) return 'ET';
  const loc = tournament.location.toLowerCase();
  if (loc.includes('hawaii') || loc.includes('honolulu'))                                      return 'HT';
  if (loc.includes('california') || loc.includes('pebble beach') || loc.includes('la quinta') ||
      loc.includes('san diego')  || loc.includes('pacific palisades') || loc.includes('napa')  ||
      loc.includes('oregon')     || loc.includes('washington'))                                 return 'PT';
  if (loc.includes('arizona')   || loc.includes('scottsdale') || loc.includes('colorado')     ||
      loc.includes('utah')       || loc.includes('montana')   || loc.includes('idaho')         ||
      loc.includes('wyoming')    || loc.includes('new mexico') || loc.includes('nevada'))       return 'MT';
  if (loc.includes('texas')     || loc.includes('houston')   || loc.includes('san antonio')   ||
      loc.includes('fort worth') || loc.includes('louisiana') || loc.includes('avondale')      ||
      loc.includes('illinois')   || loc.includes('silvis')   || loc.includes('minnesota')      ||
      loc.includes('blaine')     || loc.includes('michigan')  || loc.includes('detroit')       ||
      loc.includes('memphis')    || loc.includes('tennessee') || loc.includes('kentucky')       ||
      loc.includes('louisville'))                                                                return 'CT';
  return 'ET';
};

export const getTournamentLockHourET = (tournament) => {
  switch (getTournamentTimezone(tournament)) {
    case 'HT': return 12;
    case 'PT': return 9;
    case 'MT': return 8;
    case 'CT': return 8;
    default:   return 7;
  }
};

export const getTournamentStartDate = (tournament) => {
  if (tournament?.startDate) return new Date(tournament.startDate);
  if (!tournament?.dates) return null;
  const match = tournament.dates.match(/^([A-Za-z]+)\s+(\d+)/);
  if (!match) return null;
  const months = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
  const month = months[match[1]];
  if (month === undefined) return null;
  return new Date(2026, month, parseInt(match[2]));
};

/** Locks at first-tee Thursday morning (adjusted per local timezone). */
export const isTournamentLocked = (tournament) => {
  if (!tournament) return false;
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
  const wDay  = settings?.waiverDay    ?? 2;  // default Tue
  const wHour = settings?.waiverHour   ?? 20; // default 8pm
  const wMin  = settings?.waiverMinute ?? 0;
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
  const wDay  = settings?.waiverDay    ?? 2;  // default Tue
  const wHour = settings?.waiverHour   ?? 20; // default 8pm
  const wMin  = settings?.waiverMinute ?? 0;
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

const DAY_ABBRS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const fmtWaiverCutoff = (settings) => {
  const d = settings?.waiverDay ?? 2;
  const h = settings?.waiverHour ?? 20;
  const m = settings?.waiverMinute ?? 0;
  const hr = h % 12 || 12;
  const ampm = h < 12 ? 'am' : 'pm';
  const min = m > 0 ? `:${String(m).padStart(2, '0')}` : '';
  return `${DAY_ABBRS[d]} ${hr}${min}${ampm}`;
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

// ============================================================================
// SCORING ENGINE
// ============================================================================

/**
 * Processes raw API leaderboard data for a completed tournament.
 *
 * Fixes vs. original:
 *  - eventsPlayed only increments for players who STARTED (i.e. have round data),
 *    not just anyone who appears in the payout object.
 *  - Bonus splits are Math.round()ed to avoid fractional-dollar storage values.
 *  - cutsMade keyed off earnings > 0 (unchanged, but documented).
 */
export const processTournamentData = (tournament, apiPlayers, currentTeams, currentStats, allPlayerNames, leagueSettings = {}) => {
  const isMajor = tournament.isMajor;
  const bonuses = isMajor
    ? { round1: leagueSettings.bonusR1Major ?? BONUSES_MAJOR.round1, round2: leagueSettings.bonusR2Major ?? BONUSES_MAJOR.round2, round3: leagueSettings.bonusR3Major ?? BONUSES_MAJOR.round3 }
    : { round1: leagueSettings.bonusR1Regular ?? BONUSES_REGULAR.round1, round2: leagueSettings.bonusR2Regular ?? BONUSES_REGULAR.round2, round3: leagueSettings.bonusR3Regular ?? BONUSES_REGULAR.round3 };

  // ── Round leaders ─────────────────────────────────────────────────────────
  let r1Leaders = [], r2Leaders = [], r3Leaders = [];
  let r1Best = Infinity, r2Best = Infinity, r3Best = Infinity;

  const apiEntries = apiPlayers.map(ap => {
    const pObj = ap?.player || ap;
    let rawName = pObj?.fullName || pObj?.displayName || pObj?.name || '';
    if (!rawName) rawName = `${pObj?.firstName || ''} ${pObj?.lastName || ''}`.trim();
    const name   = resolvePlayerName(rawName, allPlayerNames) || rawName;
    const rounds  = ap.rounds || [];
    const scores  = rounds.map(r => (r?.score !== undefined && r?.score !== null) ? parseInt(r.score) : null);
    let earnings  = ap.earnings || ap.winnings || ap.payout || 0;
    if (typeof earnings === 'string') earnings = parseInt(earnings.replace(/[^0-9]/g, '')) || 0;
    const started = scores[0] !== null; // has at least R1 score
    return { name, scores, earnings, started };
  }).filter(e => e.name);

  apiEntries.forEach(({ name, scores }) => {
    if (scores[0] !== null) {
      const r1 = scores[0];
      if (r1 < r1Best)      { r1Best = r1; r1Leaders = [name]; }
      else if (r1 === r1Best) r1Leaders.push(name);
    }
    if (scores[0] !== null && scores[1] !== null) {
      const r2 = scores[0] + scores[1];
      if (r2 < r2Best)      { r2Best = r2; r2Leaders = [name]; }
      else if (r2 === r2Best) r2Leaders.push(name);
    }
    if (scores[0] !== null && scores[1] !== null && scores[2] !== null) {
      const r3 = scores[0] + scores[1] + scores[2];
      if (r3 < r3Best)      { r3Best = r3; r3Leaders = [name]; }
      else if (r3 === r3Best) r3Leaders.push(name);
    }
  });

  // ── Player payouts ────────────────────────────────────────────────────────
  const playerPayouts = {};
  apiEntries.forEach(({ name, earnings, started }) => {
    let bonus     = 0;
    const roundsLed = [];
    if (r1Leaders.includes(name)) { bonus += Math.round(bonuses.round1 / r1Leaders.length); roundsLed.push({ round: 1 }); }
    if (r2Leaders.includes(name)) { bonus += Math.round(bonuses.round2 / r2Leaders.length); roundsLed.push({ round: 2 }); }
    if (r3Leaders.includes(name)) { bonus += Math.round(bonuses.round3 / r3Leaders.length); roundsLed.push({ round: 3 }); }
    playerPayouts[name] = { earnings, bonus, roundsLed, total: earnings + bonus, started };
  });

  // ── Global stats update ───────────────────────────────────────────────────
  const newStats = { ...currentStats };
  Object.entries(playerPayouts).forEach(([pName, payout]) => {
    if (!payout.started) return; // only count players who actually teed it up
    if (!newStats[pName]) newStats[pName] = { eventsPlayed: 0, cutsMade: 0, pgaTourEarnings: 0 };
    newStats[pName].eventsPlayed   += 1;
    newStats[pName].pgaTourEarnings += payout.earnings;
    if (payout.earnings > 0) newStats[pName].cutsMade += 1;
  });

  // ── Team earnings ─────────────────────────────────────────────────────────
  const resultsData = { teams: {} };
  const newTeams    = currentTeams.map(team => {
    let teamTotal    = 0;
    const resultPlayers = [];

    const newRoster = team.roster.map(rp => {
      if (!(team.lineup || []).includes(rp.name)) return rp;
      const payout = playerPayouts[rp.name] || { earnings: 0, bonus: 0, roundsLed: [], total: 0, started: false };
      teamTotal += payout.total;
      resultPlayers.push({ ...rp, ...payout });
      return {
        ...rp,
        sfglEarnings:   (rp.sfglEarnings   || 0) + payout.total,
        pgaTourEarnings: (rp.pgaTourEarnings || 0) + payout.earnings,
        eventsPlayed:   (rp.eventsPlayed    || 0) + (payout.started ? 1 : 0),
        cutsMade:       (rp.cutsMade        || 0) + (payout.earnings > 0 ? 1 : 0),
      };
    });

    resultsData.teams[team.id] = { totalEarnings: teamTotal, players: resultPlayers };
    return { ...team, earnings: (team.earnings || 0) + teamTotal, segmentEarnings: (team.segmentEarnings || 0) + teamTotal, roster: newRoster, lineup: [] };
  });

  return { newTeams, newStats, resultsData };
};

// Wave C.5: removed the API FETCH section (slashGolfFetch + fetchFirstTeeTime).
// Both were dead code — slashGolfFetch was only used by the deleted
// ScheduleImportModal (Wave B) and by fetchFirstTeeTime, which itself was
// never called from App.jsx. The `firstTeeTime` prop that RostersView and
// TournamentsView destructure was always undefined in production.
//
// If you ever need first-tee-time data again, source it from /api/field
// (which already returns teeTimes for the current week's tournament) rather
// than reintroducing the RapidAPI dependency.

