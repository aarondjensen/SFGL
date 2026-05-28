// src/components/NotificationNudge.jsx
// ============================================================================
// Smart "turn on notifications" banner.
//
// Shows a dismissible prompt encouraging the user to enable push, but ONLY
// when it's actually useful:
//   • user is logged in (we know their team)
//   • push is supported in this browser/context
//   • permission is NOT already 'denied' (we can't re-prompt the native
//     dialog after a denial, so nagging is pointless)
//   • the user is NOT already subscribed (no token for this device)
//   • the 1-day dismiss cooldown has elapsed
//
// Dismiss ("Not now") hides it for 1 day via a localStorage timestamp, so it
// returns the next day rather than every app open (which would train users
// to reflexively dismiss it). Subscribing makes it disappear permanently for
// that device (a token now exists).
//
// Tapping "Turn on" opens the User Settings modal (onOpenSettings), where the
// actual subscribe toggle lives — that keeps the native permission prompt
// tied to the existing, well-tested subscribe flow rather than duplicating it
// here. The native OS prompt can only be triggered by a user gesture on the
// device; the commish cannot enable push for anyone remotely.
// ============================================================================

import React from 'react';
import { colors, fonts, fontSize } from '../theme.js';
import {
  isPushSupported,
  getNotificationPermission,
  getCurrentToken,
} from '../api/pushNotifications';

const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 1 day
const DISMISS_KEY = 'sfgl.notifNudge.dismissedAt';

export const NotificationNudge = ({ loggedInUser, onOpenSettings }) => {
  const [visible, setVisible] = React.useState(false);

  // Decide whether to show. Runs on mount and whenever login state changes,
  // and re-checks when the tab becomes visible (so subscribing in another
  // view, or the cooldown elapsing, is reflected without a reload).
  React.useEffect(() => {
    let cancelled = false;

    const evaluate = async () => {
      // Must be logged in with a known team
      if (!loggedInUser) { if (!cancelled) setVisible(false); return; }
      const teamId = (() => { try { return localStorage.getItem('manager_team_id'); } catch { return null; } })();
      if (!teamId) { if (!cancelled) setVisible(false); return; }

      // Push must be supported
      const supported = await isPushSupported();
      if (cancelled) return;
      if (!supported) { setVisible(false); return; }

      // Don't nag if already denied (can't re-prompt) or already granted+subscribed
      const perm = getNotificationPermission();
      if (perm === 'denied' || perm === 'unsupported') { setVisible(false); return; }

      // Already subscribed on this device? (token cached)
      const token = getCurrentToken();
      if (token) { setVisible(false); return; }

      // Respect the dismiss cooldown
      let dismissedAt = 0;
      try { dismissedAt = parseInt(localStorage.getItem(DISMISS_KEY) || '0', 10) || 0; } catch {}
      if (Date.now() - dismissedAt < COOLDOWN_MS) { setVisible(false); return; }

      setVisible(true);
    };

    evaluate();
    const onVis = () => { if (document.visibilityState === 'visible') evaluate(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { cancelled = true; document.removeEventListener('visibilitychange', onVis); };
  }, [loggedInUser]);

  const handleDismiss = (e) => {
    e?.stopPropagation();
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch {}
    setVisible(false);
  };

  const handleEnable = () => {
    // Hand off to the settings modal where the subscribe toggle lives. We do
    // NOT set the dismiss cooldown here — if they don't complete the
    // subscribe, the banner should still be available (subject to cooldown
    // only on explicit dismiss).
    if (onOpenSettings) onOpenSettings();
  };

  if (!visible) return null;

  return (
    <div style={{
      maxWidth: 1100,
      margin: '12px auto 0',
      padding: '0 16px',
    }}>
      <div
        role="button"
        tabIndex={0}
        onClick={handleEnable}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleEnable(); } }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 14px',
          background: 'linear-gradient(180deg, rgba(245,197,24,0.10), rgba(245,197,24,0.05))',
          border: '1px solid rgba(245,197,24,0.30)',
          borderRadius: 10,
          cursor: 'pointer',
        }}
      >
        <span style={{ fontSize: 20, lineHeight: 1, flexShrink: 0 }}>🔔</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontFamily: fonts.sans, fontSize: fontSize.sm, fontWeight: 700,
            color: colors.textPrimary,
          }}>
            Turn on notifications
          </div>
          <div style={{
            fontFamily: fonts.sans, fontSize: fontSize.xs, color: colors.textSecondary,
            marginTop: 1, lineHeight: 1.4,
          }}>
            Get alerts for waivers, results, lineup reminders, and lead changes.
          </div>
        </div>
        {/* Enable affordance */}
        <span style={{
          fontFamily: fonts.sans, fontSize: fontSize.xs, fontWeight: 700,
          letterSpacing: '0.5px', textTransform: 'uppercase',
          color: '#0a1628',
          background: 'rgba(245,197,24,0.95)',
          padding: '6px 12px', borderRadius: 6, flexShrink: 0,
          whiteSpace: 'nowrap',
        }}>
          Turn on
        </span>
        {/* Dismiss */}
        <button
          onClick={handleDismiss}
          aria-label="Dismiss notification prompt"
          style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: colors.textMuted, fontSize: 18, lineHeight: 1,
            padding: '2px 4px', flexShrink: 0,
          }}
        >×</button>
      </div>
    </div>
  );
};

export default NotificationNudge;
