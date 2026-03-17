/**
 * api/pga-results.js
 * Vercel serverless function — fetches and parses the PGA Tour past results page.
 *
 * Query params:
 *   ?name=THE PLAYERS Championship&year=2026
 *
 * Returns JSON:
 * {
 *   earningsMap: { [playerName]: earnings },   // all starters, missed cut = 0
 *   roundLeaders: { round1: [name], round2: [name], round3: [name] },
 *   playerCount: number,
 *   madeCutCount: number,
 *   missedCutCount: number,
 *   tournamentName: string,
 * }
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { name, year = new Date().getFullYear() } = req.query;
  if (!name) return res.status(400).json({ error: 'Missing name param' });

  // Convert tournament name to URL slug: "THE PLAYERS Championship" → "the-players-championship"
  const slug = name.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();

  // PGA Tour tournament IDs follow the pattern R{year}{3-digit-id}
  // We don't know the ID without the schedule, so we fetch the schedule first
  // to find the correct URL for this tournament name.
  const scheduleUrl = `https://www.pgatour.com/schedule`;
  let tournamentUrl = null;

  try {
    const schedResp = await fetch(scheduleUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SFGL/1.0)', 'Accept': 'text/html' },
    });
    if (schedResp.ok) {
      const schedHtml = await schedResp.text();
      // Find tournament URLs matching our slug in the schedule page
      const urlPattern = new RegExp(`/tournaments/${year}/([^/]*${slug.split('-')[0]}[^/]*)/((R|r)${year}\\d+)`, 'i');
      const match = schedHtml.match(urlPattern);
      if (match) {
        tournamentUrl = `https://www.pgatour.com/tournaments/${year}/${match[1]}/${match[2]}/past-results`;
      }

      // Broader search if slug match failed
      if (!match) {
        const allUrls = [...schedHtml.matchAll(/\/tournaments\/(\d{4})\/([^/"]+)\/(R\d+)/g)];
        for (const m of allUrls) {
          if (m[1] == year) {
            const normScheduleName = m[2].replace(/-/g, ' ').toLowerCase();
            const normInput = slug.replace(/-/g, ' ');
            if (normScheduleName.includes(normInput.split(' ')[0]) || normInput.includes(normScheduleName.split(' ')[0])) {
              tournamentUrl = `https://www.pgatour.com/tournaments/${year}/${m[2]}/${m[3]}/past-results`;
              break;
            }
          }
        }
      }
    }
  } catch (_) {}

  // If we couldn't find URL from schedule, construct a guess using slug
  // PGA Tour IDs are stable year to year (same tournament gets same last 3 digits)
  // We'll try a few variations
  if (!tournamentUrl) {
    // Try the slug-based URL with a wildcard search approach
    // Fallback: try fetching the tournament overview page which redirects to the right ID
    const guessUrl = `https://www.pgatour.com/tournaments/${year}/${slug}`;
    try {
      const guessResp = await fetch(guessUrl, {
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SFGL/1.0)' },
      });
      if (guessResp.ok) {
        const finalUrl = guessResp.url;
        const idMatch = finalUrl.match(/(R\d{7,})/);
        if (idMatch) {
          tournamentUrl = `https://www.pgatour.com/tournaments/${year}/${slug}/${idMatch[1]}/past-results`;
        }
      }
    } catch (_) {}
  }

  if (!tournamentUrl) {
    return res.status(404).json({
      error: `Could not find PGA Tour URL for "${name}". Try entering results manually.`
    });
  }

  // Fetch the past results page
  let html = '';
  try {
    const pgaResp = await fetch(tournamentUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!pgaResp.ok) {
      return res.status(pgaResp.status).json({ error: `PGA Tour returned ${pgaResp.status} for ${tournamentUrl}` });
    }
    html = await pgaResp.text();
  } catch (err) {
    return res.status(500).json({ error: `Fetch failed: ${err.message}` });
  }

  // Parse the results table
  const result = parseResultsHtml(html, name);
  if (result.playerCount === 0) {
    return res.status(422).json({
      error: 'Could not parse results from PGA Tour page. The tournament may not be complete yet.',
      url: tournamentUrl,
    });
  }

  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=300');
  return res.status(200).json({ ...result, tournamentName: name, url: tournamentUrl });
}

// ── Parse PGA Tour past results HTML ─────────────────────────────────────────
function parseResultsHtml(html, tournamentName) {
  const earningsMap = {};
  const rowData = []; // { name, rounds: [r1,r2,r3,r4], isCut }

  // Strip all HTML tags from a string
  const stripHtml = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();

  // Find the results table — look for table rows containing player data
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

    // Expect: Pos | Player | R1 | R2 | R3 | R4 | ToPar | FedExPts | Money
    if (cells.length < 7) continue;

    const pos = cells[0];
    const playerName = cells[1];
    if (!playerName || playerName === 'Player' || pos === 'Pos' || pos === '') continue;
    if (/^\d+$/.test(playerName)) continue; // skip numeric cells

    const r1 = cells[2];
    const r2 = cells[3];
    const r3 = cells[4];
    const r4 = cells[5];
    const moneyRaw = cells[cells.length - 1];
    const moneyMatch = moneyRaw.match(/[\d,]+/);
    const earnings = moneyMatch ? parseInt(moneyMatch[0].replace(/,/g, ''), 10) : 0;
    const isCut = ['CUT', 'WD', 'DQ', 'MDF'].includes(pos.toUpperCase());

    earningsMap[playerName] = earnings;
    rowData.push({ name: playerName, rounds: [r1, r2, r3, r4], isCut });
  }

  // Compute round leaders
  const parseScore = (s) => {
    if (!s || s === '-' || s === '') return null;
    if (s === 'E') return 0;
    const n = parseInt(s, 10);
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
    roundLeaders[`round${roundNum}`] = scores.filter(s => s.score === best).map(s => s.name);
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