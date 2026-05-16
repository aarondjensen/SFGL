// src/api/_helpers.js
// ============================================================================
// Shared internal helpers used by multiple domain files (players.js, teams.js,
// tournaments.js). Extracted from firebase.js in Batch 5.
//
// Underscore prefix marks them as module-internal — they're exported only so
// the sibling domain files can import them, NOT for direct use from app code.
// App code should always use the per-domain APIs (playersApi, teamsApi, etc).
//
// Dropped from the original firebase.js: `_getAll` and `_deleteAll`, both of
// which became dead code through the various refactors. If you ever need a
// generic "delete every doc in a collection" again, re-port _deleteAll from
// git history — it handled Firestore's 500-op batch limit correctly.
// ============================================================================

import { collection, query, orderBy, getDocs, onSnapshot } from 'firebase/firestore';
import { db } from './_init';

/** Return all documents ordered by a field. */
export async function _getAllOrdered(collectionName, field, dir = 'asc') {
  const q = query(collection(db, collectionName), orderBy(field, dir));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ _id: d.id, ...d.data() }));
}

/**
 * Wave-A subscribe helper: attaches an onSnapshot listener with consistent
 * error handling. Returns the unsubscribe function. Errors during snapshot
 * delivery are logged but never thrown — a transient Firestore error
 * shouldn't tear down the rest of the app.
 */
export function _subscribeOrdered(collectionName, field, mapDocs, callback, dir = 'asc') {
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
