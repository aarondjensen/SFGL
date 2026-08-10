// scripts/test-env-parsing.mjs
// ============================================================================
// The .env parser behind scripts/_adminCreds.mjs.
//
// It exists so the maintenance scripts run the same way on every shell instead
// of needing a platform-specific `VAR=value node ...` incantation. That makes
// it load-bearing, and it has been wrong twice: once by not reading .env at
// all, once by stripping a value's surrounding quotes without unescaping what
// was inside them — which is precisely the shape `vercel env pull` writes a
// service account in, so the fix for one shell broke on the real file.
//
// The fixture below is built by serialising a service-account object the way
// the Vercel CLI does, rather than by hand, so it cannot drift into testing a
// format nobody produces.
//
//   node scripts/test-env-parsing.mjs
// ============================================================================

import assert from 'node:assert/strict';
import { parseEnvFile } from './_adminCreds.mjs';

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
};

// A service account with the shape that matters: a private key whose newlines
// are real, wrapped in JSON, wrapped again as a quoted env value.
const SA = {
  type: 'service_account',
  project_id: 'sfgl-ad892',
  private_key: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\nkqhkiG9w0BAQ==\n-----END PRIVATE KEY-----\n',
  client_email: 'firebase-adminsdk-fbsvc@sfgl-ad892.iam.gserviceaccount.com',
};
// Exactly what `vercel env pull` writes: JSON.stringify the object, then quote
// and escape that string as an env value.
const vercelLine = `FIREBASE_SERVICE_ACCOUNT=${JSON.stringify(JSON.stringify(SA))}`;

console.log('\n.env parsing — the vercel env pull format');

test('the fixture really is escaped, or it tests nothing', () => {
  assert.ok(vercelLine.includes('\\"type\\"'), 'fixture is not backslash-escaped');
  assert.ok(vercelLine.includes('\\\\n'), 'fixture private key is not doubly escaped');
});

test('a service account survives the round trip and parses', () => {
  const env = parseEnvFile(['# Created by Vercel CLI', vercelLine].join('\n'));
  const parsed = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);   // the step that failed
  assert.deepEqual(parsed, SA);
});

test('the private key keeps its real newlines', () => {
  // cert() rejects a key whose newlines got flattened, with an error that says
  // nothing useful about why.
  const env = parseEnvFile(vercelLine);
  const { private_key: key } = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  assert.equal(key, SA.private_key);
  assert.equal(key.split('\n').length - 1, 4);
});

test('the three-field form unescapes to a usable key too', () => {
  const line = `FIREBASE_PRIVATE_KEY="${SA.private_key.replace(/\n/g, '\\n')}"`;
  const env = parseEnvFile(line);
  // _adminCreds applies this same replace before handing it to cert().
  assert.equal(env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'), SA.private_key);
});

console.log('\n.env parsing — ordinary lines');

test('plain, double-quoted and single-quoted values', () => {
  const env = parseEnvFile([
    'PLAIN=value',
    'DOUBLE="value"',
    "SINGLE='value'",
  ].join('\n'));
  assert.equal(env.PLAIN, 'value');
  assert.equal(env.DOUBLE, 'value');
  assert.equal(env.SINGLE, 'value');
});

test('single quotes are literal — no unescaping', () => {
  // The usual dotenv convention, and the reason the two quote styles are
  // handled by different branches.
  assert.equal(parseEnvFile(`X='a\\nb'`).X, 'a\\nb');
  assert.equal(parseEnvFile('X="a\\nb"').X, 'a\nb');
});

test('comments and blank lines are skipped', () => {
  const env = parseEnvFile(['# comment', '', '   ', 'A=1'].join('\n'));
  assert.deepEqual(Object.keys(env), ['A']);
});

test('a value containing = keeps all of it', () => {
  assert.equal(parseEnvFile('A=a=b=c').A, 'a=b=c');
});

test('surrounding whitespace goes, inner whitespace stays', () => {
  assert.equal(parseEnvFile('  A  =  hello world  ').A, 'hello world');
});

test('an empty value is an empty string, not a missing key', () => {
  const env = parseEnvFile('A=');
  assert.equal(env.A, '');
  assert.ok('A' in env);
});

test('CRLF line endings parse — the file is written on Windows too', () => {
  const env = parseEnvFile('A=1\r\nB=2\r\n');
  assert.deepEqual(env, { A: '1', B: '2' });
});

console.log(`\n${passed} assertions passed${process.exitCode ? ' (with failures)' : ''}\n`);
