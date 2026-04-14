import React, { useState } from 'react';
import { useDialog } from './DialogContext';
import { theme, colors, fonts } from '../theme.js';
import { useModalBehavior } from '../utils/modalUtils';

/**
 * MulliganModal — top-level component (not defined inside RostersView render)
 * to prevent React from destroying and recreating it on every render.
 */
export const MulliganModal = ({
  isOpen,
  onClose,
  team,
  activeTournament,
  isSignatureOrMajor,
  lineupPlayers,
  benchPlayers,
  onConfirm,
}) => {
  const [playerOut,  setPlayerOut]  = useState('');
  const [playerIn,   setPlayerIn]   = useState('');
  const [afterRound, setAfterRound] = useState('2');
  const dialog = useDialog();

  // ── Escape key + body scroll lock (shared) ────────────────────────────────
  useModalBehavior(isOpen, onClose);

  if (!isOpen || !activeTournament) return null;

  const handleConfirm = async () => {
    if (!playerOut || !playerIn) return;
    const ok = await dialog.showConfirm(
      'Use Mulligan',
      `Swap ${playerOut} OUT → ${playerIn} IN for ${activeTournament.name} (after Round ${afterRound})?`,
      { confirmText: 'Use Mulligan' },
    );
    if (!ok) return;
    onConfirm({ playerOut, playerIn, afterRound: parseInt(afterRound, 10), isSignatureOrMajor });
    handleClose();
  };

  const handleClose = () => {
    setPlayerOut('');
    setPlayerIn('');
    setAfterRound('2');
    onClose();
  };

  const sel = {
    width: '100%',
    background: '#0d1b2e',
    border: `1px solid ${colors.borderInput}`,
    borderRadius: 2,
    padding: '9px 12px',
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textPrimary,
    outline: 'none',
    cursor: 'pointer',
    appearance: 'none',
    WebkitAppearance: 'none',
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={handleClose}
    >
      <div
        style={{ background: '#0f1e30', border: `1px solid ${colors.border}`, borderRadius: 4, maxWidth: 420, width: '100%', boxShadow: '0 24px 64px rgba(0,0,0,0.6)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ padding: '14px 18px', borderBottom: `1px solid ${colors.borderSubtle}`, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontFamily: fonts.sans, fontSize: 11, fontWeight: 700, letterSpacing: '2px', textTransform: 'uppercase', color: colors.sectionHeaderBlue }}>
            🚨 Use Mulligan
          </span>
          <span style={{ ...theme.smallText }}>
            {isSignatureOrMajor ? 'Signature / Major' : 'Regular'} mulligan · {activeTournament.name}
          </span>
        </div>

        {/* Body */}
        <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>

          {/* Player OUT */}
          <div>
            <label style={{ ...theme.label, display: 'block', marginBottom: 6, color: colors.danger }}>Player Out</label>
            <select value={playerOut} onChange={e => setPlayerOut(e.target.value)} style={sel}>
              <option value="">Select...</option>
              {lineupPlayers.map(p => (
                <option key={p.name} value={p.name}>{p.name}</option>
              ))}
            </select>
          </div>

          {/* Player IN */}
          <div>
            <label style={{ ...theme.label, display: 'block', marginBottom: 6, color: colors.earningsGreen }}>Player In</label>
            <select value={playerIn} onChange={e => setPlayerIn(e.target.value)} style={sel}>
              <option value="">Select...</option>
              {benchPlayers.map(p => (
                <option key={p.name} value={p.name}>{p.name}</option>
              ))}
            </select>
          </div>

          {/* After round */}
          <div>
            <label style={{ ...theme.label, display: 'block', marginBottom: 8 }}>Takes Effect After</label>
            <div style={{ display: 'flex', gap: 6 }}>
              {['1', '2', '3'].map(r => (
                <button
                  key={r}
                  onClick={() => setAfterRound(r)}
                  style={{
                    flex: 1, padding: '9px 10px', borderRadius: 2,
                    fontFamily: fonts.sans, fontSize: 12, fontWeight: 600,
                    cursor: 'pointer', transition: 'all 0.15s',
                    background: afterRound === r ? colors.buttonNavy : 'transparent',
                    border: `1px solid ${afterRound === r ? colors.border : colors.borderInput}`,
                    color: afterRound === r ? colors.textGold : colors.textSecondary,
                  }}
                >
                  Round {r}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: '12px 18px', borderTop: `1px solid ${colors.borderSubtle}`, display: 'flex', gap: 8 }}>
          <button onClick={handleClose}
            style={{ ...theme.btnSecondary, flex: 1, padding: '10px 16px' }}>
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!playerOut || !playerIn}
            style={{ ...theme.btnPrimary, flex: 1, padding: '10px 16px', opacity: (!playerOut || !playerIn) ? 0.4 : 1, cursor: (!playerOut || !playerIn) ? 'not-allowed' : 'pointer' }}>
            Confirm Mulligan
          </button>
        </div>
      </div>
    </div>
  );
};
