// api/headshots.js — Vercel serverless function
// Looks up PGA Tour player IDs (for Cloudinary headshots) by player name.
// Uses ESPN's leaderboard API to get player names + their pgatour.com links,
// which contain the numeric PGA Tour player ID.
//
// GET /api/headshots?names=Rory+McIlroy,Scottie+Scheffler
// Returns: { results: { "Rory McIlroy": "28237", ... }, notFound: ["..."] }

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json',
};

// Recent PGA Tour event ESPN IDs — large fields = more players indexed
const ESPN_EVENT_IDS = [
  '401811938', // THE PLAYERS 2026
  '401811934', // Arnold Palmer 2026
  '401811932', // Genesis 2026
  '401811930', // AT&T Pebble Beach 2026
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { names, eventId, debug } = req.query;

  try {
    const playerMap = await buildPlayerMap(eventId ? [eventId] : ESPN_EVENT_IDS);

    if (debug === '1') {
      return res.status(200).json({
        totalPlayers: playerMap.size,
        sample: [...playerMap.entries()].slice(0, 8).map(([name, p]) => ({ name, pgaTourId: p.pgaTourId, espnId: p.espnId })),
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
      if (player?.pgaTourId) {
        results[name] = player.pgaTourId;
      } else {
        notFound.push(name);
      }
    }

    return res.status(200).json({ results, notFound, totalIndexed: playerMap.size });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function buildPlayerMap(eventIds) {
  const map = new Map(); // normalizedName -> { pgaTourId, espnId, name }

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
        const espnId = c.athlete?.id;
        if (!name || !espnId) continue;

        // ESPN includes a links array — one of them points to pgatour.com
        // Shape: [{ href: "https://www.pgatour.com/player/28237/rory-mcilroy", ... }]
        let pgaTourId = null;
        const links = c.athlete?.links || [];
        for (const link of links) {
          const m = link.href?.match(/pgatour\.com\/player\/(\d+)/);
          if (m) { pgaTourId = m[1]; break; }
        }

        // Fallback: try the athlete's uid which sometimes is "s:60~a:28237" format
        if (!pgaTourId && c.athlete?.uid) {
          const m = c.athlete.uid.match(/a:(\d+)/);
          if (m) pgaTourId = m[1];
        }

        if (pgaTourId) {
          map.set(normalize(name), { pgaTourId, espnId, name });
        }
      }

      console.log(`[headshots] Event ${eventId}: ${competitors.length} players, ${map.size} with PGA Tour IDs`);
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
  if (map.has(norm)) return map.get(norm);

  const parts = norm.split(' ');
  const lastName = parts[parts.length - 1];
  const firstInitial = parts[0]?.[0];

  const lastNameMatches = [...map.entries()].filter(([key]) => {
    const keyParts = key.split(' ');
    return keyParts[keyParts.length - 1] === lastName;
  });

  if (lastNameMatches.length === 1) return lastNameMatches[0][1];

  if (lastNameMatches.length > 1 && firstInitial) {
    const match = lastNameMatches.find(([key]) => key.startsWith(firstInitial));
    if (match) return match[1];
  }

  return null;
}
