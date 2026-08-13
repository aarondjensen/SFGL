// Export the app's season earnings, per tournament, per team, per player.
//
// Usage:  node scripts/export-app-earnings.mjs > app-earnings.json
//         node scripts/export-app-earnings.mjs --pretty
//
// Needs Firebase Admin credentials — see scripts/_adminCreds.mjs. Either
// FIREBASE_SERVICE_ACCOUNT (the JSON blob Vercel already holds for /api/cron)
// or the three separate fields, and .env.local is read automatically.
// READ-ONLY — it never writes.
//
// Pair with scripts/audit-sheet-vs-app.mjs, which diffs this against the same
// shape extracted from the Google Sheet. The two exist because the sheet and
// the app compute season earnings from DIFFERENT SOURCES (ESPN official money
// vs pgatour.com) through DIFFERENT CODE, so a season-total mismatch says
// nothing on its own about where the divergence entered. This narrows it:
// season → tournament → team → player, stopping at the first level that
// disagrees.
//
// `earners` is emitted per team per tournament on purpose. The sheet forfeits
// a team's earnings for an event when fewer than two of its five starters make
// the cut; nothing in processTournamentData.js or api/_rules.js applies that
// rule. Carrying the count means the diff can name that cause directly instead
// of reporting an unexplained delta.

import { adminDb } from './_adminCreds.mjs';
import { SEASON } from '../api/_league.js';
import { getSegmentForTournament } from '../api/_rules.js';

const db = adminDb();
const pretty = process.argv.includes('--pretty');

// Unordered fetch + JS sort, never orderBy('start_date'): Firestore silently
// drops documents missing the ordered field, and start_date is ordering-only.
// Same rule the app follows in firebase.js / cron.js.
const byStartDate = (a, b) =>
  String(a.start_date || '').localeCompare(String(b.start_date || ''));

async function main() {
  const [tSnap, teamSnap] = await Promise.all([
    db.collection('tournaments').get(),
    db.collection('teams').get(),
  ]);

  // results.teams is keyed by team.id (see processTournamentData.js), while the
  // sheet only ever knows a team by its display NAME. Map ids to names here so
  // the two exports are comparable, and keep the id alongside for tracing.
  const teamName = {};
  teamSnap.docs.forEach(d => {
    const t = { id: d.id, ...d.data() };
    teamName[t.id] = t.name || t.id;
  });

  const tournaments = tSnap.docs.map(d => ({ _id: d.id, ...d.data() })).sort(byStartDate);

  const out = {
    generatedAt: new Date().toISOString(),
    season: SEASON,
    source: 'app (Firestore)',
    teams: teamName,
    tournaments: {},
    seasonTotals: {},
  };

  for (const t of tournaments) {
    const entry = {
      completed: !!t.completed,
      isAlternate: !!t.isAlternate,
      segment: t.segment || null,
      segmentResolved: getSegmentForTournament(t),
      startDate: t.start_date || t.startDate || null,
      teams: {},
    };

    const results = t.results?.teams || {};
    for (const [teamId, tr] of Object.entries(results)) {
      const name = teamName[teamId] || teamId;
      const players = (tr.players || []).map(p => ({
        player: p.name,
        earnings: p.earnings ?? 0,
        bonus: p.bonus ?? 0,
        total: (p.earnings ?? 0) + (p.bonus ?? 0),
        roundsLed: (p.roundsLed || []).map(r => r.round),
      }));

      entry.teams[name] = {
        teamId,
        total: tr.totalEarnings ?? 0,
        earnings: players.reduce((s, p) => s + p.earnings, 0),
        bonuses: players.reduce((s, p) => s + p.bonus, 0),
        // Starters who actually made money. The cut-rule check keys off this.
        earners: players.filter(p => p.earnings > 0).length,
        starters: players.length,
        players,
      };

      if (t.completed) {
        out.seasonTotals[name] = (out.seasonTotals[name] || 0) + (tr.totalEarnings ?? 0);
      }
    }

    out.tournaments[t.name || t._id] = entry;
  }

  process.stdout.write(JSON.stringify(out, null, pretty ? 1 : 0) + '\n');

  // Everything human-readable goes to stderr so `> app-earnings.json` stays
  // valid JSON.
  const teamsSeen = Object.keys(out.seasonTotals).length;
  const completed = Object.values(out.tournaments).filter(t => t.completed).length;
  console.error(`\nExported ${Object.keys(out.tournaments).length} tournaments ` +
    `(${completed} completed), ${teamsSeen} teams.`);
  Object.entries(out.seasonTotals)
    .sort((a, b) => b[1] - a[1])
    .forEach(([name, v]) => console.error(`  ${name.padEnd(22)} $${v.toLocaleString()}`));
}

main().catch(err => {
  console.error('export-app-earnings failed:', err.message);
  process.exit(1);
});
