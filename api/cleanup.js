// api/cleanup.js — one-time admin endpoint to delete numeric player documents
// Hit GET /api/cleanup?secret=YOUR_CRON_SECRET to run
// DELETE THIS FILE after running

import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { cert } from 'firebase-admin/app';

function getAdminDb() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
  }
  return getFirestore();
}

export default async function handler(req, res) {
  if (req.query.secret !== process.env.SFGL_CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const db = getAdminDb();
  const snap = await db.collection('players').get();
  const toDelete = snap.docs.filter(d => /^\d+$/.test(d.id.trim()));

  if (!toDelete.length) {
    return res.status(200).json({ message: 'Nothing to delete', total: snap.docs.length });
  }

  // Delete in batches of 500
  for (let i = 0; i < toDelete.length; i += 500) {
    const batch = db.batch();
    toDelete.slice(i, i + 500).forEach(d => batch.delete(d.ref));
    await batch.commit();
  }

  return res.status(200).json({
    deleted: toDelete.length,
    remaining: snap.docs.length - toDelete.length,
    message: `Deleted ${toDelete.length} numeric player documents`,
  });
}
