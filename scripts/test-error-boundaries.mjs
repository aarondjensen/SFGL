// scripts/test-error-boundaries.mjs
// ============================================================================
// Is everything rendered inside <main> covered by an error boundary?
//
// A consistency guard, not a unit test. The thing it exists to catch already
// happened once: the offseason bar (keepers + the draft) was added directly
// inside <main>, ABOVE the tab boundary rather than inside one. Two
// consequences, neither visible in a build or a lint:
//
//   • a render error in it had no boundary, so React unmounted the whole tree
//     and the app went blank rather than degrading to a fallback;
//   • React render errors never reach window.onerror, which is what
//     addGlobalErrorReporters hooks — so the crash sent NO report, and the
//     commissioner's only signal that the newest code in the app was broken
//     was a manager mentioning it.
//
// The second one is why this is worth a guard. A missing boundary does not
// announce itself; it removes the thing that would have announced the bug.
//
//   node scripts/test-error-boundaries.mjs
// ============================================================================

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
};

const app = readFileSync('src/App.jsx', 'utf8');

// The body of <main>…</main>. Everything a signed-in manager sees on a tab is
// in here; the nav and the modals are deliberately siblings of PullToRefresh
// (see the note in App.jsx) and are out of scope.
const mainBody = (() => {
  const open = app.indexOf('<main');
  const close = app.indexOf('</main>');
  assert.ok(open !== -1 && close > open, 'could not find <main> in App.jsx');
  return app.slice(app.indexOf('>', open) + 1, close);
})();

// Strip every <ErrorBoundary …> … </ErrorBoundary> region. ErrorBoundary is not
// nested inside itself anywhere in App.jsx, so a non-greedy sweep is exact; if
// that ever changes this guard starts over-reporting rather than under-, which
// is the right direction for it to fail in.
const uncovered = mainBody.replace(/<ErrorBoundary[\s\S]*?<\/ErrorBoundary>/g, '');

// Components are capitalised JSX tags. Suspense and Fragment are plumbing —
// neither renders anything of its own that can throw — so a bare one outside a
// boundary is not a finding on its own; whatever it WRAPS still is, and that
// shows up as its own tag.
const ALLOWED_OUTSIDE = new Set(['Suspense', 'Fragment', 'React']);

test('nothing inside <main> renders outside an error boundary', () => {
  const tags = [...uncovered.matchAll(/<([A-Z][A-Za-z0-9_]*)/g)]
    .map(m => m[1])
    .filter(tag => !ALLOWED_OUTSIDE.has(tag));
  assert.deepEqual(
    [...new Set(tags)].sort(), [],
    'these render inside <main> with no boundary above them — a crash in one blanks the app AND sends no report',
  );
});

test('the offseason bar is inside a boundary of its own, not the tab one', () => {
  // Its own, because the tab boundary is keyed on activeTab and remounts on
  // every tab change — and because a broken draft sheet should not take the
  // tab's content with it.
  const own = /<ErrorBoundary[^>]*tabName="offseason"[\s\S]*?LazyOffseasonBar/.test(app);
  assert.ok(own, 'LazyOffseasonBar is not inside an ErrorBoundary tagged "offseason"');
});

test('its boundary is outside the Suspense, so a failed lazy load is caught', () => {
  // A stale-chunk failure after a deploy throws during render of the lazy
  // component; componentDidCatch recognises it and reloads silently instead of
  // emailing. That only happens if a boundary is above the Suspense.
  const region = app.match(/<ErrorBoundary[^>]*tabName="offseason"[\s\S]*?<\/ErrorBoundary>/);
  assert.ok(region, 'no offseason boundary region found');
  assert.ok(
    region[0].indexOf('<Suspense') > 0,
    'the Suspense must be INSIDE the boundary, not wrapped around it',
  );
});

test('a compact fallback is passed — the default card is tab-sized', () => {
  const region = app.match(/<ErrorBoundary[^>]*tabName="offseason"[\s\S]*?<\/ErrorBoundary>/);
  assert.match(region[0], /fallback=\{/, 'without one it renders the full-card fallback above the tab');
});

// ── The prop the fallback rides on ──────────────────────────────────────────
console.log('');

const boundary = readFileSync('src/pages/ErrorBoundary.jsx', 'utf8');

test('ErrorBoundary honours a fallback node or a render function', () => {
  assert.match(boundary, /'fallback' in this\.props/);
  assert.match(boundary, /typeof fallback === 'function'/);
});

test('an absent fallback still renders the original card', () => {
  // The tab boundary passes none and must be untouched by this.
  assert.match(boundary, /Something went wrong\{tabLabel\}/);
});

test('the fallback is checked AFTER the stale-chunk reload path', () => {
  // Reversing the two would render an error banner for what is really a
  // post-deploy chunk rename — a transient condition the user should never see.
  const reload = boundary.indexOf('maybeReloadForStaleChunk(error)');
  const fallback = boundary.indexOf("'fallback' in this.props");
  assert.ok(reload !== -1 && fallback !== -1, 'expected both paths to exist');
  assert.ok(reload < fallback, 'the fallback must not pre-empt the silent stale-chunk reload');
});

console.log(`\n${passed} assertions passed\n`);
