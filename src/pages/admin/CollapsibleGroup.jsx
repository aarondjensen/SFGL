// src/pages/admin/CollapsibleGroup.jsx
// ============================================================================
// Wraps a set of related admin sections into a collapsible accordion group.
// Persists open/closed state in localStorage so a refresh remembers what the
// commish had collapsed.
//
// Wave I: extracted from AdminView.jsx for readability and reuse.
// ============================================================================

import React from 'react';
import { fonts } from '../../theme.js';

const CG_STATE_KEY = 'sfgl-admin-group-state';

const _readGroupState = () => {
  try { return JSON.parse(localStorage.getItem(CG_STATE_KEY) || '{}') || {}; }
  catch { return {}; }
};
const _writeGroupState = (state) => {
  try { localStorage.setItem(CG_STATE_KEY, JSON.stringify(state)); } catch {}
};

export const CollapsibleGroup = ({ title, icon, children, badge }) => {
  // Default each group to OPEN. Commish can collapse to focus on one group.
  const [open, setOpen] = React.useState(() => {
    const s = _readGroupState();
    return s[title] !== false;
  });
  const toggle = () => {
    const next = !open;
    setOpen(next);
    const s = _readGroupState();
    s[title] = next;
    _writeGroupState(s);
  };
  return (
    <div style={{ marginBottom: open ? 0 : 4 }}>
      <button
        onClick={toggle}
        aria-expanded={open}
        aria-label={(open ? 'Collapse ' : 'Expand ') + title + ' group'}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          width: '100%', padding: '10px 14px', marginBottom: open ? 8 : 0,
          background: 'rgba(20, 45, 80, 0.45)',
          border: '1px solid rgba(180,160,100,0.18)',
          borderRadius: 4,
          cursor: 'pointer',
          fontFamily: fonts.sans,
          fontSize: 11, fontWeight: 700,
          letterSpacing: '2px', textTransform: 'uppercase',
          color: 'rgba(245,197,24,0.92)',
          transition: 'background 0.15s, border-color 0.15s',
        }}
        onMouseEnter={e => { e.currentTarget.style.background = 'rgba(20,45,80,0.65)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'rgba(20,45,80,0.45)'; }}
      >
        <span style={{ fontSize: 13 }}>{icon}</span>
        <span style={{ flex: 1, textAlign: 'left' }}>{title}</span>
        {/* Wave I: optional badge slot — used by Tournament Operations to show
            "N pending" so the commish sees attention-needed items before
            expanding the group. */}
        {badge && (
          <span style={{
            background: 'rgba(220,170,60,0.15)',
            border: '1px solid rgba(220,170,60,0.35)',
            color: 'rgba(220,170,60,0.95)',
            padding: '2px 8px',
            borderRadius: 2,
            fontSize: 10,
            letterSpacing: '0.5px',
          }}>
            {badge}
          </span>
        )}
        <span style={{
          fontSize: 11, color: 'rgba(245,197,24,0.6)',
          transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
          transition: 'transform 0.15s',
        }}>▼</span>
      </button>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 12 }}>
          {children}
        </div>
      )}
    </div>
  );
};