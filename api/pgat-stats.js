// api/pgat-stats.js — Vercel serverless function
// =====================================================================
// v5 — Switch primary source to CBS Sports money list.
//
// ESPN's golf stats pages are protected by AWS WAF bot detection — they
// return a 202 with a tiny JS challenge page instead of the data. No way
// to defeat that from a serverless function. CBS Sports works fine.
//
// CBS Sports table columns:
//   Rank | Golfer | Ctry | Earnings | Wins | Top-10 | Top-25 | Events |
//   AVG Score | Strokes | Rounds
// (No "Cuts Made" column — that field stays at 0; the client falls back
//  to globalPlayerStats[name]?.cutsMade as before.)
//
// CBS HTML structure for the Golfer cell — two <a> tags per row:
//   <a href="/golf/players/3117436/cameron-young/">C. Young</a>
//   <a href="/golf/players/3117436/cameron-young/">Cameron Young</a>
// We pick the SECOND one (full name). Fallback: parse the href slug.
//
// Cache behaviour:
//   • 200 success → s-maxage=21600 (6h CDN cache)
//   • 502 error   → no-store (never cache errors — this was a v3 bug
//                   where stale 502s lingered on the CDN for 6h)
//
// Debug mode (?debug=1):
//   • Cache-Control: no-store
//   • Returns body previews + per-URL diagnostics + sample players

const CBS_URLS = [
  'https://www.cbssports.com/golf/rankings/money-list/',
];

// ESPN kept as a fallback in case CBS ever breaks. Currently bot-blocked
// but maybe will work again someday.
const ESPN_URLS = [
  'https://www.espn.com/golf/stats/player/_/table/general/sort/amount/dir/desc/count/300',
];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'max-age=0',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
};

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

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------
// CBS-specific parser — knows the column positions and the dual-<a>-tag
// name pattern.
// ---------------------------------------------------------------------
function parseCbsMoneyList(html) {
  const out = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g;
  let rowM;

  while ((rowM = rowRe.exec(html)) !== null) {
    const cells = [];
    let cellM;
    cellRe.lastIndex = 0;
    while ((cellM = cellRe.exec(rowM[1])) !== null) cells.push(cellM[1]);

    // CBS money-list rows have 11 cells: rank | golfer | ctry | earnings |
    // wins | top-10 | top-25 | events | avg | strokes | rounds
    if (cells.length < 8) continue;

    // First cell must be a rank number (filters out header row + footer)
    const rankTxt = stripTags(cells[0]);
    if (!/^\d+$/.test(rankTxt)) continue;

    // Golfer cell — two <a> tags. Take the SECOND one's text (full name).
    // Fallback to first if only one exists, or derive from href slug.
    const golferCell = cells[1];
    const linkMatches = [...golferCell.matchAll(/<a[^>]*href="([^"]*)"[^>]*>([^<]+)<\/a>/g)];
    let name = null;
    if (linkMatches.length >= 2) {
      name = linkMatches[1][2].trim();          // second <a> → full name
    } else if (linkMatches.length === 1) {
      // Single <a> — could be abbrev only. Try to derive full name from URL slug.
      const href = linkMatches[0][1];
      const slugMatch = href.match(/\/players\/\d+\/([^/]+)\/?/);
      if (slugMatch) {
        // Slug like "cameron-young" → "Cameron Young"
        name = slugMatch[1]
          .split('-')
          .filter(Boolean)
          .map(w => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' ');
      } else {
        name = linkMatches[0][2].trim();
      }
    }
    if (!name) continue;
    if (name.length < 4 || name.length > 50) continue;

    // Earnings cell — must contain $
    const earningsCell = cells[3];
    const moneyMatch = stripTags(earningsCell).match(/\$([\d,]+)/);
    if (!moneyMatch) continue;
    const earnings = moneyToNumber(moneyMatch[0]);
    if (!earnings || earnings < 1000) continue;

    // Events cell — index 7 (8th column). CBS renders "—" (em-dash) for
    // players who aren't FedExCup-eligible (non-members, suspended players,
    // etc.). For those rows, leave eventsPlayed as null so the sync handler
    // doesn't overwrite existing legacy data with a bogus 0.
    const eventsTxt = stripTags(cells[7] || '');
    const eventsPlayed = /^\d+$/.test(eventsTxt) ? parseInt(eventsTxt, 10) : null;

    out.push({
      name,
      earnings,
      eventsPlayed,    // null if CBS rendered "—" — sync skips writing it
      cutsMade: null,  // CBS table doesn't have a Cuts column at all
    });
  }

  return out;
}

// ---------------------------------------------------------------------
// Generic fallback parser — for ESPN if it ever comes back or any other
// source with the same general shape. Same logic as v4.
// ---------------------------------------------------------------------
function parseGenericHtmlTable(html) {
  const out = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g;
  let rowM;
  while ((rowM = rowRe.exec(html)) !== null) {
    const cells = [];
    let cellM;
    cellRe.lastIndex = 0;
    while ((cellM = cellRe.exec(rowM[1])) !== null) cells.push(cellM[1]);
    if (cells.length < 5) continue;

    let name = null;
    for (const c of cells) {
      const aMatches = [...c.matchAll(/<a[^>]*>([^<]{4,40})<\/a>/g)];
      if (aMatches.length === 0) continue;
      // Prefer the last <a> (in dual-link tables, this is usually the full name)
      const candidate = aMatches[aMatches.length - 1][1].trim();
      if (candidate.includes(' ') && /^[A-Za-zÀ-ÿ' .-]+$/.test(candidate)) {
        name = candidate;
        break;
      }
    }
    if (!name) continue;

    const moneyCell = cells.find(c => /\$[\d,]+/.test(stripTags(c)));
    const money = moneyCell ? moneyToNumber(stripTags(moneyCell).match(/\$[\d,]+/)[0]) : null;
    if (money === null || money < 1000) continue;

    let events = null;
    const moneyIdx = cells.indexOf(moneyCell);
    for (let i = moneyIdx + 1; i < cells.length; i++) {
      const t = stripTags(cells[i]);
      if (!/^\d+$/.test(t)) continue;
      const n = parseInt(t, 10);
      if (n > 50) continue;
      if (events === null) { events = n; break; }
    }
    out.push({ name, earnings: money, eventsPlayed: events || 0, cutsMade: 0 });
  }
  return out;
}

// ---------------------------------------------------------------------
// Fetch a single URL and parse with the appropriate strategy
// ---------------------------------------------------------------------
async function fetchAndParse(url, timeoutMs = 7000) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);
  let status = null;
  let bodyPreview = null;
  try {
    const resp = await fetch(url, { headers: HEADERS, signal: controller.signal });
    status = resp.status;
    const text = await resp.text();
    bodyPreview = text.slice(0, 2000);
    if (!resp.ok) {
      return { players: [], debug: { url, status, bodyBytes: text.length, bodyPreview, error: `HTTP ${status}` } };
    }

    // Pick parser based on which host we hit
    const isCbs = url.includes('cbssports.com');
    let players = isCbs ? parseCbsMoneyList(text) : [];
    let parseMethod = isCbs ? 'cbs-money-list' : 'none';

    if (!players.length) {
      players = parseGenericHtmlTable(text);
      if (players.length) parseMethod = 'generic-html';
    }

    return {
      players,
      debug: {
        url,
        status,
        contentType: resp.headers.get('content-type') || '',
        bodyBytes: text.length,
        trCount: (text.match(/<tr[^>]*>/g) || []).length,
        tdCount: (text.match(/<td[^>]*>/g) || []).length,
        dollarMatches: (text.match(/\$[\d,]+/g) || []).slice(0, 5),
        parseMethod,
        playersFound: players.length,
        bodyPreview,
      },
    };
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

  // CBS works; ESPN is bot-blocked. CBS first.
  const allUrls = [...CBS_URLS, ...ESPN_URLS];

  const debugLog = [];
  let bestPlayers = [];

  for (const url of allUrls) {
    const { players, debug } = await fetchAndParse(url);
    debugLog.push(debug);
    if (players.length > bestPlayers.length) bestPlayers = players;
    if (!isDebug && bestPlayers.length >= 50) break;
  }

  if (isDebug) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      bestPlayerCount: bestPlayers.length,
      samplePlayers: bestPlayers.slice(0, 10),
      attempts: debugLog,
    });
  }

  if (bestPlayers.length === 0) {
    // CRITICAL: don't cache error responses. The v3 bug was that 502s
    // got s-maxage=21600 same as 200s, leaving stale errors on the CDN
    // for 6 hours after a fix was deployed.
    res.setHeader('Cache-Control', 'no-store');
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

  // Success — cache for 6 hours on the CDN.
  res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=43200');
  return res.status(200).json({
    players: bestPlayers.sort((a, b) => b.earnings - a.earnings),
    count: bestPlayers.length,
    sourceAttempts: debugLog.map(d => ({ url: d.url, count: d.playersFound, parseMethod: d.parseMethod })),
  });
}
