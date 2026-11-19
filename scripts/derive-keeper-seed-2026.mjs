// scripts/derive-keeper-seed-2026.mjs
// ============================================================================
// Pull the 2026 keeper-star counts out of the Google Sheet snapshot and write
// them as a small committed module the rollover panel can import.
//
// WHY THIS EXISTS
// ---------------
// `stars` is the field keeper eligibility is judged on — three of them closes
// the limited slot — and NOTHING IN THE APP HAS EVER WRITTEN IT. Every code
// path only preserves it: registryUpkeep merges with Math.max (api/cron.js,
// src/utils/sharedHelpers.js), and makePlayer — the only function that mints a
// star — has had no call sites since it was taken out of TransactionsView. So
// whatever sits in Firestore came from the draft UI that was deleted years ago,
// or from somebody typing it, and nothing has kept it honest since.
//
// The sheet HAS kept it honest. It records the count as a `keeper` column of
// literal asterisks ("***", "**", "*") beside each limited player, and
// scripts/fixtures/sheet-state-2026.json is a snapshot of that workbook.
//
// So the sheet seeds the app, once, and the commissioner reviews the result
// before keeper tagging opens. That review is not ceremony: the snapshot is a
// point in time, and a limited player added or dropped after it was taken is
// exactly the row it would get wrong.
//
// WHY A GENERATED FILE RATHER THAN READING THE FIXTURE AT RUNTIME
// ---------------------------------------------------------------
// The fixture is 744 KB of tournament-by-tournament detail. The part that
// matters here is fifteen rows. Bundling the whole thing into the admin chunk
// to read three asterisks per team would be absurd, and the browser cannot
// read scripts/ anyway. This emits ~1 KB instead, and keeping the derivation
// in a script means the number in that file can be re-derived and checked
// rather than trusted.
//
//   node scripts/derive-keeper-seed-2026.mjs            # writes the seed
//   node scripts/derive-keeper-seed-2026.mjs --check    # verifies, writes nothing
// ============================================================================

import { readFileSync, writeFileSync } from 'node:fs';

const FIXTURE = 'scripts/fixtures/sheet-state-2026.json';
const OUT     = 'src/pages/admin/keeperSeed2026.js';
const SEASON  = 2026;

const check = process.argv.includes('--check');

const { INITIAL_TEAMS } = await import('../src/constants/index.js');

const sheet = JSON.parse(readFileSync(FIXTURE, 'utf8'));
if (!sheet?.rosters) {
  console.error(`${FIXTURE} has no rosters — wrong fixture?`);
  process.exit(1);
}

// Sheet rosters are keyed by team NAME. Teams can be renamed from the Account
// sheet, so the emitted seed carries the team ID instead: a rename between now
// and the rollover must not orphan a row. INITIAL_TEAMS is the id↔name table.
const idByName = new Map(INITIAL_TEAMS.map(t => [t.name, t.id]));

const rows = [];
const unmatchedTeams = [];

for (const [teamName, roster] of Object.entries(sheet.rosters)) {
  const teamId = idByName.get(teamName);
  if (!teamId) { unmatchedTeams.push(teamName); continue; }

  for (const entry of roster || []) {
    const mark = String(entry?.keeper ?? '').trim();
    if (!mark) continue;               // unlimited — no stars, nothing to seed
    // The column is literal asterisks. Anything else in it is not something to
    // guess at: a stray note would otherwise silently become a star count.
    if (!/^\*+$/.test(mark)) {
      console.error(`  ! ${teamName} / ${entry.player}: unexpected keeper value ${JSON.stringify(mark)}`);
      process.exitCode = 1;
      continue;
    }
    rows.push({ teamId, team: teamName, player: entry.player, stars: mark.length });
  }
}

if (unmatchedTeams.length) {
  console.error(`  ! sheet teams with no id in INITIAL_TEAMS: ${unmatchedTeams.join(', ')}`);
  process.exitCode = 1;
}

rows.sort((a, b) => a.teamId.localeCompare(b.teamId) || b.stars - a.stars || a.player.localeCompare(b.player));

const byTeam = rows.reduce((acc, r) => { (acc[r.teamId] ||= []).push(r); return acc; }, {});
console.log(`\n${SEASON} keeper stars from the sheet — ${rows.length} limited players\n`);
for (const list of Object.values(byTeam)) {
  console.log(`  ${list[0].team}`);
  for (const r of list) {
    const capped = r.stars >= 3 ? '   ← at the cap, cannot be kept' : '';
    console.log(`    ${'★'.repeat(r.stars).padEnd(4)} ${r.player}${capped}`);
  }
}
console.log('');

const body = `// src/pages/admin/keeperSeed2026.js
// ============================================================================
// GENERATED — do not edit by hand.
//   node scripts/derive-keeper-seed-2026.mjs
//
// The ${SEASON} keeper-star counts as the league's Google Sheet recorded them,
// where they live as a \`keeper\` column of asterisks beside each limited
// player. Read the header of the generating script for why the sheet is the
// source and the app is not: nothing in the app has ever WRITTEN \`stars\`, only
// carried it forward, so this is the only trustworthy copy of the number that
// decides who may be kept.
//
// A one-time migration seed for the ${SEASON} → ${SEASON + 1} rollover. It is a
// snapshot, not live data — the commissioner reviews every row against the
// current roster in the Years of Service step before keeper tagging opens, and
// a limited player added or dropped after the snapshot was taken is precisely
// the row that needs correcting. Delete this file once the rollover is done.
// ============================================================================

export const KEEPER_SEED_SEASON = ${SEASON};

/** @type {{ teamId: string, player: string, stars: number }[]} */
export const KEEPER_SEED_2026 = [
${rows.map(r => `  { teamId: ${JSON.stringify(r.teamId)}, player: ${JSON.stringify(r.player)}, stars: ${r.stars} },`).join('\n')}
];

/** The seeded rows for one team, by id. */
export const keeperSeedForTeam = (teamId) =>
  KEEPER_SEED_2026.filter(r => r.teamId === teamId);
`;

if (check) {
  const current = (() => { try { return readFileSync(OUT, 'utf8'); } catch { return null; } })();
  if (current !== body) {
    console.error(`${OUT} is stale — re-run without --check.`);
    process.exit(1);
  }
  console.log(`${OUT} is up to date.\n`);
} else {
  writeFileSync(OUT, body);
  console.log(`wrote ${OUT} (${rows.length} rows)\n`);
}
