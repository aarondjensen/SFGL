// src/hooks/useUserTeam.js
// ============================================================================
// Resolve the signed-in manager's team.
//
// AccountModal and UserSettingsModal each carried an identical copy of this
// lookup, and both copies ended in the same fallback:
//
//     (loggedInTeamId && teams.find(t => t.id === loggedInTeamId)) ||
//     teams.find(t => t.owner === loggedInUser) ||
//     null
//
// That second clause is the pattern App.jsx explicitly warns against — keying
// identity off the EDITABLE owner string rather than the immutable uid→team
// claim, which is how a rename locks a manager out of their own team. It is
// also, on inspection, unreachable. App.jsx derives both values together:
//
//     const team = teamId ? resolvedTeams.find(t => t.id === teamId) : null;
//     setLoggedInUser(team ? (team.owner || team.name) : null);
//
// so loggedInUser is non-null only when a team was ALREADY found by id. The
// fallback could never be the clause that matched: whenever it had a name to
// search for, the id lookup had already succeeded. It was dead code carrying a
// live anti-pattern, which is the most expensive kind — it looks like a working
// safety net, so the next person keeps it.
//
// Resolution is by team id only. Nothing else.
// ============================================================================

import { useMemo } from 'react';

/**
 * @param {Array}  teams          the league's teams
 * @param {string} loggedInTeamId immutable uid→team claim (App.jsx)
 * @returns {object|null} the manager's team, or null if the claim is unresolved
 */
export const useUserTeam = (teams, loggedInTeamId) =>
  useMemo(
    () => (loggedInTeamId ? (teams || []).find(t => t.id === loggedInTeamId) || null : null),
    [teams, loggedInTeamId],
  );

export default useUserTeam;
