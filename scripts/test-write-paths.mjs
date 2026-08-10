// scripts/test-write-paths.mjs
// ============================================================================
// Covers the write-path fixes:
//
//   E1  the player index has to hear about docs upsertMany creates, or the
//       next upsert in the same session mints a duplicate golfer
//   E2  settings go to Firestore in one batch, not one document at a time
//   E3  deepEqual / changedFields replace two JSON.stringify comparisons
//   E4  one tournament-start resolver instead of two that disagreed
//
//   node scripts/test-write-paths.mjs
// ============================================================================

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
};

const { deepEqual, changedFields } = await import('../src/utils/deepEqual.js');
const { NameSet } = await import('../api/_playerNames.js');

// ── E3 ───────────────────────────────────────────────────────────────────────
console.log('\ndeepEqual — what actually needs writing');

test('identical primitives and structures are equal', () => {
  assert.equal(deepEqual(1, 1), true);
  assert.equal(deepEqual('a', 'a'), true);
  assert.equal(deepEqual(null, null), true);
  assert.equal(deepEqual({ a: 1, b: [2, { c: 3 }] }, { a: 1, b: [2, { c: 3 }] }), true);
});

test('key order does not make two identical teams different', () => {
  // The regression that made every save rewrite all twelve teams.
  const a = { name: 'Detroit Rock City', lineup: ['x'], roster: [{ name: 'p', stars: 1 }] };
  const b = { roster: [{ stars: 1, name: 'p' }], lineup: ['x'], name: 'Detroit Rock City' };
  assert.equal(deepEqual(a, b), true);
  assert.notEqual(JSON.stringify(a), JSON.stringify(b), 'fixture no longer exercises key order');
});

test('a field explicitly set to undefined is a change, not a no-op', () => {
  // JSON.stringify drops it, so clearing a field this way used to read as
  // "nothing changed" and never reached the database.
  // The shape that actually bit: the field was absent on the server copy and
  // is explicitly cleared locally. Both serialize to '{}'.
  const prev = {};
  const next = { backup: undefined };
  assert.equal(JSON.stringify(prev), JSON.stringify(next), 'fixture assumption');
  assert.equal(deepEqual(prev, next), false);
  assert.deepEqual(Object.keys(changedFields(prev, next)), ['backup']);
});

test('present-but-undefined is distinct from absent', () => {
  assert.equal(deepEqual({ a: undefined }, {}), false);
  assert.equal(JSON.stringify({ a: undefined }), JSON.stringify({}), 'fixture assumption');
});

test('arrays compare by order and length', () => {
  assert.equal(deepEqual([1, 2], [1, 2]), true);
  assert.equal(deepEqual([1, 2], [2, 1]), false);
  assert.equal(deepEqual([1, 2], [1, 2, 3]), false);
  assert.equal(deepEqual([1], { 0: 1 }), false);
});

test('nested difference is found', () => {
  const a = { roster: [{ name: 'p', stars: 1 }] };
  const b = { roster: [{ name: 'p', stars: 2 }] };
  assert.equal(deepEqual(a, b), false);
});

test('dates compare by instant, NaN equals NaN', () => {
  assert.equal(deepEqual(new Date('2026-04-09'), new Date('2026-04-09')), true);
  assert.equal(deepEqual(new Date('2026-04-09'), new Date('2026-04-10')), false);
  assert.equal(deepEqual(new Date('2026-04-09'), '2026-04-09'), false);
  assert.equal(deepEqual(NaN, NaN), true);
});

test('changedFields returns only what differs', () => {
  const prev = { a: 1, b: { c: 2 }, d: [1, 2] };
  const next = { a: 1, b: { c: 3 }, d: [1, 2] };
  assert.deepEqual(changedFields(prev, next), { b: { c: 3 } });
});

test('changedFields treats a brand-new key as changed', () => {
  assert.deepEqual(changedFields({ a: 1 }, { a: 1, b: 2 }), { b: 2 });
});

test('changedFields does not report keys dropped from next', () => {
  // A merge write cannot delete a field; callers replace the whole doc for
  // that, and useLeague checks for it separately before choosing a path.
  assert.deepEqual(changedFields({ a: 1, b: 2 }, { a: 1 }), {});
});

// ── E1 ───────────────────────────────────────────────────────────────────────
// The index itself is a NameSet; the fix is that upsertMany extends it with
// what it wrote. Reproduce that sequence against the real NameSet.
console.log('\nplayer index — surviving a write');

test('a stale index cannot see the doc the sync just created', () => {
  // The index is built from the collection as it was when first asked. An OWGR
  // sync then upserts 'Nicolas Echavarria', creating that doc. Left unextended,
  // the index still describes the collection without it — so the headshot flow
  // upserting 'Nico Echavarria' later in the same session resolves nothing and
  // mints a second document for the same golfer.
  const stale = new NameSet(['Rory McIlroy']);
  assert.equal(stale.resolve('Nico Echavarria'), null);
});

test('extending the index with what was written resolves the variant', () => {
  const before = new NameSet(['Rory McIlroy']);
  const written = ['Nicolas Echavarria'];
  const after = new NameSet([...before.toArray(), ...written]);
  assert.equal(after.resolve('Nico Echavarria'), 'Nicolas Echavarria');
  assert.equal(after.resolve('Rory McIlroy'), 'Rory McIlroy', 'existing entries survive');
});

test('re-writing a name already in the index adds nothing', () => {
  const idx = new NameSet(['Nicolas Echavarria']);
  assert.equal(idx.has('Nico Echavarria'), true);
  const fresh = ['Nico Echavarria'].filter(n => !idx.has(n));
  assert.deepEqual(fresh, [], 'a known variant must not be appended as a new golfer');
});

// ── Source guards ────────────────────────────────────────────────────────────
const firebase = readFileSync('src/api/firebase.js', 'utf8');
const hooks    = readFileSync('src/hooks/index.js', 'utf8');
const admin    = readFileSync('src/pages/AdminView.jsx', 'utf8');

console.log('\nwiring');

test('E1: both doc-creating player writes tell the index', () => {
  // upsertMany and clearEspnIds both set+merge on a resolved name, which
  // creates the doc when the name did not resolve.
  const calls = (firebase.match(/noteWrittenPlayerDocs\(written\)/g) || []).length;
  assert.equal(calls, 2, 'expected upsertMany and clearEspnIds to both report their writes');
});

test('E1: a null index is left null rather than half-built', () => {
  assert.match(firebase, /if \(!_playerIndexCache \|\| !names\.length\) return;/);
});

test('E2: settings write through a batch, not a loop of single sets', () => {
  assert.match(hooks, /await settingsApi\.setMany\(resolved\)/);
  assert.ok(!/for \(const \[key, value\] of Object\.entries\(resolved\)\)/.test(hooks),
    'the per-key await loop is still there');
  assert.match(firebase, /async setMany\(entries\)/);
});

test('E3: no JSON.stringify comparisons remain in the write paths', () => {
  const cmp = hooks.match(/JSON\.stringify\([^)]*\)\s*!==\s*JSON\.stringify/g) || [];
  assert.deepEqual(cmp, [], `still comparing serialized JSON: ${cmp.join(' | ')}`);
});

test('E4: AdminView resolves tournament starts one way', () => {
  const raw = admin.match(/nextEvent\.start_date|t\.start_date \? new Date/g) || [];
  assert.deepEqual(raw, [], `still reading the ordering field directly: ${raw.join(', ')}`);
  assert.equal((admin.match(/resolveTournamentStart\(/g) || []).length, 2);
});

test('E4: the imminent-event window measures from ET', () => {
  assert.match(admin, /getETNow\(\)\.getTime\(\)/);
  assert.ok(!/const now = new Date\(\);/.test(admin), 'still reading the machine clock');
});

console.log(`\n${passed} assertions passed${process.exitCode ? ' (with failures)' : ''}\n`);
