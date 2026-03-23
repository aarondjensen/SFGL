// api/field.js — Vercel serverless function
// Returns the current PGA Tour tournament field as an array of player name strings.
//
// Fully automatic — discovers the current week's ESPN event ID from the
// ESPN golf scoreboard, then fetches the field for that event.
//
// GET /api/field          → field data
// GET /api/field?debug=1  → diagnostic info (what event was found, raw counts, etc.)
//
// Returns: { players: string[], tournament: string, eventId: string, source: 'espn', count: number }

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
};

// ── Find current PGA Tour event via the scoreboard ────────────────────────────
// ESPN's golf scoreboard uses ?dates=YYYYMMDD (single date, not a range).
// We try today, then the next few days, to find an event in or near the current week.

async function getCurrentEvent() {
  const attempts = [];

  // Try today + next 14 days — catches next week's field which is often
  // confirmed Sunday/Monday before the tournament. Skip completed events.
  for (let offset = 0; offset <= 14; offset++) {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    const dateStr = toESPNDate(d);
    attempts.push(dateStr);
    try {
      const url = `https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard?dates=${dateStr}`;
      const resp = await fetch(url, { headers: HEADERS });
      if (!resp.ok) continue;
      const data = await resp.json();
      const events = data?.events || [];
      // Filter to PGA Tour events only (slug = 'pga')
      const pga = events.filter(e => e.league?.slug === 'pga' || !e.league);
      if (pga.length > 0) {
        // Prefer upcoming (pre) over in-progress over completed
        const best = pga.find(e => e.status?.type?.state === 'pre')
                  || pga.find(e => e.status?.type?.state === 'in')
                  || pga.find(e => e.status?.type?.state !== 'post')
                  || pga[0];
        return { event: best, dateStr, allEvents: events };
      }
    } catch (_) {
      continue;
    }
  }
  return { event: null, attempts };
}

// ── Fetch field for a known event ID ─────────────────────────────────────────

async function fetchFieldByEventId(eventId) {
  const resp = await fetch(
    `https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard?event=${eventId}&_=${Date.now()}`,
    { headers: HEADERS }
  );
  if (!resp.ok) throw new Error(`ESPN leaderboard returned ${resp.status}`);
  const data = await resp.json();
  const event = data?.events?.[0];
  const competitors = event?.competitions?.[0]?.competitors || [];
  const players = competitors
    .map(p => (p.athlete?.displayName || '').trim())
    .filter(Boolean);
  return {
    players,
    name: event?.name || '',
    state: event?.status?.type?.state || 'unknown',
    competitorCount: competitors.length,
  };
}

function toESPNDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const isDebug = req.query.debug === '1';

  try {
    // Step 1: discover the current event
    const { event, dateStr, allEvents, attempts } = await getCurrentEvent();

    if (!event) {
      return res.status(404).json({
        error: 'Could not find a current PGA Tour event.',
        datesTriedCount: attempts?.length,
        hint: 'Try hitting /api/field?debug=1 for more info',
      });
    }

    // Step 2: fetch the field for that event
    const { players, name, state, competitorCount } = await fetchFieldByEventId(event.id);

    if (isDebug) {
      return res.status(200).json({
        discoveredEvent: { id: event.id, name: event.name, state: event.status?.type?.state },
        fieldState: state,
        competitorCount,
        playersReturned: players.length,
        samplePlayers: players.slice(0, 10),
        dateStr,
        allEventsOnDate: allEvents?.map(e => ({ id: e.id, name: e.name, state: e.status?.type?.state })),
      });
    }

    if (!players.length) {
      return res.status(404).json({
        error: 'Field not yet available — ESPN has not posted competitors for this event yet.',
        tournament: name,
        eventId: event.id,
        state,
        hint: 'Field data typically appears Thu morning when tee times are posted. Try again then.',
      });
    }

    return res.status(200).json({
      players,
      tournament: name,
      eventId: event.id,
      source: 'espn',
      count: players.length,
    });

  } catch (err) {
    return res.status(503).json({ error: err.message });
  }
}
