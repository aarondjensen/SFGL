// api/espn-results.js — Vercel serverless function
// Fetches completed tournament earnings + round leaders from ESPN's leaderboard API.
//
// Runs server-side so no CORS proxy is needed.
//
// Resolution order for event ID:
//   1. ?eventId=<ESPN event ID>  (explicit override)
//   2. Auto-discover by name via the ESPN scoreboard API
//      — checks current scoreboard, full year calendar, then walks back 12 weeks
//
// Returns:
//   { players: [{name, earnings}], roundLeaders: {round1, round2, round3}, eventName, espnEventId }

const SCOREBOARD  = 'https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard';
const LEADERBOARD = 'https://site.web.api.espn.com/apis/v2/sports/golf/pga/leaderboard';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { eventId: explicitId, name } = req.query;

  if (!explicitId && !name) {
    return res.status(400).json({ error: 'Provide ?name= (tournament name) or ?eventId= (ESPN event ID)' });
  }

  try {
    // ── Resolve event ID ────────────────────────────────────────────────────
    let espnEventId = explicitId || null;
    let eventName   = '';

    if (!espnEventId) {
      const found = await findEventId(name);
      if (!found) {
        return res.status(404).json({
          error: `Could not find "${name}" on ESPN. Try providing ?eventId= directly.`,
        });
      }
      espnEventId = found.id;
      eventName   = found.name;
    }

    // ── Fetch leaderboard ───────────────────────────────────────────────────
    const competitors = await fetchLeaderboard(espnEventId);

    if (!eventName) {
      eventName = competitors[0]?.eventName || '';
    }

    if (competitors.length === 0) {
      return res.status(404).json({
        error: 'ESPN found the event but returned no player data. The event may not be complete yet.',
        espnEventId,
      });
    }

    // ── Extract earnings ────────────────────────────────────────────────────
    const players = [];
    let playersWithEarnings = 0;

    competitors.forEach(c => {
      const name = c.athlete?.displayName || c.displayName || '';
      if (!name) return;

      const dnf = didNotFinish(c);
      const earnings = dnf ? 0 : extractEarnings(c);
      if (earnings > 0) playersWithEarnings++;
      players.push({ name, earnings });
    });

    if (playersWithEarnings === 0 && competitors.length > 0) {
      return res.status(202).json({
        error: 'ESPN has player data but no earnings yet. Try again after the tournament concludes.',
        espnEventId,
        eventName,
      });
    }

    // Sort descending by earnings
    players.sort((a, b) => b.earnings - a.earnings);

    // ── Compute round leaders from linescores ───────────────────────────────
    const roundLeaders = {
      round1: leadersAfterRound(competitors, 1),
      round2: leadersAfterRound(competitors, 2),
      round3: leadersAfterRound(competitors, 3),
    };

    return res.status(200).json({
      players,
      roundLeaders,
      playerCount:    players.length,
      madeCutCount:   playersWithEarnings,
      missedCutCount: players.length - playersWithEarnings,
      eventName,
      espnEventId,
    });

  } catch (err) {
    console.error('[espn-results]', err);
    return res.status(500).json({ error: err.message });
  }
}

// ── Event ID discovery ────────────────────────────────────────────────────────

function normTournName(s) {
  return (s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\b(the|championship|open|invitational|classic|tournament|pro|am|presented|by|at|of|golf)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchEvent(events, target) {
  const t = normTournName(target);
  return (
    events.find(e => normTournName(e.name) === t) ||
    events.find(e => {
      const en = normTournName(e.name);
      return en.includes(t) || t.includes(en);
    }) ||
    null
  );
}

async function findEventId(name) {
  // 1. Current scoreboard
  try {
    const r = await fetch(SCOREBOARD, { headers: HEADERS });
    if (r.ok) {
      const d = await r.json();
      const m = matchEvent(d.events || [], name);
      if (m) return { id: m.id, name: m.name };
    }
  } catch (_) {}

  // 2. Full year calendar
  try {
    const year = new Date().getFullYear();
    const r = await fetch(`${SCOREBOARD}?dates=${year}`, { headers: HEADERS });
    if (r.ok) {
      const d = await r.json();
      const m = matchEvent(d.events || [], name);
      if (m) return { id: m.id, name: m.name };
    }
  } catch (_) {}

  // 3. Walk back week by week (up to 12 weeks)
  const now = new Date();
  for (let w = 1; w <= 12; w++) {
    try {
      const d = new Date(now);
      d.setDate(d.getDate() - w * 7);
      const dateStr = d.toISOString().slice(0, 10).replace(/-/g, '');
      const r = await fetch(`${SCOREBOARD}?dates=${dateStr}`, { headers: HEADERS });
      if (!r.ok) continue;
      const data = await r.json();
      const m = matchEvent(data.events || [], name);
      if (m) return { id: m.id, name: m.name };
    } catch (_) { continue; }
  }

  return null;
}

// ── Leaderboard fetch ─────────────────────────────────────────────────────────

async function fetchLeaderboard(espnEventId) {
  const url = `${LEADERBOARD}?event=${espnEventId}&_=${Date.now()}`;
  const resp = await fetch(url, { headers: HEADERS });
  if (!resp.ok) throw new Error(`ESPN leaderboard fetch failed: ${resp.status}`);
  const data = await resp.json();

  return (
    data.events?.[0]?.competitions?.[0]?.competitors ||
    data.competitions?.[0]?.competitors ||
    data.competitors ||
    []
  );
}

// ── Earnings extraction ───────────────────────────────────────────────────────

function extractEarnings(competitor) {
  // 1. Top-level .earnings field
  if (competitor.earnings !== undefined && competitor.earnings !== null) {
    const n = parseInt(competitor.earnings, 10);
    if (!isNaN(n) && n > 0) return n;
  }

  // 2. statistics array — look for earn-labelled stat or large dollar value
  if (Array.isArray(competitor.statistics)) {
    const earnStat = competitor.statistics.find(s =>
      (s.name || '').toLowerCase().includes('earn') ||
      (s.abbreviation || '').toLowerCase().includes('earn')
    );
    if (earnStat) {
      const n = parseInt((earnStat.displayValue || '').replace(/[^0-9]/g, ''), 10);
      if (!isNaN(n) && n > 0) return n;
    }
    // Scan every stat for a value >= $10,000 (prize money floor)
    for (const stat of competitor.statistics) {
      const raw = (stat.displayValue || '').replace(/[$,]/g, '');
      const n   = parseInt(raw, 10);
      if (!isNaN(n) && n >= 10000) return n;
    }
  }

  return 0;
}

function didNotFinish(competitor) {
  const s = (
    competitor.status?.type?.name ||
    competitor.status?.type?.description ||
    competitor.status?.displayValue ||
    ''
  ).toLowerCase();
  return s.includes('cut') || s.includes('wd') || s.includes('withdraw') ||
         s.includes('dq')  || s.includes('disqualif');
}

// ── Round leader calculation from linescores ──────────────────────────────────
// roundNumber is 1-based (1 = after R1, 2 = after R2, 3 = after R3)
// Uses cumulative score-to-par through the given round number.

function leadersAfterRound(competitors, roundNumber) {
  const scored = competitors.map(c => {
    const linescores = c.linescores || [];
    // Need at least `roundNumber` linescore entries
    if (linescores.length < roundNumber) return null;

    let cumulative = 0;
    for (let i = 0; i < roundNumber; i++) {
      const ls = linescores[i];
      // value field is score-to-par for that round (integer or displayValue "E"/"+n"/"-n")
      const val = ls.value ?? ls.score ?? ls.displayValue;
      if (val === undefined || val === null || val === '--' || val === '') return null;
      const dv = String(val);
      if (dv === 'E' || dv === '0') { /* cumulative += 0 */ }
      else {
        const n = parseInt(dv, 10);
        if (isNaN(n)) return null;
        cumulative += n;
      }
    }

    const name = c.athlete?.displayName || c.displayName || '';
    if (!name) return null;
    return { name, score: cumulative };
  }).filter(Boolean);

  if (scored.length === 0) return [];

  const best = Math.min(...scored.map(s => s.score));
  return scored.filter(s => s.score === best).map(s => s.name);
}
