// scripts/test-bundle-budget.mjs
// ============================================================================
// First-load budget guard.
//
// The expensive part of this app's load is not the app — it is the vendor code
// the entry HTML tells the browser to fetch before anything renders. That set
// is easy to grow by accident: one static import of a module that touches the
// FCM SDK, or one native Capacitor bridge sharing a manual chunk with something
// eager, silently adds a chunk to every visitor's critical path. Both of those
// had happened; neither showed up anywhere except in the byte count.
//
// So this asserts the SET, not just the size. A new name in the preload list is
// a failure even if it is small, because it means something that was supposed
// to load on demand no longer does.
//
// Run after a build:
//   npm run build && node scripts/test-bundle-budget.mjs
// ============================================================================

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
};

if (!existsSync('dist/index.html')) {
  console.error('\ndist/index.html not found — run `npm run build` first.\n');
  process.exit(1);
}

const html = readFileSync('dist/index.html', 'utf8');

// Everything index.html asks for up front: the entry <script> plus every
// <link rel="modulepreload">. Content hashes are stripped so the expectation
// below is stable across builds.
const assets = [...html.matchAll(/(?:href|src)="\/assets\/([^"]+\.js)"/g)].map(m => m[1]);
// Exactly eight — rollup's default hash length. A looser quantifier eats the
// hyphens inside the chunk names themselves ('vendor-firebase' → 'vendor').
const nameOf = (f) => f.replace(/-[A-Za-z0-9_-]{8}\.js$/, '');
const preloaded = [...new Set(assets.map(nameOf))].sort();

const gz = assets.reduce((sum, f) => sum + gzipSync(readFileSync(`dist/assets/${f}`)).length, 0);

console.log('\nfirst load — ' + assets.length + ' chunks, ' + (gz / 1024).toFixed(1) + ' kB gzipped');
for (const f of assets.sort()) {
  const size = gzipSync(readFileSync(`dist/assets/${f}`)).length;
  console.log('  ' + (size / 1024).toFixed(1).padStart(7) + ' kB  ' + nameOf(f));
}
console.log('');

// The entry chunk is app code and the three vendors the app cannot start
// without: React, the Firebase SDK (auth gates the whole app, Firestore loads
// on mount), and the icon set the nav renders. vendor-capacitor is here because
// the web build asks Capacitor.isNativePlatform() during boot.
const EXPECTED = ['index', 'vendor-capacitor', 'vendor-firebase', 'vendor-icons', 'vendor-react'];

test('nothing new joined the critical path', () => {
  const added = preloaded.filter(n => !EXPECTED.includes(n));
  assert.deepEqual(added, [], `newly preloaded: ${added.join(', ')} — should these load on demand?`);
});

test('nothing dropped off it either (the expectation is still current)', () => {
  const gone = EXPECTED.filter(n => !preloaded.includes(n));
  assert.deepEqual(gone, [], `no longer preloaded: ${gone.join(', ')} — update EXPECTED if deliberate`);
});

test('the deferred chunks stayed deferred', () => {
  // Named individually because each one has been on the critical path before:
  //   pushNotifications / firebase messaging — pulled in by two modals that
  //     only wanted to POST to /api/push
  //   capacitor-firebase — native-only bridges sharing a chunk with core
  //   AdminView / TransactionsView — the two heaviest views
  for (const name of ['pushNotifications', 'AdminView', 'TransactionsView', 'UserSettingsModal', 'AccountModal']) {
    assert.ok(!preloaded.includes(name), `${name} is being preloaded on first load`);
  }
});

test('first load stays under 265 kB gzipped', () => {
  // Headroom over the current figure, not a target to grow into. If a genuine
  // feature needs more, move the number deliberately rather than by accident.
  //
  // Moved from 250 when _init.js switched Firestore to a persistent on-disk
  // cache (initializeFirestore + persistentLocalCache). That pulls the
  // IndexedDB persistence layer of the SDK into vendor-firebase: +22.6 kB
  // gzipped on first load, in exchange for relaunches resuming from a stored
  // token instead of re-reading whole collections. For a phone-first app that
  // cold-starts constantly it pays for itself on the second launch — a
  // deliberate trade, recorded here because this guard is what made it visible
  // at all.
  assert.ok(gz < 265 * 1024, `first load is ${(gz / 1024).toFixed(1)} kB gzipped`);
});

console.log(`${passed} assertions passed${process.exitCode ? ' (with failures)' : ''}\n`);
