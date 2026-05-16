// src/api/tournaments.js
// ============================================================================
// Tournaments API + tournament results API.
//   • tournamentsApi wraps /tournaments/{name}
//   • tournamentResultsApi wraps /tournament_results/{tournamentName}_{season}
// Both extracted from firebase.js in Batch 5.
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
import { _getAllOrdered, _subscribeOrdered } from './_helpers';

export const tournamentsApi = {
  async getAll() {
    return _getAllOrdered('tournaments', 'start_date');
  },

  async setAll(tournaments) {
    // Same Wave A hotfix as teamsApi.setAll — see comment there. Real-time
    // subscriptions made the delete-all-then-insert pattern emit transient
    // empty / partial snapshots that clobbered local state mid-write.
    if (!Array.isArray(tournaments)) return [];
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
    return _subscribeOrdered('tournaments', 'start_date', null, callback);
  },
};


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

