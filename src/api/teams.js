// src/api/teams.js
// ============================================================================
// Teams API — wraps /teams/{id}. Extracted from firebase.js in Batch 5.
// ============================================================================

import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  writeBatch,
} from 'firebase/firestore';
import { db } from './_init';
import { _getAllOrdered, _subscribeOrdered } from './_helpers';

export const teamsApi = {
  async getAll() {
    const teams = await _getAllOrdered('teams', 'name');
    // Ensure every team has a lineup array — older documents may not have one
    return teams.map(t => ({ ...t, lineup: t.lineup || [] }));
  },

  async setAll(teams) {
    // Wave A hotfix: previously this did `_deleteAll('teams')` followed by a
    // batch insert — destructive, multi-step, and pre-Wave-A it didn't matter
    // because real-time subscriptions weren't actually wired up. Now they are,
    // and the delete-all phase emits a stream of intermediate snapshots
    // (8 teams → 7 → 6 → ... → 0 → 8) to every subscribed client, including
    // the one issuing the write. That caused mulligans, lineups, and any
    // other team-level fields to flicker / reset during the write window.
    //
    // Replaced with an upsert (idempotent per-doc writes) plus a targeted
    // delete of any docs that exist remotely but aren't in the local set.
    // Snapshots now arrive as a single coherent emission per write.
    if (!Array.isArray(teams)) return [];
    const snap = await getDocs(collection(db, 'teams'));
    const remoteIds = new Set(snap.docs.map(d => d.id));
    const localIds = new Set(teams.map(t => t.id || t.name));

    const BATCH_SIZE = 499;
    // Upsert all locals
    for (let i = 0; i < teams.length; i += BATCH_SIZE) {
      const batch = writeBatch(db);
      teams.slice(i, i + BATCH_SIZE).forEach(team => {
        const id = team.id || team.name;
        batch.set(doc(db, 'teams', id), { ...team });
      });
      await batch.commit();
    }
    // Delete any remote docs that no longer exist locally
    const toDelete = [...remoteIds].filter(id => !localIds.has(id));
    if (toDelete.length) {
      const batch = writeBatch(db);
      toDelete.forEach(id => batch.delete(doc(db, 'teams', id)));
      await batch.commit();
    }
    return teams;
  },

  async update(teamId, updates) {
    await updateDoc(doc(db, 'teams', teamId), updates);
    return updates;
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


