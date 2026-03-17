/**
 * espnResults.js
 * ============================================================================
 * Fetches completed tournament earnings and round leaders from ESPN.
 *
 * Endpoints used (both CORS-safe from the browser):
 *   - Scoreboard: site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard
 *     Used to look up the ESPN event ID by tournament name.
 *   - Summary:    site.api.espn.com/apis/site/v2/sports/golf/pga/summary?event={id}
 *     Returns full leaderboard with competitors, linescores, and earnings.
 *
 * Returns:
 *   {
 *     earningsMap:    { [playerName]: earnings }
 *                     ALL starters included.
 *                     Made-cut players: earnings > 0.
 *                     Missed-cut / WD / DQ players: earnings = 0.
 *     roundLeaders:   { round1: [name], round2: [name], round3: [name] }
 *     playerCount:    number
 *     madeCutCount:   number
 *     missedCutCount: number
 *     eventName:      string
 *     espnEventId:    string
 *   }
 * ============================================================================
 */

const SCOREBOARD_URL = 'https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard';
const SUMMARY_URL    = 'https://site.api.espn.com/apis/site/v2/sports/golf/pga/summary';

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

// ── ESPN event lookup via scoreboard ─────────────────────────────────────────
async function findESPNEvent(tournamentName) {
  const target = normTournName(tournamentName);

  const findMatch = (events) => {
    let m = events.find(e => normTournName(e.name) === target);
    if (m) return m;
    m = events.find(e => {
      const en = normTournName(e.name);
      return en.includes(target) || target.includes(en);
    });
    return m || null;
  };

  // 1. Current scoreboard
  const sbResp = await fetch(SCOREBOARD_URL);
  if (!sbResp.ok) throw new Error(`ESPN scoreboard fetch failed: ${sbResp.status}`);
  const sbData  = await sbResp.json();
  const sbMatch = findMatch(sbData.events || []);
  if (sbMatch) return { id: sbMatch.id, name: sbMatch.name };

  // 2. Full year calendar
  const year     = new Date().getFullYear();
  const calResp  = await fetch(`${SCOREBOARD_URL}?dates=${year}`);
  if (calResp.ok) {
    const calData  = await calResp.json();
    const calMatch = findMatch(calData.events || []);
    if (calMatch) return { id: calMatch.id, name: calMatch.name };
  }

  throw new Error(
    `Could not find "${tournamentName}" on ESPN. ` +
    `The tournament may not be available yet.`
  );
}

// ── Round score helpers ───────────────────────────────────────────────────────

function getRoundScores(competitor) {
  // linescores may live on competitor directly or nested under rounds
  const linescores = competitor.linescores || [];
  return linescores.map(ls => {
    const val = ls.value ?? ls.score ?? ls.displayValue;
    if (val === undefined || val === null || val === '--' || val === '') return null;
    const n = parseInt(val, 10);
    return isNaN(n) ? null : n;
  });
}

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
  // Direct field
  if (competitor.earnings !== undefined && competitor.earnings !== null) {
    const n = parseInt(competitor.earnings, 10);
    if (!isNaN(n) && n > 0) return n;
  }

  // statistics array
  if (Array.isArray(competitor.statistics)) {
    const earnStat = competitor.statistics.find(s =>
      (s.name || '').toLowerCase().includes('earn') ||
      (s.abbreviation || '').toLowerCase().includes('earn')
    );
    if (earnStat) {
      const n = parseInt((earnStat.displayValue || '').replace(/[^0-9]/g, ''), 10);
      if (!isNaN(n) && n > 0) return n;
    }
    for (const stat of competitor.statistics) {
      const raw = (stat.displayValue || '').replace(/[$,]/g, '');
      const n   = parseInt(raw, 10);
      if (!isNaN(n) && n >= 10000) return n;
    }
  }

  return 0;
}

function didNotFinish(competitor) {
  const statusName = (
    competitor.status?.type?.name ||
    competitor.status?.type?.description ||
    competitor.status?.name ||
    competitor.statusName ||
    ''
  ).toLowerCase();

  return (
    statusName.includes('cut')      ||
    statusName.includes('wd')       ||
    statusName.includes('withdraw') ||
    statusName.includes('dq')       ||
    statusName.includes('disqualif')
  );
}

// ── Main export ───────────────────────────────────────────────────────────────
export async function fetchESPNResults(tournamentName) {
  // Step 1: Find event ID via scoreboard
  const { id: espnEventId, name: eventName } = await findESPNEvent(tournamentName);

  // Step 2: Fetch full leaderboard via summary endpoint
  const summaryResp = await fetch(`${SUMMARY_URL}?event=${espnEventId}`);
  if (!summaryResp.ok) {
    throw new Error(`ESPN summary fetch failed: ${summaryResp.status}`);
  }
  const summaryData = await summaryResp.json();

  // Summary shape: { competition: { competitors: [...] } }
  // or sometimes:  { leaderboard: { ... } }
  // Try multiple paths
  let competitors =
    summaryData.competition?.competitors ||
    summaryData.leaderboard?.competitors ||
    summaryData.competitors ||
    [];

  // If still empty, try digging into events array (some responses wrap differently)
  if (competitors.length === 0 && summaryData.events) {
    const event = summaryData.events.find(e => e.id === espnEventId) || summaryData.events[0];
    competitors = event?.competitions?.[0]?.competitors || [];
  }

  if (competitors.length === 0) {
    // Log what we got to help debug
    console.warn('[ESPN] Summary response keys:', Object.keys(summaryData));
    throw new Error(
      'ESPN returned no competitors from the summary endpoint. ' +
      'The event may not be complete yet, or the data structure may have changed.'
    );
  }

  // Step 3: Build earningsMap
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

  const madeCutCount = Object.values(earningsMap).filter(e => e > 0).length;
  if (madeCutCount === 0 && competitors.length > 0) {
    throw new Error(
      'ESPN has player data but no earnings yet — the event may still be in progress ' +
      'or prize money may not be posted. Try again after the tournament concludes.'
    );
  }

  // Step 4: Round leaders
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
