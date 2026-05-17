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
import { X } from 'lucide-react';
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

export const UserSettingsModal = ({
  isOpen,
  onClose,
  loggedInUser,
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
    () => teams.find(t => t.owner === loggedInUser) || null,
    [teams, loggedInUser]
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

  const handleCommishToggle = () => {
    setIsCommissioner(prev => {
      const next = !prev;
      // Same bounce-out as the old name-tap behavior: leaving commish mode
      // while on the Commish tab would render nothing.
      if (!next && activeTab === 'admin') setActiveTab('standings');
      return next;
    });
    onClose();
  };

  if (!isOpen) return null;

  const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(5,10,25,0.85)', backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: isMobile ? 'flex-end' : 'center',
        justifyContent: 'center',
        padding: isMobile ? 0 : 16,
        zIndex: 60,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#0f1d35',
          border: `1px solid ${colors.borderSubtle}`,
          borderRadius: isMobile ? '12px 12px 0 0' : 8,
          width: '100%', maxWidth: isMobile ? '100%' : 420,
          maxHeight: isMobile ? '85vh' : '82vh',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* ── Header ── */}
        <div style={{
          padding: '14px 18px',
          borderBottom: `1px solid ${colors.borderSubtle}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexShrink: 0, gap: 10,
        }}>
          <div style={{ minWidth: 0 }}>
            <h2 style={{
              fontFamily: fonts.sans, fontSize: 14, fontWeight: 600,
              color: colors.textPrimary, margin: 0, letterSpacing: '0.5px',
            }}>
              {loggedInUser || 'Account'}
            </h2>
            {userTeam && (
              <p style={{
                fontFamily: fonts.sans, fontSize: 11, color: colors.textMuted,
                margin: '2px 0 0', letterSpacing: '0.3px',
              }}>
                {userTeam.name}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: colors.textSecondary, padding: 4,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <X style={{ width: 18, height: 18 }} />
          </button>
        </div>

        {/* ── Body ── */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px' }}>

          {/* Commish mode toggle — only for tagged commissioners */}
          {taggedCommissioner && (
            <div style={{ marginBottom: 18 }}>
              <div style={{
                fontFamily: fonts.sans,
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '1.8px',
                textTransform: 'uppercase',
                color: colors.textMuted,
                marginBottom: 8,
              }}>
                Commissioner
              </div>
              <button
                onClick={handleCommishToggle}
                style={{
                  width: '100%',
                  padding: '12px 14px',
                  background: isCommissioner
                    ? 'rgba(245,197,24,0.08)'
                    : 'rgba(255,255,255,0.03)',
                  border: `1px solid ${isCommissioner
                    ? 'rgba(245,197,24,0.35)'
                    : colors.borderSubtle}`,
                  borderRadius: 6,
                  cursor: 'pointer',
                  textAlign: 'left',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  transition: 'background 0.15s, border-color 0.15s',
                }}
              >
                <span style={{ fontSize: 18, lineHeight: 1 }}>👑</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontFamily: fonts.sans, fontSize: 13, fontWeight: 600,
                    color: isCommissioner ? 'rgba(245,197,24,0.95)' : colors.textPrimary,
                  }}>
                    {isCommissioner ? 'Exit Commish Mode' : 'Enter Commish Mode'}
                  </div>
                  <div style={{ fontFamily: fonts.sans, fontSize: 11, color: colors.textMuted, marginTop: 1 }}>
                    {isCommissioner
                      ? 'Currently in commish mode'
                      : 'Access admin tools and Commish tab'}
                  </div>
                </div>
              </button>
            </div>
          )}

          {/* Push notifications — collapsible section. Header acts as the
              toggle. Status pill on the right shows current state at a
              glance even when collapsed (green dot = subscribed, etc) so
              users don't need to expand just to check their state. */}
          <div style={{ marginBottom: 18 }}>
            <button
              onClick={toggleNotifsExpanded}
              aria-expanded={notifsExpanded}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                background: 'transparent',
                border: 'none',
                padding: '4px 0',
                marginBottom: notifsExpanded ? 8 : 0,
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <span style={{
                fontFamily: fonts.sans,
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '1.8px',
                textTransform: 'uppercase',
                color: colors.textMuted,
              }}>
                Notifications
              </span>
              {/* Compact status dot — visible even when section is collapsed
                  so users can see their subscription state at a glance */}
              <span style={{
                width: 6, height: 6, borderRadius: '50%',
                background: !pushSupported
                  ? colors.textMuted
                  : pushSubscribed
                    ? colors.earningsGreen
                    : pushPermission === 'denied'
                      ? colors.danger
                      : colors.textMuted,
                opacity: 0.85,
                flexShrink: 0,
              }} />
              <span style={{ flex: 1 }} />
              <span style={{
                fontFamily: fonts.sans,
                fontSize: 11,
                color: colors.textMuted,
                transform: notifsExpanded ? 'rotate(0deg)' : 'rotate(-90deg)',
                transition: 'transform 0.15s',
                display: 'inline-block',
                lineHeight: 1,
              }}>▼</span>
            </button>

            {notifsExpanded && (
              <>
                {/* Master device toggle — iOS Settings pattern. One row owns
                    everything: status dot, label, and the toggle pill. The
                    pill drives subscribe/unsubscribe; status detail surfaces
                    in the secondary label below when relevant.
                      • not subscribed + supported + not denied → toggle off, tappable
                      • subscribed → toggle on, tappable (turns it off)
                      • not supported OR permission denied → toggle off, disabled
                      • mid-subscribe/unsubscribe → toggle stays in current
                        position, disabled, "…" suffix on the label */}
                {(() => {
                  const isOn = pushSubscribed;
                  const canToggle = pushSupported
                    && pushPermission !== 'denied'
                    && !pushBusy
                    && !!userTeam;
                  const dotColor = !pushSupported
                    ? colors.textMuted
                    : pushSubscribed
                      ? colors.earningsGreen
                      : pushPermission === 'denied'
                        ? colors.danger
                        : colors.textMuted;
                  // Secondary label gives the state-specific detail under
                  // the primary "Notifications on this device" line.
                  const detail = !pushSupported
                    ? 'Not supported in this browser'
                    : pushPermission === 'denied'
                      ? 'Blocked — enable in browser settings'
                      : pushBusy
                        ? (pushSubscribed ? 'Turning off…' : 'Turning on…')
                        : pushSubscribed
                          ? 'On'
                          : 'Off';
                  return (
                    <button
                      type="button"
                      role="switch"
                      aria-checked={isOn}
                      aria-label={`Notifications on this device: ${isOn ? 'on' : 'off'}`}
                      disabled={!canToggle}
                      onClick={isOn ? handleUnsubscribe : handleSubscribe}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '10px 12px',
                        background: 'rgba(255,255,255,0.02)',
                        border: `1px solid ${colors.borderSubtle}`,
                        borderRadius: 6,
                        cursor: canToggle ? 'pointer' : 'not-allowed',
                        opacity: canToggle ? 1 : 0.7,
                        transition: 'background 0.15s, border-color 0.15s, opacity 0.15s',
                        textAlign: 'left',
                        width: '100%',
                        fontFamily: fonts.sans,
                      }}
                    >
                      <div style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: dotColor,
                        flexShrink: 0,
                      }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          fontFamily: fonts.sans,
                          fontSize: 12,
                          fontWeight: 600,
                          color: colors.textPrimary,
                        }}>
                          Notifications on this device
                        </div>
                        <div style={{
                          fontFamily: fonts.sans,
                          fontSize: 10.5,
                          color: colors.textMuted,
                          marginTop: 1,
                        }}>
                          {detail}
                        </div>
                      </div>
                      {/* Toggle pill — same shape as per-event pills below */}
                      <div
                        aria-hidden="true"
                        style={{
                          position: 'relative',
                          width: 36,
                          height: 20,
                          borderRadius: 10,
                          background: isOn
                            ? 'rgba(80,195,120,0.7)'
                            : 'rgba(255,255,255,0.12)',
                          border: `1px solid ${isOn
                            ? 'rgba(80,195,120,0.85)'
                            : 'rgba(255,255,255,0.18)'}`,
                          transition: 'background 0.18s, border-color 0.18s',
                          flexShrink: 0,
                        }}
                      >
                        <div style={{
                          position: 'absolute',
                          top: 2,
                          left: 2,
                          width: 14,
                          height: 14,
                          borderRadius: '50%',
                          background: '#fff',
                          boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
                          transform: isOn ? 'translateX(16px)' : 'translateX(0)',
                          transition: 'transform 0.18s ease',
                        }} />
                      </div>
                    </button>
                  );
                })()}

                {/* Help text for unsupported / denied states. Stays because
                    a user hitting these edge cases needs the explanation —
                    the master toggle alone won't tell them how to recover. */}
                {!pushSupported && (
                  <div style={{
                    fontFamily: fonts.sans, fontSize: 11, color: colors.textMuted,
                    marginTop: 8, lineHeight: 1.5,
                  }}>
                    <strong>iPhone:</strong> add SFGL to your home screen (Safari → Share → Add to Home Screen), then open the app from the icon and revisit this screen.
                    <br />
                    <strong>Other browsers:</strong> notifications require a recent version of Chrome, Edge, or Firefox.
                  </div>
                )}
                {pushPermission === 'denied' && (
                  <div style={{
                    fontFamily: fonts.sans, fontSize: 11, color: colors.textMuted,
                    marginTop: 8, lineHeight: 1.5,
                  }}>
                    Notifications are blocked. Open your browser settings for sfglgolf.com and allow notifications, then return here.
                  </div>
                )}

                {/* Per-event toggles (Wave J Round 6 batch 3) ─────
                    Only batch 3 events are wired today; batch 4 will
                    extend NOTIFICATION_EVENTS with more rows. Each toggle
                    writes to team.notificationPrefs in Firestore so the
                    server-side push triggers can honor the preference. */}
                {pushSubscribed && userTeam && (
                  <div style={{ marginTop: 14 }}>
                    <div style={{
                      fontFamily: fonts.sans, fontSize: 11, color: colors.textMuted,
                      marginBottom: 6, lineHeight: 1.5,
                    }}>
                      Choose which events trigger pushes on your subscribed devices.
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {NOTIFICATION_EVENTS.map(evt => {
                        const enabled = effectivePrefs[evt.key];
                        const saving = !!prefSaving[evt.key];
                        return (
                          <button
                            key={evt.key}
                            type="button"
                            role="switch"
                            aria-checked={enabled}
                            aria-label={`${evt.label}: ${enabled ? 'enabled' : 'disabled'}`}
                            disabled={saving}
                            onClick={() => handleToggleEventPref(evt.key)}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 10,
                              padding: '10px 12px',
                              background: enabled
                                ? 'rgba(80,195,120,0.04)'
                                : 'rgba(255,255,255,0.02)',
                              border: `1px solid ${enabled
                                ? 'rgba(80,195,120,0.2)'
                                : colors.borderSubtle}`,
                              borderRadius: 6,
                              cursor: saving ? 'wait' : 'pointer',
                              opacity: saving ? 0.5 : 1,
                              transition: 'background 0.15s, border-color 0.15s, opacity 0.15s',
                              textAlign: 'left',
                              width: '100%',
                              fontFamily: fonts.sans,
                            }}
                          >
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{
                                fontFamily: fonts.sans, fontSize: 12, fontWeight: 600,
                                color: colors.textPrimary,
                              }}>
                                {evt.label}
                              </div>
                              <div style={{
                                fontFamily: fonts.sans, fontSize: 10.5, color: colors.textMuted,
                                marginTop: 1,
                              }}>
                                {evt.desc}
                              </div>
                            </div>
                            {/* Toggle pill — iOS-style track + thumb. The button
                                wrapping the whole row handles the click; this
                                element is purely visual.
                                  Track: 36×20 rounded pill with green-tinted bg when on
                                  Thumb: 14×14 circle that slides left↔right via transform */}
                            <div
                              aria-hidden="true"
                              style={{
                                position: 'relative',
                                width: 36,
                                height: 20,
                                borderRadius: 10,
                                background: enabled
                                  ? 'rgba(80,195,120,0.7)'
                                  : 'rgba(255,255,255,0.12)',
                                border: `1px solid ${enabled
                                  ? 'rgba(80,195,120,0.85)'
                                  : 'rgba(255,255,255,0.18)'}`,
                                transition: 'background 0.18s, border-color 0.18s',
                                flexShrink: 0,
                              }}
                            >
                              <div style={{
                                position: 'absolute',
                                top: 2,
                                left: 2,
                                width: 14,
                                height: 14,
                                borderRadius: '50%',
                                background: '#fff',
                                boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
                                transform: enabled ? 'translateX(16px)' : 'translateX(0)',
                                transition: 'transform 0.18s ease',
                              }} />
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
