// src/api/pushNotifications.js
// ─────────────────────────────────────────────────────────────────────────────
// Client-side FCM helper for SFGL.
//
// Public API:
//   isPushSupported()                      — feature detect
//   getNotificationPermission()            — 'default' | 'granted' | 'denied'
//   requestPermissionAndSubscribe(teamId)  — prompts user, stores token
//   unsubscribe(teamId)                    — removes token + clears state
//   getCurrentToken()                      — returns the FCM token if cached
//   getTokensForTeam(teamId)               — admin: list a team's tokens
//
// Architecture notes:
//   • Tokens are stored in Firestore collection `pushTokens/{token}` (token
//     itself is the doc ID — naturally deduplicates re-subscriptions from
//     the same device, since the same browser returns the same token).
//   • Each token doc has: { teamId, createdAt, updatedAt, userAgent }
//   • Foreground messages are handled directly here via onMessage. Background
//     messages go through the service worker at /firebase-messaging-sw.js.
//   • iOS web push requires the PWA to be installed to home screen AND iOS
//     16.4+. We don't try to detect or surface this — the permission prompt
//     just silently fails on browsers where push isn't supported.
// ─────────────────────────────────────────────────────────────────────────────

import { initializeApp, getApps } from 'firebase/app';
import { getMessaging, getToken, onMessage, isSupported, deleteToken } from 'firebase/messaging';
import { doc, setDoc, deleteDoc, getDocs, query, where, collection, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';

// Reuse the same Firebase app instance the rest of the app uses. We can't
// import `app` directly from firebase.js (it's not exported), but we can
// retrieve it via getApps()[0] since firebase.js initialized it on load.
const getApp = () => {
  const apps = getApps();
  if (apps.length === 0) {
    throw new Error('Firebase app not initialized — make sure firebase.js loads before pushNotifications.js');
  }
  return apps[0];
};

// VAPID public key — generated in Firebase Console → Project Settings →
// Cloud Messaging → Web Push certificates → Generate key pair.
// Stored in Vercel env vars as VITE_FIREBASE_VAPID_KEY so it's bundled into
// the client at build time. If unset, subscription attempts will fail with
// a clear error (rather than silently registering bad tokens).
const VAPID_KEY = import.meta.env.VITE_FIREBASE_VAPID_KEY;

// Lazy-init messaging. Service workers aren't always ready on first call;
// we await isSupported() before touching the messaging API to avoid throws
// on unsupported browsers (Safari < 16.4 without home-screen install, etc).
let _messaging = null;
const getMessagingInstance = async () => {
  if (_messaging) return _messaging;
  const supported = await isSupported();
  if (!supported) return null;
  _messaging = getMessaging(getApp());
  return _messaging;
};

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Whether push notifications are supported in this browser/context.
 * Returns false in Safari without home-screen install, very old Chrome, etc.
 */
export const isPushSupported = async () => {
  try {
    return await isSupported();
  } catch {
    return false;
  }
};

/**
 * Current permission state: 'default' (not yet asked), 'granted', or 'denied'.
 * Returns 'unsupported' when the browser doesn't expose Notification API.
 */
export const getNotificationPermission = () => {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
};

/**
 * Request notification permission from the user, then register a token in
 * Firestore tied to this team.
 *
 * Returns { ok: true, token } on success, or { ok: false, reason } on failure.
 * `reason` is one of:
 *   'unsupported'  — push not supported in this browser/context
 *   'denied'       — user clicked "Block" on the permission prompt
 *   'no_vapid'     — VITE_FIREBASE_VAPID_KEY env var not set (server config error)
 *   'sw_failed'    — service worker registration failed
 *   'token_failed' — FCM rejected the token request
 *   'save_failed'  — Firestore write failed
 */
export const requestPermissionAndSubscribe = async (teamId) => {
  if (!teamId) return { ok: false, reason: 'no_team' };
  if (!VAPID_KEY) {
    console.error('[push] VITE_FIREBASE_VAPID_KEY not set — set it in Vercel env vars');
    return { ok: false, reason: 'no_vapid' };
  }

  const messaging = await getMessagingInstance();
  if (!messaging) return { ok: false, reason: 'unsupported' };

  // Ask the browser for permission. On iOS PWA this only works if added to
  // home screen — Safari in regular browsing mode won't prompt.
  let permission;
  try {
    permission = await Notification.requestPermission();
  } catch (err) {
    console.error('[push] permission request failed:', err);
    return { ok: false, reason: 'denied' };
  }
  if (permission !== 'granted') {
    return { ok: false, reason: 'denied' };
  }

  // Register the service worker if not already. Firebase Messaging looks for
  // /firebase-messaging-sw.js at the site root by default. We pass an explicit
  // registration so the SW is available before getToken runs.
  let swRegistration;
  try {
    swRegistration = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
    // Wait until the SW is fully active. getToken can race the registration.
    if (swRegistration.installing || swRegistration.waiting) {
      await new Promise(resolve => {
        const sw = swRegistration.installing || swRegistration.waiting;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'activated') resolve();
        });
      });
    }
  } catch (err) {
    console.error('[push] service worker registration failed:', err);
    return { ok: false, reason: 'sw_failed' };
  }

  // Request the FCM token. This is a long opaque string that uniquely
  // identifies this device for this Firebase project.
  let token;
  try {
    token = await getToken(messaging, {
      vapidKey: VAPID_KEY,
      serviceWorkerRegistration: swRegistration,
    });
  } catch (err) {
    console.error('[push] getToken failed:', err);
    return { ok: false, reason: 'token_failed' };
  }
  if (!token) return { ok: false, reason: 'token_failed' };

  // Store in Firestore. Doc ID = token (so re-subscribing from the same
  // device naturally overwrites, no duplicate-prevention logic needed).
  try {
    await setDoc(doc(db, 'pushTokens', token), {
      token,
      teamId,
      userAgent: navigator.userAgent || 'unknown',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }, { merge: true });
  } catch (err) {
    console.error('[push] failed to save token:', err);
    return { ok: false, reason: 'save_failed' };
  }

  // Cache locally so we know we're subscribed without another Firestore read.
  try { localStorage.setItem('sfgl.pushToken', token); } catch {}

  return { ok: true, token };
};

/**
 * Unsubscribe this device from pushes. Removes the FCM token from FCM (so
 * Google stops trying to deliver) AND deletes the Firestore record (so the
 * server-side sender doesn't try to target a dead token).
 */
export const unsubscribe = async () => {
  const messaging = await getMessagingInstance();
  if (!messaging) return { ok: false, reason: 'unsupported' };

  // Pull cached token first so we can clean up Firestore even if deleteToken
  // changes things underneath us.
  let token = null;
  try { token = localStorage.getItem('sfgl.pushToken'); } catch {}
  if (!token) {
    try { token = await getToken(messaging, { vapidKey: VAPID_KEY }); } catch {}
  }

  // Revoke at the FCM layer. Safe to fail silently — if the token was already
  // gone, deleteToken throws, but our goal (no more pushes to this device)
  // is achieved either way.
  try { await deleteToken(messaging); } catch (err) { console.warn('[push] deleteToken failed:', err); }

  // Remove from Firestore so the server-side sender stops targeting it.
  if (token) {
    try { await deleteDoc(doc(db, 'pushTokens', token)); } catch (err) {
      console.warn('[push] failed to delete token doc:', err);
    }
  }

  try { localStorage.removeItem('sfgl.pushToken'); } catch {}
  return { ok: true };
};

/**
 * Returns the currently-cached FCM token for this device, or null. Reads
 * from localStorage — doesn't hit FCM or Firestore. Use this to display the
 * subscription status in the UI without a round-trip.
 */
export const getCurrentToken = () => {
  try { return localStorage.getItem('sfgl.pushToken'); } catch { return null; }
};

/**
 * Admin/debug: list all FCM tokens registered to a given team.
 */
export const getTokensForTeam = async (teamId) => {
  const q = query(collection(db, 'pushTokens'), where('teamId', '==', teamId));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
};

// ── Notification preferences (Wave J Round 6 batch 3) ──────────────────────
// Per-team, per-event toggles stored at team.notificationPrefs. Missing keys
// fall through to defaults (most are ON; batch 4 events are OFF).
//
// Used by the UserSettingsModal to render the toggle UI.

// Event definitions — single source of truth for label, description, and
// default. Server-side cron.js + push.js mirror this DEFAULTS_ON set, so
// keep the three in sync when adding new events.
//
// All current events default ON. The `batch` field is historical (which
// release the event was wired in) and isn't used at runtime — kept for
// readability.
export const NOTIFICATION_EVENTS = [
  { key: 'waivers',         label: 'Waiver results',       desc: 'Weekly waiver round summary',              batch: 4, default: true },
  { key: 'lineupLock',      label: 'Lineup lock reminder', desc: "You haven't set a lineup yet",             batch: 3, default: true },
  { key: 'freeAgent',       label: 'Free agent activity',  desc: 'Any team adds or drops a free agent',      batch: 4, default: true },
  { key: 'results',         label: 'Tournament results',   desc: 'Tournament results are processed',         batch: 4, default: true },
  { key: 'commishModified', label: 'Commish edited roster', desc: 'A commissioner modified your team',       batch: 3, default: true },
  // leadChange — fires when one of your starting lineup players takes the
  // outright lead OR joins a tied-for-1st group during round 2 or later.
  // Server-side cron (?action=lead-watch) polls every 10 minutes during a
  // live tournament. Rate-limited to one ping per team+player per 30 min.
  { key: 'leadChange',      label: 'Player takes the lead', desc: 'A starting lineup player takes the lead (round 2+)', batch: 5, default: true },
];

/**
 * Effective preference for a single event on a team. Honors stored value;
 * falls through to the event's default if unset.
 */
export const getEventPref = (team, eventKey) => {
  const event = NOTIFICATION_EVENTS.find(e => e.key === eventKey);
  if (!event) return false;
  const stored = team?.notificationPrefs?.[eventKey];
  if (typeof stored === 'boolean') return stored;
  return event.default;
};

/**
 * Effective prefs map for a team — every known event key mapped to its
 * effective (stored-or-default) boolean. Used by the modal to render the
 * toggles with the right initial state.
 */
export const getEffectivePrefs = (team) => {
  const map = {};
  NOTIFICATION_EVENTS.forEach(e => { map[e.key] = getEventPref(team, e.key); });
  return map;
};

/**
 * Trigger a commish-authorized push (test or commishModified events).
 *
 * Used by AdminView (test pushes) and TransactionsView (when commish modifies
 * a manager's roster). Uses the same commish-team-lookup auth as test pushes
 * — no CRON_SECRET required client-side.
 *
 * @param {Object} opts
 * @param {string} opts.event            — 'test' or 'commishModified'
 * @param {string} opts.commishTeamId    — current commish's teamId (auth check)
 * @param {string|string[]} opts.recipients — 'all' or array of teamIds
 * @param {string} opts.title            — notification heading
 * @param {string} opts.body             — notification body
 * @param {string} [opts.deepLink]       — optional URL hash
 */
export const sendCommishPush = async ({ event, commishTeamId, recipients, title, body, deepLink = '#standings' }) => {
  const resp = await fetch('/api/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event,
      title,
      body,
      deepLink,
      recipients,
      asCommishOfTeamId: commishTeamId,
    }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data.error || `HTTP ${resp.status}`);
  }
  return data;
};

/**
 * Trigger a manager-authorized push. Used for events any manager can
 * dispatch — currently 'freeAgent' (FA add/drop broadcast) and 'results'
 * (tournament results broadcast).
 *
 * Auth: just verifies the asTeamId is a real team in the league (no
 * commissioner check). Suitable for a small trusted league. The event
 * type whitelist on the server (MANAGER_ALLOWED_EVENTS) bounds what
 * events this path can trigger, so a spoofed team ID still can't send
 * arbitrary push types.
 *
 * @param {Object} opts
 * @param {string} opts.event       — 'freeAgent' or 'results'
 * @param {string} opts.teamId      — the manager's own teamId (auth check)
 * @param {string|string[]} opts.recipients — 'all' or array of teamIds
 * @param {string} opts.title
 * @param {string} opts.body
 * @param {string} [opts.deepLink]
 */
export const sendManagerPush = async ({ event, teamId, recipients, title, body, deepLink = '#standings' }) => {
  const resp = await fetch('/api/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event,
      title,
      body,
      deepLink,
      recipients,
      asTeamId: teamId,
    }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data.error || `HTTP ${resp.status}`);
  }
  return data;
};

/**
 * Trigger a test push from the commissioner's AdminView.
 *
 * Calls /api/push with event='test', which uses a lighter auth check
 * (verifies the commish's team has isCommissioner=true) instead of
 * requiring the CRON_SECRET. This lets the test button work without
 * exposing the secret to the browser.
 *
 * @param {Object} opts
 * @param {string} opts.commishTeamId    — current commish's teamId (auth check)
 * @param {string|string[]} opts.recipients — 'all' or array of teamIds
 * @param {string} opts.title            — notification heading
 * @param {string} opts.body             — notification body
 * @param {string} [opts.deepLink]       — optional URL hash to navigate to
 *
 * Returns the API response: { sent, failed, totalTokens, cleanedUp }.
 */
export const sendTestPush = async ({ commishTeamId, recipients, title, body, deepLink = '#standings' }) => {
  return sendCommishPush({ event: 'test', commishTeamId, recipients, title, body, deepLink });
};

// ── Foreground message handler (auto-bound on import) ───────────────────────
// When the app is OPEN and focused, FCM does NOT show a notification by default
// — it just fires onMessage. We bind a default handler that surfaces these as
// browser notifications too, so the user gets feedback regardless of whether
// they're looking at the app or not.
//
// Bound lazily so we don't trigger isSupported() at module load time.
let _foregroundHandlerBound = false;
const bindForegroundHandler = async () => {
  if (_foregroundHandlerBound) return;
  const messaging = await getMessagingInstance();
  if (!messaging) return;
  onMessage(messaging, (payload) => {
    console.log('[push] foreground message:', payload);
    // Display via Notification API directly. The service worker would handle
    // this if the app were closed, but in foreground we need to render
    // the notification ourselves.
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const title = payload.notification?.title || 'SFGL';
    const body  = payload.notification?.body  || '';
    try {
      new Notification(title, {
        body,
        icon: '/web-app-manifest-192x192.png',
        tag: payload.data?.eventType || 'sfgl-generic',
        data: payload.data || {},
      });
    } catch (err) {
      console.warn('[push] failed to render foreground notification:', err);
    }
  });
  _foregroundHandlerBound = true;
};

// Auto-bind on import. Failures are silent (unsupported browsers etc).
bindForegroundHandler().catch(() => {});
