// Export everything the app believes about the season: rosters, lineups,
// earnings, bonuses, transactions, fees and swing totals.
//
// Usage:  node scripts/export-app-state.mjs --out app-state.json
//         node scripts/export-app-state.mjs --pretty --out app-state.json
//         node scripts/export-app-state.mjs > app-state.json   (POSIX only)
//
// Prefer --out. PowerShell's `>` encodes redirected output as UTF-16LE with a
// BOM, which is not readable as JSON — `Unexpected token '<27>', "<FF><FE>{"ge"...`.
// --out writes the file directly as UTF-8 and is shell-independent.
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
//
// ROSTERS, TRANSACTIONS AND FEES are exported alongside the earnings because
// they are where a sheet/app divergence ORIGINATES. A wrong lineup shows up as
// an earnings delta, but its cause is usually a transaction the app never
// recorded — so a diff that only sees money can name the symptom and never the
// disease. All three are derived through the shared rules in api/_rules.js
// (buildEffectiveRoster, getSeasonFeesByTeam, getSwingFeesByTeam), never
// re-implemented here: a second implementation of the fee walk is exactly the
// drift this repo keeps paying for.

import { writeFileSync } from 'node:fs';
import { adminDb } from './_adminCreds.mjs';
import { SEASON, SWINGS } from '../api/_league.js';
import {
  getSegmentForTournament,
  getSwingEarningsByTeam,
  getSeasonEarningsByTeam,
  getSeasonFeesByTeam,
  getSwingFeesByTeam,
  getSwingPot,
  buildEffectiveRoster,
  lineupFor,
} from '../api/_rules.js';

const db = adminDb();
const pretty = process.argv.includes('--pretty');
const outArg = process.argv.indexOf('--out');
const outPath = outArg !== -1 && process.argv[outArg + 1] ? process.argv[outArg + 1] : null;

// Unordered fetch + JS sort, never orderBy('start_date'): Firestore silently
// drops documents missing the ordered field, and start_date is ordering-only.
// Same rule the app follows in firebase.js / cron.js.
const byStartDate = (a, b) =>
  String(a.start_date || '').localeCompare(String(b.start_date || ''));

async function main() {
  const [tSnap, teamSnap, txSnap, setSnap] = await Promise.all([
    db.collection('tournaments').get(),
    db.collection('teams').get(),
    db.collection('transactions').get(),
    db.collection('league_settings').get(),
  ]);

  // results.teams is keyed by team.id (see processTournamentData.js), while the
  // sheet only ever knows a team by its display NAME. Map ids to names here so
  // the two exports are comparable, and keep the id alongside for tracing.
  const teamName = {};
  const teamById = {};
  const teamDocs = teamSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  teamDocs.forEach(t => { teamName[t.id] = t.name || t.id; teamById[t.id] = t; });

  const tournaments = tSnap.docs.map(d => ({ _id: d.id, ...d.data() })).sort(byStartDate);

  const settings = {};
  setSnap.docs.forEach(d => { settings[d.data().key] = d.data().value; });

  // Oldest-first. buildEffectiveRoster sorts internally, but the exported list
  // is read by a human tracing a roster, and newest-first (what the app's own
  // getAll returns) reads backwards for that.
  const txTimeMs = (tx) => {
    if (typeof tx.timestamp === 'number') return tx.timestamp;
    const ms = new Date(tx.timestamp || tx.date || 0).getTime();
    return Number.isNaN(ms) ? 0 : ms;
  };
  const transactions = txSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => txTimeMs(a) - txTimeMs(b));

  const out = {
    generatedAt: new Date().toISOString(),
    season: SEASON,
    source: 'app (Firestore)',
    teams: teamName,
    settings,
    rosters: {},
    transactions: [],
    fees: {},
    swingEarnings: {},
    swingPots: {},
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
      // What the app believes led each round. Bonuses are awarded off these, so
      // when a bonus is disputed this is the thing to check — it is either
      // typed in during manual entry or scraped, and nothing downstream
      // re-derives it.
      roundLeaders: t.results?.roundLeaders || null,
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
        bonusDetail: p.roundsLed || [],
      }));

      // Three views of "who was started", exported side by side because they
      // are allowed to disagree and the disagreement is the finding:
      //   locked  the five frozen when the lineup locked — what SHOULD score
      //   full    the five processTournamentData actually scored against
      //   players the scored rows, which drop nobody but are sorted by money
      // A locked/full mismatch means the event was scored before lineupFor()
      // preferred the snapshot, and its result is stale until reprocessed.
      const teamDoc = teamById[teamId] || { id: teamId };
      const locked = t.lockedLineups?.[teamId];

      entry.teams[name] = {
        teamId,
        lockedLineup: Array.isArray(locked) ? locked : null,
        fullLineup: t.results?.fullLineups?.[teamId] || null,
        scoredAgainst: lineupFor(t, teamDoc),
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

  // ── Rosters ────────────────────────────────────────────────────────────────
  // `base` is the drafted roster as stored on the team doc; `effective` is that
  // roster with every processed add/drop replayed. The sheet's Rosters tab is
  // the effective one, so that is what a roster diff has to compare against —
  // diffing `base` would report every completed transaction as a discrepancy.
  for (const team of teamDocs) {
    out.rosters[team.name || team.id] = {
      teamId: team.id,
      base: (team.roster || []).map(p => p.name || p).filter(Boolean),
      effective: [...buildEffectiveRoster(team, transactions, { tournaments })].sort(),
      lineup: Array.isArray(team.lineup) ? team.lineup : [],
      earnings: team.earnings ?? null,
      segmentEarnings: team.segmentEarnings || null,
    };
  }

  // ── Transactions ───────────────────────────────────────────────────────────
  // Emitted whole rather than aggregated. The sheet records a transaction as a
  // (tournament, add, drop, fee) row, and a fee total that agrees while the
  // underlying rows do not is the kind of agreement worth distrusting.
  out.transactions = transactions.map(tx => ({
    id: tx.id,
    team: tx.team || null,
    teamId: tx.teamId || null,
    type: tx.type || null,
    status: tx.status || null,
    player: tx.player || null,
    droppedPlayer: tx.droppedPlayer || null,
    fee: tx.fee ?? null,
    amount: tx.amount ?? null,
    segment: tx.segment || null,
    tournament: tx.tournament || tx.tournamentName || null,
    tournamentIndex: tx.tournamentIndex ?? null,
    timestamp: tx.timestamp ?? tx.date ?? null,
  }));

  // ── Fees, swing earnings, pots ─────────────────────────────────────────────
  // All four swings are emitted even when empty, so a swing the sheet has money
  // for and the app does not shows up as a zero rather than as a missing key
  // the diff has to guess about.
  out.fees.season = getSeasonFeesByTeam(transactions, settings);
  out.fees.bySwing = {};
  for (const swing of SWINGS) {
    out.fees.bySwing[swing] = getSwingFeesByTeam(transactions, tournaments, swing, settings);
    out.swingPots[swing] = getSwingPot(transactions, tournaments, swing, settings);

    // Keyed by team NAME to match everything else in this export;
    // getSwingEarningsByTeam keys by the id results.teams uses.
    const byId = getSwingEarningsByTeam(tournaments, swing);
    out.swingEarnings[swing] = Object.fromEntries(
      Object.entries(byId).map(([id, v]) => [teamName[id] || id, v]));
  }

  // Season earnings recomputed through the shared rule, alongside the running
  // sum built above. The two are different code paths over the same data; if
  // they disagree the app is inconsistent with ITSELF and no sheet comparison
  // means anything until that is settled.
  const seasonById = getSeasonEarningsByTeam(tournaments);
  out.seasonTotalsViaRules = Object.fromEntries(
    Object.entries(seasonById).map(([id, v]) => [teamName[id] || id, v]));

  const json = JSON.stringify(out, null, pretty ? 1 : 0) + '\n';
  if (outPath) {
    // Explicit utf8, no BOM. Writing the file ourselves keeps the encoding out
    // of the shell's hands — see the --out note in the header.
    writeFileSync(outPath, json, 'utf8');
    console.error(`Wrote ${outPath}`);
  } else {
    process.stdout.write(json);
  }

  // Everything human-readable goes to stderr so `> app-state.json` stays valid
  // JSON.
  const teamsSeen = Object.keys(out.seasonTotals).length;
  const completed = Object.values(out.tournaments).filter(t => t.completed).length;
  console.error(`\nExported ${Object.keys(out.tournaments).length} tournaments ` +
    `(${completed} completed), ${teamsSeen} teams, ${transactions.length} transactions.`);
  Object.entries(out.seasonTotals)
    .sort((a, b) => b[1] - a[1])
    .forEach(([name, v]) => console.error(
      `  ${name.padEnd(22)} $${v.toLocaleString()}` +
      `   fees $${(out.fees.season[name] || 0).toLocaleString()}`));
}

main().catch(err => {
  console.error('export-app-state failed:', err.message);
  process.exit(1);
});
