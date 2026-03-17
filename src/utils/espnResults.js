/**
 * espnResults.js
 * ============================================================================
 * Fetches completed tournament earnings and round leaders from ESPN's
 * unofficial public API. No API key required.
 *
 * Usage:
 *   import { fetchESPNResults } from '../utils/espnResults';
 *   const { earningsMap, roundLeaders, playerCount, missedCutCount } =
 *     await fetchESPNResults('THE PLAYERS Championship');
 *
 * Returns:
 *   {
 *     earningsMap:    { [playerName]: earnings },
 *                     — ALL players who started the tournament.
 *                     — Made-cut players have earnings > 0.
 *                     — Missed-cut / WD / DQ players have earnings = 0.
 *                     — processTournamentData already handles this correctly:
 *                       eventsPlayed increments for everyone in the map,
 *                       cutsMade only increments when earnings > 0.
 *     roundLeaders:   { round1: [name], round2: [name], round3: [name] },
 *     playerCount:    number,   // total starters
 *     madeCutCount:   number,
 *     missedCutCount: number,
 *     eventName:      string,
 *     espnEventId:    string,
 *   }
 * ============================================================================
 */

const SCOREBOARD_URL  = 'https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard';
const LEADERBOARD_URL = 'https://site.web.api.espn.com/apis/v2/sports/golf/pga/leaderboard';

// ── Name normalisation ────────────────────────────────────────────────────────
const normName = (s) =>
  (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')  // strip accents
    .replace(/[^a-z0-9 ]/g, '')       // strip punctuation
    .replace(/\s+/g, ' ')
    .trim();

const normTournName = (s) =>
  normName(s)
    .replace(/\b(the|championship|open|invitational|classic|tournament|pro|am|presented|by|at|of|golf)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

// ── ESPN event lookup ─────────────────────────────────────────────────────────
async function findESPNEvent(tournamentName) {
  // Try current scoreboard first
  const sbResp = await fetch(SCOREBOARD_URL);
  if (!sbResp.ok) throw new Error(`ESPN scoreboard fetch failed: ${sbResp.status}`);
  const sbData  = await sbResp.json();
  const events  = sbData.events || [];
  const target  = normTournName(tournamentName);

  let match = events.find(e => normTournName(e.name) === target);
  if (!match) {
    match = events.find(e => {
      const en = normTournName(e.name);
      return en.includes(target) || target.includes(en);
    });
  }
  if (match) return { id: match.id, name: match.name };

  // Fallback: full year calendar
  const year     = new Date().getFullYear();
  const calResp  = await fetch(`${SCOREBOARD_URL}?dates=${year}`);
  if (calResp.ok) {
    const calData   = await calResp.json();
    const calEvents = calData.events || [];
    let calMatch = calEvents.find(e => normTournName(e.name) === target);
    if (!calMatch) {
      calMatch = calEvents.find(e => {
        const en = normTournName(e.name);
        return en.includes(target) || target.includes(en);
      });
    }
    if (calMatch) return { id: calMatch.id, name: calMatch.name };
  }

  throw new Error(
    `Could not find "${tournamentName}" on ESPN. ` +
    `The tournament may not be in ESPN's current data yet.`
  );
}

// ── Round score helpers ───────────────────────────────────────────────────────

/** Per-round scores as integers (relative to par). null = not played. */
function getRoundScores(competitor) {
  return (competitor.linescores || []).map(ls => {
    const val = ls.value;
    if (val === undefined || val === null || val === '--' || val === '') return null;
    const n = parseInt(val, 10);
    return isNaN(n) ? null : n;
  });
}

/** Leader name(s) after a given round (1-indexed). */
function getLeadersAfterRound(competitors, roundIndex) {
  const scores = competitors
    .map(c => {
      const rounds = getRoundScores(c);
      if (rounds.length < roundIndex) return null;
      let total = 0;
      for (let i = 0; i < roundIndex; i++) {
        if (rounds[i] === null) return null;
        total += rounds[i];
      }
      return { name: c.athlete?.displayName || c.displayName || '', score: total };
    })
    .filter(Boolean);

  if (scores.length === 0) return [];
  const best = Math.min(...scores.map(s => s.score));
  return scores.filter(s => s.score === best).map(s => s.name);
}

// ── Earnings extraction ───────────────────────────────────────────────────────

/** Extract prize money for one competitor from ESPN's various data shapes. */
function extractEarnings(competitor) {
  // Direct earnings field
  if (competitor.earnings !== undefined && competitor.earnings !== null) {
    const n = parseInt(competitor.earnings, 10);
    if (!isNaN(n)) return n;
  }

  if (Array.isArray(competitor.statistics)) {
    // Named earnings stat
    const earnStat = competitor.statistics.find(s =>
      (s.name || '').toLowerCase().includes('earn') ||
      (s.abbreviation || '').toLowerCase().includes('earn')
    );
    if (earnStat) {
      const n = parseInt((earnStat.displayValue || '').replace(/[^0-9]/g, ''), 10);
      if (!isNaN(n)) return n;
    }
    // Fallback: any stat value >= $10,000 is likely prize money
    for (const stat of competitor.statistics) {
      const raw = (stat.displayValue || '').replace(/[$,]/g, '');
      const n   = parseInt(raw, 10);
      if (!isNaN(n) && n >= 10000) return n;
    }
  }

  return 0;
}

/**
 * Determine whether a competitor missed the cut, withdrew, or was disqualified.
 * ESPN marks these with status strings like "cut", "wd", "dq".
 */
function didNotFinish(competitor) {
  const statusName = (
    competitor.status?.type?.name ||
    competitor.status?.name ||
    competitor.statusName ||
    ''
  ).toLowerCase();

  return (
    statusName.includes('cut')        ||
    statusName.includes('wd')         ||
    statusName.includes('withdrawn')  ||
    statusName.includes('dq')         ||
    statusName.includes('disqualif')
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Fetch ESPN results for a tournament by name.
 *
 * earningsMap includes ALL starters:
 *   - Made cut        → earnings > 0
 *   - Missed cut / WD / DQ → earnings = 0
 *
 * processTournamentData handles earnings = 0 correctly already:
 *   eventsPlayed++ for everyone, cutsMade++ only when earnings > 0.
 */
export async function fetchESPNResults(tournamentName) {
  // Step 1: Find the ESPN event ID
  const { id: espnEventId, name: eventName } = await findESPNEvent(tournamentName);

  // Step 2: Fetch full leaderboard
  const lbResp = await fetch(`${LEADERBOARD_URL}?event=${espnEventId}`);
  if (!lbResp.ok) throw new Error(`ESPN leaderboard fetch failed: ${lbResp.status}`);
  const lbData = await lbResp.json();

  const competition = lbData.events?.[0]?.competitions?.[0];
  if (!competition) throw new Error('ESPN returned no competition data for this event.');

  const competitors = competition.competitors || [];
  if (competitors.length === 0) {
    throw new Error('ESPN returned no competitors. The event may not be complete yet.');
  }

  // Step 3: Build earningsMap for ALL starters
  const earningsMap = {};
  let missedCutCount = 0;

  competitors.forEach(c => {
    const name = c.athlete?.displayName || c.displayName;
    if (!name) return;

    if (didNotFinish(c)) {
      // Track in eventsPlayed but not cutsMade
      earningsMap[name] = 0;
      missedCutCount++;
    } else {
      earningsMap[name] = extractEarnings(c);
    }
  });

  // Sanity check: if no one has earnings > 0, ESPN data isn't finalised yet
  const madeCutCount = Object.values(earningsMap).filter(e => e > 0).length;
  if (madeCutCount === 0 && competitors.length > 0) {
    throw new Error(
      'ESPN returned player data but no earnings yet. ' +
      'The event may still be in progress or earnings may not be finalised. Try again shortly.'
    );
  }

  // Step 4: Round leaders (after R1, R2, R3)
  const roundLeaders = {
    round1: getLeadersAfterRound(competitors, 1),
    round2: getLeadersAfterRound(competitors, 2),
    round3: getLeadersAfterRound(competitors, 3),
  };

  return {
    earningsMap,
    roundLeaders,
    playerCount:    Object.keys(earningsMap).length,
    madeCutCount,
    missedCutCount,
    eventName,
    espnEventId,
  };
}
