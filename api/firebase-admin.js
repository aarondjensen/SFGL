// api/firebase-admin.js — shared Firebase Admin SDK init for Vercel serverless functions
// Requires FIREBASE_SERVICE_ACCOUNT env var (JSON string from Firebase Console)

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

function getApp() {
  if (getApps().length) return getApps()[0];

  const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!sa) throw new Error('FIREBASE_SERVICE_ACCOUNT env var not set');

  const serviceAccount = JSON.parse(sa);
  return initializeApp({ credential: cert(serviceAccount) });
}

const app = getApp();
export const db = getFirestore(app);
