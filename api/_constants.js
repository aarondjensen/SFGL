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
