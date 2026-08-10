// src/api/pushSend.js
// ─────────────────────────────────────────────────────────────────────────────
// Outbound push TRIGGERS. Three thin POSTs to /api/push and nothing else — no
// Firebase SDK, no browser permission state, no token storage.
//
// Split out of pushNotifications.js, which imports firebase/messaging at module
// scope. Two modals on the app's critical path (Add/Drop and Add Transaction)
// import nothing from that file except these senders, and the import alone was
// pulling @firebase/messaging and @firebase/installations into the main bundle
// on every first load — for three fetch() calls. The server does the actual
// sending; the client only asks.
//
// pushNotifications.js re-exports all three, so code that already has the FCM
// module loaded (the notification settings modal, the admin panels) can keep
// treating it as the single import surface for anything push-related.
// ─────────────────────────────────────────────────────────────────────────────

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

