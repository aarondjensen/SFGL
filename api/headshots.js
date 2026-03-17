// api/headshots.js — Vercel serverless function
// Looks up ESPN player IDs for headshots by scraping ESPN golf leaderboards.
// ESPN headshot URL: https://a.espncdn.com/i/headshots/golf/players/full/{espnId}.png
//
// GET /api/headshots?names=Rory+McIlroy,Scottie+Scheffler
// Returns: { results: { "Rory McIlroy": "4696529", ... }, notFound: ["..."] }

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json',
  'Origin': 'https://www.espn.com',
  'Referer': 'https://www.espn.com/',
};

// ESPN event IDs to try — recent/current PGA Tour events give the biggest fields
// These are stable IDs for major events that always have full fields
const ESPN_EVENT_IDS = [
  '401811938', // THE PLAYERS 2026 (current)
  '401580360', // Masters 2025
  '401580362', // US Open 2025
  '401580364', // The Open 2025
  '401580366', // PGA Championship 2025
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { names, eventId, debug } = req.query;

  try {
    // Build player map from ESPN leaderboard(s)
    const playerMap = await buildPlayerMap(eventId ? [eventId] : ESPN_EVENT_IDS, debug === '1');

    if (debug === '1') {
      return res.status(200).json({
        totalPlayers: playerMap.size,
        sample: [...playerMap.entries()].slice(0, 10).map(([name, id]) => ({ name, espnId: id })),
      });
    }

    if (!names) {
      return res.status(400).json({ error: 'Provide ?names=Player+Name,Another+Player' });
    }

    const requestedNames = names.split(',').map(n => n.trim()).filter(Boolean);
    const results = {};
    const notFound = [];

    for (const name of requestedNames) {
      const id = findInMap(playerMap, name);
      if (id) results[name] = id;
      else notFound.push(name);
    }

    return res.status(200).json({ results, notFound, totalIndexed: playerMap.size });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function buildPlayerMap(eventIds, debug = false) {
  const map = new Map(); // normalizedName -> espnId

  for (const eventId of eventIds) {
    try {
      const url = `https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard?event=${eventId}`;
      const resp = await fetch(url, { headers: HEADERS });
      if (!resp.ok) continue;

      const data = await resp.json();
      const competitors = data?.events?.[0]?.competitions?.[0]?.competitors || [];
      if (!competitors.length) continue;

      for (const c of competitors) {
        const name = c.athlete?.displayName;
        const id = c.athlete?.id;
        if (name && id) {
          map.set(normalize(name), { id, name });
        }
      }

      console.log(`[headshots] Event ${eventId}: ${competitors.length} players indexed`);
    } catch (err) {
      console.warn(`[headshots] Event ${eventId} failed:`, err.message);
    }
  }

  return map;
}

function normalize(name) {
  return name.toLowerCase()
    .replace(/[àáâãäå]/g, 'a').replace(/[èéêë]/g, 'e')
    .replace(/[ìíîï]/g, 'i').replace(/[òóôõö]/g, 'o')
    .replace(/[ùúûü]/g, 'u').replace(/[ñ]/g, 'n').replace(/[ç]/g, 'c')
    .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function findInMap(map, name) {
  const norm = normalize(name);

  // Exact match
  if (map.has(norm)) return map.get(norm).id;

  // Try last name only match if unique
  const parts = norm.split(' ');
  const lastName = parts[parts.length - 1];
  const firstInitial = parts[0]?.[0];

  // Find all entries matching last name
  const lastNameMatches = [...map.entries()].filter(([key]) => {
    const keyParts = key.split(' ');
    return keyParts[keyParts.length - 1] === lastName;
  });

  if (lastNameMatches.length === 1) return lastNameMatches[0][1].id;

  // Multiple last name matches — narrow by first initial
  if (lastNameMatches.length > 1 && firstInitial) {
    const initialMatch = lastNameMatches.find(([key]) => key.startsWith(firstInitial));
    if (initialMatch) return initialMatch[1].id;
  }

  return null;
}
