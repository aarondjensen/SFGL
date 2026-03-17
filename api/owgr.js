// api/owgr.js — Vercel serverless function

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Referer': 'https://www.owgr.com/',
  'Origin': 'https://www.owgr.com',
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const debug = req.query.debug === '1';

  if (debug) {
    try {
      const pageResp = await fetch('https://www.owgr.com/current-world-ranking', {
        headers: { 'User-Agent': HEADERS['User-Agent'], 'Accept': 'text/html', 'Referer': 'https://www.owgr.com/' },
      });
      const html = await pageResp.text();
      const chunkUrls = [...html.matchAll(/src="(\/_next\/static\/chunks\/[^"]+\.js)"/g)]
        .map(m => `https://www.owgr.com${m[1]}`);

      // Get ALL apiweb paths from ALL chunks — extract just the path segment after /api/
      const allPaths = new Set();
      for (const chunkUrl of chunkUrls) {
        try {
          const r = await fetch(chunkUrl, { headers: { 'Referer': 'https://www.owgr.com/' } });
          if (!r.ok) continue;
          const js = await r.text();
          for (const m of js.matchAll(/apiweb\.owgr\.com\/api\/["'`],["'`]([^"'`\s,)]{3,80})/g)) {
            allPaths.add(m[1]);
          }
          // Also try direct concat pattern
          for (const m of js.matchAll(/apiweb\.owgr\.com\/api\/([a-zA-Z][^"'`\s\\]{3,80})/g)) {
            allPaths.add(m[1]);
          }
        } catch (_) {}
      }

      return res.status(200).json({ paths: [...allPaths] });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  try {
    const players = await fetchRankings();
    if (!players.length) return res.status(404).json({ error: 'No ranking data returned' });
    return res.status(200).json({ players, count: players.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function fetchRankings() {
  return [];
}
