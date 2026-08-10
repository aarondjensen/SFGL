// src/utils/swingAward.js
// ============================================================================
// The swing-award logic now lives in api/_rules.js, so api/cron.js's
// maybeAutoAwardSwingServer and this client path are one function rather than
// two implementations of the same rules. The header of this file used to say
// "api/cron.js inlines a server-side copy — keep them in sync"; it no longer
// does, because there is no copy.
//
// Re-exported here so TournamentResultsPanel, SwingWinnerPanel and AdminView
// keep their existing import path.
// ============================================================================

export { computeSwingAward, maybeAwardForCompletedTournament } from '../../api/_rules.js';
