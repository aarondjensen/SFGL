// api/pga-results.js — Vercel serverless function
// Fetches official earnings from PGA Tour past-results pages.
//
// Resolution order (first match wins):
//   1. ?url=<full past-results URL>         — commissioner pastes it once; auto-saved on tournament
//   2. ?pgaTourId=R2026011&name=...         — stored on tournament object, URL constructed directly
//   3. ?name=The+Players&year=2026          — schedule lookup (fallback, less reliable)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { url: directUrl, pgaTourId, name, year } = req.query;
  const resolvedYear = year || new Date().getFullYear().toString();

  let pastResultsUrl = null;

  // ── Strategy 1: direct URL ───────────────────────────────────────────────
  if (directUrl) {
    pastResultsUrl = directUrl;
    console.log('[pga-results] Strategy 1 — direct URL:', pastResultsUrl);
  }

  // ── Strategy 2: pgaTourId ────────────────────────────────────────────────
  if (!pastResultsUrl && pgaTourId && name) {
    const slug = nameToSlug(name);
    pastResultsUrl = `https://www.pgatour.com/tournaments/${resolvedYear}/${slug}/${pgaTourId}/past-results`;
    console.log('[pga-results] Strategy 2 — pgaTourId URL:', pastResultsUrl);
  }

  // ── Strategy 3: schedule lookup ──────────────────────────────────────────
  if (!pastResultsUrl && name) {
    try {
      pastResultsUrl = await lookupFromSchedule(name, resolvedYear);
      console.log('[pga-results] Strategy 3 — schedule lookup URL:', pastResultsUrl);
    } catch (err) {
      console.warn('[pga-results] Schedule lookup failed:', err.message);
    }
  }

  if (!pastResultsUrl) {
    return res.status(400).json({
      error: 'Could not determine past-results URL. Provide ?url=, ?pgaTourId=, or ?name=',
    });
  }

  // ── Fetch and parse ──────────────────────────────────────────────────────
  try {
    const html = await fetchPage(pastResultsUrl);
    const parsed = parsePastResults(html);

    if (!parsed.players.length) {
      return res.status(404).json({
        error: `No results found at ${pastResultsUrl}. The page may not have final results yet.`,
        url: pastResultsUrl,
      });
    }

    return res.status(200).json({
      players: parsed.players,
      roundLeaders: parsed.roundLeaders,
      resolvedUrl: pastResultsUrl,
    });
  } catch (err) {
    console.error('[pga-results] Fetch/parse error:', err.message);
    return res.status(500).json({
      error: err.message,
      url: pastResultsUrl,
    });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function nameToSlug(name) {
  return name
    .toLowerCase()
    .replace(/['']/g, '')          // remove apostrophes
    .replace(/[^a-z0-9\s-]/g, '') // strip special chars
    .trim()
    .replace(/\s+/g, '-');         // spaces to hyphens
}

async function fetchPage(url) {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Referer': 'https://www.pgatour.com/',
    },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}`);
  return resp.text();
}

async function lookupFromSchedule(name, year) {
  // Try the PGA Tour schedule page to find the tournament's URL path
  const scheduleUrl = `https://www.pgatour.com/schedule`;
  const html = await fetchPage(scheduleUrl);

  // Look for JSON embedded in __NEXT_DATA__ script tag
  const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextDataMatch) {
    try {
      const nextData = JSON.parse(nextDataMatch[1]);
      const tournaments = extractTournamentsFromNextData(nextData);
      const match = findTournamentByName(tournaments, name);
      if (match?.id && match?.slug) {
        return `https://www.pgatour.com/tournaments/${year}/${match.slug}/${match.id}/past-results`;
      }
    } catch (_) {}
  }

  // Fallback: scan href links for name-matching tournament path
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const hrefMatches = [...html.matchAll(/href="(\/tournaments\/\d{4}\/([^/]+)\/(R\d+)\/past-results)"/g)];
  for (const [, href, slug] of hrefMatches) {
    const slugNorm = slug.replace(/-/g, '');
    if (slugNorm.includes(normalized) || normalized.includes(slugNorm.substring(0, 8))) {
      return `https://www.pgatour.com${href}`;
    }
  }

  throw new Error(`Could not find "${name}" on the PGA Tour schedule`);
}

function extractTournamentsFromNextData(data) {
  const results = [];
  const walk = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { obj.forEach(walk); return; }
    if (obj.tournamentId && obj.name) {
      results.push({ id: obj.tournamentId, slug: obj.tournamentSlug || nameToSlug(obj.name), name: obj.name });
    }
    Object.values(obj).forEach(walk);
  };
  walk(data);
  return results;
}

function findTournamentByName(tournaments, name) {
  const norm = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return tournaments.find(t => {
    const tn = (t.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return tn === norm || tn.includes(norm) || norm.includes(tn.substring(0, 8));
  });
}

function parsePastResults(html) {
  const players = [];
  const roundLeaders = { round1: [], round2: [], round3: [] };

  // ── Try __NEXT_DATA__ JSON first (most reliable) ──────────────────────────
  const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextDataMatch) {
    try {
      const nextData = JSON.parse(nextDataMatch[1]);
      const pastResults = findPastResultsInNextData(nextData);
      if (pastResults?.players?.length) {
        return pastResults;
      }
    } catch (_) {}
  }

  // ── Fallback: parse HTML table ────────────────────────────────────────────
  const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowPattern.exec(html)) !== null) {
    const row = rowMatch[1];
    if (/<th/i.test(row)) continue;

    const cells = [];
    const cellPattern = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    while ((cellMatch = cellPattern.exec(row)) !== null) {
      cells.push(stripTags(cellMatch[1]).trim());
    }

    if (cells.length < 3) continue;

    const moneyIdx = cells.findIndex(c => /^\$?[\d,]+$/.test(c.replace(/\s/g, '')) && parseInt(c.replace(/[^0-9]/g, '')) > 1000);
    if (moneyIdx < 1) continue;

    const nameIdx = findNameCell(cells, moneyIdx);
    if (nameIdx === -1) continue;

    const name = cleanPlayerName(cells[nameIdx]);
    const earnings = parseInt(cells[moneyIdx].replace(/[^0-9]/g, ''));

    if (name && !isNaN(earnings)) {
      players.push({ name, earnings });
    }
  }

  // ── Extract round leaders from HTML ──────────────────────────────────────
  const r1Match = html.match(/[Rr]ound\s*1\s*[Ll]eader[^<]*<[^>]*>([^<]+)/);
  const r2Match = html.match(/[Rr]ound\s*2\s*[Ll]eader[^<]*<[^>]*>([^<]+)/);
  const r3Match = html.match(/[Rr]ound\s*3\s*[Ll]eader[^<]*<[^>]*>([^<]+)/);
  if (r1Match) roundLeaders.round1 = [cleanPlayerName(r1Match[1])];
  if (r2Match) roundLeaders.round2 = [cleanPlayerName(r2Match[1])];
  if (r3Match) roundLeaders.round3 = [cleanPlayerName(r3Match[1])];

  return { players, roundLeaders };
}

function findPastResultsInNextData(data) {
  const players = [];
  const roundLeaders = { round1: [], round2: [], round3: [] };

  const walk = (obj, depth = 0) => {
    if (!obj || typeof obj !== 'object' || depth > 15) return;
    if (Array.isArray(obj)) { obj.forEach(item => walk(item, depth + 1)); return; }

    // PGA Tour shape: { player: { displayName }, earnings }
    if (obj.player?.displayName && obj.earnings !== undefined) {
      players.push({ name: obj.player.displayName, earnings: obj.earnings || 0 });
      return;
    }
    // Alt shape: { displayName, officialMoney }
    if (obj.displayName && obj.officialMoney !== undefined) {
      players.push({ name: obj.displayName, earnings: obj.officialMoney || 0 });
      return;
    }

    // Round leaders
    if (obj.roundLeader) {
      const rl = obj.roundLeader;
      const toNames = (v) => Array.isArray(v) ? v.map(p => p.displayName || p) : (v ? [v.displayName || v] : []);
      if (rl.round1) roundLeaders.round1 = toNames(rl.round1);
      if (rl.round2) roundLeaders.round2 = toNames(rl.round2);
      if (rl.round3) roundLeaders.round3 = toNames(rl.round3);
    }

    Object.values(obj).forEach(v => walk(v, depth + 1));
  };
  walk(data);

  return players.length ? { players, roundLeaders } : null;
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, '').trim();
}

function findNameCell(cells, moneyIdx) {
  for (let i = moneyIdx - 1; i >= 0; i--) {
    const c = cells[i];
    if (/^[A-Za-z][A-Za-z\s'.,-]{5,}$/.test(c) && c.split(/\s+/).length >= 2) {
      return i;
    }
  }
  return -1;
}

function cleanPlayerName(raw) {
  return raw.replace(/\s+/g, ' ').replace(/[^\w\s'.,-]/g, '').trim();
}
