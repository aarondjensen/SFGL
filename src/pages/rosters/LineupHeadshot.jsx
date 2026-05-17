// src/pages/rosters/LineupHeadshot.jsx
// ============================================================================
// Shows a player's headshot in a lineup slot, with a × badge that appears on
// hover (desktop) or first-tap (mobile) when the lineup is in edit mode.
// Limited players get a star count badge below the headshot.
//
// Extracted from RostersView in Wave J Part 1. Imports headshotUtils directly
// using the canonical (name, headshotMap, isLimited) signature — RostersView's
// local wrapper that flips the arg order isn't needed here.
// ============================================================================

import React from 'react';
import { theme, colors, fonts, fontSize } from '../../theme.js';
import {
  getPlayerHeadshot,
  makeHeadshotErrorHandler,
} from '../../utils/headshotUtils';
import { playerBorderColor } from './helpers';

export const LineupHeadshot = ({ player, lastName, nameFontSize, headshots, fieldPlayerIds = {}, canEdit, onRemove }) => {
  const [hovered, setHovered] = React.useState(false);
  const [tapped, setTapped]   = React.useState(false);
  const containerRef = React.useRef(null);
  const isMobileDevice = typeof window !== 'undefined' && 'ontouchstart' in window;

  // Reset tapped state when user touches anywhere outside this headshot
  React.useEffect(() => {
    if (!tapped) return;
    const handler = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setTapped(false);
      }
    };
    document.addEventListener('touchstart', handler, { passive: true });
    return () => document.removeEventListener('touchstart', handler);
  }, [tapped]);

  // Reset tapped when lineup edit mode is exited
  React.useEffect(() => {
    if (!canEdit) setTapped(false);
  }, [canEdit]);

  // On mobile: first tap reveals the × badge, second tap (on the ×) removes.
  // Tapping elsewhere resets. On desktop: hover reveals ×.
  const showRemove = canEdit && (hovered || tapped);

  return (
    <div
      ref={containerRef}
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 56, overflow: 'visible' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setTapped(false); }}
      onClick={(e) => {
        e.stopPropagation();
        if (!canEdit) return;
        if (isMobileDevice) {
          if (tapped) { onRemove(); setTapped(false); }
          else setTapped(true);
        }
      }}
    >
      <div style={{ position: 'relative', width: 44, height: 44, overflow: 'visible' }}>
        <img
          src={getPlayerHeadshot(player.name, headshots, player.limited)}
          onError={makeHeadshotErrorHandler(player.name, headshots, player.limited)}
          alt=""
          style={{
            width: 44, height: 44, borderRadius: '50%', objectFit: 'cover',
            border: `2px solid ${playerBorderColor(player)}`,
            transition: 'opacity 0.15s',
            opacity: showRemove ? 0.55 : 1,
          }}
        />
        {showRemove && (
          <button
            onClick={e => { e.stopPropagation(); onRemove(); setTapped(false); }}
            style={{
              position: 'absolute', top: -3, right: -3,
              width: 18, height: 18, borderRadius: '50%',
              background: 'rgba(220,60,60,0.92)',
              border: '1.5px solid rgba(255,255,255,0.25)',
              color: '#fff',
              fontSize: fontSize.sm, fontWeight: 700, lineHeight: 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer',
              boxShadow: '0 2px 6px rgba(0,0,0,0.5)',
              padding: 0,
              zIndex: 10,
              transition: 'transform 0.1s',
            }}
            onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.15)'; }}
            onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; }}
            title={'Remove ' + player.name + ' from lineup'}
          >
            {'\u00D7'}
          </button>
        )}
        {player.limited && (player.stars || 1) > 0 && (
          <div style={{
            position: 'absolute', bottom: -4, left: '50%', transform: 'translateX(-50%)',
            background: 'rgba(15,25,45,0.88)', borderRadius: 6,
            padding: '0px 3px', lineHeight: 1, zIndex: 5,
            fontSize: fontSize.badge, letterSpacing: 1,
          }}>
            {'⭐'.repeat(player.stars || 1)}
          </div>
        )}
      </div>
      <div style={{
        fontSize: nameFontSize, fontFamily: fonts.sans, marginTop: 3,
        textAlign: 'center', width: '100%',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        color: player.limited ? colors.textGold : player.unlimited ? 'rgba(100,140,220,0.9)' : colors.textPrimary,
      }}>
        {lastName}
      </div>
    </div>
  );
};
