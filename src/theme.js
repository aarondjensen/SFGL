/**
 * ============================================================================
 * SFGL THEME
 * Single source of truth for all visual styles across the app.
 * To change the look of every view at once, edit values here.
 * ============================================================================
 */

// ── Hue palette ──────────────────────────────────────────────────────────────
// Every colour in the app is one of these hues at some alpha. The RGB triples
// below are the ONLY place a hue is written down; the tokens beneath and the
// call sites throughout src/ all go through the helpers.
//
// Before this existed, colours were authored as literal rgba() strings wherever
// they were needed — 454 of them, spelling out ~70 distinct hues to serve about
// eight semantic roles. Fifteen different reds, twelve golds, eight blues, five
// purples. Most were within a couple of points of each other and plainly meant
// to be the same colour; they drifted because there was nothing to drift from.
//
// Alpha stays free-form on purpose. The thing worth pinning is the HUE — that a
// destructive action is always THIS red — while opacity legitimately varies by
// context (a 6% fill, a 30% border, an 85% label). Naming forty
// hue+alpha combinations would have been a worse trade.
const HUES = {
  white:      '255,255,255',
  black:      '0,0,0',
  navy:       '17,29,46',    // page-background family (#111d2e)
  gold:       '245,197,24',  // the SFGL accent
  brass:      '180,160,100', // muted gold — borders, medals, card edges
  amber:      '220,170,60',  // warnings
  green:      '80,195,120',  // earnings, success fills
  greenMuted: '80,180,120',  // the softer green used for success text/badges
  red:        '220,80,80',   // destructive / danger
  blue:       '100,160,255', // informational accents, admin section headers
  blueBright: '100,180,255', // the lighter blue used on stats toggles + OWGR
  steel:      '100,140,220', // "unlimited" player tier
  purple:     '130,80,200',  // mulligan markers
  yellow:     '220,200,80',  // pending / awaiting-action states (waiver queue)
  scrim:      '5,10,25',     // modal backdrops
};

/** Compose any palette hue with an alpha: withAlpha(HUES.gold, 0.4). */
export const withAlpha = (hue, a) => `rgba(${hue},${a})`;

// Per-hue shorthands. `white(0.04)` reads better than rgba(255,255,255,0.04)
// and, more to the point, cannot be typed as a slightly different white.
export const white      = (a) => withAlpha(HUES.white, a);
export const black      = (a) => withAlpha(HUES.black, a);
export const navy       = (a) => withAlpha(HUES.navy, a);
export const gold       = (a) => withAlpha(HUES.gold, a);
export const brass      = (a) => withAlpha(HUES.brass, a);
export const amber      = (a) => withAlpha(HUES.amber, a);
export const green      = (a) => withAlpha(HUES.green, a);
export const greenMuted = (a) => withAlpha(HUES.greenMuted, a);
export const red        = (a) => withAlpha(HUES.red, a);
export const blue       = (a) => withAlpha(HUES.blue, a);
export const blueBright = (a) => withAlpha(HUES.blueBright, a);
export const steel      = (a) => withAlpha(HUES.steel, a);
export const purple     = (a) => withAlpha(HUES.purple, a);
export const yellow     = (a) => withAlpha(HUES.yellow, a);
export const scrim      = (a) => withAlpha(HUES.scrim, a);

// ── Color tokens ─────────────────────────────────────────────────────────────
export const colors = {
  // Backgrounds
  pageBg:        '#111d2e',
  cardBg:        white(0.03),
  cardBgHover:   white(0.055),
  rowHover:      white(0.04),
  headerBg:      'linear-gradient(90deg, rgba(16,40,72,0.5) 0%, transparent 100%)',
  inputBg:       white(0.04),
  inputBgFocus:  white(0.07),
  // OPAQUE background for a <select>. theme.select's inputBg is a translucent
  // white, and a native dropdown list painted over a translucent background
  // renders white-on-white in several browsers — so every select that has to
  // stay readable overrode it with this hex by hand, in three places. Named
  // here so the fourth one doesn't invent its own navy.
  selectBg:      '#0d1b2e',
  buttonNavy:    '#1c3a5e',
  buttonNavyHover: '#22456e',
  sectionHeaderBlue: blue(0.90),   // bright blue for AdminView section headers
  actionButtonBlue:  '#163253',    // darker navy for action buttons inside sections

  // Borders
  border:        brass(0.15),
  borderSubtle:  white(0.06),
  borderInput:   white(0.1),
  borderFocus:   brass(0.5),

  // Text
  textPrimary:   white(0.9),
  textSecondary: white(0.4),
  textMuted:     white(0.32),   // bumped from 0.2 — em-dashes / empty-state were near-invisible in sunlight
  textLabel:     white(0.25),
  textGold:      '#f5c518',
  textGoldDim:   gold(0.45),

  // Semantic
  success:       greenMuted(0.85),
  earningsGreen:      green(0.95),        // season earnings — full green
  earningsGreenLight: 'rgba(100,210,150,0.65)',  // swing earnings — deliberately lighter than `green`
  danger:        red(0.85),
  // dangerBg/dangerBorder were authored on rgba(180,60,60) while `danger`
  // itself is rgba(220,80,80) — the same role wearing two different reds, far
  // enough apart (dE ~12) to see when a danger fill sits next to danger text.
  // Both now use the one red; at 12% and 30% alpha over navy the shift is
  // barely perceptible, and it is the only way the family stays coherent.
  dangerBg:      red(0.12),
  dangerBorder:  red(0.3),
  warning:       amber(0.85),
  warningBg:     amber(0.1),
  warningBorder: amber(0.4),

  // Medal positions
  medal1:        { bg: brass(0.9),               text: '#111d2e' },
  medal2:        { bg: 'rgba(180,180,190,0.75)', text: '#111d2e' },
  medal3:        { bg: 'rgba(160,110,60,0.8)',   text: '#fff'    },
  medalDefault:  { bg: white(0.06),              text: white(0.4) },
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
  xs:      10,
  // The single most-used size in the app (57 hand-written call sites before
  // this token existed, 41 of them in the admin panels) and the one the scale
  // had no name for — so it sat between xs and sm as a raw literal everywhere.
  // A scale that cannot express its most common size is why 199 font sizes
  // were authored as bare pixels.
  caption: 11,
  sm:      12,
  base:    13,
  md:      14,
  lg:      16,
  xl:      20,
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

// ── Still off-scale ──────────────────────────────────────────────────────────
// Thirteen call sites remain on sizes this scale does not name: 9px (5 — tiny
// pips that are probably `badge`), 15px (4 — menu rows and modal titles, between
// base and lg) and 18px (4 — modal/error headings, between lg and xl). Each
// would snap to a neighbouring token with a 1-2px shift.
//
// Left alone on purpose. Adding tokens for all three would give the scale
// 8/9/10/11/12/13/14/15/16/18/20/22/24 — a ruler, not a scale — and snapping
// them is a visual decision about the app's look rather than a consistency fix.
// Worth doing, but as a deliberate choice, not as a side effect of this sweep.

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
    //
    // (This key was previously declared twice — 32 then 36 — each with its own
    // comment claiming to be the standard. 36 was the one taking effect.)
    minHeight: 36,
    background: `linear-gradient(90deg, ${white(0.12)} 0%, ${white(0.04)} 60%, transparent 100%)`,
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
  // HERO tier → tableCell (12px padding) + .sfgl-row-hero (56/52px height),
  // defined in app-global.css. Standings is the only table using it: few rows,
  // single-line content, comfortable spacing.
  //
  // This comment used to describe a second LIST tier — tableCellList paired
  // with a .sfgl-row-list class — for Rosters, Tournaments and Transactions.
  // Neither the class nor the token was ever applied anywhere; the class did
  // not exist in the stylesheet at all, and the token had no importers. The
  // two-tier system was real only in this comment, while .sfgl-row-hero itself
  // was broken (the stylesheet spelled it .sfgl-standings-row), so even the
  // tier that IS used was not enforcing its height.
  //
  // Those three views still hand-roll their own row padding and do not agree
  // with each other. Unifying them is a genuine change to three views and
  // belongs in its own piece of work — not smuggled in under a comment fix.
  tableHeaderCell: {
    padding: '8px 16px',
    fontSize: fontSize.sm,
    fontWeight: 600,
    letterSpacing: '1.5px',
    textTransform: 'uppercase',
    color: colors.textLabel,
    fontFamily: fonts.sans,
    borderBottom: `1px solid ${colors.borderSubtle}`,
    background: white(0.02),
  },

  // Hero-tier cell — used by Standings.
  tableCell: {
    padding: '12px 16px',
    borderBottom: `1px solid ${colors.borderSubtle}`,
  },

  tableRow: {
    transition: 'background 0.15s',
    cursor: 'default',
  },

  // ── Inputs ──
  //
  // fontSize.lg (16px) is deliberate on both, for two reasons that happen to
  // agree:
  //
  //   1. The scale above already assigns lg the role "form inputs, selects" —
  //      these two were the only places that documented a token and then
  //      hardcoded a different raw value (13).
  //   2. iOS Safari force-zooms the viewport when a focused control computes
  //      to under 16px, and does not zoom back out. Every text input and
  //      select in the app did that on every tap. StandingsView had already
  //      hit this and worked around it locally ("≥16px to prevent iOS zoom")
  //      — the fix just never reached the shared token.
  //
  // No `outline: 'none'` here. It suppressed the focus ring on every input and
  // select in the app, and app-global.css supplies a styled :focus-visible ring
  // in its place — visible to keyboard and switch-control users, invisible to
  // mouse users, which is what the bare outline reset was reaching for.
  input: {
    width: '100%',
    // border-box, because the width above is 100%. Without it the padding and
    // border are ADDED to the parent's full width, so every input in the app
    // sits 30px wider than the box it is in and clips on the right — which is
    // what the schedule editor's fields were doing inside their card.
    boxSizing: 'border-box',
    background: colors.inputBg,
    border: `1px solid ${colors.borderInput}`,
    borderRadius: shape.inputRadius,
    padding: '10px 14px',
    fontFamily: fonts.sans,
    fontSize: fontSize.lg,
    color: colors.textPrimary,
    transition: 'border-color 0.2s, background 0.2s',
    caretColor: colors.textGold,
  },

  select: {
    width: '100%',
    boxSizing: 'border-box',   // see theme.input
    background: colors.inputBg,
    border: `1px solid ${colors.borderInput}`,
    borderRadius: shape.inputRadius,
    padding: '9px 14px',
    fontFamily: fonts.sans,
    fontSize: fontSize.lg,
    color: colors.textPrimary,
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
    fontSize: fontSize.xs,
    fontWeight: 600,
    letterSpacing: '1px',
    textTransform: 'uppercase',
    fontFamily: fonts.sans,
  },

  badgeGold: {
    background: brass(0.12),
    border: `1px solid ${brass(0.25)}`,
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
    background: greenMuted(0.1),
    border: `1px solid ${greenMuted(0.25)}`,
    color: colors.success,
  },

  badgeInProgress: {
    background: green(0.15),
    border: `1px solid ${green(0.4)}`,
    color: green(0.9),
  },

  badgeCut: {
    background: red(0.1),
    border: `1px solid ${red(0.25)}`,
    color: colors.danger,
  },

  badgeWarning: {
    background: amber(0.1),
    border: `1px solid ${amber(0.25)}`,
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
    fontSize: fontSize.md,
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
  onMouseLeave: (e) => { e.currentTarget.style.background = isHighlighted ? brass(0.04) : 'transparent'; },
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
    e.currentTarget.style.boxShadow = `0 8px 32px ${black(0.3)}`;
    e.currentTarget.style.borderColor = brass(0.3);
  },
  onMouseLeave: (e) => {
    e.currentTarget.style.transform = 'translateY(0)';
    e.currentTarget.style.boxShadow = 'none';
    e.currentTarget.style.borderColor = brass(0.15);
  },
});

// ── Swing accent colors ─────────────────────────────────────────────────
// SWINGS itself is league data, not visual data, so it lives in
// api/_league.js — the one module both deploy targets can import. It is
// re-exported here because every view that wants the swing list also wants
// these colors, and splitting the import would just move the papercut.
// This file previously declared its own identical copy of the array.
export { SWINGS } from '../api/_league.js';

export const SWING_COLORS = {
  'West Coast Swing': 'rgba(220,190,100,0.85)',
  'Spring Swing':     `${green(0.85)}`,
  'Summer Swing':     'rgba(120,180,255,0.85)',
  'Fall Finish':      'rgba(230,150,80,0.85)',
};

export const getSwingColor = (swing) => SWING_COLORS[swing] || colors.textSecondary;

export const getSwingColorAt = (swing, alpha) => {
  const c = getSwingColor(swing);
  return c.replace(/,\s*[\d.]+\s*\)\s*$/, `,${alpha})`);
};
