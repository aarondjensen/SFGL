// api/field.js — Vercel serverless function
// Returns the current/upcoming PGA Tour tournament field with tee times.
//
// Strategy:
//   1. Fetch pgatour.com/schedule — read tournaments array from __NEXT_DATA__
//   2. Find first UPCOMING or IN_PROGRESS tournament
//   3. Fetch pgatour.com/tournaments/{year}/{slug}/{id}/field — extract players + tee times
//
// GET /api/field          → { players: string[], teeTimes: {name, teeTime, group}[], tournament, count }
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

// Format a tee time ISO string to "8:04 AM" in ET
function formatTeeTime(isoStr) {
  if (!isoStr) return null;
  try {
    const d = new Date(isoStr);
    return d.toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: true,
      timeZone: 'America/New_York',
    });
  } catch { return null; }
}

// ── Step 1: find upcoming tournament ─────────────────────────────────────────
function findUpcomingTournament(nd) {
  const queries = nd?.props?.pageProps?.dehydratedState?.queries || [];
  let allTournaments = [];
  for (const query of queries) {
    const data = query?.state?.data;
    if (data?.tournaments && Array.isArray(data.tournaments)) {
      allTournaments = allTournaments.concat(data.tournaments);
    }
  }
  const seen = new Set();
  const unique = allTournaments.filter(t => { if (seen.has(t.tournamentId)) return false; seen.add(t.tournamentId); return true; });
  const DONE = ['COMPLETED', 'OFFICIAL', 'PAST', 'CANCELLED'];
  const active = unique.find(t => t.status === 'IN_PROGRESS');
  const upcoming = unique.find(t => t.status === 'UPCOMING');
  const fallback = unique.find(t => !DONE.includes(t.status?.toUpperCase()));
  return { tournament: active || upcoming || fallback, allTournaments: unique };
}

// ── Step 2: fetch field + tee times ──────────────────────────────────────────
async function fetchField(tournament, year) {
  const slug = nameToSlug(tournament.name);
  const url = `https://www.pgatour.com/tournaments/${year}/${slug}/${tournament.tournamentId}/field`;
  const html = await fetchPage(url);
  const nd = extractNextData(html);

  const playerNames = new Set();
  // Map: normalized name → tee time string
  const teeTimeMap = {};
  // Collect raw tee time objects for debug
  const rawTeeTimeObjs = [];

  if (nd) {
    walkAll(nd, obj => {
      // Player name extraction
      const name = obj.displayName?.trim() || (obj.firstName && obj.lastName ? `${obj.firstName.trim()} ${obj.lastName.trim()}` : null);
      if (name && name.includes(' ')) {
        playerNames.add(name);
        // Capture tee time if present on this same object
        const tt = obj.teeTime || obj.teeTimeLocal || obj.startTime || obj.time;
        if (tt && typeof tt === 'string' && (tt.includes('T') || tt.includes(':'))) {
          teeTimeMap[name] = formatTeeTime(tt) || tt;
        }
      }

      // Also look for tee time group objects: { teeTime, players: [...] }
      if ((obj.teeTime || obj.startTime) && Array.isArray(obj.players)) {
        const tt = formatTeeTime(obj.teeTime || obj.startTime);
        rawTeeTimeObjs.push({ tt, count: obj.players.length, sample: JSON.stringify(obj.players[0]).slice(0, 100) });
        obj.players.forEach(p => {
          const pname = p.displayName?.trim() || (p.firstName && p.lastName ? `${p.firstName.trim()} ${p.lastName.trim()}` : null);
          if (pname && tt) teeTimeMap[pname] = tt;
        });
      }
    });
  }

  // Fallback scrape
  if (playerNames.size < 10) {
    for (const [, name] of html.matchAll(/\/players\/[^"]+">([A-Z][a-z]+ [A-Z][a-zA-Z\s'-]+)</g)) {
      if (name.trim().split(' ').length >= 2) playerNames.add(name.trim());
    }
  }

  // Deduplicate — PGA Tour returns both "First Last" and "Last, First" formats.
  // Keep "First Last" and drop the "Last, First" duplicate if both exist.
  const allNames = [...playerNames];
  const players = allNames.filter(name => {
    if (!name.includes(',')) return true;
    const [last, first] = name.split(',').map(s => s.trim());
    return first ? !playerNames.has(`${first} ${last}`) : true;
  });

  // Normalize teeTimeMap keys to "First Last" format
  const normTeeTimeMap = {};
  Object.entries(teeTimeMap).forEach(([k, v]) => {
    if (k.includes(',')) {
      const [last, first] = k.split(',').map(s => s.trim());
      if (first) normTeeTimeMap[`${first} ${last}`] = v;
    } else {
      normTeeTimeMap[k] = v;
    }
  });

  const teeTimes = players
    .filter(n => normTeeTimeMap[n])
    .map(n => ({ name: n, teeTime: normTeeTimeMap[n] }));

  return { players, teeTimes, url, rawTeeTimeObjs };
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
        statuses: [...new Set(allTournaments.map(t => t.status))],
      });
    }

    const { players, teeTimes, url, rawTeeTimeObjs } = await fetchField(tournament, year);

    if (isDebug) {
      return res.status(200).json({
        tournament: { id: tournament.tournamentId, name: tournament.name, status: tournament.status },
        fieldUrl: url,
        playerCount: players.length,
        teeTimeCount: teeTimes.length,
        samplePlayers: players.slice(0, 10),
        sampleTeeTimes: teeTimes.slice(0, 10),
        rawTeeTimeObjs: rawTeeTimeObjs.slice(0, 5),
      });
    }

    if (!players.length) {
      return res.status(404).json({ error: `Field not yet posted for ${tournament.name}`, tournament: tournament.name });
    }

    return res.status(200).json({
      players,
      teeTimes,
      tournament: tournament.name,
      count: players.length,
      source: 'pgatour',
    });

  } catch (err) {
    return res.status(503).json({ error: err.message });
  }
}
