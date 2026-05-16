// src/components/UserSettingsModal.jsx
// ─────────────────────────────────────────────────────────────────────────────
// User-level settings modal, opened by tapping the user's last name in the
// header. Replaces the previous "tap-name-to-toggle-commish-mode" affordance
// — that one-tap toggle is now an option inside this modal, alongside push
// notification subscription controls and logout.
//
// Why a single modal: SFGL had two distinct user-level actions (toggle
// commish mode, log out) and now needs push subscription too. Three separate
// header affordances would be visually noisy. One modal collects them.
//
// Push subscription logic mirrors what's in AdminView's Commissioner Status
// panel (batch 1 scaffolding) so any manager can opt in their own device.
// Server-side preferences and per-event toggles come in later batches.
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
} from '../api/pushNotifications';

export const UserSettingsModal = ({
  isOpen,
  onClose,
  loggedInUser,
  teams,
  isCommissioner,
  setIsCommissioner,
  taggedCommissioner,
  activeTab,
  setActiveTab,
  onLogout,
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

  const handleLogout = () => {
    onClose();
    if (onLogout) onLogout();
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

          {/* Push notifications */}
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
              Notifications
            </div>

            {/* Status row */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 12px',
              background: 'rgba(255,255,255,0.02)',
              border: `1px solid ${colors.borderSubtle}`,
              borderRadius: 6,
              marginBottom: 8,
            }}>
              <div style={{
                width: 8, height: 8, borderRadius: '50%',
                background: !pushSupported
                  ? colors.textMuted
                  : pushSubscribed
                    ? colors.earningsGreen
                    : pushPermission === 'denied'
                      ? colors.danger
                      : colors.textMuted,
                flexShrink: 0,
              }} />
              <div style={{ flex: 1, fontFamily: fonts.sans, fontSize: 12, color: colors.textPrimary }}>
                {!pushSupported
                  ? 'Not supported in this browser'
                  : pushSubscribed
                    ? 'Enabled on this device'
                    : pushPermission === 'denied'
                      ? 'Blocked — enable in browser settings'
                      : 'Not enabled on this device'}
              </div>
            </div>

            {/* Subscribe/unsubscribe action */}
            {pushSupported && pushPermission !== 'denied' && (
              <button
                onClick={pushSubscribed ? handleUnsubscribe : handleSubscribe}
                disabled={pushBusy || !userTeam}
                style={{
                  width: '100%',
                  padding: '10px 14px',
                  background: pushSubscribed
                    ? 'rgba(255,255,255,0.03)'
                    : 'rgba(80,195,120,0.1)',
                  border: `1px solid ${pushSubscribed
                    ? colors.borderSubtle
                    : 'rgba(80,195,120,0.35)'}`,
                  borderRadius: 6,
                  color: pushSubscribed ? colors.textSecondary : colors.earningsGreen,
                  cursor: pushBusy || !userTeam ? 'not-allowed' : 'pointer',
                  fontFamily: fonts.sans,
                  fontSize: 12,
                  fontWeight: 600,
                  opacity: pushBusy || !userTeam ? 0.5 : 1,
                  transition: 'background 0.15s, border-color 0.15s',
                }}
              >
                {pushBusy
                  ? 'Working…'
                  : pushSubscribed
                    ? 'Disable on this device'
                    : 'Enable notifications on this device'}
              </button>
            )}

            {/* Help text for unsupported / denied */}
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

            {/* Forward-looking note about per-event prefs (coming in batch 3) */}
            {pushSubscribed && (
              <div style={{
                fontFamily: fonts.sans, fontSize: 11, color: colors.textMuted,
                marginTop: 10, lineHeight: 1.5, fontStyle: 'italic',
              }}>
                Per-event notification preferences (waivers, free agents, etc.) are coming soon.
              </div>
            )}
          </div>

          {/* Log out */}
          {onLogout && (
            <div>
              <div style={{
                fontFamily: fonts.sans,
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '1.8px',
                textTransform: 'uppercase',
                color: colors.textMuted,
                marginBottom: 8,
              }}>
                Account
              </div>
              <button
                onClick={handleLogout}
                style={{
                  width: '100%',
                  padding: '10px 14px',
                  background: 'rgba(220,80,80,0.06)',
                  border: '1px solid rgba(220,80,80,0.3)',
                  borderRadius: 6,
                  color: colors.danger,
                  cursor: 'pointer',
                  fontFamily: fonts.sans,
                  fontSize: 12,
                  fontWeight: 600,
                  transition: 'background 0.15s, border-color 0.15s',
                }}
              >
                Sign Out
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
