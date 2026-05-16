// src/api/data.js
// ============================================================================
// Generic key/value storage backed by /sfgl_data/{key}, plus the
// globalPlayerStatsApi typed accessor that wraps a specific sfgl_data key.
//
// Extracted from firebase.js in Batch 5. Kept in the same file because
// globalPlayerStatsApi is just a thin typed wrapper around sfglDataApi.get/set
// — they're inseparable at the implementation level.
// ============================================================================

import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from './_init';

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
