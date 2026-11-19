// src/pages/admin/keeperSeed2026.js
// ============================================================================
// GENERATED — do not edit by hand.
//   node scripts/derive-keeper-seed-2026.mjs
//
// The 2026 keeper-star counts as the league's Google Sheet recorded them,
// where they live as a `keeper` column of asterisks beside each limited
// player. Read the header of the generating script for why the sheet is the
// source and the app is not: nothing in the app has ever WRITTEN `stars`, only
// carried it forward, so this is the only trustworthy copy of the number that
// decides who may be kept.
//
// A one-time migration seed for the 2026 → 2027 rollover. It is a
// snapshot, not live data — the commissioner reviews every row against the
// current roster in the Years of Service step before keeper tagging opens, and
// a limited player added or dropped after the snapshot was taken is precisely
// the row that needs correcting. Delete this file once the rollover is done.
// ============================================================================

export const KEEPER_SEED_SEASON = 2026;

/** @type {{ teamId: string, player: string, stars: number }[]} */
export const KEEPER_SEED_2026 = [
  { teamId: "db", player: "Sam Burns", stars: 2 },
  { teamId: "db", player: "Robert MacIntyre", stars: 1 },
  { teamId: "db", player: "Xander Schauffele", stars: 1 },
  { teamId: "drc", player: "Rory McIlroy", stars: 3 },
  { teamId: "drc", player: "Brooks Koepka", stars: 1 },
  { teamId: "drc", player: "Patrick Cantlay", stars: 1 },
  { teamId: "hh", player: "Scottie Scheffler", stars: 3 },
  { teamId: "hh", player: "Matt Fitzpatrick", stars: 1 },
  { teamId: "hh", player: "Russell Henley", stars: 1 },
  { teamId: "pops", player: "Hideki Matsuyama", stars: 3 },
  { teamId: "pops", player: "Keegan Bradley", stars: 1 },
  { teamId: "pops", player: "Ludvig Åberg", stars: 1 },
  { teamId: "w1", player: "Tommy Fleetwood", stars: 3 },
  { teamId: "w1", player: "Collin Morikawa", stars: 1 },
  { teamId: "w1", player: "Viktor Hovland", stars: 1 },
];

/** The seeded rows for one team, by id. */
export const keeperSeedForTeam = (teamId) =>
  KEEPER_SEED_2026.filter(r => r.teamId === teamId);
