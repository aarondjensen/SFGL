// scripts/cleanup-players.js
// Run once from your project root: node scripts/cleanup-players.js
// Deletes all documents in the 'players' collection where the document ID
// is a pure number (legacy numeric IDs from old RapidAPI import).
//
// Usage:
//   GOOGLE_APPLICATION_CREDENTIALS=./serviceAccount.json node cleanup-players.js
// Or set env vars directly:
//   FIREBASE_PROJECT_ID=xxx FIREBASE_CLIENT_EMAIL=xxx FIREBASE_PRIVATE_KEY=xxx node cleanup-players.js

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const app = initializeApp({
  credential: cert({
    projectId:    process.env.FIREBASE_PROJECT_ID,
    clientEmail:  process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:   process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  }),
});

const db = getFirestore(app);

async function cleanup() {
  console.log('Fetching all players...');
  const snap = await db.collection('players').get();
  
  const toDelete = snap.docs.filter(d => /^\d+$/.test(d.id.trim()));
  console.log(`Found ${snap.docs.length} total documents, ${toDelete.length} numeric IDs to delete`);
  
  if (toDelete.length === 0) {
    console.log('Nothing to clean up.');
    return;
  }

  // Delete in batches of 500 (Firestore limit)
  const batchSize = 500;
  for (let i = 0; i < toDelete.length; i += batchSize) {
    const batch = db.batch();
    toDelete.slice(i, i + batchSize).forEach(d => batch.delete(d.ref));
    await batch.commit();
    console.log(`Deleted ${Math.min(i + batchSize, toDelete.length)} / ${toDelete.length}`);
  }

  console.log('Done. Also invalidating player cache...');
  // Optionally clear the last-updated timestamp to force a fresh OWGR sync
  await db.collection('app_metadata').doc('player_rankings_last_updated').set({ value: null });
  console.log('Complete.');
}

cleanup().catch(console.error);
