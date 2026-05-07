// src/utils/modalUtils.js
// Shared utilities for modal behavior: scroll lock + Escape key.
// Used by AddDropPlayerModal, DraftModal, EditTransactionModal, etc.

import { useEffect, useRef } from 'react';

/**
 * Lock body scroll (prevents background scroll on iOS while modal is open).
 * Saves scroll position and applies `position: fixed` to prevent iOS bounce.
 */
export function lockScroll() {
  const scrollY = window.scrollY;
  document.body.classList.add('sfgl-modal-open');
  document.body.style.top = `-${scrollY}px`;
  document.body.dataset.scrollY = scrollY;
}

/**
 * Unlock body scroll — restores previous scroll position.
 */
export function unlockScroll() {
  const scrollY = parseInt(document.body.dataset.scrollY || '0', 10);
  document.body.classList.remove('sfgl-modal-open');
  document.body.style.top = '';
  window.scrollTo(0, scrollY);
}

/**
 * Hook: adds Escape key handler + body scroll lock for a modal.
 *
 * Wave D fix: previously `onClose` was missing from the effect's dep array,
 * so the Escape handler captured the *first* onClose reference forever. If a
 * parent passed a fresh onClose each render (very common), pressing Escape
 * after a re-render would still call the stale original — sometimes closing
 * the wrong thing or doing nothing. Now we hold onClose in a ref and read
 * `onCloseRef.current` inside the handler, so it always sees the latest fn
 * without re-subscribing the keydown listener on every render.
 *
 * @param {boolean} isOpen - whether the modal is currently visible
 * @param {Function} onClose - called when Escape is pressed
 */
export function useModalBehavior(isOpen, onClose) {
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;
    lockScroll();
    const handler = (e) => { if (e.key === 'Escape') onCloseRef.current?.(); };
    document.addEventListener('keydown', handler);
    return () => {
      unlockScroll();
      document.removeEventListener('keydown', handler);
    };
  }, [isOpen]);
}

/**
 * Hook: same as useModalBehavior but for modals that are always mounted
 * (no isOpen prop — they mount = they're open).
 *
 * Same ref-based fix as useModalBehavior so a fresh onClose from the parent
 * doesn't tear down + re-add the listener on every render.
 *
 * @param {Function} onClose - called when Escape is pressed
 */
export function useModalBehaviorAlways(onClose) {
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    lockScroll();
    const handler = (e) => { if (e.key === 'Escape') onCloseRef.current?.(); };
    document.addEventListener('keydown', handler);
    return () => {
      unlockScroll();
      document.removeEventListener('keydown', handler);
    };
  }, []);
}
