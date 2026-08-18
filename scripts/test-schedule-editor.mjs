// Guards the commissioner's schedule editor (src/pages/TournamentsView.jsx).
//
// What it looked like on a phone: one eight-column table at every width, with
// `tableLayout: fixed`, `width: 100%` and — in edit mode only — no <colgroup>.
// Fixed layout with no widths splits the table evenly, so on a 390px viewport
// every column got ~44px and every header and control painted over its
// neighbour. "TOURNAMENT" sat on top of "DATES", "LOCATION / COURSE" ran
// through "SWING", and the Lock column left the screen. The wrapper had
// `overflowX: auto` and never scrolled, because a 100%-wide table never
// exceeds its container — it just crushes its own columns.
//
// Three separate causes, each guarded below:
//   1. no column widths in edit mode, and no minimum width to scroll to;
//   2. one layout for every viewport, when eight editable fields do not fit on
//      a phone in any arrangement;
//   3. theme.input / theme.select declare width:100% with padding and no
//      box-sizing, so every input in the app overflowed its parent by 30px.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { theme } from '../src/theme.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') =>
  cond ? (pass++, console.log('  ok   ' + name))
       : (fail++, console.log('  FAIL ' + name + ' ' + extra));

const src = readFileSync('src/pages/TournamentsView.jsx', 'utf8');

console.log('\n── every table declares its columns ──');
{
  // Both edit and read-only tables. A <table> with tableLayout:fixed and no
  // colgroup is the exact shape of the bug.
  const tables = src.split(/<table\b/).slice(1);
  check('both schedule tables exist', tables.length === 2, `found ${tables.length}`);
  const missing = tables.filter(t => !t.slice(0, 1400).includes('<colgroup>'));
  check('no fixed-layout table without a colgroup', missing.length === 0,
    `${missing.length} table(s) size their columns by division`);

  // Eight columns of controls need more width than a laptop always has, so the
  // table must be wider than its wrapper and let the wrapper scroll — a table
  // pinned to 100% cannot overflow, it can only crush.
  check('the edit table sets a minWidth so its wrapper can scroll',
    /minWidth: 1140/.test(src));
  check('…and the wrapper is the thing that scrolls',
    /overflowX: 'auto' \}\}>\{renderEditTable/.test(src));
}

console.log('\n── the phone gets a different layout, not a smaller table ──');
{
  check('a card list exists for narrow viewports', /renderEditCards = \(list, kind\)/.test(src));

  // The first version of the card list was one labelled form per event: six
  // rows and ~380px each, so a 31-event schedule ran about eleven screens.
  // It reads as one line per event now and opens the editor in place.
  check('events are collapsed to a summary row by default',
    /const open = editingRow === i;/.test(src));
  check('the summary row is keyboard-activatable (house a11y helper)',
    /\{\.\.\.activatable\(\(\) => setEditingRow\(open \? null : i\)/.test(src));
  check('one editor open at a time', /const \[editingRow, setEditingRow\] = useState\(null\)/.test(src));
  check('the active checkbox does not also toggle the editor',
    /onClick=\{e => e\.stopPropagation\(\)\}/.test(src));

  // The summary row holds exactly four things: name, dates, the swing as the
  // row's left edge colour, and the S/M badge. Everything else — location,
  // course, lock, type, delete — is in the editor. Spelling the swing out cost
  // the row a second line for a word repeated down the whole list.
  const row = src.slice(src.indexOf('{/* Summary row'), src.indexOf('{/* Editor — only for the open row'));
  check('the swing is a colour on the row, not a word',
    /background: segIsSet \? getSwingColor\(seg\) : red\(0\.9\)/.test(row) && !/\{seg\}/.test(row));
  check('an unset swing is still flagged on the row', /⚠/.test(row));
  check('the row shows the dates', /\{t\.dates \|\| '—'\}/.test(row));
  check('the row shows the signature/major badge', /<TournamentBadges/.test(row));
  check('location and course are not on the row',
    !/t\.location/.test(row) && !/t\.course/.test(row));

  // 165px of name column ellipses a third of the schedule to "FedEx St. Jude
  // Cham…", which is the truncation this rework exists to remove.
  check('a long name wraps to a second line instead of truncating',
    /WebkitLineClamp: 2/.test(row) && !/textOverflow: 'ellipsis'/.test(row));
  check('the row height matches the read-only table\'s', /minHeight: 44/.test(row));
  check('the editor picks between them on width',
    /useCardEditor\s*\?\s*\n?\s*renderEditCards/.test(src));
  check('the breakpoint clears the table\'s own minimum',
    /useIsMobile\(900\)/.test(src));

  // The two layouts must render the SAME controls. Defining a field twice is
  // how one of them ends up missing the swing warning or the lock's Auto label.
  for (const fn of ['activeToggle', 'typeBadges', 'textField', 'swingSelect', 'lockSelect', 'deleteButton']) {
    const defs = (src.match(new RegExp(`const ${fn} = `, 'g')) || []).length;
    check(`${fn} is defined exactly once`, defs === 1, `defined ${defs} times`);
  }
  check('the card list renders the swing control', /swingSelect\(t, i, false\)/.test(src));
  check('the table renders the same one', /swingSelect\(t, i, true\)/.test(src));
}

console.log('\n── an editable row is identified by identity, not by its name ──');
{
  // Both edit renderers used `key={t.name}` and looked their row up with
  // findIndex on the name. The name is one of the fields being edited: React
  // sees a new key on every keystroke, unmounts the row, and the input loses
  // focus after each character — and the open editor, keyed the same way,
  // closed itself.
  const editSection = src.slice(src.indexOf('const renderEditCards'), src.indexOf('const renderTable'));
  check('no edit row is keyed by the name being typed into',
    !/key=\{t\.name\}/.test(editSection));
  check('rows resolve by object identity',
    (editSection.match(/localTournaments\.indexOf\(t\)/g) || []).length === 2,
    'expected both edit renderers to use indexOf');
  check('no name-based row lookup remains in the editors',
    !/findIndex\(lt => lt\.name === t\.name\)/.test(editSection));
  check('deleting a row closes the editor rather than re-targeting it',
    /setEditingRow\(null\);\n\s*setLocalTournaments\(prev => prev\.filter/.test(src));
  check('a newly added row opens straight into its editor',
    /setEditingRow\(localTournaments\.length\)/.test(src));
}

console.log('\n── inputs fit the box they are in ──');
{
  check('theme.input is border-box', theme.input.boxSizing === 'border-box',
    `got ${theme.input.boxSizing}`);
  check('theme.select is border-box', theme.select.boxSizing === 'border-box',
    `got ${theme.select.boxSizing}`);
  check('both still declare width:100% (which is why it matters)',
    theme.input.width === '100%' && theme.select.width === '100%');

  // A grid item's min-width is min-content, and a <select>'s min-content is its
  // longest option — 1fr tracks let the swing box widen past the card.
  check('the card\'s two-up row uses minmax, not bare fractions',
    /repeat\(auto-fit, minmax\(168px, 1fr\)\)/.test(src));
}

console.log('\n── a colour is a colour, not a triple ──');
{
  // `rgba(${activeColor}, 0.15)` where activeColor was already 'rgba(...)'
  // produced `rgba(rgba(130,80,200,0.8), 0.15)` — not a colour, so the browser
  // dropped the declaration and a selected badge had no fill at all. withAlpha
  // in theme.js is the one place allowed to build an rgba() from parts.
  const walk = (dir, out = []) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.jsx?$/.test(p)) out.push(p);
    }
    return out;
  };
  const offenders = [];
  for (const file of walk('src')) {
    if (file.endsWith('theme.js')) continue;
    // Comments are prose — including this bug's own postmortem, which quotes
    // the broken expression. Same stripping the palette guard uses.
    const body = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter(l => !/^\s*(\/\/|\*)/.test(l))
      .join('\n');
    body.split('\n').forEach((line, n) => {
      if (/rgba\(\$\{/.test(line)) offenders.push(`${file}:${n + 1}`);
    });
  }
  check('nothing interpolates a value into rgba() outside theme.js',
    offenders.length === 0, offenders.join(' '));
}

console.log('\n── one definition of "is this a phone" ──');
{
  const hook = readFileSync('src/hooks/useIsMobile.js', 'utf8');
  check('the hook is reactive to resize', /addEventListener\('resize'/.test(hook));
  check('it defaults to the app-wide 640 breakpoint', /breakpoint = 640/.test(hook));

  // Three copies existed before, two of them non-reactive reads at render.
  const walk = (dir, out = []) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.jsx?$/.test(p)) out.push(p);
    }
    return out;
  };
  const dupes = walk('src').filter(f =>
    !f.endsWith('useIsMobile.js') && /const useIsMobile = /.test(readFileSync(f, 'utf8')));
  check('no view declares its own useIsMobile', dupes.length === 0, dupes.join(' '));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
