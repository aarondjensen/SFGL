// api/live.js — scrapes pgatour.com/leaderboard __NEXT_DATA__ → dehydratedState
// Targets the "leaderboard" query key specifically.

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

    const queries = nd.props?.pageProps?.dehydratedState?.queries || [];

    // Find the leaderboard query
    const lbQuery = queries.find(q =>
      Array.isArray(q.queryKey) && q.queryKey[0] === 'leaderboard'
    );

    if (debug === '1') {
      return res.status(200).json({
        lbQueryFound: !!lbQuery,
        lbDataKeys: lbQuery ? Object.keys(lbQuery.state?.data || {}) : [],
        lbDataSample: lbQuery ? JSON.stringify(lbQuery.state?.data || {}).slice(0, 2000) : null,
      });
    }

    if (!lbQuery?.state?.data) {
      return res.status(200).json({ state: 'pre', players: [], note: 'no leaderboard query data' });
    }

    const lbData = lbQuery.state.data;

    // Walk the leaderboard data to find player rows
    const players = [];
    const seen = new Set();

    const normScore = (v) => {
      if (v === null || v === undefined || v === 'E' || v === 0) return { totalScore: 0, score: 'E' };
      const n = parseInt(v, 10);
      if (isNaN(n)) return { totalScore: 0, score: 'E' };
      return { totalScore: n, score: n < 0 ? `${n}` : `+${n}` };
    };

    const walkForPlayers = (obj) => {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) { obj.forEach(walkForPlayers); return; }

      const name = obj.player?.displayName || obj.player?.fullName ||
                   obj.displayName || obj.fullName;

      if (name && !seen.has(name)) {
        const hasPosOrScore = 'total' in obj || 'scoreToPar' in obj || 'thru' in obj ||
                              'position' in obj || 'currentPosition' in obj || 'status' in obj;
        if (hasPosOrScore) {
          seen.add(name);

          const raw = obj.total ?? obj.scoreToPar ?? obj.player?.total ?? obj.player?.scoreToPar ?? 0;
          const { totalScore, score } = normScore(raw);

          const pos = (obj.position?.displayName || obj.currentPosition || obj.position || '').toString();
          const statusStr = (obj.status || obj.roundStatus || '').toString().toUpperCase();
          const isCut = statusStr.includes('CUT') || obj.isCut === true;
          const isWD  = statusStr.includes('WD') || statusStr.includes('WITHDRAW');

          const thruRaw = obj.thru ?? obj.thruHole ?? obj.currentHole;
          let thru = '';
          if (statusStr === 'F' || statusStr === 'FINISHED' || statusStr === 'COMPLETE' || thruRaw === 18) {
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

    walkForPlayers(lbData);

    const anyStarted = players.some(p => p.thru !== '' || p.isCut || p.isWD);
    const state = anyStarted ? 'in' : 'pre';

    return res.status(200).json({ state, players });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
