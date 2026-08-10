// src/api/_init.js
// ============================================================================
// Firebase app + Firestore initialization. This is the single place where the
// Firebase SDK is initialized — every other module imports `app`, `db` or
// `auth` from here rather than calling initializeApp() themselves.
//
// That was true of this header before it was true of the code: firebase.js
// carried a byte-identical config block and its own
// initializeApp/getFirestore, and pushNotifications.js reached for the app
// through getApps()[0] with a comment explaining it could not import one. Both
// resolved to the same instance — everything reused getApps()[0] — but only
// this file sets up App Check, so which module the bundler evaluated first
// decided whether App Check was live before the first Firestore call. Now the
// import graph decides it: ES modules evaluate their imports first, so anything
// that reaches Firestore through db has already run this file.
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
// Vite exposes env vars prefixed with VITE_.
//
// Exported because the service worker needs the same six values and cannot read
// import.meta.env from its own context — swRegistration.js passes them on the
// registration URL. It used to list the keys again itself, which is a third
// copy of this object in a codebase where the first duplicate already shipped
// to production carrying unreplaced REPLACE_WITH_* placeholders.
export const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID,
};

// Avoid re-initialising on hot reload. Exported so no other module has to go
// fishing for it with getApps()[0] — pushNotifications.js did exactly that,
// which is only safe while something else happens to have initialized first.
export const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);

// ── Firebase App Check (reCAPTCHA v3) ────────────────────────────────────────
// Attests that Firestore requests come from THIS app, so the public web config
// can't be used to read or write the database directly from a script. Fully
// inert until VITE_FIREBASE_APPCHECK_SITE_KEY is set — deploying this changes
// nothing until that key is configured — and failures never block app boot.
if (typeof window !== 'undefined' && import.meta.env.VITE_FIREBASE_APPCHECK_SITE_KEY) {
  // Dev: emit a debug token to the console; register it under
  // App Check → (your web app) → Manage debug tokens so localhost is allowed.
  if (import.meta.env.DEV) {
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
