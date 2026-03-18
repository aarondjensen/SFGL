// api/field.js — Vercel serverless function
// Returns the current PGA Tour tournament field as an array of player name strings.
//
// Strategy (first source that returns players wins):
//   1. DataGolf /fields/pga-tour  — server-rendered HTML, available Mon+ before tournament
//   2. ESPN leaderboard API       — available Thu–Sun once the tournament is live
//
// GET /api/field
// Returns: { players: string[], source: 'datagolf' | 'espn', count: number }
//
// ⚠️  UPDATE EACH SEASON: ESPN_EVENT_ID must match the current tournament.
//    Find IDs at: https://site.api.espn.com/apis/site/v2/sports/golf/scoreboard
//    or check headshots.js — keep them in sync.

const ESPN_EVENT_ID = process.env.ESPN_EVENT_ID || '401811938';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Referer': 'https://datagolf.com/',
};

// DataGolf scraper
// The /fields/pga-tour page is server-rendered. Player names appear in the HTML
// in "Last, First" format (e.g. "Scheffler, Scottie"), one per line.
// They sit between the "-- Highlight Player --" marker and the "THURSDAY" tee-time section.

async function fetchFromDataGolf() {
  const resp = await fetch('https://datagolf.com/fields/pga-tour', { headers: HEADERS });
  if (!resp.ok) throw new Error(`DataGolf returned ${resp.status}`);
  const html = await resp.text();

  const startMarker = '-- Highlight Player --';
  const endMarker   = 'THURSDAY';

  const startIdx = html.indexOf(startMarker);
  const endIdx   = html.indexOf(endMarker, startIdx);
  if (startIdx === -1 || endIdx === -1) throw new Error('Could not find player list region in DataGolf HTML');

  const region = html.slice(startIdx + startMarker.length, endIdx);

  // Strip HTML tags and decode entities
  const text = region
    .replace(/<[^>]+>/g, '\n')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, '')
    .replace(/&[a-z]+;/g, '');

  const players = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    // Match "Last, First" — capital first letter, comma, space, capital first letter
    if (/^[A-Z][A-Za-z'\-.]+,\s+[A-Z]/.test(trimmed)) {
      const commaIdx = trimmed.indexOf(', ');
      const last  = trimmed.slice(0, commaIdx).trim();
      const first = trimmed.slice(commaIdx + 2).trim();
      if (first && last) players.push(`${first} ${last}`);
    }
  }

  return players;
}

// ESPN fallback — works Thu–Sun once the tournament is live

async function fetchFromESPN() {
  const resp = await fetch(
    `https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard?event=${ESPN_EVENT_ID}&_=${Date.now()}`,
    { headers: { ...HEADERS, Accept: 'application/json' } }
  );
  if (!resp.ok) throw new Error(`ESPN returned ${resp.status}`);
  const data = await resp.json();
  const competitors = data?.events?.[0]?.competitions?.[0]?.competitors || [];
  return competitors
    .map(p => (p.athlete?.displayName || '').trim())
    .filter(Boolean);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  // Cache 30 min on Vercel CDN — field changes rarely, stale-while-revalidate
  // serves instantly while fresh data is fetched in the background.
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // 1. Try DataGolf (works Mon+ before tournament starts)
  try {
    const players = await fetchFromDataGolf();
    if (players.length > 0) {
      return res.status(200).json({ players, source: 'datagolf', count: players.length });
    }
  } catch (dgErr) {
    console.warn('[field] DataGolf failed:', dgErr.message);
  }

  // 2. Fall back to ESPN (works Thu–Sun once the tournament is live)
  try {
    const players = await fetchFromESPN();
    if (players.length > 0) {
      return res.status(200).json({ players, source: 'espn', count: players.length });
    }
  } catch (espnErr) {
    console.warn('[field] ESPN failed:', espnErr.message);
    return res.status(503).json({
      error: 'Field data unavailable — both DataGolf and ESPN failed.',
      detail: espnErr.message,
    });
  }

  return res.status(404).json({
    error: 'No field data found. DataGolf may not have posted the field yet and the tournament has not started.',
  });
}
