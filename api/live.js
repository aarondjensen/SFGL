// api/live.js — Vercel serverless function

const SCOREBOARD  = 'https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.espn.com/',
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
    // Step 1: get current event from scoreboard
    const sbResp = await fetch(SCOREBOARD, { headers: HEADERS });
    if (!sbResp.ok) throw new Error(`Scoreboard ${sbResp.status}`);
    const sbData = await sbResp.json();

    const events = sbData?.events || [];
    if (!events.length) return res.status(404).json({ error: 'No active event on scoreboard' });

    const event = events[0];
    const eventId = event.id;
    const tournament = event.name;
    const currentRound = event.competitions?.[0]?.status?.period || 1;
    const eventState = event.status?.type?.state || 'pre';

    if (isDebug) {
      // Return raw event structure so we can find the right leaderboard URL
      return res.status(200).json({
        eventId,
        tournament,
        round: currentRound,
        state: eventState,
        eventKeys: Object.keys(event),
        competitionKeys: event.competitions?.[0] ? Object.keys(event.competitions[0]) : [],
        competitorCount: event.competitions?.[0]?.competitors?.length || 0,
        sampleCompetitor: event.competitions?.[0]?.competitors?.[0]
          ? JSON.stringify(event.competitions[0].competitors[0]).slice(0, 800)
          : null,
        links: event.links?.map(l => l.href).slice(0, 5),
      });
    }

    // Step 2: competitors are already in the scoreboard response
    const competitors = event.competitions?.[0]?.competitors || [];
    if (!competitors.length) {
      return res.status(200).json({ players: [], tournament, round: currentRound, state: eventState });
    }

    const posCounts = {};
    competitors.forEach(c => { if (c.sortOrder) posCounts[c.sortOrder] = (posCounts[c.sortOrder] || 0) + 1; });

    const players = competitors.map(c => {
      const name = c.athlete?.displayName || c.displayName || '';
      if (!name) return null;

      const pos = c.sortOrder;
      const posDisplay = pos ? ((posCounts[pos] > 1) ? `T${pos}` : `${pos}`) : null;

      // Score to par from statistics array
      let scoreNum = null;
      const scoreStat = (c.statistics || []).find(s =>
        s.name === 'scoreToPar' || s.abbreviation === 'SCORE' || s.name === 'score' || s.name === 'totalScore'
      );
      if (scoreStat) {
        const v = scoreStat.displayValue;
        scoreNum = v === 'E' ? 0 : parseInt(v, 10);
      }
      // Fallback: linescores
      if (scoreNum === null && c.linescores?.length) {
        const total = c.linescores.reduce((sum, ls) => {
          const v = parseInt(ls.value ?? ls.score ?? ls.displayValue, 10);
          return sum + (isNaN(v) ? 0 : v);
        }, 0);
        if (total !== 0) scoreNum = total;
      }

      const thruVal = c.status?.thru ?? c.thru;
      const thru = thruVal != null ? (thruVal === 18 ? 'F' : `${thruVal}`) : null;
      const started = thru !== null;

      const teeTime = formatTeeTime(c.teeTime || c.status?.teeTime);

      const statusStr = (c.status?.type?.name || c.status?.type?.description || '').toLowerCase();
      const cut = statusStr.includes('cut') || statusStr.includes('wd') || statusStr.includes('withdraw') || statusStr.includes('dq');

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
