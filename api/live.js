// api/live.js — Vercel serverless function
// Uses ESPN's public scoreboard API (CORS-safe, no auth needed).
// The scoreboard already contains live scores during in-progress events.
//
// Response: { state, eventName, players: [{ name, score, totalScore, position, thru, isCut, isWD }] }

const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard';

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
    const sbResp = await fetch(SCOREBOARD, { headers: HEADERS });
    if (!sbResp.ok) return res.status(502).json({ error: `ESPN scoreboard ${sbResp.status}` });

    const sbData = await sbResp.json();
    const event  = (sbData.events || [])[0];
    if (!event) return res.status(200).json({ state: 'pre', players: [] });

    const eventName = event.name;
    const sbState   = event.status?.type?.state || 'pre';
    const competition = event.competitions?.[0];
    const competitors = competition?.competitors || [];

    if (debug === '1') {
      return res.status(200).json({
        eventName, sbState,
        competitorCount: competitors.length,
        sampleKeys: competitors[0] ? Object.keys(competitors[0]) : [],
        statusSample: competitors[0]?.status,
        scoreSample:  competitors[0]?.score,
        linescoresSample: competitors[0]?.linescores?.slice(0, 2),
        sample: competitors.slice(0, 3),
      });
    }

    const players = competitors.map(c => {
      const name = c.athlete?.displayName || c.displayName || '';
      if (!name) return null;

      // Score to par
      const scoreVal = c.score?.value ?? c.score?.displayValue;
      let totalScore = 0;
      let score = 'E';
      if (scoreVal !== undefined && scoreVal !== null) {
        const n = parseInt(scoreVal, 10);
        if (!isNaN(n)) {
          totalScore = n;
          score = n < 0 ? `${n}` : n > 0 ? `+${n}` : 'E';
        }
      }

      const statusDesc  = (c.status?.type?.description || '').toLowerCase();
      const statusName  = (c.status?.type?.name        || '').toLowerCase();
      const statusState = (c.status?.type?.state       || '').toLowerCase();

      const isCut = statusDesc.includes('cut') || statusName.includes('cut');
      const isWD  = statusDesc.includes('withdraw') || statusName.includes('wd');

      // thru: "F" if finished, hole number if in progress, "" if not started
      let thru = '';
      if (statusDesc.includes('finish') || statusName === 'final' || c.status?.thru === 18) {
        thru = 'F';
      } else if (c.status?.thru != null && c.status.thru > 0) {
        thru = c.status.thru.toString();
      } else if (c.status?.thru === 0 && statusState === 'in') {
        thru = '0'; // started but on hole 1
      }

      const position = c.status?.position?.displayName || c.status?.position?.id || '';

      return { name, score, totalScore, position, thru, isCut, isWD };
    }).filter(Boolean);

    return res.status(200).json({ state: sbState, eventName, players });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
