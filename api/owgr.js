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
      return res.status(404).json({ error: 'No ranking data found' });
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

  // ── Strategy 3: Scrape the HTML page ─────────────────────────────────────
  try {
    const resp = await fetch('https://www.owgr.com/current-world-ranking', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Referer': 'https://www.owgr.com/',
      },
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const html = await resp.text();

    // Try __NEXT_DATA__ or similar embedded JSON first
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (nextDataMatch) {
      const nd = JSON.parse(nextDataMatch[1]);
      const players = extractPlayersFromJson(nd);
      if (players.length > 0) {
        console.log(`[owgr] Strategy 3a (__NEXT_DATA__): ${players.length} players`);
        players._source = 'owgr-html-json';
        return players;
      }
    }

    // Try table parsing
    const players = parseHtmlTable(html);
    if (players.length > 0) {
      console.log(`[owgr] Strategy 3b (HTML table): ${players.length} players`);
      players._source = 'owgr-html-table';
      return players;
    }

    if (debug) {
      // Return debug info about the page structure
      const scriptTags = [...html.matchAll(/<script[^>]*>([\s\S]{50,2000}?)<\/script>/gi)]
        .map(m => m[1].slice(0, 200))
        .filter(s => s.includes('rank') || s.includes('player'))
        .slice(0, 3);
      throw new Error(JSON.stringify({
        htmlLength: html.length,
        hasNextData: !!nextDataMatch,
        playerInHtml: html.includes('Scottie Scheffler'),
        scripts: scriptTags,
      }));
    }
  } catch (err) {
    console.warn('[owgr] Strategy 3 failed:', err.message);
    throw err;
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
