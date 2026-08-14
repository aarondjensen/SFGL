// Guards reconcileRoundLeaders in api/pga-results.js.
//
//   node scripts/test-round-leader-sources.mjs
//
// Needs no credentials and makes no network calls.
//
// WHAT THIS PROTECTS
// ------------------
// A round leader is whoever holds the low cumulative score, and that is
// routinely more than one player. pgatour.com's page data names ONE — it is
// written to fill a "Round 3 Leader" slot on a page, not to enumerate a tie —
// while the score table gives the whole set by arithmetic.
//
// The old code preferred the JSON wholesale, and only consulted the scores when
// the JSON named nobody in ANY round. Michael Brennan tied Beau Hossler at 194
// after round 3 of the 2026 Wyndham and won the tournament; the JSON named one
// of them, and a $60,000 bonus went to nobody. The same gate also left a round
// empty whenever the JSON happened to carry the other two.
//
// The reconciliation is deliberately one-directional — scores may ADD
// co-leaders to a set the JSON already agrees with, and may never REPLACE a set
// it disagrees with. That asymmetry is the thing to keep: it recovers ties
// without letting a broken scrape invent a bonus.

import { reconcileRoundLeaders } from '../api/pga-results.js';

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? '  ok  ' : '  FAIL'}  ${label}`);
  if (!cond) failures++;
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('\nround-leader source reconciliation\n');

// ── The Wyndham ──────────────────────────────────────────────────────────────
{
  const json = { round1: ['Beau Hossler'], round2: ['Beau Hossler'], round3: ['Beau Hossler'] };
  const html = { round1: ['Beau Hossler'], round2: ['Aaron Wise', 'Beau Hossler'],
                 round3: ['Beau Hossler', 'Michael Brennan'] };
  const out = reconcileRoundLeaders(json, html);
  check('a co-lead the JSON dropped is recovered',
    out.round3.includes('Michael Brennan') && out.round3.includes('Beau Hossler'));
  check('an outright lead both agree on is left alone', eq(out.round1, ['Beau Hossler']));
}

// ── Per round, not all-or-nothing ────────────────────────────────────────────
{
  const json = { round1: ['A'], round2: ['B'], round3: [] };
  const html = { round1: ['A'], round2: ['B'], round3: ['C', 'D'] };
  const out = reconcileRoundLeaders(json, html);
  check('a round the JSON omits is filled from the scores', eq(out.round3, ['C', 'D']));
  check('...without disturbing the rounds it did carry',
    eq(out.round1, ['A']) && eq(out.round2, ['B']));
}

// ── The asymmetry ────────────────────────────────────────────────────────────
{
  const disagree = reconcileRoundLeaders({ round1: ['Real Leader'] }, { round1: ['Someone Else'] });
  check('sources naming different players keeps the JSON, not the union',
    eq(disagree.round1, ['Real Leader']));

  const partial = reconcileRoundLeaders(
    { round1: ['Named One', 'Named Two'] },
    { round1: ['Named One', 'Third Player'] });
  check('scores are refused when they drop a player the JSON named',
    eq(partial.round1, ['Named One', 'Named Two']));

  const superset = reconcileRoundLeaders(
    { round1: ['Named One'] },
    { round1: ['Named One', 'Tied With Him'] });
  check('scores are accepted when they only add to the JSON',
    eq(superset.round1, ['Named One', 'Tied With Him']));
}

// ── Names, not strings ───────────────────────────────────────────────────────
// The two sources are two renderings of the same page and spell these
// differently. A string compare would read every such round as a disagreement
// and quietly decline to recover its ties — a silent failure, which is the
// species of bug this whole area keeps producing.
{
  const nordic = reconcileRoundLeaders(
    { round3: ['Nicolai Hojgaard'] },
    { round3: ['Nicolai Højgaard', 'Ludvig Åberg'] });
  check('a Nordic spelling difference is not a disagreement',
    nordic.round3.length === 2);

  const hyphen = reconcileRoundLeaders(
    { round2: ['Sungjae Im'] },
    { round2: ['Sung-Jae Im', 'Si Woo Kim'] });
  check('an alias-group spelling is not a disagreement', hyphen.round2.length === 2);
}

// ── Degenerate inputs ────────────────────────────────────────────────────────
{
  check('no scores at all leaves the JSON untouched',
    eq(reconcileRoundLeaders({ round1: ['A'] }, null).round1, ['A']));
  check('no JSON at all takes the scores',
    eq(reconcileRoundLeaders(null, { round1: ['A', 'B'] }).round1, ['A', 'B']));
  check('neither source yields empty rounds, not undefined',
    eq(reconcileRoundLeaders(null, null), { round1: [], round2: [], round3: [] }));
  check('blank entries are dropped',
    eq(reconcileRoundLeaders({ round1: ['', null] }, { round1: ['A'] }).round1, ['A']));
  check('all three rounds are always present',
    Object.keys(reconcileRoundLeaders({ round1: ['A'] }, {})).length === 3);
}

console.log(failures ? `\n${failures} failure(s).\n` : '\nAll round-leader source tests passed.\n');
process.exit(failures ? 1 : 0);
