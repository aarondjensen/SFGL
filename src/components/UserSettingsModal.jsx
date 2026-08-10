// src/components/UserSettingsModal.jsx
// ─────────────────────────────────────────────────────────────────────────────
// User-level settings modal, opened by tapping the user's last name in the
// header. Replaces the previous "tap-name-to-toggle-commish-mode" affordance
// — that one-tap toggle is now an option inside this modal, alongside push
// notification subscription controls and per-event toggles.
//
// Scope note: this modal used to also host the commish-mode toggle and a sign
// out button. Both moved — commish mode to the More menu, sign out to
// AccountModal — but the props feeding them (onLogout, isCommissioner,
// setIsCommissioner, taggedCommissioner, activeTab, setActiveTab) stayed on
// the signature and were still being passed from App.jsx, describing a
// component that no longer existed. This is now notifications only.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useMemo } from 'react';
import { useDialog } from '../pages/DialogContext';
import { colors, fonts, green, white, black, fontSize } from '../theme.js';
import { BottomSheet, SheetBody } from './BottomSheet';
import { useUserTeam } from '../hooks/useUserTeam';
import {
  isPushSupported,
  getNotificationPermission,
  requestPermissionAndSubscribe,
  unsubscribe as unsubscribePush,
  getCurrentToken,
  NOTIFICATION_EVENTS,
  getEffectivePrefs,
} from '../api/pushNotifications';

// Reusable iOS-style toggle pill (visual only — the row button handles clicks).
const Toggle = ({ on, accent = green(0.95), disabled = false }) => (
  <div
    aria-hidden="true"
    style={{
      position: 'relative',
      width: 46, height: 28, borderRadius: 14,
      background: on ? accent : white(0.13),
      boxShadow: on ? ('inset 0 0 0 1px ' + accent) : `inset 0 0 0 1px ${white(0.16)}`,
      opacity: disabled ? 0.45 : 1,
      transition: 'background 0.22s, box-shadow 0.22s, opacity 0.2s',
      flexShrink: 0,
    }}
  >
    <div style={{
      position: 'absolute', top: 2, left: 2,
      width: 24, height: 24, borderRadius: '50%',
      background: '#fff',
      boxShadow: `0 1px 3px ${black(0.4)}`,
      transform: on ? 'translateX(18px)' : 'translateX(0)',
      transition: 'transform 0.22s cubic-bezier(0.32,0.72,0,1)',
    }} />
  </div>
);

const GROUP_CARD = {
  background: white(0.035),
  border: `1px solid ${white(0.06)}`,
  borderRadius: 14,
  overflow: 'hidden',
};
const ROW_BASE = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  width: '100%',
  padding: '10px 14px',
  background: 'transparent',
  border: 'none',
  textAlign: 'left',
  fontFamily: fonts.sans,
  cursor: 'pointer',
};

export const UserSettingsModal = ({
  isOpen,
  onClose,
  loggedInUser,
  loggedInTeamId,
  teams,
  updateTeams,
}) => {
  const dialog = useDialog();
  // Team identity is required to subscribe pushes against the right teamId.
  const userTeam = useUserTeam(teams, loggedInTeamId);

  // Effective per-event prefs for this team (stored values + defaults).
  // Recomputed when the team list or loggedInUser changes.
  const effectivePrefs = useMemo(
    () => userTeam ? getEffectivePrefs(userTeam) : {},
    [userTeam]
  );

  // Tracks pending writes per event key so we can disable toggles while
  // their Firestore write is in flight (prevents rapid double-toggle bugs).
  const [prefSaving, setPrefSaving] = useState({});

  const handleToggleEventPref = async (eventKey) => {
    if (!userTeam) return;
    if (prefSaving[eventKey]) return;  // ignore while in-flight

    const currentValue = effectivePrefs[eventKey];
    const newValue = !currentValue;

    // Optimistic update: write new prefs map to local state immediately
    // via updateTeams. Realtime subscription will reconcile if needed.
    const newPrefs = { ...(userTeam.notificationPrefs || {}), [eventKey]: newValue };
    const newTeams = teams.map(t =>
      t.id === userTeam.id ? { ...t, notificationPrefs: newPrefs } : t
    );

    setPrefSaving(p => ({ ...p, [eventKey]: true }));
    try {
      await updateTeams(newTeams);
    } catch (err) {
      dialog.showToast('Could not save preference: ' + err.message, 'error');
    } finally {
      setPrefSaving(p => ({ ...p, [eventKey]: false }));
    }
  };

  // ── Push subscription state (mirrors AdminView batch 1 panel) ──────────
  const [pushSupported,  setPushSupported]  = useState(false);
  const [pushPermission, setPushPermission] = useState('default');
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [pushBusy,       setPushBusy]       = useState(false);

  // Re-check status whenever the modal opens (subscription state can change
  // between opens — e.g. user denied permission externally, or revoked
  // notification access in browser settings).
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    (async () => {
      const supported = await isPushSupported();
      if (cancelled) return;
      setPushSupported(supported);
      setPushPermission(getNotificationPermission());
      setPushSubscribed(!!getCurrentToken());
    })();
    return () => { cancelled = true; };
  }, [isOpen]);

  const handleSubscribe = async () => {
    if (!userTeam?.id) {
      dialog.showToast('Could not identify your team. Please sign in again.', 'error');
      return;
    }
    setPushBusy(true);
    try {
      const result = await requestPermissionAndSubscribe(userTeam.id);
      if (result.ok) {
        setPushSubscribed(true);
        setPushPermission('granted');
        dialog.showToast('✓ Notifications enabled on this device', 'success');
      } else {
        const messages = {
          unsupported:  'Push notifications aren\u2019t supported in this browser. On iPhone, add SFGL to your home screen first (Safari → Share → Add to Home Screen), then open the app from the icon.',
          denied:       'Permission denied. Enable notifications for SFGL in your browser settings if you want to receive pushes.',
          no_vapid:     'Server not configured for push notifications. Ask the commish to check VAPID setup.',
          sw_failed:    'Service worker registration failed. Try refreshing the page.',
          token_failed: 'Could not register with the push service. Try again in a moment.',
          save_failed:  'Permission granted but failed to save subscription. Try again.',
        };
        dialog.showToast(messages[result.reason] || `Subscription failed: ${result.reason}`, 'error');
      }
    } catch (err) {
      console.error('[push] subscribe error:', err);
      dialog.showToast('Subscription failed: ' + err.message, 'error');
    } finally {
      setPushBusy(false);
    }
  };

  const handleUnsubscribe = async () => {
    setPushBusy(true);
    try {
      await unsubscribePush();
      setPushSubscribed(false);
      dialog.showToast('Unsubscribed from notifications on this device', 'success');
    } catch (err) {
      console.error('[push] unsubscribe error:', err);
      dialog.showToast('Unsubscribe failed: ' + err.message, 'error');
    } finally {
      setPushBusy(false);
    }
  };

  return (
    <BottomSheet
      isOpen={isOpen}
      onClose={onClose}
      variant="sheet"
      title={loggedInUser || 'Account'}
      subtitle={userTeam?.name}
    >
      <SheetBody>

          <div style={{ marginBottom: 14 }}>
                {(() => {
                  const isOn = pushSubscribed;
                  const canToggle = pushSupported && pushPermission !== 'denied' && !pushBusy && !!userTeam;
                  const dotColor = !pushSupported ? colors.textMuted : pushSubscribed ? colors.earningsGreen : pushPermission === 'denied' ? colors.danger : colors.textMuted;
                  const detail = !pushSupported ? 'Not supported in this browser' : pushPermission === 'denied' ? 'Blocked — enable in browser settings' : pushBusy ? (pushSubscribed ? 'Turning off…' : 'Turning on…') : pushSubscribed ? 'On' : 'Off';
                  const showDetail = !pushSupported || pushPermission === 'denied' || pushBusy;
                  return (
                    <div style={GROUP_CARD}>
                      <button
                        type="button" role="switch" aria-checked={isOn}
                        aria-label={`Notifications on this device: ${isOn ? 'on' : 'off'}`}
                        disabled={!canToggle}
                        onClick={isOn ? handleUnsubscribe : handleSubscribe}
                        style={{ ...ROW_BASE, cursor: canToggle ? 'pointer' : 'not-allowed', opacity: canToggle ? 1 : 0.65 }}
                      >
                        <span style={{ width: 9, height: 9, borderRadius: '50%', background: dotColor, flexShrink: 0 }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: fontSize.md, fontWeight: 600, color: colors.textPrimary }}>
                            Notifications on this device
                          </div>
                          {showDetail && (
                            <div style={{ fontSize: fontSize.caption, color: colors.textMuted, marginTop: 2 }}>{detail}</div>
                          )}
                        </div>
                        <Toggle on={isOn} accent="rgba(255,215,0,0.95)" disabled={!canToggle} />
                      </button>
                    </div>
                  );
                })()}

                {!pushSupported && (
                  <div style={{ fontFamily: fonts.sans, fontSize: fontSize.sm, color: colors.textMuted, marginTop: 10, lineHeight: 1.55 }}>
                    <strong>iPhone:</strong> add SFGL to your home screen (Safari → Share → Add to Home Screen), then open from the icon and revisit this screen.
                    <br />
                    <strong>Other browsers:</strong> notifications require a recent Chrome, Edge, or Firefox.
                  </div>
                )}
                {pushPermission === 'denied' && (
                  <div style={{ fontFamily: fonts.sans, fontSize: fontSize.sm, color: colors.textMuted, marginTop: 10, lineHeight: 1.55 }}>
                    Notifications are blocked. Open your browser settings for sfglgolf.com, allow notifications, then return here.
                  </div>
                )}

                {pushSubscribed && userTeam && (
                  <div style={{ marginTop: 12 }}>
                    <div style={GROUP_CARD}>
                      {NOTIFICATION_EVENTS.map((evt, idx) => {
                        const enabled = effectivePrefs[evt.key];
                        const saving = !!prefSaving[evt.key];
                        return (
                          <button
                            key={evt.key}
                            type="button" role="switch" aria-checked={enabled}
                            aria-label={`${evt.label}: ${enabled ? 'enabled' : 'disabled'}`}
                            disabled={saving}
                            onClick={() => handleToggleEventPref(evt.key)}
                            style={{
                              ...ROW_BASE,
                              borderTop: idx === 0 ? 'none' : `1px solid ${white(0.06)}`,
                              cursor: saving ? 'wait' : 'pointer',
                              opacity: saving ? 0.5 : 1,
                            }}
                          >
                            <div style={{ flex: 1, minWidth: 0, fontSize: fontSize.md, fontWeight: 600, color: colors.textPrimary }}>{evt.label}</div>
                            <Toggle on={enabled} />
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
          </div>
      </SheetBody>
    </BottomSheet>
  );
};
