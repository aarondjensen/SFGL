// api/live.js — Vercel serverless function
// Returns live leaderboard data for the current/upcoming PGA Tour event.
//
// Uses ESPN scoreboard — tries today + next 7 days to find a non-completed event.
// During 'pre' state: returns tee times only (no scores yet)
// During 'in' state: returns live scores + positions + thru
// During 'post' state: returns final scores
//
// GET /api/live          → { players, tournament, round, state }
// GET /api/live?debug=1  → diagnostic

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.espn.com/',
};

function toESPNDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function formatTeeTime(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: true,
      timeZone: 'America/New_York',
    });
  } catch { return null; }
}

// Find an upcoming or in-progress event, skipping completed ones
async function findEvent() {
  for (let offset = 0; offset <= 7; offset++) {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    const dateStr = toESPNDate(d);
    try {
      const resp = await fetch(
        `https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard?dates=${dateStr}`,
        { headers: HEADERS }
      );
      if (!resp.ok) continue;
      const data = await resp.json();
      const events = data?.events || [];
      const nonPost = events.filter(e => e.status?.type?.state !== 'post');
      if (nonPost.length > 0) {
        // Prefer 'in' over 'pre'
        return nonPost.find(e => e.status?.type?.state === 'in') || nonPost[0];
      }
    } catch { continue; }
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const isDebug = req.query.debug === '1';

  try {
    const event = await findEvent();

    if (!event) {
      return res.status(404).json({ error: 'No upcoming or active event found' });
    }

    const eventId    = event.id;
    const tournament = event.name;
    const round      = event.competitions?.[0]?.status?.period || 1;
    const state      = event.status?.type?.state || 'pre'; // 'pre', 'in', 'post'
    const competitors = event.competitions?.[0]?.competitors || [];

    if (isDebug) {
      return res.status(200).json({
        eventId, tournament, round, state,
        competitorCount: competitors.length,
        sample: competitors[0] ? JSON.stringify(competitors[0]).slice(0, 600) : null,
      });
    }

    if (!competitors.length) {
      return res.status(200).json({ players: [], tournament, round, state });
    }

    // Count position occurrences for tie detection
    const posCounts = {};
    competitors.forEach(c => {
      if (c.sortOrder) posCounts[c.sortOrder] = (posCounts[c.sortOrder] || 0) + 1;
    });

    const players = competitors.map(c => {
      const name = c.athlete?.displayName || c.athlete?.fullName || c.displayName || '';
      if (!name) return null;

      // Score is a pre-formatted string like "-11", "E", "+3" in ESPN's scoreboard
      const scoreRaw = c.score;
      const score = scoreRaw === '0' ? 'E' : (scoreRaw || null);

      // Position
      const pos = c.sortOrder;
      const posDisplay = pos ? ((posCounts[pos] > 1) ? `T${pos}` : `${pos}`) : null;

      // Thru — from status
      const thruVal = c.status?.thru ?? c.thru;
      const thru = thruVal != null ? (Number(thruVal) === 18 ? 'F' : `${thruVal}`) : null;
      const started = thru !== null;

      // Tee time
      const teeTime = formatTeeTime(c.teeTime || c.status?.teeTime);

      // Cut / WD
      const statusStr = (c.status?.type?.name || c.status?.type?.description || '').toLowerCase();
      const cut = statusStr.includes('cut') || statusStr.includes('wd') ||
                  statusStr.includes('withdraw') || statusStr.includes('dq');

      return {
        name,
        position: (!cut && posDisplay) ? posDisplay : null,
        score: cut ? null : score,
        thru: started ? thru : null,
        teeTime,
        started,
        cut,
        status: cut ? 'cut' : started ? 'active' : 'pre',
      };
    }).filter(Boolean);

    return res.status(200).json({ players, tournament, round, state });

  } catch (err) {
    return res.status(503).json({ error: err.message });
  }
}
