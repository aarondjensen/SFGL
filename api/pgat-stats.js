// api/pgat-stats.js — Vercel serverless function
// =====================================================================
// v7 — Profile-page scraping for rostered players.
//
// CBS Sports money list works for broad earnings sweep but has no Cuts
// column and renders "—" for non-FedExCup-eligible players. The PGA Tour
// player profile /results sub-page is server-side rendered with the full
// 2026 season stats (Starts, Cuts, Earnings, Wins) and is the cleanest
// source for accurate per-player data.
//
// Strategy:
//   1. CBS sweep — top ~200 by earnings (current behaviour, kept for
//      non-rostered players)
//   2. If `?roster=name1,name2,...` query is provided, additionally:
//      a. Fetch pgatour.com FedExCup standings once → name→{id,slug} map
//      b. Fetch each rostered player's /results page in parallel
//      c. Parse season 2026 stats from the SSR'd HTML
//      d. Merge: profile data overrides CBS for matched rostered players
//
// Response (with roster param):
// {
//   players: [{ name, earnings, eventsPlayed, cutsMade, wins, source }, ...],
//   count, rosteredEnriched, rosteredMissing
// }
//
// Cache behaviour:
//   • 200 success → s-maxage=21600 (6h CDN cache)
//   • 502 error   → no-store

const CBS_URLS = [
  'https://www.cbssports.com/golf/rankings/money-list/',
];

const PGAT_FEDEX_URL = 'https://www.pgatour.com/fedexcup/standings';

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
// Normalization for name matching — must mirror the client (firebase.js)
// ---------------------------------------------------------------------
function normalize(name) {
  if (!name) return '';
  return String(name)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // strip combining diacritics
    .replace(/ø/g, 'o').replace(/Ø/g, 'o')
    .replace(/æ/g, 'ae').replace(/Æ/g, 'ae')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z]/g, '');
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
// CBS Sports money list parser (same as v6)
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
    if (cells.length < 8) continue;

    const rankTxt = stripTags(cells[0]);
    if (!/^\d+$/.test(rankTxt)) continue;

    const golferCell = cells[1];
    const linkMatches = [...golferCell.matchAll(/<a[^>]*href="([^"]*)"[^>]*>([^<]+)<\/a>/g)];
    let name = null;
    if (linkMatches.length >= 2) {
      name = linkMatches[1][2].trim();
    } else if (linkMatches.length === 1) {
      const href = linkMatches[0][1];
      const slugMatch = href.match(/\/players\/\d+\/([^/]+)\/?/);
      if (slugMatch) {
        name = slugMatch[1]
          .split('-')
          .filter(Boolean)
          .map(w => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' ');
      } else {
        name = linkMatches[0][2].trim();
      }
    }
    if (!name || name.length < 4 || name.length > 50) continue;

    const moneyMatch = stripTags(cells[3]).match(/\$([\d,]+)/);
    if (!moneyMatch) continue;
    const earnings = moneyToNumber(moneyMatch[0]);
    if (!earnings || earnings < 1000) continue;

    const eventsTxt = stripTags(cells[7] || '');
    const eventsPlayed = /^\d+$/.test(eventsTxt) ? parseInt(eventsTxt, 10) : null;

    out.push({
      name,
      earnings,
      eventsPlayed,
      cutsMade: null,
      source: 'cbs',
    });
  }
  return out;
}

// ---------------------------------------------------------------------
// PGA Tour FedExCup standings parser — extract name → {id, slug} map
// ---------------------------------------------------------------------
function parseFedExCupIdMap(html) {
  const map = new Map();
  // Pattern: <a href="/player/{id}/{slug}">{Full Name}</a>
  // Some hrefs may be absolute (https://...), some relative
  const re = /href="(?:https?:\/\/(?:www\.)?pgatour\.com)?\/player\/(\d+)\/([^"\/]+)"[^>]*>([^<]+)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const [, id, slug, rawName] = m;
    const name = stripTags(rawName);
    if (name.length < 4 || name.length > 60) continue;
    if (!name.includes(' ')) continue;
    if (!/^[A-Za-zÀ-ÿ' .\-]+$/.test(name)) continue;
    const key = normalize(name);
    // Don't overwrite — first occurrence usually has the cleanest data
    if (!map.has(key)) map.set(key, { id, slug, name });
  }
  return map;
}

// ---------------------------------------------------------------------
// PGA Tour player /results page parser — extract season 2026 stats
//
// The page SSRs a stats block like:
//   <div>Season</div><div>2026</div>
//   <div>Starts</div><div>3<span>Events</span> 3/3<span>Cuts</span></div>
//   <div>Earnings</div><div>$2,832,750<span>Official Money</span></div>
//   <div>Finishes</div><div>1<span>Wins</span> 0<span>2nd</span> ...</div>
//
// After HTML strip + whitespace normalize, the text reads roughly:
//   "Season 2026 Starts 3 Events 3/3 Cuts Earnings $2,832,750 Official Money
//    Finishes 1 Wins 0 2nd ..."
//
// We anchor each stat regex on its unique surrounding label.
// ---------------------------------------------------------------------
function parsePlayerResults(html) {
  // Verify 2026 is the rendered season. Some profiles default to an older
  // season (e.g. a player's last "real" PGA Tour season). Skip those —
  // CBS fallback will cover them.
  const seasonIdx = html.search(/Season[\s\S]{0,800}?2026[\s\S]{0,800}?Starts/i);
  if (seasonIdx < 0) return null;

  // Strip HTML to plain text, scoped to ~2000 chars after the season block
  const text = html.slice(seasonIdx)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .slice(0, 2000);

  // Anchor each stat on its unique label
  const startsMatch    = text.match(/Starts\s*(\d+)\s*Events/i);
  const cutsMatch      = text.match(/(\d+)\s*\/\s*(\d+)\s*Cuts/i);
  const earningsMatch  = text.match(/Earnings\s*\$([\d,]+)\s*Official\s+Money/i);
  const winsMatch      = text.match(/Finishes\s*(\d+)\s*Wins/i);

  // Require at least one core stat to consider this a real parse
  if (!startsMatch && !cutsMatch && !earningsMatch) return null;

  return {
    eventsPlayed: startsMatch  ? parseInt(startsMatch[1], 10)              : null,
    cutsMade:     cutsMatch    ? parseInt(cutsMatch[1], 10)                : null,
    earnings:     earningsMatch ? parseInt(earningsMatch[1].replace(/,/g, ''), 10) : null,
    wins:         winsMatch    ? parseInt(winsMatch[1], 10)                : null,
  };
}

// ---------------------------------------------------------------------
// Fetch helper with timeout
// ---------------------------------------------------------------------
async function fetchWithTimeout(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { headers: HEADERS, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(tid);
  }
}

// ---------------------------------------------------------------------
// Orchestration helpers
// ---------------------------------------------------------------------
async function fetchCbsMoneyList() {
  for (const url of CBS_URLS) {
    try {
      const resp = await fetchWithTimeout(url, 6000);
      if (!resp.ok) continue;
      const html = await resp.text();
      const players = parseCbsMoneyList(html);
      if (players.length > 0) return { players, url, ok: true };
    } catch (err) { /* try next */ }
  }
  return { players: [], ok: false, error: 'cbs_unreachable' };
}

async function fetchPgatIdMap() {
  try {
    const resp = await fetchWithTimeout(PGAT_FEDEX_URL, 6000);
    if (!resp.ok) return null;
    const html = await resp.text();
    const map = parseFedExCupIdMap(html);
    return map.size > 0 ? map : null;
  } catch (err) {
    return null;
  }
}

async function fetchPlayerProfile(id, slug, name) {
  try {
    const url = `https://www.pgatour.com/player/${id}/${slug}/results`;
    const resp = await fetchWithTimeout(url, 5000);
    if (!resp.ok) return { name, status: `http_${resp.status}` };
    const html = await resp.text();
    const stats = parsePlayerResults(html);
    if (!stats) return { name, status: 'no_2026_data' };
    return {
      name,
      earnings: stats.earnings,
      eventsPlayed: stats.eventsPlayed,
      cutsMade: stats.cutsMade,
      wins: stats.wins,
      source: 'pgat_profile',
      status: 'ok',
    };
  } catch (err) {
    return { name, status: err.name === 'AbortError' ? 'timeout' : 'fetch_error' };
  }
}

// ---------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const isDebug = req.query?.debug === '1';
  const rosterParam = req.query?.roster || '';
  const rosterNames = rosterParam
    ? rosterParam.split(',').map(n => decodeURIComponent(n.trim())).filter(Boolean)
    : [];

  // ===== Step 1: CBS broad sweep =====
  const cbsResult = await fetchCbsMoneyList();
  let allPlayers = cbsResult.players;
  const cbsLookup = new Map(allPlayers.map(p => [normalize(p.name), p]));

  // ===== Step 2: If roster names provided, fetch profile data =====
  let profileResults = [];
  let idMapSize = 0;
  if (rosterNames.length > 0) {
    const idMap = await fetchPgatIdMap();
    idMapSize = idMap ? idMap.size : 0;

    if (idMap) {
      // Resolve each roster name to {id, slug}
      const lookups = rosterNames.map(name => {
        const key = normalize(name);
        const info = idMap.get(key);
        return { name, info };
      });

      // Fetch all profiles in parallel
      profileResults = await Promise.all(
        lookups.map(({ name, info }) => {
          if (!info) return { name, status: 'not_in_fedex_standings' };
          return fetchPlayerProfile(info.id, info.slug, info.name);
        })
      );

      // Merge: replace CBS data with profile data for any matched player
      profileResults.forEach(p => {
        if (p.status !== 'ok') return;
        const key = normalize(p.name);
        const cbsPlayer = cbsLookup.get(key);
        if (cbsPlayer) {
          // Override with profile data (more accurate)
          cbsPlayer.earnings     = p.earnings     ?? cbsPlayer.earnings;
          cbsPlayer.eventsPlayed = p.eventsPlayed ?? cbsPlayer.eventsPlayed;
          cbsPlayer.cutsMade     = p.cutsMade     ?? cbsPlayer.cutsMade;
          cbsPlayer.wins         = p.wins         ?? null;
          cbsPlayer.source       = 'pgat_profile';
        } else {
          // Profile player not in CBS top 200 — add them
          allPlayers.push({
            name: p.name,
            earnings: p.earnings,
            eventsPlayed: p.eventsPlayed,
            cutsMade: p.cutsMade,
            wins: p.wins,
            source: 'pgat_profile',
          });
        }
      });
    }
  }

  // ===== Step 3: Return =====
  const rosteredEnriched = profileResults.filter(p => p.status === 'ok').length;
  const rosteredMissing  = profileResults.filter(p => p.status !== 'ok');

  if (isDebug) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      totalPlayers: allPlayers.length,
      cbsCount: cbsResult.players.length,
      rosteredRequested: rosterNames.length,
      rosteredEnriched,
      rosteredMissing,
      idMapSize,
      sample: allPlayers.slice(0, 10),
      profileSample: profileResults.slice(0, 5),
    });
  }

  if (allPlayers.length === 0) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({
      error: 'No PGA Tour stats data could be parsed',
      hint: 'Hit /api/pgat-stats?debug=1 for diagnostics',
    });
  }

  // Cache: shorter when roster param present (per-roster results are
  // unique and shouldn't be cached aggressively); longer for the bare
  // CBS sweep.
  if (rosterNames.length > 0) {
    res.setHeader('Cache-Control', 'no-store');
  } else {
    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=43200');
  }

  return res.status(200).json({
    players: allPlayers.sort((a, b) => (b.earnings || 0) - (a.earnings || 0)),
    count: allPlayers.length,
    rosteredEnriched,
    rosteredMissing: rosteredMissing.map(p => ({ name: p.name, status: p.status })),
  });
}
