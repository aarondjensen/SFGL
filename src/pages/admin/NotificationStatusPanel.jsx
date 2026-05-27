// src/pages/admin/NotificationStatusPanel.jsx
// ============================================================================
// Commish console — "Manager Activity" view.
//
// Per team, shows:
//   • Last active — when the manager last opened the app (lastActiveAt on the
//     team doc, written by a throttled heartbeat in App.jsx). Reflects real
//     engagement, not just explicit logins.
//   • Notification status — whether anyone on the team has push enabled and
//     on how many devices (pushTokens collection, keyed by teamId).
//
// Read-only. Managers control their own subscriptions in their user settings;
// this view answers "who's engaged, and who will actually receive pushes."
//
// One pushTokens collection read on mount/refresh. lastActiveAt rides along
// on the teams prop (no extra read).
// ============================================================================

import React from 'react';
import { colors, fonts, fontSize } from '../../theme.js';
import { M, disabledBtn } from './adminStyles';
import { getAllTokensByTeam } from '../../api/pushNotifications';

// Best-effort device label from a userAgent string. Purely cosmetic.
function deviceLabel(ua) {
  if (!ua) return 'Unknown device';
  const s = ua.toLowerCase();
  if (s.includes('iphone')) return 'iPhone';
  if (s.includes('ipad')) return 'iPad';
  if (s.includes('android')) return 'Android';
  if (s.includes('mac os') || s.includes('macintosh')) return 'Mac';
  if (s.includes('windows')) return 'Windows';
  if (s.includes('linux')) return 'Linux';
  return 'Other device';
}

// Relative-time formatter: ISO string → "2h ago", "3d ago", "just now", or
// "Never". Coarse by design — exact minutes don't matter for engagement.
function relativeTime(iso) {
  if (!iso) return 'Never';
  const then = new Date(iso).getTime();
  if (isNaN(then)) return 'Never';
  const diffMs = Date.now() - then;
  if (diffMs < 0) return 'just now';
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

// Staleness color for the last-active text. Recent = bright, older = dimmer,
// never = muted. Helps the commish spot disengaged managers at a glance.
function activeColor(iso) {
  if (!iso) return colors.textMuted;
  const then = new Date(iso).getTime();
  if (isNaN(then)) return colors.textMuted;
  const days = (Date.now() - then) / (1000 * 60 * 60 * 24);
  if (days < 3)  return colors.earningsGreen;
  if (days < 10) return colors.textSecondary;
  return colors.textMuted;
}

export const NotificationStatusPanel = ({ teams = [] }) => {
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);
  const [tokensByTeam, setTokensByTeam] = React.useState(new Map());

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const map = await getAllTokensByTeam();
      setTokensByTeam(map);
    } catch (err) {
      console.error('[NotificationStatusPanel] load failed:', err);
      setError(err.message || 'Failed to load notification status');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  // Build a display row per team. Teams with no tokens still show (as "off").
  const rows = (teams || []).map(team => {
    const tokens = tokensByTeam.get(team.id) || [];
    return {
      teamId: team.id,
      teamName: team.name,
      lastActiveAt: team.lastActiveAt || null,
      count: tokens.length,
      devices: tokens.map(t => deviceLabel(t.userAgent)),
    };
  });

  const onCount = rows.filter(r => r.count > 0).length;

  return (
    <div style={M.group}>
      <div style={M.eyebrow}>📊 Manager Activity</div>
      <div style={M.descText}>
        When each manager last opened the app, and whether they have push
        notifications enabled (and on how many devices). A team needs at least
        one subscribed device to receive any pushes you send. Read-only —
        managers control their own subscriptions.
      </div>

      {loading ? (
        <div style={{ fontFamily: fonts.sans, fontSize: fontSize.sm, color: colors.textMuted, padding: '12px 0' }}>
          Loading notification status…
        </div>
      ) : error ? (
        <div style={{ fontFamily: fonts.sans, fontSize: fontSize.sm, color: colors.danger, padding: '12px 0' }}>
          {error}
        </div>
      ) : (
        <>
          <div style={{
            fontFamily: fonts.sans, fontSize: fontSize.sm, color: colors.textSecondary,
            marginBottom: 4,
          }}>
            {onCount} of {rows.length} teams have notifications on
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {rows.map(row => {
              const isOn = row.count > 0;
              return (
                <div
                  key={row.teamId}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 12px',
                    background: 'rgba(255,255,255,0.02)',
                    border: `1px solid ${colors.borderSubtle}`,
                    borderRadius: 6,
                  }}
                >
                  {/* Status dot */}
                  <div style={{
                    width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                    background: isOn ? colors.earningsGreen : colors.textMuted,
                  }} />

                  {/* Status dot reflects notification on/off */}

                  {/* Main content: two lines — name + last-active, then notif status */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                      <span style={{
                        fontFamily: fonts.sans, fontSize: fontSize.md, fontWeight: 600,
                        color: colors.textPrimary,
                      }}>
                        {row.teamName}
                      </span>
                      <span style={{
                        fontFamily: fonts.sans, fontSize: fontSize.sm,
                        color: activeColor(row.lastActiveAt), whiteSpace: 'nowrap',
                      }}>
                        {relativeTime(row.lastActiveAt)}
                      </span>
                    </div>
                    <div style={{
                      fontFamily: fonts.sans, fontSize: fontSize.xs,
                      color: isOn ? colors.earningsGreen : colors.textMuted,
                      marginTop: 2,
                    }}>
                      {isOn ? (
                        <>
                          🔔 On · {row.count} {row.count === 1 ? 'device' : 'devices'}
                          {row.devices.length > 0 && (
                            <span style={{ color: colors.textMuted }}>
                              {' ('}
                              {Object.entries(
                                row.devices.reduce((acc, d) => { acc[d] = (acc[d] || 0) + 1; return acc; }, {})
                              ).map(([label, n]) => n > 1 ? `${label} ×${n}` : label).join(', ')}
                              {')'}
                            </span>
                          )}
                        </>
                      ) : '🔕 Notifications off'}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <button
            onClick={load}
            disabled={loading}
            className="modal-feel-lift"
            style={{ ...M.btnSecondary, ...disabledBtn(loading), marginTop: 4 }}
          >
            🔄 Refresh
          </button>
        </>
      )}
    </div>
  );
};
