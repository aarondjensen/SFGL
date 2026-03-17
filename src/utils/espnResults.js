/**
 * espnResults.js
 * ============================================================================
 * Fetches completed tournament earnings and round leaders from ESPN.
 *
 * Strategy:
 *  1. Use the CORS-safe scoreboard to find the ESPN event ID by tournament name.
 *  2. Fetch full leaderboard data from cdn.espn.com/golf/leaderboard?tournamentId=
 *     This CDN endpoint is publicly accessible and returns complete results
 *     including earnings for completed events.
 *
 * Returns:
 *   {
 *     earningsMap:    { [playerName]: earnings }
 *                     ALL starters. Made-cut: earnings > 0. Missed-cut: 0.
 *     roundLeaders:   { round1: [name], round2: [name], round3: [name] }
 *     playerCount, madeCutCount, missedCutCount, eventName, espnEventId
 *   }
 * ============================================================================
 */

const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard';
const CDN_LEADERBOARD = 'https://cdn.espn.com/golf/leaderboard';

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

// ── Find event in a list, return the matching event object ────────────────────
function findEventInList(events, target) {
  let match = events.find(e => normTournName(e.name) === target);
  if (!match) {
    match = events.find(e => {
      const en = normTournName(e.name);
      return en.includes(target) || target.includes(en);
    });
  }
  return match || null;
}

// ── Find ESPN event ID via scoreboard ─────────────────────────────────────────
async function findESPNEventId(tournamentName) {
  const target = normTournName(tournamentName);

  // 1. Current scoreboard
  const sbResp = await fetch(SCOREBOARD);
  if (!sbResp.ok) throw new Error(`ESPN scoreboard fetch failed: ${sbResp.status}`);
  const sbData  = await sbResp.json();
  const sbMatch = findEventInList(sbData.events || [], target);
  if (sbMatch) {
    console.log(`[ESPN] Found "${sbMatch.name}" on current scoreboard (id: ${sbMatch.id})`);
    return { id: sbMatch.id, name: sbMatch.name };
  }

  // 2. Full year calendar — scoreboard with year gives list of all events
  //    but without competitor data. We just need the ID here.
  const year    = new Date().getFullYear();
  const calResp = await fetch(`${SCOREBOARD}?dates=${year}`);
  if (calResp.ok) {
    const calData  = await calResp.json();
    const calMatch = findEventInList(calData.events || [], target);
    if (calMatch) {
      console.log(`[ESPN] Found "${calMatch.name}" on year calendar (id: ${calMatch.id})`);
      return { id: calMatch.id, name: calMatch.name };
    }
  }

  // 3. Walk back week by week (up to 12 weeks) using dated scoreboard
  const now = new Date();
  for (let weeksBack = 0; weeksBack <= 12; weeksBack++) {
    const d = new Date(now);
    d.setDate(d.getDate() - weeksBack * 7);
    const dateStr = d.toISOString().slice(0, 10).replace(/-/g, '');
    const wResp   = await fetch(`${SCOREBOARD}?dates=${dateStr}`).catch(() => null);
    if (!wResp?.ok) continue;
    const wData   = await wResp.json();
    const wMatch  = findEventInList(wData.events || [], target);
    if (wMatch) {
      console.log(`[ESPN] Found "${wMatch.name}" at week -${weeksBack} (id: ${wMatch.id})`);
      return { id: wMatch.id, name: wMatch.name };
    }
  }

  throw new Error(
    `Could not find "${tournamentName}" on ESPN. ` +
    `The tournament may not be available yet.`
  );
}

// ── Fetch full leaderboard from CDN endpoint ──────────────────────────────────
async function fetchLeaderboard(espnEventId) {
  const url  = `${CDN_LEADERBOARD}?tournamentId=${espnEventId}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`ESPN CDN leaderboard fetch failed: ${resp.status}`);
  const data = await resp.json();

  // CDN leaderboard shape:
  //   data.leaderboard.competitors  — array of competitor objects
  // or sometimes nested under events/competitions
  let competitors =
    data.leaderboard?.competitors ||
    data.events?.[0]?.competitions?.[0]?.competitors ||
    data.competitions?.[0]?.competitors ||
    data.competitors ||
    [];

  // Some CDN responses wrap everything under a "leaderboard" key differently
  if (competitors.length === 0 && data.leaderboard) {
    // Try iterating leaderboard rows
    const rows = data.leaderboard.rows || data.leaderboard.groups || [];
    rows.forEach(group => {
      (group.competitors || group.athletes || []).forEach(c => competitors.push(c));
    });
  }

  console.log(`[ESPN] CDN leaderboard returned ${competitors.length} competitors`);
  if (competitors.length === 0) {
    console.warn('[ESPN] CDN response keys:', Object.keys(data));
    if (data.leaderboard) console.warn('[ESPN] leaderboard keys:', Object.keys(data.leaderboard));
  }

  return competitors;
}

// ── Round score helpers ───────────────────────────────────────────────────────
function getRoundScores(competitor) {
  return (competitor.linescores || []).map(ls => {
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
  // Direct earnings field
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
  const s = (
    competitor.status?.type?.name ||
    competitor.status?.type?.description ||
    competitor.status?.name ||
    competitor.statusName || ''
  ).toLowerCase();
  return s.includes('cut') || s.includes('wd') || s.includes('withdraw') ||
         s.includes('dq')  || s.includes('disqualif');
}

// ── Main export ───────────────────────────────────────────────────────────────
export async function fetchESPNResults(tournamentName) {
  // Step 1: Find the ESPN event ID
  const { id: espnEventId, name: eventName } = await findESPNEventId(tournamentName);

  // Step 2: Fetch full leaderboard via CDN endpoint
  const competitors = await fetchLeaderboard(espnEventId);

  if (competitors.length === 0) {
    throw new Error(
      `ESPN found the event but returned no player data. ` +
      `The event may not have started or results may not be posted yet.`
    );
  }

  // Step 3: Build earningsMap
  const earningsMap  = {};
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
      'ESPN has player data but no earnings yet. ' +
      'The event may still be in progress or prize money may not be posted. ' +
      'Try again after the tournament concludes.'
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
