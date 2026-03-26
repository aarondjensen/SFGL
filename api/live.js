// api/live.js — Vercel serverless function
// Returns live leaderboard scores from ESPN scoreboard + leaderboard APIs.
// Score fields match the golfUtils.js pattern: thru, totalScore, position, isCut, isWD.
//
// Response: { state, eventName, players: [{ name, score, totalScore, position, thru, started, cut, isCut, isWD }] }
//   state: 'pre' | 'in' | 'post'
//   score: display string e.g. "-8", "+2", "E"
//   totalScore: integer e.g. -8, 2, 0
//   thru: "F" | "6" | "10:05 AM" | ""

const SCOREBOARD  = 'https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard';
const LEADERBOARD = 'https://site.web.api.espn.com/apis/v2/sports/golf/pga/leaderboard';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.espn.com/',
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { debug } = req.query;

  try {
    // ── Step 1: current event from scoreboard ─────────────────────────────────
    const sbResp = await fetch(SCOREBOARD, { headers: HEADERS });
    if (!sbResp.ok) return res.status(502).json({ error: `Scoreboard ${sbResp.status}` });
    const sbData = await sbResp.json();
    const event  = (sbData.events || [])[0];
    if (!event) return res.status(200).json({ state: 'pre', players: [] });

    const eventId   = event.id;
    const eventName = event.name;
    const sbState   = event.status?.type?.state || 'pre'; // 'pre' | 'in' | 'post'

    // ── Step 2: live leaderboard ──────────────────────────────────────────────
    const lbResp = await fetch(`${LEADERBOARD}?event=${eventId}`, { headers: HEADERS });
    if (!lbResp.ok) return res.status(502).json({ error: `Leaderboard ${lbResp.status}` });
    const lbData = await lbResp.json();

    const competitors =
      lbData.events?.[0]?.competitions?.[0]?.competitors ||
      lbData.competitions?.[0]?.competitors ||
      lbData.competitors ||
      [];

    if (debug === '1') {
      return res.status(200).json({
        eventId, eventName, sbState,
        competitorCount: competitors.length,
        sampleKeys: competitors[0] ? Object.keys(competitors[0]) : [],
        statusSample: competitors[0]?.status,
        scoreSample: competitors[0]?.score,
        linescoresSample: competitors[0]?.linescores?.slice(0, 2),
        sample: competitors.slice(0, 3).map(c => ({
          name: c.athlete?.displayName,
          score: c.score,
          status: c.status,
          linescores: c.linescores?.slice(0, 2),
          statistics: c.statistics?.slice(0, 2),
        })),
      });
    }

    // ── Step 3: map to our shape ──────────────────────────────────────────────
    const players = competitors.map(c => {
      const name = c.athlete?.displayName || c.displayName || '';
      if (!name) return null;

      // Score to par as integer and display string
      const scoreRaw = c.score?.value ?? c.score?.displayValue;
      let totalScore = 0;
      let score = 'E';
      if (scoreRaw !== undefined && scoreRaw !== null) {
        const n = parseInt(scoreRaw, 10);
        if (!isNaN(n)) {
          totalScore = n;
          score = n < 0 ? `${n}` : n > 0 ? `+${n}` : 'E';
        }
      }

      // Status details
      const statusDesc = (c.status?.type?.description || '').toLowerCase();
      const statusName = (c.status?.type?.name || '').toLowerCase();
      const statusState = (c.status?.type?.state || '').toLowerCase();

      const isCut = statusDesc.includes('cut') || statusName.includes('cut');
      const isWD  = statusDesc.includes('withdraw') || statusName.includes('wd');

      // Thru: "F" if finished, hole number if in progress, tee time if not started
      let thru = '';
      if (statusDesc.includes('finish') || statusName === 'final' || statusDesc === 'final') {
        thru = 'F';
      } else if (c.status?.thru != null && c.status.thru !== 0) {
        thru = c.status.thru.toString();
      } else if (statusState === 'pre' || statusName === 'scheduled') {
        // Try to get tee time from competitions tee time
        const teeTime = c.teeTime || c.status?.teeTime || '';
        if (teeTime) {
          // Format: "2026-04-10T13:42:00Z" → "1:42 PM"
          try {
            const d = new Date(teeTime);
            thru = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Chicago' });
          } catch { thru = teeTime; }
        }
      }

      // Position
      const position = c.status?.position?.displayName || c.status?.position?.id || '';

      const started = statusState !== 'pre' && statusState !== '' && !isCut && !isWD
        ? true
        : statusDesc === 'in progress' || (c.status?.thru != null && c.status.thru > 0);

      return { name, score, totalScore, position, thru, started, cut: isCut, isCut, isWD };
    }).filter(Boolean);

    return res.status(200).json({ state: sbState, eventName, players });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
