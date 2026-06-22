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
import { Capacitor } from '@capacitor/core';

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
  if (Capacitor.isNativePlatform()) return true;
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
  if (Capacitor.isNativePlatform()) {
    try { return localStorage.getItem('sfgl.pushToken') ? 'granted' : 'default'; } catch { return 'default'; }
  }
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
// Helper: race a promise against a timeout. Resolves to a sentinel
// { __timeout: true } if the timeout fires first. Used to keep the subscribe
// flow from hanging silently on Android when SW activation or getToken
// never resolves.
const withTimeout = (promise, ms, label) => {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => {
      console.warn(`[push] step "${label}" timed out after ${ms}ms`);
      resolve({ __timeout: true });
    }, ms)),
  ]);
};

// ── Native (Capacitor) push path ────────────
// Inside the iOS/Android app there is no service worker or web-push/VAPID; we
// use the native @capacitor/push-notifications plugin instead. On Android the
// registration token IS the FCM token, so it drops into the same
// `pushTokens/{token}` collection and your existing push.js backend delivers
// to it with no server changes. (iOS will additionally need an APNs key +
// Firebase messaging so its token is also an FCM token — handled later.)
const nativeSubscribe = async (teamId) => {
  console.log('[push] native subscribe START — teamId:', teamId, 'platform:', Capacitor.getPlatform());
  if (!teamId) { console.warn('[push] no teamId'); return { ok: false, reason: 'no_team' }; }

  let PushNotifications;
  try {
    ({ PushNotifications } = await import('@capacitor/push-notifications'));
  } catch (err) {
    console.error('[push] native plugin import failed:', err);
    return { ok: false, reason: 'unsupported' };
  }

  // Permission (Android 13+ and iOS both prompt here).
  let perm;
  try {
    perm = await PushNotifications.checkPermissions();
    if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') {
      perm = await PushNotifications.requestPermissions();
    }
  } catch (err) {
    console.error('[push] native permission error:', err);
    return { ok: false, reason: 'denied' };
  }
  if (perm.receive !== 'granted') {
    console.warn('[push] native permission not granted:', perm.receive);
    return { ok: false, reason: 'denied' };
  }

  // register() resolves immediately; the token arrives via the 'registration'
  // listener. Wait for it (or fail on registrationError / 15s timeout).
  let regHandle, errHandle, resolveToken;
  const tokenPromise = new Promise((resolve) => { resolveToken = resolve; });
  try {
    regHandle = await PushNotifications.addListener('registration', (t) => {
      console.log('[push] native token received, len:', t && t.value && t.value.length);
      resolveToken(t.value);
    });
    errHandle = await PushNotifications.addListener('registrationError', (e) => {
      console.error('[push] native registrationError:', e);
      resolveToken(null);
    });
    await PushNotifications.register();
  } catch (err) {
    console.error('[push] native register failed:', err);
    resolveToken(null);
  }
  const token = await Promise.race([
    tokenPromise,
    new Promise((r) => setTimeout(() => { console.warn('[push] native token wait timed out'); r(null); }, 15000)),
  ]);
  try { regHandle && regHandle.remove(); } catch {}
  try { errHandle && errHandle.remove(); } catch {}

  if (!token) { console.warn('[push] native: no token'); return { ok: false, reason: 'token_failed' }; }

  // Same collection your server already reads — no backend change needed.
  try {
    await setDoc(doc(db, 'pushTokens', token), {
      token,
      teamId,
      userAgent: 'capacitor-' + Capacitor.getPlatform(),
      platform: Capacitor.getPlatform(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }, { merge: true });
  } catch (err) {
    console.error('[push] native save token failed:', err);
    return { ok: false, reason: 'save_failed' };
  }

  try { localStorage.setItem('sfgl.pushToken', token); } catch {}
  console.log('[push] native subscribe COMPLETE');
  return { ok: true, token };
};

const nativeUnsubscribe = async () => {
  let token = null;
  try { token = localStorage.getItem('sfgl.pushToken'); } catch {}
  // No 'revoke token' call exists; deleting the Firestore doc stops the server
  // from targeting this device, which is the goal.
  if (token) {
    try { await deleteDoc(doc(db, 'pushTokens', token)); }
    catch (err) { console.warn('[push] native delete token doc failed:', err); }
  }
  try { localStorage.removeItem('sfgl.pushToken'); } catch {}
  return { ok: true };
};

export const requestPermissionAndSubscribe = async (teamId) => {
  if (Capacitor.isNativePlatform()) return nativeSubscribe(teamId);
  console.log('[push] subscribe START — teamId:', teamId, 'ua:', navigator.userAgent);
  if (!teamId) { console.warn('[push] no teamId'); return { ok: false, reason: 'no_team' }; }
  if (!VAPID_KEY) {
    console.error('[push] VITE_FIREBASE_VAPID_KEY not set — set it in Vercel env vars');
    return { ok: false, reason: 'no_vapid' };
  }

  console.log('[push] step 1: getMessagingInstance');
  const messaging = await getMessagingInstance();
  if (!messaging) {
    console.warn('[push] getMessagingInstance returned null — push unsupported');
    return { ok: false, reason: 'unsupported' };
  }
  console.log('[push] step 1 OK');

  // Ask the browser for permission. On iOS PWA this only works if added to
  // home screen — Safari in regular browsing mode won't prompt.
  console.log('[push] step 2: Notification.requestPermission()');
  let permission;
  try {
    permission = await Notification.requestPermission();
    console.log('[push] step 2 result:', permission);
  } catch (err) {
    console.error('[push] permission request failed:', err);
    return { ok: false, reason: 'denied' };
  }
  if (permission !== 'granted') {
    console.warn('[push] permission not granted:', permission);
    return { ok: false, reason: 'denied' };
  }

  // Register the service worker if not already. Firebase Messaging looks for
  // /firebase-messaging-sw.js at the site root by default. We pass an explicit
  // registration so the SW is available before getToken runs.
  console.log('[push] step 3: register service worker');
  let swRegistration;
  try {
    swRegistration = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
    console.log('[push] step 3 register OK; states — installing:', !!swRegistration.installing,
      'waiting:', !!swRegistration.waiting, 'active:', !!swRegistration.active);
    // Wait until the SW is fully active. getToken can race the registration.
    // 10-second timeout so we don't hang silently if activation never fires
    // (an observed Android failure mode).
    if (swRegistration.installing || swRegistration.waiting) {
      const activationResult = await withTimeout(
        new Promise(resolve => {
          const sw = swRegistration.installing || swRegistration.waiting;
          sw.addEventListener('statechange', () => {
            console.log('[push] sw statechange:', sw.state);
            if (sw.state === 'activated') resolve('activated');
          });
        }),
        10000,
        'sw-activation',
      );
      if (activationResult?.__timeout) {
        console.error('[push] SW activation timed out — proceeding anyway, getToken may still work');
        // Don't abort — sometimes getToken can succeed even without seeing
        // the activated state event. The next step's own timeout will catch
        // a true hang.
      }
    }
    console.log('[push] step 3 OK; active SW:', !!swRegistration.active);
  } catch (err) {
    console.error('[push] service worker registration failed:', err);
    return { ok: false, reason: 'sw_failed' };
  }

  // Request the FCM token. This is a long opaque string that uniquely
  // identifies this device for this Firebase project. 15-second timeout
  // because FCM can hang indefinitely on flaky networks or VAPID misconfigs.
  console.log('[push] step 4: getToken');
  let token;
  try {
    const tokenResult = await withTimeout(
      getToken(messaging, {
        vapidKey: VAPID_KEY,
        serviceWorkerRegistration: swRegistration,
      }),
      15000,
      'getToken',
    );
    if (tokenResult?.__timeout) {
      console.error('[push] getToken timed out — likely FCM connectivity or VAPID issue');
      return { ok: false, reason: 'token_failed' };
    }
    token = tokenResult;
    console.log('[push] step 4 OK; token length:', token?.length);
  } catch (err) {
    console.error('[push] getToken failed:', err);
    return { ok: false, reason: 'token_failed' };
  }
  if (!token) {
    console.warn('[push] getToken returned empty token');
    return { ok: false, reason: 'token_failed' };
  }

  // Collapse STALE tokens this same device previously registered for this
  // team. FCM rotates tokens over time; the old doc (id = old token) lingers
  // and stays briefly deliverable, firing a DUPLICATE push to the one device.
  // Match "same device" via the stored userAgent. Single-field teamId query
  // (no composite index needed) + client-side UA filter. Best-effort.
  try {
    const ua = navigator.userAgent || 'unknown';
    const existing = await getDocs(query(collection(db, 'pushTokens'), where('teamId', '==', teamId)));
    await Promise.all(existing.docs
      .filter(d => d.id !== token && (d.data()?.userAgent || 'unknown') === ua)
      .map(d => deleteDoc(d.ref).catch(() => {})));
  } catch (err) {
    console.warn('[push] stale-token cleanup skipped:', err.message);
  }

  // Store in Firestore. Doc ID = token (so re-subscribing from the same
  // device naturally overwrites, no duplicate-prevention logic needed).
  console.log('[push] step 5: Firestore write');
  try {
    await setDoc(doc(db, 'pushTokens', token), {
      token,
      teamId,
      userAgent: navigator.userAgent || 'unknown',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }, { merge: true });
    console.log('[push] step 5 OK');
  } catch (err) {
    console.error('[push] failed to save token:', err);
    return { ok: false, reason: 'save_failed' };
  }

  // Cache locally so we know we're subscribed without another Firestore read.
  try { localStorage.setItem('sfgl.pushToken', token); } catch {}

  console.log('[push] subscribe COMPLETE');
  return { ok: true, token };
};

/**
 * Unsubscribe this device from pushes. Removes the FCM token from FCM (so
 * Google stops trying to deliver) AND deletes the Firestore record (so the
 * server-side sender doesn't try to target a dead token).
 */
export const unsubscribe = async () => {
  if (Capacitor.isNativePlatform()) return nativeUnsubscribe();
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

/**
 * Admin: read the entire pushTokens collection once and group by teamId.
 * Returns a Map<teamId, Array<tokenDoc>>. Used by the commish console's
 * "Manager Notification Status" view to show who's subscribed and on how
 * many devices. Single collection read — cheap for a 5-team league.
 *
 * Each tokenDoc carries { id (=token), teamId, userAgent, createdAt,
 * updatedAt }, so the UI can show device counts and (optionally) the
 * device type parsed from the userAgent.
 */
export const getAllTokensByTeam = async () => {
  const snap = await getDocs(collection(db, 'pushTokens'));
  const byTeam = new Map();
  snap.docs.forEach(d => {
    const data = { id: d.id, ...d.data() };
    const tid = data.teamId || '(unknown)';
    if (!byTeam.has(tid)) byTeam.set(tid, []);
    byTeam.get(tid).push(data);
  });
  return byTeam;
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
 * Channel-aware preference for a single event on a team. Returns
 * { push: boolean, email: boolean }.
 *
 * BACKWARD COMPATIBILITY: notificationPrefs values were historically a bare
 * boolean (one switch gating both channels). We now store a per-channel
 * object { push, email }. The read layer interprets both shapes:
 *   • object  → use as-is, filling missing channel from the event default
 *   • boolean → legacy: both channels inherit that boolean
 *   • missing → both channels use the event default
 * This means NO data migration is required — old records self-interpret, and
 * new writes use the object shape.
 */
export const getEventChannelPrefs = (team, eventKey) => {
  const event = NOTIFICATION_EVENTS.find(e => e.key === eventKey);
  if (!event) return { push: false, email: false };
  const stored = team?.notificationPrefs?.[eventKey];
  if (stored && typeof stored === 'object') {
    return {
      push:  typeof stored.push  === 'boolean' ? stored.push  : event.default,
      email: typeof stored.email === 'boolean' ? stored.email : event.default,
    };
  }
  if (typeof stored === 'boolean') {
    // Legacy single-switch value — both channels inherit it.
    return { push: stored, email: stored };
  }
  return { push: event.default, email: event.default };
};

/**
 * Effective preference for a single event on a team (LEGACY boolean form).
 * Kept for any caller that still wants a single yes/no — returns true if
 * EITHER channel is enabled. New code should use getEventChannelPrefs.
 */
export const getEventPref = (team, eventKey) => {
  const ch = getEventChannelPrefs(team, eventKey);
  return ch.push || ch.email;
};

/**
 * Channel-aware effective prefs map: every event key → { push, email }.
 * Used by the matrix UI in UserSettingsModal and the commish panel.
 */
export const getEffectiveChannelPrefs = (team) => {
  const map = {};
  NOTIFICATION_EVENTS.forEach(e => { map[e.key] = getEventChannelPrefs(team, e.key); });
  return map;
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
 * Pure helper: given a team's existing notificationPrefs, produce a new prefs
 * map with one event's one channel flipped to `value`. Normalizes any legacy
 * boolean entry into the { push, email } object shape in the process, so the
 * write always lands in the new format. Does not mutate the input.
 *
 * @param {Object} team       — the team whose prefs are being edited
 * @param {string} eventKey   — which event
 * @param {'push'|'email'} channel
 * @param {boolean} value     — new value for that channel
 * @returns {Object} the new notificationPrefs map to persist
 */
export const buildChannelPrefUpdate = (team, eventKey, channel, value) => {
  const current = getEventChannelPrefs(team, eventKey); // normalized { push, email }
  const updatedEvent = { ...current, [channel]: value };
  return { ...(team?.notificationPrefs || {}), [eventKey]: updatedEvent };
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
