// Guards the hue palette in src/theme.js.
//
// 1. Each helper must emit the exact rgba string it replaced — the sweep that
//    introduced them relied on byte-identical output, so a typo in a hue would
//    silently restyle the app.
// 2. No palette hue may be written as a literal anywhere in src/ again. That is
//    how ~70 hues accumulated for eight roles in the first place: there was
//    nothing to drift FROM, so every new colour was retyped by hand.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  withAlpha, colors,
  fontSize,
  white, black, navy, gold, brass, amber, green, greenMuted,
  red, blue, blueBright, steel, purple, yellow, scrim,
} from '../src/theme.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') =>
  cond ? (pass++, console.log('  ok   ' + name))
       : (fail++, console.log('  FAIL ' + name + ' ' + extra));

// ── 1. Helper output is exact ─────────────────────────────────────────────
const HELPERS = {
  white: [white, '255,255,255'], black: [black, '0,0,0'], navy: [navy, '17,29,46'],
  gold: [gold, '245,197,24'], brass: [brass, '180,160,100'], amber: [amber, '220,170,60'],
  green: [green, '80,195,120'], greenMuted: [greenMuted, '80,180,120'],
  red: [red, '220,80,80'], blue: [blue, '100,160,255'], blueBright: [blueBright, '100,180,255'],
  steel: [steel, '100,140,220'], purple: [purple, '130,80,200'],
  yellow: [yellow, '220,200,80'], scrim: [scrim, '5,10,25'],
};
let bad = [];
for (const [name, [fn, rgb]] of Object.entries(HELPERS)) {
  for (const a of ['0.04', '0.5', '0.95', '1']) {
    if (fn(a) !== `rgba(${rgb},${a})`) bad.push(`${name}(${a}) = ${fn(a)}`);
  }
}
check(`all ${Object.keys(HELPERS).length} helpers emit exact rgba strings`, bad.length === 0, bad.join(' '));
check('withAlpha composes any hue', withAlpha('1,2,3', 0.5) === 'rgba(1,2,3,0.5)');

// ── 2. Tokens still resolve to the values they had before the refactor ─────
const EXPECTED = {
  cardBg: 'rgba(255,255,255,0.03)', cardBgHover: 'rgba(255,255,255,0.055)',
  rowHover: 'rgba(255,255,255,0.04)', inputBg: 'rgba(255,255,255,0.04)',
  inputBgFocus: 'rgba(255,255,255,0.07)', border: 'rgba(180,160,100,0.15)',
  borderSubtle: 'rgba(255,255,255,0.06)', borderInput: 'rgba(255,255,255,0.1)',
  borderFocus: 'rgba(180,160,100,0.5)', textPrimary: 'rgba(255,255,255,0.9)',
  textSecondary: 'rgba(255,255,255,0.4)', textMuted: 'rgba(255,255,255,0.32)',
  textLabel: 'rgba(255,255,255,0.25)', textGoldDim: 'rgba(245,197,24,0.45)',
  success: 'rgba(80,180,120,0.85)', earningsGreen: 'rgba(80,195,120,0.95)',
  danger: 'rgba(220,80,80,0.85)', warning: 'rgba(220,170,60,0.85)',
  warningBg: 'rgba(220,170,60,0.1)', warningBorder: 'rgba(220,170,60,0.4)',
  sectionHeaderBlue: 'rgba(100,160,255,0.9)',
};
const drifted = Object.entries(EXPECTED).filter(([k, v]) => colors[k] !== v)
  .map(([k, v]) => `${k}: ${colors[k]} (was ${v})`);
check(`all ${Object.keys(EXPECTED).length} tokens unchanged by the refactor`, drifted.length === 0, drifted.join('; '));

// dangerBg/dangerBorder were deliberately re-based onto the one red.
check('dangerBg re-based onto the danger red', colors.dangerBg === 'rgba(220,80,80,0.12)');
check('dangerBorder re-based onto the danger red', colors.dangerBorder === 'rgba(220,80,80,0.3)');

// ── 3. No palette hue may reappear as a literal ───────────────────────────
const PALETTE = new Set(Object.values(HELPERS).map(([, rgb]) => rgb));
const walk = (dir, out = []) => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.jsx?$/.test(p)) out.push(p);
  }
  return out;
};
// Comments are prose, not styling. This file's own header quotes the literals
// it replaced, and so do several of the notes left behind in src/ explaining
// what a value used to be — those are documentation, and flagging them would
// train people to delete the explanation rather than the duplication.
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')                    // block comments
  .split('\n')
  .filter(l => !/^\s*(\/\/|\*)/.test(l))                 // whole-line comments
  .join('\n');

const offenders = [];
for (const file of walk('src')) {
  const src = stripComments(readFileSync(file, 'utf8'));
  for (const m of src.matchAll(/rgba\(\s*(\d+\s*,\s*\d+\s*,\s*\d+)\s*,\s*[0-9.]+\)/g)) {
    const rgb = m[1].replace(/\s/g, '');
    if (!PALETTE.has(rgb)) continue;
    // theme.js is allowed to name its own hues.
    if (file.endsWith('theme.js')) continue;
    const line = src.slice(0, m.index).split('\n').length;
    offenders.push(`${file}:${line} ${m[0]}`);
  }
}
check('no palette hue is written as a literal outside theme.js',
  offenders.length === 0, '\n      ' + offenders.join('\n      '));

// ── 4. Font scale ─────────────────────────────────────────────────────────
// The scale must be able to express what the app actually authors. 199 sizes
// were written as bare pixels before this, 57 of them at 11px — a size the
// scale had no name for at all.
check('scale names the app\'s most-used size', fontSize.caption === 11);
check('scale is ordered', fontSize.xs < fontSize.caption && fontSize.caption < fontSize.sm
  && fontSize.sm < fontSize.base && fontSize.base < fontSize.md
  && fontSize.md < fontSize.lg && fontSize.lg < fontSize.xl && fontSize.xl < fontSize.xxl);

// Only these sizes may still be written as raw pixels. They are the documented
// off-scale remainder (see the note in theme.js): snapping them is a visual
// decision about the app's look, not a consistency fix, so they are pinned here
// rather than silently changed — and nothing NEW may join them.
const ALLOWED_RAW = new Set([9, 15, 18]);
const rawSizes = [];
for (const file of walk('src')) {
  if (file.endsWith('theme.js')) continue;
  const src = stripComments(readFileSync(file, 'utf8'));
  for (const m of src.matchAll(/fontSize: ([0-9.]+)/g)) {
    if (!ALLOWED_RAW.has(Number(m[1]))) {
      rawSizes.push(`${file}:${src.slice(0, m.index).split('\n').length} ${m[0]}`);
    }
  }
}
check('no font size outside the scale except the documented remainder',
  rawSizes.length === 0, '\n      ' + rawSizes.join('\n      '));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
