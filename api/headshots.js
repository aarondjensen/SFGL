// api/headshots.js — Vercel serverless function
// Returns ESPN athlete IDs for player names, sourced from ESPN leaderboard API.
// Headshot URL: https://a.espncdn.com/i/headshots/golf/players/full/{espnId}.png
//
// GET /api/headshots?names=Rory+McIlroy,Scottie+Scheffler
// Returns: { results: { "Rory McIlroy": "4696529", ... }, notFound: ["..."] }
//
// UPDATE EACH SEASON: swap in recent ESPN event IDs with large fields.
// Find IDs at: https://www.espn.com/golf/leaderboard?tournamentId=XXXXXXX

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json',
};

// Recent 2026 PGA Tour event ESPN IDs — Signature/Major fields for maximum coverage
const ESPN_EVENT_IDS = [
  '401811942', // RBC Heritage 2026 (Signature — 82 players)
  '401811940', // Masters 2026
  '401811938', // THE PLAYERS 2026 (Signature — large field)
  '401811934', // Arnold Palmer Invitational 2026
  '401811932', // Genesis Invitational 2026
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  // Cache for 6 hours — ESPN IDs don't change
  res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=43200');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { names, eventId, debug } = req.query;

  try {
    const playerMap = await buildPlayerMap(eventId ? [eventId] : ESPN_EVENT_IDS);

    if (debug === '1') {
      return res.status(200).json({
        totalPlayers: playerMap.size,
        sample: [...playerMap.entries()].slice(0, 10).map(([name, p]) => ({ name, espnId: p.espnId })),
      });
    }

    if (!names) {
      return res.status(400).json({ error: 'Provide ?names=Player+Name,Another+Player' });
    }

    const requestedNames = names.split(',').map(n => decodeURIComponent(n.trim())).filter(Boolean);
    const results = {};
    const notFound = [];

    for (const name of requestedNames) {
      const player = findInMap(playerMap, name);
      if (player?.espnId) results[name] = player.espnId;
      else notFound.push(name);
    }

    return res.status(200).json({ results, notFound, totalIndexed: playerMap.size });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── Nordic / diacritics normalization ────────────────────────────────────────
function normalize(name) {
  return (name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[øØ]/g, 'o')
    .replace(/[æÆ]/g, 'ae')
    .replace(/[ß]/g, 'ss')
    .replace(/[^a-z0-9\s]/gi, '')
    .toLowerCase()
    .trim();
}

// ── Build player map from ESPN events (parallel) ────────────────────────────
async function buildPlayerMap(eventIds) {
  const map = new Map(); // normalizedName -> { espnId, name }

  // Fetch all events in parallel — ~2s total instead of ~10s sequential
  const results = await Promise.allSettled(
    eventIds.map(async (eventId) => {
      const url = `https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard?event=${eventId}`;
      const resp = await fetch(url, { headers: HEADERS });
      if (!resp.ok) return [];
      const data = await resp.json();
      return data?.events?.[0]?.competitions?.[0]?.competitors || [];
    })
  );

  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const competitors = result.value;

    for (const c of competitors) {
      const athlete = c.athlete || c;
      const displayName = athlete.displayName || athlete.shortName || '';
      const espnId = athlete.id || '';
      if (!displayName || !espnId) continue;

      const key = normalize(displayName);
      if (!map.has(key)) {
        map.set(key, { espnId: String(espnId), name: displayName });
      }
    }
  }

  return map;
}

// ── Fuzzy name lookup ────────────────────────────────────────────────────────
function findInMap(map, name) {
  const norm = normalize(name);

  // Exact match
  if (map.has(norm)) return map.get(norm);

  // Last name only
  const parts = norm.split(' ');
  const lastName = parts[parts.length - 1];
  const firstInitial = parts[0]?.[0];

  // Find all entries with same last name
  const lastNameMatches = [...map.entries()].filter(([key]) => {
    const keyParts = key.split(' ');
    return keyParts[keyParts.length - 1] === lastName;
  });

  if (lastNameMatches.length === 1) return lastNameMatches[0][1];

  // Narrow by first initial
  if (lastNameMatches.length > 1 && firstInitial) {
    const match = lastNameMatches.find(([key]) => key.startsWith(firstInitial));
    if (match) return match[1];
  }

  return null;
}
