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

function walkAll(obj, collect) {
  if (!obj || typeof obj !== 'object') return;
  collect(obj);
  if (Array.isArray(obj)) obj.forEach(o => walkAll(o, collect));
  else Object.values(obj).forEach(v => walkAll(v, collect));
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
      if (!nd) {
        // No __NEXT_DATA__ — show raw HTML snippet to diagnose
        return res.status(200).json({
          error: 'No __NEXT_DATA__ found',
          hasScriptTag: html.includes('__NEXT_DATA__'),
          htmlLength: html.length,
          htmlSnippet: html.slice(0, 2000),
        });
      }

      // Show the top-level keys and search for any tournament-like data
      const topLevelKeys = Object.keys(nd);
      const allKeys = new Set();
      const tournamentLike = [];
      const stringValues = [];

      walkAll(nd, obj => {
        Object.keys(obj).forEach(k => allKeys.add(k));
        // Collect objects that look tournament-related
        if (obj.id && obj.name && typeof obj.name === 'string' && obj.name.length > 3) {
          tournamentLike.push({ id: obj.id, name: obj.name, keys: Object.keys(obj).slice(0, 10) });
        }
        // Look for Houston or tournament name strings
        Object.values(obj).forEach(v => {
          if (typeof v === 'string' && (v.includes('Houston') || v.includes('Valero') || v.includes('Masters'))) {
            stringValues.push(v.slice(0, 100));
          }
        });
      });

      return res.status(200).json({
        topLevelKeys,
        allKeysFound: [...allKeys].sort().slice(0, 80),
        tournamentLikeSample: tournamentLike.slice(0, 10),
        tournamentStrings: [...new Set(stringValues)].slice(0, 20),
      });
    }

    // Non-debug: attempt to find field using __NEXT_DATA__
    if (!nd) throw new Error('No __NEXT_DATA__ on pgatour.com/schedule');

    // Try to find Houston Open ID directly from known pattern
    // PGA Tour tournament IDs follow R{year}{num} pattern — scan all string values
    const today = new Date();
    const tournaments = [];
    walkAll(nd, obj => {
      const id = obj.tournamentId || obj.id;
      const name = obj.tournamentName || obj.name;
      const date = obj.startDate || obj.date || obj.tournamentDate;
      if (id && name && typeof id === 'string' && id.startsWith('R') && typeof name === 'string') {
        tournaments.push({ id, name, date: date ? new Date(date) : null, slug: obj.tournamentSlug || obj.slug || '' });
      }
    });

    const seen = new Set();
    const unique = tournaments.filter(t => { if (seen.has(t.id)) return false; seen.add(t.id); return true; });
    unique.sort((a, b) => (a.date || 0) - (b.date || 0));
    const upcoming = unique.find(t => !t.date || t.date >= today) || unique[0];

    if (!upcoming) throw new Error('Could not identify upcoming tournament from schedule data');

    return res.status(200).json({
      players: [],
      tournament: upcoming.name,
      count: 0,
      debug: { upcoming, totalFound: unique.length },
    });

  } catch (err) {
    return res.status(503).json({ error: err.message });
  }
}
