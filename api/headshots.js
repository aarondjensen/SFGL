// api/headshots.js — Vercel serverless function
// Returns ESPN athlete IDs for player names, sourced from ESPN leaderboard API.
// Headshot URL: https://a.espncdn.com/i/headshots/golf/players/full/{espnId}.png
//
// GET /api/headshots?names=Rory+McIlroy,Scottie+Scheffler
// Returns: { results: { "Rory McIlroy": "4696529", ... }, notFound: ["..."] }
//
// UPDATE EACH SEASON: swap in recent ESPN event IDs with large fields.
// Find IDs at: https://www.espn.com/golf/leaderboard?tournamentId=XXXXXXX

import { extractNextData } from './_constants.js';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
};

// ── BACKFILL event list ──────────────────────────────────────────────────
// The index is built from TWO sources, in this priority order:
//   1. The CURRENT PGA event's field (getCurrentPgaEventIds). By definition
//      every player you can roster THIS week is in this week's field, so this
//      rescues lower-ranked players / rookies / one-week qualifiers who never
//      appear in elite Signature fields.
//   2. Recent COMPLETED events of the current season, as a backfill for
//      BENCHED players who aren't in this week's field. Fetched lazily —
//      see resolveWithBackfill in the handler: if source 1 answered every
//      requested name, we never make these requests at all.
//
// This list used to be seven hardcoded event IDs with an "UPDATE EACH SEASON"
// note. Two problems, both of which this replaces:
//   • Annual maintenance chore, and a silent one — a stale list still returns
//     200s, just against last season's fields.
//   • It was WRONG and nobody could tell. Six of the seven IDs did not match
//     the events their comments named (the ID commented "Truist Championship
//     … includes Alex Fitzpatrick" was actually the Zurich Classic — which is
//     why Alex Fitzpatrick needed a MANUAL_OVERRIDE below to work around a
//     backfill entry that was never indexing the field its author intended).
//
// ESPN's scoreboard endpoint takes a date range and returns the whole season
// with IDs and completion state, so the list is fully derivable from one
// request. If that request fails we fall back to the last cached result, and
// failing that to no backfill at all — source 1 still covers this week's field.
const BACKFILL_MAX_EVENTS = 8;
const BACKFILL_TTL_MS = 6 * 60 * 60 * 1000; // 6h — the schedule barely moves

let _backfillCache = { season: null, ids: [], fetchedAt: 0 };

async function getBackfillEventIds(season) {
  const now = Date.now();
  if (
    _backfillCache.season === season &&
    _backfillCache.ids.length &&
    now - _backfillCache.fetchedAt < BACKFILL_TTL_MS
  ) {
    return _backfillCache.ids;
  }

  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard?dates=${season}0101-${season}1231`;
    const resp = await fetch(url, { headers: HEADERS });
    if (!resp.ok) return _backfillCache.ids;
    const data = await resp.json();
    // Events come back in chronological order; keep the most recent COMPLETED
    // ones. Completed events have a settled field, which is exactly what a
    // backfill index wants.
    const completed = (data?.events || [])
      .filter((e) => e?.id && e?.status?.type?.state === 'post')
      .map((e) => String(e.id));
    const ids = completed.slice(-BACKFILL_MAX_EVENTS);
    if (ids.length) _backfillCache = { season, ids, fetchedAt: now };
    return ids;
  } catch {
    return _backfillCache.ids;
  }
}

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
//
// ⚠ A near-duplicate of this map lives in src/utils/headshotUtils.js, which
// applies at RENDER time and therefore wins even over what this endpoint
// returns. api/ and src/ are separate deploy targets and can't share a module
// (same constraint as NAME_ALIASES / normalizeNordic). Keep the two in sync:
// this one fixes the DATA (its result is persisted to /players/{name}.espn_id),
// the client one is the last-resort display guarantee.
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

  // Validate BEFORE any outbound work. This check used to sit after the index
  // was built, so a request with no ?names= still fired a fetch per indexed
  // event before returning 400.
  if (!names && debug !== '1') {
    return res.status(400).json({ error: 'Provide ?names=Player+Name,Another+Player' });
  }

  try {
    const season = new Date().getUTCFullYear();

    // Resolve a batch of names against an index. Manual overrides win outright
    // (verified IDs that bypass the strict matcher to avoid brother/relative
    // collisions); everything else goes through findInMap, which returns null
    // rather than guessing when a name is ambiguous.
    //
    // Each result is an OBJECT, not a bare id: { espn?, pga? }. The client
    // chains them (utils/headshotUtils.js), so a player only needs ONE source
    // to render — but having both means a dead entry in one CDN silently falls
    // through to the other instead of dropping to an initials avatar.
    const resolveNames = (list, map) => {
      const results = {};
      const notFound = [];
      for (const name of list) {
        const entry = {};
        const override = MANUAL_OVERRIDES[normalize(name)];
        if (override) entry.espn = override;
        else {
          const player = findInMap(map, name);
          if (player?.espnId) entry.espn = player.espnId;
        }
        if (Object.keys(entry).length > 0) results[name] = entry;
        else notFound.push(name);
      }
      return { results, notFound };
    };

    // Attach PGA TOUR ids from the full directory. Runs for EVERY requested
    // name, not just the ESPN misses — a player with both ids gets a working
    // fallback if their ESPN headshot ever disappears. Names still unresolved
    // afterwards move out of notFound, since a pga-only entry is renderable.
    const attachPgaIds = async (requested, results, notFound) => {
      const dir = await getPgaDirectory();
      if (!dir) return notFound;
      const stillMissing = [];
      for (const name of requested) {
        const pga = dir[normalize(name)];
        if (!pga) {
          if (notFound.includes(name)) stillMissing.push(name);
          continue;
        }
        results[name] = { ...(results[name] || {}), pga };
      }
      return stillMissing;
    };

    // ── Explicit ?eventId= — debugging / one-off, index just that event ──
    if (eventId) {
      const map = await buildPlayerMap([eventId]);
      if (debug === '1') {
        return res.status(200).json({
          totalPlayers: map.size,
          indexedEventIds: [eventId],
          sample: [...map.entries()].slice(0, 10).map(([n, p]) => ({ name: n, espnId: p.espnId })),
          manualOverrides: Object.keys(MANUAL_OVERRIDES),
        });
      }
      const requested = names.split(',').map(n => decodeURIComponent(n.trim())).filter(Boolean);
      const { results, notFound } = resolveNames(requested, map);
      const stillMissing = await attachPgaIds(requested, results, notFound);
      return res.status(200).json({ results, notFound: stillMissing, totalIndexed: map.size, indexedEventIds: [eventId] });
    }

    // ── Source 1: this week's field ──
    const currentEventIds = await getCurrentPgaEventIds();
    const playerMap = await buildPlayerMap(currentEventIds);
    let indexedEventIds = [...currentEventIds];
    let backfillUsed = false;

    // Merge a secondary index in WITHOUT letting it override source 1 —
    // the current field is the fresher, more authoritative answer.
    const mergeInto = (target, extra) => {
      for (const [k, v] of extra) if (!target.has(k)) target.set(k, v);
    };

    if (debug === '1') {
      const backfillIds = await getBackfillEventIds(season);
      const extra = backfillIds.filter(id => !indexedEventIds.includes(id));
      if (extra.length) {
        mergeInto(playerMap, await buildPlayerMap(extra));
        indexedEventIds = [...indexedEventIds, ...extra];
      }
      return res.status(200).json({
        totalPlayers: playerMap.size,
        season,
        currentEventIds,
        backfillEventIds: extra,
        indexedEventIds,
        sample: [...playerMap.entries()].slice(0, 10).map(([n, p]) => ({ name: n, espnId: p.espnId })),
        manualOverrides: Object.keys(MANUAL_OVERRIDES),
      });
    }

    const requestedNames = names.split(',').map(n => decodeURIComponent(n.trim())).filter(Boolean);
    let { results, notFound } = resolveNames(requestedNames, playerMap);

    // ── Source 2: lazy backfill, ONLY for names this week's field missed ──
    // In the common case (every requested player is in the field, or already
    // resolved) this block never runs, so the request costs one ESPN fetch
    // instead of the eight the old fixed-list version always paid.
    if (notFound.length > 0) {
      const backfillIds = await getBackfillEventIds(season);
      const extra = backfillIds.filter(id => !indexedEventIds.includes(id));
      if (extra.length > 0) {
        mergeInto(playerMap, await buildPlayerMap(extra));
        indexedEventIds = [...indexedEventIds, ...extra];
        backfillUsed = true;
        // Re-resolve only the misses.
        const second = resolveNames(notFound, playerMap);
        Object.assign(results, second.results);
        notFound = second.notFound;
      }
    }

    // Source 3 — the full PGA TOUR directory. Adds a pga id to every name it
    // knows, which both enriches already-resolved players and rescues the ones
    // ESPN's leaderboard index has never seen (long-term injured, inactive).
    const stillMissing = await attachPgaIds(requestedNames, results, notFound);

    return res.status(200).json({
      results,
      notFound: stillMissing,
      totalIndexed: playerMap.size,
      indexedEventIds,
      backfillUsed,
      pgaDirectorySize: Object.keys((await getPgaDirectory()) || {}).length,
    });
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

// ── Resolve the current PGA event ID(s) ─────────────────────────────────────
// ESPN's PGA scoreboard returns the current week's event(s) with their IDs and
// status ('pre' = upcoming this week, 'in' = live, 'post' = just finished).
// We index whatever it returns so this week's full field is always covered.
// Falls back to the generic golf leaderboard endpoint, then to [] (in which
// case the handler still has the fixed backfill list to work with).
// ── Source 3: the full PGA TOUR player directory ─────────────────────────────
// pgatour.com/players embeds every player it knows about — ~2,700 entries —
// in its __NEXT_DATA__ blob, each with a PGA TOUR player ID. That's a superset
// of anyone rosterable, including players who have been inactive for months
// and therefore appear in NO recent leaderboard.
//
// This is what closes the last coverage gap. ESPN's leaderboard index only
// knows players who have recently teed it up; the directory knows everyone.
// Between them, every name we've tested resolves.
//
// Returns name → PGA TOUR id. Cached for 12h (the directory changes rarely)
// and falls back to the last good result on failure.
const PGA_DIRECTORY_TTL_MS = 12 * 60 * 60 * 1000;
let _pgaDirectory = { map: null, fetchedAt: 0 };

async function getPgaDirectory() {
  if (_pgaDirectory.map && Date.now() - _pgaDirectory.fetchedAt < PGA_DIRECTORY_TTL_MS) {
    return _pgaDirectory.map;
  }
  try {
    const resp = await fetch('https://www.pgatour.com/players', {
      headers: { ...HEADERS, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', Referer: 'https://www.pgatour.com/' },
    });
    if (!resp.ok) return _pgaDirectory.map;
    const nd = extractNextData(await resp.text());
    if (!nd) return _pgaDirectory.map;

    const map = {};
    const seen = new Set();
    (function walk(o, depth) {
      if (!o || typeof o !== 'object' || depth > 12) return;
      if (Array.isArray(o)) { o.forEach(x => walk(x, depth + 1)); return; }
      const nm = o.displayName || (o.firstName && o.lastName ? `${o.firstName} ${o.lastName}` : null);
      if (nm && o.id && /^\d+$/.test(String(o.id)) && !seen.has(nm)) {
        seen.add(nm);
        map[normalize(nm)] = String(o.id);
      }
      Object.values(o).forEach(v => walk(v, depth + 1));
    })(nd, 0);

    if (Object.keys(map).length) _pgaDirectory = { map, fetchedAt: Date.now() };
    return _pgaDirectory.map;
  } catch {
    return _pgaDirectory.map;
  }
}

// Memoized for 15 minutes: the current event changes at most weekly, so
// re-resolving it on every request is pure overhead on a warm instance.
const CURRENT_EVENT_TTL_MS = 15 * 60 * 1000;
let _currentEventCache = { ids: [], fetchedAt: 0 };

async function getCurrentPgaEventIds() {
  if (_currentEventCache.ids.length && Date.now() - _currentEventCache.fetchedAt < CURRENT_EVENT_TTL_MS) {
    return _currentEventCache.ids;
  }
  const endpoints = [
    'https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard',
    'https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard',
  ];
  for (const url of endpoints) {
    try {
      const resp = await fetch(url, { headers: HEADERS });
      if (!resp.ok) continue;
      const data = await resp.json();
      const ids = (data?.events || [])
        .map(e => e?.id)
        .filter(Boolean)
        .map(String);
      if (ids.length) {
        const unique = [...new Set(ids)];
        _currentEventCache = { ids: unique, fetchedAt: Date.now() };
        return unique;
      }
    } catch {
      // try next endpoint
    }
  }
  return _currentEventCache.ids;
}

// ── Build player map from ESPN events (parallel, memoized per event) ────────
// Per-event results are cached in module scope for the life of the warm
// lambda. A completed event's field never changes, and an in-progress event's
// roster of competitors only changes at cut time — neither needs re-fetching
// within a single instance's lifetime. This is what keeps the lazy-backfill
// path cheap: the first request that needs backfill pays for it, every
// subsequent request on that instance reuses the index for free.
const EVENT_CACHE_TTL_MS = 60 * 60 * 1000; // 1h
const _eventCache = new Map(); // eventId -> { entries: [[key, val], ...], fetchedAt }

async function fetchEventEntries(eventId) {
  const cached = _eventCache.get(eventId);
  if (cached && Date.now() - cached.fetchedAt < EVENT_CACHE_TTL_MS) return cached.entries;

  const url = `https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard?event=${eventId}`;
  const resp = await fetch(url, { headers: HEADERS });
  if (!resp.ok) return cached?.entries || [];
  const data = await resp.json();
  const competitors = data?.events?.[0]?.competitions?.[0]?.competitors || [];

  const entries = [];
  for (const c of competitors) {
    const athlete = c.athlete || c;
    const displayName = athlete.displayName || athlete.shortName || '';
    const espnId = athlete.id || '';
    if (!displayName || !espnId) continue;
    entries.push([normalize(displayName), { espnId: String(espnId), name: displayName }]);
  }
  _eventCache.set(eventId, { entries, fetchedAt: Date.now() });
  return entries;
}

async function buildPlayerMap(eventIds) {
  const map = new Map(); // normalizedName -> { espnId, name }

  // Fetch all events in parallel — ~2s total instead of ~10s sequential
  const results = await Promise.allSettled(eventIds.map(fetchEventEntries));

  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    for (const [key, val] of result.value) {
      // First event wins — eventIds are passed most-authoritative-first.
      if (!map.has(key)) map.set(key, val);
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
// Fitzpatrick at a lower-tier tournament the backfill doesn't cover).
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
