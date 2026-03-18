// api/field.js — Vercel serverless function
// Returns the current PGA Tour tournament field as an array of player name strings.
//
// Fully automatic — discovers the current week's ESPN event ID by querying
// the ESPN scoreboard API. No manual ID updates needed week to week.
//
// GET /api/field
// Returns: { players: string[], tournament: string, eventId: string, source: 'espn', count: number }

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
};

// ── Step 1: Find the current week's PGA Tour event ID ─────────────────────────
// ESPN's scoreboard endpoint returns active/upcoming PGA Tour events.
// We try a few date ranges to find whichever tournament is current or next.

async function getCurrentEventId() {
  // Try current week first, then next two weeks as fallback
  const dates = [getWeekRange(0), getWeekRange(1), getWeekRange(-1)];

  for (const { startDate, endDate } of dates) {
    try {
      const url = `https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard?league=pga&dates=${startDate}-${endDate}`;
      const resp = await fetch(url, { headers: HEADERS });
      if (!resp.ok) continue;
      const data = await resp.json();
      const events = data?.events || [];
      if (events.length > 0) {
        // Prefer events that are in progress or scheduled (not completed)
        const active = events.find(e => e.status?.type?.state !== 'post')
          || events[events.length - 1];
        return { id: active.id, name: active.name };
      }
    } catch (_) {
      continue;
    }
  }
  return null;
}

// Returns { startDate, endDate } as YYYYMMDD strings for a given week offset
function getWeekRange(weekOffset = 0) {
  const now = new Date();
  now.setDate(now.getDate() + weekOffset * 7);
  // Find the Monday of the current week
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
  // Sunday = Monday + 6
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return {
    startDate: toESPNDate(monday),
    endDate: toESPNDate(sunday),
  };
}

function toESPNDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

// ── Step 2: Fetch the field for a given event ID ──────────────────────────────

async function fetchField(eventId) {
  const resp = await fetch(
    `https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard?event=${eventId}&_=${Date.now()}`,
    { headers: HEADERS }
  );
  if (!resp.ok) throw new Error(`ESPN returned ${resp.status} for event ${eventId}`);
  const data = await resp.json();
  const event = data?.events?.[0];
  const competitors = event?.competitions?.[0]?.competitors || [];
  const players = competitors
    .map(p => (p.athlete?.displayName || '').trim())
    .filter(Boolean);
  return { players, name: event?.name || '' };
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  // Cache 30 min — field is stable once posted; stale-while-revalidate handles
  // late withdrawal updates without blocking the response.
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // Auto-discover the current event
    const event = await getCurrentEventId();
    if (!event) {
      return res.status(404).json({
        error: 'Could not find a current PGA Tour event on ESPN.',
      });
    }

    // Fetch the field for that event
    const { players, name } = await fetchField(event.id);

    if (!players.length) {
      return res.status(404).json({
        error: 'Field not yet available for this event.',
        tournament: name,
        eventId: event.id,
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
