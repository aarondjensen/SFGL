/**
 * espnResults.js
 * ============================================================================
 * Fetches completed tournament earnings and round leaders from ESPN's
 * public scoreboard API. Uses only site.api.espn.com which is CORS-safe
 * for browser requests (unlike site.web.api.espn.com which blocks cross-origin).
 *
 * Usage:
 *   import { fetchESPNResults } from '../utils/espnResults';
 *   const { earningsMap, roundLeaders, madeCutCount, missedCutCount } =
 *     await fetchESPNResults('THE PLAYERS Championship');
 *
 * Returns:
 *   {
 *     earningsMap:    { [playerName]: earnings }
 *                     ALL starters: made-cut have earnings > 0,
 *                     missed-cut / WD / DQ have earnings = 0.
 *     roundLeaders:   { round1: [name], round2: [name], round3: [name] }
 *     playerCount:    number
 *     madeCutCount:   number
 *     missedCutCount: number
 *     eventName:      string
 *     espnEventId:    string
 *   }
 * ============================================================================
 */

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard';

// ── Name normalisation ────────────────────────────────────────────────────────
const normName = (s) =>
  (s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const normTournName = (s) =>
  normName(s)
    .replace(/\b(the|championship|open|invitational|classic|tournament|pro|am|presented|by|at|of|golf)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

// ── ESPN event lookup ─────────────────────────────────────────────────────────
async function findESPNEvent(tournamentName) {
  const target = normTournName(tournamentName);

  // Helper: find best match in an events array
  const findMatch = (events) => {
    // Exact normalised match
    let m = events.find(e => normTournName(e.name) === target);
    if (m) return m;
    // Partial match
    m = events.find(e => {
      const en = normTournName(e.name);
      return en.includes(target) || target.includes(en);
    });
    return m || null;
  };

  // 1. Try current scoreboard (includes recent/in-progress/upcoming events)
  const sbResp = await fetch(BASE);
  if (!sbResp.ok) throw new Error(`ESPN fetch failed: ${sbResp.status}`);
  const sbData = await sbResp.json();
  const sbMatch = findMatch(sbData.events || []);
  if (sbMatch) return { id: sbMatch.id, name: sbMatch.name };

  // 2. Try full calendar for current year
  const year = new Date().getFullYear();
  const calResp = await fetch(`${BASE}?dates=${year}`);
  if (calResp.ok) {
    const calData = await calResp.json();
    const calMatch = findMatch(calData.events || []);
    if (calMatch) return { id: calMatch.id, name: calMatch.name };
  }

  throw new Error(
    `Could not find "${tournamentName}" on ESPN. ` +
    `The tournament may not be available yet.`
  );
}

// ── Fetch full event data by ID ───────────────────────────────────────────────
// Using the scoreboard endpoint with ?event= returns the full competition
// including competitors, linescores, and statistics — all CORS-safe.
async function fetchEventData(espnEventId) {
  const resp = await fetch(`${BASE}?event=${espnEventId}`);
  if (!resp.ok) throw new Error(`ESPN event fetch failed: ${resp.status}`);
  const data = await resp.json();

  // The event should be in data.events[0]
  const event = (data.events || []).find(e => e.id === espnEventId) || data.events?.[0];
  if (!event) throw new Error('ESPN returned no event data.');

  const competition = event.competitions?.[0];
  if (!competition) throw new Error('ESPN returned no competition data.');

  return competition;
}

// ── Round score helpers ───────────────────────────────────────────────────────

/** Per-round scores as integers (relative to par). null = not played. */
function getRoundScores(competitor) {
  return (competitor.linescores || []).map(ls => {
    const val = ls.value ?? ls.score ?? ls.displayValue;
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

function extractEarnings(competitor) {
  // Direct earnings field
  if (competitor.earnings !== undefined && competitor.earnings !== null) {
    const n = parseInt(competitor.earnings, 10);
    if (!isNaN(n) && n > 0) return n;
  }

  // statistics array
  if (Array.isArray(competitor.statistics)) {
    // Named earnings stat
    const earnStat = competitor.statistics.find(s =>
      (s.name || '').toLowerCase().includes('earn') ||
      (s.abbreviation || '').toLowerCase().includes('earn')
    );
    if (earnStat) {
      const n = parseInt((earnStat.displayValue || '').replace(/[^0-9]/g, ''), 10);
      if (!isNaN(n) && n > 0) return n;
    }
    // Fallback: any stat value that looks like prize money (>= $10,000)
    for (const stat of competitor.statistics) {
      const raw = (stat.displayValue || '').replace(/[$,]/g, '');
      const n   = parseInt(raw, 10);
      if (!isNaN(n) && n >= 10000) return n;
    }
  }

  // status.earnings or nested prize
  if (competitor.status?.earnings) {
    const n = parseInt(competitor.status.earnings, 10);
    if (!isNaN(n) && n > 0) return n;
  }

  return 0;
}

/** True if this competitor missed the cut, withdrew, or was disqualified. */
function didNotFinish(competitor) {
  const statusName = (
    competitor.status?.type?.name ||
    competitor.status?.type?.description ||
    competitor.status?.name ||
    competitor.statusName ||
    ''
  ).toLowerCase();

  return (
    statusName.includes('cut')       ||
    statusName.includes('wd')        ||
    statusName.includes('withdraw')  ||
    statusName.includes('dq')        ||
    statusName.includes('disqualif')
  );
}

// ── Main export ───────────────────────────────────────────────────────────────
export async function fetchESPNResults(tournamentName) {
  // Step 1: Find the ESPN event ID via the CORS-safe scoreboard endpoint
  const { id: espnEventId, name: eventName } = await findESPNEvent(tournamentName);

  // Step 2: Fetch full competition data (also via the CORS-safe scoreboard endpoint)
  const competition = await fetchEventData(espnEventId);

  const competitors = competition.competitors || [];
  if (competitors.length === 0) {
    throw new Error('ESPN returned no competitors. The event may not be complete yet.');
  }

  // Step 3: Build earningsMap — ALL starters included
  const earningsMap = {};
  let missedCutCount = 0;

  competitors.forEach(c => {
    const name = c.athlete?.displayName || c.displayName;
    if (!name) return;

    if (didNotFinish(c)) {
      earningsMap[name] = 0;
      missedCutCount++;
    } else {
      earningsMap[name] = extractEarnings(c);
    }
  });

  // Sanity check: if nobody has earnings > 0, data isn't finalised yet
  const madeCutCount = Object.values(earningsMap).filter(e => e > 0).length;
  if (madeCutCount === 0 && competitors.length > 0) {
    throw new Error(
      'ESPN has player data but no earnings yet — the event may still be in progress ' +
      'or prize money may not be posted. Try again after the tournament concludes.'
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
