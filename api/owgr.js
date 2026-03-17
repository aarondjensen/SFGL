// api/owgr.js — Vercel serverless function
// Fetches current OWGR world rankings.
// Tries OWGR's internal API endpoints, falls back to scraping the rankings page.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const debug = req.query.debug === '1';

  try {
    const players = await fetchRankings(debug);

    if (!players.length) {
      return res.status(404).json({ error: 'No ranking data found — all fetch strategies failed. Try ?debug=1 for details.' });
    }

    return res.status(200).json({ players, count: players.length, source: players._source || 'owgr' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function fetchRankings(debug = false) {
  // ── Strategy 1: OWGR paginated JSON API ──────────────────────────────────
  // The OWGR website calls this endpoint internally (observed via network tab pattern)
  try {
    const players = [];
    let pageNumber = 1;
    const pageSize = 200;

    while (players.length < 500) {
      const url = `https://www.owgr.com/api/ranking/rankings?pageSize=${pageSize}&pageNumber=${pageNumber}&rankingDate=&regionId=0&countryId=0&categoryId=0`;
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Referer': 'https://www.owgr.com/current-world-ranking',
          'X-Requested-With': 'XMLHttpRequest',
        },
      });

      if (!resp.ok) break;
      const data = await resp.json();

      // Possible shapes: { rankings: [...] } or { data: [...] } or just [...]
      const rows = data.rankings || data.data || data.rankingList || (Array.isArray(data) ? data : null);
      if (!rows?.length) break;

      for (const row of rows) {
        const name = row.playerName || row.name || row.fullName ||
          [row.firstName, row.lastName].filter(Boolean).join(' ');
        const rank = row.rank || row.worldRanking || row.position || row.pos;
        if (name && rank) players.push({ name: name.trim(), worldRank: parseInt(rank) });
      }

      if (rows.length < pageSize) break; // last page
      pageNumber++;
    }

    if (players.length > 0) {
      console.log(`[owgr] Strategy 1 (JSON API): ${players.length} players`);
      players._source = 'owgr-api';
      return players;
    }
  } catch (err) {
    console.warn('[owgr] Strategy 1 failed:', err.message);
  }

  // ── Strategy 2: Alternative OWGR API path ─────────────────────────────────
  try {
    const players = [];
    for (let page = 1; page <= 3; page++) {
      const url = `https://www.owgr.com/ranking/ranking-list/get-ranking-list?pageSize=200&pageNumber=${page}&rankingDate=&regionId=0&countryId=0&categoryId=0`;
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept': 'application/json',
          'Referer': 'https://www.owgr.com/current-world-ranking',
        },
      });
      if (!resp.ok) break;
      const data = await resp.json();
      const rows = data.rankingsList || data.rankings || data.data || (Array.isArray(data) ? data : null);
      if (!rows?.length) break;
      for (const row of rows) {
        const name = row.playerName || row.name || [row.firstName, row.lastName].filter(Boolean).join(' ');
        const rank = row.rank || row.worldRanking || row.rankingPosition;
        if (name && rank) players.push({ name: name.trim(), worldRank: parseInt(rank) });
      }
      if (rows.length < 200) break;
    }
    if (players.length > 0) {
      console.log(`[owgr] Strategy 2 (alt API): ${players.length} players`);
      players._source = 'owgr-api-alt';
      return players;
    }
  } catch (err) {
    console.warn('[owgr] Strategy 2 failed:', err.message);
  }

  // ── Strategy 3: Find API endpoint from JS bundle ─────────────────────────
  // OWGR is a Next.js SPA — player data loads via XHR after mount.
  // Fetch the page to get chunk URLs, then scan the chunks for the API endpoint.
  try {
    const pageResp = await fetch('https://www.owgr.com/current-world-ranking', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html', 'Referer': 'https://www.owgr.com/' },
    });
    if (!pageResp.ok) throw new Error(`Page HTTP ${pageResp.status}`);
    const html = await pageResp.text();

    // Get all JS chunk URLs
    const chunkUrls = [...html.matchAll(/src="(\/_next\/static\/chunks\/[^"]+\.js)"/g)]
      .map(m => `https://www.owgr.com${m[1]}`);

    // Scan each chunk for API endpoint patterns
    let apiBase = null;
    for (const chunkUrl of chunkUrls) {
      try {
        const chunkResp = await fetch(chunkUrl, { headers: { 'Referer': 'https://www.owgr.com/' } });
        if (!chunkResp.ok) continue;
        const js = await chunkResp.text();
        // Look for patterns like: "https://api.owgr.com" or fetch("/api/rankings") or axios.get("...")
        const apiMatch = js.match(/["'`](https?:\/\/[^"'`]*owgr[^"'`]{0,50}(?:rank|player|list)[^"'`]{0,30})["'`]/i)
          || js.match(/["'`](\/api\/[^"'`]{5,60}(?:rank|player|list)[^"'`]{0,20})["'`]/i)
          || js.match(/baseURL\s*[:=]\s*["'`]([^"'`]{10,80})["'`]/i)
          || js.match(/["'`](https?:\/\/[^"'`]{10,80}owgr[^"'`]{0,40})["'`]/i);
        if (apiMatch) {
          apiBase = apiMatch[1];
          console.log(`[owgr] Found API pattern in ${chunkUrl}: ${apiBase}`);
          break;
        }
      } catch (_) {}
    }

    if (debug) {
      // Return what we found in the chunks
      const chunkSamples = {};
      for (const chunkUrl of chunkUrls.slice(0, 5)) {
        try {
          const r = await fetch(chunkUrl, { headers: { 'Referer': 'https://www.owgr.com/' } });
          const js = await r.text();
          const hits = [...js.matchAll(/["'`](https?:\/\/[^"'`]{10,100})["'`]/g)]
            .map(m => m[1])
            .filter(u => u.includes('owgr') || u.includes('rank') || u.includes('golf'))
            .slice(0, 5);
          if (hits.length) chunkSamples[chunkUrl.split('/').pop()] = hits;
        } catch (_) {}
      }
      throw new Error(JSON.stringify({ apiBase, chunkSamples, totalChunks: chunkUrls.length }));
    }

    // If we found an API base, try fetching rankings from it
    if (apiBase) {
      const rankUrl = apiBase.startsWith('http') ? apiBase : `https://www.owgr.com${apiBase}`;
      const rankResp = await fetch(`${rankUrl}?pageSize=500&pageNumber=1`, {
        headers: { 'Referer': 'https://www.owgr.com/', 'Accept': 'application/json' },
      });
      if (rankResp.ok) {
        const data = await rankResp.json();
        const players = extractPlayersFromJson(data);
        if (players.length > 0) {
          players._source = 'owgr-bundle-api';
          return players;
        }
      }
    }
  } catch (err) {
    if (debug) throw err;
    console.warn('[owgr] Strategy 3 failed:', err.message);
  }

  return [];
}

function extractPlayersFromJson(data) {
  const players = [];
  const seen = new Set();
  const walk = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { obj.forEach(walk); return; }
    // Look for objects with a rank number + player name
    const hasRank = 'rank' in obj || 'worldRanking' in obj || 'position' in obj || 'rankingPosition' in obj;
    const name = obj.playerName || obj.name || obj.fullName ||
      (obj.firstName && obj.lastName ? `${obj.firstName} ${obj.lastName}` : null);
    if (hasRank && name) {
      const rank = parseInt(obj.rank || obj.worldRanking || obj.position || obj.rankingPosition);
      if (!isNaN(rank) && !seen.has(name)) {
        seen.add(name);
        players.push({ name: name.trim(), worldRank: rank });
      }
    }
    Object.values(obj).forEach(walk);
  };
  walk(data);
  return players;
}

function parseHtmlTable(html) {
  const players = [];
  const seen = new Set();

  for (const rowMatch of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row = rowMatch[1];
    if (/<th/i.test(row)) continue;

    const cells = [];
    for (const cellMatch of row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)) {
      const text = cellMatch[1]
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ').trim();
      cells.push(text);
    }
    if (cells.length < 2) continue;

    // First cell should be a rank number
    const rank = parseInt(cells[0]);
    if (isNaN(rank) || rank < 1 || rank > 1000) continue;

    // Find a cell that looks like a player name (2+ words, letters only)
    const nameCell = cells.slice(1, 4).find(c =>
      c.split(/\s+/).length >= 2 && /\p{L}/u.test(c) && !/\d/.test(c) && c.length >= 5
    );
    if (!nameCell || seen.has(nameCell)) continue;

    seen.add(nameCell);
    players.push({ name: nameCell, worldRank: rank });
  }

  return players;
}
