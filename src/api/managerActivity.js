// src/api/managerActivity.js
// ============================================================================
// Lightweight per-manager activity tracking (last login / last active).
//
// Why a heartbeat instead of relying on managerAuthApi.login(): managers stay
// signed in via the persisted manager_team_id in localStorage, so login() only
// fires the rare times they actually re-enter a password. Recording on every
// app load (session restore) is what keeps "last login" accurate — otherwise
// the timestamp freezes at the last password entry even for daily-active users.
//
// Storage: one sfgl_data doc per team, keyed `manager_activity_<teamId>`, so
// concurrent logins from different managers never collide on a shared map
// (avoids the read-modify-write race a single combined doc would have).
//   doc value shape: { lastLogin: <ms epoch> }
// ============================================================================
import { sfglDataApi } from './firebase';

const keyFor = (teamId) => `manager_activity_${teamId}`;

export const managerActivityApi = {
  // Stamp "now" as this team's last login/active time. Best-effort: never
  // throws into the caller, since a tracking write must not block login or
  // session restore.
  async recordLogin(teamId) {
    if (!teamId) return;
    try {
      await sfglDataApi.set(keyFor(teamId), { lastLogin: Date.now() });
    } catch (err) {
      console.warn('[managerActivity] recordLogin failed:', err);
    }
  },

  // Returns { [teamId]: { lastLogin } | null } for the given team ids.
  async getActivity(teamIds = []) {
    const ids = (teamIds || []).filter(Boolean);
    if (!ids.length) return {};
    try {
      const raw = await sfglDataApi.getMany(ids.map(keyFor));
      const out = {};
      ids.forEach((id) => { out[id] = raw[keyFor(id)] || null; });
      return out;
    } catch (err) {
      console.warn('[managerActivity] getActivity failed:', err);
      return {};
    }
  },
};
