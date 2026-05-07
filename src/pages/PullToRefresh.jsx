// pages/PullToRefresh.jsx
// Wraps content with a touch-driven pull-to-refresh gesture. When the user
// pulls down past the threshold while at the top of the page, the page
// fully reloads — picking up both fresh data AND any newly-deployed code.
//
// Pure visual feedback while pulling (no reload until release).
// On non-touch devices the touch handlers are silent — no negative impact.

import React from 'react';

const THRESHOLD = 80;

export const PullToRefresh = ({ children, onRefresh }) => {
  // onRefresh is accepted for backward compatibility but no longer used.
  // The previous behaviour (call onRefresh() to refetch from Firestore in-place)
  // didn't pick up new code from Vercel deploys — users had to fully close the
  // app and reopen it to get the new bundle. Doing a full reload here gets
  // both new code and new data in one gesture, matching how every other
  // mobile app's pull-to-refresh works.
  void onRefresh;

  const [pulling, setPulling] = React.useState(false);
  const [pullY, setPullY] = React.useState(0);
  const [refreshing, setRefreshing] = React.useState(false);
  const startY = React.useRef(0);
  const scrollableRef = React.useRef(null);

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
      // Rubber band effect — diminishing returns past threshold
      setPullY(Math.min(delta * 0.4, 120));
    } else {
      setPullY(0);
    }
  }, [pulling, refreshing]);

  const onTouchEnd = React.useCallback(() => {
    if (!pulling) return;
    if (pullY >= THRESHOLD && !refreshing) {
      setRefreshing(true);
      setPullY(THRESHOLD * 0.5);
      // Brief delay so the user sees the "Refreshing…" state before the
      // page goes white during reload. 200ms feels intentional, not laggy.
      setTimeout(() => {
        // Bypass HTTP cache when supported (Chrome desktop/Android, some others).
        // iOS Safari ignores the bool argument but `.reload()` itself still
        // re-fetches when the server's cache headers permit.
        try { window.location.reload(true); }
        catch { window.location.reload(); }
      }, 200);
    } else {
      setPullY(0);
    }
    setPulling(false);
  }, [pulling, pullY, refreshing]);

  return (
    <div
      ref={scrollableRef}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      style={{ position: 'relative' }}
    >
      {/* Pull indicator */}
      {(pullY > 0 || refreshing) && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0,
          display: 'flex', justifyContent: 'center', alignItems: 'center',
          height: Math.max(pullY, refreshing ? 40 : 0),
          transition: pulling ? 'none' : 'height 0.25s ease',
          zIndex: 9999, overflow: 'hidden',
          background: 'rgba(10,22,40,0.95)',
        }}>
          <div style={{
            fontFamily: '-apple-system, sans-serif', fontSize: 12, fontWeight: 600,
            color: pullY >= THRESHOLD || refreshing ? 'rgba(196,162,78,0.9)' : 'rgba(255,255,255,0.4)',
            transition: 'color 0.15s',
          }}>
            {refreshing ? '⏳ Refreshing…' : pullY >= THRESHOLD ? '↑ Release to refresh' : '↓ Pull to refresh'}
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
