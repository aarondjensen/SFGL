// src/pages/admin/adminStyles.js
// ============================================================================
// Shared style tokens used by every admin panel. Was previously a local `S`
// const inside AdminView's render — extracted here so each panel can share
// the same look without redefining.
// ============================================================================

import { theme, colors, fonts } from '../../theme.js';

export const S = {
  section: {
    background: colors.cardBg,
    border: `1px solid ${colors.border}`,
    borderRadius: 4,
    padding: '16px 18px',
    marginBottom: 12,
  },
  title: {
    fontFamily: fonts.sans,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '1.8px',
    textTransform: 'uppercase',
    color: colors.sectionHeaderBlue,
    marginBottom: 12,
  },
  btn: {
    ...theme.btnPrimary,
    width: '100%',
    padding: '10px 16px',
    textAlign: 'center',
    display: 'block',
    cursor: 'pointer',
  },
  btnSec: {
    ...theme.btnSecondary,
    width: '100%',
    padding: '10px 16px',
    textAlign: 'center',
    display: 'block',
    cursor: 'pointer',
  },
  btnDgr: {
    ...theme.btnDanger,
    width: '100%',
    padding: '10px 16px',
    textAlign: 'center',
    display: 'block',
    cursor: 'pointer',
  },
  input: {
    ...theme.input,
    marginBottom: 8,
  },
  select: {
    ...theme.select,
    marginBottom: 8,
    color: colors.textPrimary,
    backgroundColor: '#0d1b2e',
    appearance: 'none',
    WebkitAppearance: 'none',
  },
  lbl: {
    ...theme.label,
    display: 'block',
    marginBottom: 6,
  },
};

// Helper for disabled-button styling
export const disabledBtn = (disabled) =>
  disabled ? { opacity: 0.4, cursor: 'not-allowed', pointerEvents: 'none' } : {};

// ── Status banner shared by sync panels (OWGR / LIV / Aliases) ──────────────
export const SyncStatusBanner = ({ status, summary }) => {
  if (!summary) return null;
  const isError = status === 'error';
  return (
    <div style={{
      marginTop: 10,
      padding: '8px 12px',
      borderRadius: 3,
      fontSize: 12,
      fontFamily: fonts.sans,
      whiteSpace: 'pre-wrap',
      background: isError ? colors.dangerBg : 'rgba(80,160,100,0.1)',
      border: `1px solid ${isError ? colors.dangerBorder : 'rgba(80,160,100,0.3)'}`,
      color: isError ? colors.danger : colors.success,
    }}>
      {summary}
    </div>
  );
};

// ── "Last synced" line shared by sync panels ────────────────────────────────
export const LastSyncedLine = ({ timestamp }) => {
  if (!timestamp) return null;
  return (
    <div style={{ ...theme.smallText, color: colors.textGoldDim, marginBottom: 10 }}>
      Last synced: {new Date(timestamp).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      })}
    </div>
  );
};
