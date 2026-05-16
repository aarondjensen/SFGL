// src/api/_init.js
// ============================================================================
// Firebase app + Firestore initialization. This is the single place where the
// Firebase SDK is initialized — every domain file (players.js, teams.js, etc.)
// imports `db` from here rather than calling initializeApp() themselves.
//
// Used to live at the top of firebase.js; extracted in Batch 5 so the domain
// files can be navigated without scrolling past initialization boilerplate.
//
// Firestore collections (unchanged from the original supabase migration):
//   players            → /players/{name}
//   app_metadata       → /app_metadata/{key}
//   teams              → /teams/{id}
//   tournaments        → /tournaments/{name}
//   transactions       → /transactions/{txId|autoId}
//   league_settings    → /league_settings/{key}
//   draft_state        → /draft_state/default
//   draft_picks        → /draft_picks/{autoId}
//   tournament_results → /tournament_results/{tournamentName}_{season}
//   sfgl_data          → /sfgl_data/{key}
// ============================================================================

import { initializeApp, getApps } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';

// ── Firebase config — values come from environment variables ─────────────────
// Vite exposes env vars prefixed with VITE_
const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID,
};

// Avoid re-initialising on hot reload
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
export const db = getFirestore(app);
