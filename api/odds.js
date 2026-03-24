// api/odds.js — Vercel serverless function
// Fetches PGA Tour tournament winner odds by scraping pgatour.com's field page,
// which embeds DraftKings odds in its __NEXT_DATA__ when oddsEnabled is true.
// Falls back to scraping covers.com which publishes public golf odds.
//
// GET /api/odds          → { odds: { "Scottie Scheffler": "+350", ... }, tournament, count }
// GET /api/odds?debug=1  → diagnostic info

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

function nameToSlug(name) {
  return name.toLowerCase().replace(/['']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
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

// ── Source 1: PGA Tour field page __NEXT_DATA__ odds ─────────────────────────
async function fetchFromPGATour() {
  // Get upcoming tournament from schedule
  const schedResp = await fetch('https://www.pgatour.com/schedule', { headers: HEADERS });
  if (!schedResp.ok) throw new Error(`Schedule ${schedResp.status}`);
  const nd = extractNextData(await schedResp.text());
  if (!nd) throw new Error('No __NEXT_DATA__ on schedule');

  const queries = nd?.props?.pageProps?.dehydratedState?.queries || [];
  let tournaments = [];
  for (const q of queries) {
    if (q?.state?.data?.tournaments) tournaments = tournaments.concat(q.state.data.tournaments);
  }
  const DONE = ['COMPLETED', 'OFFICIAL', 'PAST', 'CANCELLED'];
  const seen = new Set();
  const unique = tournaments.filter(t => { if (seen.has(t.tournamentId)) return false; seen.add(t.tournamentId); return true; });
  const tournament = unique.find(t => t.status === 'IN_PROGRESS')
    || unique.find(t => t.status === 'UPCOMING')
    || unique.find(t => !DONE.includes(t.status?.toUpperCase()));
  if (!tournament) throw new Error('No upcoming tournament');

  const slug = nameToSlug(tournament.name);
  const fieldUrl = `https://www.pgatour.com/tournaments/${new Date().getFullYear()}/${slug}/${tournament.tournamentId}/field`;
  const fieldResp = await fetch(fieldUrl, { headers: HEADERS });
  if (!fieldResp.ok) throw new Error(`Field page ${fieldResp.status}`);
  const fieldNd = extractNextData(await fieldResp.text());
  if (!fieldNd) throw new Error('No __NEXT_DATA__ on field page');

  const odds = {};
  walkAll(fieldNd, obj => {
    // PGA Tour embeds odds object: { oddsToWinId, oddsEnabled, players: [{ displayName, odds }] }
    if (obj.oddsToWinId && obj.oddsEnabled === true && Array.isArray(obj.players) && obj.players.length) {
      obj.players.forEach(p => {
        const name = p.displayName?.trim() || p.playerName?.trim();
        const raw = p.odds || p.currentOdds || p.americanOdds;
        if (name && raw !== undefined && raw !== null) {
          const n = parseInt(raw, 10);
          if (!isNaN(n)) odds[name] = n > 0 ? `+${n}` : `${n}`;
        }
      });
    }
  });

  if (!Object.keys(odds).length) throw new Error('oddsEnabled=false or no players in odds object');
  return { odds, tournament: tournament.name, source: 'pgatour' };
}

// ── Source 2: scrape covers.com golf odds page ────────────────────────────────
async function fetchFromCovers() {
  const resp = await fetch('https://www.covers.com/sport/golf/pga/odds', {
    headers: { ...HEADERS, Accept: 'text/html' },
  });
  if (!resp.ok) throw new Error(`covers.com ${resp.status}`);
  const html = await resp.text();

  const odds = {};
  let tournament = null;

  // Covers embeds odds in a JSON blob in a script tag
  const jsonMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});\s*<\/script>/);
  if (jsonMatch) {
    try {
      const state = JSON.parse(jsonMatch[1]);
      // Walk for odds data
      walkAll(state, obj => {
        if (obj.participantName && (obj.americanOdds || obj.currentLine)) {
          const name = obj.participantName.trim();
          const price = obj.americanOdds || obj.currentLine;
          const n = parseInt(price, 10);
          if (name && !isNaN(n)) odds[name] = n > 0 ? `+${n}` : `${n}`;
        }
        if (obj.eventName && !tournament) tournament = obj.eventName;
      });
    } catch (_) {}
  }

  // Fallback: parse HTML table rows with player name + odds pattern
  if (!Object.keys(odds).length) {
    // Covers renders odds like: PlayerName ... +2000
    const rowPattern = /([A-Z][a-z]+ [A-Z][a-zA-Z\s'-]+?)\s*[\s\S]{0,200}?([+-]\d{3,5})/g;
    for (const [, name, price] of html.matchAll(rowPattern)) {
      const n = parseInt(price, 10);
      if (name.trim().split(' ').length >= 2 && !isNaN(n)) {
        odds[name.trim()] = n > 0 ? `+${n}` : `${n}`;
      }
    }
  }

  if (!Object.keys(odds).length) throw new Error('No odds found on covers.com');
  return { odds, tournament, source: 'covers' };
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const isDebug = req.query.debug === '1';

  const errors = [];

  // Try PGA Tour field page first (free, already being fetched)
  try {
    const result = await fetchFromPGATour();
    if (isDebug) return res.status(200).json({ source: result.source, tournament: result.tournament, count: Object.keys(result.odds).length, sample: Object.entries(result.odds).slice(0, 5) });
    return res.status(200).json(result);
  } catch (e) { errors.push(`pgatour: ${e.message}`); }

  // Fallback: covers.com
  try {
    const result = await fetchFromCovers();
    if (isDebug) return res.status(200).json({ source: result.source, tournament: result.tournament, count: Object.keys(result.odds).length, sample: Object.entries(result.odds).slice(0, 5), errors });
    return res.status(200).json(result);
  } catch (e) { errors.push(`covers: ${e.message}`); }

  // Nothing worked — return empty
  return res.status(200).json({ odds: {}, tournament: null, reason: 'all-sources-failed', errors });
}
