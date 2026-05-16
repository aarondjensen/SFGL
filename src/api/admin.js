// src/api/admin.js
// ============================================================================
// Admin-domain APIs grouped together: league settings, draft state, manager
// auth, and draft picks. Includes the _hashPassword helper used by
// managerAuthApi (SHA-256 via the SubtleCrypto Web API).
//
// Extracted from firebase.js in Batch 5.
//   • settingsApi      → /league_settings/{key}
//   • draftStateApi    → /draft_state/default
//   • managerAuthApi   → /league_settings/{ownerName} (yes, settings collection)
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
  writeBatch,
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
