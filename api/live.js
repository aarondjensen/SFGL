// api/live.js — Vercel serverless function
// Returns live leaderboard positions for all players in the current PGA Tour event.
// Used by RostersView to show player positions during tournament week.
//
// GET /api/live → { players: [{ name, position, score, thru, status, teeTime }], tournament, round }

const SCOREBOARD  = 'https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard';
const LEADERBOARD = 'https://site.web.api.espn.com/apis/v2/sports/golf/pga/leaderboard';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
};

// Format tee time ISO string to "8:04 AM" ET
function formatTeeTime(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: true,
      timeZone: 'America/New_York',
    });
  } catch { return null; }
}

// Score to par display: -5 → "-5", 0 → "E", +3 → "+3"
function formatScore(n) {
  if (n === null || n === undefined || isNaN(n)) return null;
  if (n === 0) return 'E';
  return n > 0 ? `+${n}` : `${n}`;
}

// Position with T prefix for ties: sortOrder 1 → "1", tied → "T3" etc.
function formatPosition(pos, tied) {
  if (!pos) return null;
  return tied ? `T${pos}` : `${pos}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  // Short cache — update every 5 minutes during live play
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // Step 1: find current event from ESPN scoreboard
    const sbResp = await fetch(SCOREBOARD, { headers: HEADERS });
    if (!sbResp.ok) throw new Error(`Scoreboard fetch failed: ${sbResp.status}`);
    const sbData = await sbResp.json();
    const events = sbData?.events || [];
    if (!events.length) return res.status(404).json({ error: 'No active event found' });
    const event = events[0];
    const eventId = event.id;
    const tournament = event.name;
    const currentRound = event.competitions?.[0]?.status?.period || 1;
    const eventState = event.status?.type?.state; // 'pre', 'in', 'post'

    // Step 2: fetch leaderboard via proxy (ESPN blocks direct browser requests)
    const targetUrl = `${LEADERBOARD}?event=${eventId}`;
    const proxiedUrl = `https://corsproxy.io/?url=${encodeURIComponent(targetUrl)}`;
    const lbResp = await fetch(proxiedUrl, { headers: { ...HEADERS, Accept: 'application/json' } });
    if (!lbResp.ok) throw new Error(`Leaderboard fetch failed: ${lbResp.status}`);
    const lbData = await lbResp.json();

    const competitors =
      lbData.events?.[0]?.competitions?.[0]?.competitors ||
      lbData.competitions?.[0]?.competitors ||
      lbData.competitors || [];

    if (!competitors.length) {
      return res.status(200).json({ players: [], tournament, round: currentRound, state: eventState });
    }

    // Count ties for position formatting
    const posCounts = {};
    competitors.forEach(c => {
      const p = c.sortOrder || c.position?.displayName;
      if (p) posCounts[p] = (posCounts[p] || 0) + 1;
    });

    const players = competitors.map(c => {
      const name = c.athlete?.displayName || c.displayName || '';
      const pos = c.sortOrder || c.position?.value;
      const tied = pos && posCounts[pos] > 1;

      // Score to par from statistics
      let score = null;
      const scoreStat = (c.statistics || []).find(s =>
        s.name === 'scoreToPar' || s.abbreviation === 'SCORE' || s.name === 'score'
      );
      if (scoreStat) {
        const v = scoreStat.displayValue;
        score = v === 'E' ? 0 : parseInt(v, 10);
      }
      // Fallback: sum linescores
      if (score === null && c.linescores?.length) {
        score = c.linescores.reduce((sum, ls) => {
          const v = ls.value ?? ls.score;
          return sum + (isNaN(parseInt(v, 10)) ? 0 : parseInt(v, 10));
        }, 0);
      }

      // Thru (holes completed in current round)
      const thru = c.status?.thru ?? c.thru ?? null;

      // Tee time (only relevant pre-round)
      const teeTimeRaw = c.teeTime || c.status?.teeTime || null;
      const teeTime = formatTeeTime(teeTimeRaw);

      // Status: 'active', 'cut', 'wd', 'pre' (not yet started)
      const statusName = (
        c.status?.type?.name ||
        c.status?.type?.description ||
        c.status?.name ||
        c.statusName || ''
      ).toLowerCase();

      const started = thru !== null && thru !== undefined;
      const cut = statusName.includes('cut') || statusName.includes('wd') || statusName.includes('withdraw') || statusName.includes('dq');

      return {
        name,
        position: pos && !cut ? formatPosition(pos, tied) : null,
        score: formatScore(score),
        thru: started ? (thru === 18 ? 'F' : thru) : null,
        teeTime,
        started,
        cut,
        status: cut ? 'cut' : started ? 'active' : 'pre',
      };
    }).filter(p => p.name);

    return res.status(200).json({
      players,
      tournament,
      round: currentRound,
      state: eventState, // 'pre', 'in', 'post'
    });

  } catch (err) {
    return res.status(503).json({ error: err.message });
  }
}
