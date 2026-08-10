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

// Undo the ENV-LEVEL escaping inside a double-quoted value, and nothing more.
// Single-quoted values are literal, the usual dotenv convention.
//
// Only \\ and \" and \' are unescaped. \n, \r and \t are deliberately left
// ALONE — which is a deviation from dotenv, and the only thing that makes this
// work on a real file.
//
// The reason is that the value we care about is itself JSON. `vercel env pull`
// writes a service account as one double-quoted line, and its private key
// carries \n escapes that belong to the INNER JSON — JSON.parse is what turns
// those into newlines, one step later. Converting them here produces literal
// newlines inside a JSON string literal, which is a syntax error ("Bad control
// character in string literal").
//
// It also makes the rule indifferent to how many layers of escaping the file
// actually has, which varies by Vercel CLI version and by whether a human
// pasted the JSON:
//
//   \"  ->  "     env-level quote escaping, always undone
//   \n  ->  \n    left intact, JSON.parse handles it
//   \\n ->  \n    the \\ collapses, same result
//
// Both shapes therefore land on the same correct string. An unrecognised
// escape keeps its backslash rather than silently losing it.
const unescape = (v) => v.replace(/\\(.)/g, (match, c) => (
  c === '\\' || c === '"' || c === "'" ? c : match
));

// ── Decoding a service account ───────────────────────────────────────────────
// The env-level unescape above is not enough on its own, because \n inside this
// particular value is genuinely ambiguous. A real pulled file looks like:
//
//   FIREBASE_SERVICE_ACCOUNT="{\n  "type": "service_account",\n  "private_key":
//     "-----BEGIN PRIVATE KEY-----\nMIIEv…\n-----END PRIVATE KEY-----\n"}"
//
// The JSON was pretty-printed and its real newlines escaped, but its quotes were
// left bare. So \n now means two different things in one string:
//
//   between tokens   structural whitespace — must become a real newline, or
//                    JSON.parse hits a backslash where it wants a property name
//   inside a string  the private key's own line breaks — must STAY \n, or
//                    JSON.parse reports a bad control character in a string
//
// No uniform substitution satisfies both; applying either one breaks the other,
// which is precisely what the two previous attempts at this did, in opposite
// directions. Telling them apart needs one bit of state — are we inside a
// string — so that is what this tracks.
const unescapeStructuralWhitespace = (text) => {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '\\' && i + 1 < text.length) {
      const n = text[i + 1];
      if (!inString && (n === 'n' || n === 'r' || n === 't')) {
        out += n === 'n' ? '\n' : n === 'r' ? '\r' : '\t';
        i += 1;
        continue;
      }
      // Inside a string, or not a whitespace escape: keep the pair verbatim
      // and let JSON.parse deal with it. Consuming both characters is also
      // what stops an escaped quote from toggling inString.
      out += c + n;
      i += 1;
      continue;
    }
    if (c === '"') inString = !inString;
    out += c;
  }
  return out;
};

/**
 * Turn the FIREBASE_SERVICE_ACCOUNT value into an object, or null.
 *
 * Deliberately try-then-verify rather than one clever rule. How the value is
 * escaped varies with the Vercel CLI version, with whether the JSON was
 * pretty-printed before it was stored, and with whether a human pasted it into
 * the dashboard — and each variation needs a different decoding. Since the
 * result is checkable, the honest approach is to attempt each and keep the one
 * that produces a usable credential, instead of inferring the format and being
 * wrong about it.
 *
 * The check is deliberately more than "did JSON.parse succeed": a decoding can
 * produce valid JSON that is not a service account, and cert() would then fail
 * later with something far less obvious.
 */
export const decodeServiceAccount = (raw) => {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const candidates = [
    raw,                                                    // already clean JSON
    unescapeStructuralWhitespace(raw),                      // pretty-printed, newlines escaped
    unescape(raw),                                          // env-level \" escaping left over
    unescapeStructuralWhitespace(unescape(raw)),            // both at once
  ];
  for (const candidate of candidates) {
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === 'object' && parsed.private_key && parsed.client_email) {
      return parsed;
    }
  }
  return null;
};

// Exported for scripts/test-env-parsing.mjs. This has been wrong twice — first
// not reading .env at all, then stripping quotes without unescaping — and both
// times the symptom was a maintenance script that looked broken.
export const parseEnvFile = (text) => {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.length >= 2 && value[0] === '"' && value.endsWith('"')) {
      value = unescape(value.slice(1, -1));
    } else if (value.length >= 2 && value[0] === "'" && value.endsWith("'")) {
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
    const parsed = decodeServiceAccount(blob);
    if (!parsed) {
      console.error('\nFIREBASE_SERVICE_ACCOUNT is set but could not be decoded as a');
      console.error('service account. Every known escaping of it was tried.');
      console.error('It should be the entire service-account file, quoted as one string.\n');
      // A shape summary, not the value. Escaping depth varies between files and
      // is exactly what determines whether the parser above handled it — but
      // the value is a private key, so none of it is printed. Counts and
      // booleans only.
      const count = (re) => (blob.match(re) || []).length;
      console.error('What was actually read (no secret material below):');
      console.error(`  length                 ${blob.length}`);
      console.error(`  starts with {          ${blob.trimStart().startsWith('{')}`);
      console.error(`  contains real newlines ${/[\n\r]/.test(blob)}   <- must be false`);
      console.error(`  \\" sequences           ${count(/\\"/g)}`);
      console.error(`  \\n sequences           ${count(/(?<!\\)\\n/g)}`);
      console.error(`  \\\\n sequences          ${count(/\\\\n/g)}`);
      console.error('');
      process.exit(2);
    }
    try {
      initializeApp({ credential: cert(parsed) });
    } catch (err) {
      // Decoding succeeded, so the JSON was fine and the key itself is not.
      // Left uncaught this is a raw ASN.1 stack trace, which reads like the
      // script is broken rather than the credential.
      console.error(`\nThe service account decoded, but Firebase rejected it: ${err.message}`);
      console.error('\nUsually one of:');
      console.error('  • the private key was truncated or had its newlines flattened');
      console.error('  • the key was revoked in Firebase console → Service accounts');
      console.error('  • the JSON is from a different Firebase project\n');
      process.exit(2);
    }
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
