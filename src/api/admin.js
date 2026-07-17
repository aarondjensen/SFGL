// src/api/admin.js
// ============================================================================
// Admin-domain APIs grouped together: league settings, draft state, and
// draft picks. (The legacy name/password managerAuthApi was removed when
// Firebase Auth + locked Firestore rules landed — see src/api/authApi.js.)
//
// Extracted from firebase.js in Batch 5.
//   • settingsApi      → /league_settings/{key}
//   • draftStateApi    → /draft_state/default
//   • draftPicksApi    → /draft_picks/{autoId}
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
  orderBy,
  where,
  writeBatch,
  onSnapshot,
} from 'firebase/firestore';
import { db } from './_init';

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
