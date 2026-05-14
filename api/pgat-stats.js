// api/pgat-stats.js — Vercel serverless function
// =====================================================================
// v4 — ESPN was returning Akamai bot-detection placeholders (202 with 2KB
// of HTML and no table data). This version tries:
//   1. ESPN with FULL Chrome headers (Sec-Fetch-* hints) to defeat Akamai
//   2. CBS Sports money list as a fallback (lighter bot detection)
// Debug mode always surfaces the body preview so we can see exactly what
// each source returns.
//
// RESPONSE: { players: [{ name, earnings, eventsPlayed, cutsMade }], count }

const ESPN_HTML_URLS = [
  'https://www.espn.com/golf/stats/player/_/table/general/sort/amount/dir/desc/count/300',
  'https://www.espn.com/golf/stats/player/_/table/general/sort/amount/dir/desc',
];

// CBS Sports money list — alternate source with the same data set.
// Cleaner table structure, less bot detection in my experience.
const CBS_HTML_URLS = [
  'https://www.cbssports.com/golf/leaderboard/pga/money-leaders/',
  'https://www.cbssports.com/golf/rankings/money-list/',
];

// Full Chrome-on-Windows header set. Akamai checks for Sec-Fetch-*
// "client hints" that automated tools typically omit.
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Cache-Control': 'max-age=0',
  'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

// ---------------------------------------------------------------------
// JSON extraction — bracket counting
// ---------------------------------------------------------------------
function extractAssignmentJson(html, varPatterns) {
  for (const pat of varPatterns) {
    const idx = html.search(pat);
    if (idx === -1) continue;
    const eqIdx = html.indexOf('=', idx);
    if (eqIdx === -1) continue;
    const startIdx = html.indexOf('{', eqIdx);
    if (startIdx === -1) continue;
    let depth = 0, i = startIdx, inStr = false, strCh = '', esc = false;
    for (; i < html.length; i++) {
      const c = html[i];
      if (inStr) {
        if (esc) { esc = false; continue; }
        if (c === '\\') { esc = true; continue; }
        if (c === strCh) inStr = false;
        continue;
      }
      if (c === '"' || c === "'") { inStr = true; strCh = c; continue; }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          const jsonStr = html.slice(startIdx, i + 1);
          try { return JSON.parse(jsonStr); } catch { return null; }
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------
// Value coercion
// ---------------------------------------------------------------------
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

// ---------------------------------------------------------------------
// Parser — walks JSON looking for player+earnings combinations
// ---------------------------------------------------------------------
function parsePlayersFromJson(payload) {
  const map = new Map();
  const MONEY_KEYS = ['amount', 'money', 'officialMoney', 'EARNINGS', 'earnings'];
  const EVENT_KEYS = ['tournamentsPlayed', 'eventsPlayed', 'tournaments', 'EVNTS', 'events'];
  const CUTS_KEYS  = ['cutsMade', 'cuts', 'CUTS', 'madeCuts'];
  const NAME_KEYS  = ['fullName', 'displayName', 'name', 'playerName', 'athleteName'];

  const findVal = (obj, keys) => {
    if (!obj || typeof obj !== 'object') return null;
    for (const k of keys) if (k in obj) return obj[k];
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
    if (!name || name.length < 4 || name.length > 40) return;
    if (!/^[A-Za-zÀ-ÿ' .-]+$/.test(name)) return;
    const prev = map.get(name) || { earnings: 0, eventsPlayed: 0, cutsMade: 0 };
    map.set(name, {
      earnings:     Math.max(prev.earnings,     money  || 0),
      eventsPlayed: Math.max(prev.eventsPlayed, events || 0),
      cutsMade:     Math.max(prev.cutsMade,     cuts   || 0),
    });
  };

  const tryTabular = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    const rows = obj.rows || obj.rowsdata || obj.players;
    const headers = obj.headers || obj.cols || obj.columns;
    if (!Array.isArray(rows) || !Array.isArray(headers)) return;
    if (rows.length === 0 || headers.length === 0) return;
    const norm = headers.map(h =>
      typeof h === 'string' ? h.toUpperCase() : String(h?.text || h?.label || h?.key || h?.title || '').toUpperCase()
    );
    const moneyIdx  = norm.findIndex(h => /EARNING|AMOUNT|MONEY/.test(h));
    const eventsIdx = norm.findIndex(h => /EVNTS|EVENTS|TOURN/.test(h));
    const cutsIdx   = norm.findIndex(h => /CUTS/.test(h));
    const nameIdx   = norm.findIndex(h => /PLAYER|NAME|ATHLETE/.test(h));
    if (moneyIdx < 0 && eventsIdx < 0 && cutsIdx < 0) return;

    rows.forEach(row => {
      if (!Array.isArray(row)) return;
      const cell = (i) => {
        if (i < 0 || i >= row.length) return null;
        const c = row[i];
        if (c === null || c === undefined) return null;
        if (typeof c === 'string' || typeof c === 'number') return c;
        return c.text ?? c.value ?? c.displayValue ?? c.statValue ?? null;
      };
      let name = cell(nameIdx);
      if (typeof name === 'string') name = name.replace(/<[^>]+>/g, '').trim();
      const money  = moneyToNumber(cell(moneyIdx));
      const events = intFromAny(cell(eventsIdx));
      const cuts   = intFromAny(cell(cutsIdx));
      if (name && (money !== null || events !== null || cuts !== null)) {
        upsert(name, money, events, cuts);
      }
    });
  };

  const visit = (obj, depth = 0) => {
    if (!obj || typeof obj !== 'object' || depth > 50) return;
    if (Array.isArray(obj)) { obj.forEach(o => visit(o, depth + 1)); return; }

    tryTabular(obj);

    const name = findName(obj);
    if (name) {
      const money  = moneyToNumber(findVal(obj, MONEY_KEYS));
      const events = intFromAny(findVal(obj, EVENT_KEYS));
      const cuts   = intFromAny(findVal(obj, CUTS_KEYS));
      const realMoney  = (money  !== null && money >= 1000) ? money : null;
      const realEvents = (events !== null && events >= 0 && events <= 50) ? events : null;
      const realCuts   = (cuts   !== null && cuts   >= 0 && cuts   <= 50) ? cuts : null;
      if (realMoney !== null || realEvents !== null || realCuts !== null) {
        upsert(name, realMoney, realEvents, realCuts);
      }
    }

    for (const k in obj) {
      const v = obj[k];
      if (v && typeof v === 'object') visit(v, depth + 1);
    }
  };

  visit(payload);
  return [...map.entries()].map(([name, stats]) => ({ name, ...stats }));
}

// ---------------------------------------------------------------------
// Generic HTML table parser — works for any standard <table><tr><td> page
// Handles both ESPN (when not bot-blocked) and CBS Sports tables.
// ---------------------------------------------------------------------
function parsePlayersFromHtmlFallback(html) {
  const out = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g;
  const stripTags = s => s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  let rowM;
  while ((rowM = rowRe.exec(html)) !== null) {
    const cells = [];
    let cellM;
    cellRe.lastIndex = 0;
    while ((cellM = cellRe.exec(rowM[1])) !== null) cells.push(cellM[1]);
    if (cells.length < 4) continue;

    // Find name: prefer text inside <a> tag; fall back to any cell with a
    // "First Last" shape.
    let name = null;
    for (const c of cells) {
      const aMatch = c.match(/<a[^>]*>([^<]{4,40})<\/a>/);
      if (aMatch) {
        const candidate = aMatch[1].trim();
        if (candidate.includes(' ') && /^[A-Za-zÀ-ÿ' .-]+$/.test(candidate)) {
          name = candidate;
          break;
        }
      }
    }
    if (!name) {
      for (const c of cells) {
        const txt = stripTags(c);
        if (txt.length >= 4 && txt.length <= 40 && txt.includes(' ') && /^[A-Za-zÀ-ÿ' .-]+$/.test(txt)) {
          name = txt; break;
        }
      }
    }
    if (!name) continue;

    // Find money: any cell containing $ followed by digits/commas
    const moneyCell = cells.find(c => /\$[\d,]+/.test(stripTags(c)));
    const money = moneyCell ? moneyToNumber(stripTags(moneyCell).match(/\$[\d,]+/)[0]) : null;
    if (money === null || money < 1000) continue;

    // Events and cuts: take the first two reasonable small integers we see
    // in cells AFTER the money cell. Heuristic — not perfect but works on
    // most standard money-list tables.
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

// ---------------------------------------------------------------------
// Fetch + parse one URL
// ---------------------------------------------------------------------
async function fetchAndParse(url, timeoutMs = 7000) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);
  let status = null;
  let bodyPreview = null;
  let parseDetail = null;
  try {
    const resp = await fetch(url, { headers: HEADERS, signal: controller.signal });
    status = resp.status;
    const text = await resp.text();
    bodyPreview = text.slice(0, 4000); // truncated to keep debug response sane
    if (!resp.ok) {
      return { players: [], debug: { url, status, bodyBytes: text.length, bodyPreview, error: `HTTP ${status}` } };
    }

    let parsed = null;
    if (resp.headers.get('content-type')?.includes('application/json')) {
      try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    }

    let extracted = null;
    let extractedAt = -1;
    if (!parsed) {
      const patterns = [
        /window\[['"]__espnfitt__['"]\]/,
        /window\.__espnfitt__/,
        /__espnfitt__\s*=\s*\{/,
        /__INITIAL_STATE__\s*=\s*\{/,
        /__NEXT_DATA__\s*=\s*\{/,
        /window\.__data\s*=\s*\{/,
      ];
      patterns.forEach((p) => {
        if (extractedAt === -1) {
          const i = text.search(p);
          if (i !== -1) extractedAt = i;
        }
      });
      extracted = extractAssignmentJson(text, patterns);
    }

    const root = parsed || extracted;
    let players = root ? parsePlayersFromJson(root) : [];
    let parseMethod = root ? 'json' : 'none';

    if (!players.length) {
      players = parsePlayersFromHtmlFallback(text);
      if (players.length) parseMethod = 'html-fallback';
    }

    parseDetail = {
      contentType: resp.headers.get('content-type') || '',
      bodyBytes: text.length,
      espnfittFound: extractedAt !== -1,
      espnfittOffset: extractedAt,
      jsonExtracted: !!root,
      trCount: (text.match(/<tr[^>]*>/g) || []).length,
      tdCount: (text.match(/<td[^>]*>/g) || []).length,
      hasDollarSign: text.indexOf('$') !== -1,
      dollarMatches: (text.match(/\$[\d,]+/g) || []).slice(0, 5),
      parseMethod,
      playersFound: players.length,
      bodyPreview,
    };

    return { players, debug: { url, status, ...parseDetail } };
  } catch (err) {
    const msg = err.name === 'AbortError' ? `Timeout (${timeoutMs}ms)` : (err.message || String(err));
    return { players: [], debug: { url, status, error: msg, bodyPreview } };
  } finally {
    clearTimeout(tid);
  }
}

// ---------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const isDebug = req.query?.debug === '1' || req.url?.includes('debug=1');

  if (!isDebug) {
    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=43200');
  } else {
    res.setHeader('Cache-Control', 'no-store');
  }

  // Try ESPN first (most complete data), then CBS Sports as a fallback.
  const allUrls = [...ESPN_HTML_URLS, ...CBS_HTML_URLS];

  const debugLog = [];
  let bestPlayers = [];

  for (const url of allUrls) {
    const { players, debug } = await fetchAndParse(url);
    debugLog.push(debug);
    if (players.length > bestPlayers.length) bestPlayers = players;
    if (!isDebug && bestPlayers.length >= 50) break;
  }

  if (isDebug) {
    return res.status(200).json({
      bestPlayerCount: bestPlayers.length,
      samplePlayers: bestPlayers.slice(0, 10),
      attempts: debugLog,
    });
  }

  if (bestPlayers.length === 0) {
    return res.status(502).json({
      error: 'No PGA Tour stats data could be parsed',
      hint: 'Hit /api/pgat-stats?debug=1 for diagnostics',
      attempts: debugLog.map(d => ({
        url: d.url,
        status: d.status,
        bodyBytes: d.bodyBytes,
        parseMethod: d.parseMethod,
        error: d.error,
      })),
    });
  }

  return res.status(200).json({
    players: bestPlayers.sort((a, b) => b.earnings - a.earnings),
    count: bestPlayers.length,
    sourceAttempts: debugLog.map(d => ({ url: d.url, count: d.playersFound, parseMethod: d.parseMethod })),
  });
}
