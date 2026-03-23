// api/owgr.js — Vercel serverless function
// Fetches current OWGR world rankings from apiweb.owgr.com
// Endpoint discovered from JS bundle: owgr/rankings/getRankings
// Response shape: { rankingsList: [{ rank, player: { fullName } }], totalNumberOfPages }
//
// UPDATE EACH SEASON: verify pageSize/pageNumber params still work with OWGR API.

const API_URL = 'https://apiweb.owgr.com/api/owgr/rankings/getRankings';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.owgr.com/',
  'Origin': 'https://www.owgr.com',
};

const PAGE_COUNT = 2; // top 400 players (200 per page) — client slices to 250

function buildUrl(page) {
  return `${API_URL}?pageSize=200&pageNumber=${page}&rankingDate=&regionId=0&countryId=0&categoryId=0`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  // Cache for 1 hour on Vercel CDN; rankings don't change more often than weekly
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // Fetch all pages in parallel instead of sequentially — ~3x faster
    const pageNums = Array.from({ length: PAGE_COUNT }, (_, i) => i + 1);
    const results = await Promise.all(
      pageNums.map(async (page) => {
        const resp = await fetch(buildUrl(page), { headers: HEADERS });
        if (!resp.ok) throw new Error(`OWGR API returned ${resp.status} on page ${page}`);
        return resp.json();
      })
    );

    const players = [];
    for (const data of results) {
      const rows = data.rankingsList;
      if (!rows?.length) break;
      for (const row of rows) {
        const name = row.player?.fullName;
        const rank = row.rank;
        if (name && rank) players.push({ name: name.trim(), worldRank: rank });
      }
    }

    if (!players.length) return res.status(404).json({ error: 'No ranking data returned' });

    return res.status(200).json({ players, count: players.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
