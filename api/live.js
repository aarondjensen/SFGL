// api/live.js — scrapes pgatour.com/leaderboard __NEXT_DATA__ → dehydratedState

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Referer': 'https://www.pgatour.com/',
};

function extractNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { debug } = req.query;

  try {
    const resp = await fetch('https://www.pgatour.com/leaderboard', { headers: HEADERS });
    if (!resp.ok) return res.status(502).json({ error: `pgatour.com ${resp.status}` });

    const html = await resp.text();
    const nd   = extractNextData(html);
    if (!nd) return res.status(200).json({ state: 'pre', players: [], note: 'no __NEXT_DATA__' });

    const dehydrated = nd.props?.pageProps?.dehydratedState;

    if (debug === '1') {
      // Show the structure of dehydratedState so we can find players
      const queries = dehydrated?.queries || [];
      return res.status(200).json({
        queryCount: queries.length,
        queryKeys: queries.map(q => JSON.stringify(q.queryKey)).slice(0, 20),
        // Show first query that has substantial data
        firstBigQuery: queries.find(q => JSON.stringify(q.state?.data || {}).length > 500)
          ? {
              key: queries.find(q => JSON.stringify(q.state?.data || {}).length > 500).queryKey,
              dataKeys: Object.keys(queries.find(q => JSON.stringify(q.state?.data || {}).length > 500).state?.data || {}),
              dataSample: JSON.stringify(queries.find(q => JSON.stringify(q.state?.data || {}).length > 500).state?.data || {}).slice(0, 1000),
            }
          : null,
      });
    }

    // Walk dehydratedState queries to find leaderboard players
    const queries = dehydrated?.queries || [];
    const players = [];
    const seen = new Set();

    const normScore = (v) => {
      if (v === null || v === undefined || v === 'E') return { totalScore: 0, score: 'E' };
      const n = parseInt(v, 10);
      if (isNaN(n)) return { totalScore: 0, score: 'E' };
      return { totalScore: n, score: n < 0 ? `${n}` : n > 0 ? `+${n}` : 'E' };
    };

    const walkForPlayers = (obj) => {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) { obj.forEach(walkForPlayers); return; }

      const name = obj.player?.displayName || obj.player?.fullName ||
                   obj.displayName || obj.fullName || obj.playerName;

      if (name && !seen.has(name)) {
        const hasRelevantField = 'total' in obj || 'scoreToPar' in obj || 'thru' in obj ||
                                  'position' in obj || 'status' in obj || obj.player;
        if (hasRelevantField) {
          seen.add(name);
          const raw = obj.total ?? obj.scoreToPar ?? obj.score ?? obj.player?.total ?? obj.player?.scoreToPar ?? 0;
          const { totalScore, score } = normScore(raw);
          const pos = (obj.position?.displayName || obj.position || obj.currentPosition || '').toString();
          const statusStr = (obj.status || obj.roundStatus || '').toString().toLowerCase();
          const isCut = statusStr.includes('cut') || obj.isCut === true;
          const isWD  = statusStr.includes('wd') || statusStr.includes('withdraw');

          const thruRaw = obj.thru ?? obj.thruHole ?? obj.currentHole;
          let thru = '';
          if (statusStr === 'f' || statusStr === 'finished' || statusStr === 'complete' || thruRaw === 18) {
            thru = 'F';
          } else if (thruRaw != null) {
            const n = parseInt(thruRaw, 10);
            if (!isNaN(n) && n >= 0) thru = n.toString();
          }

          players.push({ name, score, totalScore, position: pos, thru, isCut, isWD });
        }
      }

      for (const v of Object.values(obj)) {
        if (v && typeof v === 'object') walkForPlayers(v);
      }
    };

    for (const q of queries) {
      walkForPlayers(q.state?.data);
    }

    const anyStarted = players.some(p => p.thru !== '' || p.isCut || p.isWD);
    const state = anyStarted ? 'in' : 'pre';

    return res.status(200).json({ state, players });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
