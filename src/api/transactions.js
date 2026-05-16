// src/api/transactions.js
// ============================================================================
// Transactions API — wraps /transactions/{txId|autoId}.
// Includes the _dedupeTransactions helper (the dedup logic that's been here
// since the Supabase migration: prefer txId as the dedup key, fall back to
// a composite of (team, type, player, droppedPlayer, tournamentIndex,
// status, segment) for legacy rows).
// Extracted from firebase.js in Batch 5.
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
  onSnapshot,
} from 'firebase/firestore';
import { db } from './_init';

// ── Transaction dedup (shared between getAll + subscribe) ───────────────────
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

export const transactionsApi = {
  async getAll() {
    const snap = await getDocs(
      query(collection(db, 'transactions'), orderBy('timestamp', 'desc'))
    );
    const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return _dedupeTransactions(data);
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

  /**
   * Wave A fix: real-time subscription via onSnapshot. Applies the same
   * dedup logic that getAll() uses so subscribers and direct fetchers see
   * identical shapes.
   */
  subscribe(callback) {
    const q = query(collection(db, 'transactions'), orderBy('timestamp', 'desc'));
    return onSnapshot(
      q,
      (snap) => {
        try {
          const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
          callback(_dedupeTransactions(data));
        } catch (e) {
          console.error('[subscribe:transactions] handler error:', e);
        }
      },
      (err) => console.error('[subscribe:transactions] firestore error:', err)
    );
  },
};


