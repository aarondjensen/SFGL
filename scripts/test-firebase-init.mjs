// scripts/test-firebase-init.mjs
// ============================================================================
// Guards the "Firebase is initialized in exactly one place" invariant.
//
// It was broken in two directions at once, and neither was visible at runtime:
//
//   • src/api/firebase.js carried a byte-identical copy of the config object
//     and its own initializeApp/getFirestore, exporting a second `db`.
//   • src/api/pushNotifications.js reached for the app through getApps()[0],
//     with a comment explaining it could not import one.
//
// Both resolved to the same instance, because everything reused getApps()[0]
// when an app already existed — so nothing was doubly initialized and nothing
// looked wrong. The consequence was subtler: only _init.js configures App
// Check, so whichever module the bundler evaluated first won the initializeApp
// race, and whether App Check was live before the first Firestore call came
// down to module evaluation order. An import change anywhere could flip it,
// silently, with the only symptom being that App Check stopped attesting.
//
// This is a source guard because that is the only place the problem is
// visible — by the time the app runs, the duplicate has already collapsed into
// the same instance.
//
//   node scripts/test-firebase-init.mjs
// ============================================================================

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
};

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(js|jsx|ts|tsx)$/.test(p)) files.push(p);
  }
})('src');

const INIT = 'src/api/_init.js';

// Strip comments so the prose in this repo — which discusses these very calls
// at length — does not count as a call site.
const code = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

const sources = new Map(files.map(f => [f, code(readFileSync(f, 'utf8'))]));

const callers = (re) =>
  [...sources].filter(([, src]) => re.test(src)).map(([f]) => f).sort();

console.log('\nfirebase initialization — one place only');

test('initializeApp is called in exactly one module', () => {
  assert.deepEqual(callers(/\binitializeApp\s*\(/), [INIT]);
});

test('getFirestore is called in exactly one module', () => {
  assert.deepEqual(callers(/\bgetFirestore\s*\(/), [INIT]);
});

test('getAuth is called in exactly one module', () => {
  assert.deepEqual(callers(/\bgetAuth\s*\(/), [INIT]);
});

test('nothing fishes the app out of getApps()', () => {
  // _init.js uses it for the hot-reload guard, which is its job. Anywhere else
  // it means "I assume somebody already initialized Firebase", which is the
  // load-order dependency this guard exists to prevent.
  assert.deepEqual(callers(/\bgetApps\s*\(/), [INIT]);
});

test('_init.js exports the app, so nobody has to', () => {
  assert.match(sources.get(INIT), /export const app\s*=/);
});

test('App Check is configured in that same module', () => {
  // If App Check ever moves elsewhere, the ordering guarantee this whole file
  // is about moves with it and these assertions stop meaning anything.
  assert.deepEqual(callers(/\binitializeAppCheck\s*\(/), [INIT]);
});

test('firebase.js re-exports the shared db rather than making one', () => {
  const fb = sources.get('src/api/firebase.js');
  assert.match(fb, /import \{ db \} from '\.\/_init\.js'/);
  assert.match(fb, /export \{ db \}/);
});

test('no module declares a second firebase config object', () => {
  const configs = callers(/apiKey:\s*import\.meta\.env\.VITE_FIREBASE_API_KEY/);
  assert.deepEqual(configs, [INIT], `duplicate config in: ${configs.join(', ')}`);
});

console.log(`\n${passed} assertions passed${process.exitCode ? ' (with failures)' : ''}\n`);
