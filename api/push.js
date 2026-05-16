// api/push.js
// ─────────────────────────────────────────────────────────────────────────────
// Server-side FCM push sender for SFGL.
//
// POST /api/push  (requires Authorization: Bearer ${CRON_SECRET})
//
// Body:
//   {
//     event:      'waiver_won' | 'waiver_lost' | 'lineup_lock' | 'test' | ...
//     title:      string  — notification heading
//     body:       string  — notification body text
//     deepLink:   '#standings' | '#rosters' | '#transactions' | ...
//     recipients: 'all' | string[] — teamIds (or 'all' = every team's tokens)
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
// Authentication: uses the same CRON_SECRET as the rest of api/cron.js, so
// only our own server-side code (cron jobs, AdminView via authenticated
// fetch) can trigger pushes. External callers get 401.
//
// Wave J Round 6: web push notifications, batch 1 (scaffolding). This
// endpoint is callable today but no event triggers are wired up yet — only
// the test push from AdminView.
// ─────────────────────────────────────────────────────────────────────────────

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

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
  const { event, title, body, deepLink, recipients, asCommishOfTeamId } = req.body || {};
  if (!event || !title || !body) {
    return res.status(400).json({ error: 'missing required fields: event, title, body' });
  }
  if (!recipients) {
    return res.status(400).json({ error: 'missing recipients (use "all" or an array of teamIds)' });
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  // Two auth paths:
  //   1. Server-to-server (cron jobs, future event triggers): Bearer CRON_SECRET.
  //      Used for all production push triggers (waiver results etc).
  //   2. Commish-driven test pushes: event must be 'test' AND the request must
  //      include asCommishOfTeamId pointing at a team with isCommissioner=true.
  //      Used by the "Send test push" button in AdminView. The commish can't
  //      send real event pushes — only test pings — through this path.
  //
  // This split avoids exposing CRON_SECRET to the browser while still letting
  // the AdminView test button function. Not bulletproof (someone who knows a
  // commish's teamId could spoof a test push to themselves) but the blast
  // radius is limited to "test" pushes to existing tokens.
  const expectedSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization || '';
  const providedSecret = authHeader.replace(/^Bearer\s+/i, '');
  const isCronAuth = expectedSecret && providedSecret === expectedSecret;

  if (!isCronAuth) {
    // Try the commish-test auth path
    if (event !== 'test') {
      return res.status(401).json({ error: 'unauthorized: non-test events require CRON_SECRET' });
    }
    if (!asCommishOfTeamId) {
      return res.status(401).json({ error: 'unauthorized: test events require asCommishOfTeamId' });
    }
    try {
      const teamSnap = await db.collection('teams').doc(asCommishOfTeamId).get();
      if (!teamSnap.exists || teamSnap.data()?.isCommissioner !== true) {
        return res.status(403).json({ error: 'forbidden: not a commissioner team' });
      }
    } catch (err) {
      console.error('[push] commish auth lookup failed:', err);
      return res.status(500).json({ error: 'auth lookup failed' });
    }
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

  if (tokenDocs.length === 0) {
    return res.status(200).json({ sent: 0, failed: 0, totalTokens: 0, cleanedUp: 0, message: 'no tokens to send to' });
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
      deepLink:  String(deepLink || '#standings'),
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
        link: deepLink ? `https://sfglgolf.com/${deepLink.startsWith('#') ? deepLink : '#' + deepLink}` : 'https://sfglgolf.com/',
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
  });
}
