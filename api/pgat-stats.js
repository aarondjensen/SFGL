// api/pgat-stats.js — Vercel serverless function
// =====================================================================
// Fetches PGA Tour season earnings, events played, and cuts made.
//
// HISTORY OF THIS FILE:
//   v1 tried pgatour.com/stats/detail/02671 + alternates. Two problems:
//     (a) 02671 is FedExCup points, NOT money — the parser was returning
//         point totals (~327) interpreted as dollars.
//     (b) pgatour.com stats pages render their tables CLIENT-SIDE via JS,
//         so the SSR'd HTML doesn't contain row data at all. Even with
//         the right stat ID, scraping the rendered HTML returns 0 players.
//   v2 (this version) switches the source to ESPN. ESPN's golf stats pages
//   ARE server-rendered: they embed a window.__espnfitt__ JSON blob that
//   contains every player row with earnings + events + cuts in one place.
//   ESPN's table structure has been stable for ~10 years.
//
// PRIMARY SOURCE:  https://www.espn.com/golf/stats/player/_/table/general/sort/amount/dir/desc
//   • Already sorted by official money won, descending
//   • Default page shows ~50 players; add /count/200 for more
//   • Same single page contains EARNINGS, EVNTS (tournaments played), and CUTS (cuts made)
//   • Updated nightly by ESPN's data feed
//
// RESPONSE SHAPE: { players: [{ name, earnings, eventsPlayed, cutsMade }], count }
// On failure: 502 with { error, attempts } so admin can diagnose from the toast.

// ESPN stats URLs. We fetch the amount-sorted one with count=300 — enough
// headroom to cover every PGA Tour player who's earned anything this season.
const ESPN_URLS = [
  'https://www.espn.com/golf/stats/player/_/table/general/sort/amount/dir/desc/count/300',
  'https://www.espn.com/golf/stats/player/_/table/general/sort/amount/dir/desc',
];

// Browser-like headers reduce the chance of being served a bot-blocked page.
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Referer': 'https://www.espn.com/',
};

// ESPN inlines all page data in a <script> assignment:
//   window['__espnfitt__'] = { ...giant JSON... };
// Extract and parse the JSON. The exact assignment shape varies slightly
// across ESPN page templates — we try a few patterns.
function extractEspnPayload(html) {
  const patterns = [
    /window\[['"]__espnfitt__['"]\]\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/,
    /window\.__espnfitt__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (!m) continue;
    try { return JSON.parse(m[1]); } catch { /* try next */ }
  }
  return null;
}

// Coerce ESPN's money values to numbers. ESPN sometimes serves the raw
// integer ("amount": 6246430) and sometimes the formatted string
// ("$6,246,430"). Be permissive.
function moneyToNumber(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number' && isFinite(raw)) return raw;
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/[$,\s]/g, '').trim();
  if (!cleaned) return null;
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

function intFromAny(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number' && isFinite(raw)) return Math.round(raw);
  if (typeof raw !== 'string') return null;
  const n = parseInt(raw.replace(/[,\s]/g, ''), 10);
  return isNaN(n) ? null : n;
}

// Walk the ESPN page payload looking for the player table rows.
// ESPN's page structure varies, so we cast a fairly wide net.
function parsePlayersFromEspn(payload) {
  const map = new Map();

  const MONEY_KEYS  = ['amount', 'money', 'officialMoney', 'EARNINGS', 'earnings'];
  const EVENT_KEYS  = ['tournamentsPlayed', 'eventsPlayed', 'tournaments', 'EVNTS', 'events'];
  const CUTS_KEYS   = ['cutsMade', 'cuts', 'CUTS', 'madeCuts'];
  const NAME_KEYS   = ['fullName', 'displayName', 'name', 'playerName', 'athleteName'];

  const findMoney = (obj) => {
    if (!obj || typeof obj !== 'object') return null;
    for (const k of MONEY_KEYS) {
      if (k in obj) {
        const v = moneyToNumber(obj[k]);
        if (v !== null && v >= 1000) return v; // sanity floor — under $1k is junk
      }
    }
    return null;
  };
  const findInt = (obj, keys, max = 50) => {
    if (!obj || typeof obj !== 'object') return null;
    for (const k of keys) {
      if (k in obj) {
        const v = intFromAny(obj[k]);
        // PGA Tour season events cap around 35. A bigger value almost
        // certainly means we matched the wrong field.
        if (v !== null && v >= 0 && v <= max) return v;
      }
    }
    return null;
  };

  const findName = (obj) => {
    if (!obj || typeof obj !== 'object') return null;
    for (const k of NAME_KEYS) {
      if (typeof obj[k] === 'string' && obj[k].includes(' ')) return obj[k].trim();
    }
    const sub = obj.athlete || obj.player;
    if (sub && typeof sub === 'object') {
      for (const k of NAME_KEYS) {
        if (typeof sub[k] === 'string' && sub[k].includes(' ')) return sub[k].trim();
      }
      if (typeof sub.firstName === 'string' && typeof sub.lastName === 'string') {
        const n = (sub.firstName + ' ' + sub.lastName).trim();
        if (n.includes(' ')) return n;
      }
    }
    if (typeof obj.firstName === 'string' && typeof obj.lastName === 'string') {
      const n = (obj.firstName + ' ' + obj.lastName).trim();
      if (n.includes(' ')) return n;
    }
    return null;
  };

  const upsert = (name, money, events, cuts) => {
    if (!name) return;
    if (name.length < 4 || name.length > 40) return;
    // Allow letters, hyphens, apostrophes, periods, spaces, and accented chars
    if (!/^[A-Za-zÀ-ÿ' .-]+$/.test(name)) return;
    const prev = map.get(name) || { earnings: 0, eventsPlayed: 0, cutsMade: 0 };
    map.set(name, {
      earnings:     Math.max(prev.earnings,     money  || 0),
      eventsPlayed: Math.max(prev.eventsPlayed, events || 0),
      cutsMade:     Math.max(prev.cutsMade,     cuts   || 0),
    });
  };

  // ESPN often serves stats as a tabular `rows` array where each row is an
  // array of cell values (positional, in column order). We map column index
  // → field by looking at the headers.
  const tryParseTabularRows = (obj) => {
    if (!obj || typeof obj !== 'object') return false;
    const rows = obj.rows || obj.rowsdata || obj.players;
    const headers = obj.headers || obj.cols || obj.columns;
    if (!Array.isArray(rows) || !Array.isArray(headers)) return false;
    if (rows.length === 0 || headers.length === 0) return false;
    const norm = headers.map(h =>
      typeof h === 'string' ? h.toUpperCase() : String(h?.text || h?.label || h?.key || '').toUpperCase()
    );
    const moneyIdx  = norm.findIndex(h => /EARNING|AMOUNT|MONEY/.test(h));
    const eventsIdx = norm.findIndex(h => /EVNTS|EVENTS|TOURN/.test(h));
    const cutsIdx   = norm.findIndex(h => /CUTS/.test(h));
    const nameIdx   = norm.findIndex(h => /PLAYER|NAME|ATHLETE/.test(h));
    if (moneyIdx < 0 && eventsIdx < 0 && cutsIdx < 0) return false;

    rows.forEach(row => {
      if (!Array.isArray(row)) return;
      const cellVal = (i) => {
        if (i < 0 || i >= row.length) return null;
        const c = row[i];
        if (c === null || c === undefined) return null;
        if (typeof c === 'string' || typeof c === 'number') return c;
        return c.text ?? c.value ?? c.displayValue ?? null;
      };
      const rawName = cellVal(nameIdx);
      let name = null;
      if (typeof rawName === 'string') {
        name = rawName.replace(/<[^>]+>/g, '').trim();
      }
      const money  = moneyToNumber(cellVal(moneyIdx));
      const events = intFromAny(cellVal(eventsIdx));
      const cuts   = intFromAny(cellVal(cutsIdx));
      if (name && name.includes(' ') && (money !== null || events !== null || cuts !== null)) {
        upsert(name, money, events, cuts);
      }
    });
    return true;
  };

  const visit = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { obj.forEach(visit); return; }

    tryParseTabularRows(obj);

    const name = findName(obj);
    if (name) {
      const money  = findMoney(obj);
      const events = findInt(obj, EVENT_KEYS, 50);
      const cuts   = findInt(obj, CUTS_KEYS, 50);
      if (money !== null || events !== null || cuts !== null) {
        upsert(name, money, events, cuts);
      }
    }

    for (const k in obj) {
      const v = obj[k];
      if (v && typeof v === 'object') visit(v);
    }
  };

  visit(payload);

  return [...map.entries()].map(([name, stats]) => ({ name, ...stats }));
}

// Final fallback: parse the rendered HTML table directly. Used only when
// extractEspnPayload returns null (ESPN changed their inline payload format)
// but the table HTML is still recognizable.
function parsePlayersFromHtmlFallback(html) {
  const out = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
  let rowM;
  while ((rowM = rowRe.exec(html)) !== null) {
    const cells = [];
    let cellM;
    cellRe.lastIndex = 0;
    while ((cellM = cellRe.exec(rowM[1])) !== null) {
      cells.push(cellM[1]);
    }
    if (cells.length < 5) continue;
    const nameCell = cells.find(c => /<a[^>]*>([^<]{4,})<\/a>/.test(c));
    if (!nameCell) continue;
    const nameMatch = nameCell.match(/<a[^>]*>([^<]+)<\/a>/);
    if (!nameMatch) continue;
    const name = nameMatch[1].trim();
    if (!name.includes(' ')) continue;
    const moneyCell = cells.find(c => /\$[\d,]+/.test(c));
    const money = moneyCell ? moneyToNumber(moneyCell.match(/\$[\d,]+/)[0]) : null;
    if (money === null || money < 1000) continue;
    const stripTags = s => s.replace(/<[^>]+>/g, '').trim();
    let events = null, cuts = null;
    const moneyIdx = cells.indexOf(moneyCell);
    for (let i = moneyIdx + 1; i < cells.length; i++) {
      const t = stripTags(cells[i]);
      if (!/^\d+$/.test(t)) continue;
      const n = parseInt(t, 10);
      if (n > 50) continue;
      if (events === null) { events = n; continue; }
      if (cuts === null)   { cuts = n;   break; }
    }
    out.push({ name, earnings: money, eventsPlayed: events || 0, cutsMade: cuts || 0 });
  }
  return out;
}

async function fetchAndParse(url, timeoutMs = 7000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { headers: HEADERS, signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}`);
    const html = await resp.text();
    const payload = extractEspnPayload(html);
    let players = payload ? parsePlayersFromEspn(payload) : [];
    if (!players.length) {
      players = parsePlayersFromHtmlFallback(html);
    }
    return players;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Timeout (${timeoutMs}ms) fetching ${url}`);
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=43200');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Try URLs sequentially — the first one (count/300) should always work;
  // the second is a fallback in case ESPN's count parameter ever breaks.
  const tried = [];
  let bestPlayers = [];
  let lastError = null;

  for (const url of ESPN_URLS) {
    try {
      const players = await fetchAndParse(url);
      const withEarnings = players.filter(p => (p.earnings || 0) > 0);
      tried.push({ url, count: withEarnings.length });
      if (withEarnings.length > bestPlayers.length) bestPlayers = withEarnings;
      if (withEarnings.length >= 50) break;
    } catch (err) {
      lastError = err?.message || String(err);
      tried.push({ url, error: lastError });
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
