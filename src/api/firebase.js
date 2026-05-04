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
 *   liv_roster         → /liv_roster/{name}
 *   teams              → /teams/{id}
 *   tournaments        → /tournaments/{name}
 *   transactions       → /transactions/{txId|autoId}
 *   league_settings    → /league_settings/{key}
 *   draft_state        → /draft_state/default
 *   draft_picks        → /draft_picks/{autoId}
 *   tournament_results → /tournament_results/{tournamentName}_{season}
 *   sfgl_data          → /sfgl_data/{key}
 * ============================================================================
 */

import { initializeApp, getApps } from 'firebase/app';
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  orderBy,
  where,
  limit,
  writeBatch,
  serverTimestamp,
} from 'firebase/firestore';
// Wave 5: hoisted from mid-file (was line 323) so all imports live at the top.
import { NAME_ALIASES, NAME_ALIASES_REVERSE, resolveAlias, allNameVariants } from '../constants/nameAliases.js';

// ── Firebase config — values come from environment variables ─────────────────
// Vite exposes env vars prefixed with VITE_
const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID,
};

// Avoid re-initialising on hot reload
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
export const db = getFirestore(app);

// ── Alias cache — maps alternate player names to canonical doc IDs ────────────
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

// ── Internal helpers ─────────────────────────────────────────────────────────

/** Return all documents from a collection as an array of plain objects. */
async function _getAll(collectionName) {
  const snap = await getDocs(collection(db, collectionName));
  return snap.docs.map(d => ({ _id: d.id, ...d.data() }));
}

/** Return all documents ordered by a field. */
async function _getAllOrdered(collectionName, field, dir = 'asc') {
  const q = query(collection(db, collectionName), orderBy(field, dir));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ _id: d.id, ...d.data() }));
}

/** Delete every document in a collection using a batched write. */
async function _deleteAll(collectionName) {
  const snap = await getDocs(collection(db, collectionName));
  if (snap.empty) return;
  // Firestore batch limit is 500 ops; chunk if needed
  const chunks = [];
  let batch = writeBatch(db);
  let count = 0;
  snap.docs.forEach(d => {
    batch.delete(d.ref);
    count++;
    if (count === 499) { chunks.push(batch); batch = writeBatch(db); count = 0; }
  });
  chunks.push(batch);
  await Promise.all(chunks.map(b => b.commit()));
}

// ============================================================================
// PLAYERS API
// ============================================================================
export const playersApi = {
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
    // Wave 5: renamed from `addDoc` to avoid shadowing the imported `addDoc`
    // from firebase/firestore at the top of this file.
    const pushResult = d => {
      const name = resolveAlias(d.id);
      if (!seen.has(name)) {
        seen.add(name);
        results.push({ name, worldRank: d.data().world_rank, espnId: d.data().espn_id, headshotUrl: d.data().headshot_url, isLiv: d.data().is_liv });
      }
    };
    snapRaw.docs.forEach(pushResult);
    snapCap.docs.forEach(pushResult);

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
    const aliasMap = await getAliasMap(db);
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

// ============================================================================
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
  async getAll()         { return playersApi.getHeadshotsMap(); },
  async setAll(_obj)     { console.warn('headshotsApi.setAll is deprecated'); },
};

export const playerStatsApi = {
  async getAll()              { return playersApi.getStatsMap(); },
  async set(playerName, stats){ return playersApi.update(playerName, { stats }); },
  async setAll(_obj)          { console.warn('playerStatsApi.setAll is deprecated'); },
};

// ============================================================================
// LIV ROSTER API
// ============================================================================
export const livRosterApi = {
  async getAll() {
    const snap = await getDocs(query(collection(db, 'liv_roster'), orderBy('player_name')));
    return snap.docs.map(d => d.data().player_name);
  },

  async setAll(players) {
    await _deleteAll('liv_roster');
    if (players.length === 0) return [];
    const BATCH_SIZE = 499;
    for (let i = 0; i < players.length; i += BATCH_SIZE) {
      const batch = writeBatch(db);
      players.slice(i, i + BATCH_SIZE).forEach(name => {
        batch.set(doc(collection(db, 'liv_roster')), { player_name: name });
      });
      await batch.commit();
    }
    return players;
  },

  async addPlayer(playerName) {
    await addDoc(collection(db, 'liv_roster'), { player_name: playerName });
  },

  async removePlayer(playerName) {
    const q = query(collection(db, 'liv_roster'), where('player_name', '==', playerName));
    const snap = await getDocs(q);
    const batch = writeBatch(db);
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
  },
};

// ============================================================================
// TEAMS API
// ============================================================================
export const teamsApi = {
  async getAll() {
    const teams = await _getAllOrdered('teams', 'name');
    // Ensure every team has a lineup array — older documents may not have one
    return teams.map(t => ({ ...t, lineup: t.lineup || [] }));
  },

  async setAll(teams) {
    await _deleteAll('teams');
    if (teams.length === 0) return [];
    const batch = writeBatch(db);
    teams.forEach(team => {
      const id = team.id || team.name;
      batch.set(doc(db, 'teams', id), { ...team });
    });
    await batch.commit();
    return teams;
  },

  async update(teamId, updates) {
    await updateDoc(doc(db, 'teams', teamId), updates);
    return updates;
  },
};

// ============================================================================
// TOURNAMENTS API
// ============================================================================
export const tournamentsApi = {
  async getAll() {
    return _getAllOrdered('tournaments', 'start_date');
  },

  async setAll(tournaments) {
    await _deleteAll('tournaments');
    if (tournaments.length === 0) return [];
    const batch = writeBatch(db);
    tournaments.forEach(t => {
      const id = t.name || t.id;
      batch.set(doc(db, 'tournaments', id), { ...t });
    });
    await batch.commit();
    return tournaments;
  },

  async update(tournamentName, updates) {
    await updateDoc(doc(db, 'tournaments', tournamentName), updates);
    return updates;
  },
};

// ============================================================================
// TRANSACTIONS API
// ============================================================================
export const transactionsApi = {
  async getAll() {
    const snap = await getDocs(
      query(collection(db, 'transactions'), orderBy('timestamp', 'desc'))
    );
    const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Dedup — mirrors supabase.js logic exactly
    const seen = new Set();
    const deduped = [];
    data.forEach(tx => {
      if (tx.txId) {
        if (!seen.has('txId:' + tx.txId)) {
          seen.add('txId:' + tx.txId);
          deduped.push(tx);
        }
      } else {
        const key = [tx.team, tx.type, tx.player, tx.droppedPlayer, tx.tournamentIndex, tx.status, tx.segment].join('|');
        if (!seen.has(key)) {
          seen.add(key);
          deduped.push(tx);
        }
      }
    });
    return deduped;
  },

  async add(transaction) {
    const ref = await addDoc(collection(db, 'transactions'), transaction);
    return [{ id: ref.id, ...transaction }];
  },

  async setAll(transactions) {
    return this.sync(transactions);
  },

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

    const validCols = ['team','type','player','droppedPlayer','status','fee','segment',
                       'priority','timestamp','processedDate','failReason','txId',
                       'tournamentIndex','tournament','date'];

    localTransactions.forEach(tx => {
      if (tx.txId && remoteByTxId.has(tx.txId)) {
        const r = remoteByTxId.get(tx.txId);
        if (tx.status !== r.status || tx.failReason !== r.failReason || tx.priority !== r.priority) {
          toUpdate.push({ ...tx, id: r.id });
        }
      } else if (tx.id && remoteById.has(tx.id)) {
        const r = remoteById.get(tx.id);
        if (tx.status !== r.status || tx.failReason !== r.failReason || tx.priority !== r.priority) {
          toUpdate.push(tx);
        }
      } else if (!tx.id) {
        const row = {};
        validCols.forEach(c => { if (tx[c] !== undefined) row[c] = tx[c]; });
        toInsert.push(row);
      }
    });

    // Detect remote transactions that were deleted locally and remove them from Firebase
    const localTxIds = new Set(localTransactions.filter(t => t.txId).map(t => t.txId));
    const localIds   = new Set(localTransactions.filter(t => t.id).map(t => t.id));
    const toDelete = remote.filter(tx => {
      if (tx.txId && localTxIds.has(tx.txId)) return false; // still exists locally
      if (tx.id   && localIds.has(tx.id))     return false; // still exists locally
      // If remote tx has neither txId nor id match in local, it was deleted
      return true;
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

    // Individual updates (preserving ids)
    for (const tx of toUpdate) {
      if (tx.id) {
        const { id, ...rest } = tx;
        await updateDoc(doc(db, 'transactions', id), rest).catch(e =>
          console.error('[transactionsApi.sync] update error:', e)
        );
      }
    }

    // Delete removed transactions from Firebase
    if (toDelete.length > 0) {
      const BATCH_SIZE = 499;
      for (let i = 0; i < toDelete.length; i += BATCH_SIZE) {
        const batch = writeBatch(db);
        toDelete.slice(i, i + BATCH_SIZE).forEach(tx => {
          batch.delete(doc(db, 'transactions', tx.id));
        });
        await batch.commit();
      }
    }

    // Return only what the local state should have (no more merging back deleted items)
    return localTransactions;
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

  async getAll() {
    const snap = await getDocs(collection(db, 'league_settings'));
    const settings = {};
    snap.docs.forEach(d => { settings[d.data().key] = d.data().value; });
    return settings;
  },
};

// ============================================================================
// DRAFT STATE API
// ============================================================================
export const draftStateApi = {
  async get() {
    const snap = await getDoc(doc(db, 'draft_state', 'default'));
    return snap.exists() ? { league_id: 'default', ...snap.data() } : null;
  },

  async save(state) {
    await setDoc(doc(db, 'draft_state', 'default'), {
      league_id:           'default',
      phase:               state.phase,
      draft_order:         state.draftOrder,
      keeper_team_index:   state.keeperTeamIndex,
      keepers:             state.keepers,
      current_team_index:  state.currentTeamIndex,
      current_round:       state.currentRound,
      drafted_players:     state.draftedPlayers,
      is_complete:         state.isComplete || false,
    });
    return state;
  },

  async clear() {
    await deleteDoc(doc(db, 'draft_state', 'default'));
  },
};

// ============================================================================
// MANAGER AUTH API
// Credentials stored in sfgl_data (via sfglDataApi). Sessions in localStorage.
// Identical behaviour to supabase.js.
// ============================================================================
const CREDS_KEY = 'manager_credentials';

const _hashPassword = async (password) => {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
};

export const managerAuthApi = {
  async _getCreds() {
    const creds = await sfglDataApi.get(CREDS_KEY);
    return creds || {};
  },

  async setCredentials(teamId, name, password) {
    const creds       = await this._getCreds();
    const passwordHash = await _hashPassword(password.trim());
    creds[teamId]     = { name: name.trim(), passwordHash };
    await sfglDataApi.set(CREDS_KEY, creds);
  },

  async login(name, password) {
    const creds        = await this._getCreds();
    const passwordHash = await _hashPassword(password.trim());
    const entry = Object.entries(creds).find(([, c]) =>
      c.name.toLowerCase() === name.trim().toLowerCase() &&
      (c.passwordHash === passwordHash || c.password === password.trim())
    );
    if (!entry) throw new Error('Invalid name or password');
    const [teamId, cred] = entry;
    // Auto-migrate legacy plain-text → hashed
    if (cred.password && !cred.passwordHash) {
      creds[teamId] = { name: cred.name, passwordHash };
      await sfglDataApi.set(CREDS_KEY, creds);
    }
    localStorage.setItem('manager_team_id', teamId);
    localStorage.removeItem('is_commissioner');
    return { teamId };
  },

  async getCurrentSession() {
    const teamId = localStorage.getItem('manager_team_id');
    return teamId ? { teamId } : null;
  },

  async logout() {
    localStorage.removeItem('manager_team_id');
    localStorage.removeItem('is_commissioner');
  },
};

// ============================================================================
// DRAFT PICKS API
// ============================================================================
export const draftPicksApi = {
  async getAllForDraft(draftId = 'default') {
    const q = query(
      collection(db, 'draft_picks'),
      where('draft_id', '==', draftId),
      orderBy('pick_number')
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },

  async addPick(pick) {
    const data = {
      draft_id:          pick.draftId || 'default',
      pick_number:       pick.pickNumber,
      round_number:      pick.roundNumber,
      team_id:           pick.teamId,
      team_name:         pick.teamName,
      player_name:       pick.playerName,
      player_type:       pick.playerType,
      picked_by_manager: pick.pickedByManager !== false,
    };
    const ref = await addDoc(collection(db, 'draft_picks'), data);
    return [{ id: ref.id, ...data }];
  },

  async deleteLastPick(draftId = 'default') {
    const q = query(
      collection(db, 'draft_picks'),
      where('draft_id', '==', draftId),
      orderBy('pick_number', 'desc')
    );
    const snap = await getDocs(q);
    if (snap.empty) return null;
    const lastDoc  = snap.docs[0];
    const lastPick = { id: lastDoc.id, ...lastDoc.data() };
    await deleteDoc(lastDoc.ref);
    return lastPick;
  },
};

// ============================================================================
// TOURNAMENT RESULTS API
// Document ID: `${tournamentName}__${season}`  (double-underscore separator)
// ============================================================================
const _resultDocId = (tournamentName, season) =>
  `${tournamentName}__${season}`.replace(/[/]/g, '_');

export const tournamentResultsApi = {
  async save({ tournamentName, season = 2026, teamResults, earningsMap, roundLeaders, fullLineups = {}, rosterSnapshots = {}, isManualEntry = false }) {
    const earningsObj = earningsMap instanceof Map
      ? Object.fromEntries(earningsMap)
      : (earningsMap || {});

    const id   = _resultDocId(tournamentName, season);
    const data = {
      tournament_name:  tournamentName,
      season,
      processed_at:     new Date().toISOString(),
      is_manual_entry:  isManualEntry,
      team_results:     teamResults || {},
      earnings_map:     earningsObj,
      round_leaders:    roundLeaders || {},
      full_lineups:     fullLineups,
      roster_snapshots: rosterSnapshots,
    };
    await setDoc(doc(db, 'tournament_results', id), data);
    return data;
  },

  async getByName(tournamentName, season = 2026) {
    const snap = await getDoc(doc(db, 'tournament_results', _resultDocId(tournamentName, season)));
    if (!snap.exists()) return null;
    const d = snap.data();
    return {
      tournamentName:  d.tournament_name,
      season:          d.season,
      processedAt:     d.processed_at,
      isManualEntry:   d.is_manual_entry,
      teamResults:     d.team_results,
      earningsMap:     d.earnings_map,
      roundLeaders:    d.round_leaders,
      fullLineups:     d.full_lineups     || {},
      rosterSnapshots: d.roster_snapshots || {},
    };
  },

  async getAllForSeason(season = 2026) {
    const q = query(
      collection(db, 'tournament_results'),
      where('season', '==', season),
      orderBy('processed_at')
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => {
      const row = d.data();
      return {
        tournamentName: row.tournament_name,
        season:         row.season,
        processedAt:    row.processed_at,
        isManualEntry:  row.is_manual_entry,
        results: {
          teams:           row.team_results,
          earningsMap:     row.earnings_map,
          roundLeaders:    row.round_leaders,
          fullLineups:     row.full_lineups     || {},
          rosterSnapshots: row.roster_snapshots || {},
        },
      };
    });
  },

  async deleteByName(tournamentName, season = 2026) {
    await deleteDoc(doc(db, 'tournament_results', _resultDocId(tournamentName, season)));
  },

  async deleteAllForSeason(season = 2026) {
    const q = query(
      collection(db, 'tournament_results'),
      where('season', '==', season)
    );
    const snap = await getDocs(q);
    const batch = writeBatch(db);
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
  },
};

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

