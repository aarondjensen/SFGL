// pages/PullToRefresh.jsx
// Wave 7: now accepts an onRefresh callback so we can refetch from Firebase
// instead of doing a full page reload. Falls back to window.location.reload()
// if no callback provided so this component still works in isolation.
//
// Wraps content with a touch-driven pull-to-refresh gesture. When the user
// pulls down past the threshold while at the top of the page, onRefresh fires.
// Pure visual feedback while pulling (no refresh until release).
//
// On non-touch devices the touch handlers are silent — no negative impact.

import React from 'react';

const THRESHOLD = 80;

export const PullToRefresh = ({ children, onRefresh }) => {
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
      // Wave 7: prefer the onRefresh callback (refetches data without bundle reload)
      // and fall back to the old reload behavior if no callback was passed.
      if (typeof onRefresh === 'function') {
        Promise.resolve(onRefresh())
          .catch(err => console.error('[PullToRefresh] onRefresh failed:', err))
          .finally(() => {
            setPullY(0);
            setRefreshing(false);
          });
      } else {
        setTimeout(() => window.location.reload(), 400);
      }
    } else {
      setPullY(0);
    }
    setPulling(false);
  }, [pulling, pullY, refreshing, onRefresh]);

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
