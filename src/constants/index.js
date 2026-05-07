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
// AUTH
// ============================================================================
export const COMMISSIONER_PASSWORD_HASH =
  'a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3';

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
export const PGA_TOUR_IDS = {
  'Scottie Scheffler': '46046', 'Rory McIlroy': '28237', 'Xander Schauffele': '48081',
  'Viktor Hovland': '46717', 'Brooks Koepka': '36689', 'Tommy Fleetwood': '30911',
  'Ludvig Aberg': '52955', 'Patrick Cantlay': '35450', 'Wyndham Clark': '47128',
  'Collin Morikawa': '50525', 'Max Homa': '39977', 'Tony Finau': '29725',
  'Sahith Theegala': '51634', 'Keegan Bradley': '33141', 'Sam Burns': '47504',
  'Hideki Matsuyama': '32839', 'Jordan Spieth': '34046', 'Justin Thomas': '33448',
  'Matt Fitzpatrick': '40098', 'Russell Henley': '34098', 'Shane Lowry': '33204',
  'Robert MacIntyre': '50264', 'Corey Conners': '39971', 'Jason Day': '28089',
  'Si Woo Kim': '32791', 'Akshay Bhatia': '56630', 'Cameron Young': '57362',
  'Brian Harman': '34021', 'Sepp Straka': '49960', 'Sungjae Im': '49298',
  'Justin Rose': '22405', 'Tom Kim': '55182', 'Aaron Rai': '46414',
  'Billy Horschel': '28679', 'Adam Scott': '24502', 'Min Woo Lee': '54591',
  'Byeong Hun An': '32058', 'Denny McCarthy': '47856', 'Taylor Pendrith': '48867',
  'Christiaan Bezuidenhout': '51349', 'Eric Cole': '39546', 'Chris Kirk': '29478',
  'Adam Hadwin': '33399', 'Alex Noren': '27349', 'Tom Hoge': '35532',
  'J.T. Poston': '34306', 'Nick Taylor': '25493', 'Max Greyserman': '52375',
  'Maverick McNealy': '49766', 'Harris English': '30925',
  'Patrick Rodgers': '36699', 'Stephan Jaeger': '35421', 'Davis Thompson': '56441',
  'Justin Lower': '49964', 'Nick Dunlap': '59442', 'Luke Clanton': '60529',
  'Austin Eckroat': '53165', 'Ben Griffin': '50095', 'Nico Echavarria': '52440',
  'Andrew Novak': '51997', 'Keith Mitchell': '40009', 'Jake Knapp': '47420',
  'Harry Hall': '51890', 'Michael Thorbjornsen': '57366', 'Cam Davis': '45526',
  'Matt Kuchar': '22371', 'Taylor Moore': '49771', 'J.J. Spaun': '39324',
  'Mark Hubbard': '40068', 'Ryan Fox': '33419', 'Gary Woodland': '31323',
  'Emiliano Grillo': '32640', 'Peter Malnati': '29926', 'Adam Svensson': '47347',
  'Doug Ghim': '53236', 'Ben Kohles': '50128', 'Ryo Hisatsune': '51287',
  'Mac Meissner': '57371', 'Kevin Yu': '52372', 'Joel Dahmen': '34076',
  'Lucas Glover': '24361', 'Matt Wallace': '48153', 'Thorbjorn Olesen': '34255',
  'Lee Hodges': '52164', 'Ryan Palmer': '25364', 'Zac Blair': '37380',
  'Sam Stevens': '56449', 'Rasmus Hojgaard': '55895', 'Nicolai Hojgaard': '55894',
  'Rickie Fowler': '32102', 'Webb Simpson': '25804', 'Will Zalatoris': '57975',
  'Brendon Todd': '30978', 'Kevin Kisner': '29908', 'Scott Stallings': '30692',
  'Andrew Putnam': '33486', 'Charley Hoffman': '21528', 'Nick Hardy': '49768',
  'Zach Johnson': '20766', 'Sam Ryder': '49959', 'Nate Lashley': '28775',
  'Chad Ramey': '50048', 'Martin Laird': '25632', 'Kevin Streelman': '25493',
  'Brandon Wu': '54825', 'Pierceson Coody': '55898', 'Chris Gotterup': '59095',
  'Rico Hoey': '52366', 'Will Gordon': '50395', 'Hayden Springer': '58168',
  'Davis Riley': '51070', 'Austin Smotherman': '53197', 'Karl Vilips': '59820',
  'Aldrich Potgieter': '60192', 'Michael Brennan': '58440', 'Seamus Power': '34213',
  'Matt McCarty': '57359', 'Matthieu Pavon': '50893', 'Erik van Rooyen': '46611',
  'Thomas Detry': '46402', 'Alex Smalley': '52443', 'Gordon Sargent': '57376',
  'Garrick Higgo': '55909', 'Camilo Villegas': '25198', 'Hayden Buckley': '52163',
  'Joe Highsmith': '57373', 'Mackenzie Hughes': '35506', 'Luke List': '30927',
  'David Lipsky': '33408', 'Isaiah Salinda': '53193', 'Steven Fisk': '51066',
  'Doc Redman': '48117', 'Wilson Furr': '55905', 'Bryson DeChambeau': '47959',
  'Cameron Smith': '34360', 'Tyrrell Hatton': '34363',
};

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
