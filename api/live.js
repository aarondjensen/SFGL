// api/live.js — Vercel serverless function
// Scrapes live leaderboard from pgatour.com/leaderboard using __NEXT_DATA__,
// the same technique used by pga-results.js for past results.
//
// Response: { state, eventName, players: [{ name, score, totalScore, position, thru, isCut, isWD }] }

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

// Walk the full JSON tree looking for leaderboard player objects
function extractPlayers(nd) {
  const players = [];
  const seen = new Set();

  const walk = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { obj.forEach(walk); return; }

    // Look for objects that have a player name + score/position fields
    const name = obj.player?.displayName || obj.player?.fullName ||
                 obj.displayName || obj.fullName || obj.playerName;
    const hasScoreField = 'total' in obj || 'score' in obj || 'totalScore' in obj ||
                          'scoreToPar' in obj || 'totalStrokes' in obj;

    if (name && hasScoreField && !seen.has(name)) {
      seen.add(name);

      // Score to par
      const rawScore = obj.total ?? obj.score ?? obj.scoreToPar ?? obj.totalScore ?? 0;
      const totalScore = parseInt(rawScore, 10) || 0;
      const score = totalScore < 0 ? `${totalScore}` : totalScore > 0 ? `+${totalScore}` : 'E';

      // Position
      const position = obj.position?.displayName || obj.position || obj.positionDisplay || '';

      // Thru / status
      const thruRaw = obj.thru ?? obj.thruHole ?? obj.currentHole ?? '';
      const statusStr = (obj.status || obj.roundStatus || obj.playerState || '').toString().toLowerCase();
      const isCut = statusStr.includes('cut') || obj.isCut === true || obj.madeCut === false;
      const isWD  = statusStr.includes('wd') || statusStr.includes('withdraw') || obj.isWD === true;

      let thru = '';
      if (obj.thru === 18 || statusStr === 'f' || statusStr === 'finished' || statusStr === 'complete') {
        thru = 'F';
      } else if (thruRaw !== '' && thruRaw !== null && thruRaw !== undefined) {
        const n = parseInt(thruRaw, 10);
        if (!isNaN(n) && n > 0) thru = n.toString();
        else if (!isNaN(n) && n === 0) thru = '0';
      }

      players.push({ name, score, totalScore, position: position.toString(), thru, isCut, isWD });
    }

    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object') walk(v);
    }
  };

  walk(nd);
  return players;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { debug } = req.query;

  try {
    const resp = await fetch('https://www.pgatour.com/leaderboard', { headers: HEADERS });
    if (!resp.ok) return res.status(502).json({ error: `pgatour.com/leaderboard returned ${resp.status}` });

    const html = await resp.text();
    const nd   = extractNextData(html);

    if (!nd) return res.status(200).json({ state: 'pre', players: [], debug: 'no __NEXT_DATA__' });

    if (debug === '1') {
      const topKeys     = Object.keys(nd);
      const propsKeys   = nd.props ? Object.keys(nd.props) : [];
      const ppKeys      = nd.props?.pageProps ? Object.keys(nd.props.pageProps) : [];
      const players     = extractPlayers(nd);
      return res.status(200).json({
        topKeys, propsKeys, ppKeys,
        playerCount: players.length,
        samplePlayers: players.slice(0, 5),
        htmlLength: html.length,
      });
    }

    const players = extractPlayers(nd);

    // Determine state from whether anyone has started
    const anyStarted = players.some(p => p.thru !== '' || p.isCut || p.isWD);
    const anyFinished = players.some(p => p.thru === 'F');
    const state = anyFinished ? 'post' : anyStarted ? 'in' : 'pre';

    return res.status(200).json({ state, players });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
