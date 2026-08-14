// scripts/test-layout-vars.mjs
// ============================================================================
// Guards the --sfgl-* layout custom properties: every one that is read must be
// published, and every one that is published must be read.
//
// These vars exist because two chrome elements are fixed/sticky and neither has
// a height anyone can write down. The sticky header grows when a tournament
// name wraps; the bottom nav grows when the commish row appears, and again by
// the safe-area inset on a notched phone. Anything that has to sit clear of
// them measures them at runtime — App.jsx observes each element and publishes
// its offsetHeight, and the consumers read it through var().
//
// The failure mode is silence. A var() with a fallback that nothing publishes
// does not throw, does not warn, and does not fail the build — it quietly
// renders at the fallback. For --sfgl-nav-h that means the last rows of every
// view sit underneath the nav whenever commish mode is on, which is exactly the
// hard-coded 80px this replaced. For --sfgl-header-h it means the lineup card
// pins at the wrong offset. Both look like a styling nit and neither points at
// the deleted publisher.
//
// So the pairing is what gets checked, not either half on its own.
//
//   node scripts/test-layout-vars.mjs
// ============================================================================

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
};

// ── Collect every source file that could mention a custom property ──────────
const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(jsx?|tsx?|css)$/.test(p)) files.push(p);
  }
})('src');

const sources = new Map(files.map(f => [f, readFileSync(f, 'utf8')]));

// setProperty('--sfgl-nav-h', ...) — the publisher side.
const PUBLISH = /setProperty\(\s*['"`](--sfgl-[a-z0-9-]+)['"`]/g;
// var(--sfgl-nav-h) / var(--sfgl-nav-h, 80px) — the consumer side.
const CONSUME = /var\(\s*(--sfgl-[a-z0-9-]+)/g;

const collect = (re) => {
  const found = new Map(); // var name → [files]
  for (const [file, src] of sources) {
    for (const m of src.matchAll(re)) {
      if (!found.has(m[1])) found.set(m[1], []);
      if (!found.get(m[1]).includes(file)) found.get(m[1]).push(file);
    }
  }
  return found;
};

const published = collect(PUBLISH);
const consumed   = collect(CONSUME);

// ── The pairing ─────────────────────────────────────────────────────────────
test('every --sfgl-* var that is read is also published', () => {
  const orphans = [...consumed.keys()].filter(v => !published.has(v));
  assert.deepEqual(orphans, [],
    `read but never published (silently renders at its fallback): ` +
    orphans.map(v => `${v} in ${consumed.get(v).join(', ')}`).join('; '));
});

test('every --sfgl-* var that is published is also read', () => {
  const unread = [...published.keys()].filter(v => !consumed.has(v));
  assert.deepEqual(unread, [],
    `published but nothing reads it — a consumer was probably deleted: ` +
    unread.map(v => `${v} in ${published.get(v).join(', ')}`).join('; '));
});

// ── The two that exist today ────────────────────────────────────────────────
// Named explicitly so deleting a publisher fails here with the reason attached,
// rather than only tripping the generic pairing check above.
test('--sfgl-header-h is published from the sticky header', () => {
  assert.ok(published.has('--sfgl-header-h'), 'nothing publishes --sfgl-header-h');
  assert.deepEqual(published.get('--sfgl-header-h'), ['src/App.jsx']);
});

test('--sfgl-nav-h is published from the bottom nav', () => {
  assert.ok(published.has('--sfgl-nav-h'), 'nothing publishes --sfgl-nav-h');
  assert.deepEqual(published.get('--sfgl-nav-h'), ['src/App.jsx']);
});

test('main content clears the nav by reading --sfgl-nav-h, not a fixed inset', () => {
  const css = sources.get('src/app-global.css');
  const rule = css.match(/\.sfgl-main-content\s*\{[^}]*\}/);
  assert.ok(rule, '.sfgl-main-content rule is gone from app-global.css');
  assert.match(rule[0], /padding-bottom:\s*calc\([^)]*var\(--sfgl-nav-h/,
    `.sfgl-main-content pads its bottom without reading --sfgl-nav-h — a fixed ` +
    `inset cannot cover both the plain nav and the taller commish-row nav:\n    ${rule[0]}`);
});

// Both publishers must survive the element being remounted or resized. A
// one-shot read on mount was the tempting version and it is wrong: the header
// reflows when a long tournament name wraps, and the nav reflows when commish
// mode turns on, neither of which remounts the component.
test('both publishers re-measure on resize rather than reading once', () => {
  const app = sources.get('src/App.jsx');
  const observers = app.match(/new ResizeObserver\(publish\)/g) || [];
  assert.equal(observers.length, published.size,
    `${published.size} layout vars published but ${observers.length} ResizeObserver(s) — ` +
    `a var read once on mount goes stale when its element reflows`);
});

console.log(`\n${passed} assertions passed${process.exitCode ? ' (with failures)' : ''}\n`);
