// api/field.js — Vercel serverless function
// Returns the current/upcoming PGA Tour tournament field as an array of player names.
//
// Strategy:
//   1. Fetch pgatour.com/schedule — parse __NEXT_DATA__ to find the next upcoming tournament
//   2. Fetch pgatour.com/tournaments/{year}/{slug}/{id}/field — parse __NEXT_DATA__ for competitors
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

function walkAll(obj, collect) {
  if (!obj || typeof obj !== 'object') return;
  collect(obj);
  if (Array.isArray(obj)) obj.forEach(o => walkAll(o, collect));
  else Object.values(obj).forEach(v => walkAll(v, collect));
}

// ── Step 1: find the next upcoming tournament from the schedule ───────────────
async function findUpcomingTournament(year) {
  const html = await fetchPage('https://www.pgatour.com/schedule');
  const nd = extractNextData(html);
  if (!nd) throw new Error('No __NEXT_DATA__ on schedule page');

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const tournaments = [];
  walkAll(nd, obj => {
    if (obj.tournamentId && obj.name && (obj.startDate || obj.date)) {
      tournaments.push({
        id:     obj.tournamentId,
        slug:   obj.tournamentSlug || obj.tournamentId.toLowerCase(),
        name:   obj.name,
        date:   new Date(obj.startDate || obj.date),
        endDate: obj.endDate ? new Date(obj.endDate) : null,
        status: (obj.status || obj.statusV2 || '').toLowerCase(),
      });
    }
  });

  // Deduplicate by ID
  const seen = new Set();
  const unique = tournaments.filter(t => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });

  unique.sort((a, b) => a.date - b.date);

  // Find first tournament that hasn't ended yet
  // "completed" and "official" mean it's done — everything else is fair game
  const DONE = ['completed', 'official', 'past'];
  const upcoming = unique.find(t => {
    if (DONE.some(s => t.status.includes(s))) return false;
    // Also skip if end date is in the past
    if (t.endDate && t.endDate < today) return false;
    return true;
  });

  // Last resort: just find the nearest future start date
  const fallback = upcoming || unique.find(t => t.date >= today) || unique[unique.length - 1];

  return { tournament: fallback, allTournaments: unique };
}

// ── Step 2: fetch the field page and extract player names ─────────────────────
async function fetchField(tournament, year) {
  const url = `https://www.pgatour.com/tournaments/${year}/${tournament.slug}/${tournament.id}/field`;
  const html = await fetchPage(url);
  const nd = extractNextData(html);

  const players = new Set();

  if (nd) {
    walkAll(nd, obj => {
      if (obj.displayName && typeof obj.displayName === 'string' && obj.displayName.trim().includes(' ')) {
        players.add(obj.displayName.trim());
      }
      if (obj.firstName && obj.lastName && typeof obj.firstName === 'string') {
        players.add(`${obj.firstName.trim()} ${obj.lastName.trim()}`);
      }
      if (obj.playerName && typeof obj.playerName === 'string' && obj.playerName.trim().includes(' ')) {
        players.add(obj.playerName.trim());
      }
    });
  }

  // Fallback: scrape player names from HTML
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
    const { tournament, allTournaments } = await findUpcomingTournament(year);

    if (!tournament) {
      return res.status(404).json({ error: 'No upcoming tournament found on schedule' });
    }

    const { players, url } = await fetchField(tournament, year);

    if (isDebug) {
      return res.status(200).json({
        tournament: { id: tournament.id, slug: tournament.slug, name: tournament.name, date: tournament.date, status: tournament.status },
        fieldUrl: url,
        playerCount: players.length,
        samplePlayers: players.slice(0, 15),
        // Show all tournaments found for debugging status values
        allTournamentsFound: allTournaments.map(t => ({ id: t.id, name: t.name, status: t.status, date: t.date })),
      });
    }

    if (!players.length) {
      return res.status(404).json({
        error: 'Field not yet posted for ' + tournament.name,
        tournament: tournament.name,
        hint: 'PGA Tour typically posts the field Sunday or Monday before the event.',
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
