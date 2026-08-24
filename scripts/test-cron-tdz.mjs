// Guard: no handler in api/cron.js may read one of its own `const` bindings
// before the line that declares it.
//
// THE BUG. handleProcessResults scored each team with
//
//     const scoredLineup = [...lineupFor(newTournaments[ti], team)];
//
// while `const newTournaments = ...` sits ~130 lines further down, after the
// loop. That is a temporal dead zone: evaluating the name throws
// `ReferenceError: Cannot access 'newTournaments' before initialization` on the
// FIRST team, so the handler 500s before it reads a single result.
//
// It stayed invisible for six days because an `if (!team.lineup ||
// team.lineup.length === 0) return team;` guard used to sit above that line.
// Completing an event clears every team's lineup, so on the one Monday the
// handler ran, every team returned early and the poisoned expression was never
// evaluated. When that guard was replaced by one that reads `scoredLineup`, the
// only line that could produce scoredLineup moved to the top of the body and
// the crash became unconditional — which is how the season's final event, the
// BMW Championship, went unprocessed.
//
// Nothing caught it. `js.configs.recommended` does not enable
// no-use-before-define, the build never evaluates api/, and every existing cron
// test reads the file as TEXT rather than running it. So this scans the source
// for the defect class directly: for each top-level `const NAME =` inside a
// top-level function, any earlier reference to NAME in that same body is a TDZ
// error waiting for the first request that reaches it.
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') =>
  cond ? (pass++, console.log('  ok   ' + name))
       : (fail++, console.log('  FAIL ' + name + (extra ? '\n       ' + extra : '')));

// ── Blank out comments, strings and regex literals ───────────────────────────
// Replaced with spaces rather than removed so every index still lines up with
// the original source and line numbers stay reportable.
function blankNonCode(src) {
  const out = src.split('');
  const blank = (from, to) => {
    for (let i = from; i < to && i < out.length; i++) if (out[i] !== '\n') out[i] = ' ';
  };
  // The token before a '/' decides whether it opens a regex or is division.
  const REGEX_PRECEDERS = '(,=:[!&|?{};+-*%~^<>';
  let i = 0, lastReal = '';
  while (i < src.length) {
    const c = src[i], next = src[i + 1];
    if (c === '/' && next === '/') {
      let j = src.indexOf('\n', i); if (j === -1) j = src.length;
      blank(i, j); i = j; continue;
    }
    if (c === '/' && next === '*') {
      let j = src.indexOf('*/', i + 2); j = j === -1 ? src.length : j + 2;
      blank(i, j); i = j; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) break;
        j++;
      }
      blank(i + 1, j); i = j + 1; lastReal = c; continue;
    }
    if (c === '/' && REGEX_PRECEDERS.includes(lastReal)) {
      let j = i + 1, inClass = false, closed = false;
      while (j < src.length && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) { closed = true; break; }
        j++;
      }
      if (closed) { blank(i, j + 1); i = j + 1; lastReal = ')'; continue; }
    }
    if (!/\s/.test(c)) lastReal = c;
    i++;
  }
  return out.join('');
}

// ── Find each top-level function body ────────────────────────────────────────
function topLevelFunctions(code) {
  const found = [];
  const re = /^(?:export\s+default\s+)?(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
  let m;
  while ((m = re.exec(code)) !== null) {
    const open = code.indexOf('{', re.lastIndex);
    if (open === -1) continue;
    let depth = 0, end = -1;
    for (let i = open; i < code.length; i++) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) continue;
    found.push({ name: m[1], start: open + 1, end });
  }
  return found;
}

// A reference that is really an object KEY (`{ foo: bar }`, `{ foo: baz } =`)
// binds nothing and reads nothing, so it is not a use.
function isObjectKey(body, idx, name) {
  const after = body.slice(idx + name.length);
  if (!/^\s*:/.test(after)) return false;
  const before = body.slice(0, idx).replace(/\s+$/, '');
  return before.endsWith('{') || before.endsWith(',');
}

function tdzViolations(src) {
  const code = blankNonCode(src);
  const violations = [];
  for (const fn of topLevelFunctions(code)) {
    const body = code.slice(fn.start, fn.end);
    // Only declarations at the function's own top level (two-space indent).
    // Anything nested is a different scope and needs real scope analysis.
    const decl = /^ {2}(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/gm;
    let d;
    while ((d = decl.exec(body)) !== null) {
      const name = d[1];
      const declAt = d.index;
      const use = new RegExp(`(?<![.\\w$])${name}(?![\\w$])`, 'g');
      let u;
      while ((u = use.exec(body)) !== null) {
        if (u.index >= declAt) break;
        if (isObjectKey(body, u.index, name)) continue;
        const line = src.slice(0, fn.start + u.index).split('\n').length;
        violations.push({ fn: fn.name, name, line,
          declLine: src.slice(0, fn.start + declAt).split('\n').length });
        break;
      }
    }
  }
  return violations;
}

console.log('\n── the scanner detects a TDZ read ──');
{
  const broken = `
async function handleThing(res) {
  const teams = await load();
  const scored = teams.map(t => later[0]);
  const later = [1, 2, 3];
  return res.json({ scored });
}
`;
  const v = tdzViolations(broken);
  check('flags a const read before its declaration',
    v.length === 1 && v[0].name === 'later' && v[0].fn === 'handleThing',
    JSON.stringify(v));

  const fixed = broken.replace('later[0]', 'teams[0]');
  check('clean once the read is moved off the later binding',
    tdzViolations(fixed).length === 0, JSON.stringify(tdzViolations(fixed)));

  // The exact shape that broke process-results: the read is legal-looking
  // because a guard above it used to make it unreachable.
  const guarded = `
async function handleProcessResults(res) {
  const teams = await load();
  const updated = teams.map(t => {
    const lineup = [...lineupFor(newT[ti], t)];
    if (!lineup.length) return t;
    return score(lineup);
  });
  const newT = [];
  return res.json({ updated, newT });
}
`;
  const gv = tdzViolations(guarded);
  check('flags the process-results shape', gv.length === 1 && gv[0].name === 'newT',
    JSON.stringify(gv));
}

console.log('\n── comments, strings and regexes are not code ──');
{
  const src = `
function handleX(res) {
  // mentions later before it exists
  const s = 'later and later';
  const t = \`also later\`;
  const r = /later/g;
  const later = 1;
  return later + s + t + r;
}
`;
  check('a name only in comments/strings/regex is not a use',
    tdzViolations(src).length === 0, JSON.stringify(tdzViolations(src)));

  const keys = `
function handleY(res) {
  const payload = { roundLeaders: rl, other: 1 };
  const roundLeaders = payload.roundLeaders;
  return roundLeaders;
}
`;
  check('an object KEY spelled like a later const is not a use',
    tdzViolations(keys).length === 0, JSON.stringify(tdzViolations(keys)));
}

console.log('\n── api/cron.js ──');
{
  const src = readFileSync(new URL('../api/cron.js', import.meta.url), 'utf8');
  const v = tdzViolations(src);
  check('no handler reads a const before declaring it', v.length === 0,
    v.map(x => `${x.fn}: "${x.name}" read at line ${x.line}, declared at line ${x.declLine}`).join('\n       '));

  // The specific regression, stated in its own terms so a future edit that
  // reintroduces it fails with the reason rather than just a line number.
  const proc = src.slice(src.indexOf('async function handleProcessResults'));
  const loop = proc.slice(proc.indexOf('const updatedTeams = teams.map'),
                          proc.indexOf('const newTournaments ='));
  check('the scoring loop does not reach for newTournaments',
    !/newTournaments/.test(loop.replace(/\/\/[^\n]*/g, '')),
    'newTournaments is declared after the loop — use `tournament` / `tournaments`');
  check('the scoring loop scores the frozen lineup',
    /lineupFor\(tournament, team\)/.test(loop));
}

console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
