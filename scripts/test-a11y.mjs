// scripts/test-a11y.mjs
// ============================================================================
// Regression tests for the keyboard/accessibility layer added in D3/D4:
//
//   src/utils/a11y.js       activatable() — the ARIA button pattern applied to
//                           the ~15 clickable <div> rows
//   src/utils/modalUtils.js the ref-counted body scroll lock
//
// Both are plain functions with no React state, so they test directly against a
// tiny DOM stub. The focus trap itself lives inside a useEffect and needs a
// real document to exercise; what is checked here is the part that used to be
// wrong on its own — the lock counting, which a nested dialog broke.
//
//   node scripts/test-a11y.mjs
// ============================================================================

import assert from 'node:assert/strict';

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
};

// ── DOM stub ─────────────────────────────────────────────────────────────────
// Only what lockScroll/unlockScroll touch. Installed before importing the
// module under test so nothing captures a missing global at module scope.
const body = {
  dataset: {},
  style: {},
  _classes: new Set(),
  classList: {
    add: (c) => body._classes.add(c),
    remove: (c) => body._classes.delete(c),
    contains: (c) => body._classes.has(c),
  },
};
globalThis.document = { body };
globalThis.window = {
  scrollY: 0,
  scrollTo: (_x, y) => { globalThis.window.scrollY = y; },
};

const { activatable } = await import('../src/utils/a11y.js');
const { lockScroll, unlockScroll } = await import('../src/utils/modalUtils.js');

// A key event with no nested control under it.
const keyEvent = (key, target = 'self') => {
  const el = { closest: () => null };
  const e = {
    key,
    currentTarget: el,
    target: target === 'self' ? el : target,
    prevented: false,
    preventDefault() { this.prevented = true; },
  };
  return e;
};

console.log('\nactivatable() — ARIA button pattern');

test('enabled row gets role, tab stop, click and key handlers', () => {
  const p = activatable(() => {});
  assert.equal(p.role, 'button');
  assert.equal(p.tabIndex, 0);
  assert.equal(typeof p.onClick, 'function');
  assert.equal(typeof p.onKeyDown, 'function');
});

test('Enter activates and prevents default', () => {
  let fired = 0;
  const p = activatable(() => { fired += 1; });
  const e = keyEvent('Enter');
  p.onKeyDown(e);
  assert.equal(fired, 1);
  assert.equal(e.prevented, true);
});

test('Space activates and prevents default (page must not scroll)', () => {
  let fired = 0;
  const p = activatable(() => { fired += 1; });
  const e = keyEvent(' ');
  p.onKeyDown(e);
  assert.equal(fired, 1, 'Space did not activate');
  assert.equal(e.prevented, true, 'Space would have scrolled the page');
});

test('legacy "Spacebar" key name also activates', () => {
  let fired = 0;
  activatable(() => { fired += 1; }).onKeyDown(keyEvent('Spacebar'));
  assert.equal(fired, 1);
});

test('other keys are ignored and left to the browser', () => {
  let fired = 0;
  const p = activatable(() => { fired += 1; });
  for (const k of ['Tab', 'a', 'ArrowDown', 'Escape', 'Shift']) {
    const e = keyEvent(k);
    p.onKeyDown(e);
    assert.equal(e.prevented, false, `${k} should not be swallowed`);
  }
  assert.equal(fired, 0);
});

test('the click handler is the caller\'s handler, unwrapped', () => {
  const fn = () => {};
  assert.equal(activatable(fn).onClick, fn);
});

test('event is forwarded so handlers can stopPropagation', () => {
  // RostersView's lineup slots sit inside a "click anywhere to exit lineup
  // mode" wrapper and must stop the event; that only works if they get it.
  let seen = null;
  const p = activatable((e) => { seen = e; });
  const e = keyEvent('Enter');
  p.onKeyDown(e);
  assert.equal(seen, e);
});

test('a key press from a nested control does not double-fire the row', () => {
  let rowFired = 0;
  const p = activatable(() => { rowFired += 1; });
  const nestedButton = {};
  const row = {};
  nestedButton.closest = () => nestedButton;   // the × inside a lineup headshot
  const e = {
    key: 'Enter', currentTarget: row, target: nestedButton,
    prevented: false, preventDefault() { this.prevented = true; },
  };
  p.onKeyDown(e);
  assert.equal(rowFired, 0, 'Enter on the nested × also fired the row');
  assert.equal(e.prevented, false, 'the nested control lost its own default');
});

test('disabled row is announced disabled and drops out of the tab order', () => {
  const p = activatable(() => {}, { disabled: true });
  assert.equal(p['aria-disabled'], true);
  assert.equal(p.tabIndex, undefined, 'unavailable rows must not be tab stops');
  assert.equal(p.onClick, undefined);
  assert.equal(p.onKeyDown, undefined);
});

test('a missing handler is treated as disabled, not as a broken tab stop', () => {
  const p = activatable(undefined);
  assert.equal(p['aria-disabled'], true);
  assert.equal(p.tabIndex, undefined);
});

test('selected renders aria-pressed; omitted leaves it off entirely', () => {
  assert.equal(activatable(() => {}, { selected: true })['aria-pressed'], true);
  assert.equal(activatable(() => {}, { selected: false })['aria-pressed'], false);
  assert.ok(!('aria-pressed' in activatable(() => {})));
});

test('expanded renders aria-expanded; label renders aria-label', () => {
  const p = activatable(() => {}, { expanded: false, label: 'Add Scottie Scheffler' });
  assert.equal(p['aria-expanded'], false);
  assert.equal(p['aria-label'], 'Add Scottie Scheffler');
});

test('role is overridable without losing the keyboard behaviour', () => {
  const p = activatable(() => {}, { role: 'menuitem' });
  assert.equal(p.role, 'menuitem');
  assert.equal(p.tabIndex, 0);
});

console.log('\nscroll lock — reference counting');

test('a single modal locks and unlocks cleanly', () => {
  globalThis.window.scrollY = 420;
  lockScroll();
  assert.equal(body.classList.contains('sfgl-modal-open'), true);
  assert.equal(body.style.top, '-420px');
  unlockScroll();
  assert.equal(body.classList.contains('sfgl-modal-open'), false);
  assert.equal(body.style.top, '');
  assert.equal(globalThis.window.scrollY, 420, 'scroll position was not restored');
});

test('a nested modal closing does not unlock the one underneath', () => {
  // The bug this counting fixes: Add/Drop open at scroll 900, its confirm
  // dialog opens on top, the confirm closes — and the old code unlocked the
  // body and scroll-restored while Add/Drop was still up.
  globalThis.window.scrollY = 900;
  lockScroll();            // Add/Drop
  lockScroll();            // confirm on top
  assert.equal(body.style.top, '-900px');
  unlockScroll();          // confirm closes
  assert.equal(body.classList.contains('sfgl-modal-open'), true, 'body unlocked too early');
  assert.equal(body.style.top, '-900px', 'the page moved under the open modal');
  unlockScroll();          // Add/Drop closes
  assert.equal(body.classList.contains('sfgl-modal-open'), false);
  assert.equal(globalThis.window.scrollY, 900);
});

test('the offset is taken from the first lock, not the last', () => {
  // window.scrollY reads 0 while the body is already position-fixed, so a
  // second lock must not overwrite the saved offset with that 0.
  globalThis.window.scrollY = 640;
  lockScroll();
  globalThis.window.scrollY = 0;
  lockScroll();
  unlockScroll();
  unlockScroll();
  assert.equal(globalThis.window.scrollY, 640);
});

test('an extra unlock cannot drive the count negative', () => {
  // A stray unlock used to leave the counter at -1, so the NEXT modal to open
  // would reach 0 on close and never actually lock.
  unlockScroll();
  unlockScroll();
  globalThis.window.scrollY = 55;
  lockScroll();
  assert.equal(body.classList.contains('sfgl-modal-open'), true);
  unlockScroll();
  assert.equal(body.classList.contains('sfgl-modal-open'), false);
  assert.equal(globalThis.window.scrollY, 55);
});

console.log(`\n${passed} assertions passed${process.exitCode ? ' (with failures)' : ''}\n`);
