// src/api/swRegistration.js
// ============================================================================
// Single registration point for /firebase-messaging-sw.js.
//
// WHY THIS EXISTS
// ---------------
// Service workers run in their own context and cannot read Vite's
// `import.meta.env`, so the SW previously carried a hand-copied Firebase
// config block. That block shipped to production still holding
// REPLACE_WITH_VITE_FIREBASE_* placeholders, which meant:
//   • FCM initialized against a bogus sender ID → background pushes could
//     never route, and
//   • if firebase.messaging() threw on the bad config, the whole SW script
//     died before its shell-cache handlers registered — silently disabling
//     the PWA cold-start cache for every user.
//
// Rather than hardcoding the config into a file under source control, we pass
// it on the registration URL's query string. The SW reads it from
// self.location.search. This keeps the values in Vercel env vars only (they
// are public config, but there's no reason to re-commit them), and it works
// identically in dev and prod with no build step.
//
// Both callers (main.tsx's unconditional shell-cache registration and
// pushNotifications.js's opt-in FCM flow) MUST go through here. Registering
// the same script under two different URLs would create two registrations.
// ============================================================================

import { firebaseConfig } from './_init.js';

const SW_PATH = '/firebase-messaging-sw.js';

// Build the registration URL from the SAME config object the app initializes
// with, rather than re-reading the six env vars here. The six keys the SW reads
// back out (see public/firebase-messaging-sw.js) are exactly the keys of that
// object, so adding or renaming one now cannot leave the worker behind.
//
// Empty-string coercion is kept: URLSearchParams stringifies undefined as the
// literal "undefined", which would reach the SW as a plausible-looking value
// instead of an obviously missing one.
const swUrl = () => {
  const params = new URLSearchParams(
    Object.fromEntries(Object.entries(firebaseConfig).map(([k, v]) => [k, v || ''])),
  );
  return `${SW_PATH}?${params.toString()}`;
};

// Memoized so concurrent callers share one registration promise. A second
// register() call with the same URL is a no-op in the browser, but sharing the
// promise means pushNotifications.js can await the registration main.tsx
// already started instead of racing it.
let _registration = null;

/**
 * Register the messaging/shell-cache service worker. Resolves with the
 * ServiceWorkerRegistration, or null when service workers are unavailable.
 * Never throws — a registration failure must not break app boot.
 */
export function registerMessagingSW() {
  if (_registration) return _registration;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return Promise.resolve(null);
  }
  _registration = navigator.serviceWorker
    .register(swUrl())
    .catch((err) => {
      console.warn('[sw] registration failed:', err?.message || err);
      _registration = null; // allow a later retry
      return null;
    });
  return _registration;
}
