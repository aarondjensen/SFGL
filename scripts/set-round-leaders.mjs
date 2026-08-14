// Retroactively correct the round leaders a past tournament pays bonuses off.
//
// Usage:
//   node scripts/set-round-leaders.mjs --file scripts/fixtures/round-leader-corrections-2026.json
//   node scripts/set-round-leaders.mjs --file <corrections.json> --apply
//
// DRY RUN BY DEFAULT. Nothing is written until --apply.
// Needs Firebase Admin credentials — see scripts/_adminCreds.mjs.
//
// WHY THIS EXISTS
// ---------------
// Round-leader bonuses are the one part of a tournament result that is not
// derived from anything. Earnings come from a feed; the leaders are typed in
// during manual entry or scraped, and if they are missing NOTHING downstream
// notices — the event processes cleanly and simply pays no bonuses. Two 2026
// signature events went through with no leaders recorded at all, costing
// $220,000 across three teams, and the only reason it surfaced was a sheet
// comparison.
//
// The Admin panel can enter them by hand, which is the right tool for one
// event. This exists for the case the panel is bad at: removing one name from
// a round without disturbing the others, and applying several corrections
// across several events as one reviewable, re-runnable change.
//
// A WRITE HERE IS HALF THE FIX. Bonuses live in results.teams[id].totalEarnings
// and players[].bonus, and roll up into team.earnings and segmentEarnings —
// none of which this touches. The commissioner must REPROCESS each tournament
// in Admin → Tournament Results afterwards, which reverses the old result and
// re-applies from the corrected leaders. Same contract as
// scripts/set-locked-lineups.mjs.
//
// CORRECTIONS FILE
//   [
//     { "tournament": "RBC Heritage",
//       "set": { "round1": ["Ludvig Åberg"], "round2": ["Matt Fitzpatrick"] } },
//     { "tournament": "RBC Canadian Open",
//       "remove": { "round1": ["Brooks Koepka"] } }
//   ]
//
// `set` replaces a round's leaders outright; `remove` takes named players out
// and leaves the rest alone. Rounds not mentioned are untouched by either.
// Both are idempotent — re-running a correction that is already applied
// reports "no change" rather than failing, so a partial run can be repeated.
//
// TWO LISTS, NOT ONE
// ------------------
// A tournament stores `roundLeaders` (filtered to players who were actually
// started, which is what the bonus display reads) and `roundLeadersAll` (every
// leader, which is what lets a mulligan added later credit a player who led a
// round without having been started). Writing only one leaves them
// contradicting each other, so this script always writes both: the full list
// to roundLeadersAll, and the subset that appears in some team's scored lineup
// to roundLeaders. That subset is derived here rather than declared in the
// file, which means the dry run tells you exactly which names will collect.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { adminDb } from './_adminCreds.mjs';
import { namesMatch } from '../api/_playerNames.js';
import { scoredLineupFor } from '../api/_rules.js';

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const ROUNDS = ['round1', 'round2', 'round3'];
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Exact name, then case-insensitive, then "sheet tab name inside the full title". */
function findByName(docs, wanted) {
  const exact = docs.find(d => d.name === wanted);
  if (exact) return exact;
  const ci = docs.find(d => norm(d.name) === norm(wanted));
  if (ci) return ci;
  const wt = norm(wanted).split(' ').filter(Boolean);
  const subset = docs.filter(d => {
    const dt = new Set(norm(d.name).split(' ').filter(Boolean));
    return wt.length && wt.every(t => dt.has(t));
  });
  // Ambiguity is refused, not guessed: "RBC" matches Heritage AND Canadian Open.
  return subset.length === 1 ? subset[0] : null;
}

export const asList = (v) => (Array.isArray(v) ? v.filter(Boolean) : (v ? [v] : []));
export const sameList = (a, b) =>
  a.length === b.length && a.every((n, i) => namesMatch(n, b[i]));

/**
 * The whole correction, as a pure function: current leaders + one correction
 * + who was started → the two lists to store.
 *
 * Separated from the Firestore walk so it can be tested, because the invariant
 * it carries is not obvious from either call site: `filtered` must always be a
 * subset of `all` under name equivalence. Storing a filtered list containing a
 * name that is not in the full list is how the two records start disagreeing
 * about who led a round, which is the state this whole script exists to leave
 * behind rather than create.
 *
 * `set` replaces a round outright; `remove` subtracts from it; a round named by
 * neither is carried through untouched. Both are applied in that order, so a
 * correction may legitimately do both to the same round.
 */
export function applyRoundLeaderCorrection({ currentAll = {}, correction = {}, startedNames = [] }) {
  const all = {};
  for (const r of ROUNDS) {
    let list = asList(currentAll[r]);
    if (correction.set && correction.set[r] !== undefined) list = asList(correction.set[r]);
    if (correction.remove && correction.remove[r] !== undefined) {
      const drop = asList(correction.remove[r]);
      list = list.filter(n => !drop.some(d => namesMatch(d, n)));
    }
    all[r] = list;
  }

  const filtered = {};
  for (const r of ROUNDS) {
    filtered[r] = all[r].filter(n => startedNames.some(s => namesMatch(s, n)));
  }
  return { all, filtered };
}

async function main() {
  const filePath = arg('--file', null);
  const apply = process.argv.includes('--apply');
  if (!filePath) {
    console.error('Usage: node scripts/set-round-leaders.mjs --file <corrections.json> [--apply]');
    process.exit(2);
  }
  // Constructed inside main, not at module scope: the pure correction logic
  // above is imported by scripts/test-round-leaders.mjs, and a top-level
  // adminDb() would make that import demand production credentials.
  const db = adminDb();

  const corrections = JSON.parse(readFileSync(filePath, 'utf8'));
  if (!Array.isArray(corrections) || !corrections.length) {
    console.error('Corrections file must be a non-empty array.');
    process.exit(2);
  }

  const [tSnap, teamSnap] = await Promise.all([
    db.collection('tournaments').get(),
    db.collection('teams').get(),
  ]);
  const tournaments = tSnap.docs.map(d => ({ _id: d.id, ...d.data() }));
  const teams = teamSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  const writes = new Map();
  let failed = 0;

  for (const c of corrections) {
    const t = findByName(tournaments, c.tournament);
    if (!t) { console.error(`✗ no single tournament matches "${c.tournament}"`); failed++; continue; }
    if (!c.set && !c.remove) {
      console.error(`✗ ${t.name}: needs either "set" or "remove"`); failed++; continue;
    }

    // Everyone any team was scored with, so a leader can be told apart from a
    // name that collects nothing.
    //
    // scoredLineupFor, NOT lineupFor. lineupFor falls through to team.lineup —
    // the manager's CURRENT five — which for a finished event is next week's
    // lineup, and every leader is then judged against a lineup that did not
    // exist when the tournament was played. That is not hypothetical: the first
    // version of this script used lineupFor, computed "nobody was started" for
    // every event, and wrote an empty bonus list over a correct one.
    const started = [];
    const guessed = [];
    for (const team of teams) {
      const { lineup, source } = scoredLineupFor(t, team);
      started.push(...lineup.filter(Boolean));
      if (source === 'live') guessed.push(team.name || team.id);
    }
    if (guessed.length) {
      console.warn(`⚠ ${t.name}: no scored lineup recorded for ${guessed.join(', ')} — ` +
        `falling back to their CURRENT lineup, which may not be who played.`);
    }

    const currentAll = t.results?.roundLeadersAll || t.results?.roundLeaders || {};
    const { all: nextAll, filtered: nextFiltered } = applyRoundLeaderCorrection({
      currentAll, correction: c, startedNames: started,
    });

    // A name that appears twice in one round would pay its bonus twice.
    for (const r of ROUNDS) {
      const dupe = nextAll[r].find((n, i) => nextAll[r].findIndex(m => namesMatch(m, n)) !== i);
      if (dupe) {
        console.error(`✗ ${t.name} / ${r}: "${dupe}" listed twice`);
        failed++;
      }
    }

    // ── Report ───────────────────────────────────────────────────────────────
    // Built up and printed under the tournament's own heading rather than
    // logged as it goes, so a note about one event cannot appear under the
    // previous event's name.
    //
    // Every round is reported, changed or not, and the full list and the
    // collecting subset are always both shown. The first version printed only
    // rounds whose FULL list moved — which is why a run that corrected exactly
    // the thing this script exists to correct, the started-only list, printed
    // the tournament name and nothing else, then wrote. A dry run that shows
    // nothing is not a dry run.
    const notes = [];
    const rows = [];

    // Removing a name that is not there is a no-op, but removing one that is
    // spelled differently than you think is a silent no-op — and this script
    // exists because silent no-ops in bonus data cost $220,000. So say it.
    if (c.remove) {
      for (const r of ROUNDS) {
        for (const n of asList(c.remove[r])) {
          const wasThere = asList(currentAll[r]).some(m => namesMatch(m, n));
          const stillListed = asList(t.results?.roundLeaders?.[r]).some(m => namesMatch(m, n));
          if (!wasThere && !stillListed) {
            notes.push(`   ${r}: "${n}" was not listed — nothing to remove`);
          }
        }
      }
    }

    for (const r of ROUNDS) {
      const wasAll = asList(currentAll[r]);
      const wasPaid = asList(t.results?.roundLeaders?.[r]);
      const allMoved = !sameList(wasAll, nextAll[r]);
      const paidMoved = !sameList(wasPaid, nextFiltered[r]);
      const mark = allMoved || paidMoved ? '→' : ' ';
      rows.push(`   ${mark} ${r}  led: ${nextAll[r].join(', ') || '—'}` +
        (allMoved ? `   (was ${wasAll.join(', ') || '—'})` : ''));
      rows.push(`     ${' '.repeat(r.length)}  collects: ${nextFiltered[r].join(', ') || 'nobody — none of them was started'}` +
        (paidMoved ? `   (was ${wasPaid.join(', ') || '—'})` : ''));
    }

    const unchanged = ROUNDS.every(r =>
      sameList(nextAll[r], asList(currentAll[r])) &&
      sameList(nextFiltered[r], asList(t.results?.roundLeaders?.[r])));

    console.log(`\n${t.name}${unchanged ? '   — no change, already correct' : ''}`);
    notes.forEach(n => console.log(n));
    rows.forEach(n => console.log(n));

    if (unchanged) continue;

    if (!t.results) {
      console.error(`✗ ${t.name}: has no stored results — process the tournament first`);
      failed++; continue;
    }

    writes.set(t._id, { name: t.name, roundLeaders: nextFiltered, roundLeadersAll: nextAll });
  }

  if (failed) {
    console.error(`\n${failed} correction(s) failed validation — nothing written.`);
    process.exit(1);
  }

  if (!apply) {
    console.log(`\nDRY RUN — ${writes.size} tournament doc(s) would be updated. Re-run with --apply.`);
    return;
  }

  for (const [docId, entry] of writes) {
    await db.collection('tournaments').doc(docId).update({
      'results.roundLeaders': entry.roundLeaders,
      'results.roundLeadersAll': entry.roundLeadersAll,
    });
    console.log(`✓ wrote round leaders to "${entry.name}"`);
  }
  console.log('\nNow REPROCESS each of those tournaments in Admin → Tournament Results.');
  console.log('Bonuses are baked into results.teams, team.earnings and segmentEarnings at');
  console.log('process time; this wrote only the leaders they are computed from.');
}

// Only when run directly. Importing this module for its pure parts must not
// open a Firestore connection or read argv.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(err => {
    console.error('set-round-leaders failed:', err.message);
    process.exit(1);
  });
}
