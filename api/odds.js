// api/odds.js — Vercel serverless function
// Fetches odds from the PGA Tour's own odds page, which embeds DraftKings odds
// in __NEXT_DATA__ when markets are open.
//
// Tournament ID format: R2026020 (from field.js schedule fetch)
// Odds page: pgatour.com/tournaments/{year}/{slug}/{id}/odds
//
// GET /api/odds          → { odds: { "Scottie Scheffler": "+350", ... }, tournament, count }
// GET /api/odds?debug=1  → diagnostic info

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

function extractNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function nameToSlug(name) {
  return name.toLowerCase().replace(/['']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function walkAll(obj, fn) {
  if (!obj || typeof obj !== 'object') return;
  fn(obj);
  (Array.isArray(obj) ? obj : Object.values(obj)).forEach(v => walkAll(v, fn));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const isDebug = req.query.debug === '1';
  const year = new Date().getFullYear().toString();

  try {
    // Step 1: get upcoming tournament ID + name from schedule
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

    // Step 2: fetch the odds page
    const slug = nameToSlug(tournament.name);
    const oddsUrl = `https://www.pgatour.com/tournaments/${year}/${slug}/${tournament.tournamentId}/odds`;
    const oddsResp = await fetch(oddsUrl, { headers: HEADERS });
    if (!oddsResp.ok) throw new Error(`Odds page ${oddsResp.status}`);
    const oddsNd = extractNextData(await oddsResp.text());

    if (isDebug) {
      // Scan for anything odds-related in the data
      const found = [];
      if (oddsNd) {
        walkAll(oddsNd, obj => {
          if (obj.oddsEnabled !== undefined || obj.oddsToWinId !== undefined) {
            found.push({ oddsEnabled: obj.oddsEnabled, oddsToWinId: obj.oddsToWinId, playerCount: obj.players?.length });
          }
        });
      }
      return res.status(200).json({ oddsUrl, hasNextData: !!oddsNd, oddsObjects: found.slice(0, 5) });
    }

    if (!oddsNd) throw new Error('No __NEXT_DATA__ on odds page');

    // Step 3: extract odds from the data
    const odds = {};
    walkAll(oddsNd, obj => {
      if (obj.oddsEnabled === true && Array.isArray(obj.players) && obj.players.length) {
        obj.players.forEach(p => {
          const name = p.displayName?.trim() || p.playerName?.trim();
          const raw = p.odds ?? p.currentOdds ?? p.americanOdds;
          if (name && raw !== undefined && raw !== null) {
            const n = parseInt(raw, 10);
            if (!isNaN(n)) odds[name] = n > 0 ? `+${n}` : `${n}`;
          }
        });
      }
    });

    if (!Object.keys(odds).length) {
      return res.status(200).json({ odds: {}, tournament: tournament.name, reason: 'oddsEnabled-false-or-no-players', oddsUrl });
    }

    return res.status(200).json({
      odds,
      tournament: tournament.name,
      count: Object.keys(odds).length,
      source: 'pgatour',
    });

  } catch (err) {
    return res.status(200).json({ odds: {}, tournament: null, reason: err.message });
  }
}
