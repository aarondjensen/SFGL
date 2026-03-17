/**
 * api/pga-results.js
 * Vercel serverless function — fetches and parses PGA Tour past results.
 *
 * Query params:
 *   ?url=https://www.pgatour.com/tournaments/2026/the-players-championship/R2026011/past-results
 *
 * OR lookup by name + year (searches schedule page):
 *   ?name=THE PLAYERS Championship&year=2026
 *
 * Returns JSON:
 * {
 *   earningsMap: { [playerName]: earnings },
 *   roundLeaders: { round1: [name], round2: [name], round3: [name] },
 *   playerCount, madeCutCount, missedCutCount, tournamentName, url
 * }
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { url: directUrl, name, year = new Date().getFullYear() } = req.query;

  const fetchHeaders = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  let pastResultsUrl = directUrl || null;

  // ── Find URL via schedule page if not provided directly ───────────────────
  if (!pastResultsUrl) {
    if (!name) return res.status(400).json({ error: 'Missing url or name param' });

    try {
      const schedResp = await fetch('https://www.pgatour.com/schedule', { headers: fetchHeaders });
      if (!schedResp.ok) throw new Error(`Schedule fetch failed: ${schedResp.status}`);
      const schedHtml = await schedResp.text();
      pastResultsUrl  = findTournamentUrl(schedHtml, name, year);
    } catch (err) {
      return res.status(500).json({ error: `Could not fetch schedule: ${err.message}` });
    }

    if (!pastResultsUrl) {
      return res.status(404).json({
        error: `Could not find "${name}" on the PGA Tour schedule. Try again or enter results manually.`,
      });
    }
  }

  // Ensure URL ends with /past-results
  if (!pastResultsUrl.includes('past-results')) {
    pastResultsUrl = pastResultsUrl.replace(/\/$/, '') + '/past-results';
  }

  // ── Fetch the past-results page ────────────────────────────────────────────
  let html = '';
  try {
    const pgaResp = await fetch(pastResultsUrl, { headers: fetchHeaders });
    if (!pgaResp.ok) {
      return res.status(pgaResp.status).json({ error: `PGA Tour returned ${pgaResp.status}`, url: pastResultsUrl });
    }
    html = await pgaResp.text();
  } catch (err) {
    return res.status(500).json({ error: `Fetch failed: ${err.message}` });
  }

  // ── Parse the results table ────────────────────────────────────────────────
  const result = parseResultsHtml(html);

  if (result.playerCount === 0) {
    return res.status(422).json({
      error: 'Could not parse results. The tournament may not be complete yet.',
      url: pastResultsUrl,
    });
  }

  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=300');
  return res.status(200).json({
    ...result,
    tournamentName: name || 'Tournament',
    url: pastResultsUrl,
  });
}

// ── Find tournament URL from schedule HTML ────────────────────────────────────
function findTournamentUrl(html, tournamentName, year) {
  // Extract all /tournaments/{year}/{slug}/{id}/ patterns
  const urlPattern = new RegExp(
    `/tournaments/${year}/([a-z0-9-]+)/(R${year}\\d+)/`,
    'gi'
  );

  const normTarget = normStr(tournamentName);
  const targetWords = normTarget.split(' ').filter(w => w.length > 2);

  let bestMatch = null;
  let bestScore = -1;
  const seen = new Set();

  let match;
  while ((match = urlPattern.exec(html)) !== null) {
    const slug    = match[1];
    const tournId = match[2];
    const key     = `${slug}/${tournId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const normSlug  = normStr(slug.replace(/-/g, ' '));
    const slugWords = normSlug.split(' ').filter(w => w.length > 2);

    const sharedCount = targetWords.filter(w => slugWords.includes(w)).length;
    const score = sharedCount / Math.max(targetWords.length, slugWords.length, 1);

    if (score > bestScore) {
      bestScore = score;
      bestMatch = { slug, tournId };
    }
  }

  if (!bestMatch || bestScore < 0.25) return null;

  return `https://www.pgatour.com/tournaments/${year}/${bestMatch.slug}/${bestMatch.tournId}/past-results`;
}

function normStr(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\b(the|championship|open|invitational|classic|at|of|pga|tour)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Parse the PGA Tour past-results HTML table ────────────────────────────────
function parseResultsHtml(html) {
  const earningsMap = {};
  const rowData     = [];

  // Strip HTML tags from a cell, decode entities, collapse whitespace
  const stripHtml = (s) =>
    s.replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&nbsp;/g, ' ')
      .replace(/&#[0-9]+;/g, '')
      .replace(/&[a-z]+;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  // Only look at the table rows — find the results table first
  // The past-results table has "Official Money" in the header
  const tableMatch = html.match(/<table[\s\S]*?Official Money[\s\S]*?<\/table>/i);
  const tableHtml  = tableMatch ? tableMatch[0] : html;

  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch;

  while ((trMatch = trRegex.exec(tableHtml)) !== null) {
    const rowHtml = trMatch[1];
    const cells   = [];
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let tdMatch;

    while ((tdMatch = tdRegex.exec(rowHtml)) !== null) {
      cells.push(stripHtml(tdMatch[1]));
    }

    // Need at least: Pos | Player | R1 | R2 | ... | Money
    if (cells.length < 7) continue;

    const pos        = cells[0].replace(/\s+/g, '').toUpperCase();
    const playerName = cells[1];

    // Skip header rows and garbage rows
    if (!playerName || playerName.toLowerCase() === 'player') continue;
    if (pos === 'POS' || pos === '') continue;
    // Reject rows where player name contains CSS or is too long (leaked styles)
    if (playerName.includes('{') || playerName.includes(':') || playerName.length > 60) continue;
    // Reject purely numeric names
    if (/^\d+$/.test(playerName)) continue;
    // Must look like a real name (at least one letter, reasonable length)
    if (!/[a-zA-Z]{2,}/.test(playerName)) continue;

    const r1       = cells[2];
    const r2       = cells[3];
    const r3       = cells[4];
    const r4       = cells[5];
    const moneyRaw = cells[cells.length - 1];

    // Parse money — strip $ and commas, find digits
    const moneyClean = moneyRaw.replace(/[$,]/g, '');
    const moneyMatch = moneyClean.match(/^\d+$/);
    const earnings   = moneyMatch ? parseInt(moneyClean, 10) : 0;

    const isCut = ['CUT', 'WD', 'DQ', 'MDF', 'W/D', 'RTD'].includes(pos);

    earningsMap[playerName] = earnings;
    rowData.push({ name: playerName, rounds: [r1, r2, r3, r4], isCut });
  }

  // ── Round leaders ──────────────────────────────────────────────────────────
  const parseScore = (s) => {
    if (!s || s === '-' || s === '' || s === '--') return null;
    if (s === 'E') return 0;
    const clean = s.replace(/[^-+\d]/g, '');
    const n = parseInt(clean, 10);
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

    if (!scores.length) return;
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
