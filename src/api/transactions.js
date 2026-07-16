// src/api/transactions.js
// ============================================================================
// Transactions API — wraps /transactions/{txId|autoId}.
// Includes the _dedupeTransactions helper (the dedup logic that's been here
// since the Supabase migration: prefer txId as the dedup key, fall back to
// a composite of (team, type, player, droppedPlayer, tournamentIndex,
// status, segment) for legacy rows).
// Extracted from firebase.js in Batch 5.
//
// NOTE: not yet imported anywhere — firebase.js still owns the live copy.
// Keep the two in lockstep until the extraction is wired in.
// ============================================================================

import {
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  updateDoc,
  writeBatch,
  onSnapshot,
  deleteField,
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
  async getAll() {
    // Unordered fetch + JS sort. Never orderBy('timestamp'): Firestore orderBy
    // silently omits docs missing the ordered field, so legacy rows without a
    // timestamp would vanish from every read (same failure mode as the
    // start_date incident — see tournamentsApi.getAll and utils/swingAward.js).
    const snap = await getDocs(collection(db, 'transactions'));
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

    const validCols = ['team','type','player','droppedPlayer','status','fee','segment',
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
