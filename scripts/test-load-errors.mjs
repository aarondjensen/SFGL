// scripts/test-load-errors.mjs
// ============================================================================
// Consistency guard for the stale-data banner (D5).
//
// Three lists have to agree about which collections exist, and they live in
// three different places:
//
//   1. useLeague's tier-1 loader pushes a name onto `errors` when a read fails
//   2. useLeague's realtime subscriptions call clearLoadError(name) when a
//      snapshot arrives — retiring the entry the loader set
//   3. App.jsx filters loadErrors down to the collections worth warning about
//
// Drift between them fails silently and in the worst direction: a collection
// added to (1) but missed in (3) fails invisibly again, and one missed in (2)
// leaves a "showing your last saved data" banner up over live data forever.
// This is a source-text guard, in the same spirit as the palette guard.
//
//   node scripts/test-load-errors.mjs
// ============================================================================

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
};

const hooks = readFileSync('src/hooks/index.js', 'utf8');
const app   = readFileSync('src/App.jsx', 'utf8');

const setOf = (src, re) => {
  const out = new Set();
  for (const m of src.matchAll(re)) out.add(m[1]);
  return out;
};

// errors.push('teams') etc, in the tier-1 loader
const pushed   = setOf(hooks, /errors\.push\('([a-z]+)'\)/g);
// clearLoadError('teams') in the subscription callbacks
const cleared  = setOf(hooks, /clearLoadError\('([a-z]+)'\)/g);
// the userVisible allow-list in App.jsx's staleCollections memo
const visibleMatch = app.match(/const userVisible = \[([^\]]+)\]/);
const visible = new Set(
  (visibleMatch?.[1] || '').split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean),
);

console.log('\nstale-data banner — collection lists');

test('the loader records failures for the four core collections', () => {
  assert.deepEqual([...pushed].sort(), ['settings', 'teams', 'tournaments', 'transactions']);
});

test('every collection the loader can flag is one the banner will mention', () => {
  const unwarned = [...pushed].filter(n => !visible.has(n));
  assert.deepEqual(unwarned, [], `flagged but never surfaced: ${unwarned.join(', ')}`);
});

test('the banner does not claim collections the loader never flags', () => {
  const phantom = [...visible].filter(n => !pushed.has(n));
  assert.deepEqual(phantom, [], `surfaced but never flagged: ${phantom.join(', ')}`);
});

test('every flagged collection has a subscription that can retire the flag', () => {
  // Otherwise a failed load that self-heals over the realtime channel leaves
  // the warning up over data that is actually live.
  const stuck = [...pushed].filter(n => !cleared.has(n));
  assert.deepEqual(stuck, [], `no clearLoadError for: ${stuck.join(', ')}`);
});

test('clearLoadError returns the same array when nothing changed', () => {
  // A new array identity on every snapshot would re-run the memo and the
  // dismissal-reset effect on every realtime tick.
  assert.match(
    hooks,
    /setLoadErrors\(prev => \(prev\.includes\(name\) \? prev\.filter\(f => f !== name\) : prev\)\)/,
    'clearLoadError must return prev unchanged when the name is absent',
  );
});

console.log('\nstale-data banner — wiring');

test('loadErrors is no longer consumed by console alone', () => {
  assert.ok(!/Couldn't reach Firebase for/.test(app), 'the console-only handler is still present');
  assert.ok(/showStaleBanner/.test(app), 'the banner condition is missing');
});

test('the banner offers a retry that goes through refetch', () => {
  assert.match(app, /const retryLoad = useCallback\(async \(\) => \{[\s\S]*?await refetch\(\)/);
});

test('dismissal is cleared once the data is healthy again', () => {
  assert.match(app, /if \(staleCollections\.length === 0\) setStaleDismissed\(false\)/);
});

test('the banner is announced without stealing focus', () => {
  assert.match(app, /role="status"\s*\n\s*aria-live="polite"/);
});

console.log(`\n${passed} assertions passed${process.exitCode ? ' (with failures)' : ''}\n`);
