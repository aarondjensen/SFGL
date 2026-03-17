/**
 * api/pga-results.js
 * Vercel serverless function — fetches and parses PGA Tour past results.
 *
 * Strategy:
 * 1. Fetch pgatour.com/schedule server-side (works without CORS issues)
 * 2. Parse tournament URLs from the HTML to find slug + ID for the requested tournament
 * 3. Fetch the past-results page and parse earnings + round leaders from the table
 *
 * Query params: ?name=THE PLAYERS Championship&year=2026
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { name, year = new Date().getFullYear() } = req.query;
  if (!name) return res.status(400).json({ error: 'Missing name param' });

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  // ── Step 1: Fetch the PGA Tour schedule to find the tournament URL ──────────
  let pastResultsUrl = null;

  try {
    const schedResp = await fetch('https://www.pgatour.com/schedule', { headers });
    if (schedResp.ok) {
      const schedHtml = await schedResp.text();
      pastResultsUrl = findTournamentUrl(schedHtml, name, year);
    }
  } catch (err) {
    console.error('[pga-results] Schedule fetch error:', err.message);
  }

  if (!pastResultsUrl) {
    return res.status(404).json({
      error: `Could not find PGA Tour URL for "${name}". Try entering results manually.`,
    });
  }

  // ── Step 2: Fetch the past-results page ────────────────────────────────────
  let html = '';
  try {
    const pgaResp = await fetch(pastResultsUrl, { headers });
    if (!pgaResp.ok) {
      return res.status(pgaResp.status).json({
        error: `PGA Tour returned ${pgaResp.status}`,
        url: pastResultsUrl,
      });
    }
    html = await pgaResp.text();
  } catch (err) {
    return res.status(500).json({ error: `Fetch failed: ${err.message}` });
  }

  // ── Step 3: Parse results from the HTML table ──────────────────────────────
  const result = parseResultsHtml(html);

  if (result.playerCount === 0) {
    return res.status(422).json({
      error: 'Could not parse results. The tournament may not be complete yet.',
      url: pastResultsUrl,
    });
  }

  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=300');
  return res.status(200).json({ ...result, tournamentName: name, url: pastResultsUrl });
}

// ── Find the past-results URL for a tournament by name ───────────────────────
function findTournamentUrl(html, tournamentName, year) {
  // Extract all tournament URLs from the schedule page
  // Pattern: /tournaments/2026/some-slug/R2026XXX/leaderboard
  const urlPattern = new RegExp(
    `/tournaments/${year}/([^/"]+)/(R${year}\\d+)/`,
    'gi'
  );

  const normTarget = normStr(tournamentName);
  let bestMatch = null;
  let bestScore = 0;

  let match;
  while ((match = urlPattern.exec(html)) !== null) {
    const slug = match[1];
    const tournId = match[2];
    const normSlug = normStr(slug.replace(/-/g, ' '));

    // Score the match: count shared words
    const targetWords = normTarget.split(' ').filter(w => w.length > 2);
    const slugWords   = normSlug.split(' ').filter(w => w.length > 2);
    const shared = targetWords.filter(w => slugWords.includes(w)).length;
    const score  = shared / Math.max(targetWords.length, slugWords.length);

    if (score > bestScore) {
      bestScore = score;
      bestMatch = { slug, tournId };
    }
  }

  if (!bestMatch || bestScore < 0.3) return null;

  return `https://www.pgatour.com/tournaments/${year}/${bestMatch.slug}/${bestMatch.tournId}/past-results`;
}

function normStr(s) {
  return (s || '').toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Parse the PGA Tour past-results HTML table ────────────────────────────────
function parseResultsHtml(html) {
  const earningsMap = {};
  const rowData = [];

  const stripHtml = (s) =>
    s.replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&nbsp;/g, ' ')
      .replace(/&[a-z]+;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  // Find all <tr> blocks
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch;

  while ((trMatch = trRegex.exec(html)) !== null) {
    const rowHtml = trMatch[1];
    const cells = [];
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let tdMatch;
    while ((tdMatch = tdRegex.exec(rowHtml)) !== null) {
      cells.push(stripHtml(tdMatch[1]));
    }

    // Expect at minimum: Pos | Player | R1 | R2 | R3 | R4 | ToPar | Money
    if (cells.length < 7) continue;

    const pos        = cells[0];
    const playerName = cells[1];

    // Skip header rows
    if (!playerName || playerName === 'Player' || pos === 'Pos' || pos === '') continue;
    // Skip rows where player name is numeric (colgroup etc)
    if (/^\d+$/.test(playerName) || playerName.length < 2) continue;

    const r1       = cells[2];
    const r2       = cells[3];
    const r3       = cells[4];
    const r4       = cells[5];
    const moneyRaw = cells[cells.length - 1];

    const moneyMatch = moneyRaw.replace(/,/g, '').match(/\d+/);
    const earnings   = moneyMatch ? parseInt(moneyMatch[0], 10) : 0;
    const isCut      = ['CUT', 'WD', 'DQ', 'MDF', 'W/D'].includes(pos.toUpperCase().trim());

    earningsMap[playerName] = earnings;
    rowData.push({ name: playerName, rounds: [r1, r2, r3, r4], isCut });
  }

  // ── Compute round leaders ──────────────────────────────────────────────────
  const parseScore = (s) => {
    if (!s || s === '-' || s === '') return null;
    if (s === 'E') return 0;
    const n = parseInt(s.replace(/[^-\d]/g, ''), 10);
    return isNaN(n) ? null : n;
  };

  const roundLeaders = { round1: [], round2: [], round3: [] };
  [1, 2, 3].forEach(roundNum => {
    const scores = rowData
      .map(p => {
        let total = 0;
        for (let i = 0; i < roundNum; i++) {
          const s = parseScore(p.rounds[i]);
          if (s === null) return null;
          total += s;
        }
        return { name: p.name, score: total };
      })
      .filter(Boolean);

    if (scores.length === 0) return;
    const best = Math.min(...scores.map(s => s.score));
    roundLeaders[`round${roundNum}`] = scores
      .filter(s => s.score === best)
      .map(s => s.name);
  });

  const madeCutCount   = Object.values(earningsMap).filter(e => e > 0).length;
  const missedCutCount = rowData.filter(p => p.isCut).length;

  return {
    earningsMap,
    roundLeaders,
    playerCount:    Object.keys(earningsMap).length,
    madeCutCount,
    missedCutCount,
  };
}
