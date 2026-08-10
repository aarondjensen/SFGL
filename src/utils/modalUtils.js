// src/utils/modalUtils.js
// Modal behaviour: body scroll lock, Escape to close, and focus management.
// Used by components/BottomSheet.jsx, which is the shell behind every modal.

import { useEffect, useRef } from 'react';

// ── Body scroll lock ─────────────────────────────────────────────────────────
// Ref-counted. It used to be a bare add/remove of a class plus a single
// `body.dataset.scrollY`, which is correct for one modal and wrong for two: a
// nested dialog closing would unlock the body and scroll-restore while the
// modal underneath was still open, dumping the user back at the top of the
// page. Counting means the lock lifts when the LAST holder releases it, and the
// saved offset is only written by the first.
let _lockCount = 0;

export function lockScroll() {
  if (_lockCount === 0) {
    const scrollY = window.scrollY;
    document.body.dataset.scrollY = String(scrollY);
    document.body.style.top = `-${scrollY}px`;
    document.body.classList.add('sfgl-modal-open');
  }
  _lockCount += 1;
}

export function unlockScroll() {
  _lockCount = Math.max(0, _lockCount - 1);
  if (_lockCount > 0) return;
  const scrollY = parseInt(document.body.dataset.scrollY || '0', 10);
  document.body.classList.remove('sfgl-modal-open');
  document.body.style.top = '';
  delete document.body.dataset.scrollY;
  window.scrollTo(0, scrollY);
}

// Tab-reachable descendants, in DOM order. `:not([disabled])` matters — a
// disabled submit button is a very common last element in these forms, and
// trapping onto it would strand the keyboard.
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const focusableIn = (root) =>
  root ? [...root.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null || el === document.activeElement) : [];

/**
 * Escape-to-close, body scroll lock, and — when a container ref is supplied —
 * a focus trap with focus restore.
 *
 * Without the trap, Tab from inside an open modal walks straight out into the
 * page behind it: the nav, the roster table, every button on the tab underneath.
 * The modal stays visibly open the whole time, so a keyboard or screen-reader
 * user ends up operating a UI they cannot see while a dialog they cannot reach
 * is still up. aria-modal tells assistive tech to ignore the background; it
 * does nothing about the Tab key.
 *
 * @param {boolean}  isOpen
 * @param {Function} onClose        called on Escape
 * @param {object}   [containerRef] ref to the dialog element; enables the trap
 */
export function useModalBehavior(isOpen, onClose, containerRef) {
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;

    // Whatever had focus when the modal opened — the More-menu item, the Add
    // button — is where focus goes back on close. Losing it sends the user to
    // the top of the document and makes them Tab back to where they were.
    const restoreTo = document.activeElement;

    lockScroll();

    // Move focus in. `data-autofocus` wins where a modal has an opinion about
    // which control should be first — the confirm dialog wants Enter to mean
    // "Confirm", and would otherwise land on Cancel because Cancel comes first
    // in the grid. (React's own autoFocus prop is applied during commit, so
    // this effect would override it either way.) Otherwise the first real
    // control; failing that the dialog itself, which BottomSheet gives
    // tabIndex={-1} so it can hold focus.
    const container = containerRef?.current;
    if (container) {
      const first = container.querySelector('[data-autofocus]') || focusableIn(container)[0];
      (first || container).focus?.({ preventScroll: true });
    }

    const handler = (e) => {
      if (e.key === 'Escape') { onCloseRef.current?.(); return; }
      if (e.key !== 'Tab' || !containerRef?.current) return;

      const items = focusableIn(containerRef.current);
      if (items.length === 0) {
        // Nothing focusable inside — keep focus on the dialog rather than
        // letting Tab escape to the page behind.
        e.preventDefault();
        containerRef.current.focus?.({ preventScroll: true });
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;

      // Wrap at both ends, and pull focus back in if it has somehow escaped
      // (a click on the backdrop, say, leaves activeElement on <body>).
      if (!containerRef.current.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus({ preventScroll: true });
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus({ preventScroll: true });
      }
    };

    document.addEventListener('keydown', handler);
    return () => {
      unlockScroll();
      document.removeEventListener('keydown', handler);
      // Only restore if focus is still somewhere in (or lost from) the modal —
      // if something else has deliberately taken focus, leave it alone.
      if (restoreTo && typeof restoreTo.focus === 'function' && document.contains(restoreTo)) {
        restoreTo.focus({ preventScroll: true });
      }
    };
  }, [isOpen, containerRef]);
}
