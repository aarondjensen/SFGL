// api/owgr.js — Vercel serverless function
// Fetches current OWGR world rankings from apiweb.owgr.com
// Endpoint discovered from JS bundle: owgr/rankings/getRankings
// Response shape: { rankingsList: [{ rank, player: { fullName } }], totalNumberOfPages }

const API_URL = 'https://apiweb.owgr.com/api/owgr/rankings/getRankings';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.owgr.com/',
  'Origin': 'https://www.owgr.com',
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const players = [];
    // Fetch top 500 (pages of 200, so 3 pages)
    for (let page = 1; page <= 3; page++) {
      const url = `${API_URL}?pageSize=200&pageNumber=${page}&rankingDate=&regionId=0&countryId=0&categoryId=0`;
      const resp = await fetch(url, { headers: HEADERS });
      if (!resp.ok) throw new Error(`OWGR API returned ${resp.status} on page ${page}`);

      const data = await resp.json();
      const rows = data.rankingsList;
      if (!rows?.length) break;

      for (const row of rows) {
        const name = row.player?.fullName;
        const rank = row.rank;
        if (name && rank) players.push({ name: name.trim(), worldRank: rank });
      }

      if (page >= data.totalNumberOfPages) break;
    }

    if (!players.length) return res.status(404).json({ error: 'No ranking data returned' });

    return res.status(200).json({ players, count: players.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
