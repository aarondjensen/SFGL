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
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ── .env loading ─────────────────────────────────────────────────────────────
// Vite loads these for the app; a plain `node scripts/...` does not, which left
// the credentials to be passed on the command line — and that line is different
// on every shell. `VAR=value node ...` is a bashism; PowerShell needs
// `$env:VAR = ...` on a separate line, which is exactly the kind of paper cut
// that makes a maintenance script feel broken.
//
// So the script reads the file itself. Real environment variables always win,
// so CI and `vercel env pull` piping still behave as before.
//
// Deliberately minimal: this is not a dotenv replacement. It handles KEY=VALUE,
// optional surrounding quotes, comments and blank lines, and stops there.
//
// One shape it will NOT read: a value spanning multiple lines. `vercel env
// pull` writes the service account as one line with \n escaped inside the
// JSON, which is what this expects. A hand-pasted multi-line key parses as
// truncated JSON and fails on the JSON.parse below with a message saying so —
// wrong, but not silently wrong.
const ENV_FILES = ['.env.local', '.env.production.local', '.env.production', '.env'];

const parseEnvFile = (text) => {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip one matching pair of surrounding quotes, if present.
    if (value.length >= 2 && ((value[0] === '"' && value.endsWith('"')) ||
                              (value[0] === "'" && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
};

const loadEnvFiles = () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const loaded = [];
  for (const name of ENV_FILES) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    let parsed;
    try {
      parsed = parseEnvFile(readFileSync(path, 'utf8'));
    } catch {
      continue;
    }
    for (const [k, v] of Object.entries(parsed)) {
      // A real env var beats the file, and an earlier file beats a later one —
      // same precedence Vite applies, so .env.local overrides .env.
      if (process.env[k] === undefined) process.env[k] = v;
    }
    loaded.push(name);
  }
  return loaded;
};

const HELP = `
Provide ONE of the following:

  FIREBASE_SERVICE_ACCOUNT   the service-account JSON as a single string
                             (the same variable Vercel holds for /api/cron)

  …or the three fields individually:
  FIREBASE_PROJECT_ID
  FIREBASE_CLIENT_EMAIL
  FIREBASE_PRIVATE_KEY

Easiest: put it in .env.local at the repo root — this reads that file, and
${ENV_FILES.slice(1).join(', ')}, automatically.

  FIREBASE_SERVICE_ACCOUNT={"type":"service_account", ... }

Or pull everything from Vercel in one go:

  vercel env pull .env.local

Or set it in the shell you are already in:

  PowerShell   $env:FIREBASE_SERVICE_ACCOUNT = Get-Content service-account.json -Raw
  bash/zsh     export FIREBASE_SERVICE_ACCOUNT="$(cat service-account.json)"
`;

/**
 * Returns an authenticated Firestore instance, or exits with a usable message.
 * Read-only scripts and write scripts alike go through this.
 */
export function adminDb() {
  if (getApps().length) return getFirestore();

  // Kept for the error path below: "loaded .env" followed by "no credentials
  // found" reads as a contradiction unless the two are connected explicitly.
  const envFilesRead = loadEnvFiles();

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
  if (envFilesRead.length) {
    console.error(`Read ${envFilesRead.join(', ')} — none of them set FIREBASE_SERVICE_ACCOUNT`);
    console.error('or the three separate fields. Those are SERVER credentials; a .env holding');
    console.error('only VITE_* values is the browser config and cannot authenticate here.');
  } else {
    console.error('No .env file found at the repo root.');
  }
  console.error(HELP);
  process.exit(2);
}

export default adminDb;
