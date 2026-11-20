// scripts/test-season-archive.mjs
// ============================================================================
// Can a finished season be read back after the rollover has destroyed it?
//
// The rollover is not reversible and does not pretend to be: transactions are
// DELETED (buildEffectiveRoster would otherwise replay last season's add/drops
// onto the new rosters), the schedule import deletes every tournament doc not
// in the new set along with its results, and rosters are replaced in place.
//
// So the archive is the only copy, and for a while it was WRITE-ONLY — one
// sfglDataApi.set with no reader anywhere in the codebase. These assertions
// cover the two ways that goes wrong: nothing reads it, and the thing that
// writes it silently exceeds what a Firestore document can hold.
//
//   node scripts/test-season-archive.mjs
// ============================================================================

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
};

const firebase = readFileSync('src/api/firebase.js', 'utf8');
const panel    = readFileSync('src/pages/admin/SeasonRolloverPanel.jsx', 'utf8');
const view     = readFileSync('src/pages/SeasonArchiveView.jsx', 'utf8');
const app      = readFileSync('src/App.jsx', 'utf8');

console.log('\nthe archive is written, and read');

test('the archive has a reader, not just a writer', () => {
  // The whole point. A season nobody can open is a season that is gone.
  const files = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(js|jsx)$/.test(full)) files.push(full);
    }
  })('src');
  const readers = files.filter(f =>
    f !== 'src/api/firebase.js' && /seasonArchiveApi\.(get|getManifest|listSeasons)/.test(readFileSync(f, 'utf8')));
  assert.ok(readers.length > 0, 'nothing in src/ reads the archive back');
});

test('the rollover writes it through the API, not by hand', () => {
  assert.match(panel, /seasonArchiveApi\.save\(SEASON/);
  // The old single-document write, which is what could outgrow 1 MiB.
  assert.equal(/sfglDataApi\.set\(archiveKey/.test(panel), false);
});

test('it archives the rosters teams FINISHED on, not the stored arrays', () => {
  // The stored roster array and the replayed effective roster drift apart as
  // soon as a transaction lands, and the replay is the one the app treats as
  // real all season.
  assert.match(panel, /roster: rosters\[t\.id \|\| t\.name\]/);
});

console.log('\nsplit across documents');

test('each collection gets its own key', () => {
  // Declared in the shared layout module, not in firebase.js — the import
  // script writes the same documents and cannot reach the app's API.
  const layout = readFileSync('api/_archive.js', 'utf8');
  assert.match(layout, /ARCHIVE_PARTS = \['teams', 'tournaments', 'transactions'\]/);
});

test('a part too large for one document is refused with a legible error', () => {
  // Firestore caps a document at 1 MiB. Its own rejection names neither the
  // collection nor the size, and this write happens at step 1 of a rollover —
  // the step every later one is gated on. Both writers check it.
  assert.match(readFileSync('api/_archive.js', 'utf8'), /ARCHIVE_PART_LIMIT/);
  assert.match(firebase, /ARCHIVE_PART_LIMIT/);
  assert.match(firebase, /the limit is 1 MB/);
  assert.match(readFileSync('scripts/import-season-archive.mjs', 'utf8'), /TOO LARGE/);
});

test('the manifest is written AFTER the parts, and the index after that', () => {
  // A failure part-way through must leave nothing the view will offer to open.
  // A half-written archive that looked complete would be worse than none.
  const parts    = firebase.indexOf('for (const part of ARCHIVE_PARTS)');
  const manifest = firebase.indexOf('await sfglDataApi.set(archiveKey(season), {');
  const index    = firebase.indexOf('await sfglDataApi.set(ARCHIVE_INDEX');
  assert.ok(parts !== -1 && manifest !== -1 && index !== -1, 'expected all three writes');
  assert.ok(parts < manifest, 'the manifest must not precede its parts');
  assert.ok(manifest < index, 'a season must not be listed before it is whole');
});

test('standings ride on the manifest, so opening the view is one read', () => {
  // They are small and they are the tab the view opens on; fetching thirty
  // tournaments to draw them would be the wrong trade.
  const save = firebase.slice(firebase.indexOf('async save(season'));
  assert.match(save.slice(0, save.indexOf('\n  },')), /standings,/);
});

console.log('\nthe view');

test('archived standings render through the real StandingsView', () => {
  // The archived shapes are the ones it takes live, so a manager looking up a
  // finished season sees the table the league read all year rather than a
  // second, slightly-different rendering of it.
  assert.match(view, /import \{ StandingsView \}/);
  assert.match(view, /<StandingsView[\s\S]*?teams=\{archive\.teams/);
});

test('it writes nothing', () => {
  // Read-only is the contract. An archive the UI can edit is not an archive.
  ['seasonArchiveApi.save', 'updateTeams', 'updateTransactions', 'sfglDataApi.set', 'setDoc']
    .forEach(w => assert.equal(view.includes(w), false, `the archive view must not call ${w}`));
});

test('loading is derived, never set synchronously in an effect', () => {
  // The repo's lint rules reject a synchronous setState in an effect body, and
  // deriving it also stops a stale season's data showing under a new season's
  // heading while the new one is in flight.
  assert.match(view, /const loading = season != null && !ready && !error;/);
  // Comments stripped: the note explaining why there is no setLoading mentions
  // it by name, and a guard that its own rationale trips is a guard nobody
  // keeps.
  const code = view.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.equal(/setLoading/.test(code), false);
});

test('#archive survives a reload', () => {
  // It is reached from the More menu, so it is not in TABS — but a deep link
  // and a refresh still have to land on it rather than falling through to
  // Standings.
  assert.match(app, /const EXTRA_TAB_IDS = \['archive'\]/);
  assert.match(app, /new Set\(\[\.\.\.TABS\.map\(t => t\.id\), \.\.\.EXTRA_TAB_IDS\]\)/);
});

test('the view is lazy, so the archive costs nothing until it is opened', () => {
  assert.match(app, /LazySeasonArchiveView = React\.lazy/);
});

// ── The 2025 archive ────────────────────────────────────────────────────────
console.log('\nthe 2025 archive, extracted from the Google Sheet');

const { readFileSync: rf } = await import('node:fs');
const a25 = JSON.parse(rf('scripts/fixtures/season-archive-2025.json', 'utf8'));
const D = await import('../api/_draft.js');
const { NameSet } = await import('../api/_playerNames.js');
const seed26 = await import('../src/pages/admin/keeperSeed2026.js');

test('it carries no credentials or private notes from the sheet', () => {
  // The Rosters tab has a login and password sitting in plain cells next to
  // the mulligan rules. An extractor that takes whole regions rather than
  // named ones would publish them to every manager in the league.
  const raw = rf('scripts/fixtures/season-archive-2025.json', 'utf8');
  [/password/i, /username/i, /@gmail\.com/i].forEach(pat =>
    assert.equal(pat.test(raw), false, `the fixture matches ${pat}`));
});

test('every team is keyed to an id the app already uses', () => {
  // Including SS Express, which is the franchise that is Hip Happens in 2026.
  // Archived under its own 2025 NAME and the live id, so the history joins up.
  assert.deepEqual(a25.teams.map(t => t.id).sort(), ['db', 'drc', 'hh', 'pops', 'w1']);
  assert.equal(a25.teams.find(t => t.id === 'hh').name, 'SS Express');
});

test('every roster is 13 with three yellows and no blues', () => {
  // The sheet records yellows (asterisks and a start cap) and lists everyone
  // else as a plain name, so it cannot say who was blue. Archiving a guess
  // would put a keeper designation in the record that nobody granted.
  a25.teams.forEach(t => {
    assert.equal(t.roster.length, 13, `${t.name} has ${t.roster.length}`);
    assert.equal(t.roster.filter(p => p.limited).length, 3, `${t.name} yellows`);
    assert.equal(t.roster.filter(p => p.unlimited).length, 0, `${t.name} blues`);
  });
});

test('the standings match the sum of the archived events', () => {
  // The derived table is what StandingsView will draw from `tournaments`, so
  // it has to agree with the `standings` the manifest carries — otherwise the
  // archive shows one final table and claims another.
  const summed = {};
  a25.tournaments.forEach(ev => {
    Object.entries(ev.results.teams).forEach(([id, r]) => {
      summed[id] = (summed[id] || 0) + r.totalEarnings;
    });
  });
  a25.standings.forEach(row => assert.equal(summed[row.teamId], row.earnings, row.name));
});

test('positions run 1..5 in descending earnings', () => {
  const sorted = [...a25.standings].sort((x, y) => x.position - y.position);
  assert.deepEqual(sorted.map(r => r.position), [1, 2, 3, 4, 5]);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(sorted[i - 1].earnings >= sorted[i].earnings, 'out of order');
  }
});

test('a yellow player\'s stars and years of service agree', () => {
  a25.teams.flatMap(t => t.roster).filter(p => p.limited).forEach(p => {
    assert.equal(p.stars, p.yearsOfService, p.name);
    assert.ok(p.stars >= 1 && p.stars <= D.KEEPER_MAX_YEARS, `${p.name} on ${p.stars}`);
  });
});

test('every 2025 → 2026 yellow is a transition the rules allow', () => {
  // The strongest check available on the whole model: two seasons of real
  // league data, extracted independently from two different workbooks, have to
  // be joinable by the rules in api/_draft.js. If the engine were wrong about
  // keeping, releasing or re-drafting, this is where it would show.
  const seedNames = new NameSet(seed26.KEEPER_SEED_2026.map(r => r.player));
  const seedBy = (name) => {
    const resolved = seedNames.resolve(name);
    return resolved ? seed26.KEEPER_SEED_2026.find(r => r.player === resolved) : null;
  };

  a25.teams.forEach(team => {
    team.roster.filter(p => p.limited).forEach(p => {
      const next = seedBy(p.name);
      if (!next) return;   // went white or left the league — both legal

      if (next.teamId === team.id) {
        // Same team: either kept (+1 year) or released and re-drafted yellow
        // (back to 1). Nothing else is reachable.
        assert.ok(
          next.stars === p.stars + 1 || next.stars === 1,
          `${p.name}: ${p.stars}★ on ${team.id} → ${next.stars}★ is neither a keep nor a redraft`,
        );
        if (next.stars === p.stars + 1) {
          assert.equal(D.keeperStatus(p).limited.eligible, true,
            `${p.name} was kept at ${p.stars}★ but the rules say he could not be`);
          assert.equal(D.keptPlayerAttrs(p, 'limited').stars, next.stars, p.name);
        }
      } else {
        // A different team can only have got him through the draft, and the
        // pool is uniform, so he starts over at one.
        assert.equal(next.stars, 1,
          `${p.name} moved ${team.id} → ${next.teamId} and must restart at 1★, not ${next.stars}★`);
      }
    });
  });
});

test('a maxed-out yellow came back at one star, not four', () => {
  // Ludvig Åberg is the case in the real data: three stars on Dirty Bird(ies)
  // in 2025, so unkeepable, and one star on POPS in 2026. That is the release
  // wipe working — and it is exactly what draftedPlayerAttrs now produces.
  const aberg25 = a25.teams.flatMap(t => t.roster).find(p => /Åberg|Aberg/.test(p.name));
  assert.equal(aberg25.stars, 3);
  assert.equal(D.keeperStatus(aberg25).limited.eligible, false, 'he should be unkeepable');

  const aberg26 = seed26.KEEPER_SEED_2026.find(r => /Åberg|Aberg/.test(r.player));
  assert.equal(aberg26.stars, 1);
  assert.equal(D.draftedPlayerAttrs(aberg26.player, { round: 1, prior: aberg25 }).stars, 1,
    'the draft must ignore what he was and start him over');
});

test('the discrepancies the sheet contains are recorded, not smoothed over', () => {
  // Eight team blocks publish a Total of $0 while their own starters add up to
  // real money — a broken formula the 2026 audit already names. The published
  // figure is kept because the league settled on it; the gap is recorded so
  // nobody has to rediscover it.
  assert.ok(a25.discrepancies.zeroTotalBlocks.length > 0);
  a25.discrepancies.zeroTotalBlocks.forEach(d => {
    assert.equal(d.publishedTotal, 0);
    assert.ok(d.short > 0, `${d.event}/${d.team}`);
  });
});

test('the archive layout has one definition, shared three ways', () => {
  // The app writes and reads it with the client SDK; the import script writes
  // it with firebase-admin and cannot import the app's API. Without a shared
  // module the key naming exists twice, and a season imported under the wrong
  // key is invisible rather than broken.
  const layout = rf('api/_archive.js', 'utf8');
  assert.match(layout, /export const ARCHIVE_PARTS/);
  assert.match(firebase, /from '\.\.\/\.\.\/api\/_archive\.js'/);
  assert.match(rf('scripts/import-season-archive.mjs', 'utf8'), /from '\.\.\/api\/_archive\.js'/);
});

test('the importer is a dry run unless told otherwise', () => {
  const imp = rf('scripts/import-season-archive.mjs', 'utf8');
  assert.match(imp, /const apply = args\.includes\('--apply'\)/);
  assert.match(imp, /Dry run — nothing written/);
});

console.log(`\n${passed} assertions passed\n`);
