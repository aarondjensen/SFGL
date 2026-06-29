// api/_constants.js — shared constants for serverless functions.
// ============================================================================
// Single source of truth for values that were previously duplicated across
// multiple /api functions. The leading underscore tells Vercel NOT to treat
// this file as a routable serverless function; it is only ever imported by
// sibling functions (cron.js, push.js), so it doesn't count against the
// Hobby-plan function cap.
//
// Previously DEFAULTS_ON was hand-copied into both api/cron.js and api/push.js
// with a "keep these in sync" comment. Importing it from here removes that
// hazard — change the set once and both senders pick it up.
// ============================================================================

// Notification events that are ON by default when a team has no explicit
// per-event preference stored.
//   • team has no prefs map at all        → fall through to these defaults
//   • event present in this set           → fire unless prefs[event] === false
//   • event NOT in this set               → require explicit opt-in (default OFF)
//
// NOTE: the client mirror lives in src/api/pushNotifications.js as the
// per-event `default: true` flags on each NOTIFICATION_EVENTS entry. That file
// is a different deploy target (Vite-bundled, runs in the browser) and uses a
// richer object shape for the settings UI, so it intentionally isn't imported
// here. When adding a new default-on event, update both this set and the
// matching pushNotifications.js entry.
export const DEFAULTS_ON = new Set([
  'waivers', 'lineupLock', 'freeAgent', 'results', 'commishModified', 'leadChange',
]);

// ── Push-token de-duplication ───────────────────────────────────────────────
// A single physical device can end up with MORE THAN ONE deliverable pushTokens
// doc, which makes that device receive the same push twice. Two causes:
//   (1) the exact same FCM token written to two docs (defensive), and
//   (2) FCM token ROTATION — the device re-registers under a fresh token and
//       the previous doc lingers, still briefly deliverable.
// Both senders (cron.js handleLeadWatch → sendPushToTeam, and push.js) must
// collapse to ONE delivery per device before calling messaging.send(), or the
// phone double-fires (e.g. the round-leader "is in the lead!" push arriving
// twice). This is the single source of truth for that collapse.

// Normalize a Firestore/JS timestamp to epoch millis. Handles Firestore
// Timestamp objects (admin + web shapes), Date, number, and ISO strings.
export function tsMillis(v) {
  if (!v) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isFinite(t) ? t : 0; }
  if (typeof v.toMillis === 'function') { try { return v.toMillis(); } catch { return 0; } }
  if (typeof v._seconds === 'number') return v._seconds * 1000 + Math.floor((v._nanoseconds || 0) / 1e6);
  if (typeof v.seconds === 'number') return v.seconds * 1000 + Math.floor((v.nanoseconds || 0) / 1e6);
  if (v instanceof Date) return v.getTime();
  return 0;
}

// Collapse a list of pushTokens docs to one-per-device. Within each device
// group the NEWEST doc (by updatedAt, then createdAt) wins; older siblings are
// dropped from THIS send only — they are NOT deleted here (registration-side
// cleanup + dead-token pruning handle removal). Device grouping precedence:
//   • stable `deviceId` when present (new docs; exact device key), else
//   • `userAgent` scoped by teamId (legacy docs predating deviceId — this is
//     what catches the rotation case where the token differs but the device is
//     the same), else
//   • the token string itself (never collapse unknown-UA docs together).
// A first pass also collapses byte-identical token strings, since sending to
// the same FCM token twice always double-fires regardless of doc shape.
export function dedupeTokenDocs(tokenDocs) {
  if (!Array.isArray(tokenDocs) || tokenDocs.length < 2) return tokenDocs || [];

  const newer = (a, b) =>
    tsMillis(a.updatedAt || a.createdAt) >= tsMillis(b.updatedAt || b.createdAt);

  // Pass 1 — identical FCM token string ⇒ same device.
  const byToken = new Map();
  for (const d of tokenDocs) {
    const tok = d.token || d.id;
    if (!tok) continue;
    const prev = byToken.get(tok);
    if (!prev || newer(d, prev)) byToken.set(tok, d);
  }

  // Pass 2 — same device under a rotated token.
  const byDevice = new Map();
  for (const d of byToken.values()) {
    const key = d.deviceId
      ? `dev:${d.deviceId}`
      : (d.userAgent ? `ua:${d.teamId || ''}:${d.userAgent}` : `tok:${d.token || d.id}`);
    const prev = byDevice.get(key);
    if (!prev || newer(d, prev)) byDevice.set(key, d);
  }

  return [...byDevice.values()];
}
