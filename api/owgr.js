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
      // Fetch the page to get current chunk filenames
      const pageResp = await fetch('https://www.owgr.com/current-world-ranking', {
        headers: { 'User-Agent': HEADERS['User-Agent'], 'Accept': 'text/html', 'Referer': 'https://www.owgr.com/' },
      });
      const html = await pageResp.text();

      // Get ALL chunk URLs (not just _app)
      const chunkUrls = [...html.matchAll(/src="(\/_next\/static\/chunks\/[^"]+\.js)"/g)]
        .map(m => `https://www.owgr.com${m[1]}`);

      // Scan every chunk — look for 200 chars around "apiweb" to see path construction
      const contexts = [];
      for (const chunkUrl of chunkUrls) {
        try {
          const r = await fetch(chunkUrl, { headers: { 'Referer': 'https://www.owgr.com/' } });
          if (!r.ok) continue;
          const js = await r.text();
          // Find all occurrences of "apiweb" and grab surrounding context
          let idx = 0;
          while ((idx = js.indexOf('apiweb', idx)) !== -1) {
            contexts.push({
              chunk: chunkUrl.split('/').pop(),
              context: js.slice(Math.max(0, idx - 100), idx + 200),
            });
            idx += 6;
            if (contexts.length >= 10) break;
          }
          if (contexts.length >= 10) break;
        } catch (_) {}
      }

      return res.status(200).json({ contexts });
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
  // Placeholder — will be updated once we know the exact endpoint
  return [];
}
