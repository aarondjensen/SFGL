// Find starters scored $0, and say WHY each one was scored $0.
//
// Usage:
//   node scripts/audit-zero-earners.mjs
//   node scripts/audit-zero-earners.mjs --tournament "Genesis Scottish Open"
//   node scripts/audit-zero-earners.mjs --all      (list the missed cuts too)
//
// READ-ONLY. Needs Firebase Admin credentials — see scripts/_adminCreds.mjs.
//
// WHY THIS EXISTS
// ---------------
// A starter scored $0 is usually a missed cut, which is fine. But it is also
// what a NAME LOOKUP FAILURE looks like, and the two are indistinguishable in
// every screen the app has. Nicolai Højgaard was scored $0 at the Genesis
// Scottish Open and the Rocket Classic in 2026 — T26 and T61, $100,750 of real
// money — and it took a comparison against an outside record to notice, because
// $0 next to a starter's name is the most ordinary thing on the page.
//
// So this separates the two, by asking what the tournament's own earningsMap
// says about the player:
//
//   MISSED CUT   the feed lists them with $0. Nothing to fix.
//   NAME GAP     the feed has money under a name that is plainly the same
//                golfer but does not compare equal. Fix api/_playerNames.js —
//                the two spellings are printed so the gap is actionable.
//   NOT IN FEED  the feed has no row for them at all, under any spelling. The
//                earningsMap is incomplete; re-import that event's results in
//                Admin and reprocess. No code change will help.
//
// The NAME GAP test deliberately does NOT use namesMatch — that is the
// comparison being audited, and asking it to find its own blind spots is
// circular. It uses a deliberately looser surname-and-initial rule, so it
// surfaces candidates namesMatch rejects. Expect it to propose a few false
// pairs (brothers, in particular); reading them is the point.

import { adminDb } from './_adminCreds.mjs';
import { namesMatch, nameKey } from '../api/_playerNames.js';
import { lineupFor } from '../api/_rules.js';

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const only = arg('--tournament', null);
const showAll = process.argv.includes('--all');

const db = adminDb();
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const $ = (n) => `$${Math.round(n || 0).toLocaleString()}`;

/**
 * Could these two plausibly be the same golfer, by a rule LOOSER than the one
 * the app uses? Same surname plus a compatible first initial.
 *
 * Surnames are compared after collapsing the Nordic digraphs both ways — oe/ø,
 * ae/æ, aa/å — because a feed that writes "Hoejgaard" and a roster that writes
 * "Hojgaard" share no key under any single-letter fold, and that is exactly the
 * kind of gap this is looking for.
 */
const surnameKey = (name) => {
  const parts = nameKey(name).split(' ').filter(Boolean);
  const last = parts[parts.length - 1] || '';
  return last.replace(/oe/g, 'o').replace(/ae/g, 'a').replace(/aa/g, 'a');
};
const firstInitial = (name) => (nameKey(name).split(' ')[0] || '')[0] || '';

function nearMisses(player, feedNames) {
  const sk = surnameKey(player);
  const fi = firstInitial(player);
  if (!sk) return [];
  return feedNames.filter(f =>
    !namesMatch(f, player) && surnameKey(f) === sk && firstInitial(f) === fi);
}

async function main() {
  const [tSnap, teamSnap] = await Promise.all([
    db.collection('tournaments').get(),
    db.collection('teams').get(),
  ]);
  const teams = teamSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const teamName = Object.fromEntries(teams.map(t => [t.id, t.name || t.id]));
  const tournaments = tSnap.docs
    .map(d => ({ _id: d.id, ...d.data() }))
    .filter(t => t.completed && t.results?.teams)
    .filter(t => !only || norm(t.name).includes(norm(only)))
    .sort((a, b) => String(a.start_date || '').localeCompare(String(b.start_date || '')));

  let gaps = 0, absent = 0, cuts = 0;

  for (const t of tournaments) {
    const feed = t.results?.earningsMap || {};
    const feedNames = Object.keys(feed);
    const lines = [];

    for (const [teamId, tr] of Object.entries(t.results.teams)) {
      for (const p of tr.players || []) {
        if ((p.earnings || 0) > 0) continue;
        const name = p.name;

        // Present in the feed at $0 — an ordinary missed cut.
        const hit = feedNames.find(f => namesMatch(f, name));
        if (hit !== undefined) {
          cuts++;
          if (showAll) lines.push(`    MISSED CUT   ${teamName[teamId].padEnd(20)} ${name}`);
          continue;
        }

        const near = nearMisses(name, feedNames);
        if (near.length) {
          gaps++;
          lines.push(`    NAME GAP     ${teamName[teamId].padEnd(20)} ${name}`);
          near.forEach(f => lines.push(
            `                 feed has "${f}" holding ${$(feed[f])} — namesMatch says these are different golfers`));
        } else {
          absent++;
          lines.push(`    NOT IN FEED  ${teamName[teamId].padEnd(20)} ${name}` +
            `   (feed has ${feedNames.length} players)`);
        }
      }
    }

    // A lineup the processor never saw scores nothing at all, which is a
    // different failure from a starter scoring zero — worth saying out loud
    // while we are here.
    for (const team of teams) {
      if (t.results.teams[team.id]) continue;
      const lu = lineupFor(t, team);
      if (lu.length) lines.push(`    NO RESULT    ${(team.name || team.id).padEnd(20)} ${lu.length} starters, no scored block`);
    }

    if (lines.length) {
      console.log(`\n── ${t.name}`);
      lines.forEach(l => console.log(l));
    }
  }

  console.log(`\n${gaps} name gap(s), ${absent} starter(s) absent from their feed, ${cuts} ordinary missed cut(s).`);
  if (gaps) {
    console.log('\nNAME GAP  → add the pair to ALIAS_GROUPS in api/_playerNames.js, or extend the');
    console.log('            folding rules if it generalizes, then reprocess that tournament.');
  }
  if (absent) {
    console.log('\nNOT IN FEED → the stored earningsMap is missing that player. Re-import the');
    console.log('            event in Admin → Tournament Results and reprocess. Nothing in the');
    console.log('            name module can recover a row that was never fetched.');
  }
  if (!gaps && !absent) console.log('\nEvery $0 starter is a genuine missed cut.');
}

main().catch(err => {
  console.error('audit-zero-earners failed:', err.message);
  process.exit(1);
});
