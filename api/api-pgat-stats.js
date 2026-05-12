// api/pgat-stats.js — Vercel serverless function
// Fetches PGA Tour season earnings/events/cuts from pgatour.com.
// Same scrape pattern as api/pga-results.js — pull __NEXT_DATA__ from the
// Next.js-rendered stats page, walk the JSON to collect every player row
// with money + events + cuts data.
//
// The PGA Tour's stats system uses numeric stat IDs that occasionally
// change between seasons. We try the canonical "Money Leaders" page first;
// if that returns no players, fall back to a few alternates.
//
// Response shape: { players: [{ name, earnings, eventsPlayed, cutsMade }] }
// Empty array if the page changed and we couldn't parse — admin gets an
// error toast and can investigate.

// Common PGA Tour stat-page URLs that have surfaced over the past few seasons.
// We try each until one returns enough data. The "02671" stat is the
// official money-earned leaderboard for the current season (CME points
// have a different ID).
const STATS_URLS = [
  'https://www.pgatour.com/stats/detail/02671',          // Money Earned
  'https://www.pgatour.com/stats/category/money/02671',  // alternate route
  'https://www.pgatour.com/fedexcup/standings',          // FedEx Cup (includes earnings)
];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Referer': 'https://www.pgatour.com/',
};

function extractNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

// Walk the __NEXT_DATA__ JSON looking for stat rows.
// Each row should have a player name plus at least one of:
//   - money/earnings (the main metric)
//   - eventsPlayed (sometimes called "tournaments", "starts", "events")
//   - cutsMade (sometimes called "cuts", "cutsMade")
//
// Casts a wide net since PGA Tour's response shape varies by stat ID.
function parseStatsFromNextData(nd) {
  const NAME_KEYS  = ['displayName', 'playerName', 'name', 'fullName'];
  const MONEY_KEYS = ['money', 'earnings', 'officialMoney', 'moneyEarned', 'amount', 'statValue'];
  const EVENT_KEYS = ['events', 'eventsPlayed', 'tournaments', 'tournamentsPlayed', 'starts'];
  const CUTS_KEYS  = ['cutsMade', 'cuts', 'madeCuts'];

  const map = new Map(); // name -> { earnings, eventsPlayed, cutsMade }

  const numFromAny = (raw) => {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'number' && isFinite(raw)) return raw;
    if (typeof raw === 'string') {
      // Strip currency symbols, commas, whitespace
      const cleaned = raw.replace(/[$,]/g, '').trim();
      const n = parseFloat(cleaned);
      return isNaN(n) ? null : n;
    }
    return null;
  };

  const findOne = (obj, keys) => {
    if (!obj || typeof obj !== 'object') return null;
    for (const k of keys) {
      if (k in obj) {
        const v = numFromAny(obj[k]);
        if (v !== null) return v;
      }
    }
    return null;
  };

  const findName = (obj) => {
    if (!obj || typeof obj !== 'object') return null;
    const src = obj.player || obj;
    for (const k of NAME_KEYS) {
      if (typeof src[k] === 'string' && src[k].trim().length > 2) {
        return src[k].trim();
      }
    }
    return null;
  };

  const walk = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { obj.forEach(walk); return; }

    const name = findName(obj);
    if (name) {
      // PGA Tour stat rows often nest the value as { statName, statValue }
      // or scatter values across fields. Try both shapes.
      let earnings   = findOne(obj, MONEY_KEYS) ?? findOne(obj.player || {}, MONEY_KEYS);
      let events     = findOne(obj, EVENT_KEYS) ?? findOne(obj.player || {}, EVENT_KEYS);
      let cuts       = findOne(obj, CUTS_KEYS)  ?? findOne(obj.player || {}, CUTS_KEYS);

      // Many PGA Tour pages store stats as an array of { statName, value }
      if (Array.isArray(obj.stats)) {
        for (const s of obj.stats) {
          const sn = String(s?.statName || s?.name || '').toLowerCase();
          const sv = numFromAny(s?.value ?? s?.statValue);
          if (sv === null) continue;
          if (earnings === null && /money|earning/.test(sn)) earnings = sv;
          if (events   === null && /event|start/.test(sn))   events   = sv;
          if (cuts     === null && /cut/.test(sn))           cuts     = sv;
        }
      }

      if (earnings !== null || events !== null || cuts !== null) {
        const prev = map.get(name) || { earnings: 0, eventsPlayed: 0, cutsMade: 0 };
        // Keep highest values seen — handles cases where the same player
        // appears in multiple JSON nodes with partial data in each.
        map.set(name, {
          earnings:     Math.max(prev.earnings,     earnings || 0),
          eventsPlayed: Math.max(prev.eventsPlayed, events   || 0),
          cutsMade:     Math.max(prev.cutsMade,     cuts     || 0),
        });
      }
    }

    Object.values(obj).forEach(walk);
  };

  walk(nd);

  return [...map.entries()].map(([name, stats]) => ({ name, ...stats }));
}

async function fetchAndParse(url) {
  const resp = await fetch(url, { headers: HEADERS });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}`);
  const html = await resp.text();
  const nd = extractNextData(html);
  if (!nd) throw new Error(`No __NEXT_DATA__ on ${url}`);
  return parseStatsFromNextData(nd);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  // Stats change daily-ish at most. Cache 6h on Vercel CDN.
  res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=43200');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const tried = [];
  let bestPlayers = [];
  let lastError = null;

  for (const url of STATS_URLS) {
    try {
      const players = await fetchAndParse(url);
      const withEarnings = players.filter(p => (p.earnings || 0) > 0);
      tried.push({ url, count: withEarnings.length });
      if (withEarnings.length > bestPlayers.length) bestPlayers = withEarnings;
      // If we got a reasonable amount of data (50+ players with earnings),
      // accept this source and stop trying alternates.
      if (withEarnings.length >= 50) break;
    } catch (err) {
      lastError = err.message;
      tried.push({ url, error: err.message });
    }
  }

  if (bestPlayers.length === 0) {
    return res.status(502).json({
      error: 'No PGA Tour stats data could be parsed',
      attempts: tried,
      lastError,
    });
  }

  return res.status(200).json({
    players: bestPlayers.sort((a, b) => b.earnings - a.earnings),
    count: bestPlayers.length,
    sourceAttempts: tried,
  });
}
