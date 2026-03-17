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

  const { url: directUrl, pgaTourId, name, year, debug } = req.query;
  const resolvedYear = year || new Date().getFullYear().toString();
  const debugMode = debug === '1';

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
    const parsed = parsePastResults(html, debugMode);

    if (debugMode) {
      // Return raw debug info instead of parsed results
      const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      let nextDataKeys = [];
      let samplePaths = [];
      if (nextDataMatch) {
        try {
          const nd = JSON.parse(nextDataMatch[1]);
          nextDataKeys = Object.keys(nd);
          samplePaths = findDeepPaths(nd, 'earnings', 5);
        } catch (_) {}
      }
      return res.status(200).json({
        resolvedUrl: pastResultsUrl,
        htmlLength: html.length,
        hasNextData: !!nextDataMatch,
        nextDataTopKeys: nextDataKeys,
        earningsKeyPaths: samplePaths,
        parsedCount: parsed.players.length,
        firstFew: parsed.players.slice(0, 5),
      });
    }

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
    .replace(/['']/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
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
  const scheduleUrl = `https://www.pgatour.com/schedule`;
  const html = await fetchPage(scheduleUrl);

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

// Debug helper: find all JSON paths where a key exists
function findDeepPaths(obj, key, maxResults = 5, path = '', results = []) {
  if (results.length >= maxResults) return results;
  if (!obj || typeof obj !== 'object') return results;
  if (Array.isArray(obj)) {
    obj.slice(0, 3).forEach((item, i) => findDeepPaths(item, key, maxResults, `${path}[${i}]`, results));
  } else {
    for (const [k, v] of Object.entries(obj)) {
      if (k === key) results.push(`${path}.${k} = ${JSON.stringify(v)?.slice(0, 80)}`);
      if (v && typeof v === 'object') findDeepPaths(v, key, maxResults, `${path}.${k}`, results);
      if (results.length >= maxResults) break;
    }
  }
  return results;
}

function parsePastResults(html, debugMode = false) {
  const players = [];
  const roundLeaders = { round1: [], round2: [], round3: [] };

  // ── Try __NEXT_DATA__ JSON first (most reliable) ──────────────────────────
  const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextDataMatch) {
    try {
      const nextData = JSON.parse(nextDataMatch[1]);
      const pastResults = findPastResultsInNextData(nextData);
      if (pastResults?.players?.length) {
        console.log(`[pga-results] __NEXT_DATA__ found ${pastResults.players.length} players`);
        return pastResults;
      }
      console.log('[pga-results] __NEXT_DATA__ parsed but no players found, falling back to HTML table');
    } catch (err) {
      console.log('[pga-results] __NEXT_DATA__ parse error:', err.message);
    }
  }

  // ── Fallback: parse HTML table ────────────────────────────────────────────
  // PGA Tour past-results table columns: Pos | Player | R1 | R2 | R3 | R4 | Tot | Money
  // We find rows with a money column ($x,xxx,xxx format) and extract name + money.
  // We also include $0 rows (MC/WD) by scanning for player names near money-like cells.

  const seenNames = new Set();

  // First pass: rows with actual earnings > 0
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

    // Find money cell: $x,xxx,xxx or plain digits with commas >= 4 digits
    // Also allow $0 and plain 0 for MC/WD rows
    const moneyIdx = cells.findIndex(c => {
      const stripped = c.replace(/[$,\s]/g, '');
      return /^\d+$/.test(stripped) && stripped.length >= 4;
    });

    // Also check for $0 / "0" at the end (MC/WD)
    const zeroMoneyIdx = moneyIdx === -1
      ? cells.findLastIndex(c => c === '$0' || c === '0' || c === '--')
      : -1;

    const effectiveMoneyIdx = moneyIdx !== -1 ? moneyIdx : zeroMoneyIdx;
    if (effectiveMoneyIdx < 1) continue;

    const nameIdx = findNameCell(cells, effectiveMoneyIdx);
    if (nameIdx === -1) continue;

    const name = cleanPlayerName(cells[nameIdx]);
    const rawMoney = cells[effectiveMoneyIdx].replace(/[^0-9]/g, '');
    const earnings = rawMoney ? parseInt(rawMoney) : 0;

    if (name && name.length > 3 && !seenNames.has(name)) {
      seenNames.add(name);
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

  console.log(`[pga-results] HTML table fallback found ${players.length} players`);
  return { players, roundLeaders };
}

function findPastResultsInNextData(data) {
  const players = [];
  const roundLeaders = { round1: [], round2: [], round3: [] };
  const seenNames = new Set();

  // Unlimited depth walk — PGA Tour Apollo cache can be deeply nested
  const walk = (obj) => {
    if (!obj || typeof obj !== 'object') return;

    if (Array.isArray(obj)) {
      obj.forEach(walk);
      return;
    }

    // PGA Tour shape 1: { player: { displayName }, earnings }
    // earnings can be 0 for MC/WD — must check !== undefined, not truthiness
    if (obj.player?.displayName && 'earnings' in obj) {
      const name = obj.player.displayName;
      if (!seenNames.has(name)) {
        seenNames.add(name);
        players.push({ name, earnings: obj.earnings ?? 0 });
      }
      // Still walk children for roundLeader data
    }

    // PGA Tour shape 2: { displayName, officialMoney }
    if (obj.displayName && 'officialMoney' in obj) {
      const name = obj.displayName;
      if (!seenNames.has(name)) {
        seenNames.add(name);
        players.push({ name, earnings: obj.officialMoney ?? 0 });
      }
    }

    // Round leaders — various shapes PGA Tour has used
    if (obj.roundLeader) {
      const rl = obj.roundLeader;
      const toNames = (v) => {
        if (!v) return [];
        if (Array.isArray(v)) return v.map(p => (typeof p === 'string' ? p : p.displayName || p.name || ''));
        return [typeof v === 'string' ? v : v.displayName || v.name || ''];
      };
      if (rl.round1) roundLeaders.round1 = toNames(rl.round1);
      if (rl.round2) roundLeaders.round2 = toNames(rl.round2);
      if (rl.round3) roundLeaders.round3 = toNames(rl.round3);
    }

    // Also handle: { leadersByRound: { r1: [...], r2: [...], r3: [...] } }
    if (obj.leadersByRound) {
      const rl = obj.leadersByRound;
      const toNames = (v) => !v ? [] : Array.isArray(v) ? v.map(p => p.displayName || p.name || p) : [v.displayName || v.name || v];
      if (rl.r1 || rl.round1) roundLeaders.round1 = toNames(rl.r1 || rl.round1);
      if (rl.r2 || rl.round2) roundLeaders.round2 = toNames(rl.r2 || rl.round2);
      if (rl.r3 || rl.round3) roundLeaders.round3 = toNames(rl.r3 || rl.round3);
    }

    // Walk all children
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object') walk(v);
    }
  };

  walk(data);
  return players.length ? { players, roundLeaders } : null;
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, '').trim();
}

function findNameCell(cells, moneyIdx) {
  // Walk backwards from money cell looking for a player name (2+ words, letters/spaces/hyphens)
  for (let i = moneyIdx - 1; i >= 0; i--) {
    const c = cells[i];
    if (/^[A-Za-z][A-Za-z\s'.,-]{4,}$/.test(c) && c.split(/\s+/).length >= 2) {
      return i;
    }
  }
  return -1;
}

function cleanPlayerName(raw) {
  return raw.replace(/\s+/g, ' ').replace(/[^\w\s'.,-]/g, '').trim();
}
