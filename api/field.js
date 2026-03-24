// api/field.js — Vercel serverless function
// Returns the current/upcoming PGA Tour tournament field as an array of player names.
//
// Strategy:
//   1. Fetch pgatour.com/schedule — read tournaments from __NEXT_DATA__
//      path: .props.pageProps.dehydratedState.queries[*].state.data.tournaments
//   2. Find first tournament with status UPCOMING or IN_PROGRESS
//   3. Fetch pgatour.com/tournaments/{year}/{slug}/{id}/field and extract player names
//
// GET /api/field          → { players, tournament, count }
// GET /api/field?debug=1  → diagnostic info

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

async function fetchPage(url) {
  const resp = await fetch(url, { headers: HEADERS });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  return resp.text();
}

function extractNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function nameToSlug(name) {
  return name.toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function walkAll(obj, collect) {
  if (!obj || typeof obj !== 'object') return;
  collect(obj);
  if (Array.isArray(obj)) obj.forEach(o => walkAll(o, collect));
  else Object.values(obj).forEach(v => walkAll(v, collect));
}

// ── Step 1: find upcoming tournament from schedule ────────────────────────────
function findUpcomingTournament(nd) {
  // Walk all queries looking for a tournaments array
  const queries = nd?.props?.pageProps?.dehydratedState?.queries || [];
  let allTournaments = [];

  for (const query of queries) {
    const data = query?.state?.data;
    if (data?.tournaments && Array.isArray(data.tournaments)) {
      allTournaments = allTournaments.concat(data.tournaments);
    }
  }

  if (!allTournaments.length) return { tournament: null, allTournaments };

  // Status priority: IN_PROGRESS > UPCOMING > anything else
  const DONE = ['COMPLETED', 'OFFICIAL', 'PAST', 'CANCELLED'];
  const active = allTournaments.find(t => t.status === 'IN_PROGRESS');
  const upcoming = allTournaments.find(t => t.status === 'UPCOMING');
  const fallback = allTournaments.find(t => !DONE.includes(t.status?.toUpperCase()));
  const tournament = active || upcoming || fallback;

  return { tournament, allTournaments };
}

// ── Step 2: fetch field page and extract player names ─────────────────────────
async function fetchField(tournament, year) {
  const slug = nameToSlug(tournament.name);
  const url = `https://www.pgatour.com/tournaments/${year}/${slug}/${tournament.tournamentId}/field`;
  const html = await fetchPage(url);
  const nd = extractNextData(html);

  const players = new Set();

  if (nd) {
    walkAll(nd, obj => {
      if (obj.displayName && typeof obj.displayName === 'string' && obj.displayName.includes(' ')) {
        players.add(obj.displayName.trim());
      }
      if (obj.firstName && obj.lastName && typeof obj.firstName === 'string') {
        players.add(`${obj.firstName.trim()} ${obj.lastName.trim()}`);
      }
    });
  }

  // Fallback: scrape anchor tags linking to player profiles
  if (players.size < 10) {
    for (const [, name] of html.matchAll(/\/players\/[^"]+">([A-Z][a-z]+ [A-Z][a-zA-Z\s'-]+)</g)) {
      if (name.trim().split(' ').length >= 2) players.add(name.trim());
    }
  }

  return { players: [...players], url };
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=1800');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const isDebug = req.query.debug === '1';
  const year = new Date().getFullYear().toString();

  try {
    const scheduleHtml = await fetchPage('https://www.pgatour.com/schedule');
    const nd = extractNextData(scheduleHtml);
    if (!nd) throw new Error('No __NEXT_DATA__ on pgatour.com/schedule');

    const { tournament, allTournaments } = findUpcomingTournament(nd);

    if (!tournament) {
      return res.status(404).json({
        error: 'No upcoming tournament found',
        totalTournamentsFound: allTournaments.length,
        statuses: [...new Set(allTournaments.map(t => t.status))],
      });
    }

    const { players, url } = await fetchField(tournament, year);

    if (isDebug) {
      return res.status(200).json({
        tournament: { id: tournament.tournamentId, name: tournament.name, status: tournament.status, date: tournament.displayDate },
        fieldUrl: url,
        playerCount: players.length,
        samplePlayers: players.slice(0, 15),
        allStatuses: [...new Set(allTournaments.map(t => t.status))],
      });
    }

    if (!players.length) {
      return res.status(404).json({
        error: `Field not yet posted for ${tournament.name}`,
        tournament: tournament.name,
      });
    }

    return res.status(200).json({
      players,
      tournament: tournament.name,
      count: players.length,
      source: 'pgatour',
    });

  } catch (err) {
    return res.status(503).json({ error: err.message });
  }
}
