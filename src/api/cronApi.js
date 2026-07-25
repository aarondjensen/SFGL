// src/api/cronApi.js
// ============================================================================
// Authenticated client → /api/cron caller.
//
// Four cron actions are invoked from the browser rather than by the scheduler
// (notify-results, pgat-stats, sync-cron-schedule, resync-legacy-tournaments).
// They used to be listed in NO_AUTH_ACTIONS and ran with no authentication at
// all, which meant anyone on the internet could:
//   • notify-results  → send arbitrary email to every manager from the
//                       league's own domain (the body is caller-supplied),
//   • sync-cron-schedule → rewrite the league's cron-job.org schedules,
//   • resync-legacy-tournaments → force a Firestore write,
//   • pgat-stats      → burn the scraping budget.
//
// All four are commissioner-only operations, and the caller is already signed
// in with Firebase, so we send the user's ID token and let the server verify
// it (Admin SDK verifyIdToken + the `commissioner` custom claim — the same
// claim the app's own commish gate uses). See requireCommissioner in
// api/cron.js.
// ============================================================================

import { auth } from './_init';

/**
 * Call /api/cron?action=<action> with the signed-in user's Firebase ID token.
 *
 * @param {string} action  cron action name
 * @param {object} [opts]  { method, body } — body is JSON-serialized when given
 * @returns {Promise<Response>} the raw fetch Response, so callers keep their
 *          existing `resp.ok` / `resp.json()` handling.
 */
export async function cronFetch(action, opts = {}) {
  const { method = 'GET', body } = opts;

  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  // Attach the ID token when signed in. Not fatal if absent — the server
  // returns 401 with a clear message, which the existing error paths surface.
  try {
    const token = await auth.currentUser?.getIdToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch (e) {
    console.warn('[cronApi] could not read ID token:', e?.message || e);
  }

  return fetch(`/api/cron?action=${encodeURIComponent(action)}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
