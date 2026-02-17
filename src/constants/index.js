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
  'Dim Bulb':          'DB',
  'POPS, LLC':         'POP',
};

export const INITIAL_TEAMS = [
  { id: 'drc',  name: 'Detroit Rock City', owner: 'TJ',     roster: [], lineup: [], earnings: 0, segmentEarnings: 0, segmentFees: 0, transactionFees: 0, mulligans: { ...DEFAULT_MULLIGANS } },
  { id: 'db',   name: 'Dirty Bird(ies)',   owner: 'Hershey', roster: [], lineup: [], earnings: 0, segmentEarnings: 0, segmentFees: 0, transactionFees: 0, mulligans: { ...DEFAULT_MULLIGANS } },
  { id: 'hh',   name: 'Hip Happens',       owner: 'Fano',   roster: [], lineup: [], earnings: 0, segmentEarnings: 0, segmentFees: 0, transactionFees: 0, mulligans: { ...DEFAULT_MULLIGANS } },
  { id: 'w1',   name: 'World #1',          owner: 'Jensen', roster: [], lineup: [], earnings: 0, segmentEarnings: 0, segmentFees: 0, transactionFees: 0, mulligans: { ...DEFAULT_MULLIGANS } },
  { id: 'pops', name: 'POPS, LLC',         owner: 'Lutz',   roster: [], lineup: [], earnings: 0, segmentEarnings: 0, segmentFees: 0, transactionFees: 0, mulligans: { ...DEFAULT_MULLIGANS } },
];

// ============================================================================
// API
// ============================================================================
export const RAPIDAPI_HOST = 'live-golf-data.p.rapidapi.com';

// ============================================================================
// FALLBACK SCHEDULE
// ============================================================================
export const FALLBACK_SCHEDULE_DATA = [
  { key: 'Sentry',            loc: 'Kapalua, Hawaii',                course: 'Kapalua Resort',       d: 'Jan 5-11',      s: '2026-01-05', e: '2026-01-11' },
  { key: 'Sony Open',         loc: 'Honolulu, Hawaii',               course: 'Waialae CC',            d: 'Jan 12-18',     s: '2026-01-12', e: '2026-01-18' },
  { key: 'American Express',  loc: 'La Quinta, California',          course: 'PGA West',             d: 'Jan 19-25',     s: '2026-01-19', e: '2026-01-25' },
  { key: 'Farmers Insurance', loc: 'San Diego, California',          course: 'Torrey Pines',         d: 'Jan 26-Feb 1',  s: '2026-01-26', e: '2026-02-01' },
  { key: 'WM Phoenix',        loc: 'Scottsdale, Arizona',            course: 'TPC Scottsdale',       d: 'Feb 2-8',       s: '2026-02-02', e: '2026-02-08' },
  { key: 'Phoenix Open',      loc: 'Scottsdale, Arizona',            course: 'TPC Scottsdale',       d: 'Feb 2-8',       s: '2026-02-02', e: '2026-02-08' },
  { key: 'Pebble Beach',      loc: 'Pebble Beach, California',       course: 'Pebble Beach GL',      d: 'Feb 9-15',      s: '2026-02-09', e: '2026-02-15' },
  { key: 'Genesis',           loc: 'Pacific Palisades, California',  course: 'Riviera CC',           d: 'Feb 16-22',     s: '2026-02-16', e: '2026-02-22' },
  { key: 'Cognizant',         loc: 'Palm Beach Gardens, Florida',    course: 'PGA National',         d: 'Feb 23-Mar 1',  s: '2026-02-23', e: '2026-03-01' },
  { key: 'Arnold Palmer',     loc: 'Orlando, Florida',               course: 'Bay Hill',             d: 'Mar 2-8',       s: '2026-03-02', e: '2026-03-08' },
  { key: 'Puerto Rico',       loc: 'Rio Grande, Puerto Rico',        course: 'Grand Reserve',        d: 'Mar 2-8',       s: '2026-03-02', e: '2026-03-08' },
  { key: 'PLAYERS',           loc: 'Ponte Vedra Beach, Florida',     course: 'TPC Sawgrass',         d: 'Mar 9-15',      s: '2026-03-09', e: '2026-03-15' },
  { key: 'Valspar',           loc: 'Palm Harbor, Florida',           course: 'Innisbrook',           d: 'Mar 16-22',     s: '2026-03-16', e: '2026-03-22' },
  { key: 'Houston Open',      loc: 'Houston, Texas',                 course: 'Memorial Park',        d: 'Mar 23-29',     s: '2026-03-23', e: '2026-03-29' },
  { key: 'Valero Texas',      loc: 'San Antonio, Texas',             course: 'TPC San Antonio',      d: 'Mar 30-Apr 5',  s: '2026-03-30', e: '2026-04-05' },
  { key: 'Masters',           loc: 'Augusta, Georgia',               course: 'Augusta National',     d: 'Apr 6-12',      s: '2026-04-06', e: '2026-04-12' },
  { key: 'RBC Heritage',      loc: 'Hilton Head Island, SC',         course: 'Harbour Town',         d: 'Apr 13-19',     s: '2026-04-13', e: '2026-04-19' },
  { key: 'Zurich Classic',    loc: 'Avondale, Louisiana',            course: 'TPC Louisiana',        d: 'Apr 20-26',     s: '2026-04-20', e: '2026-04-26' },
  { key: 'Miami Championship',loc: 'Miami, Florida',                 course: 'TBD',                  d: 'Apr 27-May 3',  s: '2026-04-27', e: '2026-05-03' },
  { key: 'Truist Championship',loc:'Charlotte, North Carolina',      course: 'Quail Hollow',         d: 'May 4-10',      s: '2026-05-04', e: '2026-05-10' },
  { key: 'Myrtle Beach',      loc: 'Myrtle Beach, SC',               course: 'Dunes Club',           d: 'May 4-10',      s: '2026-05-04', e: '2026-05-10' },
  { key: 'PGA Championship',  loc: 'Newtown Square, Pennsylvania',   course: 'Aronimink GC',         d: 'May 11-17',     s: '2026-05-11', e: '2026-05-17' },
  { key: 'Charles Schwab',    loc: 'Fort Worth, Texas',              course: 'Colonial CC',          d: 'May 18-24',     s: '2026-05-18', e: '2026-05-24' },
  { key: 'Memorial',          loc: 'Dublin, Ohio',                   course: 'Muirfield Village',    d: 'May 25-31',     s: '2026-05-25', e: '2026-05-31' },
  { key: 'RBC Canadian',      loc: 'Toronto, Ontario',               course: 'Oakdale',              d: 'Jun 1-7',       s: '2026-06-01', e: '2026-06-07' },
  { key: 'U.S. Open',         loc: 'Southampton, New York',          course: 'Shinnecock Hills',     d: 'Jun 8-14',      s: '2026-06-08', e: '2026-06-14' },
  { key: 'Travelers',         loc: 'Cromwell, Connecticut',          course: 'TPC River Highlands',  d: 'Jun 15-21',     s: '2026-06-15', e: '2026-06-21' },
  { key: 'Rocket Mortgage',   loc: 'Detroit, Michigan',              course: 'Detroit GC',           d: 'Jun 22-28',     s: '2026-06-22', e: '2026-06-28' },
  { key: 'John Deere',        loc: 'Silvis, Illinois',               course: 'TPC Deere Run',        d: 'Jun 29-Jul 5',  s: '2026-06-29', e: '2026-07-05' },
  { key: 'Scottish Open',     loc: 'North Berwick, Scotland',        course: 'Renaissance Club',     d: 'Jul 6-12',      s: '2026-07-06', e: '2026-07-12' },
  { key: 'ISCO',              loc: 'Nicholasville, Kentucky',        course: 'Keene Trace',          d: 'Jul 6-12',      s: '2026-07-06', e: '2026-07-12' },
  { key: 'The Open',          loc: 'Lytham St Annes, England',       course: 'Royal Birkdale',       d: 'Jul 13-19',     s: '2026-07-13', e: '2026-07-19' },
  { key: 'Barracuda',         loc: 'Truckee, California',            course: 'Tahoe Mountain Club',  d: 'Jul 13-19',     s: '2026-07-13', e: '2026-07-19' },
  { key: '3M Open',           loc: 'Blaine, Minnesota',              course: 'TPC Twin Cities',      d: 'Jul 20-26',     s: '2026-07-20', e: '2026-07-26' },
  { key: 'Wyndham',           loc: 'Greensboro, North Carolina',     course: 'Sedgefield CC',        d: 'Aug 3-9',       s: '2026-08-03', e: '2026-08-09' },
  { key: 'FedEx St. Jude',    loc: 'Memphis, Tennessee',             course: 'TPC Southwind',        d: 'Aug 10-16',     s: '2026-08-10', e: '2026-08-16' },
  { key: 'BMW Championship',  loc: 'Owings Mills, Maryland',         course: 'Caves Valley',         d: 'Aug 17-23',     s: '2026-08-17', e: '2026-08-23' },
  { key: 'TOUR Championship', loc: 'Atlanta, Georgia',               course: 'East Lake GC',         d: 'Aug 24-30',     s: '2026-08-24', e: '2026-08-30' },
];

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
