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
// The fixtures cover BOTH escaping depths seen in real pulled files, because
// assuming one of them is how this broke the second time:
//
//   singly escaped   \"type\": … \"private_key\":\"…\nMII…\n…\"
//   doubly escaped   \"type\": … \"private_key\":\"…\\nMII…\\n…\"
//
// Which one you get depends on the CLI version and on whether a human pasted
// the JSON into the Vercel dashboard. Both must yield the same key.
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
// The JSON text of the service account, with its private key carrying the \n
// escapes JSON itself defines.
const SA_JSON = JSON.stringify(SA);

// DOUBLY escaped: JSON.stringify again, so every \ and " in SA_JSON is escaped
// once more. This is what a strict serialiser produces.
const doublyEscaped = `FIREBASE_SERVICE_ACCOUNT=${JSON.stringify(SA_JSON)}`;

// SINGLY escaped: quotes escaped, backslashes left as they were. This is what
// the file on a real machine turned out to contain, and what broke the first
// attempt at this parser.
const singlyEscaped =
  `FIREBASE_SERVICE_ACCOUNT="${SA_JSON.replace(/"/g, '\\"')}"`;

console.log('\n.env parsing — the vercel env pull format');

test('the fixtures really are escaped, and differently, or they test nothing', () => {
  assert.ok(doublyEscaped.includes('\\"type\\"'), 'doubly-escaped fixture is not escaped');
  assert.ok(doublyEscaped.includes('\\\\n'), 'doubly-escaped fixture has no \\\\n');
  assert.ok(singlyEscaped.includes('\\"type\\"'), 'singly-escaped fixture is not escaped');
  assert.ok(!singlyEscaped.includes('\\\\n'), 'singly-escaped fixture should have no \\\\n');
});

test('a DOUBLY escaped service account parses', () => {
  const env = parseEnvFile(['# Created by Vercel CLI', doublyEscaped].join('\n'));
  assert.deepEqual(JSON.parse(env.FIREBASE_SERVICE_ACCOUNT), SA);
});

test('a SINGLY escaped service account parses', () => {
  // The shape that produced "Bad control character in string literal" when the
  // parser converted the inner \n to a real newline.
  const env = parseEnvFile(['# Created by Vercel CLI', singlyEscaped].join('\n'));
  assert.deepEqual(JSON.parse(env.FIREBASE_SERVICE_ACCOUNT), SA);
});

test('both escaping depths yield the identical private key', () => {
  // cert() rejects a key whose newlines got flattened, with an error that says
  // nothing useful about why.
  const a = JSON.parse(parseEnvFile(doublyEscaped).FIREBASE_SERVICE_ACCOUNT).private_key;
  const b = JSON.parse(parseEnvFile(singlyEscaped).FIREBASE_SERVICE_ACCOUNT).private_key;
  assert.equal(a, SA.private_key);
  assert.equal(b, SA.private_key);
  assert.equal(a.split('\n').length - 1, 4);
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
});

test('\\n is preserved, not turned into a newline', () => {
  // The deviation from dotenv that makes an embedded JSON value survive.
  assert.equal(parseEnvFile('X="a\\nb"').X, 'a\\nb');
  assert.ok(!parseEnvFile('X="a\\nb"').X.includes('\n'), 'a real newline crept in');
});

test('escaped quotes and backslashes ARE unescaped', () => {
  assert.equal(parseEnvFile('X="say \\"hi\\""').X, 'say "hi"');
  assert.equal(parseEnvFile('X="a\\\\b"').X, 'a\\b');
});

test('an unrecognised escape keeps its backslash', () => {
  // Dropping it silently would corrupt a Windows path or a regex.
  assert.equal(parseEnvFile('X="C:\\dev\\sfgl"').X, 'C:\\dev\\sfgl');
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
