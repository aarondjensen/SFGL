// pages/TournamentBadges.jsx
// Shared S/M (Signature/Major) badge component used across ResultsView and TournamentsView.
// Replaces ~5 sites of inlined identical JSX.

import React from 'react';

const baseStyle = {
  width: 20, height: 20,
  borderRadius: 2,
  display: 'inline-flex',
  alignItems: 'center', justifyContent: 'center',
  padding: 0, lineHeight: 1,
  fontSize: 9,
  letterSpacing: 0,
};

const majorStyle = {
  ...baseStyle,
  fontWeight: 800,
  background: 'rgba(160,110,240,0.18)',
  border: '1px solid rgba(160,110,240,0.65)',
  color: 'rgba(250,200,80,0.98)',
};

const sigStyle = {
  ...baseStyle,
  fontWeight: 600,
  background: 'rgba(150,115,230,0.16)',
  border: '1px solid rgba(160,125,240,0.6)',
  color: 'rgba(195,170,255,0.92)',
};

/**
 * TournamentBadges
 * Renders Major (M) badge if tournament.isMajor,
 * else Signature (S) badge if tournament.isSignature.
 * Renders nothing for normal tournaments.
 *
 * Optional `size` prop scales down for compact rows (e.g. TournamentsView read-only):
 *   size="sm" → 18×18, fontSize 8
 *
 * @param {Object} props
 * @param {Object} props.tournament  - { isMajor, isSignature }
 * @param {string} [props.size]      - 'sm' for compact (18×18), default 20×20
 */
export const TournamentBadges = ({ tournament, size }) => {
  const sm = size === 'sm';
  const wh = sm ? 18 : 20;
  const fs = sm ? 8 : 9;
  if (tournament.isMajor) {
    return <span style={{ ...majorStyle, width: wh, height: wh, fontSize: fs }}>M</span>;
  }
  if (tournament.isSignature) {
    return <span style={{ ...sigStyle, width: wh, height: wh, fontSize: fs }}>S</span>;
  }
  return null;
};

export default TournamentBadges;
