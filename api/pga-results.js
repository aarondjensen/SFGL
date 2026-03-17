// api/pga-results.js — Vercel serverless function
// Fetches official earnings from PGA Tour past-results pages.
//
// Resolution order (first match wins):
//   1. ?url=<full past-results URL>
//   2. ?pgaTourId=R2026011&name=...
//   3. ?name=The+Players&year=2026  (schedule lookup)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { url: directUrl, pgaTourId, name, year, debug } = req.query;
  const resolvedYear = year || new Date().getFullYear().toString();

  let pastResultsUrl = null;

  if (directUrl) {
    pastResultsUrl = directUrl;
  } else if (pgaTourId && name) {
    pastResultsUrl = `https://www.pgatour.com/tournaments/${resolvedYear}/${nameToSlug(name)}/${pgaTourId}/past-results`;
  } else if (name) {
    try {
      pastResultsUrl = await lookupFromSchedule(name, resolvedYear);
    } catch (err) {
      return res.status(404).json({ error: `Could not find "${name}" on PGA Tour schedule. Try providing the past-results URL directly.` });
    }
  } else {
    return res.status(400).json({ error: 'Provide ?url=, ?pgaTourId=+?name=, or ?name=' });
  }

  try {
    const html = await fetchPage(pastResultsUrl);

    // ── Debug mode ──────────────────────────────────────────────────────────
    if (debug === '1') {
      const nd = extractNextData(html);
      const ndSize = nd ? JSON.stringify(nd).length : 0;

      // Search for round leader patterns in the HTML
      const leaderSearchTerms = [
        'Round 1 Leader', 'Round 2 Leader', 'Round 3 Leader',
        'round1Leader', 'round2Leader', 'round3Leader',
        'roundLeader', 'R1 Leader', 'R2 Leader', 'R3 Leader',
        'round-leader', 'leaderR1', 'leaderR2', 'leaderR3',
        'Maverick McNealy', // known R1 leader for THE PLAYERS
        'Ludvig', // known R2 leader
      ];
      const leaderContexts = {};
      for (const term of leaderSearchTerms) {
        const idx = html.indexOf(term);
        if (idx >= 0) {
          leaderContexts[term] = html.slice(Math.max(0, idx - 200), idx + 400)
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 500);
        }
      }

      // Also grab the __NEXT_DATA__ keys at top level to see what's there
      const ndKeys = nd ? Object.keys(nd) : [];
      const ndPropsKeys = nd?.props ? Object.keys(nd.props) : [];
      const ndPagePropsKeys = nd?.props?.pageProps ? Object.keys(nd.props.pageProps) : [];

      const { players } = parseResults(html);

      return res.status(200).json({
        resolvedUrl: pastResultsUrl,
        htmlLength: html.length,
        nextDataSize: ndSize,
        ndKeys,
        ndPropsKeys,
        ndPagePropsKeys,
        leaderContexts,
        playersFoundCount: players.length,
        topThree: players.filter(p => p.earnings > 0).slice(0, 3),
        currentRoundLeaders: players.length ? parseResults(html).roundLeaders : null,
      });
    }

    // ── Parse ──────────────────────────────────────────────────────────────
    const { players, roundLeaders } = parseResults(html);

    if (!players.length) {
      return res.status(404).json({
        error: 'No player results found. The page may not have final results yet.',
        url: pastResultsUrl,
      });
    }

    return res.status(200).json({ players, roundLeaders, resolvedUrl: pastResultsUrl });

  } catch (err) {
    return res.status(500).json({ error: err.message, url: pastResultsUrl });
  }
}

// ─────────────────────────────────────────────────────────────────────────────

function nameToSlug(name) {
  return name.toLowerCase().replace(/['']/g, '').replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
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
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  return resp.text();
}

function extractNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

async function lookupFromSchedule(name, year) {
  const html = await fetchPage('https://www.pgatour.com/schedule');
  const nd = extractNextData(html);
  if (nd) {
    const list = [];
    const walk = (o) => {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) { o.forEach(walk); return; }
      if (o.tournamentId && o.name) list.push({ id: o.tournamentId, slug: o.tournamentSlug || nameToSlug(o.name), name: o.name });
      Object.values(o).forEach(walk);
    };
    walk(nd);
    const norm = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const match = list.find(t => {
      const tn = t.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      return tn === norm || tn.includes(norm) || norm.includes(tn.slice(0, 8));
    });
    if (match?.id) return `https://www.pgatour.com/tournaments/${year}/${match.slug}/${match.id}/past-results`;
  }
  // Fallback: scan hrefs
  const norm = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const [, href, slug] of html.matchAll(/href="(\/tournaments\/\d{4}\/([^/]+)\/(R\d+)\/past-results)"/g)) {
    if (slug.replace(/-/g, '').includes(norm.slice(0, 8))) return `https://www.pgatour.com${href}`;
  }
  throw new Error(`Not found: ${name}`);
}

// ── Main parse function ───────────────────────────────────────────────────────

function parseResults(html) {
  const nd = extractNextData(html);

  if (nd) {
    // Walk the entire JSON tree collecting every object that has:
    //   - A player name (any of several known field patterns)
    //   - Any money field (earnings, officialMoney, prize, purse, total, moneyAmount, winnings)
    // This intentionally casts a wide net so we don't miss the winner.

    const playerMap = new Map(); // name -> earnings (keep highest seen)
    const roundLeaders = { round1: [], round2: [], round3: [] };

    const MONEY_KEYS = ['earnings', 'officialMoney', 'prize', 'purse', 'moneyAmount', 'winnings', 'money', 'totalMoney'];
    const NAME_KEYS  = ['displayName', 'name', 'fullName', 'playerName'];

    const walk = (obj) => {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) { obj.forEach(walk); return; }

      // Resolve player name from this object or its nested `player` sub-object
      let playerName = null;
      const src = obj.player || obj; // prefer obj.player if it exists
      for (const k of NAME_KEYS) {
        if (typeof src[k] === 'string' && src[k].trim().length > 2) {
          playerName = src[k].trim();
          break;
        }
      }

      if (playerName) {
        // Find any money value on this object
        let money = null;
        for (const k of MONEY_KEYS) {
          if (k in obj && obj[k] !== null && obj[k] !== undefined) {
            const val = Number(obj[k]);
            if (!isNaN(val)) { money = val; break; }
          }
        }
        // Also check inside obj.player for money keys
        if (money === null && obj.player) {
          for (const k of MONEY_KEYS) {
            if (k in obj.player && obj.player[k] !== null) {
              const val = Number(obj.player[k]);
              if (!isNaN(val)) { money = val; break; }
            }
          }
        }

        if (money !== null) {
          // Keep the highest earnings value seen for this player
          // (handles case where winner appears first with earnings=null/0 in a banner object,
          //  then again with real earnings in the leaderboard array)
          const current = playerMap.get(playerName) ?? -1;
          if (money > current) playerMap.set(playerName, money);
        }
      }

      // Round leaders
      if (obj.roundLeader) {
        const rl = obj.roundLeader;
        const toNames = (v) => !v ? [] : (Array.isArray(v) ? v : [v]).map(p => (typeof p === 'string' ? p : p?.displayName || p?.name || '').trim()).filter(Boolean);
        if (rl.round1) roundLeaders.round1 = toNames(rl.round1);
        if (rl.round2) roundLeaders.round2 = toNames(rl.round2);
        if (rl.round3) roundLeaders.round3 = toNames(rl.round3);
      }
      if (obj.leadersByRound) {
        const rl = obj.leadersByRound;
        const toNames = (v) => !v ? [] : (Array.isArray(v) ? v : [v]).map(p => (typeof p === 'string' ? p : p?.displayName || p?.name || '').trim()).filter(Boolean);
        if (rl.r1 || rl.round1) roundLeaders.round1 = toNames(rl.r1 || rl.round1);
        if (rl.r2 || rl.round2) roundLeaders.round2 = toNames(rl.r2 || rl.round2);
        if (rl.r3 || rl.round3) roundLeaders.round3 = toNames(rl.r3 || rl.round3);
      }

      for (const v of Object.values(obj)) {
        if (v && typeof v === 'object') walk(v);
      }
    };

    walk(nd);

    if (playerMap.size > 0) {
      const players = [...playerMap.entries()]
        .map(([name, earnings]) => ({ name, earnings }))
        .sort((a, b) => b.earnings - a.earnings);
      console.log(`[pga-results] __NEXT_DATA__ found ${players.length} players, top: ${players[0]?.name} $${players[0]?.earnings}`);
      return { players, roundLeaders };
    }

    console.log('[pga-results] __NEXT_DATA__ found no players, falling back to HTML table');
  }

  // ── HTML table fallback ───────────────────────────────────────────────────
  return parseHtmlTable(html);
}

// ── HTML table parser (fallback) ──────────────────────────────────────────────

function parseHtmlTable(html) {
  const players = [];
  const seenNames = new Set();
  const roundLeaders = { round1: [], round2: [], round3: [] };

  for (const rowMatch of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row = rowMatch[1];
    if (/<th/i.test(row)) continue;

    const cells = [];
    for (const cellMatch of row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)) {
      cells.push(stripTags(cellMatch[1]).trim());
    }
    if (cells.length < 3) continue;

    // Money cell: 4+ digit number (with or without $ or commas), or exactly $0 / 0
    let moneyIdx = -1;
    for (let i = cells.length - 1; i >= 1; i--) {
      const stripped = cells[i].replace(/[$,\s]/g, '');
      if (/^\d+$/.test(stripped) && (stripped.length >= 4 || cells[i] === '$0' || cells[i] === '0')) {
        moneyIdx = i;
        break;
      }
    }
    if (moneyIdx < 1) continue;

    const nameIdx = findNameCell(cells, moneyIdx);
    if (nameIdx === -1) continue;

    const name = cleanName(cells[nameIdx]);
    if (!name || name.length < 4 || seenNames.has(name)) continue;

    const rawMoney = cells[moneyIdx].replace(/[^0-9]/g, '');
    seenNames.add(name);
    players.push({ name, earnings: rawMoney ? parseInt(rawMoney) : 0 });
  }

  // Round leaders
  const r1 = html.match(/[Rr]ound\s*1\s*[Ll]eader[^<]*<[^>]*>([^<]+)/);
  const r2 = html.match(/[Rr]ound\s*2\s*[Ll]eader[^<]*<[^>]*>([^<]+)/);
  const r3 = html.match(/[Rr]ound\s*3\s*[Ll]eader[^<]*<[^>]*>([^<]+)/);
  if (r1) roundLeaders.round1 = [cleanName(r1[1])];
  if (r2) roundLeaders.round2 = [cleanName(r2[1])];
  if (r3) roundLeaders.round3 = [cleanName(r3[1])];

  console.log(`[pga-results] HTML table fallback found ${players.length} players`);
  return { players, roundLeaders };
}

function findNameCell(cells, moneyIdx) {
  for (let i = moneyIdx - 1; i >= 0; i--) {
    const c = cells[i];
    if (c.length < 4 || /\d/.test(c)) continue;
    if (/^[T]?\d/.test(c) || /^[-+]\d/.test(c)) continue;
    if (c.split(/\s+/).length >= 2 && /\p{L}/u.test(c)) return i;
  }
  return -1;
}

function stripTags(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '') // remove inline <style> blocks (Chakra UI injects these per-cell)
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '') // remove any inline scripts too
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, '')
    .replace(/\s+/g, ' ').trim();
}

function cleanName(raw) {
  return raw.replace(/\s+/g, ' ').replace(/[^\p{L}\p{N}\s'.,-]/gu, '').trim();
}

// ── Debug helpers ─────────────────────────────────────────────────────────────

function walkForDebug(obj, results, maxDepth, depth = 0, path = '') {
  if (!obj || typeof obj !== 'object' || depth > maxDepth) return;
  if (Array.isArray(obj)) {
    obj.slice(0, 2).forEach((item, i) => walkForDebug(item, results, maxDepth, depth + 1, `${path}[${i}]`));
    return;
  }
  const MONEY_KEYS = ['earnings', 'officialMoney', 'prize', 'purse', 'moneyAmount', 'winnings', 'money'];
  const NAME_KEYS  = ['displayName', 'name', 'fullName', 'playerName'];
  const hasMoneyKey = MONEY_KEYS.some(k => k in obj);
  const hasNameKey  = NAME_KEYS.some(k => typeof obj[k] === 'string') || NAME_KEYS.some(k => typeof obj.player?.[k] === 'string');
  if (hasMoneyKey && hasNameKey && results.length < 5) {
    results.push({ path, keys: Object.keys(obj), sample: JSON.stringify(obj).slice(0, 400) });
  }
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object') walkForDebug(v, results, maxDepth, depth + 1, `${path}.${k}`);
  }
}
