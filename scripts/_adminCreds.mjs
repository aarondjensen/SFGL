// scripts/_adminCreds.mjs
// ============================================================================
// One way for a maintenance script to authenticate as Firebase Admin.
//
// The project already had two, which is one more than the number of credentials
// it actually has:
//
//   api/cron.js      FIREBASE_SERVICE_ACCOUNT   — the whole service-account
//                                                 JSON, as one string. This is
//                                                 what Vercel holds.
//   scripts/*.mjs    FIREBASE_PROJECT_ID +
//                    FIREBASE_CLIENT_EMAIL +
//                    FIREBASE_PRIVATE_KEY      — the same three fields, pulled
//                                                 out of that same JSON by hand.
//
// So anyone with a working deployment still had to crack open the service
// account and re-export three pieces of it before a script would run. This
// accepts either, preferring the JSON blob because that is the one the app
// itself uses.
//
// Underscore-prefixed to match the api/ convention: a shared module, not a
// script you run.
// ============================================================================

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const HELP = `
Set ONE of the following:

  FIREBASE_SERVICE_ACCOUNT   the service-account JSON as a single string
                             (the same variable Vercel holds for /api/cron)

  …or the three fields individually:
  FIREBASE_PROJECT_ID
  FIREBASE_CLIENT_EMAIL
  FIREBASE_PRIVATE_KEY

A .env.local is not read automatically — export them in your shell, or prefix
the command:

  FIREBASE_SERVICE_ACCOUNT="$(cat service-account.json)" node scripts/<script>
`;

/**
 * Returns an authenticated Firestore instance, or exits with a usable message.
 * Read-only scripts and write scripts alike go through this.
 */
export function adminDb() {
  if (getApps().length) return getFirestore();

  const blob = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (blob) {
    let parsed;
    try {
      parsed = JSON.parse(blob);
    } catch (err) {
      console.error(`\nFIREBASE_SERVICE_ACCOUNT is set but is not valid JSON: ${err.message}`);
      console.error('It should be the entire service-account file, quoted as one string.\n');
      process.exit(2);
    }
    initializeApp({ credential: cert(parsed) });
    return getFirestore();
  }

  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
  if (FIREBASE_PROJECT_ID && FIREBASE_CLIENT_EMAIL && FIREBASE_PRIVATE_KEY) {
    initializeApp({
      credential: cert({
        projectId: FIREBASE_PROJECT_ID,
        clientEmail: FIREBASE_CLIENT_EMAIL,
        // Shell env vars keep newlines escaped; cert() needs them real.
        privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    });
    return getFirestore();
  }

  console.error('\nNo Firebase Admin credentials found.');
  console.error(HELP);
  process.exit(2);
}

export default adminDb;
