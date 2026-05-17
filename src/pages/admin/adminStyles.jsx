// src/pages/admin/adminStyles.jsx
// ============================================================================
// Shared style tokens used by every admin panel + a couple of small JSX
// helper components (SyncStatusBanner, LastSyncedLine).
//
// Wave I hotfix: this file was originally written as .js but contains JSX,
// which Vite refuses to parse without the .jsx extension. Same content as
// before — only the file extension changed.
//
// IMPORTANT: delete the old src/pages/admin/adminStyles.js file when you
// drop this in. Bare imports of './adminStyles' will resolve to .jsx
// automatically once .js is gone.
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


// ─────────────────────────────────────────────────────────────────────────────
// Modal-feel tokens (Wave J Round 6 follow-up)
//
// A second style system layered on top of S.*, modeled after the
// UserSettingsModal aesthetic — lighter borders, eyebrow headings instead
// of bright blue titles, more breathing room, less nesting.
//
// Old tokens (S.section, S.title) remain available for panels that haven't
// been migrated. As each panel restructures, it switches to M.* and the
// modal-feel cascade takes over for that panel.
//
// Usage pattern within a migrated panel:
//   <BackBar label="Tournament Results" onBack={back} />
//   <div style={M.page}>
//     <div style={M.descText}>One-line context for the page.</div>
//
//     <div style={M.group}>
//       <div style={M.eyebrow}>Tournament</div>
//       <select style={M.select}>...</select>
//     </div>
//
//     <div style={M.group}>
//       <div style={M.eyebrow}>Round Leaders</div>
//       ...
//     </div>
//
//     <button style={M.btnPrimary}>Process Results</button>
//   </div>
// ─────────────────────────────────────────────────────────────────────────────

export const M = {
  // Top-level page wrapper inside a drilled-in admin view. Sits below BackBar.
  // No border, no card chrome — just consistent spacing.
  page: {
    padding: '4px 4px 24px',
    display: 'flex',
    flexDirection: 'column',
    gap: 22,
  },

  // A single logical section. Just bottom margin — no card, no border.
  // Sections separate themselves with breathing room, not chrome.
  group: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },

  // Small uppercase muted heading that labels a group. Replaces S.title's
  // bright blue uppercase. Lower visual weight = less competition with
  // primary content.
  eyebrow: {
    fontFamily: fonts.sans,
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '1.8px',
    textTransform: 'uppercase',
    color: colors.textMuted,
    marginBottom: 2,
  },

  // Short paragraph of context that sits between eyebrow and content.
  descText: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 1.5,
  },

  // Selects + inputs — same shape as theme.select/input but with the lighter
  // border treatment used in the modal.
  select: {
    width: '100%',
    padding: '10px 12px',
    background: 'rgba(255,255,255,0.02)',
    border: `1px solid ${colors.borderSubtle}`,
    borderRadius: 6,
    color: colors.textPrimary,
    fontSize: 13,
    fontFamily: fonts.sans,
    appearance: 'none',
    WebkitAppearance: 'none',
    cursor: 'pointer',
  },
  input: {
    width: '100%',
    padding: '10px 12px',
    background: 'rgba(255,255,255,0.02)',
    border: `1px solid ${colors.borderSubtle}`,
    borderRadius: 6,
    color: colors.textPrimary,
    fontSize: 13,
    fontFamily: fonts.sans,
  },

  // Primary action button — green-tinted, lifts subtly on hover.
  // The hover lift is applied via the .modal-feel-btn CSS class (defined in
  // app-global.css) for the cleanest transition behavior; this token sets
  // the static styles.
  btnPrimary: {
    width: '100%',
    padding: '12px 16px',
    background: 'rgba(80,195,120,0.12)',
    border: '1px solid rgba(80,195,120,0.35)',
    borderRadius: 6,
    color: colors.earningsGreen,
    fontSize: 13,
    fontFamily: fonts.sans,
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'background 0.15s, border-color 0.15s, transform 0.1s',
  },

  // Secondary button — neutral, used for navigation or non-primary actions.
  btnSecondary: {
    width: '100%',
    padding: '10px 14px',
    background: 'rgba(255,255,255,0.03)',
    border: `1px solid ${colors.borderSubtle}`,
    borderRadius: 6,
    color: colors.textSecondary,
    fontSize: 12,
    fontFamily: fonts.sans,
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'background 0.15s, border-color 0.15s, transform 0.1s',
  },

  // Warning button — used for destructive-but-recoverable actions like
  // reprocessing a completed tournament. Orange-tinted.
  btnWarning: {
    width: '100%',
    padding: '12px 16px',
    background: 'rgba(220,150,50,0.1)',
    border: '1px solid rgba(220,150,50,0.35)',
    borderRadius: 6,
    color: 'rgba(220,180,80,0.95)',
    fontSize: 13,
    fontFamily: fonts.sans,
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'background 0.15s, border-color 0.15s, transform 0.1s',
  },

  // Danger button — used for irreversible destructive actions.
  btnDanger: {
    width: '100%',
    padding: '12px 16px',
    background: 'rgba(220,80,80,0.08)',
    border: '1px solid rgba(220,80,80,0.35)',
    borderRadius: 6,
    color: colors.danger,
    fontSize: 13,
    fontFamily: fonts.sans,
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'background 0.15s, border-color 0.15s, transform 0.1s',
  },

  // Interactive row used for tappable items in a list (rosters, settings,
  // toggles). Lifts on hover.
  liftRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 12px',
    background: 'rgba(255,255,255,0.02)',
    border: `1px solid ${colors.borderSubtle}`,
    borderRadius: 6,
    cursor: 'pointer',
    transition: 'background 0.15s, border-color 0.15s, transform 0.1s',
  },

  // Status row — non-interactive, shows current state (e.g. "Subscribed",
  // "Tournament in progress"). Same shape as liftRow but no cursor and
  // no transitions.
  statusRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 12px',
    background: 'rgba(255,255,255,0.02)',
    border: `1px solid ${colors.borderSubtle}`,
    borderRadius: 6,
  },

  // Status dot — small colored circle for the status row.
  statusDot: (color) => ({
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: color,
    flexShrink: 0,
  }),
};

// Helper that adds hover-lift behavior to interactive elements styled with
// M.btnPrimary / M.btnSecondary / M.btnWarning / M.liftRow. Apply via
// className alongside the inline style — the CSS file handles :hover.
export const liftClass = 'modal-feel-lift';

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
