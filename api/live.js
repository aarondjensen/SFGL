// api/live.js — Vercel serverless function
// Returns live leaderboard positions for the current PGA Tour event.
// Vercel runs server-side so we can hit ESPN directly — no CORS proxy needed.
//
// GET /api/live → { players: [{ name, position, score, thru, teeTime, status }], tournament, round, state }

const SCOREBOARD  = 'https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard';
const LEADERBOARD = 'https://site.web.api.espn.com/apis/v2/sports/golf/pga/leaderboard';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.espn.com/',
  'Origin': 'https://www.espn.com',
};

function formatTeeTime(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: true,
      timeZone: 'America/New_York',
    });
  } catch { return null; }
}

function formatScore(n) {
  if (n === null || n === undefined || isNaN(n)) return null;
  if (n === 0) return 'E';
  return n > 0 ? `+${n}` : `${n}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const isDebug = req.query.debug === '1';

  try {
    // Step 1: find current event ID from scoreboard
    const sbResp = await fetch(SCOREBOARD, { headers: HEADERS });
    if (!sbResp.ok) throw new Error(`Scoreboard ${sbResp.status}`);
    const sbData = await sbResp.json();
    const events = sbData?.events || [];
    if (!events.length) return res.status(404).json({ error: 'No active event on ESPN scoreboard' });

    const event = events[0];
    const eventId = event.id;
    const tournament = event.name;
    const currentRound = event.competitions?.[0]?.status?.period || 1;
    const eventState = event.status?.type?.state || 'pre'; // 'pre', 'in', 'post'

    // Step 2: fetch full leaderboard directly (server-side, no CORS issue)
    const lbResp = await fetch(`${LEADERBOARD}?event=${eventId}`, { headers: HEADERS });
    if (!lbResp.ok) throw new Error(`Leaderboard ${lbResp.status}`);
    const lbData = await lbResp.json();

    const competitors =
      lbData.events?.[0]?.competitions?.[0]?.competitors ||
      lbData.competitions?.[0]?.competitors ||
      lbData.competitors || [];

    if (isDebug) {
      return res.status(200).json({
        eventId, tournament, round: currentRound, state: eventState,
        competitorCount: competitors.length,
        sampleCompetitor: competitors[0] ? {
          keys: Object.keys(competitors[0]),
          statusKeys: competitors[0].status ? Object.keys(competitors[0].status) : null,
          sample: JSON.stringify(competitors[0]).slice(0, 600),
        } : null,
      });
    }

    if (!competitors.length) {
      return res.status(200).json({ players: [], tournament, round: currentRound, state: eventState });
    }

    // Count positions to detect ties
    const posCounts = {};
    competitors.forEach(c => {
      const p = c.sortOrder;
      if (p) posCounts[p] = (posCounts[p] || 0) + 1;
    });

    const players = competitors.map(c => {
      const name = c.athlete?.displayName || c.displayName || '';
      if (!name) return null;

      const pos = c.sortOrder;
      const tied = pos && posCounts[pos] > 1;
      const posDisplay = pos ? (tied ? `T${pos}` : `${pos}`) : null;

      // Score to par
      let scoreNum = null;
      const scoreStat = (c.statistics || []).find(s =>
        s.name === 'scoreToPar' || s.abbreviation === 'SCORE' || s.name === 'score'
      );
      if (scoreStat) {
        const v = scoreStat.displayValue;
        scoreNum = v === 'E' ? 0 : parseInt(v, 10);
      }

      // Thru holes
      const thruVal = c.status?.thru ?? c.thru;
      const thru = (thruVal !== null && thruVal !== undefined) ? (thruVal === 18 ? 'F' : `${thruVal}`) : null;
      const started = thru !== null;

      // Tee time
      const teeTime = formatTeeTime(c.teeTime || c.status?.teeTime);

      // Cut / WD / DQ
      const statusStr = (c.status?.type?.name || c.status?.type?.description || c.statusName || '').toLowerCase();
      const cut = statusStr.includes('cut') || statusStr.includes('wd') || statusStr.includes('withdraw') || statusStr.includes('dq') || statusStr.includes('disqualif');

      return {
        name,
        position: (!cut && posDisplay) ? posDisplay : null,
        score: formatScore(scoreNum),
        thru,
        teeTime,
        started,
        cut,
        status: cut ? 'cut' : started ? 'active' : 'pre',
      };
    }).filter(Boolean);

    return res.status(200).json({ players, tournament, round: currentRound, state: eventState });

  } catch (err) {
    return res.status(503).json({ error: err.message });
  }
}
