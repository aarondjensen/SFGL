// src/pages/admin/ManagerActivityPanel.jsx
// ============================================================================
// Read-only commish view: each manager's most-recent login plus whether they
// have push notifications enabled (i.e. at least one registered device token).
//
// Data sources:
//   • Last login — managerActivityApi.getActivity(): the sfgl_data heartbeat
//     written on session restore + login (see App.jsx wiring).
//   • Notifications — getTokensForTeam() against the pushTokens collection; a
//     team with >= 1 token has push enabled on some device.
// ============================================================================
import React from 'react';
import { colors, fonts } from '../../theme.js';
import { M } from './adminStyles';
import { managerActivityApi } from '../../api/managerActivity';
import { getTokensForTeam } from '../../api/pushNotifications';

// "Just now" / "12m ago" / "3h ago" / "2d ago" / "1mo ago" / "Never"
const timeAgo = (ms) => {
  if (!ms) return 'Never';
  const diff = Date.now() - ms;
  if (diff < 60000) return 'Just now';
  const min = Math.floor(diff / 60000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  return `${mo}mo ago`;
};

const fullDate = (ms) => (ms
  ? new Date(ms).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
    })
  : 'No login recorded yet');

export const ManagerActivityPanel = ({ teams = [] }) => {
  const [activity, setActivity] = React.useState({});
  const [notif, setNotif] = React.useState({});
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const ids = teams.map((t) => t.id).filter(Boolean);
      const [act, tokenFlags] = await Promise.all([
        managerActivityApi.getActivity(ids),
        Promise.all(ids.map((id) =>
          getTokensForTeam(id)
            .then((toks) => [id, (toks || []).length > 0])
            .catch(() => [id, false])
        )),
      ]);
      if (cancelled) return;
      setActivity(act);
      setNotif(Object.fromEntries(tokenFlags));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [teams]);

  // Most recently active first; never-logged-in fall to the bottom.
  const rows = [...teams].sort(
    (a, b) => (activity[b.id]?.lastLogin || 0) - (activity[a.id]?.lastLogin || 0)
  );

  return (
    <div style={M.page}>
      <div style={M.descText}>
        Most recent login per manager, and whether they have push notifications
        enabled on at least one device.
      </div>

      <div style={M.group}>
        <div style={M.eyebrow}>👥 Manager Activity</div>

        {loading ? (
          <div style={{ fontFamily: fonts.sans, fontSize: 13, color: colors.textMuted, padding: '10px 0' }}>
            Loading…
          </div>
        ) : rows.map((t) => {
          const last = activity[t.id]?.lastLogin || null;
          const on = !!notif[t.id];
          return (
            <div
              key={t.id}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                gap: 12, padding: '11px 0', borderBottom: `1px solid ${colors.borderSubtle}`,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: fonts.sans, fontSize: 14, fontWeight: 600, color: colors.textPrimary }}>
                  {t.name}
                </div>
                <div
                  title={fullDate(last)}
                  style={{ fontFamily: fonts.sans, fontSize: 11, color: colors.textMuted, marginTop: 2 }}
                >
                  Last login: {timeAgo(last)}
                </div>
              </div>

              <span
                style={{
                  flexShrink: 0,
                  fontFamily: fonts.sans, fontSize: 11, fontWeight: 700, letterSpacing: '0.3px',
                  padding: '4px 10px', borderRadius: 999, whiteSpace: 'nowrap',
                  color: on ? colors.earningsGreen : colors.textMuted,
                  background: on ? 'rgba(80,195,120,0.08)' : 'rgba(255,255,255,0.04)',
                  border: `1px solid ${on ? 'rgba(80,195,120,0.3)' : colors.borderSubtle}`,
                }}
              >
                {on ? '🔔 Notifications on' : '🔕 Off'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};
