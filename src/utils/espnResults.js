/**
 * espnResults.js
 * ============================================================================
 * Fetches completed tournament earnings and round leaders from ESPN.
 *
 * - Event ID lookup: site.api.espn.com/scoreboard (CORS-safe, direct)
 * - Leaderboard data: site.web.api.espn.com/leaderboard via corsproxy.io
 *   (ESPN blocks direct browser requests; corsproxy.io relays them)
 * ============================================================================
 */

const SCOREBOARD  = 'https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard';
const LEADERBOARD = 'https://site.web.api.espn.com/apis/v2/sports/golf/pga/leaderboard';

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

// ── Find ESPN event ID via the CORS-safe scoreboard ───────────────────────────
async function findESPNEventId(tournamentName) {
  const target = normTournName(tournamentName);

  // 1. Current scoreboard
  const sbResp  = await fetch(SCOREBOARD);
  if (!sbResp.ok) throw new Error(`ESPN scoreboard fetch failed: ${sbResp.status}`);
  const sbData  = await sbResp.json();
  const sbMatch = findEventInList(sbData.events || [], target);
  if (sbMatch) {
    console.log(`[ESPN] Found on current scoreboard: "${sbMatch.name}" (id: ${sbMatch.id})`);
    return { id: sbMatch.id, name: sbMatch.name };
  }

  // 2. Full year calendar
  const year    = new Date().getFullYear();
  const calResp = await fetch(`${SCOREBOARD}?dates=${year}`);
  if (calResp.ok) {
    const calData  = await calResp.json();
    const calMatch = findEventInList(calData.events || [], target);
    if (calMatch) {
      console.log(`[ESPN] Found on year calendar: "${calMatch.name}" (id: ${calMatch.id})`);
      return { id: calMatch.id, name: calMatch.name };
    }
  }

  // 3. Walk back week by week up to 12 weeks
  const now = new Date();
  for (let w = 1; w <= 12; w++) {
    const d       = new Date(now);
    d.setDate(d.getDate() - w * 7);
    const dateStr = d.toISOString().slice(0, 10).replace(/-/g, '');
    const wResp   = await fetch(`${SCOREBOARD}?dates=${dateStr}`).catch(() => null);
    if (!wResp?.ok) continue;
    const wData   = await wResp.json();
    const wMatch  = findEventInList(wData.events || [], target);
    if (wMatch) {
      console.log(`[ESPN] Found at week -${w}: "${wMatch.name}" (id: ${wMatch.id})`);
      return { id: wMatch.id, name: wMatch.name };
    }
  }

  throw new Error(`Could not find "${tournamentName}" on ESPN.`);
}

// ── Fetch full leaderboard via corsproxy.io ───────────────────────────────────
async function fetchLeaderboard(espnEventId) {
  const targetUrl  = `${LEADERBOARD}?event=${espnEventId}`;
  const proxiedUrl = `https://corsproxy.io/?url=${encodeURIComponent(targetUrl)}`;

  console.log(`[ESPN] Fetching leaderboard via corsproxy.io for event ${espnEventId}`);
  const resp = await fetch(proxiedUrl);
  if (!resp.ok) throw new Error(`ESPN leaderboard fetch failed: ${resp.status}`);
  const data = await resp.json();

  const competitors =
    data.events?.[0]?.competitions?.[0]?.competitors ||
    data.competitions?.[0]?.competitors ||
    data.competitors ||
    [];

  console.log(`[ESPN] Got ${competitors.length} competitors`);
  if (competitors.length === 0) {
    console.warn('[ESPN] Response keys:', Object.keys(data));
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
  if (competitor.earnings !== undefined && competitor.earnings !== null) {
    const n = parseInt(competitor.earnings, 10);
    if (!isNaN(n) && n > 0) return n;
  }
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
  const { id: espnEventId, name: eventName } = await findESPNEventId(tournamentName);
  const competitors = await fetchLeaderboard(espnEventId);

  if (competitors.length === 0) {
    throw new Error('ESPN found the event but returned no player data. The event may not be complete yet.');
  }

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
      'Try again after the tournament concludes.'
    );
  }

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