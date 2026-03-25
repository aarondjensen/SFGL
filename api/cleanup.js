// api/cleanup.js — deletes numeric player documents using client SDK
// Visit: /api/cleanup?secret=YOUR_CRON_SECRET then DELETE this file

import { initializeApp, getApps } from 'firebase/app';
import { getFirestore, collection, getDocs, writeBatch, doc } from 'firebase/firestore';

const firebaseConfig = {
  apiKey:            process.env.VITE_FIREBASE_API_KEY,
  authDomain:        process.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId:         process.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket:     process.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:             process.env.VITE_FIREBASE_APP_ID,
};

function getDb() {
  if (!getApps().length) initializeApp(firebaseConfig);
  return getFirestore();
}

export default async function handler(req, res) {
  if (req.query.secret !== process.env.SFGL_CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const db = getDb();
    const snap = await getDocs(collection(db, 'players'));
    const toDelete = snap.docs.filter(d => /^\d+$/.test(d.id.trim()));

    if (!toDelete.length) {
      return res.status(200).json({ message: 'Nothing to delete', total: snap.docs.length });
    }

    for (let i = 0; i < toDelete.length; i += 500) {
      const batch = writeBatch(db);
      toDelete.slice(i, i + 500).forEach(d => batch.delete(doc(db, 'players', d.id)));
      await batch.commit();
    }

    return res.status(200).json({
      deleted: toDelete.length,
      remaining: snap.docs.length - toDelete.length,
      message: `Deleted ${toDelete.length} numeric player documents`,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
