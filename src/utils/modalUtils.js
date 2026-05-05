// src/utils/modalUtils.js
// Shared utilities for modal behavior: scroll lock + Escape key.
// Used by AddDropPlayerModal, DraftModal, EditTransactionModal, etc.

import { useEffect } from 'react';

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
 * @param {boolean} isOpen - whether the modal is currently visible
 * @param {Function} onClose - called when Escape is pressed
 */
export function useModalBehavior(isOpen, onClose) {
  useEffect(() => {
    if (!isOpen) return;
    lockScroll();
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => {
      unlockScroll();
      document.removeEventListener('keydown', handler);
    };
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * Hook: same as useModalBehavior but for modals that are always mounted
 * (no isOpen prop — they mount = they're open).
 * @param {Function} onClose - called when Escape is pressed
 */
export function useModalBehaviorAlways(onClose) {
  useEffect(() => {
    lockScroll();
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => {
      unlockScroll();
      document.removeEventListener('keydown', handler);
    };
  }, [onClose]);
}
