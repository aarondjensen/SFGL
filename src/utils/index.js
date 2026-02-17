import { CHAR_MAP, PLAYER_NAME_ALIASES, PGA_TOUR_IDS, TEAM_ABBREVIATIONS, BONUSES_REGULAR, BONUSES_MAJOR, SWINGS } from '../constants/index.js';

// ============================================================================
// AUTH
// ============================================================================
export const hashPassword = async (password) => {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
};

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

export const getSortedRoster = (roster) => {
  const limited   = roster.filter(p => p.limited);
  const unlimited = roster.filter(p => !p.limited);
  return [...limited, ...unlimited];
};

// ============================================================================
// HEADSHOTS
// ============================================================================
export const getPlayerHeadshot = (playerName, isLimited = false, headshotMap = {}) => {
  const pgaId = headshotMap[playerName] || PGA_TOUR_IDS[playerName];
  if (pgaId) {
    return `https://pga-tour-res.cloudinary.com/image/upload/c_thumb,g_face,z_0.7,q_auto,f_auto,dpr_2.0,w_96,h_96/headshots_${pgaId}`;
  }
  return getPlayerHeadshotFallback(playerName, isLimited);
};

export const getPlayerHeadshotFallback = (playerName, isLimited = false) => {
  const encodedName = encodeURIComponent(playerName);
  const background  = isLimited ? 'EAB308' : '059669';
  return `https://ui-avatars.com/api/?name=${encodedName}&background=${background}&color=ffffff&size=400&bold=true&font-size=0.4`;
};

// ============================================================================
// TEAM UTILITIES
// ============================================================================
export const getTeamAbbreviation = (teamName) =>
  TEAM_ABBREVIATIONS[teamName] ||
  teamName.split(' ').map(w => w[0]).join('').slice(0, 3).toUpperCase();

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
// SEGMENT
// ============================================================================
export const getSegmentByDate = () => {
  const month = new Date().getMonth() + 1;
  if (month >= 1 && month <= 3) return 'West Coast Swing';
  if (month >= 4 && month <= 5) return 'Florida Swing';
  if (month >= 6 && month <= 8) return 'Summer Swing';
  return 'Fall Finish';
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

export const isFreeAgentWindowOpen = (tournament) => {
  if (isTournamentLocked(tournament)) return false;
  const et      = getETNow();
  const day     = et.getDay();
  const timeVal = et.getHours() * 60 + et.getMinutes();
  if (day === 2 && timeVal >= 20 * 60 + 1) return true; // Tue 8:01pm+
  if (day === 3 || day === 4) return true;
  return false;
};

export const isWaiverWindowOpen = () => {
  const et      = getETNow();
  const day     = et.getDay();
  const timeVal = et.getHours() * 60 + et.getMinutes();
  if (day === 0 && timeVal >= 21 * 60) return true;
  if (day === 1) return true;
  if (day === 2 && timeVal < 20 * 60) return true;
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

export const getFreeAgentWindowStatus = (tournament) => {
  if (isFreeAgentWindowOpen(tournament)) {
    const h = getTournamentLockHourET(tournament);
    return { open: true, label: `Open until Thu ${lockStr(h)} ET` };
  }
  if (isTournamentLocked(tournament)) return { open: false, label: 'Locked' };
  return { open: false, label: 'Opens Tue 8:01pm ET' };
};

export const getWaiverWindowStatus = () =>
  isWaiverWindowOpen()
    ? { open: true,  label: 'Open' }
    : { open: false, label: 'Opens Sun 9pm ET' };

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
export const processTournamentData = (tournament, apiPlayers, currentTeams, currentStats, allPlayerNames) => {
  const isMajor = tournament.isMajor;
  const bonuses = isMajor ? BONUSES_MAJOR : BONUSES_REGULAR;

  // ── Round leaders ─────────────────────────────────────────────────────────
  let r1Leaders = [], r2Leaders = [], r3Leaders = [];
  let r1Best = Infinity, r2Best = Infinity, r3Best = Infinity;

  const apiEntries = apiPlayers.map(ap => {
    const pObj = ap?.player || ap;
    let rawName = pObj?.fullName || pObj?.displayName || pObj?.name || '';
    if (!rawName) rawName = `${pObj?.firstName || ''} ${pObj?.lastName || ''}`.trim();
    const name   = resolvePlayerName(rawName, allPlayerNames) || rawName;
    const rounds  = ap.rounds || [];
const scores  = rounds.map(r => {
  if (r?.strokes?.$numberInt !== undefined) return parseInt(r.strokes.$numberInt);
  if (r?.strokes !== undefined && r?.strokes !== null) return parseInt(r.strokes);
  if (r?.score !== undefined && r?.score !== null) return parseInt(r.score);
  return null;
});
let earnings  = ap.earnings || ap.winnings || ap.payout || 0;
if (typeof earnings === 'object' && earnings?.$numberInt) earnings = parseInt(earnings.$numberInt);
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

// ============================================================================
// API FETCH
// ============================================================================
export const slashGolfFetch = async (endpoint, params = {}) => {
  const RAPIDAPI_KEY = import.meta.env.VITE_RAPIDAPI_KEY;
  const url = new URL(`https://live-golf-data.p.rapidapi.com/${endpoint}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  });
  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'X-RapidAPI-Key':  RAPIDAPI_KEY,
      'X-RapidAPI-Host': 'live-golf-data.p.rapidapi.com',
    },
  });
  if (!res.ok) throw new Error(`Slash Golf API error: ${res.status} ${res.statusText}`);
  return res.json();
};
