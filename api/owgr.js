// api/owgr.js — Vercel serverless function
// Fetches current OWGR world rankings from apiweb.owgr.com

const API_URL = 'https://apiweb.owgr.com/api/owgr/rankings/getRankings';
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

  try {
    const players = [];

    for (let page = 1; page <= 5; page++) {
      const url = `${API_URL}?pageSize=200&pageNumber=${page}&rankingDate=&regionId=0&countryId=0&categoryId=0`;
      const resp = await fetch(url, { headers: HEADERS });

      if (!resp.ok) {
        if (page === 1) return res.status(resp.status).json({ error: `OWGR API returned ${resp.status}` });
        break;
      }

      const data = await resp.json();

      // Discover the shape on first page if debug requested
      if (page === 1 && req.query.debug === '1') {
        return res.status(200).json({ sample: data });
      }

      const rows = data.rankings || data.rankingsList || data.data ||
        data.rankingList || data.players || (Array.isArray(data) ? data : null);

      if (!rows?.length) break;

      for (const row of rows) {
        const name = row.playerName || row.name || row.fullName ||
          [row.firstName, row.lastName].filter(Boolean).join(' ').trim();
        const rank = row.rank || row.worldRanking || row.rankingPosition || row.position;
        if (name && rank) players.push({ name: name.trim(), worldRank: parseInt(rank) });
      }

      if (rows.length < 200) break; // last page
    }

    if (!players.length) return res.status(404).json({ error: 'No ranking data returned' });

    return res.status(200).json({ players, count: players.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
