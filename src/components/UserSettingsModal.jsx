// src/components/UserSettingsModal.jsx
// ─────────────────────────────────────────────────────────────────────────────
// User-level settings modal, opened by tapping the user's last name in the
// header. Replaces the previous "tap-name-to-toggle-commish-mode" affordance
// — that one-tap toggle is now an option inside this modal, alongside push
// notification subscription controls and per-event toggles.
//
// Why a single modal: SFGL had two distinct user-level actions (toggle
// commish mode, plus push subscription) and they live better grouped
// together. The modal contains a Notifications group (master device toggle
// + per-event preferences) and the commish-mode toggle for tagged managers.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useEffect, useMemo } from 'react';
import { X, LogOut } from 'lucide-react';
import { useDialog } from '../pages/DialogContext';
import { colors, fonts } from '../theme.js';
import { useModalBehavior } from '../utils/modalUtils';
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
const Toggle = ({ on, accent = 'rgba(80,195,120,0.95)', disabled = false }) => (
  <div
    aria-hidden="true"
    style={{
      position: 'relative',
      width: 46, height: 28, borderRadius: 14,
      background: on ? accent : 'rgba(255,255,255,0.13)',
      boxShadow: on ? ('inset 0 0 0 1px ' + accent) : 'inset 0 0 0 1px rgba(255,255,255,0.16)',
      opacity: disabled ? 0.45 : 1,
      transition: 'background 0.22s, box-shadow 0.22s, opacity 0.2s',
      flexShrink: 0,
    }}
  >
    <div style={{
      position: 'absolute', top: 2, left: 2,
      width: 24, height: 24, borderRadius: '50%',
      background: '#fff',
      boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
      transform: on ? 'translateX(18px)' : 'translateX(0)',
      transition: 'transform 0.22s cubic-bezier(0.32,0.72,0,1)',
    }} />
  </div>
);

const GROUP_CARD = {
  background: 'rgba(255,255,255,0.035)',
  border: '1px solid rgba(255,255,255,0.06)',
  borderRadius: 14,
  overflow: 'hidden',
};
const GROUP_LABEL = {
  fontFamily: fonts.sans,
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '1.5px',
  textTransform: 'uppercase',
  color: colors.textMuted,
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
  onLogout,
  loggedInUser,
  loggedInTeamId,
  teams,
  updateTeams,
  isCommissioner,
  setIsCommissioner,
  taggedCommissioner,
  activeTab,
  setActiveTab,
}) => {
  const dialog = useDialog();
  useModalBehavior(isOpen, onClose);

  // Resolve the current user's team. We do this even though loggedInUser is
  // a string — the team identity is required to subscribe pushes to the
  // correct teamId in Firestore.
  const userTeam = useMemo(
    () =>
      (loggedInTeamId && teams.find(t => t.id === loggedInTeamId)) ||
      teams.find(t => t.owner === loggedInUser) ||
      null,
    [teams, loggedInTeamId, loggedInUser]
  );

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

  // Whether the Notifications section is expanded. Persisted in localStorage
  // so the user's preference sticks across modal opens. Defaults to expanded
  // for new users so the subscribe button is discoverable.
  // The section now has 6 event toggles. Expanded is still the default —
  // the user may want to flip a toggle and the click cost of opening
  // outweighs the visual cost of seeing the toggles by default. If we add
  // many more events later, flipping to collapsed-by-default may become
  // appropriate.
  const NOTIFS_EXPAND_KEY = 'sfgl.userSettings.notifsExpanded';
  const [notifsExpanded, setNotifsExpanded] = useState(() => {
    try {
      const stored = localStorage.getItem(NOTIFS_EXPAND_KEY);
      // If not set yet, default to true. Otherwise honor the stored value.
      return stored === null ? true : stored === 'true';
    } catch { return true; }
  });
  const toggleNotifsExpanded = () => {
    setNotifsExpanded(prev => {
      const next = !prev;
      try { localStorage.setItem(NOTIFS_EXPAND_KEY, String(next)); } catch {}
      return next;
    });
  };

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

  if (!isOpen) return null;

  const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(4,9,22,0.86)',
        backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: isMobile ? 'flex-end' : 'center',
        justifyContent: 'center',
        padding: isMobile ? 0 : 16,
        zIndex: 60,
        animation: 'sfglSheetFade 0.2s ease',
      }}
    >
      <style>{`@keyframes sfglSheetFade{from{opacity:0}to{opacity:1}}@keyframes sfglSheetUp{from{transform:translateY(26px);opacity:0}to{transform:translateY(0);opacity:1}}`}</style>
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'linear-gradient(180deg, #14233f 0%, #0f1b31 100%)',
          border: '1px solid rgba(255,255,255,0.07)',
          borderRadius: isMobile ? '22px 22px 0 0' : 18,
          width: '100%', maxWidth: isMobile ? '100%' : 440,
          maxHeight: isMobile ? '92vh' : '84vh',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 -8px 40px rgba(0,0,0,0.5)',
          paddingBottom: isMobile ? 'env(safe-area-inset-bottom)' : 0,
          animation: 'sfglSheetUp 0.3s cubic-bezier(0.32,0.72,0,1)',
        }}
      >
        {isMobile && (
          <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 8, flexShrink: 0 }}>
            <div style={{ width: 40, height: 5, borderRadius: 3, background: 'rgba(255,255,255,0.18)' }} />
          </div>
        )}

        <div style={{
          padding: isMobile ? '10px 20px 10px' : '16px 20px 12px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 12, flexShrink: 0,
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{
              fontFamily: fonts.sans, fontSize: 18, fontWeight: 600,
              color: colors.textPrimary, letterSpacing: '0.2px',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              {loggedInUser || 'Account'}
            </div>
            {userTeam && (
              <div style={{ fontFamily: fonts.sans, fontSize: 13, color: colors.textMuted, marginTop: 2 }}>
                {userTeam.name}
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              flexShrink: 0, width: 34, height: 34, borderRadius: '50%',
              background: 'rgba(255,255,255,0.06)', border: 'none', cursor: 'pointer',
              color: colors.textSecondary,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <X style={{ width: 18, height: 18 }} />
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '4px 20px 20px', WebkitOverflowScrolling: 'touch' }}>

          <div style={{ marginBottom: 14 }}>
            <button
              onClick={toggleNotifsExpanded}
              aria-expanded={notifsExpanded}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                background: 'transparent', border: 'none', padding: '2px 0 10px',
                cursor: 'pointer', textAlign: 'left',
              }}
            >
              <span style={GROUP_LABEL}>Notifications</span>
              <span style={{
                width: 7, height: 7, borderRadius: '50%',
                background: !pushSupported ? colors.textMuted : pushSubscribed ? colors.earningsGreen : pushPermission === 'denied' ? colors.danger : colors.textMuted,
                flexShrink: 0,
              }} />
              <span style={{ flex: 1 }} />
              <span style={{
                fontSize: 12, color: colors.textMuted,
                transform: notifsExpanded ? 'rotate(0deg)' : 'rotate(-90deg)',
                transition: 'transform 0.18s', display: 'inline-block', lineHeight: 1,
              }}>▼</span>
            </button>

            {notifsExpanded && (
              <>
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
                          <div style={{ fontSize: 14.5, fontWeight: 600, color: colors.textPrimary }}>
                            Notifications on this device
                          </div>
                          {showDetail && (
                            <div style={{ fontSize: 11.5, color: colors.textMuted, marginTop: 2 }}>{detail}</div>
                          )}
                        </div>
                        <Toggle on={isOn} accent="rgba(255,215,0,0.95)" disabled={!canToggle} />
                      </button>
                    </div>
                  );
                })()}

                {!pushSupported && (
                  <div style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.textMuted, marginTop: 10, lineHeight: 1.55 }}>
                    <strong>iPhone:</strong> add SFGL to your home screen (Safari → Share → Add to Home Screen), then open from the icon and revisit this screen.
                    <br />
                    <strong>Other browsers:</strong> notifications require a recent Chrome, Edge, or Firefox.
                  </div>
                )}
                {pushPermission === 'denied' && (
                  <div style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.textMuted, marginTop: 10, lineHeight: 1.55 }}>
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
                              borderTop: idx === 0 ? 'none' : '1px solid rgba(255,255,255,0.06)',
                              cursor: saving ? 'wait' : 'pointer',
                              opacity: saving ? 0.5 : 1,
                            }}
                          >
                            <div style={{ flex: 1, minWidth: 0, fontSize: 14.5, fontWeight: 600, color: colors.textPrimary }}>{evt.label}</div>
                            <Toggle on={enabled} />
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {onLogout && (
            <button
              onClick={onLogout}
              aria-label="Sign out"
              style={{
                width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                padding: '14px', minHeight: 50,
                background: 'rgba(200,70,70,0.10)',
                border: '1px solid rgba(220,90,90,0.28)',
                borderRadius: 14,
                color: 'rgba(240,140,140,0.95)',
                fontFamily: fonts.sans, fontSize: 14.5, fontWeight: 600, letterSpacing: '0.2px',
                cursor: 'pointer', transition: 'background 0.18s',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(200,70,70,0.18)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'rgba(200,70,70,0.10)'; }}
            >
              <LogOut style={{ width: 17, height: 17 }} />
              Sign out
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
