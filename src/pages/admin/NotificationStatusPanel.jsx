// src/pages/admin/NotificationStatusPanel.jsx
// ============================================================================
// Commish console — "Manager Notification Status" view.
//
// Shows, per team, whether anyone on that team has push notifications
// enabled and on how many devices. Data source: the pushTokens Firestore
// collection (one doc per device-token, carrying teamId + userAgent). A
// team with >=1 token is "on"; zero tokens is "off".
//
// This is read-only visibility for the commish — it does NOT let the commish
// toggle anyone's notifications (that's each manager's own choice in their
// user settings). It answers the practical question "who will actually
// receive the pushes I send?"
//
// One collection read on mount (and on manual refresh). Cheap for a 5-team
// league. Device type is parsed best-effort from the userAgent string for a
// friendlier display (iPhone / Android / Mac / Windows / etc.).
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
      count: tokens.length,
      devices: tokens.map(t => deviceLabel(t.userAgent)),
    };
  });

  const onCount = rows.filter(r => r.count > 0).length;

  return (
    <div style={M.group}>
      <div style={M.eyebrow}>🔔 Manager Notification Status</div>
      <div style={M.descText}>
        Who currently has push notifications enabled, and on how many devices.
        A team must have at least one subscribed device to receive any pushes
        you send. Managers control their own subscriptions in their user
        settings — this view is read-only.
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

                  {/* Team name */}
                  <div style={{
                    flex: 1,
                    fontFamily: fonts.sans, fontSize: fontSize.md, fontWeight: 600,
                    color: colors.textPrimary,
                  }}>
                    {row.teamName}
                  </div>

                  {/* Status text */}
                  <div style={{
                    fontFamily: fonts.sans, fontSize: fontSize.sm,
                    color: isOn ? colors.earningsGreen : colors.textMuted,
                    textAlign: 'right',
                  }}>
                    {isOn ? (
                      <>
                        On
                        <span style={{ color: colors.textMuted }}>
                          {' · '}{row.count} {row.count === 1 ? 'device' : 'devices'}
                        </span>
                        {row.devices.length > 0 && (
                          <div style={{ fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1 }}>
                            {/* De-dupe identical device labels with a count, e.g. "iPhone ×2" */}
                            {Object.entries(
                              row.devices.reduce((acc, d) => { acc[d] = (acc[d] || 0) + 1; return acc; }, {})
                            ).map(([label, n]) => n > 1 ? `${label} ×${n}` : label).join(', ')}
                          </div>
                        )}
                      </>
                    ) : 'Off'}
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
