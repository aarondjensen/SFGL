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

// Recent 2026 PGA Tour event ESPN IDs — Signature + full-field events for max coverage.
// Signature events have small fields (~75) of top players. Full-field events
// include lower-tier players who don't qualify for Signatures (e.g. Alex
// Fitzpatrick at Truist 2026). Mixing both ensures we index headshots for
// the widest possible roster.
//
// To update: find new IDs at https://www.espn.com/golf/leaderboard?tournamentId=XXXXXXX
// — open a recent tournament's leaderboard and the ID is in the URL.
const ESPN_EVENT_IDS = [
  '401811942', // RBC Heritage 2026 (Signature — 82 players)
  '401811940', // Masters 2026
  '401811938', // THE PLAYERS 2026 (Signature)
  '401811934', // Arnold Palmer Invitational 2026
  '401811932', // Genesis Invitational 2026
  '401811943', // Truist Championship 2026 (full-field, includes Alex Fitzpatrick et al)
  '401811935', // Cognizant Classic 2026 (full-field — opposite week from a Signature)
];

// ── Manual overrides ─────────────────────────────────────────────────────
// Verified ESPN athlete IDs for names that the event-index strict-matcher
// can't reliably resolve. Most often this is brothers/cousins/Jr-Sr pairs
// (Alex vs Matt Fitzpatrick, Tom vs Kevin Kim, etc) where ESPN's leaderboard
// dumps may only include one of them — leaving the other to fall back to
// an ambiguous or wrong match.
//
// Each entry takes precedence over event-index lookup. Keys MUST be in the
// same normalized form findInMap uses: lowercased, accent-stripped, single-
// spaced. Verify each ID against the ESPN profile URL:
//   https://www.espn.com/golf/player/_/id/{ID}/{name-slug}
const MANUAL_OVERRIDES = {
  'alex fitzpatrick': '4364865', // verified at .../id/4364865/alex-fitzpatrick
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  // Cache for 1 hour — short enough that manual override updates propagate
  // quickly; long enough that repeated client renders within an hour share
  // the same ESPN fetch. Was previously 6h but the long window made it
  // hard to roll out fixes for ambiguous-name bugs like Alex/Matt Fitzpatrick.
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=21600');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { names, eventId, debug } = req.query;

  try {
    const playerMap = await buildPlayerMap(eventId ? [eventId] : ESPN_EVENT_IDS);

    if (debug === '1') {
      return res.status(200).json({
        totalPlayers: playerMap.size,
        sample: [...playerMap.entries()].slice(0, 10).map(([name, p]) => ({ name, espnId: p.espnId })),
        manualOverrides: Object.keys(MANUAL_OVERRIDES),
      });
    }

    if (!names) {
      return res.status(400).json({ error: 'Provide ?names=Player+Name,Another+Player' });
    }

    const requestedNames = names.split(',').map(n => decodeURIComponent(n.trim())).filter(Boolean);
    const results = {};
    const notFound = [];

    for (const name of requestedNames) {
      // 1. Manual overrides take precedence — these are verified IDs that
      //    bypass the strict-matcher entirely to avoid brother-collisions.
      const normalized = normalize(name);
      if (MANUAL_OVERRIDES[normalized]) {
        results[name] = MANUAL_OVERRIDES[normalized];
        continue;
      }
      // 2. Otherwise fall through to the event-index strict-matcher.
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
// Strategy:
//   1. Exact normalized match (best)
//   2. Last-name match AND first-initial must agree (prevents brother/relative
//      collisions like Alex vs Matt Fitzpatrick, Tom vs Kevin Kim, etc)
//   3. If multiple last-name matches, narrow by first-initial
//
// Critical: when only one last-name match exists, we still REQUIRE the first
// initial to match. Otherwise we incorrectly returned the wrong relative's
// ID whenever the actual player wasn't in our indexed events (e.g. Alex
// Fitzpatrick at a lower-tier tournament our ESPN_EVENT_IDS don't include).
// Returning null lets the client fall back to an initials-avatar — which is
// preferable to displaying the wrong player's face.
function findInMap(map, name) {
  const norm = normalize(name);

  // 1. Exact match
  if (map.has(norm)) return map.get(norm);

  // 2. Last-name + first-initial match (strict)
  const parts = norm.split(' ');
  const lastName = parts[parts.length - 1];
  const firstInitial = parts[0]?.[0];
  if (!lastName || !firstInitial) return null;

  const lastNameMatches = [...map.entries()].filter(([key]) => {
    const keyParts = key.split(' ');
    return keyParts[keyParts.length - 1] === lastName;
  });

  // Filter to entries whose first initial agrees with the request.
  const initialMatches = lastNameMatches.filter(([key]) => key.startsWith(firstInitial));

  // Exactly one match with correct initial → safe to return.
  if (initialMatches.length === 1) return initialMatches[0][1];

  // Multiple matches with same first initial (e.g. multiple "S. Kim"s): too
  // ambiguous to disambiguate further without more name parts; return null.
  // Caller falls back to the initials avatar so we never show wrong faces.
  return null;
}
