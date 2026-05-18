// public/firebase-messaging-sw.js
// ─────────────────────────────────────────────────────────────────────────────
// Firebase Cloud Messaging service worker for SFGL.
//
// This file MUST live at the site root (served at /firebase-messaging-sw.js)
// — Firebase Messaging looks for it there by convention. Vite's /public/
// directory is copied verbatim to the build output root, so placing this
// file there satisfies the requirement.
//
// What this does:
//   1. Initializes Firebase in the service worker context (separate from the
//      main app — service workers run in their own thread without access to
//      the main app's Firebase instance).
//   2. Handles background push messages (when the app is closed or in another
//      tab). FCM auto-displays foreground messages but background ones need
//      the SW to render them.
//   3. Handles notification clicks: routes the user to the right tab in the
//      app via URL hash (which our App.jsx hash-routing reads on load).
//
// IMPORTANT: this file must use importScripts() with full URLs (not ES module
// imports). Service workers don't support the same import syntax as the
// main app and Firebase ships specific compat builds for SW use.
// ─────────────────────────────────────────────────────────────────────────────

/* eslint-disable */

importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

// Firebase config is duplicated here (can't share with main app — different
// execution context). Keep these in sync with src/api/firebase.js. The values
// below are PUBLIC config — apiKey for Firebase is not a secret, it's just an
// identifier (security is enforced via Firestore rules + App Check, not by
// hiding this key).
//
// SETUP NOTE: replace these placeholders by hardcoding the same values that
// your VITE_FIREBASE_* env vars contain. Service workers can't read Vite env
// vars, so they need to be baked in. Find them in:
//   Firebase Console → Project Settings → General → Your apps → Web app config
firebase.initializeApp({
  apiKey:            'REPLACE_WITH_VITE_FIREBASE_API_KEY',
  authDomain:        'REPLACE_WITH_VITE_FIREBASE_AUTH_DOMAIN',
  projectId:         'REPLACE_WITH_VITE_FIREBASE_PROJECT_ID',
  storageBucket:     'REPLACE_WITH_VITE_FIREBASE_STORAGE_BUCKET',
  messagingSenderId: 'REPLACE_WITH_VITE_FIREBASE_MESSAGING_SENDER_ID',
  appId:             'REPLACE_WITH_VITE_FIREBASE_APP_ID',
});

const messaging = firebase.messaging();

// ── Background message handler ──────────────────────────────────────────────
// Fires when a push arrives while the app is closed or in a different tab.
// The payload comes from /api/push (our server-side sender). We expect:
//   notification: { title, body, icon }
//   data:         { deepLink: '#standings' | '#rosters' | etc, eventType: '...' }
messaging.onBackgroundMessage((payload) => {
  // Defensive logging — visible in DevTools → Application → Service Workers
  // → click the SW → Console output. Helps debug iOS quirks.
  console.log('[SW] Background push received:', payload);

  // Payloads are now data-only (see /api/push.js comment for why). Read
  // title/body from the data field. Fall back to notification field for
  // backward compat with any messages still in flight from the old shape.
  const title = payload.data?.title || payload.notification?.title || 'SFGL';
  const body  = payload.data?.body  || payload.notification?.body  || '';

  // Build the notification options. Icon path matches site.webmanifest.
  // Badge falls back to the same icon if a dedicated smaller asset isn't
  // present.
  const options = {
    body,
    icon: '/web-app-manifest-192x192.png',
    badge: '/web-app-manifest-192x192.png',
    // Tag groups notifications: a new push with the same tag replaces the old
    // one. We use eventType so e.g. multiple waiver-result pushes collapse
    // into one rather than stacking up.
    tag: payload.data?.eventType || 'sfgl-generic',
    // data is passed to the notificationclick handler below so we know where
    // to deep-link to.
    data: payload.data || {},
    // Show on iOS even if app is in foreground (default is to suppress)
    requireInteraction: false,
  };

  // Set the home-screen badge indicator. The Badging API doesn't exist on
  // every browser/version, so feature-detect first. We pass no count
  // argument — iOS only renders a dot regardless of value, and on Android
  // Chrome a generic indicator is enough since we don't track precise
  // unread state. The call is best-effort: a failure here mustn't block
  // showing the actual notification banner.
  if ('setAppBadge' in self.navigator) {
    self.navigator.setAppBadge().catch(err => {
      console.log('[SW] setAppBadge failed (non-fatal):', err?.message);
    });
  }

  return self.registration.showNotification(title, options);
});

// ── Notification click handler ──────────────────────────────────────────────
// Routes the user to the right tab when they tap a push. Uses URL hash routing
// (added to App.jsx in a prior batch) so the app lands on the correct view.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const deepLink = event.notification.data?.deepLink || '#standings';
  // Resolve relative to the SW scope — should be the site root in production.
  const targetUrl = new URL(deepLink, self.registration.scope).href;

  // Try to focus an existing open tab before opening a new one. This is the
  // expected behavior on desktop: tap notification → existing tab pops to
  // foreground (and switches to the right view) rather than opening a duplicate.
  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });
    // Look for any SFGL tab that's already open
    for (const client of allClients) {
      const url = new URL(client.url);
      if (url.origin === new URL(targetUrl).origin) {
        // Found one — navigate it to the deep link and focus
        await client.navigate(targetUrl);
        return client.focus();
      }
    }
    // No existing tab — open a new window
    return self.clients.openWindow(targetUrl);
  })());
});
