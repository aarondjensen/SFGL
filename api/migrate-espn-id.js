// api/migrate-espn-id.js — one-time migration
// Renames pga_tour_id → espn_id on all player documents
// Visit: /api/migrate-espn-id?secret=YOUR_CRON_SECRET
// DELETE THIS FILE after running

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

    // Find docs that have pga_tour_id but not espn_id
    const toMigrate = snap.docs.filter(d => {
      const data = d.data();
      return data.pga_tour_id !== undefined;
    });

    if (!toMigrate.length) {
      return res.status(200).json({ message: 'Nothing to migrate — all docs already use espn_id', total: snap.docs.length });
    }

    let migrated = 0;
    for (let i = 0; i < toMigrate.length; i += 500) {
      const batch = writeBatch(db);
      toMigrate.slice(i, i + 500).forEach(d => {
        const data = d.data();
        batch.update(doc(db, 'players', d.id), {
          espn_id: data.pga_tour_id,
          pga_tour_id: null, // null it out (Firestore doesn't support deleteField in batch easily)
        });
        migrated++;
      });
      await batch.commit();
    }

    return res.status(200).json({
      migrated,
      total: snap.docs.length,
      message: `Migrated ${migrated} player documents from pga_tour_id → espn_id`,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
