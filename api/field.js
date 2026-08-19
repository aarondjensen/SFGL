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
// Ways it has lost a player, all fixed here:
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
//      consider the row's own name.
//   4. NAMESPACE. The odds side reads `[p.playerId, p.id]`, but the recorder
//      that FILLS the id map only ever read `obj.id`. A golfer stated with
//      `playerId` and no `id` was therefore in `players` (their displayName
//      needs no id) and absent from the id map, so their price was dropped.
//      recordIdAlias now records every id namespace a row can cite.
//   5. A DEGRADED NAME BEATING A GOOD ID. Resolution preferred the row's own
//      name unconditionally. That name comes from the BOOK, which sometimes
//      renders surname-only ('Spaun'), and a lone surname matches nothing —
//      so the price landed under a junk key and the golfer kept their '—'.
//      This week's FIELD now arbitrates: whichever candidate names somebody
//      actually playing wins, and the key is the field's own spelling.
//   6. A PARTIAL RAIL SUPPRESSING THE BOARD. The dedicated odds page was
//      fetched only when the field page carried NO odds, so a favourites-only
//      promo rail satisfied the gate and everyone outside it showed '—'. The
//      gate is coverage now, and the two paths share one code path so they
//      cannot drift apart again.
//
// A row that still resolves to nothing is counted, not swallowed: `?debug=1`
// reports `oddsUnresolved`, and `oddsNotInField` for rows that resolved to
// somebody no roster answers to. The next instance of this is visible from the
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
      // Which market this row came from. A page can carry several — outright,
      // top-10, matchups, and a favourites-only promo rail — each with its own
      // oddsToWinId, and they overlap. Ranking them lets the writer below keep
      // the best market's price for a player who appears in more than one,
      // instead of the naive last-write-wins the DFS order happened to give.
      // The outright board is the enabled one and the one with everybody in
      // it, so 'enabled' outranks 'big' and 'big' outranks 'small'.
      const rank = (obj.oddsEnabled ? 1e6 : 0) + obj.players.length;
      obj.players.forEach((p) => {
        // A row with no usable price is KEPT, with odds: null. It used to be
        // dropped here, which threw away the one fact that separates the two
        // reasons a player shows '—': the book has no row for them at all, or
        // the book has a row and has PULLED the price (suspended market, '',
        // 'OTB'). Those look identical downstream and want opposite responses
        // — the first is ours to chase, the second is not. resolveOddsRows
        // reports the second as `pulled`; neither ever reaches the odds map.
        rows.push({
          name: p.displayName?.trim() || p.playerName?.trim() || null,
          ids: [p.playerId, p.id].filter((v) => v != null).map(String),
          odds: formatOdds(p.odds ?? p.currentOdds ?? p.americanOdds),
          rank,
        });
      });
    }
  });
  return rows;
}

/**
 * Resolve collected rows into a name→odds map.
 *
 * `field` is a NameSet of this week's field. It is not just a filter — it is
 * the ARBITER. A row can identify its player two ways (its own name, and the
 * id map), and the two are not equally trustworthy:
 *
 *   • the id map's names come from the field page, so they are already in the
 *     same namespace as `players` — the exact spellings the client will look
 *     odds up against;
 *   • the row's own name comes from the BOOK, which renders names its own way
 *     and sometimes surname-only ('Spaun'). A surname is not a name this app
 *     can match — nameKey('Spaun') is a single token that meets nothing — so
 *     preferring it unconditionally, as this used to, threw away a perfectly
 *     good id and left that player with a '—'. It did not even count as
 *     unresolved: the map just grew a junk 'Spaun' key nobody reads.
 *
 * So: try both, take the first that names somebody actually in the field, and
 * key the map with the FIELD's spelling. That last part is what guarantees the
 * odds keys and the `players` list can never end up in two namespaces.
 *
 * The original preference order (row name first, id second) is kept among
 * candidates that do resolve — a name needs no join and cannot go stale.
 *
 * Returns:
 *   oddsMap    — name → price, keyed in the field's namespace
 *   unresolved — rows nothing could identify (an id nobody claimed, no name)
 *   notInField — priced rows that resolved to somebody outside the field
 *   pulled     — field players the book LISTS but has no price for right now
 *
 * The last three are diagnostics; see the ?debug=1 block in the handler.
 */
function resolveOddsRows(rows, idToName, field) {
  const oddsMap = {};
  const wroteAtRank = {};   // name key → rank of the market that set it
  const notInField = new Set();
  const priceless = new Set();
  let unresolved = 0;

  for (const row of rows) {
    let byId = null;
    for (const id of row.ids) {
      const hit = idToName.get(id);
      if (hit) { byId = hit; break; }
    }

    // The field's own spelling wins when either candidate resolves to it.
    let name = null;
    for (const candidate of [row.name, byId]) {
      if (!candidate) continue;
      const inField = field?.resolve(candidate);
      if (inField) { name = inField; break; }
    }
    // Nothing matched the field. Keep the row anyway — the field list can be
    // incomplete, and a price for a player we failed to parse into `players`
    // is still better than none — but report it.
    if (!name) name = row.name || byId;
    // A row with no price and no identity is not an identification failure —
    // there is nothing it was supposed to price. Only priced rows count.
    if (!name) { if (row.odds) unresolved++; continue; }

    const key = canonicalName(name) || name;
    if (!row.odds) { priceless.add(key); continue; }

    if (!field?.has(key)) notInField.add(key);
    const rank = row.rank ?? 0;
    if (wroteAtRank[key] == null || rank >= wroteAtRank[key]) {
      oddsMap[key] = row.odds;
      wroteAtRank[key] = rank;
    }
  }

  // Only a player left with NO price anywhere is really pulled — a player the
  // top-10 market has suspended while the outright board still prices them is
  // priced, and saying otherwise would be noise.
  const pulled = [...priceless].filter((k) => !(k in oddsMap));
  return { oddsMap, unresolved, notInField: [...notInField], pulled };
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

  // idToName ONLY — every other id namespace an odds row might cite.
  //
  // This is the half of the join that used to be missing. collectOddsRows
  // reads `[p.playerId, p.id]`, but the recorder above only ever read
  // `obj.id`, so a golfer whose field-page object states `playerId` and no
  // `id` contributed NOTHING to the id map. Their odds row then cited an id
  // nobody had claimed and was dropped — while their name, which comes from
  // `displayName` and needs no id at all, still put them in `players`. That is
  // exactly the reported shape: in the field, ⛳ flag showing, '—' in Odds,
  // one player at a time, because only the sections that spell it `playerId`
  // are affected.
  //
  // pgaIds is deliberately NOT written here. It is the map headshot URLs are
  // built from, and mixing a second namespace into it is how this file grew a
  // photo bug once already.
  const recordIdAlias = (name, id) => {
    if (!name || id == null) return;
    const key = String(id);
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
      recordIdAlias(canonicalName(name) || name, obj.id);
      recordIdAlias(canonicalName(name) || name, obj.playerId);
    } else if (name?.includes(' ')) {
      playerNames.add(canonicalName(name) || name);
      // Store player ID (field page uses 'id'; some sections use 'playerId',
      // which only feeds the odds join — see recordIdAlias)
      if (obj.id) recordId(canonicalName(name) || name, obj.id);
      recordIdAlias(canonicalName(name) || name, obj.playerId);
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
            recordIdAlias(canonicalName(pn) || pn, p.playerId);
          }
        });
      }
    }

    // Odds rows are NOT resolved here — see the Odds section above. Resolving
    // them mid-walk meant joining against a half-built id map.
  });

  // Deduplicate the same golfer appearing under two renderings. The old
  // version only handled the literal "Last, First" vs "First Last" pair by
  // string-rebuilding the name; NameSet's grouping also collapses hyphen,
  // accent, punctuation and nickname differences between page sections, and
  // prefers the first spelling seen. "First Last" entries are added to the
  // set before comma-form ones below so they win as the representative.
  const ordered = [...playerNames].sort((a, b) => Number(a.includes(',')) - Number(b.includes(',')));
  const players = new NameSet(ordered).groups.map((group) => group[0]);
  const fieldSet = new NameSet(players);

  // Second pass, with the id map AND the field list complete — resolveOddsRows
  // needs the field to arbitrate between a row's own name and its id.
  const { oddsMap, unresolved: oddsUnresolved, notInField: oddsNotInField,
          pulled: oddsPulled } =
    resolveOddsRows(collectOddsRows(nd), idToName, fieldSet);

  // A name is only really rejected if NOTHING accepted it. The same golfer is
  // walked several times over — their own object, their tee-time pairing, a
  // featured-group entry — and the sparse renderings fail looksLikePlayer
  // while the rich ones pass. Subtracting at the end rather than deleting on
  // acceptance keeps this independent of which rendering the DFS reaches last.
  const rejected = [...rejectedNames].filter((n) => !fieldSet.has(n));

  return { players, pgaIds, idToName, photos, teeTimeMap,
           oddsMap, oddsUnresolved, oddsNotInField, oddsPulled,
           rejectedNames: rejected, firstTeeTimeISO: earliestTee.iso };
}

// ── ESPN ──────────────────────────────────────────────────────────────────────

const ESPN_HEADERS = { 'User-Agent': HEADERS['User-Agent'], 'Accept': 'application/json' };

/**
 * Find the next non-finished PGA event on ESPN and return its leaderboard.
 *
 * ONE discovery path, shared by the field/tee-time fallback and the odds
 * gap-filler below. They used to be one function; splitting the odds work out
 * without splitting this out first would have meant two copies of the
 * scoreboard walk, which is the duplication this repo keeps getting bitten by.
 *
 * `fromOffset` exists so callers can resume the day-by-day scan where a
 * previous call left off. fetchFromESPN needs that: an event whose leaderboard
 * carries competitors but no usable names must not stop the search.
 *
 * `trace` is filled in as it goes, so a caller can say WHICH step failed
 * rather than only that nothing came back. ESPN failing here is silent
 * everywhere else — the tee-time supplement and the odds gap-filler both just
 * quietly do nothing — and `espnIdCount: 0` in ?debug=1 turned out to be the
 * only sign that this path had stopped working at all.
 *
 * Returns { event, ld, competitors, offset } or null.
 */
async function findESPNEvent(fromOffset = 0, trace = espnTrace(), maxOffset = 14) {
  // Try the plain scoreboard first — no `dates` at all. Golf events span four
  // days, so a single-day `dates=YYYYMMDD` is a guess about which day ESPN
  // files the event under, and the bare endpoint simply returns what is on now.
  // The dated scan below stays as the fallback it always was.
  const urls = [];
  if (fromOffset === 0) urls.push('https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard');
  for (let offset = fromOffset; offset <= maxOffset; offset++) {
    const d = new Date(); d.setDate(d.getDate() + offset);
    const ds = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
    urls.push(`https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard?dates=${ds}`);
  }

  for (let i = 0; i < urls.length; i++) {
    // offset is what the caller resumes from; the bare URL is not a day, so it
    // reports as the day the caller asked for.
    const offset = fromOffset === 0 ? Math.max(0, i - 1) : fromOffset + i;

    trace.sbTried++;
    let r;
    // Per-request, so one refusal or one DNS blip does not end the scan. This
    // used to throw straight out through every caller's swallow, which turned
    // a transient network error into "ESPN has no event".
    try { r = await fetch(urls[i], { headers: ESPN_HEADERS }); }
    catch (e) { trace.sbCodes.add(`fetch:${e.message}`); continue; }
    if (!r.ok) { trace.sbCodes.add(String(r.status)); continue; }
    trace.sbOk++;
    const data = await r.json();
    const pga = (data?.events || []).filter(e => e.status?.type?.state !== 'post');
    if (!pga.length) continue;
    trace.evFound++;
    const event = pga.find(e => e.status?.type?.state === 'pre') || pga[0];

    // Both spellings of the leaderboard URL. Every other golf endpoint ESPN
    // serves is tour-scoped (`golf/pga/...`); this one was not, and an
    // untour-scoped URL is the kind of thing that 404s without anyone noticing
    // because the whole path is wrapped in a swallow. Tour-scoped is tried
    // first and the original second, so this cannot regress a form that works.
    const lbUrls = [
      `https://site.api.espn.com/apis/site/v2/sports/golf/pga/leaderboard?event=${event.id}`,
      `https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard?event=${event.id}`,
    ];
    for (const lbUrl of lbUrls) {
      trace.lbTried++;
      let r2;
      try { r2 = await fetch(lbUrl, { headers: ESPN_HEADERS }); }
      catch (e) { trace.lbCodes.add(`fetch:${e.message}`); continue; }
      if (!r2.ok) { trace.lbCodes.add(String(r2.status)); continue; }
      trace.lbOk++;
      const ld = await r2.json();
      const competitors = ld?.events?.[0]?.competitions?.[0]?.competitors
        || ld?.competitions?.[0]?.competitors
        || [];
      trace.competitors = Math.max(trace.competitors, competitors.length);
      if (!competitors.length) continue;
      return { event, ld, competitors, offset };
    }
  }
  return null;
}

/** Counters findESPNEvent fills in, so a failure can name its own step. */
function espnTrace() {
  return { sbTried: 0, sbOk: 0, evFound: 0, lbTried: 0, lbOk: 0, competitors: 0,
           sbCodes: new Set(), lbCodes: new Set() };
}

/**
 * The one-line version of a trace, for ?debug=1.
 *
 * The status codes are the part that matters. "0/8 ok" says the scan failed;
 * it does not say whether ESPN refused us (403 — a datacenter block, which no
 * amount of URL-fixing solves) or whether we asked for the wrong thing (404).
 * Those want opposite responses, and telling them apart from outside is the
 * whole point of this string.
 */
function espnTraceSummary(t) {
  const codes = (set) => (set.size ? ` (${[...set].slice(0, 3).join(', ')})` : '');
  if (!t.sbTried) return 'not tried';
  if (!t.sbOk) return `scoreboard 0/${t.sbTried} ok${codes(t.sbCodes)}`;
  if (!t.evFound) return `scoreboard ${t.sbOk}/${t.sbTried} ok, no live events`;
  if (!t.lbOk) return `${t.evFound} events, leaderboard 0/${t.lbTried} ok${codes(t.lbCodes)}`;
  return `${t.evFound} events, leaderboard ok, ${t.competitors} competitors`;
}

// ── ESPN fallback for field + tee times ───────────────────────────────────────
async function fetchFromESPN() {
  for (let from = 0; from <= 14; ) {
    const found = await findESPNEvent(from);
    if (!found) break;
    from = found.offset + 1;
    const { event, competitors } = found;

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

// ── ESPN odds: the gap-filler ────────────────────────────────────────────────
//
// Last resort, and only for players BOTH pgatour.com pages left unpriced. At
// the 2026 BMW Championship the tour's own board carried 48 rows for a 50-man
// field — the field page and the dedicated /odds page agreed on the same 48 —
// so J.J. Spaun and Matt McCarty rendered '—' with nothing wrong on our side.
// That is what this is for.
//
// Two deliberate limits:
//
//   • GAPS ONLY, never an overwrite. ESPN's book is not the tour's, so their
//     prices differ by a few points on the same golfer. Filling a blank cell
//     from a second book is worth it; silently restating a price the tour
//     already gave us in another book's numbers is not.
//   • NAMES ONLY, never ids. ESPN athlete ids and PGA TOUR player ids are
//     different namespaces that both look like bare integers, and joining an
//     ESPN id through the PGA id map is precisely the mix-up that once put
//     another golfer's face on a player card. resolveOddsRows is handed an
//     EMPTY id map here, so a row that cannot name itself is simply dropped.
//
// The harvester is shape-agnostic on purpose. ESPN serves golf prices from
// more than one endpoint and more than one layout, so rather than hard-code a
// path this walks the payload for objects that pair a golfer with an
// explicitly odds-named field — the same tactic collectOddsRows uses on
// pgatour's __NEXT_DATA__.

/** An American price, and only that — not a score, a position or a yardage. */
function bookPrice(raw) {
  let v = raw;
  // ESPN wraps a price as { value, displayValue } about half the time.
  if (v && typeof v === 'object') v = v.displayValue ?? v.american ?? v.moneyLine ?? v.value;
  if (v == null) return null;
  const s = String(v).trim();
  if (!/^[+-]?\d{2,6}$/.test(s)) return null;
  const n = parseInt(s, 10);
  // Three figures minimum. A golf outright runs from about +250 to +100000,
  // while a round score, a position and a rank are all two digits or fewer —
  // this is what keeps a walker this generic from reading one as the other.
  if (isNaN(n) || Math.abs(n) < 100) return null;
  return formatOdds(n);
}

// ── Which market is the Odds column? ─────────────────────────────────────────
//
// A sportsbook offers dozens of markets on one tournament, and most of them
// name the same golfers: Top 10 Finish, First Round Leader, head-to-head
// matchups, group betting, make-the-cut. Their prices are nothing like an
// outright price — a matchup is around -110, a top-10 a fraction of the win
// number — so harvesting blind would quietly put a two-man matchup price in a
// column that says "Odds" and means "odds to win".
//
// That is strictly worse than the blank cell this whole exercise is trying to
// fill: a blank is honestly empty, whereas '-115' beside a golfer's name reads
// as a real number and is wrong. So the market label has to say winner, and
// must not say anything else.
const WIN_MARKET = /(tournament\s+winner|outright\s+winner|outright|to\s+win\b|winner)/i;
const NOT_WIN_MARKET = /(top\s*\d|finish|placement|matchup|match\s*bet|head\s*to\s*head|h2h|group|round\s*\d|first\s*round|hole|cut|nationality|3\s*balls?|2\s*balls?)/i;

function isWinMarket(label) {
  const s = String(label ?? '');
  if (!s) return false;
  if (NOT_WIN_MARKET.test(s)) return false;
  return WIN_MARKET.test(s);
}

/**
 * Odds rows harvested from a secondary source, in resolveOddsRows' shape.
 * Handles both families this endpoint reaches for:
 *
 *   • sportsbook — a MARKET object carrying `outcomes` / `runners`, each with
 *     a player label and an American price. Only outright-winner markets are
 *     taken (see isWinMarket), and `rank` is the market's size so that if two
 *     win markets overlap, the fuller board wins.
 *   • ESPN — a flat object naming a golfer beside an odds-named field.
 *
 * The two are kept apart deliberately. A book's outcome objects also satisfy
 * the flat test, so harvesting them there as well would readmit every market
 * the label gate just excluded, at rank 1 but with nothing else competing for
 * a player the outright board does not carry.
 */
export function bookOddsRows(json) {
  const rows = [];
  const push = (name, odds, rank) => {
    // A single token is not a name this app can match, and a `label` on an
    // odds object is as likely to be 'Over', 'Yes', or the book's own name.
    if (name && name.includes(' ') && odds) rows.push({ name, ids: [], odds, rank });
  };

  walkAll(json, (obj) => {
    const outcomes = Array.isArray(obj.outcomes) ? obj.outcomes
      : Array.isArray(obj.runners) ? obj.runners : null;

    if (outcomes?.length) {
      const label = obj.label || obj.name || obj.marketName || obj.marketType
        || obj.betOfferType?.name || obj.offerSubcategory?.name || '';
      if (!isWinMarket(label)) return;
      for (const o of outcomes) {
        if (!o || typeof o !== 'object') continue;
        const name = (o.label || o.participant || o.runnerName || o.playerName
          || o.displayName || o.fullName || '').trim();
        const raw = o.oddsAmerican ?? o.americanOdds ?? o.odds
          ?? o.winRunnerOdds?.americanDisplayOdds?.americanOdds
          ?? o.price?.american;
        push(name, bookPrice(raw), outcomes.length);
      }
      return;
    }

    // Flat (ESPN). Only keys that SAY they are odds — a generic value scan
    // would pick up yardages and purses, which are shaped exactly like prices.
    // `oddsAmerican` is deliberately absent: it is the book spelling, and it
    // only ever occurs inside a market handled above.
    const raw = obj.odds ?? obj.moneyLine ?? obj.moneyline ?? obj.americanOdds
             ?? obj.currentOdds ?? obj.oddsToWin ?? obj.winOdds;
    if (raw == null) return;
    const athlete = obj.athlete && typeof obj.athlete === 'object' ? obj.athlete : null;
    const name = (athlete?.displayName || athlete?.fullName
      || obj.displayName || obj.fullName || '').trim();
    push(name, bookPrice(raw), 1);
  });
  return rows;
}

// ── Sportsbook gap-filler ────────────────────────────────────────────────────
//
// Tried BEFORE ESPN, which has been answering non-2xx to every request from
// this function (see the oddsEspn trace). Same two restrictions as every other
// secondary source, enforced in pickGapOdds: names only, gaps only.
//
// The endpoint list is overridable by ODDS_BOOK_URLS (comma-separated). These
// are unofficial endpoints on a geo-partitioned host — the region prefix and
// the golf event-group id both move — and being able to repoint it from the
// Vercel dashboard is the difference between a config change and a deploy.
const BOOK_HEADERS = {
  'User-Agent': HEADERS['User-Agent'],
  'Accept': 'application/json',
  'Referer': 'https://sportsbook.draftkings.com/',
};

// The human-facing league page comes FIRST, deliberately.
//
// The alternative was to hardcode a golf event-group id, and that id is not
// documented anywhere — a guess at it fails exactly the way a wrong URL fails,
// silently and indistinguishably from "the book had nothing". The page URL, by
// contrast, is a fact: it is what you get by clicking golf on the site.
//
// So the page is treated as the entry point and mined for the id, which is the
// same move this file already makes against pgatour.com — fetch the HTML,
// pull the embedded state, work from that. If the page happens to embed the
// board itself, no id is needed at all.
// The tournament slug is derived, not hardcoded — DraftKings spells its golf
// league pages the same way pgatour.com spells its tournament pages
// ('BMW Championship' → 'bmw-championship'), so nameToSlug already produces
// it. A literal would have worked for exactly one week.
export const bookUrlsFor = (tournamentName) => [
  ...(tournamentName ? [`https://sportsbook.draftkings.com/leagues/golf/${nameToSlug(tournamentName)}`] : []),
  'https://sportsbook.draftkings.com/leagues/golf/pga',
];

const DK_API = (id) =>
  `https://sportsbook-us-il.draftkings.com/sites/US-IL-SB/api/v5/eventgroups/${id}?format=json`;

/**
 * Every JSON blob a sportsbook page embeds. DraftKings is a React app, so its
 * state arrives as one of a few well-known shapes rather than in the markup.
 */
export function embeddedJson(html) {
  const blobs = [];
  const next = extractNextData(html);
  if (next) blobs.push(next);
  for (const re of [
    /window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});?\s*<\/script>/,
    /window\.__PRELOADED_STATE__\s*=\s*({[\s\S]*?});?\s*<\/script>/,
  ]) {
    const m = html.match(re);
    if (m) { try { blobs.push(JSON.parse(m[1])); } catch { /* not JSON after all */ } }
  }
  for (const m of html.matchAll(/<script[^>]+type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)) {
    try { blobs.push(JSON.parse(m[1])); } catch { /* ditto */ }
  }
  return blobs;
}

/**
 * Event-group ids named anywhere in a page — a URL it links to, a data
 * attribute, a fragment of embedded state. Deduped, capped, because each one
 * costs a request.
 */
export function eventGroupIds(html) {
  const ids = new Set();
  for (const re of [
    /eventgroups?\/(\d{1,7})/gi,
    /"eventGroupId"\s*:\s*"?(\d{1,7})/gi,
    /"leagueId"\s*:\s*"?(\d{1,7})/gi,
  ]) {
    for (const m of html.matchAll(re)) ids.add(m[1]);
  }
  return [...ids].slice(0, 4);
}

/**
 * Prices for `wanted` from a sportsbook, or an empty map. Never throws.
 *
 * Every candidate is tried until one yields a fill, and each one's outcome is
 * recorded, so a failure names itself in ?debug=1 rather than looking the same
 * as "no gaps to fill".
 */
async function fetchBookOdds(fieldSet, wanted, tournamentName) {
  const configured = (process.env.ODDS_BOOK_URLS || '')
    .split(',').map((u) => u.trim()).filter(Boolean);
  const urls = configured.length ? configured : bookUrlsFor(tournamentName);
  const notes = [];

  // Each candidate reduces to rows; the first that actually fills a gap wins.
  const tryRows = (label, rows) => {
    if (!rows.length) { notes.push(`${label} no win market`); return null; }
    const odds = pickGapOdds(rows, fieldSet, wanted);
    const filled = Object.keys(odds).length;
    if (!filled) { notes.push(`${label} ${rows.length} rows, filled 0`); return null; }
    return { odds, status: `${label} ${rows.length} rows, filled ${filled}` };
  };

  for (const url of urls) {
    const label = (() => {
      try { const u = new URL(url); return u.pathname.split('/').filter(Boolean).pop() || u.hostname; }
      catch { return 'url'; }
    })();
    try {
      const r = await fetch(url, { headers: BOOK_HEADERS });
      if (!r.ok) { notes.push(`${label} ${r.status}`); continue; }
      const body = await r.text();

      // A JSON endpoint answers directly.
      if (body.trimStart().startsWith('{')) {
        let json = null;
        try { json = JSON.parse(body); } catch { /* fall through to the HTML path */ }
        if (json) {
          const hit = tryRows(label, bookOddsRows(json));
          if (hit) return hit;
          continue;
        }
      }

      // A page: the board may be embedded outright…
      const embedded = embeddedJson(body).flatMap((b) => bookOddsRows(b));
      const hit = tryRows(`${label} page`, embedded);
      if (hit) return hit;

      // …and failing that, the page names the ids the API wants. This is the
      // step that removes the guess: the id comes from the site, not from us.
      const ids = eventGroupIds(body);
      if (!ids.length) { notes.push(`${label} no id`); continue; }
      for (const id of ids) {
        const ar = await fetch(DK_API(id), { headers: BOOK_HEADERS });
        if (!ar.ok) { notes.push(`eg${id} ${ar.status}`); continue; }
        const apiHit = tryRows(`eg${id}`, bookOddsRows(await ar.json()));
        if (apiHit) return apiHit;
      }
    } catch (e) {
      notes.push(`${label} fetch:${e.message}`);
    }
  }
  return { odds: {}, status: notes.join('; ') || 'not tried' };
}

/**
 * Reduce harvested ESPN rows to prices for `wanted` — the field players nobody
 * has priced yet — keyed by the spelling `wanted` used.
 *
 * The two restrictions that make a cross-source fill safe live here:
 *
 *   • an EMPTY id map, so ESPN athlete ids can never be joined through the PGA
 *     TOUR id map (different namespaces, both bare integers);
 *   • the result is intersected with `wanted`, so a row for a player who is
 *     already priced cannot overwrite the tour's number, and a row for someone
 *     outside this week's field cannot be published at all. ESPN's "next
 *     event" is its own judgement and can be a different tournament than the
 *     one this endpoint is serving — a mismatch must fill nothing rather than
 *     quietly price the field from another week.
 */
export function pickGapOdds(rows, fieldSet, wanted) {
  const { oddsMap } = resolveOddsRows(rows, new Map(), fieldSet);
  const want = new NameSet(wanted);
  const odds = {};
  for (const [name, price] of Object.entries(oddsMap)) {
    const hit = want.resolve(name);
    if (hit) odds[hit] = price;
  }
  return odds;
}

/**
 * Prices for `wanted` (field players nobody has priced yet), or an empty map.
 * Never throws — a gap-filler that can take the endpoint down with it is worse
 * than the gap. Returns { odds, status } where status is this function's own
 * account of itself for ?debug=1.
 */
async function fetchESPNOdds(fieldSet, wanted) {
  try {
    // One day, not fifteen. This runs on every origin miss now that any
    // unpriced player triggers it, and a long scan against an ESPN that is
    // currently refusing us outright is pure latency inside a serverless
    // function that still has pgatour.com and a sportsbook to get through.
    // The bare scoreboard is the meaningful attempt — if ESPN serves this
    // function at all it returns the current event — so the dated scan is
    // kept only as a token retry.
    //
    // The field/tee-time fallback keeps its full 15-day range: if pgatour.com
    // ever fails, that scan is the only thing standing behind this endpoint.
    const trace = espnTrace();
    const found = await findESPNEvent(0, trace, 1);
    if (!found) return { odds: {}, status: `no-event (${espnTraceSummary(trace)})` };

    // The leaderboard first — it is already the payload the field fallback
    // reads, so when it carries prices this costs nothing extra.
    let rows = bookOddsRows(found.ld);

    // Otherwise the core API's odds collection for this event.
    if (!rows.length) {
      const id = found.event?.id;
      const comp = found.ld?.events?.[0]?.competitions?.[0]?.id || id;
      if (id) {
        const r = await fetch(
          `https://sports.core.api.espn.com/v2/sports/golf/leagues/pga/events/${id}/competitions/${comp}/odds`,
          { headers: ESPN_HEADERS });
        if (r.ok) rows = bookOddsRows(await r.json());
      }
    }
    if (!rows.length) return { odds: {}, status: 'no-rows' };

    const odds = pickGapOdds(rows, fieldSet, wanted);
    return { odds, status: `${rows.length} rows, filled ${Object.keys(odds).length}` };
  } catch (e) {
    return { odds: {}, status: `error: ${e.message}` };
  }
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
        let oddsNotInField = parsedField.oddsNotInField || [];
        let oddsPulled = parsedField.oddsPulled || [];

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

        // ── Odds: field page first, dedicated odds page to fill the gaps ────
        //
        // This used to consult the odds page only when the field page carried
        // NO odds at all (`if (!finalOdds.length)`). That gate reads "we have
        // odds" as "we have everyone's odds", and those are different things:
        // a field page that embeds a favourites-only promo rail satisfies it
        // with a handful of prices and suppresses the full board outright, so
        // every player outside the rail renders '—' with nothing to say why.
        //
        // The gate is now COVERAGE, and the bar is EVERYBODY. A first pass at
        // this used a half-the-field threshold, which is the same mistake in a
        // milder form: at the BMW Championship the field page priced 48 of 50
        // and comfortably cleared it, so the dedicated board was never asked
        // about the two it had missed. Any field player without a price is a
        // reason to ask.
        //
        // The cost of the stricter bar is one extra origin fetch on weeks
        // where a couple of players are genuinely unpriced. /api/field is
        // CDN-cached for five minutes and serves the whole league from one
        // origin hit, so that is a request every five minutes at worst.
        const fieldSet = new NameSet(players);
        const unpriced = (map) => {
          const priced = new NameSet(Object.keys(map));
          return players.filter(n => !priced.has(n));
        };
        let mergedOdds = { ...oddsMap };
        // Every branch below sets this. The whole fallback sits inside a
        // try/catch that swallows, and a step that can silently do nothing is
        // a step that cannot be debugged from the endpoint — which is the
        // trap this file keeps falling into. ?debug=1 reports it.
        let oddsPage = 'not-needed';
        if (players.length && unpriced(mergedOdds).length) {
          oddsPage = 'no-response';
          try {
            const oddsUrl = `https://www.pgatour.com/tournaments/${year}/${slug}/${tournament.tournamentId}/odds`;
            const oddsResp = await fetch(oddsUrl, { headers: HEADERS });
            oddsPage = oddsResp.ok ? 'no-next-data' : `http ${oddsResp.status}`;
            if (oddsResp.ok) {
              const oddsNd = extractNextData(await oddsResp.text());
              if (oddsNd) {
                oddsPage = 'no-rows';
                // Same two helpers as the field page. This path used to carry
                // its OWN market picker and its OWN row builder, and they had
                // already drifted: the field page took every market with naive
                // last-write-wins while this one took a single market, and only
                // this one knew about `oddsEnabled`. One code path now, so the
                // two cannot disagree about the same league again.
                const rows = collectOddsRows(oddsNd);
                const resolved = resolveOddsRows(rows, idToName, fieldSet);
                if (Object.keys(resolved.oddsMap).length) {
                  const before = unpriced(mergedOdds).length;
                  // Keys on both sides are the field's own spellings whenever
                  // the player is in the field, so this merge lines up rather
                  // than stacking two renderings of one golfer.
                  mergedOdds = { ...mergedOdds, ...resolved.oddsMap };
                  oddsUnresolved += resolved.unresolved;
                  oddsNotInField = [...new Set([...oddsNotInField, ...resolved.notInField])];
                  oddsPulled = resolved.pulled;
                  oddsPage = `${rows.length} rows, filled ${before - unpriced(mergedOdds).length}`;
                }
              }
            }
          } catch (e) { oddsPage = `error: ${e.message}`; }
        }

        // Still unpriced after both pgatour.com sources? Try the secondary
        // sources, book first — ESPN has been answering non-2xx to every
        // request from here, and the book is the source that might work.
        //
        // Both sit UNDER the tour: they only ever see the names the tour left
        // blank, and the spread order below keeps a tour price whatever
        // happens. Neither runs at all when there are no gaps.
        let oddsBook = 'not-needed';
        let oddsBookFilled = [];
        let oddsEspn = 'not-needed';
        let oddsEspnFilled = [];

        let stillMissing = players.length ? unpriced(mergedOdds) : [];
        if (stillMissing.length) {
          const book = await fetchBookOdds(fieldSet, stillMissing, tournament.name);
          oddsBook = book.status;
          oddsBookFilled = Object.keys(book.odds);
          mergedOdds = { ...book.odds, ...mergedOdds };
          stillMissing = unpriced(mergedOdds);
        }
        if (stillMissing.length) {
          const espnOdds = await fetchESPNOdds(fieldSet, stillMissing);
          oddsEspn = espnOdds.status;
          oddsEspnFilled = Object.keys(espnOdds.odds);
          mergedOdds = { ...espnOdds.odds, ...mergedOdds };
        }

        const finalOdds = Object.entries(mergedOdds).map(([name, odds]) => ({ name, odds }));
        // A player the field page listed without a price but another source
        // does price is not pulled. Recheck against the merged result.
        oddsPulled = oddsPulled.filter(n => !(n in mergedOdds));

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
            oddsNotInField,
            oddsPulled,
            oddsPage,
            oddsBook,
            oddsBookFilled,
            oddsEspn,
            oddsEspnFilled,
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
      // Odds rows that DID resolve to a name, but to a name nobody in this
      // week's field answers to. This is the other half of the same failure
      // and the half that used to be invisible: `oddsUnresolved` only counts
      // rows nothing could identify at all, so a row the book rendered
      // surname-only ('Spaun') sailed through as a junk map key and showed up
      // nowhere — while the golfer it was for kept their '—'.
      //
      // Read it beside fieldPlayersWithoutOdds below: a name here and its
      // owner there is a name problem on our end, and it is one Merge Players
      // or an alias row can fix.
      oddsNotInField: result.oddsNotInField || [],
      // Field players the book LISTS but has no price for — a suspended or
      // pulled market ('', 'OTB'), as opposed to a player the board omits
      // entirely. Both render '—' and they are NOT the same problem: a name in
      // here is upstream and not ours to fix, while a player in
      // fieldPlayersWithoutOdds who is NOT in here is a row we never saw, and
      // that is ours.
      oddsPulled: result.oddsPulled || [],
      // What the dedicated /odds page contributed. 'not-needed' means the
      // field page already priced every player in `players`; anything else is
      // this fallback's own account of itself, because it runs inside a
      // try/catch that swallows and used to leave no trace at all.
      oddsPage: result.oddsPage || null,
      // The ESPN gap-filler's account of itself, same vocabulary as oddsPage,
      // plus the players it actually priced. 'not-needed' means both
      // pgatour.com sources between them priced the whole field.
      // The sportsbook gap-filler's account of itself, per candidate URL, plus
      // the players it priced. Tried before ESPN. Repoint it without a deploy
      // by setting ODDS_BOOK_URLS — these are unofficial, geo-partitioned
      // endpoints and both the region prefix and the golf event-group id move.
      oddsBook: result.oddsBook || null,
      oddsBookFilled: result.oddsBookFilled || [],
      oddsEspn: result.oddsEspn || null,
      oddsEspnFilled: result.oddsEspnFilled || [],
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
