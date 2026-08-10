/**
 * firebase.js
 * ============================================================================
 * Drop-in replacement for supabase.js. Exports the exact same API surface so
 * no component code needs to change — only the import path.
 *
 * Import path to use everywhere (was '../api/firebase'):
 *   import { ... } from '../api/firebase';
 *
 * Firebase services used:
 *   • Firestore  — all league data (replaces every Supabase table)
 *   • No Firebase Auth — manager auth stays localStorage-based (unchanged)
 *   • No Firebase Storage — headshots still served from CDN / manual overrides
 *
 * Firestore collections → former Supabase tables:
 *   players            → /players/{name}
 *   app_metadata       → /app_metadata/{key}
 *   teams              → /teams/{id}
 *   tournaments        → /tournaments/{name}
 *   transactions       → /transactions/{txId|autoId}
 *   league_settings    → /league_settings/{key}
 *   draft_state        → /draft_state/default
 *   draft_picks        → /draft_picks/{autoId}
 *   sfgl_data          → /sfgl_data/{key}
 *
 * DEPRECATED: /liv_roster/ — LIV status now lives on /players/{name}.is_liv.
 * ============================================================================
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  getDocsFromCache,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  orderBy,
  where,
  limit,
  writeBatch,
  onSnapshot,
  deleteField,
} from 'firebase/firestore';

// ── Firestore handle ─────────────────────────────────────────────────────────
// Imported from ./_init.js, which is the one place the SDK is initialized —
// and which said so in its own header while this file quietly did it again.
//
// Both copies called `getApps().length ? getApps()[0] : initializeApp(config)`,
// so they resolved to the same underlying app; for a long time that made the
// duplicate look harmless. It stopped being harmless twice over:
//
//   • Only _init.js configures App Check, so whichever module the bundler
//     evaluated first won the initializeApp race, and whether App Check was
//     attesting before the first Firestore call came down to module evaluation
//     order — invisible, and liable to flip on any import change.
//   • _init.js now creates Firestore with an on-disk cache via
//     initializeFirestore, which THROWS if the instance already exists. A
//     getFirestore() here that won the race sent it down its fallback path and
//     silently turned persistence off.
//
// Importing makes the order a guarantee: ES modules evaluate their imports
// first, so _init.js (config, App Check, the persistent cache, auth) is fully
// initialized before a single line of this file runs.
//
// Re-exported because a great many modules import `db` from here.
import { db } from './_init.js';
export { db };

// ── Players collection: one read, many projections ───────────────────────────
// /players is the widest collection in the app (~700 docs) and five different
// things want to read all of it: the rankings list, the headshot map, the
// career-stats map, the duplicate-name index, and the alias map.
//
// They used to each issue their own getDocs(). Because useLeague's Tier-2
// loader fires the first three inside one Promise.all, a cold open read the
// whole collection THREE TIMES CONCURRENTLY — ~2,100 document reads and 3x the
// payload to build three views of identical data. upsertMany added a fourth
// and fifth read for the index + alias map, also concurrently.
//
// This is a single-flight coalescer, deliberately NOT a TTL cache. While a
// fetch is in flight, every additional caller joins it; the moment it settles
// the slot is cleared, so the next call after that goes to the network again.
// That collapses concurrent fan-out (the actual problem) without introducing
// any window in which a caller can be served stale data — which matters here,
// because App.jsx's headshot flow writes espn_ids via upsertMany and a
// subsequent getHeadshotsMap() must see them.
//
// Callers get their own array (slice) so an in-place sort/splice by one can't
// corrupt another's view. The element objects are shared and treated as
// read-only by every projection below.
let _playersInFlight = null;
async function _fetchAllPlayers() {
  const snap = await getDocs(collection(db, 'players'));
  return snap.docs.map(d => ({ _id: d.id, ...d.data() })).sort(_byWorldRank);
}
function readAllPlayers() {
  if (!_playersInFlight) {
    _playersInFlight = _fetchAllPlayers().finally(() => { _playersInFlight = null; });
  }
  return _playersInFlight.then(rows => rows.slice());
}

// ── Alias cache — maps alternate player names to canonical doc IDs ────────────
// Populated lazily from player docs that have an 'aliases' array field.
// Invalidated whenever aliases are written or a player is deleted.
//
// Derived from the shared read rather than its own where('aliases','!=',null)
// query: its only callers (upsertMany, clearEspnIds) resolve it in a
// Promise.all alongside getPlayerIndex, which needs the full collection
// anyway — so the filtered query was a second round trip for a subset of data
// the other half of the same Promise.all was already fetching. Same result:
// a doc with no aliases field contributes no entries either way.
let _aliasCache = null;
async function getAliasMap() {
  if (_aliasCache) return _aliasCache;
  try {
    const players = await readAllPlayers();
    const map = {};
    players.forEach(p => {
      (p.aliases || []).forEach(alias => { map[alias] = p._id; });
    });
    _aliasCache = map;
    return map;
  } catch (_) { return {}; }
}

// ── Existing-player index — resolves a name onto the doc that already
// represents that golfer ────────────────────────────────────────────────────
// Mirrors the same step in api/cron.js's OWGR sync, and exists for the same
// reason: writing a ranking under a spelling that differs from the existing
// doc ID creates a SECOND doc for one player. That is how the league ended up
// holding both 'Nico Echavarria' and 'Nicolas Echavarria' — one carrying the
// world rank and headshot, the other sitting on a roster, with nothing tying
// them together.
//
// The aliases arrays are hand-maintained through Merge Players, so they only
// ever covered spellings someone had already noticed. NameSet resolves the
// rest by identity, automatically.
//
// Cached like the alias map (and invalidated with it) so the extra collection
// read costs one round trip per session, not one per upsert.
let _playerIndexCache = null;
async function getPlayerIndex() {
  if (_playerIndexCache) return _playerIndexCache;
  try {
    const players = await readAllPlayers();
    _playerIndexCache = new NameSet(players.map(p => p._id));
  } catch (_) {
    _playerIndexCache = new NameSet([]);
  }
  return _playerIndexCache;
}

function invalidateAliasCache() { _aliasCache = null; _playerIndexCache = null; }

// Record doc IDs this session has just created or written, so the index stays
// truthful for the rest of the session.
//
// Without this, the index was a snapshot of the collection as it looked the
// first time anything asked — and upsertMany CREATES documents. The sequence
// that reintroduced the duplicate-player bug the index exists to prevent:
//
//   1. an OWGR sync upserts 'Nicolas Echavarria', creating the doc
//   2. the index still holds the pre-sync ID list, which has no Echavarria
//   3. the headshot flow later upserts 'Nico Echavarria' in the same session
//   4. resolve() misses, so a SECOND doc is minted for the same golfer
//
// Extending beats invalidating: dropping the cache would make the next upsert
// re-read all ~700 docs, and we already know exactly which names were written.
// A null cache is left null — it will be built from the collection, which by
// then includes these writes anyway.
function noteWrittenPlayerDocs(names) {
  if (!_playerIndexCache || !names.length) return;
  const known = _playerIndexCache.toArray();
  const fresh = names.filter(n => !_playerIndexCache.has(n));
  if (fresh.length) _playerIndexCache = new NameSet([...known, ...fresh]);
}

// ── Internal helpers ─────────────────────────────────────────────────────────

// Firestore rejects an undefined field value outright ("Unsupported field
// value: undefined"). Where a write REPLACES a document, an undefined value and
// an absent key mean the same thing, so dropping it is exact — not lossy.
// Merge writes are different and use deleteField() instead; see teamsApi.update.
const _withoutUndefined = (obj) => {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) if (v !== undefined) out[k] = v;
  return out;
};

/** Return all documents from a collection as an array of plain objects. */
async function _getAll(collectionName) {
  const snap = await getDocs(collection(db, collectionName));
  return snap.docs.map(d => ({ _id: d.id, ...d.data() }));
}

/** Return all documents ordered by a field. */
// ── Headshot id reading ─────────────────────────────────────────────────────
// A player doc's espn_id / pga_id must be a scalar the app can drop into a CDN
// URL. Two things can put something else there, and both render a URL that is
// syntactically fine and 404s for every player at once:
//   • an object — /api/headshots returns { espn, pga } per player, and a caller
//     that saved the whole response object instead of unpacking it wrote that
//     object into espn_id (see the note in admin/DataSyncPanel.jsx).
//   • the string "[object Object]" — the same corruption after a round trip
//     through a String() that has since been removed.
// readId returns null for both, so a corrupt doc reads as "no id known" and the
// client's /api/headshots auto-fetch refills it, rather than the app confidently
// requesting a broken URL forever.
function readId(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return (t && t !== '[object Object]') ? t : null;
}

// Pull usable { espn, pga } ids off a player doc, salvaging the real ids from
// docs whose espn_id holds the whole { espn, pga } response object — the real
// ids are sitting right there, so recovering them restores those players on the
// next load instead of making them wait for a rewrite.
function recoverIds(p) {
  const wrapped = (p?.espn_id && typeof p.espn_id === 'object') ? p.espn_id : null;
  return {
    espn: readId(wrapped ? wrapped.espn : p?.espn_id),
    pga:  readId(wrapped ? wrapped.pga  : p?.pga_id) || readId(p?.pga_id),
  };
}

// ── Cache-first reads ────────────────────────────────────────────────────────
// Firestore's persistent cache (see api/_init.js) makes a re-attached listener
// cheap — it resumes from a stored token and the server sends only what
// changed. It does NOT help a plain getDocs, which always goes to the server
// and is billed for every document it returns. So the four collections behind
// the app's load path were being paid for TWICE on every launch: once by
// getAll(), and again a moment later when useLeague attached its listener.
//
// This helper serves those reads from the on-disk copy when there is one. It is
// only safe for a collection with a LIVE onSnapshot listener behind it, because
// the listener is what makes the data correct — it lands within a second and
// reconciles anything that changed while this device was away. Do not use it
// for a one-shot read nobody is watching.
//
// Two escape hatches keep it honest:
//   • An empty cache falls through to the server, so a first-ever launch, a
//     cleared cache, or a browser with persistence unavailable all behave
//     exactly as before.
//   • Callers pass { fromServer: true } to opt out. Pull-to-refresh does (a
//     manual refresh should mean what it says), and so does useLeague if its
//     subscriptions fail to attach — which is the one path where nothing would
//     otherwise arrive to correct a stale cache. Note this means "ask the
//     server", not "fail without one": a plain getDocs still answers from the
//     cache when the device is offline, so pull-to-refresh out of signal range
//     shows the league rather than an error.
async function _getDocsCacheFirst(q, { fromServer = false } = {}) {
  if (!fromServer) {
    try {
      const cached = await getDocsFromCache(q);
      if (!cached.empty) return cached;
    } catch (_) {
      // No local copy yet, or the cache is unavailable — fall through.
    }
  }
  return getDocs(q);
}

async function _getAllOrdered(collectionName, field, dir = 'asc', opts = {}) {
  const q = query(collection(db, collectionName), orderBy(field, dir));
  const snap = await _getDocsCacheFirst(q, opts);
  return snap.docs.map(d => ({ _id: d.id, ...d.data() }));
}

// Rank for sorting: a finite number (accepting numeric strings, which some
// older docs carry), or null for "unranked".
function _rankOf(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Sort comparator for player docs — ranked ascending, UNRANKED LAST (never
// dropped), ties broken by name so the order is stable across loads.
function _byWorldRank(a, b) {
  const ra = _rankOf(a?.world_rank), rb = _rankOf(b?.world_rank);
  const nameA = String(a?.name || a?._id || ''), nameB = String(b?.name || b?._id || '');
  if (ra !== null && rb !== null) return (ra - rb) || nameA.localeCompare(nameB);
  if (ra !== null) return -1;
  if (rb !== null) return 1;
  return nameA.localeCompare(nameB);
}

/**
 * Wave-A subscribe helper: attaches an onSnapshot listener with consistent
 * error handling. Returns the unsubscribe function. Errors during snapshot
 * delivery are logged but never thrown — a transient Firestore error
 * shouldn't tear down the rest of the app.
 */
function _subscribeOrdered(collectionName, field, mapDocs, callback, dir = 'asc') {
  const q = query(collection(db, collectionName), orderBy(field, dir));
  return onSnapshot(
    q,
    (snap) => {
      try {
        const docs = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
        callback(mapDocs ? mapDocs(docs) : docs);
      } catch (e) {
        console.error(`[subscribe:${collectionName}] handler error:`, e);
      }
    },
    (err) => console.error(`[subscribe:${collectionName}] firestore error:`, err)
  );
}

// ── Transaction dedup (shared between getAll + subscribe) ───────────────────
// Same logic that's been in transactionsApi.getAll since the Supabase migration:
// • Prefer `txId` as the dedup key when present.
// • Fall back to a composite of (team, type, player, droppedPlayer,
//   tournamentIndex, status, segment) for legacy rows without a txId.
function _dedupeTransactions(rows) {
  const seen = new Set();
  const out = [];
  rows.forEach(tx => {
    if (tx.txId) {
      const k = 'txId:' + tx.txId;
      if (!seen.has(k)) { seen.add(k); out.push(tx); }
    } else {
      const k = [tx.team, tx.type, tx.player, tx.droppedPlayer, tx.tournamentIndex, tx.status, tx.segment].join('|');
      if (!seen.has(k)) { seen.add(k); out.push(tx); }
    }
  });
  return out;
}

// ============================================================================
// PLAYERS API
// ============================================================================
export const playersApi = {
  // Unordered fetch + JS sort by world_rank. NEVER orderBy('world_rank'): a
  // Firestore orderBy silently EXCLUDES every document that does not carry the
  // field, and player docs routinely don't —
  //   • headshotsApi.setAll -> upsertMany creates docs with only
  //     { name, espn_id, pga_id } when it first resolves a player;
  //   • DataSyncPanel's manual add deliberately leaves the rank to OWGR;
  //   • the OWGR sync only ranks the top ~600, so fringe/qualifier golfers
  //     who are very much rosterable never get one.
  // Every such doc was invisible to this query, so getHeadshotsMap() had no
  // entry for those players and they rendered as initials avatars no matter
  // how many times their ids were resolved and persisted. Same trap that was
  // already fixed for tournaments (see tournamentsApi.getAll / _byStartDate)
  // and in api/cron.js loadTournaments. Unranked players now sort last —
  // visible, never dropped.
  // Goes through readAllPlayers() so the three projections below —
  // getAllForApp / getHeadshotsMap / getStatsMap, which useLeague resolves in
  // one Promise.all — share a single collection read instead of issuing three.
  async getAll() {
    return readAllPlayers();
  },

  async getByName(name) {
    const snap = await getDoc(doc(db, 'players', name));
    return snap.exists() ? { _id: snap.id, ...snap.data() } : null;
  },

  // Get top N players by world rank, excluding LIV players
  async getTopRanked(n = 50) {
    // Fetch only as many docs as we need (plus a buffer for LIV/junk filtering)
    // rather than the entire ~700-doc collection every time. A caller that
    // genuinely wants the full list (e.g. searchByName passes n=700) still gets
    // it, since the cap is 700.
    const fetchLimit = Math.min(Math.max(n + 100, 200), 700);
    const rankedQ = query(
      collection(db, 'players'),
      orderBy('world_rank', 'asc'),
      limit(fetchLimit)
    );
    const rankedSnap = await getDocs(rankedQ);
    return rankedSnap.docs
      .map(d => ({
        name:        d.id,
        worldRank:   d.data().world_rank,
        espnId:      d.data().espn_id,
        headshotUrl: d.data().headshot_url,
        isLiv:       d.data().is_liv,
        aliases:     d.data().aliases || [],
      }))
      .filter(p => !p.isLiv && p.name && !/^\d+$/.test(p.name.trim()) && p.name.includes(' '))
      .slice(0, n);
  },

  // Search players by name prefix (case-sensitive Firestore range query)
  async searchByName(searchTerm, maxResults = 20) {
    if (!searchTerm || searchTerm.length < 2) return [];
    // Firestore prefix search is case-sensitive and only matches from the start of the doc ID.
    // We run two queries: one for the raw term (handles first-name prefix like "Ror"),
    // and one capitalized (handles "rory" -> "Rory"). Then we also fetch all ranked players
    // and filter client-side for last-name / substring matches.
    const capitalize = s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
    const makeRange = (term) => {
      const end = term.slice(0, -1) + String.fromCharCode(term.charCodeAt(term.length - 1) + 1);
      return query(collection(db, 'players'), orderBy('__name__'), where('__name__', '>=', term), where('__name__', '<', end), limit(maxResults));
    };

    const [snapRaw, snapCap] = await Promise.all([
      getDocs(makeRange(searchTerm)),
      getDocs(makeRange(capitalize(searchTerm))),
    ]);

    const seen = new Set();
    const results = [];
    const addDoc = d => {
      // d.id IS the canonical name (it's the doc ID we wrote it under).
      // No alias resolution needed.
      const name = d.id;
      if (!seen.has(name)) {
        seen.add(name);
        results.push({ name, worldRank: d.data().world_rank, espnId: d.data().espn_id, headshotUrl: d.data().headshot_url, isLiv: d.data().is_liv });
      }
    };
    snapRaw.docs.forEach(addDoc);
    snapCap.docs.forEach(addDoc);

    // Then a client-side substring/last-name pass over the SHARED players
    // snapshot (localStorage, 24h). This used to be getTopRanked(700) — a fresh
    // ~700-document read on every search, i.e. every time a manager typed a
    // name into add/drop on waiver day. The prefix queries above still run
    // against the server, so a player added to the collection since this
    // device's snapshot was built is still findable by first-name prefix.
    try {
      const allRanked = await playerRankingsApi.getAll();
      const lower = searchTerm.toLowerCase();
      (allRanked || []).forEach(p => {
        // Same rosterability filter getTopRanked applied, so this pass can't
        // start surfacing LIV players or junk name rows that it never did.
        if (!p?.name || p.isLiv) return;
        if (/^\d+$/.test(p.name.trim()) || !p.name.includes(' ')) return;
        if (!seen.has(p.name) && p.name.toLowerCase().includes(lower)) {
          seen.add(p.name);
          results.push(p);
        }
      });
    } catch (_) {}

    return results.slice(0, maxResults);
  },

  // Get specific players by name (for rostered players)
  async getByNames(names) {
    if (!names?.length) return [];
    // Firestore doesn't support IN queries on document IDs efficiently for large sets
    // Fetch individually but in parallel
    const results = await Promise.all(
      names.map(name => getDoc(doc(db, 'players', name))
        .then(snap => snap.exists() ? {
          name:        snap.id,
          worldRank:   snap.data().world_rank,
          espnId:   snap.data().espn_id,
          headshotUrl: snap.data().headshot_url,
          isLiv:       snap.data().is_liv,
        } : { name, worldRank: null, espnId: null, headshotUrl: null, isLiv: false })
        .catch(() => ({ name, worldRank: null, espnId: null, headshotUrl: null, isLiv: false }))
      )
    );
    return results;
  },

  async upsertMany(players) {
    // Resolve each incoming name onto the doc that already represents that
    // golfer, so a sync updates the existing player instead of minting a
    // duplicate under a different spelling. Precedence:
    //   1. explicit aliases array  — a deliberate commissioner decision
    //   2. identity match on an existing doc ID  — automatic
    //   3. the static alias groups — for a player with no doc yet
    const [aliasMap, playerIndex] = await Promise.all([getAliasMap(), getPlayerIndex()]);
    const written = [];
    const BATCH_SIZE = 499;
    for (let i = 0; i < players.length; i += BATCH_SIZE) {
      const batch = writeBatch(db);
      players.slice(i, i + BATCH_SIZE).forEach(p => {
        const canonicalName = aliasMap[p.name] || playerIndex.resolve(p.name) || resolveAlias(p.name);
        written.push(canonicalName);
        const row = { name: canonicalName };
        if (p.worldRank   !== undefined) row.world_rank   = p.worldRank ?? null;
        if (p.espnId      !== undefined && p.espnId !== null) row.espn_id = p.espnId;
        if (p.pgaId       !== undefined && p.pgaId  !== null) row.pga_id  = p.pgaId;
        if (p.headshotUrl !== undefined) row.headshot_url = p.headshotUrl ?? null;
        if (p.stats       !== undefined) row.career_stats = p.stats ?? {};
        if (p.isLiv       !== undefined) row.is_liv       = p.isLiv ?? false;
        batch.set(doc(db, 'players', canonicalName), row, { merge: true });
      });
      await batch.commit();
    }
    await setDoc(
      doc(db, 'app_metadata', 'players_last_updated'),
      { key: 'players_last_updated', value: Date.now().toString() }
    );
    // Docs this call may have created are now known to the index — see
    // noteWrittenPlayerDocs. Skipping this is what let a second upsert in the
    // same session mint a duplicate under an alternate spelling.
    noteWrittenPlayerDocs(written);
    return players;
  },

  async delete(name) {
    await deleteDoc(doc(db, 'players', name));
    invalidateAliasCache();
  },

  /**
   * Explicitly clears espn_id for the given player names. Used by the
   * admin "Rebuild Headshots" handler when a stale wrong ID is cached
   * (e.g. Alex Fitzpatrick getting Matt Fitzpatrick's ID). The regular
   * upsertMany path skips null/undefined espnId values to avoid
   * accidentally clearing during partial updates — this method is the
   * deliberate, explicit clear.
   */
  async clearEspnIds(names) {
    if (!Array.isArray(names) || names.length === 0) return;
    // Resolve the dynamic alias map first — this used to reference a bare
    // `aliasMap` that only exists inside upsertMany's scope, so every call
    // threw a ReferenceError before writing anything (i.e. the admin
    // "Rebuild Headshots" repair path silently never worked).
    const [aliasMap, playerIndex] = await Promise.all([getAliasMap(), getPlayerIndex()]);
    const written = [];
    const BATCH_SIZE = 250;
    for (let i = 0; i < names.length; i += BATCH_SIZE) {
      const batch = writeBatch(db);
      names.slice(i, i + BATCH_SIZE).forEach(name => {
        const canonicalName = aliasMap[name] || playerIndex.resolve(name) || resolveAlias(name);
        written.push(canonicalName);
        batch.set(doc(db, 'players', canonicalName), { espn_id: null }, { merge: true });
      });
      await batch.commit();
    }
    // set+merge on an unresolved name creates a doc here too, so the index has
    // to hear about it for the same reason it does in upsertMany.
    noteWrittenPlayerDocs(written);
  },

  // Add an alias to a player doc — e.g. addAlias('Nicolas Echavarria', 'Nico Echavarria')
  // After this, any OWGR sync writing 'Nico Echavarria' will update the 'Nicolas Echavarria' doc
  async addAlias(canonicalName, aliasName) {
    const ref = doc(db, 'players', canonicalName);
    const snap = await getDoc(ref);
    if (!snap.exists()) throw new Error(`Player "${canonicalName}" not found in Firebase`);
    const existing = snap.data().aliases || [];
    if (!existing.includes(aliasName)) {
      await updateDoc(ref, { aliases: [...existing, aliasName] });
    }
    invalidateAliasCache();
  },

  async update(name, updates) {
    const updateData = {};
    if (updates.worldRank  !== undefined) updateData.world_rank   = updates.worldRank;
    if (updates.espnId  !== undefined) updateData.espn_id  = updates.espnId;
    if (updates.pgaId   !== undefined) updateData.pga_id   = updates.pgaId;
    if (updates.headshotUrl !== undefined) updateData.headshot_url = updates.headshotUrl;
    if (updates.stats      !== undefined) updateData.career_stats  = updates.stats;
    if (updates.isLiv      !== undefined) updateData.is_liv        = updates.isLiv;
    await updateDoc(doc(db, 'players', name), updateData);
    return updateData;
  },

  async getAllForApp() {
    const players = await this.getAll();
    return players.map(p => {
      // Same scalar-only read as getHeadshotsMap — a corrupt object-valued id
      // must not reach an admin field or a CDN URL as "[object Object]".
      const { espn, pga } = recoverIds(p);
      return {
        name:        p.name,
        worldRank:   p.world_rank,
        espnId:      espn,
        pgaId:       pga,
        headshotUrl: p.headshot_url,
        stats:       p.career_stats,
        isLiv:       p.is_liv,
      };
    });
  },

  // NOTE: the app no longer reads headshots or stats through these two
  // methods — both now build their map from the shared, localStorage-cached
  // players snapshot (see headshotsApi.getAll / playerStatsApi.getAll), because
  // each call here is a full read of the ~700-document collection. They are
  // kept as the raw-document implementations for one-off/admin use; if you are
  // fixing headshot behaviour, fix it in headshotsApi.getAll, not here.

  // name -> { url?, espn?, pga? } — the shape utils/headshotUtils.js chains.
  // Previously returned a bare string (url OR espn id, whichever existed),
  // which meant a player could carry only one source and had nothing to fall
  // back to when that CDN 404'd. headshotUtils still accepts the old string
  // form, so nothing already persisted needs migrating.
  async getHeadshotsMap() {
    const players = await this.getAll();
    const map = {};
    players.forEach(p => {
      const entry = {};
      if (typeof p.headshot_url === 'string' && p.headshot_url.trim()) {
        entry.url = p.headshot_url.trim();
      }
      // espn_id / pga_id must be SCALARS. This used to be a bare
      // String(p.espn_id), which silently turned a malformed object-valued id
      // into the string "[object Object]" — a perfectly well-formed CDN URL
      // that 404s for every player. readId rejects anything that isn't a
      // usable scalar, and recoverIds salvages the real ids out of docs the
      // old DataSyncPanel corrupted, so those players resolve on the next load
      // instead of waiting to be rewritten.
      const { espn, pga } = recoverIds(p);
      if (espn) entry.espn = espn;
      if (pga)  entry.pga  = pga;
      if (Object.keys(entry).length > 0) map[p.name] = entry;
    });
    return map;
  },

  async getStatsMap() {
    const players = await this.getAll();
    const map = {};
    players.forEach(p => {
      if (p.career_stats && Object.keys(p.career_stats).length > 0) {
        map[p.name] = p.career_stats;
      }
    });
    return map;
  },

  async getLastUpdated() {
    const snap = await getDoc(doc(db, 'app_metadata', 'players_last_updated'));
    return snap.exists() ? snap.data().value : null;
  },

  async setLastUpdated(timestamp) {
    await setDoc(
      doc(db, 'app_metadata', 'players_last_updated'),
      { key: 'players_last_updated', value: timestamp }
    );
  },
};

// ============================================================================
// LEGACY API WRAPPERS  (identical surface to supabase.js)
// ============================================================================
import { resolveAlias, NameSet } from '../../api/_playerNames.js';


const PLAYER_CACHE_KEY = 'sfgl-player-cache';
const PLAYER_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

// In-flight de-dupe for the CACHED rankings projection. useLeague's Tier-2 load
// asks for rankings, headshots and stats in the SAME Promise.all — all three
// now resolve through getAll() below, and on a cold cache all three would find
// nothing in localStorage and each fire their own ~700-document query before
// the first one finished writing the cache. Sharing the promise makes
// concurrent callers ride a single query. Cleared as soon as it settles, so it
// never serves stale data.
//
// Distinct from _playersInFlight at the top of this file, which coalesces the
// raw /players getDocs behind readAllPlayers() — the alias map, the duplicate
// name index and the headshot map all ride that one. This layer sits above it
// and adds the 24-hour localStorage cache; both are wanted, they just needed
// telling apart.
let _rankingsInFlight = null;

export const playerRankingsApi = {
  // The one place the whole players collection is read. It is ~700 documents,
  // so it is cached in localStorage for 24 hours and shared by every consumer
  // (rankings, headshots, stats, add/drop search). Admin paths that change
  // player docs — the OWGR sync and the manual add in DataSyncPanel — call
  // invalidateCache() so their edits are visible immediately.
  async getAll() {
    // Try localStorage cache first — avoids 10k Firestore reads on every load
    try {
      const cached = localStorage.getItem(PLAYER_CACHE_KEY);
      if (cached) {
        const { players, timestamp } = JSON.parse(cached);
        if (Date.now() - timestamp < PLAYER_CACHE_TTL && players?.length) {
          return players;
        }
      }
    } catch (_) {}

    // Cache miss or expired — fetch from Firestore (one query, however many
    // callers are waiting on it).
    if (!_rankingsInFlight) {
      _rankingsInFlight = playersApi.getAllForApp()
        .then(players => {
          try {
            localStorage.setItem(PLAYER_CACHE_KEY, JSON.stringify({ players, timestamp: Date.now() }));
          } catch (_) {}
          return players;
        })
        .finally(() => { _rankingsInFlight = null; });
    }
    return _rankingsInFlight;
  },
  async invalidateCache() {
    try { localStorage.removeItem(PLAYER_CACHE_KEY); } catch (_) {}
  },
  async updateAll(players) { return playersApi.upsertMany(players); },
  async getLastUpdated()   { return playersApi.getLastUpdated(); },
  async setLastUpdated(ts) { return playersApi.setLastUpdated(ts); },
};

export const headshotsApi = {
  // Built from the SHARED players snapshot (localStorage, 24h) rather than its
  // own full read of the collection. This used to call getHeadshotsMap(), which
  // re-read all ~700 player documents — and it ran in the same Promise.all as
  // the stats map, which did the same thing, and the rankings load, which did
  // it a third time. Three full reads of one collection on every cold start.
  //
  // Staleness is a non-issue here specifically: App.jsx re-resolves every
  // rostered player through /api/headshots on each launch and merges the ids
  // over whatever this returns, so a newly-resolved id shows up immediately
  // regardless of the cache, and the commissioner's headshot_url pins land via
  // DataSyncPanel, which invalidates the cache when it writes.
  async getAll() {
    const players = await playerRankingsApi.getAll();
    const map = {};
    (players || []).forEach(p => {
      if (!p?.name) return;
      const entry = {};
      // espnId/pgaId arrive already scrubbed by getAllForApp -> recoverIds, so
      // a corrupt object-valued id can't reach a CDN URL as "[object Object]".
      if (typeof p.headshotUrl === 'string' && p.headshotUrl.trim()) entry.url = p.headshotUrl.trim();
      if (p.espnId) entry.espn = p.espnId;
      if (p.pgaId)  entry.pga  = p.pgaId;
      if (Object.keys(entry).length > 0) map[p.name] = entry;
    });
    return map;
  },

  /**
   * Wave A fix: previously a deprecated no-op that just `console.warn`-ed.
   * useLeague.updateHeadshots was calling this on every headshot update,
   * which meant the centralized persistence path never wrote to Firebase —
   * headshots only landed in the DB through the explicit playersApi.upsertMany
   * call in App.jsx. If that explicit call ever got skipped, the headshot
   * was lost on next load.
   *
   * Now setAll properly persists. Accepts either a map { name: espnId } (the
   * shape useLeague passes) or an array of { name, espnId } objects.
   */
  async setAll(map) {
    if (!map) return;
    let entries;
    // Accepts an array of { name, espnId, pgaId } or a map of
    // name -> { espn?, pga?, url? } | legacy bare espn-id string.
    if (Array.isArray(map)) {
      entries = map
        .filter(p => p && p.name && (p.espnId || p.pgaId))
        .map(p => ({ name: p.name, espnId: p.espnId, pgaId: p.pgaId }));
    } else if (typeof map === 'object') {
      entries = Object.entries(map)
        .map(([name, v]) => {
          if (!name || !v) return null;
          if (typeof v === 'string') return { name, espnId: v };
          return { name, espnId: v.espn, pgaId: v.pga };
        })
        .filter(e => e && (e.espnId || e.pgaId));
    } else {
      return;
    }
    if (!entries.length) return;
    return playersApi.upsertMany(entries);
  },
};

export const playerStatsApi = {
  // Also built from the shared players snapshot — see headshotsApi.getAll.
  // career_stats is written by admin tooling only, never during normal play, so
  // reading it from a snapshot up to a day old changes nothing on screen.
  async getAll() {
    const players = await playerRankingsApi.getAll();
    const map = {};
    (players || []).forEach(p => {
      if (p?.name && p.stats && Object.keys(p.stats).length > 0) map[p.name] = p.stats;
    });
    return map;
  },
  async set(playerName, stats){ return playersApi.update(playerName, { stats }); },
  async setAll(_obj)          { console.warn('playerStatsApi.setAll is deprecated'); },
};

// ============================================================================
// TEAMS API
// ============================================================================
export const teamsApi = {
  // Cache-first (see _getDocsCacheFirst) — teamsApi.subscribe() below is the
  // live listener that keeps it honest. Pass { fromServer: true } to force it.
  async getAll(opts = {}) {
    const teams = await _getAllOrdered('teams', 'name', 'asc', opts);
    // Ensure every team has a lineup array — older documents may not have one
    return teams.map(t => ({ ...t, lineup: t.lineup || [] }));
  },

  /**
   * Upsert ONLY the given team docs. Never touches docs that aren't in the
   * list and never deletes anything. This is the normal persistence path for
   * roster/lineup edits: a manager's save writes exactly the team(s) they
   * changed, so a concurrent manager's edit to a DIFFERENT team can't be
   * reverted by this client's possibly-stale copy of it.
   */
  async upsertMany(teams) {
    if (!Array.isArray(teams) || teams.length === 0) return teams || [];
    const BATCH_SIZE = 499;
    for (let i = 0; i < teams.length; i += BATCH_SIZE) {
      const batch = writeBatch(db);
      teams.slice(i, i + BATCH_SIZE).forEach(team => {
        const id = team.id || team.name;
        // set() without merge replaces the document, so a key the caller
        // dropped is already gone. An undefined VALUE means the same thing —
        // and Firestore rejects it outright — so it is stripped rather than
        // sent.
        batch.set(doc(db, 'teams', id), _withoutUndefined(team));
      });
      await batch.commit();
    }
    return teams;
  },

  /**
   * FULL-COLLECTION REPLACE — reserved for explicit commissioner bulk
   * operations (season import / restore). Upserts every local doc, then
   * deletes any remote doc not in the local set. Do NOT use this for
   * ordinary roster/lineup edits: it persists the caller's entire in-memory
   * array, so a stale copy silently reverts other managers' concurrent
   * changes. Ordinary edits go through upsertMany/update (see
   * useLeague.updateTeams / updateTeam).
   */
  async setAll(teams) {
    if (!Array.isArray(teams)) return [];
    const snap = await getDocs(collection(db, 'teams'));
    const remoteIds = new Set(snap.docs.map(d => d.id));
    const localIds = new Set(teams.map(t => t.id || t.name));

    await this.upsertMany(teams);
    // Delete any remote docs that no longer exist locally
    const toDelete = [...remoteIds].filter(id => !localIds.has(id));
    if (toDelete.length) {
      const batch = writeBatch(db);
      toDelete.forEach(id => batch.delete(doc(db, 'teams', id)));
      await batch.commit();
    }
    return teams;
  },

  // set+merge (not updateDoc) so a patch also succeeds if the doc is missing
  // (e.g. a team created on another device that hasn't synced here yet).
  async update(teamId, updates) {
    // A merge write cannot express "remove this field" by omission — omission
    // is exactly what merge preserves. The app clears a field by setting it to
    // undefined (`backup: picked || undefined`), which Firestore refuses as a
    // value, so it is translated to the deleteField sentinel that means it.
    // Before this, useLeague's change detection dropped those keys before they
    // reached here, so the clear only ever happened in local state.
    const payload = {};
    for (const [k, v] of Object.entries(updates || {})) {
      payload[k] = v === undefined ? deleteField() : v;
    }
    await setDoc(doc(db, 'teams', teamId), payload, { merge: true });
    return updates;
  },

  /**
   * Rename a team AND re-key every transaction that referenced it by name.
   *
   * ── Why this can't be a plain field update ──────────────────────────────
   * Transactions identify their team by NAME (`tx.team`), not by id. Managers
   * can rename their own team from the Account sheet. Before this existed, a
   * rename was written as an ordinary team-doc patch, which silently cut that
   * team loose from its entire history:
   *
   *   • buildEffectiveRoster filters `tx.team === team.name`, so every
   *     add/drop the team had ever made stopped replaying — dropped players
   *     came back and added players disappeared from the roster;
   *   • the fee panel, the swing pot and the swing award stopped counting
   *     their fees;
   *   • pending waiver claims vanished from the Rosters page, and the
   *     commish's waiver panel could no longer resolve the claiming team;
   *   • the cron's waiver processing (which does the same name match) skipped
   *     them entirely.
   *
   * All of that failed silently, and only for the team that renamed.
   *
   * ── Ordering ────────────────────────────────────────────────────────────
   * Transactions are re-keyed FIRST, the team doc LAST. Firestore batches are
   * atomic individually but a >500-op rename needs several, so the failure
   * mode matters: if a transaction batch fails, the team still carries its old
   * name and the rows already rewritten are the orphans. Renaming the team
   * first would orphan EVERY not-yet-rewritten row instead. Either way the
   * write is retried by the caller; this ordering just makes a partial failure
   * as small as possible.
   *
   * Belt and braces: new transactions also carry a stable `teamId` (see
   * txBelongsToTeam in sharedHelpers), so rows written from here on are
   * rename-proof even if this re-key never runs.
   */
  async rename(teamId, newName) {
    const trimmed = String(newName || '').trim();
    if (!trimmed) throw new Error('Team name cannot be empty.');

    const teamsSnap = await getDocs(collection(db, 'teams'));
    const teams = teamsSnap.docs.map(d => ({ _id: d.id, ...d.data() }));
    const target = teams.find(t => (t.id || t._id) === teamId);
    if (!target) throw new Error(`Unknown team "${teamId}".`);

    const oldName = target.name;
    if (oldName === trimmed) return { transactionsUpdated: 0 };

    // A duplicate name is worse than the rename it replaces: every
    // `teams.find(t => t.name === ...)` in the app would resolve to whichever
    // team happens to come first, and the two teams' transactions would merge.
    const collision = teams.find(t => (t.id || t._id) !== teamId && t.name === trimmed);
    if (collision) throw new Error(`Another team is already called "${trimmed}".`);

    const txSnap = await getDocs(query(collection(db, 'transactions'), where('team', '==', oldName)));
    const targets = txSnap.docs;

    const BATCH_SIZE = 499;
    for (let i = 0; i < targets.length; i += BATCH_SIZE) {
      const batch = writeBatch(db);
      targets.slice(i, i + BATCH_SIZE).forEach(d => {
        // Stamp teamId while we're here so this row never needs re-keying again.
        batch.update(d.ref, { team: trimmed, teamId });
      });
      await batch.commit();
    }

    await setDoc(doc(db, 'teams', teamId), { name: trimmed }, { merge: true });
    return { transactionsUpdated: targets.length };
  },

  /**
   * Wave A fix: real-time subscription. useLeague has been calling this
   * since the Wave 8 changes, but no implementation existed — every call
   * threw silently and the subscription block in useLeague was a no-op.
   * Now wired through onSnapshot. Returns the unsubscribe function.
   */
  subscribe(callback) {
    return _subscribeOrdered('teams', 'name', (docs) =>
      docs.map(t => ({ ...t, lineup: t.lineup || [] })),
      callback
    );
  },
};

// ============================================================================
// TOURNAMENTS API
// ============================================================================
// ── Tournament ordering (start_date is ORDERING-ONLY; the visible date is the
// `dates` string). We sort in JS rather than via Firestore orderBy('start_date')
// because orderBy SILENTLY DROPS any doc missing the field — which is exactly
// what left the whole collection reading as empty (docs had no start_date), so
// the client fell back to the legacy sfgl_data doc and the cron saw nothing.
// Sorting in JS keeps every doc; a doc missing start_date sorts LAST (visible,
// never dropped), tie-broken by name for stability.
const _byStartDate = (a, b) => {
  const sa = a.start_date || '', sb = b.start_date || '';
  if (sa && sb) return sa < sb ? -1 : sa > sb ? 1 : (a.name || '').localeCompare(b.name || '');
  if (sa) return -1;
  if (sb) return 1;
  return (a.name || '').localeCompare(b.name || '');
};

// Guarantee every tournament carries an ordering start_date that is monotonic
// with array order. Preserves existing valid, in-order dates; fills gaps or
// out-of-order entries with a synthetic weekly step. This closes the write-side
// hole that created docs with no start_date in the first place.
const _START_DATE_ANCHOR = '2025-01-06';
const _ensureStartDates = (arr) => {
  let cursor = null;
  return arr.map((t) => {
    const sd = (typeof t.start_date === 'string' && t.start_date) ? t.start_date : null;
    if (sd && (cursor === null || sd > cursor)) { cursor = sd; return t; }
    let next;
    if (cursor === null) next = _START_DATE_ANCHOR;
    else { const d = new Date(cursor + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 7); next = d.toISOString().slice(0, 10); }
    cursor = next;
    return { ...t, start_date: next };
  });
};

export const tournamentsApi = {
  // Cache-first — tournamentsApi.subscribe() is the live listener behind it.
  async getAll(opts = {}) {
    // Unordered fetch + JS sort (see _byStartDate). Never orderBy('start_date').
    const snap = await _getDocsCacheFirst(collection(db, 'tournaments'), opts);
    const docs = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
    // GUARD: if any doc lacks start_date, a JS sort would fall back to
    // alphabetical and scramble the schedule — which corrupts activeTournamentIndex
    // and roster replay (the incident this guards against). Fail SAFE by using the
    // legacy doc's chronological array order instead, and fail LOUD in the console.
    const missing = docs.filter(t => !t.start_date).length;
    if (docs.length > 0 && missing > 0) {
      console.error(`[tournamentsApi.getAll] ${missing}/${docs.length} tournaments missing start_date — NOT alphabetizing (would scramble rosters). Falling back to legacy chronological order. Fix start_date.`);
      try {
        const legacy = await sfglDataApi.get('fantasy-golf-tournaments');
        if (Array.isArray(legacy) && legacy.length > 0) return legacy;
      } catch (e) { console.error('[tournamentsApi.getAll] legacy fallback failed:', e); }
      console.error('[tournamentsApi.getAll] No legacy fallback available; returning Firestore order UNSORTED. Populate start_date immediately.');
      return docs;
    }
    return docs.sort(_byStartDate);
  },

  async setAll(tournaments) {
    // Same Wave A hotfix as teamsApi.setAll — see comment there. Real-time
    // subscriptions made the delete-all-then-insert pattern emit transient
    // empty / partial snapshots that clobbered local state mid-write.
    if (!Array.isArray(tournaments)) return [];
    // Guarantee an ordering start_date on every tournament before writing, so a
    // doc can never again be created without one (which is what broke reads).
    tournaments = _ensureStartDates(tournaments);
    const snap = await getDocs(collection(db, 'tournaments'));
    const remoteIds = new Set(snap.docs.map(d => d.id));
    const localIds = new Set(tournaments.map(t => t.name || t.id));

    const BATCH_SIZE = 499;
    for (let i = 0; i < tournaments.length; i += BATCH_SIZE) {
      const batch = writeBatch(db);
      tournaments.slice(i, i + BATCH_SIZE).forEach(t => {
        const id = t.name || t.id;
        batch.set(doc(db, 'tournaments', id), { ...t });
      });
      await batch.commit();
    }
    const toDelete = [...remoteIds].filter(id => !localIds.has(id));
    if (toDelete.length) {
      const batch = writeBatch(db);
      toDelete.forEach(id => batch.delete(doc(db, 'tournaments', id)));
      await batch.commit();
    }
    // Keep the legacy sfgl_data/fantasy-golf-tournaments doc in sync on every
    // write so the load-cascade fallback (and any legacy reader) can never drift
    // from canonical again. Best-effort: a legacy failure must not fail the
    // canonical write that already succeeded above.
    try { await sfglDataApi.set('fantasy-golf-tournaments', tournaments); }
    catch (e) { console.error('[tournamentsApi.setAll] legacy sync failed:', e); }
    return tournaments;
  },

  async update(tournamentName, updates) {
    await updateDoc(doc(db, 'tournaments', tournamentName), updates);
    return updates;
  },

  /**
   * Wave A fix: real-time subscription via onSnapshot.
   */
  subscribe(callback) {
    // Unordered onSnapshot + JS sort — same reason as getAll: orderBy would
    // drop docs missing start_date and emit an empty snapshot. Same fail-safe
    // guard as getAll: never alphabetize a start_date-less set.
    return onSnapshot(
      collection(db, 'tournaments'),
      async (snap) => {
        try {
          const docs = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
          const missing = docs.filter(t => !t.start_date).length;
          if (docs.length > 0 && missing > 0) {
            console.error(`[subscribe:tournaments] ${missing}/${docs.length} missing start_date — NOT alphabetizing. Falling back to legacy chronological order.`);
            try {
              const legacy = await sfglDataApi.get('fantasy-golf-tournaments');
              if (Array.isArray(legacy) && legacy.length > 0) { callback(legacy); return; }
            } catch (e) { console.error('[subscribe:tournaments] legacy fallback failed:', e); }
            callback(docs); // unsorted, already warned
            return;
          }
          callback(docs.sort(_byStartDate));
        } catch (e) { console.error('[subscribe:tournaments] handler error:', e); }
      },
      (err) => console.error('[subscribe:tournaments] firestore error:', err)
    );
  },
};

// ============================================================================
// TRANSACTIONS API
// ============================================================================
// Timestamp is a number (Date.now()) at every creation site today, but legacy
// rows may carry a date string, or neither. Rows with no resolvable time sort
// last (desc).
const _txTimeMs = (tx) => {
  if (typeof tx.timestamp === 'number') return tx.timestamp;
  const raw = tx.timestamp || tx.date;
  const ms = raw ? new Date(raw).getTime() : NaN;
  return Number.isNaN(ms) ? 0 : ms;
};
const _byTimestampDesc = (a, b) => _txTimeMs(b) - _txTimeMs(a);

export const transactionsApi = {
  // Cache-first — transactionsApi.subscribe() is the live listener behind it.
  // This is the collection that benefits most: it only grows across the season,
  // and it was being read in full twice on every launch.
  async getAll(opts = {}) {
    // Unordered fetch + JS sort. Never orderBy('timestamp'): Firestore orderBy
    // silently omits docs missing the ordered field, so legacy rows without a
    // timestamp would vanish from every read (same failure mode as the
    // start_date incident — see tournamentsApi.getAll and utils/swingAward.js).
    const snap = await _getDocsCacheFirst(collection(db, 'transactions'), opts);
    const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return _dedupeTransactions(data.sort(_byTimestampDesc));
  },

  async getById(id) {
    if (!id) return null;
    const snap = await getDoc(doc(db, 'transactions', id));
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
  },

  async add(transaction) {
    const ref = await addDoc(collection(db, 'transactions'), transaction);
    return [{ id: ref.id, ...transaction }];
  },

  async setAll(transactions) {
    return this.sync(transactions);
  },

  /**
   * Upsert-only sync: inserts new local transactions and updates changed ones.
   * NEVER deletes. It used to infer deletion from absence (any remote doc
   * missing from the caller's array was removed), so a stale client — snapshot
   * lag, or the localStorage fallback in useLeague — saving any transaction
   * permanently deleted other managers' recent transactions. Deletion is now
   * only ever explicit, via transactionsApi.delete() from the UI's
   * delete/undo flows.
   */
  async sync(localTransactions) {
    const snap = await getDocs(collection(db, 'transactions'));
    const remote = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    const remoteByTxId = new Map();
    const remoteById   = new Map();
    remote.forEach(tx => {
      if (tx.txId) remoteByTxId.set(tx.txId, tx);
      if (tx.id)   remoteById.set(tx.id, tx);
    });

    const toInsert = [];
    const toUpdate = [];

    // Wave J Round 6 follow-up: added 'amount' and 'note' to support
    // swing_winner transactions. Previously these were silently stripped
    // during sync, causing swing_winner rows to display +$0 instead of the
    // actual pot amount. Adding them is backwards-compatible — older rows
    // without these fields aren't affected.
    // 'teamId' is the stable companion to 'team'. Transactions identify their
    // team by NAME, which managers can change; teamId is the immutable key, and
    // omitting it from this list would have sync() silently strip it back off
    // every row it touched.
    const validCols = ['team','teamId','type','player','droppedPlayer','status','fee','segment',
                       'priority','timestamp','processedDate','failReason','txId',
                       'tournamentIndex','tournament','date','amount','note'];

    localTransactions.forEach(tx => {
      const r = (tx.txId && remoteByTxId.get(tx.txId)) ||
                (tx.id   && remoteById.get(tx.id)) || null;
      if (r) {
        // Diff EVERY valid column — not just status/failReason/priority, which
        // silently reverted commissioner edits to team/player/droppedPlayer/
        // fee/tournament/amount/note. A field cleared locally (e.g. failReason
        // when a blocked waiver is re-queued) is deleted remotely.
        const changes = {};
        validCols.forEach(c => {
          if (tx[c] !== r[c]) {
            changes[c] = tx[c] !== undefined ? tx[c] : deleteField();
          }
        });
        if (Object.keys(changes).length > 0) toUpdate.push({ id: r.id, changes });
      } else if (!tx.id) {
        const row = {};
        validCols.forEach(c => { if (tx[c] !== undefined) row[c] = tx[c]; });
        toInsert.push(row);
      }
      // tx.id set but doc gone remotely: another manager deleted it — don't
      // resurrect it.
    });

    // Batch inserts
    if (toInsert.length > 0) {
      const BATCH_SIZE = 499;
      for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
        const batch = writeBatch(db);
        toInsert.slice(i, i + BATCH_SIZE).forEach(row => {
          batch.set(doc(collection(db, 'transactions')), row);
        });
        await batch.commit();
      }
    }

    // Individual updates (changed fields only, preserving ids)
    for (const u of toUpdate) {
      await updateDoc(doc(db, 'transactions', u.id), u.changes).catch(e =>
        console.error('[transactionsApi.sync] update error:', e)
      );
    }

    return localTransactions;
  },

  /**
   * Explicit deletion — the ONLY path that removes transaction docs.
   * Accepts one or many transactions (or bare id/txId strings). Matches remote
   * docs by doc id OR txId, so rows created locally (txId only, no doc id yet)
   * and rows fetched from Firestore (doc id) both resolve; txId matching also
   * sweeps up any duplicate docs sharing the same txId.
   */
  async delete(txsOrKeys) {
    const list = (Array.isArray(txsOrKeys) ? txsOrKeys : [txsOrKeys]).filter(Boolean);
    const keys = new Set();
    list.forEach(t => {
      if (typeof t === 'string') { keys.add(t); return; }
      if (t.id)   keys.add(t.id);
      if (t.txId) keys.add(t.txId);
    });
    if (keys.size === 0) return 0;

    const snap = await getDocs(collection(db, 'transactions'));
    const targets = snap.docs.filter(d => keys.has(d.id) || (d.data().txId && keys.has(d.data().txId)));

    const BATCH_SIZE = 499;
    for (let i = 0; i < targets.length; i += BATCH_SIZE) {
      const batch = writeBatch(db);
      targets.slice(i, i + BATCH_SIZE).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
    return targets.length;
  },

  /**
   * Wave A fix: real-time subscription via onSnapshot. Applies the same
   * dedup logic that getAll() uses so subscribers and direct fetchers see
   * identical shapes. Unordered snapshot + JS sort — same reason as getAll:
   * orderBy('timestamp') drops docs missing the field.
   */
  subscribe(callback) {
    return onSnapshot(
      collection(db, 'transactions'),
      (snap) => {
        try {
          // Ignore an empty snapshot that is NOT server-confirmed.
          //
          // Honest note on why this is written the way it is. The listeners for
          // teams/tournaments/settings in useLeague carry a blunt length>0
          // guard, against a reconnect emitting a spurious empty snapshot. That
          // was never reproduced here: across a cold cache, three
          // disconnect/reconnect cycles and a visibility change, this listener
          // handed the app nothing but the real row count. So treat this line
          // as insurance, not as a fix for an observed bug.
          //
          // What it must NOT do is copy that blunt guard, because transactions
          // are the one collection that can legitimately be empty — a new
          // season, or an undo of the season's only waiver. Keying on
          // metadata.fromCache means a real, server-confirmed deletion still
          // propagates to everyone else's screen; only an unconfirmed empty is
          // dropped. A length>0 guard would leave a deleted row showing on
          // every other manager's phone, which is worse than what it prevents.
          if (snap.empty && snap.metadata.fromCache) return;
          const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
          callback(_dedupeTransactions(data.sort(_byTimestampDesc)));
        } catch (e) {
          console.error('[subscribe:transactions] handler error:', e);
        }
      },
      (err) => console.error('[subscribe:transactions] firestore error:', err)
    );
  },
};

// ============================================================================
// SETTINGS API
// ============================================================================
export const settingsApi = {
  async get(key) {
    const snap = await getDoc(doc(db, 'league_settings', key));
    return snap.exists() ? snap.data().value : undefined;
  },

  async set(key, value) {
    await setDoc(doc(db, 'league_settings', key), { key, value });
    return [{ key, value }];
  },

  /**
   * Write several settings in one atomic batch.
   *
   * useLeague used to loop `await set(key, value)` over the WHOLE settings
   * object on every save — roughly twenty sequential round trips to change one
   * checkbox, each one landing separately. The collection has a live
   * onSnapshot subscription, so every one of those writes also emitted a fresh
   * settings object to the whole app: twenty renders, and twenty chances for a
   * reader to observe a half-applied save. A batch commits once and emits once.
   *
   * @param {Object} entries {key: value} — only the keys you intend to write
   */
  async setMany(entries) {
    const pairs = Object.entries(entries || {});
    if (!pairs.length) return [];
    const BATCH_SIZE = 499;
    for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
      const batch = writeBatch(db);
      pairs.slice(i, i + BATCH_SIZE).forEach(([key, value]) => {
        batch.set(doc(db, 'league_settings', key), { key, value });
      });
      await batch.commit();
    }
    return pairs.map(([key, value]) => ({ key, value }));
  },

  // Cache-first — settingsApi.subscribe() is the live listener behind it.
  async getAll(opts = {}) {
    const snap = await _getDocsCacheFirst(collection(db, 'league_settings'), opts);
    const settings = {};
    snap.docs.forEach(d => { settings[d.data().key] = d.data().value; });
    return settings;
  },

  /**
   * Wave A fix: real-time subscription. Emits the full {key: value} settings
   * object whenever any league_settings doc changes — same shape as getAll().
   */
  subscribe(callback) {
    return onSnapshot(
      collection(db, 'league_settings'),
      (snap) => {
        try {
          const settings = {};
          snap.docs.forEach(d => { settings[d.data().key] = d.data().value; });
          callback(settings);
        } catch (e) {
          console.error('[subscribe:league_settings] handler error:', e);
        }
      },
      (err) => console.error('[subscribe:league_settings] firestore error:', err)
    );
  },
};

// ============================================================================
// DRAFT APIs — REMOVED
// ============================================================================
// draftStateApi and draftPicksApi existed solely to serve src/pages/DraftModal.jsx,
// which was deleted as dead code (it had no importers — App.jsx's comment
// claiming it was a transitive dependency of AdminView was stale). The
// /draft_state and /draft_picks Firestore collections are left untouched; if
// the draft UI is rebuilt for a future season, restore these from git history.

// ============================================================================
// TOURNAMENT RESULTS API — FROZEN ARCHIVE, READ ONLY
// Document ID: `${tournamentName}__${season}`  (double-underscore separator)
// ============================================================================
// Nothing writes this collection. `save` lost its last caller some time ago,
// and both the client (TournamentResultsPanel) and the cron
// (handleProcessResults) now write results onto the tournament document
// itself — /tournaments/{name}.results — which carries the same payload:
// teams, earningsMap, roundLeaders, fullLineups, rosterSnapshots.
//
// So this is not a second source of truth so much as a fossil of one. It is
// still read, once, by App.jsx's recovery pass, purely to fill a gap for any
// event whose embedded results were lost before the write moved. It can never
// overwrite a tournament that already has results.
//
// The dead half of the surface — save, getByName, deleteByName,
// deleteAllForSeason — has been removed. Leaving a `save` nobody calls sitting
// next to a `getAllForSeason` everybody calls is what makes a frozen
// collection look live, and invites the next person to write to it again and
// re-create the split.
//
// scripts/audit-tournament-results.mjs reports whether the archive still holds
// anything /tournaments does not. Once it reports clean, this API and the
// recovery step in App.jsx can both go, and results will have exactly one home.
// tournament_results — REMOVED.
//
// A frozen archive with no writer: tournamentResultsApi.save lost its last
// caller some time ago, and results live on the tournament document itself
// (/tournaments/{name}.results). App.jsx read this collection once at load as
// a one-way backstop for events whose embedded copy predated that change.
//
// scripts/audit-tournament-results.mjs compared the two against production and
// reported CLEAN: no archive-only results, none disagreeing, none orphaned —
// zero documents for the season at all. So the read and this API are gone, and
// results have exactly one home.

// ============================================================================
// SFGL DATA API  (generic key-value store — replaces sfgl_data table)
// ============================================================================
export const sfglDataApi = {
  async get(key) {
    const snap = await getDoc(doc(db, 'sfgl_data', key));
    return snap.exists() ? snap.data().value : null;
  },

  async set(key, value) {
    await setDoc(doc(db, 'sfgl_data', key), { key, value });
  },

  async getMany(keys) {
    const results = await Promise.all(keys.map(k => this.get(k)));
    const map = {};
    keys.forEach((k, i) => { map[k] = results[i]; });
    return map;
  },
};

// ============================================================================
// GLOBAL PLAYER STATS API
// ============================================================================
export const globalPlayerStatsApi = {
  async get()         { return (await sfglDataApi.get('fantasy-golf-global-stats')) || {}; },
  async set(stats)    { await sfglDataApi.set('fantasy-golf-global-stats', stats); },
};

// ============================================================================
// PLAYER REGISTRY API
// ============================================================================
// Durable single source of truth for per-player SFGL attributes (limited,
// unlimited, stars, yearsOfService, and career tallies). Survives drop/re-add,
// so a limited player can never come back unlimited or lose their data.
// Populated + persisted by useLeague at load and on every team save.
export const playerRegistryApi = {
  async get()      { return (await sfglDataApi.get('player-registry')) || {}; },
  async set(reg)   { await sfglDataApi.set('player-registry', reg); },
};
