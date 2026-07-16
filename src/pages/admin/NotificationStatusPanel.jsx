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
import { TeamName } from '../../components/TeamName';
import { M, disabledBtn } from './adminStyles';
import {
  getAllTokensByTeam,
  NOTIFICATION_EVENTS,
  getEffectiveChannelPrefs,
  buildChannelPrefUpdate,
} from '../../api/pushNotifications';

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

// Compact iOS-style toggle pill (mirrors the one in UserSettingsModal).
const TogglePill = ({ on, saving, onToggle, ariaLabel }) => (
  <button
    type="button" role="switch" aria-checked={on} aria-label={ariaLabel}
    disabled={saving} onClick={onToggle}
    style={{
      position: 'relative', width: 34, height: 19, borderRadius: 10,
      padding: 0, flexShrink: 0,
      background: on ? 'rgba(80,195,120,0.7)' : 'rgba(255,255,255,0.12)',
      border: `1px solid ${on ? 'rgba(80,195,120,0.85)' : 'rgba(255,255,255,0.18)'}`,
      cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.5 : 1,
      transition: 'background 0.18s, border-color 0.18s, opacity 0.18s',
    }}
  >
    <span aria-hidden="true" style={{
      position: 'absolute', top: 2, left: 2, width: 13, height: 13, borderRadius: '50%',
      background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
      transform: on ? 'translateX(15px)' : 'translateX(0)',
      transition: 'transform 0.18s ease',
    }} />
  </button>
);

export const NotificationStatusPanel = ({ teams = [], updateTeam }) => {
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);
  const [tokensByTeam, setTokensByTeam] = React.useState(new Map());
  // Which team's per-event matrix is expanded (teamId or null). Only one open
  // at a time keeps the panel compact.
  const [expandedTeam, setExpandedTeam] = React.useState(null);
  // Pending writes keyed "teamId:eventKey:channel" so we can disable just the
  // toggle being saved.
  const [prefSaving, setPrefSaving] = React.useState({});

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

  // Commish edits another team's prefs. Same write path as the user's own
  // settings (buildChannelPrefUpdate → updateTeam), just targeting an
  // arbitrary team rather than the logged-in one. Per-doc write — only the
  // toggled team is persisted.
  const handleToggleChannel = async (team, eventKey, channel) => {
    if (!updateTeam) return;
    const savingKey = `${team.id}:${eventKey}:${channel}`;
    if (prefSaving[savingKey]) return;

    const current = getEffectiveChannelPrefs(team)[eventKey] || { push: true, email: true };
    const newValue = !current[channel];
    const newPrefs = buildChannelPrefUpdate(team, eventKey, channel, newValue);

    setPrefSaving(p => ({ ...p, [savingKey]: true }));
    try {
      await updateTeam(team.id, { notificationPrefs: newPrefs });
    } catch (err) {
      console.warn('[NotificationStatusPanel] pref write failed:', err?.message);
    } finally {
      setPrefSaving(p => ({ ...p, [savingKey]: false }));
    }
  };

  // Build a display row per team. Teams with no tokens still show (as "off").
  const rows = (teams || []).map(team => {
    const tokens = tokensByTeam.get(team.id) || [];
    return {
      team,                       // full team object (for pref editing)
      teamId: team.id,
      teamName: team.name,
      lastActiveAt: team.lastActiveAt || null,
      count: tokens.length,
      devices: tokens.map(t => deviceLabel(t.userAgent)),
    };
  });

  const onCount = rows.filter(r => r.count > 0).length;
  const canEdit = typeof updateTeam === 'function';

  return (
    <div style={M.group}>
      <div style={M.eyebrow}>📊 Manager Activity</div>
      <div style={M.descText}>
        When each manager last opened the app, and whether they have push
        notifications enabled (and on how many devices). A team needs at least
        one subscribed device to receive any pushes you send.
        {canEdit && ' Tap a team to view and adjust their per-event push/email preferences.'}
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
              const isExpanded = expandedTeam === row.teamId;
              const chPrefs = getEffectiveChannelPrefs(row.team);
              return (
                <div
                  key={row.teamId}
                  style={{
                    background: 'rgba(255,255,255,0.02)',
                    border: `1px solid ${isExpanded ? 'rgba(255,255,255,0.16)' : colors.borderSubtle}`,
                    borderRadius: 6,
                    overflow: 'hidden',
                    transition: 'border-color 0.15s',
                  }}
                >
                  {/* Summary row — clickable to expand when editing is enabled */}
                  <div
                    onClick={canEdit ? () => setExpandedTeam(isExpanded ? null : row.teamId) : undefined}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '10px 12px',
                      cursor: canEdit ? 'pointer' : 'default',
                    }}
                  >
                    {/* Status dot */}
                    <div style={{
                      width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                      background: isOn ? colors.earningsGreen : colors.textMuted,
                    }} />

                    {/* Main content: two lines — name + last-active, then notif status */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                        <span style={{
                          fontFamily: fonts.sans, fontSize: fontSize.md, fontWeight: 600,
                          color: colors.textPrimary,
                        }}>
                          <TeamName name={row.teamName} />
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

                    {/* Chevron when editable */}
                    {canEdit && (
                      <span style={{
                        color: colors.textMuted, fontSize: fontSize.sm, flexShrink: 0,
                        transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                        transition: 'transform 0.15s',
                      }}>›</span>
                    )}
                  </div>

                  {/* Expanded per-event channel matrix — animated grid-rows
                      collapse so it slides open/closed smoothly in sync with
                      the chevron, rather than popping the row's height. */}
                  {canEdit && (
                    <div style={{
                      display: 'grid',
                      gridTemplateRows: isExpanded ? '1fr' : '0fr',
                      transition: 'grid-template-rows 0.22s ease',
                    }}>
                      <div style={{ overflow: 'hidden', minHeight: 0 }}>
                        <div style={{
                          borderTop: `1px solid ${colors.borderSubtle}`,
                          padding: '8px 12px 10px',
                        }}>
                          {/* Column header */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0 6px' }}>
                            <div style={{ flex: 1 }} />
                            <div style={{ width: 40, textAlign: 'center', fontFamily: fonts.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase', color: colors.textMuted }}>Push</div>
                            <div style={{ width: 40, textAlign: 'center', fontFamily: fonts.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase', color: colors.textMuted }}>Email</div>
                          </div>
                          {NOTIFICATION_EVENTS.map(evt => {
                            const ch = chPrefs[evt.key] || { push: true, email: true };
                            return (
                              <div key={evt.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0' }}>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ fontFamily: fonts.sans, fontSize: fontSize.sm, fontWeight: 600, color: colors.textPrimary }}>
                                    {evt.label}
                                  </div>
                                </div>
                                <div style={{ width: 40, display: 'flex', justifyContent: 'center' }}>
                                  <TogglePill
                                    on={ch.push}
                                    saving={!!prefSaving[`${row.teamId}:${evt.key}:push`]}
                                    onToggle={() => handleToggleChannel(row.team, evt.key, 'push')}
                                    ariaLabel={`${row.teamName} ${evt.label} push`}
                                  />
                                </div>
                                <div style={{ width: 40, display: 'flex', justifyContent: 'center' }}>
                                  <TogglePill
                                    on={ch.email}
                                    saving={!!prefSaving[`${row.teamId}:${evt.key}:email`]}
                                    onToggle={() => handleToggleChannel(row.team, evt.key, 'email')}
                                    ariaLabel={`${row.teamName} ${evt.label} email`}
                                  />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  )}
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
