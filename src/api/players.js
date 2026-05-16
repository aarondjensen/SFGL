// src/api/players.js
// ============================================================================
// Player domain API: the playersApi root + 4 legacy wrappers around it
// (playerRankingsApi, headshotsApi, playerStatsApi). All share the same
// /players/{name} Firestore collection.
//
// Extracted from firebase.js in Batch 5. Module-level alias cache and
// getAliasMap helper kept here because they're playersApi-internal —
// nothing else in the app needs them.
//
// `globalPlayerStatsApi` lives in ./storage.js because it's stored in
// /sfgl_data/{key} rather than the players collection. Conceptually a
// player stat, practically a sfgl_data wrapper.
// ============================================================================

import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  writeBatch,
} from 'firebase/firestore';
import { db } from './_init';
import { _getAllOrdered } from './_helpers';
import { resolveAlias } from '../constants/nameAliases.js';

// ── Alias cache — maps alternate player names to canonical doc IDs ──────────
// Populated lazily from player docs that have an 'aliases' array field.
// Invalidated whenever aliases are written or a player is deleted.
let _aliasCache = null;
async function getAliasMap() {
  if (_aliasCache) return _aliasCache;
  try {
    const snap = await getDocs(query(collection(db, 'players'), where('aliases', '!=', null)));
    const map = {};
    snap.docs.forEach(d => {
      (d.data().aliases || []).forEach(alias => { map[alias] = d.id; });
    });
    _aliasCache = map;
    return map;
  } catch (_) { return {}; }
}
function invalidateAliasCache() { _aliasCache = null; }

export const playersApi = {
  // Exposed for components/hooks that need to resolve alternate names
  // to canonical IDs without going through upsertMany. The internal
  // module-level getAliasMap() is the actual implementation; this is
  // a thin pass-through so the call works as a method too.
  getAliasMap,
  invalidateAliasCache,

  async getAll() {
    return _getAllOrdered('players', 'world_rank');
  },

  async getByName(name) {
    const snap = await getDoc(doc(db, 'players', name));
    return snap.exists() ? { _id: snap.id, ...snap.data() } : null;
  },

  // Get top N players by world rank, excluding LIV players
  async getTopRanked(n = 50) {
    const rankedQ = query(
      collection(db, 'players'),
      orderBy('world_rank', 'asc'),
      limit(700) // covers full OWGR list (~600) plus buffer
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

    // Also search all ranked players client-side for substring/last-name matches
    try {
      const allRanked = await this.getTopRanked(700);
      const lower = searchTerm.toLowerCase();
      allRanked.forEach(p => {
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
    const timestamp = Date.now();
    // Check alias map — if a player name is an alias for a canonical doc, use that doc ID
    const aliasMap = await getAliasMap();
    const BATCH_SIZE = 499;
    for (let i = 0; i < players.length; i += BATCH_SIZE) {
      const batch = writeBatch(db);
      players.slice(i, i + BATCH_SIZE).forEach(p => {
        // Resolve via static aliases first, then dynamic Firebase aliases
        const canonicalName = aliasMap[p.name] || resolveAlias(p.name);
        const row = { name: canonicalName };
        if (p.worldRank   !== undefined) row.world_rank   = p.worldRank ?? null;
        if (p.espnId      !== undefined && p.espnId !== null) row.espn_id = p.espnId;
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
   *
   * Bug fix: previously referenced `aliasMap` in scope without declaring it
   * (the var was only defined inside upsertMany). Every call threw
   * ReferenceError. Now resolves the alias map up front like upsertMany does.
   */
  async clearEspnIds(names) {
    if (!Array.isArray(names) || names.length === 0) return;
    const aliasMap = await getAliasMap();
    const BATCH_SIZE = 250;
    for (let i = 0; i < names.length; i += BATCH_SIZE) {
      const batch = writeBatch(db);
      names.slice(i, i + BATCH_SIZE).forEach(name => {
        const canonicalName = aliasMap[name] || resolveAlias(name);
        batch.set(doc(db, 'players', canonicalName), { espn_id: null }, { merge: true });
      });
      await batch.commit();
    }
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
    if (updates.headshotUrl !== undefined) updateData.headshot_url = updates.headshotUrl;
    if (updates.stats      !== undefined) updateData.career_stats  = updates.stats;
    if (updates.isLiv      !== undefined) updateData.is_liv        = updates.isLiv;
    await updateDoc(doc(db, 'players', name), updateData);
    return updateData;
  },

  async getAllForApp() {
    const players = await this.getAll();
    return players.map(p => ({
      name:        p.name,
      worldRank:   p.world_rank,
      espnId:   p.espn_id,
      headshotUrl: p.headshot_url,
      stats:       p.career_stats,
      isLiv:       p.is_liv,
    }));
  },

  async getHeadshotsMap() {
    const players = await this.getAll();
    const map = {};
    players.forEach(p => {
      if (p.headshot_url) {
        map[p.name] = p.headshot_url;
      } else if (p.espn_id) {
        map[p.name] = String(p.espn_id);
      }
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
// LEGACY API WRAPPERS  (identical surface to supabase.js)
// ============================================================================


const PLAYER_CACHE_KEY = 'sfgl-player-cache';
const PLAYER_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

export const playerRankingsApi = {
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

    // Cache miss or expired — fetch from Firestore
    const players = await playersApi.getAllForApp();
    try {
      localStorage.setItem(PLAYER_CACHE_KEY, JSON.stringify({ players, timestamp: Date.now() }));
    } catch (_) {}
    return players;
  },
  async invalidateCache() {
    try { localStorage.removeItem(PLAYER_CACHE_KEY); } catch (_) {}
  },
  async updateAll(players) { return playersApi.upsertMany(players); },
  async getLastUpdated()   { return playersApi.getLastUpdated(); },
  async setLastUpdated(ts) { return playersApi.setLastUpdated(ts); },
};

export const headshotsApi = {
  async getAll() { return playersApi.getHeadshotsMap(); },

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
    if (Array.isArray(map)) {
      entries = map
        .filter(p => p && p.name && p.espnId)
        .map(p => ({ name: p.name, espnId: p.espnId }));
    } else if (typeof map === 'object') {
      entries = Object.entries(map)
        .filter(([name, espnId]) => name && espnId)
        .map(([name, espnId]) => ({ name, espnId }));
    } else {
      return;
    }
    if (!entries.length) return;
    return playersApi.upsertMany(entries);
  },
};

export const playerStatsApi = {
  async getAll()              { return playersApi.getStatsMap(); },
  async set(playerName, stats){ return playersApi.update(playerName, { stats }); },
  async setAll(_obj)          { console.warn('playerStatsApi.setAll is deprecated'); },
};
