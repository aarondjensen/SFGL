// api/field.js — Vercel serverless function

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

async function fetchPage(url) {
  const resp = await fetch(url, { headers: HEADERS });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  return resp.text();
}

function extractNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

// Find the parent object containing a specific string value anywhere in the tree
function findParentsWithString(obj, needle, path = '', results = []) {
  if (!obj || typeof obj !== 'object') return results;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => findParentsWithString(v, needle, `${path}[${i}]`, results));
  } else {
    let found = false;
    Object.entries(obj).forEach(([k, v]) => {
      if (typeof v === 'string' && v.includes(needle)) found = true;
    });
    if (found && results.length < 5) {
      results.push({ path, keys: Object.keys(obj), sample: JSON.stringify(obj).slice(0, 500) });
    }
    Object.entries(obj).forEach(([k, v]) => findParentsWithString(v, needle, `${path}.${k}`, results));
  }
  return results;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const isDebug = req.query.debug === '1';
  const year = new Date().getFullYear().toString();

  try {
    const html = await fetchPage('https://www.pgatour.com/schedule');
    const nd = extractNextData(html);

    if (isDebug) {
      if (!nd) return res.status(200).json({ error: 'No __NEXT_DATA__', htmlLength: html.length });

      // Find objects that contain "Houston" to understand the tournament data structure
      const houstonParents = findParentsWithString(nd, 'Houston');
      // Also look for R2026 pattern (tournament IDs) in the raw JSON string
      const rawJson = JSON.stringify(nd);
      const r2026Matches = [...new Set(rawJson.match(/R202[0-9][0-9]{3}/g) || [])];
      // Find any key that looks like a tournament slug
      const slugMatches = [...new Set(rawJson.match(/"texas-childrens[^"]+"/g) || [])];
      const urlMatches = [...new Set(rawJson.match(/\/tournaments\/[^"]{5,80}/g) || [])].slice(0, 10);

      return res.status(200).json({
        houstonParents,
        r2026IdsFound: r2026Matches,
        slugsFound: slugMatches,
        tournamentUrlsFound: urlMatches,
      });
    }

    return res.status(503).json({ error: 'Use ?debug=1 to diagnose' });

  } catch (err) {
    return res.status(503).json({ error: err.message });
  }
}
