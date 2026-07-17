// api/owgr.js — Vercel serverless function
// Fetches current OWGR world rankings from apiweb.owgr.com
// Endpoint discovered from JS bundle: owgr/rankings/getRankings
// Response shape: { rankingsList: [{ rank, player: { fullName } }], totalNumberOfPages }
//
// Strategy: fetch page 1, read totalNumberOfPages, then fetch remaining pages
// in parallel. Capped at MAX_PAGES so a misconfigured OWGR response can't
// trigger a runaway parallel fetch. Previously this was a hardcoded PAGE_COUNT
// constant that had to be updated by hand each season — the new dynamic
// approach captures the full ranking depth automatically.

const API_URL = 'https://apiweb.owgr.com/api/owgr/rankings/getRankings';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.owgr.com/',
  'Origin': 'https://www.owgr.com',
};

// Safety cap. OWGR typically publishes ~600-1000 ranked players; at 200/page
// that's 3-5 pages. Setting the cap to 6 leaves headroom without exposing
// us to an unbounded fetch if OWGR ever returns a corrupt totalNumberOfPages.
// Bump if OWGR expands the ranking depth substantially in future.
const MAX_PAGES = 6;
const PAGE_SIZE = 200;

function buildUrl(page) {
  return `${API_URL}?pageSize=${PAGE_SIZE}&pageNumber=${page}&rankingDate=&regionId=0&countryId=0&categoryId=0`;
}

// Per-fetch AbortController timeout (mirrors pgatFetchAndParse in cron.js):
// pages are fetched in parallel, so one hung OWGR request must not stall the
// whole handler past the 10s Vercel budget.
async function fetchWithTimeout(url, options = {}, timeoutMs = 7000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Timeout (${timeoutMs}ms) fetching ${url}`);
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

function extractPlayers(data) {
  const out = [];
  const rows = data?.rankingsList;
  if (!rows?.length) return out;
  for (const row of rows) {
    const name = row.player?.fullName;
    const rank = row.rank;
    if (name && rank) out.push({ name: name.trim(), worldRank: rank });
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  // Cache for 1 hour on Vercel CDN; rankings don't change more often than weekly
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // Step 1: fetch page 1 to discover how many pages exist.
    const firstResp = await fetchWithTimeout(buildUrl(1), { headers: HEADERS });
    if (!firstResp.ok) throw new Error(`OWGR API returned ${firstResp.status} on page 1`);
    const firstData = await firstResp.json();

    const players = extractPlayers(firstData);

    // Step 2: determine remaining pages from totalNumberOfPages, capped at
    // MAX_PAGES. Falls back to just page 1 if the field is missing/invalid.
    const totalPages = Number(firstData?.totalNumberOfPages);
    const pagesToFetch = Number.isFinite(totalPages) && totalPages > 1
      ? Math.min(totalPages, MAX_PAGES)
      : 1;

    // Step 3: fetch pages 2..pagesToFetch in parallel.
    if (pagesToFetch > 1) {
      const remainingPageNums = Array.from({ length: pagesToFetch - 1 }, (_, i) => i + 2);
      const results = await Promise.all(
        remainingPageNums.map(async (page) => {
          const resp = await fetchWithTimeout(buildUrl(page), { headers: HEADERS });
          if (!resp.ok) throw new Error(`OWGR API returned ${resp.status} on page ${page}`);
          return resp.json();
        })
      );
      for (const data of results) {
        for (const p of extractPlayers(data)) players.push(p);
      }
    }

    if (!players.length) return res.status(404).json({ error: 'No ranking data returned' });

    return res.status(200).json({
      players,
      count: players.length,
      pagesFetched: pagesToFetch,
      // Surface the API's totalNumberOfPages so callers can detect if our cap
      // was hit (would mean OWGR added more pages than MAX_PAGES — bump the cap).
      totalPages: Number.isFinite(totalPages) ? totalPages : null,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
