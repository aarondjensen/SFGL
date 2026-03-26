// api/live.js — pgatour.com/leaderboard → dehydratedState → leaderboard query → players[].scoringData

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

  try {
    const resp = await fetch('https://www.pgatour.com/leaderboard', { headers: HEADERS });
    if (!resp.ok) return res.status(502).json({ error: `pgatour.com ${resp.status}` });

    const html = await resp.text();
    const nd   = extractNextData(html);
    if (!nd) return res.status(200).json({ state: 'pre', players: [] });

    const queries = nd.props?.pageProps?.dehydratedState?.queries || [];
    const lbQuery = queries.find(q => Array.isArray(q.queryKey) && q.queryKey[0] === 'leaderboard');
    const lbData  = lbQuery?.state?.data;

    if (!lbData?.players?.length) {
      return res.status(200).json({ state: 'pre', players: [] });
    }

    const players = lbData.players.map(row => {
      const name = row.player?.displayName;
      if (!name) return null;

      const sd = row.scoringData || {};

      // Score: sd.total is "-5", "+2", "E", "0"
      const totalRaw = sd.total ?? '0';
      const totalScore = parseInt(totalRaw, 10) || 0;
      const score = totalScore < 0 ? `${totalScore}` : totalScore > 0 ? `+${totalScore}` : 'E';

      // Position: sd.position is "T1", "1", "CUT" etc
      const position = sd.position || '';

      // Thru: "F*" or "F" = finished, "9" = thru 9, "-" or "" = not started
      const thruRaw = (sd.thru || '').replace('*', '').trim();
      const playerState = (sd.playerState || '').toUpperCase();
      let thru = '';
      if (playerState === 'COMPLETE' || thruRaw === 'F') {
        thru = 'F';
      } else if (thruRaw && thruRaw !== '-') {
        const n = parseInt(thruRaw, 10);
        if (!isNaN(n)) thru = n.toString();
      }

      const isCut = playerState === 'CUT' || position === 'CUT';
      const isWD  = playerState === 'WD'  || position === 'WD';

      return { name, score, totalScore, position, thru, isCut, isWD };
    }).filter(Boolean);

    const anyStarted = players.some(p => p.thru !== '' || p.isCut || p.isWD);
    const state = anyStarted ? 'in' : 'pre';

    return res.status(200).json({ state, players });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
