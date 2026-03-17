// api/owgr.js — Vercel serverless function
// Fetches current OWGR world rankings from apiweb.owgr.com

const API_BASE = 'https://apiweb.owgr.com/api';
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

  // ── Debug: scan _app bundle for all API paths ─────────────────────────────
  if (debug) {
    try {
      // Fetch the page to get the current _app chunk filename
      const pageResp = await fetch('https://www.owgr.com/current-world-ranking', {
        headers: { 'User-Agent': HEADERS['User-Agent'], 'Accept': 'text/html', 'Referer': 'https://www.owgr.com/' },
      });
      const html = await pageResp.text();
      const appChunk = html.match(/src="(\/_next\/static\/chunks\/pages\/_app-[^"]+\.js)"/)?.[1];

      let apiPaths = [];
      if (appChunk) {
        const chunkResp = await fetch(`https://www.owgr.com${appChunk}`, { headers: HEADERS });
        const js = await chunkResp.text();
        // Extract everything after "apiweb.owgr.com/api/"
        apiPaths = [...new Set(
          [...js.matchAll(/apiweb\.owgr\.com\/api\/([^"'`\s\\]{2,80})/g)].map(m => m[1])
        )];
      }

      // Also try some common endpoint guesses directly
      const guesses = [
        `${API_BASE}/owgr/ranking/rankings?pageSize=10&pageNumber=1`,
        `${API_BASE}/owgr/rankings?pageSize=10&pageNumber=1`,
        `${API_BASE}/ranking/rankings?pageSize=10&pageNumber=1`,
        `${API_BASE}/rankings?pageSize=10&pageNumber=1`,
        `${API_BASE}/owgr/ranking/getRanking?pageSize=10&pageNumber=1`,
        `${API_BASE}/owgr/ranking/ranking-list?pageSize=10&pageNumber=1`,
      ];
      const guessResults = {};
      for (const url of guesses) {
        try {
          const r = await fetch(url, { headers: HEADERS });
          guessResults[url] = { status: r.status, sample: (await r.text()).slice(0, 200) };
        } catch (e) {
          guessResults[url] = { error: e.message };
        }
      }

      return res.status(200).json({ appChunk, apiPaths, guessResults });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── Fetch rankings ────────────────────────────────────────────────────────
  try {
    const players = await fetchRankings();
    if (!players.length) {
      return res.status(404).json({ error: 'No ranking data returned' });
    }
    return res.status(200).json({ players, count: players.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function fetchRankings() {
  // Try known endpoint patterns, paginate up to 500 players
  const endpointCandidates = [
    'owgr/ranking/rankings',
    'owgr/rankings',
    'ranking/rankings',
    'rankings',
    'owgr/ranking/getRanking',
    'owgr/ranking/ranking-list',
  ];

  for (const endpoint of endpointCandidates) {
    try {
      const players = [];
      for (let page = 1; page <= 3; page++) {
        const url = `${API_BASE}/${endpoint}?pageSize=200&pageNumber=${page}&rankingDate=&regionId=0&countryId=0&categoryId=0`;
        const resp = await fetch(url, { headers: HEADERS });
        if (!resp.ok) break;

        const data = await resp.json();
        const rows = data.rankings || data.rankingsList || data.data ||
          data.rankingList || data.players || (Array.isArray(data) ? data : null);
        if (!rows?.length) break;

        for (const row of rows) {
          const name = row.playerName || row.name || row.fullName ||
            [row.firstName, row.lastName].filter(Boolean).join(' ');
          const rank = row.rank || row.worldRanking || row.rankingPosition || row.position;
          if (name?.trim() && rank) players.push({ name: name.trim(), worldRank: parseInt(rank) });
        }
        if (rows.length < 200) break;
      }
      if (players.length > 0) {
        console.log(`[owgr] Success with endpoint: ${endpoint}, ${players.length} players`);
        return players;
      }
    } catch (_) {}
  }
  return [];
}
