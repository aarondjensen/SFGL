/**
 * ============================================================================
 * SFGL THEME
 * Single source of truth for all visual styles across the app.
 * To change the look of every view at once, edit values here.
 * ============================================================================
 */

// ── Color tokens ─────────────────────────────────────────────────────────────
export const colors = {
  // Backgrounds
  pageBg:        '#111d2e',
  cardBg:        'rgba(255,255,255,0.03)',
  cardBgHover:   'rgba(255,255,255,0.055)',
  rowHover:      'rgba(255,255,255,0.04)',
  headerBg:      'linear-gradient(90deg, rgba(16,40,72,0.5) 0%, transparent 100%)',
  inputBg:       'rgba(255,255,255,0.04)',
  inputBgFocus:  'rgba(255,255,255,0.07)',
  buttonNavy:    '#1c3a5e',
  buttonNavyHover: '#22456e',
  sectionHeaderBlue: 'rgba(100,160,255,0.90)',   // bright blue for AdminView section headers
  actionButtonBlue:  '#163253',                  // darker navy for action buttons inside sections

  // Borders
  border:        'rgba(180,160,100,0.15)',
  borderSubtle:  'rgba(255,255,255,0.06)',
  borderInput:   'rgba(255,255,255,0.1)',
  borderFocus:   'rgba(180,160,100,0.5)',

  // Text
  textPrimary:   'rgba(255,255,255,0.9)',
  textSecondary: 'rgba(255,255,255,0.4)',
  textMuted:     'rgba(255,255,255,0.2)',
  textLabel:     'rgba(255,255,255,0.25)',
  textGold:      'rgba(180,160,100,0.9)',
  textGoldDim:   'rgba(180,160,100,0.5)',

  // Semantic
  success:       'rgba(80,180,120,0.85)',
  earningsGreen:      'rgba(80,195,120,0.95)',   // season earnings — full green
  earningsGreenLight: 'rgba(100,210,150,0.65)',  // swing earnings — softer green
  danger:        'rgba(220,80,80,0.85)',
  dangerBg:      'rgba(180,60,60,0.12)',
  dangerBorder:  'rgba(180,60,60,0.3)',
  warning:       'rgba(220,170,60,0.85)',

  // Medal positions
  medal1:        { bg: 'rgba(180,160,100,0.9)',  text: '#111d2e' },
  medal2:        { bg: 'rgba(180,180,190,0.75)', text: '#111d2e' },
  medal3:        { bg: 'rgba(160,110,60,0.8)',   text: '#fff'    },
  medalDefault:  { bg: 'rgba(255,255,255,0.06)', text: 'rgba(255,255,255,0.4)' },
};

// ── Typography ────────────────────────────────────────────────────────────────
// Matches the LoginPage font stack: Cormorant Garamond for display/serif,
// Raleway for UI/sans. Google Fonts import is injected in App.jsx root.
export const fonts = {
  serif:      "'Cormorant Garamond', Georgia, serif",
  sans:       "'Raleway', system-ui, sans-serif",
  mono:       "'Roboto Mono', 'JetBrains Mono', 'Fira Mono', monospace",
};

// ── Spacing / shape ───────────────────────────────────────────────────────────
export const shape = {
  cardRadius:  3,
  inputRadius: 1,
  btnRadius:   1,
};

// ── Reusable style objects ────────────────────────────────────────────────────
// Use these directly on JSX elements: <div style={theme.card}>

export const theme = {

  // ── Layout ──
  page: {
    minHeight: '100vh',
    background: colors.pageBg,
    color: colors.textPrimary,
    paddingBottom: 80,
  },

  // ── Cards ──
  card: {
    background: colors.cardBg,
    border: `1px solid ${colors.border}`,
    borderRadius: shape.cardRadius,
    overflow: 'hidden',
  },

  // Card with hover lift — apply via onMouseEnter/Leave using cardLiftHandlers()
  cardLift: {
    background: colors.cardBg,
    border: `1px solid ${colors.border}`,
    borderRadius: shape.cardRadius,
    overflow: 'hidden',
    transition: 'transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease',
    cursor: 'pointer',
  },

  cardHeader: {
    padding: '16px 20px',
    background: colors.headerBg,
    borderBottom: `1px solid ${colors.borderSubtle}`,
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },

  cardBody: {
    padding: '16px 20px',
  },

  cardSection: {
    padding: '12px 20px',
    borderBottom: `1px solid ${colors.borderSubtle}`,
  },

  // ── Typography ──
  h1: {
    fontFamily: fonts.serif,
    fontSize: "clamp(24px, 2.2vw, 30px)",
    fontWeight: 400,
    color: colors.textPrimary,
    letterSpacing: '0.3px',
  },

  h2: {
    fontFamily: fonts.serif,
    fontSize: "clamp(17px, 1.5vw, 22px)",
    fontWeight: 400,
    color: colors.textPrimary,
    letterSpacing: '0.5px',
  },

  h3: {
    fontFamily: fonts.serif,
    fontSize: "clamp(15px, 1.3vw, 18px)",
    fontWeight: 400,
    color: colors.textPrimary,
    letterSpacing: '0.3px',
  },

  label: {
    fontFamily: fonts.sans,
    fontSize: "clamp(10px, 0.85vw, 12px)",
    fontWeight: 600,
    letterSpacing: '1.5px',
    textTransform: 'uppercase',
    color: colors.textLabel,
  },

  bodyText: {
    fontFamily: fonts.sans,
    fontSize: "clamp(13px, 1.1vw, 15px)",
    color: colors.textSecondary,
  },

  smallText: {
    fontFamily: fonts.sans,
    fontSize: "clamp(11px, 0.95vw, 13px)",
    color: colors.textMuted,
  },

  // Monospace stat numbers — for earnings, scores, rankings
  statNum: {
    fontFamily: fonts.mono,
    fontVariantNumeric: 'tabular-nums',
    letterSpacing: '-0.3px',
  },

  statNumLg: {
    fontFamily: fonts.mono,
    fontVariantNumeric: 'tabular-nums',
    fontSize: "clamp(15px, 1.3vw, 18px)",
    fontWeight: 500,
    letterSpacing: '-0.5px',
  },

  goldText: {
    fontFamily: fonts.serif,
    color: colors.textGold,
  },

  // ── Table ──
  tableHeaderCell: {
    padding: '8px 16px',
    fontSize: "clamp(10px, 0.85vw, 12px)",
    fontWeight: 600,
    letterSpacing: '1.5px',
    textTransform: 'uppercase',
    color: colors.textLabel,
    fontFamily: fonts.sans,
    borderBottom: `1px solid ${colors.borderSubtle}`,
    background: 'rgba(255,255,255,0.02)',
  },

  tableCell: {
    padding: '12px 16px',
    borderBottom: `1px solid ${colors.borderSubtle}`,
  },

  tableRow: {
    transition: 'background 0.15s',
    cursor: 'default',
  },

  // ── Inputs ──
  input: {
    width: '100%',
    background: colors.inputBg,
    border: `1px solid ${colors.borderInput}`,
    borderRadius: shape.inputRadius,
    padding: '10px 14px',
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textPrimary,
    outline: 'none',
    transition: 'border-color 0.2s, background 0.2s',
    caretColor: colors.textGold,
  },

  select: {
    width: '100%',
    background: colors.inputBg,
    border: `1px solid ${colors.borderInput}`,
    borderRadius: shape.inputRadius,
    padding: '9px 14px',
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textPrimary,
    outline: 'none',
    cursor: 'pointer',
  },

  // ── Buttons ──
  btnPrimary: {
    background: colors.buttonNavy,
    border: `1px solid ${colors.border}`,
    borderRadius: shape.btnRadius,
    padding: '9px 18px',
    fontFamily: fonts.sans,
    fontSize: "clamp(11px, 0.9vw, 13px)",
    fontWeight: 600,
    letterSpacing: '1.5px',
    textTransform: 'uppercase',
    color: colors.textGold,
    cursor: 'pointer',
    transition: 'all 0.2s',
  },

  btnSecondary: {
    background: 'transparent',
    border: `1px solid ${colors.borderInput}`,
    borderRadius: shape.btnRadius,
    padding: '9px 18px',
    fontFamily: fonts.sans,
    fontSize: "clamp(11px, 0.9vw, 13px)",
    fontWeight: 600,
    letterSpacing: '1.5px',
    textTransform: 'uppercase',
    color: colors.textSecondary,
    cursor: 'pointer',
    transition: 'all 0.2s',
  },

  btnDanger: {
    background: colors.dangerBg,
    border: `1px solid ${colors.dangerBorder}`,
    borderRadius: shape.btnRadius,
    padding: '9px 18px',
    fontFamily: fonts.sans,
    fontSize: "clamp(11px, 0.9vw, 13px)",
    fontWeight: 600,
    letterSpacing: '1.5px',
    textTransform: 'uppercase',
    color: colors.danger,
    cursor: 'pointer',
    transition: 'all 0.2s',
  },

  btnIconSmall: {
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    padding: 4,
    color: colors.textSecondary,
    display: 'flex',
    alignItems: 'center',
    transition: 'color 0.2s',
  },

  // ── Badges / pills ──
  badge: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '2px 8px',
    borderRadius: 2,
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: '1px',
    textTransform: 'uppercase',
    fontFamily: fonts.sans,
  },

  badgeGold: {
    background: 'rgba(180,160,100,0.12)',
    border: '1px solid rgba(180,160,100,0.25)',
    color: colors.textGold,
  },

  badgeNavy: {
    background: 'rgba(20,45,82,0.5)',
    border: '1px solid rgba(20,45,82,0.8)',
    color: 'rgba(150,170,220,0.8)',
  },

  badgeDanger: {
    background: colors.dangerBg,
    border: `1px solid ${colors.dangerBorder}`,
    color: colors.danger,
  },

  badgeSuccess: {
    background: 'rgba(80,180,120,0.1)',
    border: '1px solid rgba(80,180,120,0.25)',
    color: colors.success,
  },

  badgeCut: {
    background: 'rgba(220,80,80,0.1)',
    border: '1px solid rgba(220,80,80,0.25)',
    color: colors.danger,
  },

  badgeWarning: {
    background: 'rgba(220,170,60,0.1)',
    border: '1px solid rgba(220,170,60,0.25)',
    color: colors.warning,
  },

  // ── Dividers ──
  divider: {
    height: 1,
    background: colors.borderSubtle,
    border: 'none',
    margin: '0',
  },

  dividerGold: {
    height: 1,
    background: `linear-gradient(90deg, transparent, ${colors.borderFocus}, transparent)`,
    border: 'none',
    margin: '16px 0',
  },

  // ── Empty state ──
  emptyState: {
    padding: '48px 20px',
    textAlign: 'center',
    color: colors.textMuted,
    fontFamily: fonts.serif,
    fontSize: 14,
    letterSpacing: '0.5px',
  },
};

// ── Helper: medal style by position index ─────────────────────────────────────
export const getMedalStyle = (index) => {
  if (index === 0) return colors.medal1;
  if (index === 1) return colors.medal2;
  if (index === 2) return colors.medal3;
  return colors.medalDefault;
};

// ── Helper: row hover handlers ────────────────────────────────────────────────
export const rowHoverHandlers = (isHighlighted = false) => ({
  onMouseEnter: (e) => { e.currentTarget.style.background = colors.rowHover; },
  onMouseLeave: (e) => { e.currentTarget.style.background = isHighlighted ? 'rgba(180,160,100,0.04)' : 'transparent'; },
});

// ── Helper: earnings color ────────────────────────────────────────────────────
export const earningsColor = (amount) =>
  (amount || 0) > 0 ? colors.earningsGreen : colors.textMuted;

export const segmentEarningsColor = (amount) =>
  (amount || 0) > 0 ? colors.earningsGreenLight : colors.textMuted;

// ── Helper: card lift hover handlers ─────────────────────────────────────────
export const cardLiftHandlers = () => ({
  onMouseEnter: (e) => {
    e.currentTarget.style.transform = 'translateY(-2px)';
    e.currentTarget.style.boxShadow = '0 8px 32px rgba(0,0,0,0.3)';
    e.currentTarget.style.borderColor = 'rgba(180,160,100,0.3)';
  },
  onMouseLeave: (e) => {
    e.currentTarget.style.transform = 'translateY(0)';
    e.currentTarget.style.boxShadow = 'none';
    e.currentTarget.style.borderColor = 'rgba(180,160,100,0.15)';
  },
});
