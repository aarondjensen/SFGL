// pages/PullToRefresh.jsx
// Wraps content with a touch-driven pull-to-refresh gesture. When the user
// pulls down past the threshold while at the top of the page, the page
// fully reloads — picking up both fresh data AND any newly-deployed code.
//
// Visual: a golf ball that rotates as the user pulls (one full rotation by
// the time it's at threshold). Past threshold the ball tints gold; on
// release it spins continuously while the page reloads. Text rendered in
// Raleway with uppercase tracking to match the rest of the app's chrome.

import React from 'react';

const THRESHOLD = 80;
const REFRESH_HEIGHT = 64; // height of the indicator bar while reloading

// Local keyframes — scoped to this component so the file is self-contained
// (no app-global.css edit required to ship this animation).
const KEYFRAMES = `
@keyframes sfgl-ptr-spin {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}
@keyframes sfgl-ptr-pulse {
  0%, 100% { opacity: 0.55; }
  50%      { opacity: 1; }
}
`;

// Golf-ball SVG — white sphere with subtle dimples. When `gold` is true the
// radial gradient fills with brand gold instead of white. When `spinning`,
// a CSS keyframe rotates it indefinitely; otherwise rotation is driven by
// the `rotation` prop (mapped to pull progress).
const GolfBall = ({ size = 30, gold = false, spinning = false, rotation = 0 }) => {
  // Stable gradient id keyed on `gold` so the gradient stops re-resolve when
  // the colour changes (avoids the cached white fill sticking on transition).
  const gradId = gold ? 'sfgl-ptr-ball-gold' : 'sfgl-ptr-ball-white';
  return (
    <div style={{
      width: size, height: size,
      display: 'inline-block',
      transform: spinning ? undefined : `rotate(${rotation}deg)`,
      transition: spinning ? 'none' : 'transform 0.05s linear',
      animation: spinning ? 'sfgl-ptr-spin 0.7s linear infinite' : undefined,
      filter: gold ? 'drop-shadow(0 0 6px rgba(245,197,24,0.45))' : undefined,
      willChange: 'transform',
    }}>
      <svg viewBox="0 0 32 32" width={size} height={size}>
        <defs>
          <radialGradient id={gradId} cx="0.38" cy="0.32" r="0.75">
            <stop offset="0%"  stopColor={gold ? '#fff5d0' : '#ffffff'} />
            <stop offset="65%" stopColor={gold ? '#f5c518' : '#dadce0'} />
            <stop offset="100%" stopColor={gold ? '#7d6210' : '#888888'} />
          </radialGradient>
        </defs>
        <circle cx="16" cy="16" r="15" fill={`url(#${gradId})`} />
        {/* Dimples — rotate with the ball, giving the spin a tactile feel */}
        {[
          [11, 9],   [16, 7.5], [21, 9],
          [8, 14],   [13, 13],  [19, 13],  [24, 14],
          [9, 19],   [16, 19.5],[23, 19],
          [11, 24],  [16, 25],  [21, 24],
        ].map(([cx, cy], i) => (
          <circle key={i} cx={cx} cy={cy} r="1" fill="rgba(0,0,0,0.18)" />
        ))}
      </svg>
    </div>
  );
};

export const PullToRefresh = ({ children, onRefresh }) => {
  // onRefresh is accepted for backward compatibility but no longer used.
  // The previous behaviour (call onRefresh() to refetch from Firestore in-place)
  // didn't pick up new code from Vercel deploys — users had to fully close the
  // app and reopen it to get the new bundle. Doing a full reload here gets
  // both new code and new data in one gesture, matching how every other
  // mobile app's pull-to-refresh works.
  void onRefresh;

  const [pulling,    setPulling]    = React.useState(false);
  const [pullY,      setPullY]      = React.useState(0);
  const [refreshing, setRefreshing] = React.useState(false);
  const startY = React.useRef(0);

  const onTouchStart = React.useCallback((e) => {
    // Only activate when scrolled to top
    if (window.scrollY > 0) return;
    startY.current = e.touches[0].clientY;
    setPulling(true);
  }, []);

  const onTouchMove = React.useCallback((e) => {
    if (!pulling || refreshing) return;
    if (window.scrollY > 0) { setPulling(false); setPullY(0); return; }
    const delta = e.touches[0].clientY - startY.current;
    if (delta > 0) {
      // Rubber band — diminishing returns past the comfortable max
      setPullY(Math.min(delta * 0.4, 120));
    } else {
      setPullY(0);
    }
  }, [pulling, refreshing]);

  const onTouchEnd = React.useCallback(() => {
    if (!pulling) return;
    if (pullY >= THRESHOLD && !refreshing) {
      setRefreshing(true);
      // Settle the bar at REFRESH_HEIGHT — content translation matches so
      // the bar doesn't overlap the page header.
      setPullY(REFRESH_HEIGHT);
      // Brief delay so the user sees the spinning ball state before the
      // page goes white during reload. 200ms feels intentional, not laggy.
      setTimeout(() => {
        // Bypass HTTP cache when supported (Chrome desktop/Android, some
        // others). iOS Safari ignores the bool argument but `.reload()`
        // itself still re-fetches when the server's cache headers permit.
        try { window.location.reload(true); }
        catch { window.location.reload(); }
      }, 200);
    } else {
      setPullY(0);
    }
    setPulling(false);
  }, [pulling, pullY, refreshing]);

  const past     = pullY >= THRESHOLD;
  const label    = refreshing ? 'Teeing off' : past ? 'Release' : 'Pull to refresh';
  // Map pull progress to one full rotation at threshold
  const rotation = (pullY / THRESHOLD) * 360;

  return (
    <div
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      style={{ position: 'relative' }}
    >
      {/* Inject keyframes (idempotent — duplicates dedupe in the DOM) */}
      <style>{KEYFRAMES}</style>

      {/* Pull indicator */}
      {(pullY > 0 || refreshing) && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0,
          display: 'flex', flexDirection: 'column',
          justifyContent: 'center', alignItems: 'center',
          gap: 6,
          height: Math.max(pullY, refreshing ? REFRESH_HEIGHT : 0),
          transition: pulling ? 'none' : 'height 0.25s ease',
          zIndex: 9999, overflow: 'hidden',
          background: 'rgba(10,22,40,0.97)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          borderBottom: past || refreshing
            ? '1px solid rgba(245,197,24,0.3)'
            : '1px solid transparent',
          transitionProperty: pulling ? 'border-color' : 'height, border-color',
        }}>
          <GolfBall
            size={30}
            gold={past || refreshing}
            spinning={refreshing}
            rotation={rotation}
          />
          <div style={{
            fontFamily: "'Raleway', system-ui, sans-serif",
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 2.5,
            textTransform: 'uppercase',
            color: past || refreshing
              ? 'rgba(245,197,24,0.95)'
              : 'rgba(255,255,255,0.5)',
            transition: 'color 0.15s',
            // Soft pulse on the refreshing label so the static text doesn't
            // feel frozen alongside the spinning ball.
            animation: refreshing ? 'sfgl-ptr-pulse 1.2s ease-in-out infinite' : undefined,
          }}>
            {label}
          </div>
        </div>
      )}

      <div style={{
        transform: pullY > 0 || refreshing ? `translateY(${pullY}px)` : 'none',
        transition: pulling ? 'none' : 'transform 0.25s ease',
      }}>
        {children}
      </div>
    </div>
  );
};

export default PullToRefresh;
