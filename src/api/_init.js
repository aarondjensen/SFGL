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
import { getAuth } from 'firebase/auth';
import { initializeAppCheck, ReCaptchaV3Provider } from 'firebase/app-check';

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

// ── Firebase App Check (reCAPTCHA v3) ────────────────────────────────────────
// Attests that Firestore requests come from THIS app, so the public web config
// can't be used to read or write the database directly from a script. Fully
// inert until VITE_FIREBASE_APPCHECK_SITE_KEY is set — deploying this changes
// nothing until that key is configured — and failures never block app boot.
if (typeof window !== 'undefined' && import.meta.env.VITE_FIREBASE_APPCHECK_SITE_KEY) {
  // Dev: emit a debug token to the console; register it under
  // App Check → (your web app) → Manage debug tokens so localhost is allowed.
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-undef
    self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  }
  try {
    initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(import.meta.env.VITE_FIREBASE_APPCHECK_SITE_KEY),
      isTokenAutoRefreshEnabled: true,
    });
  } catch (err) {
    // Never let App Check init break the app — log and continue.
    console.warn('[appcheck] initialization skipped:', err?.message || err);
  }
}

export const db = getFirestore(app);

// ── Firebase Authentication ──────────────────────────────────────────────────
// Single auth instance for the app. Identity is the immutable Firebase UID;
// the auth/team-claim logic lives in api/authApi.js.
export const auth = getAuth(app);
