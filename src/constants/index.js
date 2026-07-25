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
// SWINGS / SEGMENTS
// ============================================================================
// SFGL canonical: 4 swings, evenly distributed across the year.
// Wave 7: removed 'Florida Swing' which was an outlier in this file but never
// actually used by any month-to-segment mapping in the codebase. The 4-swing
// model matches theme.js, AdminView, ResultsView, TransactionsView, and (after
// Wave 7) utils/getSegmentByDate.
export const SWINGS = [
  'West Coast Swing',
  'Spring Swing',
  'Summer Swing',
  'Fall Finish',
];

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

export const PLAYER_NAME_ALIASES = {
  'samuel stevens': 'Sam Stevens', 'john keefer': 'Johnny Keefer',
  'si woo kim': 'Si Woo Kim', 'byeong hun an': 'Byeong Hun An',
  'sung-jae im': 'Sungjae Im', 'sungjae im': 'Sungjae Im',
  'seung-jae im': 'Sungjae Im', 'kyoung-hoon lee': 'K.H. Lee',
  'k.h. lee': 'K.H. Lee', 'min-woo lee': 'Min Woo Lee',
  'c.t. pan': 'C.T. Pan', 'ct pan': 'C.T. Pan',
  'matthew fitzpatrick': 'Matt Fitzpatrick', 'matthew kuchar': 'Matt Kuchar',
  'matthew wallace': 'Matt Wallace', 'matthew mccarty': 'Matt McCarty',
  'william zalatoris': 'Will Zalatoris', 'william gordon': 'Will Gordon',
  'william chandler': 'Will Chandler', 'benjamin griffin': 'Ben Griffin',
  'benjamin kohles': 'Ben Kohles', 'benjamin silverman': 'Ben Silverman',
  'benjamin martin': 'Ben Martin', 'nicholas dunlap': 'Nick Dunlap',
  'nicholas taylor': 'Nick Taylor', 'nicholas hardy': 'Nick Hardy',
  'joseph highsmith': 'Joe Highsmith', 'alexander noren': 'Alex Noren',
  'alexander smalley': 'Alex Smalley', 'cameron young': 'Cameron Young',
  'cameron davis': 'Cam Davis', 'cameron percy': 'Cam Percy',
  'christopher kirk': 'Chris Kirk', 'christopher gotterup': 'Chris Gotterup',
  'douglas ghim': 'Doug Ghim', 'robert macintyre': 'Robert MacIntyre',
  'mackenzie hughes': 'Mackenzie Hughes', 'edward cole': 'Eric Cole',
  'francisco molinari': 'Francesco Molinari', 'haotong li': 'Haotong Li',
};

export const CHAR_MAP = {
  'ø':'o','ö':'o','ó':'o','ô':'o','õ':'o',
  'å':'a','ä':'a','á':'a','à':'a','â':'a','ã':'a',
  'ü':'u','ú':'u','ù':'u','û':'u',
  'é':'e','è':'e','ê':'e','ë':'e',
  'í':'i','ì':'i','î':'i','ï':'i',
  'ñ':'n','ç':'c','ß':'ss',
};

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
