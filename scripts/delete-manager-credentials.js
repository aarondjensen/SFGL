// scripts/delete-manager-credentials.js
// One-off cleanup: deletes the retired /sfgl_data/manager_credentials doc.
//
// Why: it held client-readable, unsalted SHA-256 password hashes from the
// legacy name/password login (managerAuthApi, removed from the app). Auth is
// now Firebase Auth + team_claims, and firestore.rules denies ALL client
// access to this doc — but the data itself should not sit in the database.
//
// Run once from the project root with Admin credentials (same pattern as
// cleanup-players.js):
//   GOOGLE_APPLICATION_CREDENTIALS=./serviceAccount.json node scripts/delete-manager-credentials.js
// Or with env vars directly:
//   FIREBASE_PROJECT_ID=xxx FIREBASE_CLIENT_EMAIL=xxx FIREBASE_PRIVATE_KEY=xxx node scripts/delete-manager-credentials.js

import { initializeApp, cert, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const app = initializeApp({
  credential: process.env.GOOGLE_APPLICATION_CREDENTIALS
    ? applicationDefault()
    : cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
});

const db = getFirestore(app);

async function run() {
  const ref = db.collection('sfgl_data').doc('manager_credentials');
  const snap = await ref.get();
  if (!snap.exists) {
    console.log('sfgl_data/manager_credentials does not exist — nothing to delete.');
    return;
  }
  const teams = Object.keys(snap.data()?.value || {});
  console.log(`Deleting sfgl_data/manager_credentials (${teams.length} credential entr${teams.length === 1 ? 'y' : 'ies'})...`);
  await ref.delete();
  console.log('Deleted. Legacy manager credentials are gone from Firestore.');
}

run().catch((e) => { console.error(e); process.exit(1); });
