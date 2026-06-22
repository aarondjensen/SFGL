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
  textMuted:     'rgba(255,255,255,0.32)',   // bumped from 0.2 — em-dashes / empty-state were near-invisible in sunlight
  textLabel:     'rgba(255,255,255,0.25)',
  textGold:      '#f5c518',
  textGoldDim:   'rgba(245,197,24,0.45)',

  // Semantic
  success:       'rgba(80,180,120,0.85)',
  earningsGreen:      'rgba(80,195,120,0.95)',   // season earnings — full green
  earningsGreenLight: 'rgba(100,210,150,0.65)',  // swing earnings — softer green
  danger:        'rgba(220,80,80,0.85)',
  dangerBg:      'rgba(180,60,60,0.12)',
  dangerBorder:  'rgba(180,60,60,0.3)',
  warning:       'rgba(220,170,60,0.85)',
  warningBg:     'rgba(220,170,60,0.1)',
  warningBorder: 'rgba(220,170,60,0.4)',

  // Medal positions
  medal1:        { bg: 'rgba(180,160,100,0.9)',  text: '#111d2e' },
  medal2:        { bg: 'rgba(180,180,190,0.75)', text: '#111d2e' },
  medal3:        { bg: 'rgba(160,110,60,0.8)',   text: '#fff'    },
  medalDefault:  { bg: 'rgba(255,255,255,0.06)', text: 'rgba(255,255,255,0.4)' },
};

// ── Typography ────────────────────────────────────────────────────────────────
const RALEWAY = "'Raleway', system-ui, sans-serif";
export const fonts = {
  serif: RALEWAY,
  sans:  RALEWAY,
  mono:  RALEWAY,
};

// ── Spacing / shape ───────────────────────────────────────────────────────────
export const shape = {
  cardRadius:  3,
  inputRadius: 1,
  btnRadius:   1,
};

// ── Font size scale ───────────────────────────────────────────────────────────
// Semantic scale, fixed-pixel (mobile-first). Six sizes, each with a clear
// role. Use these tokens app-wide; only escape to inline pixels for true
// special cases (icon-as-glyph sizing, tier-letter badges).
//
//   xs   10px  — eyebrow labels, tiny metadata, rank badges
//   sm   12px  — helper text, descriptions, captions
//   base 13px  — body, list items, button labels, player names, table cells
//   md   14px  — section titles, slightly emphasized content
//   lg   16px  — form inputs, selects, modal titles, prominent values
//   xl   20px  — page headers, major totals
//
// (Previously these were responsive `clamp()` values. They've been migrated to
// fixed pixels because the responsive ranges overlapped, making roles ambiguous;
// and because in practice the codebase was authoring most copy at the high-end
// pixel values anyway. If the app ever needs to scale up on huge screens, this
// is the single place to reintroduce a media query or container-query rule.)
export const fontSize = {
  xs:   10,
  sm:   12,
  base: 13,
  md:   14,
  lg:   16,
  xl:   20,
  // xxl kept for back-compat with any straggler import; rarely used in
  // practice. Major totals should use xl instead.
  xxl:  24,

  // Sub-text / icon sizes. These are NOT for readable body content —
  // they're for tiny pip badges (star counts, "Backup" labels, mulligan
  // chips) and large emoji used as visual markers (admin tile icons).
  // Splitting them off from the regular scale keeps the body-text scale
  // semantic and prevents anyone from reaching for `badge` when they
  // really wanted `xs`.
  badge:    8,    // overlay pips, tier-letter labels, micro-captions
  tileIcon: 22,   // emoji icons on the admin tile grid
};

// ── Reusable style objects ────────────────────────────────────────────────────

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

  // ── Section header bar + title — single source of truth ───────────────
  // The white-gradient "SEASON"-style header shared by Standings, Rosters,
  // Transactions, and Tournaments. Bar + title both live here so one edit
  // (e.g. font size) cascades to every tab. Views spread these and override
  // only what's local (swing-accent tint, full-bleed margins, natural-case
  // team name). No justifyContent here — Tournaments puts an icon beside its
  // title; the space-between tabs add it themselves.
  sectionHeaderBar: {
    padding: '8px 14px',
    // Standardized header-bar height across all views. With 8px top/bottom
    // padding (16px total), a 36px min content area yields a uniform 52px-tall
    // gradient bar everywhere — sized to RostersView's selector bar (its
    // mulligan cluster is the tallest content), so nothing gets clipped.
    minHeight: 36,
    background: 'linear-gradient(90deg, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0.04) 60%, transparent 100%)',
    borderBottom: `1px solid ${colors.borderSubtle}`,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },

  sectionTitle: {
    fontFamily: fonts.sans,
    fontSize: fontSize.lg,
    fontWeight: 700,
    letterSpacing: '2px',
    textTransform: 'uppercase',
    color: colors.textPrimary,
    minHeight: 28,
    display: 'inline-flex',
    alignItems: 'center',
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
    fontSize: fontSize.xxl,
    fontWeight: 400,
    color: colors.textPrimary,
    letterSpacing: '0.3px',
  },

  h2: {
    fontFamily: fonts.serif,
    fontSize: fontSize.xl,
    fontWeight: 400,
    color: colors.textPrimary,
    letterSpacing: '0.5px',
  },

  h3: {
    fontFamily: fonts.serif,
    fontSize: fontSize.lg,
    fontWeight: 400,
    color: colors.textPrimary,
    letterSpacing: '0.3px',
  },

  label: {
    fontFamily: fonts.sans,
    fontSize: fontSize.sm,
    fontWeight: 600,
    letterSpacing: '1.5px',
    textTransform: 'uppercase',
    color: colors.textLabel,
  },

  bodyText: {
    fontFamily: fonts.sans,
    fontSize: fontSize.md,
    color: colors.textSecondary,
  },

  smallText: {
    fontFamily: fonts.sans,
    fontSize: fontSize.base,
    color: colors.textMuted,
  },

  statNum: {
    fontFamily: fonts.mono,
    fontVariantNumeric: 'tabular-nums lining-nums',
    letterSpacing: '-0.3px',
  },

  statNumLg: {
    fontFamily: fonts.mono,
    fontVariantNumeric: 'tabular-nums lining-nums',
    fontSize: fontSize.lg,
    fontWeight: 500,
    letterSpacing: '-0.5px',
  },

  goldText: {
    fontFamily: fonts.serif,
    color: colors.textGold,
  },

  // ── Table ──
  // Two row-density tiers used across the app:
  //
  //   HERO tier  → tableCell (12px padding) + .sfgl-row-hero (56/52px height)
  //                Standings — single-line content, comfortable spacing.
  //
  //   LIST tier  → tableCellList (8px padding) + .sfgl-row-list (44/40px min-height)
  //                Rosters, Tournaments, Results, Transactions — many rows,
  //                multi-line content tolerant.
  //
  // Both row classes live in app-global.css. Apply the matching cell padding
  // from theme.tableCell or theme.tableCellList here, and the row class on
  // the <tr> (or <div> row) — that keeps row height predictable across views.
  tableHeaderCell: {
    padding: '8px 16px',
    fontSize: fontSize.sm,
    fontWeight: 600,
    letterSpacing: '1.5px',
    textTransform: 'uppercase',
    color: colors.textLabel,
    fontFamily: fonts.sans,
    borderBottom: `1px solid ${colors.borderSubtle}`,
    background: 'rgba(255,255,255,0.02)',
  },

  // Hero-tier cell — used by Standings.
  tableCell: {
    padding: '12px 16px',
    borderBottom: `1px solid ${colors.borderSubtle}`,
  },

  // List-tier cell — for dense, scannable tables (Rosters, Tournaments,
  // Results, Transactions). 8px vertical padding pairs with .sfgl-row-list
  // for a consistent ~44px row height across all list-style views.
  // Horizontal 14px matches the existing rhythm in TournamentsView and
  // ResultsView headers — switching them to this token is a no-op there.
  tableCellList: {
    padding: '8px 14px',
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
    colorScheme: 'dark',
  },

  // ── Buttons ──
  btnPrimary: {
    background: colors.buttonNavy,
    border: `1px solid ${colors.border}`,
    borderRadius: shape.btnRadius,
    padding: '9px 18px',
    fontFamily: fonts.sans,
    fontSize: fontSize.base,
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
    fontSize: fontSize.base,
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
    fontSize: fontSize.base,
    fontWeight: 600,
    letterSpacing: '1.5px',
    textTransform: 'uppercase',
    color: colors.danger,
    cursor: 'pointer',
    transition: 'all 0.2s',
  },

  btnWarning: {
    background: colors.warningBg,
    border: `1px solid ${colors.warningBorder}`,
    borderRadius: shape.btnRadius,
    padding: '9px 18px',
    fontFamily: fonts.sans,
    fontSize: fontSize.base,
    fontWeight: 600,
    letterSpacing: '1.5px',
    textTransform: 'uppercase',
    color: colors.warning,
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

  badgeInProgress: {
    background: 'rgba(80,200,120,0.15)',
    border: '1px solid rgba(80,200,120,0.4)',
    color: 'rgba(80,200,120,0.9)',
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
export const cardLiftHandlers = ({ disabled = false } = {}) => ({
  onMouseEnter: (e) => {
    if (disabled) return;
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

// ── Swing names + accent colors (single source of truth) ────────────────
export const SWINGS = ['West Coast Swing', 'Spring Swing', 'Summer Swing', 'Fall Finish'];

export const SWING_COLORS = {
  'West Coast Swing': 'rgba(220,190,100,0.85)',
  'Spring Swing':     'rgba(80,200,120,0.85)',
  'Summer Swing':     'rgba(120,180,255,0.85)',
  'Fall Finish':      'rgba(230,150,80,0.85)',
};

export const getSwingColor = (swing) => SWING_COLORS[swing] || colors.textSecondary;

export const getSwingColorAt = (swing, alpha) => {
  const c = getSwingColor(swing);
  return c.replace(/,\s*[\d.]+\s*\)\s*$/, `,${alpha})`);
};
