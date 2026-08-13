// api/field.js — Vercel serverless function
// Single hub for all PGA Tour tournament data this week.
// Fetches field page → extracts players, player IDs, tee times, and odds in one pass.
//
// GET /api/field          → { players, pgaIds, espnIds, photos, teeTimes, odds, tournament, count, source }
// GET /api/field?debug=1  → diagnostic info

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

import { extractNextData, nameToSlug } from './_constants.js';
import { NameMap, NameSet, resolveAlias } from './_playerNames.js';

function walkAll(obj, fn) {
  if (!obj || typeof obj !== 'object') return;
  fn(obj);
  (Array.isArray(obj) ? obj : Object.values(obj)).forEach(v => walkAll(v, fn));
}

function formatTeeTime(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: true,
      timeZone: 'America/New_York',
    });
  } catch { return null; }
}

// Pick the right tee time per player when the PGA Tour field page contains
// data for multiple rounds (R1, R2, R3, R4) inside the same __NEXT_DATA__.
//
// Before this helper existed the parser used naive last-write-wins on
// teeTimeMap[name] = ..., which meant whichever round happened to be
// traversed last in __NEXT_DATA__ won — typically R2 — so during R1 the
// roster page showed afternoon-wave players with their *Friday* (R2)
// tee times instead of their Thursday afternoon ones.
//
// Rule used here:
//   • Prefer the earliest upcoming tee time (≥ now). This gives the
//     correct "next tee" for any player who hasn't started their next
//     round yet, regardless of which round we're in.
//   • If no upcoming time exists (player has played all stored rounds),
//     fall back to the latest past time so something still renders.
//
// `teeTimeMap[name]`     — the human-formatted "8:24 AM" string we serve.
// `teeTimeISOMap[name]`  — the underlying ISO string, used here for cmp.
function makeTeeTimeRecorder(teeTimeMap, teeTimeISOMap, earliest) {
  const nowMs = Date.now();
  return function setTeeTime(name, iso) {
    if (!name || !iso || typeof iso !== 'string') return;
    const newMs = new Date(iso).getTime();
    if (isNaN(newMs)) return;

    // Running minimum over EVERY tee time seen, before the per-player
    // disambiguation below touches it. That disambiguation deliberately tracks
    // each player's *next* tee, so its output walks forward as the week
    // progresses and is useless as a fixed point. The raw minimum, read before
    // round 1 starts (when nothing has been played and every published time is
    // an R1 time), is the tournament's actual first tee.
    //
    // Only meaningful pre-start; api/cron.js is responsible for capturing it in
    // that window and then freezing it. See handleFieldCheck.
    if (earliest && (earliest.ms === null || newMs < earliest.ms)) {
      earliest.ms = newMs;
      earliest.iso = iso;
    }
    const existingIso = teeTimeISOMap[name];
    if (!existingIso) {
      teeTimeISOMap[name] = iso;
      teeTimeMap[name] = formatTeeTime(iso);
      return;
    }
    const existingMs = new Date(existingIso).getTime();
    const newIsFuture = newMs >= nowMs;
    const existingIsFuture = existingMs >= nowMs;
    let shouldReplace = false;
    if (newIsFuture && !existingIsFuture) {
      shouldReplace = true;                       // future beats past
    } else if (newIsFuture && existingIsFuture) {
      shouldReplace = newMs < existingMs;         // earliest upcoming wins
    } else if (!newIsFuture && !existingIsFuture) {
      shouldReplace = newMs > existingMs;         // most recent past wins
    }
    if (shouldReplace) {
      teeTimeISOMap[name] = iso;
      teeTimeMap[name] = formatTeeTime(iso);
    }
  };
}

// ── Name identity ─────────────────────────────────────────────────────────
//
// This file used to carry its OWN copy of the alias table and its OWN
// normalizer (normName), under a "⚠ KEEP IN SYNC with src/constants/
// nameAliases.js" comment. The two drifted, as duplicated tables do: this copy
// stripped combining marks but not ø/æ, while the client's copy stripped ø/æ
// but never lowercased.
//
// Worse, the alias table was applied HERE — rewriting the tour's name to the
// SFGL canonical spelling — and the client then compared the result to roster
// names RAW. So the rewrite only helped when the roster already held the
// canonical spelling. When a roster held 'Nico Echavarria' and this endpoint
// emitted 'Nicolas Echavarria', that player silently vanished from the ⛳ flag,
// the "Playing" filter, tee times, odds and live scores.
//
// Both copies are gone. api/_playerNames.js is imported directly by this
// serverless function AND by the browser bundle, and matching is by
// equivalence class on both sides, so it no longer matters which spelling a
// given source uses.
//
// canonicalName() survives only to give the response ONE spelling per player
// when pgatour.com's own page sections disagree — the id/photo/tee-time maps
// below are keyed by name and need a stable key. It is no longer load-bearing
// for matching.
const canonicalName = (name) => resolveAlias(name);

// Build the tee-time list by player IDENTITY rather than by string key.
// Replaces a two-pass exact-then-normalized lookup that still missed any
// rendering difference the old normalizer did not happen to cover.
function joinPlayersToTeeTimes(players, teeTimeMap) {
  const lookup = new NameMap(Object.entries(teeTimeMap));
  const out = [];
  for (const n of players) {
    const tt = lookup.get(n);
    if (tt) out.push({ name: n, teeTime: tt });
  }
  return out;
}

// ── Get upcoming tournament from schedule ─────────────────────────────────────
async function getUpcomingTournament() {
  const resp = await fetch('https://www.pgatour.com/schedule', { headers: HEADERS });
  if (!resp.ok) throw new Error(`Schedule ${resp.status}`);
  const nd = extractNextData(await resp.text());
  if (!nd) throw new Error('No __NEXT_DATA__ on schedule');

  const queries = nd?.props?.pageProps?.dehydratedState?.queries || [];
  let tournaments = [];
  for (const q of queries) {
    if (q?.state?.data?.tournaments) tournaments = tournaments.concat(q.state.data.tournaments);
  }
  const seen = new Set();
  const unique = tournaments.filter(t => { if (seen.has(t.tournamentId)) return false; seen.add(t.tournamentId); return true; });
  const DONE = ['COMPLETED', 'OFFICIAL', 'PAST', 'CANCELLED'];
  const t = unique.find(t => t.status === 'IN_PROGRESS')
    || unique.find(t => t.status === 'UPCOMING')
    || unique.find(t => !DONE.includes(t.status?.toUpperCase()));
  if (!t) throw new Error('No upcoming tournament');
  return t;
}

// ── Odds ─────────────────────────────────────────────────────────────────────
//
// Every odds payload pgatour.com serves identifies its players by ID, not by
// name — the shape is `{ oddsToWinId, players: [{ id, odds }] }`. So the ONLY
// way a price becomes a name is the id→name join below, which made that join
// the single point of failure for the whole Odds column, failing one player at
// a time and silently: the player still appears in `players` (so the ⛳ flag
// and the "Playing" filter work), but the Odds cell renders '—'.
//
// Three ways it used to lose a player, all fixed here:
//
//   1. ORDER. The field-page odds block was resolved INSIDE the walk that
//      builds `pgaIds`. walkAll is pre-order DFS, so any odds row reached
//      before that player's id had been recorded resolved to undefined and was
//      dropped. Rows are now collected raw and resolved in a second pass, once
//      the id map is complete.
//   2. OVERWRITE. `pgaIds` is name→id and last-write-wins, so a player who
//      also appears in a second page section (featured group, defending
//      champion, notable-players rail) had their id replaced by whatever `id`
//      that object carried, and the join then matched nothing. `idToName` is
//      keyed by ID and first-write-wins, so it keeps every association a page
//      ever stated instead of only the last one.
//   3. NO FALLBACK. The odds-page path had no name fallback at all, so a
//      player absent from `pgaIds` — no `id` on their field-page object — was
//      unreachable even when the odds row named them outright. Both paths now
//      try the row's own name first.
//
// A row that still resolves to nothing is counted, not swallowed: `?debug=1`
// reports `oddsUnresolved` so the next instance of this is visible from the
// endpoint instead of from a screenshot of the roster page.

/** Normalize a book price to the '+700' / '-150' rendering the app serves. */
function formatOdds(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return null;                       // a pulled/suspended market
    if (t.startsWith('+') || t.startsWith('-')) return t;
  }
  const n = parseInt(raw, 10);
  if (isNaN(n)) return null;
  return n > 0 ? `+${n}` : `${n}`;
}

/**
 * Pull every odds row out of a __NEXT_DATA__ blob, WITHOUT resolving names.
 * Each row keeps whatever the payload gave us to identify the player by, so
 * the caller can resolve after its id map is complete.
 */
function collectOddsRows(nd) {
  const rows = [];
  walkAll(nd, (obj) => {
    if (obj.oddsToWinId && Array.isArray(obj.players) && obj.players.length) {
      obj.players.forEach((p) => {
        const odds = formatOdds(p.odds ?? p.currentOdds ?? p.americanOdds);
        if (!odds) return;
        rows.push({
          name: p.displayName?.trim() || p.playerName?.trim() || null,
          ids: [p.playerId, p.id].filter((v) => v != null).map(String),
          odds,
        });
      });
    }
  });
  return rows;
}

/**
 * Resolve collected rows into a name→odds map. Name first (it needs no join
 * and cannot go stale), then the id map. Returns the map plus the number of
 * rows that could not be resolved at all.
 */
function resolveOddsRows(rows, idToName) {
  const oddsMap = {};
  let unresolved = 0;
  for (const row of rows) {
    let name = row.name;
    if (!name) {
      for (const id of row.ids) {
        const hit = idToName.get(id);
        if (hit) { name = hit; break; }
      }
    }
    if (name) oddsMap[canonicalName(name) || name] = row.odds;
    else unresolved++;
  }
  return { oddsMap, unresolved };
}

// ── Telling a golfer from a page label ───────────────────────────────────────
//
// A name is not evidence of a person. The field list was built from "any
// object whose displayName contains a space", and `{ displayName: 'FedExCup
// Fall' }` — a tour-section label sitting in the same __NEXT_DATA__ — is
// shaped exactly like a two-word name, so it rode in as a phantom golfer and
// inflated the field count by one.
//
// So a name now needs corroboration from a field that only ever appears on a
// golfer. api/pga-results.js already works this way: it will not accept a name
// without a money value beside it.
//
// The test is a UNION, and deliberately generous. The two errors are not
// symmetric: a phantom entry matches no roster (NameSet keeps it in its own
// equivalence group) and costs a wrong `count`, whereas a REJECTED REAL GOLFER
// loses their ⛳ flag, vanishes from the "Playing" filter, and draws the
// Wednesday "not in this week's field" push against a player who is in it.
// When in doubt this must accept, not reject.
const PLAYER_MARKERS = [
  'shortName', 'country', 'countryCode', 'countryFlag', 'countryName',
  'amateur', 'isAmateur', 'owgr', 'worldRank', 'playerId', 'playerBio',
  'headshot', 'photo', 'photoUrl', 'imageUrl', 'headShotUrl', 'headshotUrl',
  'teeTime', 'teeTimeLocal', 'startTime',
];

function looksLikePlayer(obj) {
  // Both halves of a person's name is unambiguous on its own — no label
  // carries firstName/lastName.
  if (obj.firstName && obj.lastName) return true;
  // pgatour.com's Next.js payload is GraphQL-derived, so most player objects
  // announce themselves ('Player', 'FieldPlayer', 'PlayerRowV3').
  if (typeof obj.__typename === 'string' && /player/i.test(obj.__typename)) return true;
  // A PGA TOUR player id is a number ('46046'); a section id is a slug
  // ('fall', 'playoffs'). Having an id is not evidence — having a NUMERIC one
  // is, and it is what separates the two objects this function exists to tell
  // apart. If a label ever turns up with a numeric id we get a harmless
  // phantom back, and ?debug=1 will not list it as rejected, which is the tell.
  if (obj.id != null && /^\d+$/.test(String(obj.id))) return true;
  return PLAYER_MARKERS.some((k) => obj[k] != null && obj[k] !== '');
}

// ── Parse field page — players, IDs, tee times, odds all in one pass ──────────
// IDs are kept in SEPARATE, NAMESPACE-PURE maps. They used to share one
// `playerIdMap` that mixed three different things — PGA TOUR player IDs from
// this parser, ESPN athlete IDs merged in from the ESPN fallback, and direct
// photo URLs under `__photo_`-prefixed keys. Any consumer that treated that
// map as "PGA IDs" could take an ESPN ID and build a PGA Tour CDN URL from it,
// which does not 404 — it can resolve to a DIFFERENT REAL GOLFER's photo.
// Wrong faces are worse than missing ones, so the namespaces stay separate.
export function parseFieldPage(nd) {
  const playerNames = new Set();
  const rejectedNames = new Set(); // named things that failed looksLikePlayer
  const pgaIds      = {};   // name → PGA TOUR player id (last section seen wins)
  const idToName    = new Map(); // PGA TOUR player id → name (FIRST claim wins)
  const photos      = {};   // name → direct headshot URL (when the page has one)
  const teeTimeMap  = {};   // name → "8:24 AM"
  const teeTimeISOMap = {}; // name → ISO string (internal — used to compare across rounds)

  // Earliest tee time seen anywhere in the payload — the lineup-lock instant,
  // when read before the tournament starts. Mutable box so the recorder can
  // update it. See makeTeeTimeRecorder.
  const earliestTee = { ms: null, iso: null };

  // See makeTeeTimeRecorder for why this exists (multi-round disambiguation).
  const setTeeTime = makeTeeTimeRecorder(teeTimeMap, teeTimeISOMap, earliestTee);

  // pgaIds is name-keyed and last-write-wins, so it can only remember one id
  // per player. idToName is id-keyed, so it remembers all of them — that is
  // what makes the odds join survive a page that states a player's id twice.
  const recordId = (name, id) => {
    if (!name || id == null) return;
    const key = String(id);
    pgaIds[name] = key;
    if (!idToName.has(key)) idToName.set(key, name);
  };

  walkAll(nd, obj => {
    // Player with id + name
    const name = obj.displayName?.trim()
      || (obj.firstName && obj.lastName ? `${obj.firstName.trim()} ${obj.lastName.trim()}` : null);

    if (name?.includes(' ') && !looksLikePlayer(obj)) {
      // Kept for ?debug=1 so an over-eager rejection is visible here rather
      // than as a missing ⛳ on somebody's roster.
      rejectedNames.add(name);
      // The id→name direction is recorded ANYWAY. It feeds the odds join, and
      // that join must not be able to break because this filter got a call
      // wrong — a phantom in idToName can only surface if an odds row cites
      // its id, and that row would then name something no roster holds. A
      // real golfer wrongly rejected here still gets priced.
      if (obj.id != null) {
        const key = String(obj.id);
        if (!idToName.has(key)) idToName.set(key, canonicalName(name) || name);
      }
    } else if (name?.includes(' ')) {
      playerNames.add(canonicalName(name) || name);
      // Store player ID (field page uses 'id')
      if (obj.id) recordId(canonicalName(name) || name, obj.id);
      // Capture photo URL if present directly on player object
      const photo = obj.photo || obj.headshot || obj.photoUrl || obj.imageUrl || obj.headShotUrl || obj.headshotUrl;
      if (photo && typeof photo === 'string' && photo.startsWith('http')) {
        photos[canonicalName(name) || name] = photo;
      }
      // Individual tee time on player object
      const tt = obj.teeTime || obj.teeTimeLocal || obj.startTime;
      if (tt && typeof tt === 'string') {
        setTeeTime(canonicalName(name) || name, tt);
      }
    }

    // Tee time group: { teeTime, players: [...] }
    if ((obj.teeTime || obj.startTime) && Array.isArray(obj.players) && obj.players.length) {
      const ttIso = obj.teeTime || obj.startTime;
      if (typeof ttIso === 'string') {
        obj.players.forEach(p => {
          const pn = p.displayName?.trim()
            || (p.firstName && p.lastName ? `${p.firstName.trim()} ${p.lastName.trim()}` : null);
          if (pn) {
            // Being in a pairing IS the corroboration — nothing but a golfer
            // is grouped under a tee time. Adding them here is the safety net
            // under looksLikePlayer: a real player whose own object was too
            // sparse to pass the marker test is still recovered from the
            // groupings, so the filter above cannot cost us a ⛳ flag.
            playerNames.add(canonicalName(pn) || pn);
            setTeeTime(canonicalName(pn) || pn, ttIso);
            if (p.id) recordId(canonicalName(pn) || pn, p.id);
          }
        });
      }
    }

    // Odds rows are NOT resolved here — see the Odds section above. Resolving
    // them mid-walk meant joining against a half-built id map.
  });

  // Second pass, with the id map complete.
  const { oddsMap, unresolved: oddsUnresolved } = resolveOddsRows(collectOddsRows(nd), idToName);

  // Deduplicate the same golfer appearing under two renderings. The old
  // version only handled the literal "Last, First" vs "First Last" pair by
  // string-rebuilding the name; NameSet's grouping also collapses hyphen,
  // accent, punctuation and nickname differences between page sections, and
  // prefers the first spelling seen. "First Last" entries are added to the
  // set before comma-form ones below so they win as the representative.
  const ordered = [...playerNames].sort((a, b) => Number(a.includes(',')) - Number(b.includes(',')));
  const players = new NameSet(ordered).groups.map((group) => group[0]);

  // A name is only really rejected if NOTHING accepted it. The same golfer is
  // walked several times over — their own object, their tee-time pairing, a
  // featured-group entry — and the sparse renderings fail looksLikePlayer
  // while the rich ones pass. Subtracting at the end rather than deleting on
  // acceptance keeps this independent of which rendering the DFS reaches last.
  const accepted = new NameSet(players);
  const rejected = [...rejectedNames].filter((n) => !accepted.has(n));

  return { players, pgaIds, idToName, photos, teeTimeMap, oddsMap, oddsUnresolved,
           rejectedNames: rejected, firstTeeTimeISO: earliestTee.iso };
}

// ── ESPN fallback for field + tee times ───────────────────────────────────────
async function fetchFromESPN() {
  for (let offset = 0; offset <= 14; offset++) {
    const d = new Date(); d.setDate(d.getDate() + offset);
    const ds = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
    const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard?dates=${ds}`, { headers: { 'User-Agent': HEADERS['User-Agent'], 'Accept': 'application/json' } });
    if (!r.ok) continue;
    const data = await r.json();
    const pga = (data?.events || []).filter(e => e.status?.type?.state !== 'post');
    if (!pga.length) continue;
    const event = pga.find(e => e.status?.type?.state === 'pre') || pga[0];

    const r2 = await fetch(`https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard?event=${event.id}`, { headers: { 'User-Agent': HEADERS['User-Agent'], 'Accept': 'application/json' } });
    if (!r2.ok) continue;
    const ld = await r2.json();
    const competitors = ld?.events?.[0]?.competitions?.[0]?.competitors || [];
    if (!competitors.length) continue;

    const players = [];
    const teeTimes = [];
    const espnIds = {};
    let earliestMs = null, earliestISO = null;

    competitors.forEach(c => {
      const name = c.athlete?.displayName || c.athlete?.fullName || '';
      if (!name) return;
      const canonical = canonicalName(name) || name;
      players.push(canonical);
      // ESPN athlete ID doubles as the headshot ID
      if (c.athlete?.id) espnIds[canonical] = String(c.athlete.id);
      const ttRaw = c.teeTime || c.status?.teeTime || c.startTime;
      if (ttRaw) {
        const tt = formatTeeTime(ttRaw);
        if (tt) teeTimes.push({ name: canonical, teeTime: tt });
        const ms = new Date(ttRaw).getTime();
        if (!isNaN(ms) && (earliestMs === null || ms < earliestMs)) {
          earliestMs = ms;
          earliestISO = new Date(ms).toISOString();
        }
      }
    });

    // ESPN only supplies a first tee time BEFORE the event starts.
    //
    // Unlike pgatour.com's field page, which is a tee sheet, this is the
    // LEADERBOARD: once play is under way `c.teeTime` carries the CURRENT
    // round's times, so on Friday the minimum here is an R2 time. Storing that
    // as the first tee would move a lock that had already fired and re-open the
    // tournament mid-week. Gating on 'pre' means the value is only ever offered
    // while every published time is still an R1 time.
    const notStarted = event.status?.type?.state === 'pre';

    if (players.length) {
      return {
        players, espnIds, teeTimes, oddsMap: {},
        firstTeeTimeISO: notStarted ? earliestISO : null,
        tournament: event.name, source: 'espn',
      };
    }
  }
  throw new Error('No field found via ESPN');
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const isDebug = req.query.debug === '1';
  const year = new Date().getFullYear().toString();
  const errors = [];

  let result = null;

  // ── Source 1: PGA Tour schedule + field page ────────────────────────────────
  try {
    const tournament = await getUpcomingTournament();
    const slug = nameToSlug(tournament.name);
    const fieldUrl = `https://www.pgatour.com/tournaments/${year}/${slug}/${tournament.tournamentId}/field`;
    const fieldResp = await fetch(fieldUrl, { headers: HEADERS });

    if (fieldResp.ok) {
      const fieldNd = extractNextData(await fieldResp.text());
      if (fieldNd) {
        const parsedField = parseFieldPage(fieldNd);
        const { players, pgaIds, idToName, photos, teeTimeMap, oddsMap,
                oddsUnresolved: fieldOddsUnresolved, rejectedNames } = parsedField;
        // Reassignable, unlike the rest: the tee-times-page fallback below may
        // supply this when the field page did not carry a tee sheet.
        let firstTeeTimeISO = parsedField.firstTeeTimeISO;
        const espnIds = {}; // filled only from the ESPN supplement below
        let oddsUnresolved = fieldOddsUnresolved;

        // If no tee times from field page, try dedicated tee-times page
        let finalTeeTimes = joinPlayersToTeeTimes(players, teeTimeMap);
        if (!finalTeeTimes.length && players.length) {
          try {
            const ttResp = await fetch(`https://www.pgatour.com/tournaments/${year}/${slug}/${tournament.tournamentId}/tee-times`, { headers: HEADERS });
            if (ttResp.ok) {
              const ttNd = extractNextData(await ttResp.text());
              if (ttNd) {
                const { teeTimeMap: ttMap2, pgaIds: pgaIds2, idToName: idToName2, photos: photos2,
                        firstTeeTimeISO: firstTee2 } = parseFieldPage(ttNd);
                finalTeeTimes = joinPlayersToTeeTimes(players, ttMap2);
                // This branch runs precisely BECAUSE the field page had no tee
                // times, so it is also the branch where firstTeeTimeISO came
                // back null. Taking it from here too is what stops the lineup
                // lock silently falling back to the hour rule for every event
                // whose field page omits the tee sheet.
                if (!firstTeeTimeISO && firstTee2) firstTeeTimeISO = firstTee2;
                // Merge any new PGA ids / photos from the tee-times page. The
                // id→name direction merges WITHOUT clobbering: the field page
                // is the better authority on spelling, and an id it already
                // claimed must keep pointing at the same golfer.
                Object.assign(pgaIds, pgaIds2);
                for (const [id, n] of idToName2) if (!idToName.has(id)) idToName.set(id, n);
                Object.assign(photos, photos2);
              }
            }
          } catch (_) {}
        }

        // If still no tee times, supplement from ESPN
        if (!finalTeeTimes.length && players.length) {
          try {
            const espn = await fetchFromESPN();
            if (espn.teeTimes?.length) {
              // Joining PGA Tour names to ESPN names is the highest-variance
              // match in this file — two independent editorial styles. The
              // previous normalizer here stripped every non-[a-z ] character,
              // which folded accents to NOTHING rather than to their base
              // letter ('Muñoz' → 'muoz'), so accented players lost their tee
              // time on this path. NameMap handles it by identity.
              const espnMap = new NameMap(espn.teeTimes.map(({ name, teeTime }) => [name, teeTime]));
              // ESPN ids go in their OWN map — merging them into pgaIds is
              // what made the combined map unsafe to build PGA URLs from.
              Object.assign(espnIds, espn.espnIds || {});
              finalTeeTimes = players
                .filter(n => espnMap.has(n))
                .map(n => ({ name: n, teeTime: espnMap.get(n) }));
              // Last source standing for the lineup lock. Already gated to
              // pre-start inside fetchFromESPN, so it cannot contribute a
              // later-round time.
              if (!firstTeeTimeISO && espn.firstTeeTimeISO) firstTeeTimeISO = espn.firstTeeTimeISO;
            }
          } catch (_) {}
        }

        // Fetch odds from odds page if not already embedded in field page
        let finalOdds = Object.entries(oddsMap).map(([name, odds]) => ({ name, odds }));
        if (!finalOdds.length) {
          try {
            const oddsResp = await fetch(`https://www.pgatour.com/tournaments/${year}/${slug}/${tournament.tournamentId}/odds`, { headers: HEADERS });
            if (oddsResp.ok) {
              const oddsNd = extractNextData(await oddsResp.text());
              if (oddsNd) {
                // Market selection stays as it was: the odds page can carry
                // several markets (outright, top-10, matchups), each with its
                // own oddsToWinId, and the enabled one is the outright board.
                let oddsObj = null;
                walkAll(oddsNd, obj => {
                  if (obj.oddsToWinId && Array.isArray(obj.players) && obj.players.length) {
                    if (!oddsObj || obj.oddsEnabled) oddsObj = obj;
                  }
                });
                if (oddsObj) {
                  const rows = oddsObj.players.map(p => ({
                    name: p.displayName?.trim() || p.playerName?.trim() || null,
                    ids: [p.playerId, p.id].filter(v => v != null).map(String),
                    odds: formatOdds(p.odds ?? p.currentOdds ?? p.americanOdds),
                  })).filter(r => r.odds);
                  const resolved = resolveOddsRows(rows, idToName);
                  oddsUnresolved = resolved.unresolved;
                  finalOdds = Object.entries(resolved.oddsMap).map(([name, odds]) => ({ name, odds }));
                }
              }
            }
          } catch (_) {}
        }

        if (players.length) {
          result = {
            players,
            pgaIds,
            espnIds,
            photos,
            teeTimes: finalTeeTimes,
            // Absolute instant, unlike the display strings in teeTimes. Only
            // trustworthy before round 1 begins — see makeTeeTimeRecorder.
            firstTeeTimeISO,
            odds: finalOdds,
            oddsUnresolved,
            rejectedNames,
            tournament: tournament.name,
            source: 'pgatour',
          };
        }
      }
    }
  } catch (e) { errors.push(`pgatour: ${e.message}`); }

  // ── Source 2: ESPN fallback ─────────────────────────────────────────────────
  if (!result?.players?.length) {
    try {
      const espn = await fetchFromESPN();
      result = { ...espn, pgaIds: {}, photos: {}, odds: [] };
    } catch (e) { errors.push(`espn: ${e.message}`); }
  }

  if (!result?.players?.length) {
    return res.status(503).json({ error: 'All sources failed', details: errors });
  }

  if (isDebug) {
    return res.status(200).json({
      source: result.source,
      tournament: result.tournament,
      playerCount: result.players.length,
      teeTimeCount: result.teeTimes?.length || 0,
      oddsCount: result.odds?.length || 0,
      // Odds rows the id→name join could not place. Non-zero here is the
      // signature of a player sitting in the field with a '—' in the Odds
      // column; zero with a low oddsCount means the book simply has no price
      // for them, which is not ours to fix.
      oddsUnresolved: result.oddsUnresolved || 0,
      // Truncated — when the join fails wholesale this is the entire field,
      // and a debug endpoint that dumps 156 names is one nobody reads.
      fieldPlayersWithoutOdds: (() => {
        const priced = new NameSet((result.odds || []).map(o => o.name));
        const missing = (result.players || []).filter(n => !priced.has(n));
        return { count: missing.length, sample: missing.slice(0, 20) };
      })(),
      // Named objects rejected as page furniture rather than golfers. Expect
      // section labels and banner text here. A REAL GOLFER in this list is a
      // bug in looksLikePlayer — they will be missing their ⛳ flag on every
      // roster that holds them.
      rejectedNames: result.rejectedNames || [],
      pgaIdCount: Object.keys(result.pgaIds || {}).length,
      espnIdCount: Object.keys(result.espnIds || {}).length,
      photoUrlCount: Object.keys(result.photos || {}).length,
      samplePlayers: result.players.slice(0, 5),
      sampleTeeTimes: result.teeTimes?.slice(0, 3),
      sampleOdds: result.odds?.slice(0, 3),
      samplePgaIds: Object.entries(result.pgaIds || {}).slice(0, 5),
      sampleEspnIds: Object.entries(result.espnIds || {}).slice(0, 5),
      samplePhotos: Object.entries(result.photos || {}).slice(0, 3),
      errors,
    });
  }

  return res.status(200).json({
    players: result.players,
    // Namespace-pure ID maps. `playerIds` (a single map that mixed PGA ids,
    // ESPN ids and __photo_ URLs) is gone — building a PGA Tour CDN URL from an
    // ESPN id can surface a different real golfer's photo.
    pgaIds:  result.pgaIds  || {},
    espnIds: result.espnIds || {},
    photos:  result.photos  || {},
    teeTimes: result.teeTimes || [],
    firstTeeTimeISO: result.firstTeeTimeISO || null,
    odds: result.odds || [],
    tournament: result.tournament,
    count: result.players.length,
    source: result.source,
  });
}
