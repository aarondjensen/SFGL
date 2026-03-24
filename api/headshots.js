// api/headshots.js — Vercel serverless function
// Returns ESPN athlete IDs for player names, sourced from ESPN golf leaderboards.
// Headshot URL: https://a.espncdn.com/i/headshots/golf/players/full/{espnId}.png
//
// GET /api/headshots?names=Rory+McIlroy,Scottie+Scheffler
// Returns: { results: { "Rory McIlroy": "4696529", ... }, notFound: ["..."] }

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json',
};

// Fetch all events in parallel — recent large-field events cover most tour regulars.
//
// ⚠️  UPDATE EACH SEASON: ESPN event IDs change every year.
// To find new IDs: visit https://www.espn.com/golf/leaderboard and inspect the
// network requests, or check https://site.api.espn.com/apis/site/v2/sports/golf/scoreboard
// Pick 4-5 recent large-field events (100+ players) to maximise coverage.
// Current IDs are valid for the 2026 PGA Tour season.
const ESPN_EVENT_IDS = [
  '401811938', // THE PLAYERS 2026
  '401811934', // Arnold Palmer 2026
  '401811932', // Genesis 2026
  '401811930', // AT&T Pebble Beach 2026
  '401811928', // Farmers Insurance 2026
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  // Cache for 24 h — ESPN athlete IDs don't change within a season
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=172800');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { names, eventId, debug } = req.query;

  try {
    const eventIds = eventId ? [eventId] : ESPN_EVENT_IDS;
    const playerMap = await buildPlayerMap(eventIds);

    if (debug === '1') {
      return res.status(200).json({
        totalPlayers: playerMap.size,
        eventsUsed: eventIds,
        sample: [...playerMap.entries()].slice(0, 10).map(([name, p]) => ({ name, espnId: p.espnId })),
      });
    }

    if (!names) {
      return res.status(400).json({ error: 'Provide ?names=Player+Name,Another+Player' });
    }

    const requestedNames = names.split(',').map(n => n.trim()).filter(Boolean);
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

async function buildPlayerMap(eventIds) {
  const map = new Map(); // normalizedName -> { espnId, name }

  // Fetch all events in parallel to avoid timeout
  const results = await Promise.allSettled(
    eventIds.map(eventId =>
      fetch(`https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard?event=${eventId}`, { headers: HEADERS })
        .then(r => r.ok ? r.json() : null)
        .catch(() => null)
    )
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status !== 'fulfilled' || !result.value) continue;

    const data = result.value;
    const competitors = data?.events?.[0]?.competitions?.[0]?.competitors || [];

    for (const c of competitors) {
      const name = c.athlete?.displayName;
      const espnId = c.athlete?.id;
      if (name && espnId && !map.has(normalize(name))) {
        map.set(normalize(name), { espnId, name });
      }
    }
    console.log(`[headshots] Event ${eventIds[i]}: ${competitors.length} players (total: ${map.size})`);
  }

  return map;
}

function normalize(name) {
  return name.toLowerCase()
    .replace(/[àáâãäå]/g, 'a').replace(/[èéêë]/g, 'e')
    .replace(/[ìíîï]/g, 'i').replace(/[òóôõöø]/g, 'o')  // ø -> o (Højgaard, Thorbjørn)
    .replace(/[ùúûü]/g, 'u').replace(/[ý]/g, 'y')
    .replace(/[ñ]/g, 'n').replace(/[ç]/g, 'c')
    .replace(/[æ]/g, 'ae')                                 // æ -> ae
    .replace(/[ß]/g, 'ss')                                 // ß -> ss
    .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function findInMap(map, name) {
  const norm = normalize(name);

  // Exact match
  if (map.has(norm)) return map.get(norm);

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
