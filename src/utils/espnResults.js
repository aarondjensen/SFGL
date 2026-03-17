/**
 * espnResults.js
 * ============================================================================
 * Fetches completed tournament earnings and round leaders via a Vercel
 * serverless proxy (/api/espn-leaderboard) that calls ESPN server-side,
 * bypassing CORS restrictions on direct browser requests.
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

// Routes all ESPN requests through our Vercel proxy to avoid CORS blocks.
// In local dev (localhost) this hits the same Vercel dev server via vite proxy,
// or falls back to direct ESPN if the proxy isn't available yet.
const PROXY = '/api/espn-leaderboard';

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

// ── Fetch via proxy ───────────────────────────────────────────────────────────
async function proxyFetch(params) {
  const qs   = new URLSearchParams(params).toString();
  const resp = await fetch(`${PROXY}?${qs}`);
  if (!resp.ok) throw new Error(`Proxy fetch failed: ${resp.status}`);
  return resp.json();
}

// ── Find event in a list ──────────────────────────────────────────────────────
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

// ── Find ESPN event ID ────────────────────────────────────────────────────────
async function findESPNEventId(tournamentName) {
  const target = normTournName(tournamentName);

  // 1. Current scoreboard
  const sbData  = await proxyFetch({ scoreboard: 1 });
  const sbMatch = findEventInList(sbData.events || [], target);
  if (sbMatch) {
    console.log(`[ESPN] Found "${sbMatch.name}" on current scoreboard (id: ${sbMatch.id})`);
    return { id: sbMatch.id, name: sbMatch.name };
  }

  // 2. Full year calendar
  const year    = new Date().getFullYear();
  const calData = await proxyFetch({ scoreboard: 1, dates: year });
  const calMatch = findEventInList(calData.events || [], target);
  if (calMatch) {
    console.log(`[ESPN] Found "${calMatch.name}" on year calendar (id: ${calMatch.id})`);
    return { id: calMatch.id, name: calMatch.name };
  }

  // 3. Walk back week by week up to 12 weeks
  const now = new Date();
  for (let weeksBack = 1; weeksBack <= 12; weeksBack++) {
    const d = new Date(now);
    d.setDate(d.getDate() - weeksBack * 7);
    const dateStr  = d.toISOString().slice(0, 10).replace(/-/g, '');
    const wData    = await proxyFetch({ scoreboard: 1, dates: dateStr }).catch(() => null);
    if (!wData) continue;
    const wMatch   = findEventInList(wData.events || [], target);
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

// ── Fetch full leaderboard ────────────────────────────────────────────────────
async function fetchLeaderboard(espnEventId) {
  const data = await proxyFetch({ tournamentId: espnEventId });

  // ESPN leaderboard v2 shape: data.events[0].competitions[0].competitors
  let competitors =
    data.events?.[0]?.competitions?.[0]?.competitors ||
    data.competitions?.[0]?.competitors ||
    data.competitors ||
    data.leaderboard?.competitors ||
    [];

  console.log(`[ESPN] Leaderboard returned ${competitors.length} competitors`);
  if (competitors.length === 0) {
    console.warn('[ESPN] Response top-level keys:', Object.keys(data));
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
  // Step 1: Find the ESPN event ID
  const { id: espnEventId, name: eventName } = await findESPNEventId(tournamentName);

  // Step 2: Fetch full leaderboard via proxy
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
