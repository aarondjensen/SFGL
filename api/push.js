// api/push.js
// ─────────────────────────────────────────────────────────────────────────────
// Server-side FCM push sender for SFGL.
//
// POST /api/push
//
// Body:
//   {
//     event:      'test' | 'commishModified' | 'results' | 'freeAgent' | ...
//     title:      string  — notification heading (CRON_SECRET / commish paths only)
//     body:       string  — notification body text (CRON_SECRET / commish paths only)
//     deepLink:   '#standings' | '#rosters' | '#transactions' | ...
//     recipients: 'all' | string[] — teamIds (or 'all' = every team's tokens)
//     asTeamId:   string  — acting team (freeAgent path)
//     playerName / droppedPlayerName: strings — freeAgent structured fields;
//                 the push text is composed server-side from these (managers
//                 can NOT send free-text title/body)
//   }
//
// Returns:
//   {
//     sent:         number  — successful deliveries
//     failed:       number  — failed deliveries (token rejected, etc)
//     totalTokens:  number  — how many tokens were attempted
//     cleanedUp:    number  — invalid tokens that were removed from Firestore
//   }
//
// Authentication (see the Auth section in the handler):
//   1. CRON_SECRET — server-to-server (cron jobs).
//   2. Firebase ID token with the commissioner custom claim — commish events.
//   3. Firebase ID token of any signed-in manager — freeAgent broadcasts.
// ─────────────────────────────────────────────────────────────────────────────

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { getAuth } from 'firebase-admin/auth';
import { DEFAULTS_ON, dedupeTokenDocs } from './_constants.js';

// ── Firebase Admin init (mirrors api/cron.js pattern) ───────────────────────
function getApp() {
  if (getApps().length) return getApps()[0];
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!sa) throw new Error('FIREBASE_SERVICE_ACCOUNT env var not set');
  return initializeApp({ credential: cert(JSON.parse(sa)) });
}

const db = getFirestore(getApp());
const messaging = getMessaging(getApp());

export default async function handler(req, res) {
  // CORS preflight
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  // ── Parse + validate ──────────────────────────────────────────────────────
  const { event, deepLink, recipients, asTeamId, playerName, droppedPlayerName } = req.body || {};
  let { title, body } = req.body || {};
  if (!event) {
    return res.status(400).json({ error: 'missing required field: event' });
  }
  if (!recipients) {
    return res.status(400).json({ error: 'missing recipients (use "all" or an array of teamIds)' });
  }

  // Strip control chars + cap length on anything that ends up in a
  // notification. Used for the freeAgent structured fields below.
  const clean = (s, max) => typeof s === 'string'
    ? s.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max)
    : '';

  // deepLink feeds both the SW payload and the fcmOptions.link URL — constrain
  // it to an in-app hash route so a caller can't smuggle in an arbitrary value.
  const safeDeepLink = typeof deepLink === 'string' && /^#[\w-]{1,64}$/.test(deepLink)
    ? deepLink
    : '#standings';

  // ── Auth ──────────────────────────────────────────────────────────────────
  // Three auth paths (most → least privileged):
  //   1. CRON_SECRET (server-to-server). Trusted, can send any event to anyone
  //      with caller-supplied title/body. Used by cron jobs (waivers,
  //      lineup-reminder, process-results).
  //   2. Commissioner Firebase ID token (custom claim commissioner === true —
  //      the same claim stamped via cron.js stamp-commissioner and read by
  //      src/api/authApi.js). Whitelisted commish events, caller-supplied
  //      title/body. Replaces the old asCommishOfTeamId + team.isCommissioner
  //      check, which any client could satisfy by writing the flag onto a team
  //      doc it controlled.
  //   3. Manager Firebase ID token (any signed-in league account) for the
  //      freeAgent broadcast. The push text is composed SERVER-side from the
  //      team doc + structured player fields — a manager cannot send free-text
  //      title/body to the league. If the acting team has a claim doc, the
  //      token's uid must own it (commissioners are exempt).
  const COMMISH_ALLOWED_EVENTS = new Set([
    'test',             // diagnostic pushes from AdminView
    'commishModified',  // commish-modified-roster pushes from TransactionsView
    'results',          // tournament results pushes from TournamentResultsPanel
  ]);
  const MANAGER_ALLOWED_EVENTS = new Set([
    'freeAgent',        // FA add/drop broadcasts from AddDropPlayerModal
  ]);
  const expectedSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization || '';
  const providedToken = authHeader.replace(/^Bearer\s+/i, '');
  const isCronAuth = expectedSecret && providedToken === expectedSecret;

  if (!isCronAuth) {
    // Both browser paths present a Firebase ID token in the same header.
    let decoded = null;
    if (providedToken) {
      try {
        decoded = await getAuth(getApp()).verifyIdToken(providedToken);
      } catch {
        decoded = null;
      }
    }
    if (!decoded) {
      return res.status(401).json({ error: 'unauthorized: sign-in required' });
    }

    if (COMMISH_ALLOWED_EVENTS.has(event)) {
      if (decoded.commissioner !== true) {
        return res.status(403).json({ error: `forbidden: '${event}' events require the commissioner` });
      }
      if (!title || !body) {
        return res.status(400).json({ error: 'missing required fields: title, body' });
      }
    } else if (MANAGER_ALLOWED_EVENTS.has(event)) {
      if (!asTeamId) {
        return res.status(401).json({ error: `unauthorized: '${event}' events require asTeamId` });
      }
      let teamName;
      try {
        const teamSnap = await db.collection('teams').doc(asTeamId).get();
        if (!teamSnap.exists) {
          return res.status(403).json({ error: 'forbidden: team not found' });
        }
        teamName = teamSnap.data()?.name || asTeamId;
        // If the team is claimed, only its owner (or the commissioner) may
        // broadcast as it. Unclaimed teams fall through — any signed-in
        // league account can act for them (5-person trusted league).
        const claimSnap = await db.collection('team_claims').doc(asTeamId).get();
        const claimUid = claimSnap.exists ? claimSnap.data()?.uid : null;
        if (claimUid && claimUid !== decoded.uid && decoded.commissioner !== true) {
          return res.status(403).json({ error: 'forbidden: not your team' });
        }
      } catch (err) {
        console.error('[push] manager auth lookup failed:', err);
        return res.status(500).json({ error: 'auth lookup failed' });
      }
      // Compose the push text server-side. Only the player names come from
      // the request, and they're control-stripped + length-capped.
      const added = clean(playerName, 60);
      if (!added) {
        return res.status(400).json({ error: `'${event}' events require playerName` });
      }
      const droppedClean = clean(droppedPlayerName, 60);
      title = `🔄 ${teamName}`;
      body = droppedClean ? `+${added} / -${droppedClean}` : `+${added}`;
    } else {
      return res.status(401).json({ error: `unauthorized: event '${event}' requires CRON_SECRET` });
    }
  }

  if (!title || !body) {
    return res.status(400).json({ error: 'missing required fields: title, body' });
  }

  // ── Resolve recipients → list of FCM tokens ──────────────────────────────
  let tokenDocs = [];
  try {
    if (recipients === 'all') {
      // Fetch every token in the system
      const snap = await db.collection('pushTokens').get();
      tokenDocs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } else if (Array.isArray(recipients)) {
      // Firestore 'in' query supports up to 30 elements; chunk if needed.
      // For a 5-team league we'll never hit this, but guard anyway.
      const chunks = [];
      for (let i = 0; i < recipients.length; i += 30) {
        chunks.push(recipients.slice(i, i + 30));
      }
      for (const chunk of chunks) {
        const snap = await db.collection('pushTokens').where('teamId', 'in', chunk).get();
        tokenDocs.push(...snap.docs.map(d => ({ id: d.id, ...d.data() })));
      }
    } else {
      return res.status(400).json({ error: 'recipients must be "all" or an array of teamIds' });
    }
  } catch (err) {
    console.error('[push] failed to fetch tokens:', err);
    return res.status(500).json({ error: 'failed to fetch recipient tokens', details: err.message });
  }

  // Collapse to one delivery per physical device before sending, so a device
  // with a lingering rotated-token doc isn't notified twice. Shared logic in
  // _constants.js (same collapse cron.js uses).
  tokenDocs = dedupeTokenDocs(tokenDocs);

  // ── Apply per-event preferences (Wave J Round 6 batch 3-4) ─────────────
  // Each team can disable specific event types via team.notificationPrefs.
  // We filter the token list here before sending.
  //
  // Special cases:
  //   • event='test' → bypass prefs entirely (diagnostic must always deliver)
  //   • event in DEFAULTS_ON → fire unless explicit prefs[event] === false
  //   • event not in DEFAULTS_ON → require explicit opt-in (default OFF)
  //     [all current events are in DEFAULTS_ON; this branch is reserved for
  //      future event types if we add any default-OFF ones]
  //
  // We batch-load all relevant team docs once instead of one Firestore read
  // per token, since multiple tokens from the same team would otherwise
  // duplicate the lookup.
  //
  // DEFAULTS_ON is imported from ./_constants.js (shared with api/cron.js).
  // The client mirror is src/api/pushNotifications.js NOTIFICATION_EVENTS;
  // keep that one in sync when adding a new default-on event.
  let skipped = 0;
  if (event !== 'test' && tokenDocs.length > 0) {
    const teamIds = [...new Set(tokenDocs.map(t => t.teamId).filter(Boolean))];
    const teamPrefs = {};  // teamId → prefs map
    try {
      // Batch-load — chunked by 30 (Firestore 'in' limit)
      for (let i = 0; i < teamIds.length; i += 30) {
        const chunk = teamIds.slice(i, i + 30);
        const teamSnap = await db.collection('teams').where('__name__', 'in', chunk).get();
        teamSnap.forEach(d => { teamPrefs[d.id] = d.data()?.notificationPrefs || {}; });
      }
    } catch (err) {
      console.warn('[push] prefs batch load failed:', err.message);
      // On lookup failure, fail safe by dropping all sends
      return res.status(500).json({ error: 'prefs lookup failed', details: err.message });
    }
    const before = tokenDocs.length;
    tokenDocs = tokenDocs.filter(t => {
      const prefs = teamPrefs[t.teamId];
      if (!prefs) return DEFAULTS_ON.has(event);  // no prefs map → defaults
      if (typeof prefs[event] === 'boolean') return prefs[event];
      return DEFAULTS_ON.has(event);  // unset key → defaults
    });
    skipped = before - tokenDocs.length;
  }

  if (tokenDocs.length === 0) {
    return res.status(200).json({ sent: 0, failed: 0, totalTokens: 0, cleanedUp: 0, skipped, message: skipped > 0 ? 'all recipients opted out' : 'no tokens to send to' });
  }

  // ── Build the FCM message payload ────────────────────────────────────────
  const buildMessage = (token) => ({
    token,
    notification: {
      title,
      body,
    },
    // `data` carries extra structured payload available to the service worker.
    // FCM requires all data values to be strings — we coerce here.
    data: {
      eventType: String(event),
      deepLink:  safeDeepLink,
    },
    // Web-specific options: icon path, click action handled by SW.
    webpush: {
      notification: {
        icon: '/web-app-manifest-192x192.png',
        badge: '/web-app-manifest-192x192.png',
      },
      fcmOptions: {
        // The link FCM will open when the notification is clicked. This is a
        // fallback for browsers that don't have a service worker handler.
        // safeDeepLink is always a validated '#route' hash.
        link: `https://sfglgolf.com/${safeDeepLink}`,
      },
    },
  });

  // ── Send in parallel, collect results ────────────────────────────────────
  let sent = 0;
  let failed = 0;
  const invalidTokens = [];  // tokens to clean up from Firestore

  await Promise.all(tokenDocs.map(async (doc) => {
    try {
      await messaging.send(buildMessage(doc.token || doc.id));
      sent++;
    } catch (err) {
      failed++;
      // FCM error codes that mean "this token is permanently dead":
      //   messaging/registration-token-not-registered
      //   messaging/invalid-registration-token
      //   messaging/invalid-argument (sometimes — token format wrong)
      const code = err.errorInfo?.code || err.code || '';
      const isDead = code.includes('registration-token-not-registered') ||
                     code.includes('invalid-registration-token');
      if (isDead) {
        invalidTokens.push(doc.id);
      } else {
        console.warn(`[push] send failed (${code}):`, err.message);
      }
    }
  }));

  // ── Clean up invalid tokens ──────────────────────────────────────────────
  // Delete Firestore docs for tokens FCM said are dead. Prevents repeated
  // failures on every push, and keeps the token collection clean.
  let cleanedUp = 0;
  if (invalidTokens.length > 0) {
    const batch = db.batch();
    invalidTokens.forEach(id => batch.delete(db.collection('pushTokens').doc(id)));
    try {
      await batch.commit();
      cleanedUp = invalidTokens.length;
    } catch (err) {
      console.warn('[push] failed to clean up invalid tokens:', err);
    }
  }

  return res.status(200).json({
    sent,
    failed,
    totalTokens: tokenDocs.length,
    cleanedUp,
    skipped,
  });
}
