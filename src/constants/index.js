// ============================================================================
// STORAGE KEYS
// ============================================================================
export const STORAGE_KEYS = {
  TEAMS: 'fantasy-golf-teams',
  TOURNAMENTS: 'fantasy-golf-tournaments',
  TRANSACTIONS: 'fantasy-golf-transactions',
  SETTINGS: 'fantasy-golf-settings',
  GLOBAL_PLAYER_STATS: 'fantasy-golf-global-player-stats',
  LOGGED_IN_USER: 'sfgl-logged-in-user',
  PLAYER_RANKINGS: 'fantasy-golf-player-rankings',
  HEADSHOTS: 'fantasy-golf-headshots',
  OWGR_LAST_SYNCED: 'fantasy-golf-owgr-last-synced',
};

// ============================================================================
// LEAGUE RULES
// ============================================================================
export const ROSTER_LIMIT = 13;
export const LINEUP_SIZE = 5;
export const MAX_LIMITED_STARTS = 12;
export const DRAFT_ROUNDS = 13;

export const BONUSES_REGULAR = { round1: 20000, round2: 40000, round3: 60000 };
export const BONUSES_MAJOR   = { round1: 40000, round2: 80000, round3: 120000 };

export const TRANSACTION_FEE_FREE_AGENT = 1;
export const TRANSACTION_FEE_WAIVER     = 2;

export const DEFAULT_MULLIGANS = { signatureMajor: 1, regular: 1 };

// ============================================================================
// SWINGS / SEGMENTS  +  SEASON  —  moved out
// ============================================================================
// Both now live in api/_league.js, the one module src/ and api/ can both
// import (see the header there for why it has to sit under api/).
//
// SWINGS used to be declared HERE and in theme.js with identical contents, so
// "the canonical list" depended on which file a given view imported from. It
// was also spelled out a third time as <option> literals in the TransactionsView
// filter and encoded a fourth time as a month map in api/cron.js.
//
// Deliberately NOT re-exported from this file. Every consumer of SWINGS wants
// the swing COLORS alongside it, so they all import it from theme.js — and
// re-exporting it here as well would put two import paths back in front of one
// definition, which is most of what made the original duplication confusing.
// One symbol, one place to import it from:
//
//   SWINGS  → src/theme.js        (paired with SWING_COLORS / getSwingColor)
//   SEASON  → api/_league.js      (shared with the serverless functions)

// ============================================================================
// TEAM DATA
// ============================================================================
export const TEAM_ABBREVIATIONS = {
  'Detroit Rock City': 'DRC',
  'Dirty Bird(ies)':   'DBs',
  'Hip Happens':       'HH',
  'World #1':          'W#1',
  'POPS, LLC':         'POP',
};

export const INITIAL_TEAMS = [
  { id: 'drc',  name: 'Detroit Rock City', owner: 'TJ',     roster: [], lineup: [], earnings: 0, segmentEarnings: 0, segmentFees: 0, transactionFees: 0, mulligans: { ...DEFAULT_MULLIGANS } },
  { id: 'db',   name: 'Dirty Bird(ies)',   owner: 'Hershey', roster: [], lineup: [], earnings: 0, segmentEarnings: 0, segmentFees: 0, transactionFees: 0, mulligans: { ...DEFAULT_MULLIGANS } },
  { id: 'hh',   name: 'Hip Happens',       owner: 'Fano',   roster: [], lineup: [], earnings: 0, segmentEarnings: 0, segmentFees: 0, transactionFees: 0, mulligans: { ...DEFAULT_MULLIGANS } },
  { id: 'w1',   name: 'World #1',          owner: 'Jensen', roster: [], lineup: [], earnings: 0, segmentEarnings: 0, segmentFees: 0, transactionFees: 0, mulligans: { ...DEFAULT_MULLIGANS } },
  { id: 'pops', name: 'POPS, LLC',         owner: 'Lutz',   roster: [], lineup: [], earnings: 0, segmentEarnings: 0, segmentFees: 0, transactionFees: 0, mulligans: { ...DEFAULT_MULLIGANS } },
];

// Wave C.5: removed RAPIDAPI_HOST and FALLBACK_SCHEDULE_DATA — both were only
// used by ScheduleImportModal, which was deleted in Wave B. RAPIDAPI_HOST also
// referenced an environment variable (VITE_RAPIDAPI_KEY) that no other code
// path uses; safe to drop.

// ============================================================================
// PLAYER DATA
// ============================================================================
// No hardcoded headshot IDs live here any more.
//
// There were two attempts at one. The first (PGA_TOUR_IDS) held PGA TOUR
// player IDs but was consumed as if they were ESPN athlete IDs, so all 134
// entries 404'd. The second was a hand-verified PGA seed — correct, but only
// 105 names, and already carrying stale IDs for players whose PGA id had
// changed (Davis Thompson, Ben Kohles, Michael Brennan and 26 others were
// dead on arrival).
//
// Both are superseded by pgatour.com's own player directory, which
// /api/headshots now indexes: ~2,700 players, always current, no annual
// maintenance, and it resolved every name the static seed could not —
// including the three the seed left on initials avatars. See getPgaDirectory
// in api/headshots.js.
//
// The lesson worth keeping: a hardcoded ID map cannot tell you when it has
// gone stale. It just quietly serves 404s.

// ── REMOVED: PLAYER_NAME_ALIASES and CHAR_MAP ───────────────────────────────
//
// PLAYER_NAME_ALIASES was a second alias table that CONTRADICTED the one in
// src/constants/nameAliases.js on two players:
//
//     this file          'kyoung-hoon lee' → 'K.H. Lee'
//     nameAliases.js     'K.H. Lee'        → 'Kyoung-Hoon Lee'
//     this file          'byeong hun an'   → 'Byeong Hun An'
//     nameAliases.js     'Byeong Hun An'   → 'Byeong-Hun An'
//
// so "the canonical spelling" depended on which table a code path consulted.
// Its only consumer was resolvePlayerName() in src/utils/index.js, which had
// no call sites at all — dead code carrying a live contradiction.
//
// Every entry it held is now covered by api/_playerNames.js, most of them
// without needing to be named at all: 'matthew'→'matt', 'william'→'will',
// 'benjamin'→'ben', 'nicholas'→'nick', 'cameron'→'cam' and friends are
// GIVEN_NAME_GROUPS rows, so they generalize to players nobody has listed yet.
// The handful that no rule can derive — Eric/Edward Cole, Francesco/Francisco
// Molinari — are ALIAS_GROUPS rows.
//
// CHAR_MAP was the diacritic-folding table behind normalizePlayerName. It
// covered a hand-listed subset of accented characters and missed æ, ð, ł and
// friends; nameKey() in api/_playerNames.js folds those explicitly and then
// NFD-strips every remaining combining mark, so it needs no character list.
//
// Import from api/_playerNames.js instead:
//   nameKey / namesMatch / NameSet / NameMap / resolveAlias

// ============================================================================
// LIV GOLF ROSTER (2026 Season)
// Updated from https://www.livgolf.com/teams — March 2026
// Update at the start of each LIV season.
// ============================================================================
export const LIV_GOLF_ROSTER = [
  // 4Aces GC
  'Dustin Johnson', 'Thomas Detry', 'Anthony Kim', 'Thomas Pieters',
  // Cleeks GC
  'Martin Kaymer', 'Richard Bland', 'Adrian Meronk', 'Victor Perez',
  // Crushers GC
  'Bryson DeChambeau', 'Paul Casey', 'Charles Howell III', 'Anirban Lahiri',
  // Fireballs GC
  'Sergio Garcia', 'Josele Ballester', 'Luis Masaveu', 'David Puig',
  // HyFlyers GC
  'Phil Mickelson', 'Michael La Sasso', 'Brendan Steele', 'Cameron Tringale',
  // Korean Golf Club
  'Byeong Hun An', 'Minkyu Kim', 'Danny Lee', 'Younghan Song',
  // Legion XIII
  'Jon Rahm', 'Tyrrell Hatton', 'Tom McKibbin', 'Caleb Surratt',
  // Majesticks GC
  'Ian Poulter', 'Lee Westwood', 'Laurie Canter', 'Sam Horsfield',
  // RangeGoats GC
  'Bubba Watson', 'Ben Campbell', 'Peter Uihlein', 'Matthew Wolff',
  // Ripper GC
  'Cameron Smith', 'Lucas Herbert', 'Marc Leishman', 'Elvis Smylie',
  // Smash GC
  'Talor Gooch', 'Jason Kokrak', 'Graeme McDowell', 'Harold Varner III',
  // Southern Guards GC
  'Louis Oosthuizen', 'Dean Burmester', 'Branden Grace', 'Charl Schwartzel',
  // Torque GC
  'Joaquin Niemann', 'Abraham Ancer', 'Sebastian Munoz', 'Carlos Ortiz',
  // Wild Card
  'Yosuke Asaji', 'Bjorn Hellgren', 'Richard T. Lee', 'Miguel Tabuena', 'Scott Vincent',
];
