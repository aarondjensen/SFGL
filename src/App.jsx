import React, { useState, useEffect, useMemo, useCallback, useRef, createContext, useContext } from 'react';
import { Trophy, Users, DollarSign, Calendar, Settings, BarChart3, X, Check, AlertCircle, Clock, Download, Upload, ChevronDown, ChevronRight, Search, Edit2, Save } from 'lucide-react';
import { storage } from './api';
import sfglLogo from './assets/logo.png';

const RAPIDAPI_KEY = import.meta.env.VITE_RAPIDAPI_KEY;
const RAPIDAPI_HOST = 'live-golf-data.p.rapidapi.com';

const STORAGE_KEYS = {
  TEAMS: 'fantasy-golf-teams', TOURNAMENTS: 'fantasy-golf-tournaments',
  TRANSACTIONS: 'fantasy-golf-transactions', SETTINGS: 'fantasy-golf-settings',
  GLOBAL_PLAYER_STATS: 'fantasy-golf-global-player-stats',
  LOGGED_IN_USER: 'sfgl-logged-in-user', PLAYER_RANKINGS: 'fantasy-golf-player-rankings',
  HEADSHOTS: 'fantasy-golf-headshots'
};

const BONUSES_REGULAR = { round1: 20000, round2: 40000, round3: 60000 };
const BONUSES_MAJOR = { round1: 40000, round2: 80000, round3: 120000 };

const COMMISSIONER_PASSWORD_HASH = 'a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3';

const hashPassword = async (password) => {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
};

const TEAM_ABBREVIATIONS = {
  'Detroit Rock City': 'DRC', 'Dirty Bird(ies)': 'DBs', 'Hip Happens': 'HH',
  'World #1': 'W#1', 'Dim Bulb': 'DB', 'POPS, LLC': 'POP'
};

const SFGL_LOGO_SRC = sfglLogo;
const SWINGS = ['West Coast Swing', 'Florida Swing', 'Spring Swing', 'Summer Swing', 'Fall Finish'];

const FALLBACK_SCHEDULE_DATA = [
  { key: 'Sentry', loc: 'Kapalua, Hawaii', course: 'Kapalua Resort', d: 'Jan 5-11', s: '2026-01-05', e: '2026-01-11' },
  { key: 'Sony Open', loc: 'Honolulu, Hawaii', course: 'Waialae CC', d: 'Jan 12-18', s: '2026-01-12', e: '2026-01-18' },
  { key: 'American Express', loc: 'La Quinta, California', course: 'PGA West', d: 'Jan 19-25', s: '2026-01-19', e: '2026-01-25' },
  { key: 'Farmers Insurance', loc: 'San Diego, California', course: 'Torrey Pines', d: 'Jan 26-Feb 1', s: '2026-01-26', e: '2026-02-01' },
  { key: 'WM Phoenix', loc: 'Scottsdale, Arizona', course: 'TPC Scottsdale', d: 'Feb 2-8', s: '2026-02-02', e: '2026-02-08' },
  { key: 'Phoenix Open', loc: 'Scottsdale, Arizona', course: 'TPC Scottsdale', d: 'Feb 2-8', s: '2026-02-02', e: '2026-02-08' },
  { key: 'Pebble Beach', loc: 'Pebble Beach, California', course: 'Pebble Beach GL', d: 'Feb 9-15', s: '2026-02-09', e: '2026-02-15' },
  { key: 'Genesis', loc: 'Pacific Palisades, California', course: 'Riviera CC', d: 'Feb 16-22', s: '2026-02-16', e: '2026-02-22' },
  { key: 'Cognizant', loc: 'Palm Beach Gardens, Florida', course: 'PGA National', d: 'Feb 23-Mar 1', s: '2026-02-23', e: '2026-03-01' },
  { key: 'Arnold Palmer', loc: 'Orlando, Florida', course: 'Bay Hill', d: 'Mar 2-8', s: '2026-03-02', e: '2026-03-08' },
  { key: 'Puerto Rico', loc: 'Rio Grande, Puerto Rico', course: 'Grand Reserve', d: 'Mar 2-8', s: '2026-03-02', e: '2026-03-08' },
  { key: 'PLAYERS', loc: 'Ponte Vedra Beach, Florida', course: 'TPC Sawgrass', d: 'Mar 9-15', s: '2026-03-09', e: '2026-03-15' },
  { key: 'Valspar', loc: 'Palm Harbor, Florida', course: 'Innisbrook', d: 'Mar 16-22', s: '2026-03-16', e: '2026-03-22' },
  { key: 'Houston Open', loc: 'Houston, Texas', course: 'Memorial Park', d: 'Mar 23-29', s: '2026-03-23', e: '2026-03-29' },
  { key: 'Valero Texas', loc: 'San Antonio, Texas', course: 'TPC San Antonio', d: 'Mar 30-Apr 5', s: '2026-03-30', e: '2026-04-05' },
  { key: 'Masters', loc: 'Augusta, Georgia', course: 'Augusta National', d: 'Apr 6-12', s: '2026-04-06', e: '2026-04-12' },
  { key: 'RBC Heritage', loc: 'Hilton Head Island, SC', course: 'Harbour Town', d: 'Apr 13-19', s: '2026-04-13', e: '2026-04-19' },
  { key: 'Zurich Classic', loc: 'Avondale, Louisiana', course: 'TPC Louisiana', d: 'Apr 20-26', s: '2026-04-20', e: '2026-04-26' },
  { key: 'Miami Championship', loc: 'Miami, Florida', course: 'TBD', d: 'Apr 27-May 3', s: '2026-04-27', e: '2026-05-03' },
  { key: 'Truist Championship', loc: 'Charlotte, North Carolina', course: 'Quail Hollow', d: 'May 4-10', s: '2026-05-04', e: '2026-05-10' },
  { key: 'Myrtle Beach', loc: 'Myrtle Beach, SC', course: 'Dunes Club', d: 'May 4-10', s: '2026-05-04', e: '2026-05-10' },
  { key: 'PGA Championship', loc: 'Newtown Square, Pennsylvania', course: 'Aronimink GC', d: 'May 11-17', s: '2026-05-11', e: '2026-05-17' },
  { key: 'Charles Schwab', loc: 'Fort Worth, Texas', course: 'Colonial CC', d: 'May 18-24', s: '2026-05-18', e: '2026-05-24' },
  { key: 'Memorial', loc: 'Dublin, Ohio', course: 'Muirfield Village', d: 'May 25-31', s: '2026-05-25', e: '2026-05-31' },
  { key: 'RBC Canadian', loc: 'Toronto, Ontario', course: 'Oakdale', d: 'Jun 1-7', s: '2026-06-01', e: '2026-06-07' },
  { key: 'U.S. Open', loc: 'Southampton, New York', course: 'Shinnecock Hills', d: 'Jun 8-14', s: '2026-06-08', e: '2026-06-14' },
  { key: 'Travelers', loc: 'Cromwell, Connecticut', course: 'TPC River Highlands', d: 'Jun 15-21', s: '2026-06-15', e: '2026-06-21' },
  { key: 'Rocket Mortgage', loc: 'Detroit, Michigan', course: 'Detroit GC', d: 'Jun 22-28', s: '2026-06-22', e: '2026-06-28' },
  { key: 'John Deere', loc: 'Silvis, Illinois', course: 'TPC Deere Run', d: 'Jun 29-Jul 5', s: '2026-06-29', e: '2026-07-05' },
  { key: 'Scottish Open', loc: 'North Berwick, Scotland', course: 'Renaissance Club', d: 'Jul 6-12', s: '2026-07-06', e: '2026-07-12' },
  { key: 'ISCO', loc: 'Nicholasville, Kentucky', course: 'Keene Trace', d: 'Jul 6-12', s: '2026-07-06', e: '2026-07-12' },
  { key: 'The Open', loc: 'Lytham St Annes, England', course: 'Royal Birkdale', d: 'Jul 13-19', s: '2026-07-13', e: '2026-07-19' },
  { key: 'Barracuda', loc: 'Truckee, California', course: 'Tahoe Mountain Club', d: 'Jul 13-19', s: '2026-07-13', e: '2026-07-19' },
  { key: '3M Open', loc: 'Blaine, Minnesota', course: 'TPC Twin Cities', d: 'Jul 20-26', s: '2026-07-20', e: '2026-07-26' },
  { key: 'Wyndham', loc: 'Greensboro, North Carolina', course: 'Sedgefield CC', d: 'Aug 3-9', s: '2026-08-03', e: '2026-08-09' },
  { key: 'FedEx St. Jude', loc: 'Memphis, Tennessee', course: 'TPC Southwind', d: 'Aug 10-16', s: '2026-08-10', e: '2026-08-16' },
  { key: 'BMW Championship', loc: 'Owings Mills, Maryland', course: 'Caves Valley', d: 'Aug 17-23', s: '2026-08-17', e: '2026-08-23' },
  { key: 'TOUR Championship', loc: 'Atlanta, Georgia', course: 'East Lake GC', d: 'Aug 24-30', s: '2026-08-24', e: '2026-08-30' },
];

const DEFAULT_ELIGIBLE_PLAYERS = [];
const INITIAL_SCHEDULE = [];

const makePlayer = (name, limited = false, stars = 0, unlimited = false, yearsOfService = 1) => ({
  name, limited, stars: limited ? (stars || 1) : 0, unlimited, yearsOfService, starts: 0, eventsPlayed: 0, cutsMade: 0, pgaTourEarnings: 0, sfglEarnings: 0, headshot: ''
});

const DEFAULT_MULLIGANS = { signatureMajor: 1, regular: 1 };

const INITIAL_TEAMS = [
  { id: 'drc', name: 'Detroit Rock City', owner: 'TJ', roster: [], lineup: [], earnings: 0, segmentEarnings: 0, segmentFees: 0, transactionFees: 0, mulligans: { ...DEFAULT_MULLIGANS } },
  { id: 'db', name: 'Dirty Bird(ies)', owner: 'Hershey', roster: [], lineup: [], earnings: 0, segmentEarnings: 0, segmentFees: 0, transactionFees: 0, mulligans: { ...DEFAULT_MULLIGANS } },
  { id: 'hh', name: 'Hip Happens', owner: 'Fano', roster: [], lineup: [], earnings: 0, segmentEarnings: 0, segmentFees: 0, transactionFees: 0, mulligans: { ...DEFAULT_MULLIGANS } },
  { id: 'w1', name: 'World #1', owner: 'Jensen', roster: [], lineup: [], earnings: 0, segmentEarnings: 0, segmentFees: 0, transactionFees: 0, mulligans: { ...DEFAULT_MULLIGANS } },
  { id: 'pops', name: 'POPS, LLC', owner: 'Lutz', roster: [], lineup: [], earnings: 0, segmentEarnings: 0, segmentFees: 0, transactionFees: 0, mulligans: { ...DEFAULT_MULLIGANS } }
];

const getSegmentByDate = () => {
  const month = new Date().getMonth() + 1;
  if (month >= 1 && month <= 3) return 'West Coast Swing';
  if (month >= 4 && month <= 5) return 'Florida Swing';
  if (month >= 6 && month <= 8) return 'Summer Swing';
  return 'Fall Finish';
};

const getTeamAbbreviation = (teamName) => {
  return TEAM_ABBREVIATIONS[teamName] || teamName.split(' ').map(w => w[0]).join('').slice(0, 3).toUpperCase();
};

const getETNow = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));

const isPastRoundStart = (roundNum) => {
  const et = getETNow();
  const day = et.getDay();
  const hour = et.getHours();
  const lockHour = 7; 

  if (roundNum === 2) return (day === 5 && hour >= lockHour) || day === 6 || day === 0;
  if (roundNum === 3) return (day === 6 && hour >= lockHour) || day === 0;
  if (roundNum === 4) return day === 0 && hour >= lockHour;
  return false;
};

const getTournamentTimezone = (tournament) => {
  if (!tournament?.location) return 'ET';
  const loc = tournament.location.toLowerCase();
  if (loc.includes('hawaii') || loc.includes('honolulu')) return 'HT';
  if (loc.includes('california') || loc.includes('pebble beach') || loc.includes('la quinta') || loc.includes('san diego') || loc.includes('pacific palisades') || loc.includes('napa') || loc.includes('oregon') || loc.includes('washington')) return 'PT';
  if (loc.includes('arizona') || loc.includes('scottsdale') || loc.includes('colorado') || loc.includes('utah') || loc.includes('montana') || loc.includes('idaho') || loc.includes('wyoming') || loc.includes('new mexico') || loc.includes('nevada')) return 'MT';
  if (loc.includes('texas') || loc.includes('houston') || loc.includes('san antonio') || loc.includes('fort worth') || loc.includes('mckinney') || loc.includes('louisiana') || loc.includes('avondale') || loc.includes('illinois') || loc.includes('silvis') || loc.includes('minnesota') || loc.includes('blaine') || loc.includes('michigan') || loc.includes('detroit') || loc.includes('memphis') || loc.includes('tennessee') || loc.includes('missouri') || loc.includes('st. louis') || loc.includes('wisconsin') || loc.includes('iowa') || loc.includes('kentucky') || loc.includes('louisville')) return 'CT';
  return 'ET';
};

const getTournamentLockHourET = (tournament) => {
  const tz = getTournamentTimezone(tournament);
  switch (tz) {
    case 'HT': return 12;
    case 'PT': return 9;
    case 'MT': return 8;
    case 'CT': return 8;
    case 'ET': return 7;
    default: return 7;
  }
};

const getTournamentStartDate = (tournament) => {
  if (tournament.startDate) return new Date(tournament.startDate);
  if (!tournament?.dates) return null;
  const match = tournament.dates.match(/^([A-Za-z]+)\s+(\d+)/);
  if (!match) return null;
  const monthStr = match[1];
  const day = parseInt(match[2]);
  const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const month = months[monthStr];
  if (month === undefined) return null;
  return new Date(2026, month, day);
};

const isTournamentLocked = (tournament) => {
  if (!tournament) return false;
  const et = getETNow();
  const startDate = getTournamentStartDate(tournament);
  if (!startDate) return false;
  const rangeStart = new Date(startDate);
  let thursday = new Date(rangeStart);
  while (thursday.getDay() !== 4) {
    thursday.setDate(thursday.getDate() + 1);
  }
  const lockHour = getTournamentLockHourET(tournament);
  const lockTime = new Date(thursday);
  lockTime.setHours(lockHour, 0, 0, 0);
  return et >= lockTime;
};

const isLineupEditingOpen = (tournament) => {
  const et = getETNow();
  const day = et.getDay();
  const hour = et.getHours();
  const timeVal = hour * 60 + et.getMinutes();
  if (isTournamentLocked(tournament)) return false;
  if (day === 0 && timeVal >= 1260) return true;
  if (day >= 1 && day <= 3) return true;
  if (day === 4) return true;
  return false;
};

const getLineupStatus = (tournament) => {
  if (!tournament) return { open: false, label: '🔴 No active tournament' };
  if (isTournamentLocked(tournament)) {
    return { open: false, label: '🔴 Locked' };
  }
  if (isLineupEditingOpen(tournament)) {
    const lockHour = getTournamentLockHourET(tournament);
    const lockStr = lockHour > 12 ? `${lockHour - 12}pm` : lockHour === 12 ? '12pm' : `${lockHour}am`;
    return { open: true, label: `🟢 until Thu ${lockStr} ET` };
  }
  return { open: false, label: '🔴 until Sun 9pm ET' };
};

const isFreeAgentWindowOpen = (tournament) => {
  const et = getETNow();
  const day = et.getDay();
  const hour = et.getHours();
  const min = et.getMinutes();
  const timeVal = hour * 60 + min;
  if (isTournamentLocked(tournament)) return false;
  if (day === 2 && timeVal >= 1201) return true;
  if (day === 3) return true;
  if (day === 4) return true;
  return false;
};

const isWaiverWindowOpen = () => {
  const et = getETNow();
  const day = et.getDay();
  const hour = et.getHours();
  const min = et.getMinutes();
  const timeVal = hour * 60 + min;
  if (day === 0 && timeVal >= 1260) return true;
  if (day === 1) return true;
  if (day === 2 && timeVal <= 1200) return true;
  return false;
};

const getFreeAgentWindowStatus = (tournament) => {
  if (isFreeAgentWindowOpen(tournament)) {
    const lockHour = getTournamentLockHourET(tournament);
    const lockStr = lockHour > 12 ? `${lockHour - 12}pm` : lockHour === 12 ? '12pm' : `${lockHour}am`;
    return { open: true, label: `Open until Thu ${lockStr} ET` };
  }
  if (isTournamentLocked(tournament)) return { open: false, label: 'Locked' };
  return { open: false, label: 'Opens Tue 8:01pm ET' };
};

const getWaiverWindowStatus = () => {
  if (isWaiverWindowOpen()) return { open: true, label: 'Open' };
  return { open: false, label: 'Opens Sun 9pm ET' };
};

const shortName = (fullName) => {
  if (!fullName) return '';
  const parts = fullName.split(' ');
  return parts[parts.length - 1];
};

const PGA_TOUR_IDS = {
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
  'Adam Schenk': '49298', 'Lucas Glover': '24361', 'Matt Wallace': '48153',
  'Thorbjorn Olesen': '34255', 'Lee Hodges': '52164', 'Ryan Palmer': '25364',
  'Zac Blair': '37380', 'Sam Stevens': '56449', 'Bud Cauley': '33419',
  'Rasmus Hojgaard': '55895', 'Nicolai Hojgaard': '55894', 'Daniel Berger': '47128',
  'Rickie Fowler': '32102', 'Webb Simpson': '25804', 'Will Zalatoris': '57975',
  'Brendon Todd': '30978', 'Kevin Kisner': '29908',
  'Scott Stallings': '30692', 'Andrew Putnam': '33486', 'Charley Hoffman': '21528',
  'Nick Hardy': '49768', 'Zach Johnson': '20766', 'Patrick Fishburn': '50127',
  'Sam Ryder': '49959', 'Michael Kim': '47993', 'Vince Whaley': '51287',
  'Beau Hossler': '52955', 'Nate Lashley': '28775', 'Chad Ramey': '50048',
  'Martin Laird': '25632', 'Dylan Wu': '49267', 'Kevin Streelman': '25493',
  'Troy Merritt': '32640', 'Brandon Wu': '54825', 'Chesson Hadley': '33398',
  'Pierceson Coody': '55898', 'S.H. Kim': '59846', 'Trace Crowe': '55260',
  'Chris Gotterup': '59095', 'Rico Hoey': '52366', 'Will Gordon': '50395',
  'Hayden Springer': '58168', 'Kevin Tway': '31646',
  'Francesco Molinari': '27330', 'Henrik Norlander': '47128', 'Henrik Stenson': '21209',
  'Sung Kang': '29479', 'Kevin Chappell': '30911', 'Patton Kizzire': '32757',
  'Roger Sloan': '33375', 'Ryan Armour': '26329',
  'Davis Riley': '51070', 'Austin Smotherman': '53197', 'Karl Vilips': '59820',
  'Aldrich Potgieter': '60192', 'Michael Brennan': '58440', 'Seamus Power': '34213',
  'Matt McCarty': '57359', 'Jackson Suber': '57370', 'Sami Valimaki': '55900',
  'Matthieu Pavon': '50893', 'Erik van Rooyen': '46611',
  'Matti Schmid': '57344', 'Thomas Detry': '46402', 'Alex Smalley': '52443',
  'Thriston Lawrence': '52432', 'Ben Martin': '27970', 'Brandt Snedeker': '22733',
  'David Skinns': '49297', 'Gordon Sargent': '57376', 'Garrick Higgo': '55909',
  'Brice Garnett': '32058', 'Camilo Villegas': '25198', 'Lanto Griffin': '33410',
  'Hayden Buckley': '52163', 'Harry Higgs': '51502', 'Joe Highsmith': '57373',
  'Mackenzie Hughes': '35506', 'Luke List': '30927', 'David Lipsky': '33408',
  'Frankie Capan III': '55892', 'Ben Silverman': '50066',
  'Isaiah Salinda': '53193', 'Steven Fisk': '51066', 'Doc Redman': '48117',
  'Wilson Furr': '55905',
  'Bryson DeChambeau': '47959', 'Cameron Smith': '34360', 'Tyrrell Hatton': '34363',
};

const SEED_HEADSHOTS = PGA_TOUR_IDS;

const slashGolfFetch = async (endpoint, params = {}) => {
  const url = new URL(`https://${RAPIDAPI_HOST}/${endpoint}`);
  Object.entries(params).forEach(([k, v]) => { 
    if (v !== undefined && v !== null) url.searchParams.set(k, v); 
  });
  
  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: { 'X-RapidAPI-Key': RAPIDAPI_KEY, 'X-RapidAPI-Host': RAPIDAPI_HOST }
  });
  
  if (!res.ok) throw new Error(`Slash Golf API error: ${res.status} ${res.statusText}`);
  return res.json();
};

const getPlayerHeadshot = (playerName, isLimited = false, headshotMap = {}) => {
  const pgaId = headshotMap[playerName] || PGA_TOUR_IDS[playerName];
  if (pgaId) {
    return `https://pga-tour-res.cloudinary.com/image/upload/c_thumb,g_face,z_0.7,q_auto,f_auto,dpr_2.0,w_96,h_96/headshots_${pgaId}`;
  }
  const encodedName = encodeURIComponent(playerName);
  const background = isLimited ? 'EAB308' : '059669';
  return `https://ui-avatars.com/api/?name=${encodedName}&background=${background}&color=ffffff&size=400&bold=true&font-size=0.4`;
};

const getPlayerHeadshotFallback = (playerName, isLimited = false) => {
  const encodedName = encodeURIComponent(playerName);
  const background = isLimited ? 'EAB308' : '059669';
  return `https://ui-avatars.com/api/?name=${encodedName}&background=${background}&color=ffffff&size=400&bold=true&font-size=0.4`;
};

const CHAR_MAP = {
  'ø': 'o', 'ö': 'o', 'ó': 'o', 'ô': 'o', 'õ': 'o',
  'å': 'a', 'ä': 'a', 'á': 'a', 'à': 'a', 'â': 'a', 'ã': 'a',
  'ü': 'u', 'ú': 'u', 'ù': 'u', 'û': 'u',
  'é': 'e', 'è': 'e', 'ê': 'e', 'ë': 'e',
  'í': 'i', 'ì': 'i', 'î': 'i', 'ï': 'i',
  'ñ': 'n', 'ç': 'c', 'ß': 'ss'
};

const PLAYER_NAME_ALIASES = {
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
  'alexander smalley': 'Alex Smalley', 'james piot': 'James Piot',
  'cameron young': 'Cameron Young', 'cameron davis': 'Cam Davis',
  'cameron percy': 'Cam Percy', 'christopher kirk': 'Chris Kirk',
  'christopher gotterup': 'Chris Gotterup', 'douglas ghim': 'Doug Ghim',
  'patrick reed': 'Patrick Reed', 'robert macintyre': 'Robert MacIntyre',
  'mackenzie hughes': 'Mackenzie Hughes', 'richard bland': 'Richard Bland',
  'edward cole': 'Eric Cole', 'john pak': 'John Pak',
  'rafael campos': 'Rafael Campos', 'francisco molinari': 'Francesco Molinari',
  'haotong li': 'Haotong Li',
};

const resolvePlayerName = (owgrName, knownNames) => {
  if (!owgrName) return null;
  const lower = owgrName.toLowerCase().trim();
  if (PLAYER_NAME_ALIASES[lower]) return PLAYER_NAME_ALIASES[lower];
  
  const exact = knownNames.find(n => n.toLowerCase() === lower);
  if (exact) return exact;
  
  const normOwgr = normalizePlayerName(owgrName);
  const normMatch = knownNames.find(n => normalizePlayerName(n) === normOwgr);
  if (normMatch) return normMatch;
  
  const parts = lower.split(/\s+/);
  if (parts.length >= 2) {
    const lastName = parts[parts.length - 1];
    const firstInitial = parts[0][0];
    const candidates = knownNames.filter(n => {
      const np = n.toLowerCase().split(/\s+/);
      return np[np.length - 1] === lastName && np[0][0] === firstInitial;
    });
    if (candidates.length === 1) return candidates[0];
  }
  return null;
};

const normalizePlayerName = (name) => {
  if (!name) return '';
  let normalized = name.toLowerCase().trim();
  Object.keys(CHAR_MAP).forEach(char => {
    normalized = normalized.replace(new RegExp(char, 'g'), CHAR_MAP[char]);
  });
  return normalized.replace(/[.-]/g, ' ').replace(/\s+/g, ' ').trim();
};

const getSortedRoster = (roster) => {
  const limited = roster.filter(p => p.limited);
  const unlimited = roster.filter(p => !p.limited);
  return [...limited, ...unlimited];
};

const processTournamentData = (t, apiPlayers, currentTeams, currentStats, allPlayerNames) => {
  let r1Leaders = [], r2Leaders = [], r3Leaders = [];
  let r1Best = 999, r2Best = 999, r3Best = 999;
  
  apiPlayers.forEach(ap => {
     const pObj = ap?.player || ap;
     let rawName = pObj?.fullName || pObj?.displayName || pObj?.name || '';
     if (!rawName) {
         const fName = pObj?.firstName || '';
         const lName = pObj?.lastName || '';
         rawName = `${fName} ${lName}`.trim();
     }

     const name = resolvePlayerName(rawName, allPlayerNames) || rawName;
     if (!name) return;
     
     const rounds = ap.rounds || [];
     if (rounds[0]?.score) {
        const r1 = parseInt(rounds[0].score);
        if (r1 < r1Best) { r1Best = r1; r1Leaders = [name]; }
        else if (r1 === r1Best) r1Leaders.push(name);
     }
     if (rounds[0]?.score && rounds[1]?.score) {
        const r2 = parseInt(rounds[0].score) + parseInt(rounds[1].score);
        if (r2 < r2Best) { r2Best = r2; r2Leaders = [name]; }
        else if (r2 === r2Best) r2Leaders.push(name);
     }
     if (rounds[0]?.score && rounds[1]?.score && rounds[2]?.score) {
        const r3 = parseInt(rounds[0].score) + parseInt(rounds[1].score) + parseInt(rounds[2].score);
        if (r3 < r3Best) { r3Best = r3; r3Leaders = [name]; }
        else if (r3 === r3Best) r3Leaders.push(name);
     }
  });

  const bonuses = t.isMajor ? BONUSES_MAJOR : BONUSES_REGULAR;
  const playerPayouts = {};

  apiPlayers.forEach(ap => {
     const pObj = ap?.player || ap;
     let rawName = pObj?.fullName || pObj?.displayName || pObj?.name || '';
     if (!rawName) {
         const fName = pObj?.firstName || '';
         const lName = pObj?.lastName || '';
         rawName = `${fName} ${lName}`.trim();
     }

     const name = resolvePlayerName(rawName, allPlayerNames) || rawName;
     if (!name) return;
     
     let earnings = ap.earnings || ap.winnings || ap.payout || 0;
     if (typeof earnings === 'string') earnings = parseInt(earnings.replace(/[^0-9]/g, '')) || 0;

     let bonus = 0;
     let roundsLed = [];
     if (r1Leaders.includes(name)) { bonus += bonuses.round1 / r1Leaders.length; roundsLed.push({round: 1}); }
     if (r2Leaders.includes(name)) { bonus += bonuses.round2 / r2Leaders.length; roundsLed.push({round: 2}); }
     if (r3Leaders.includes(name)) { bonus += bonuses.round3 / r3Leaders.length; roundsLed.push({round: 3}); }

     playerPayouts[name] = { earnings, bonus, roundsLed, total: earnings + bonus };
  });

  const newStats = { ...currentStats };
  const resultsData = { teams: {} };
  
  Object.keys(playerPayouts).forEach(pName => {
      if (!newStats[pName]) newStats[pName] = { eventsPlayed: 0, cutsMade: 0, pgaTourEarnings: 0 };
      newStats[pName].eventsPlayed += 1;
      newStats[pName].pgaTourEarnings += playerPayouts[pName].earnings;
      if (playerPayouts[pName].earnings > 0) newStats[pName].cutsMade += 1;
  });

  const newTeams = currentTeams.map(team => {
     let teamTotal = 0;
     const resultPlayers = [];
     const lineupNames = team.lineup || [];
     
     const newRoster = team.roster.map(rp => {
        if (lineupNames.includes(rp.name)) {
           const payout = playerPayouts[rp.name] || { earnings: 0, bonus: 0, roundsLed: [], total: 0 };
           teamTotal += payout.total;
           resultPlayers.push({ ...rp, ...payout });

           return { 
              ...rp, 
              sfglEarnings: (rp.sfglEarnings || 0) + payout.total,
              pgaTourEarnings: (rp.pgaTourEarnings || 0) + payout.earnings,
              eventsPlayed: (rp.eventsPlayed || 0) + 1,
              cutsMade: (rp.cutsMade || 0) + (payout.earnings > 0 ? 1 : 0)
           };
        }
        return rp;
     });

     resultsData.teams[team.id] = { totalEarnings: teamTotal, players: resultPlayers };

     return {
        ...team,
        earnings: (team.earnings || 0) + teamTotal,
        segmentEarnings: (team.segmentEarnings || 0) + teamTotal,
        roster: newRoster,
        lineup: [] 
     };
  });

  return { newTeams, newStats, resultsData };
};


// ============================================================================
// CONTEXT: Toast & Confirm
// ============================================================================

const DialogContext = createContext(null);
const useDialog = () => useContext(DialogContext);

const DialogProvider = ({ children }) => {
  const [toasts, setToasts] = useState([]);
  const [confirm, setConfirm] = useState(null);
  const confirmResolveRef = useRef(null);

  const showToast = useCallback((message, type = 'success') => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

  const removeToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const showConfirm = useCallback((title, message, opts = {}) => {
    return new Promise((resolve) => {
      confirmResolveRef.current = resolve;
      setConfirm({ title, message, ...opts });
    });
  }, []);

  const handleConfirmResult = useCallback((result) => {
    if (confirmResolveRef.current) confirmResolveRef.current(result);
    confirmResolveRef.current = null;
    setConfirm(null);
  }, []);

  return (
    <DialogContext.Provider value={{ showToast, showConfirm }}>
      {children}
      <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none">
        {toasts.map(toast => {
          const bgColor = toast.type === 'success' ? 'bg-green-600' : toast.type === 'error' ? 'bg-red-600' : 'bg-blue-600';
          const Icon = toast.type === 'success' ? Check : toast.type === 'error' ? AlertCircle : Clock;
          return (
            <div key={toast.id} className={`${bgColor} text-white px-5 py-3 rounded-lg shadow-2xl flex items-center gap-3 max-w-sm pointer-events-auto animate-[slideIn_0.3s_ease-out]`}>
              <Icon className="w-4 h-4 flex-shrink-0" />
              <span className="text-sm flex-1">{toast.message}</span>
              <button onClick={() => removeToast(toast.id)} className="hover:bg-white/20 rounded p-0.5" aria-label="Dismiss">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        })}
      </div>
      {confirm && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[100] p-4" onClick={() => handleConfirmResult(false)}>
          <div className="bg-gray-800 rounded-xl shadow-2xl max-w-md w-full p-6 border border-gray-700 animate-[scaleIn_0.2s_ease-out]" onClick={e => e.stopPropagation()} role="alertdialog">
            <h3 id="confirm-title" className="text-lg font-bold mb-2">{confirm.title}</h3>
            <p id="confirm-desc" className="text-gray-300 text-sm mb-6 whitespace-pre-line">{confirm.message}</p>
            <div className="flex gap-3">
              <button onClick={() => handleConfirmResult(false)} className="flex-1 py-2.5 bg-gray-700 hover:bg-gray-600 rounded-lg font-medium text-sm transition-colors">
                {confirm.cancelText || 'Cancel'}
              </button>
              <button onClick={() => handleConfirmResult(true)} autoFocus className={`flex-1 py-2.5 rounded-lg font-medium text-sm transition-colors ${confirm.type === 'danger' ? 'bg-red-600 hover:bg-red-700' : 'bg-green-600 hover:bg-green-700'}`}>
                {confirm.confirmText || 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
      <style>{`
        html { scrollbar-gutter: stable; }
        @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        @keyframes scaleIn { from { transform: scale(0.95); opacity: 0; } to { transform: scale(1); opacity: 1; } }
      `}</style>
    </DialogContext.Provider>
  );
};

class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { hasError: false, error: null }; }
  static getDerivedStateFromError(error) { return { hasError: true, error }; }
  render() {
    if (this.state.hasError) {
      return (
        <div className="bg-red-900/30 border border-red-600/50 rounded-xl p-6 text-center">
          <AlertCircle className="w-10 h-10 text-red-400 mx-auto mb-3" />
          <h3 className="font-bold text-lg mb-2">Something went wrong</h3>
          <p className="text-sm text-gray-400 mb-4">{this.state.error?.message || 'An unexpected error occurred'}</p>
          <button onClick={() => window.location.reload()} className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded-lg text-sm font-medium transition-colors">Reload Page</button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ============================================================================
// VIEWS
// ============================================================================

const StandingsView = ({ teams, settings }) => {
  const sortedTeams = useMemo(() =>
    [...teams].sort((a, b) => b.earnings - a.earnings).map((team, i) => ({ ...team, position: i + 1 })),
    [teams]
  );
  const segmentStandings = useMemo(() =>
    [...teams].sort((a, b) => (b.segmentEarnings || 0) - (a.segmentEarnings || 0)),
    [teams]
  );

  return (
    <div className="space-y-4">
      <div className="bg-gray-800/50 backdrop-blur rounded-xl border border-green-700/30 overflow-hidden">
        <div className="p-4 bg-gradient-to-r from-green-600/20 to-transparent border-b border-green-700/30">
          <h2 className="text-xl font-bold flex items-center gap-2"><Trophy className="w-5 h-5 text-yellow-400" />Overall Standings</h2>
        </div>
        <div>
          <table className="w-full" role="table">
            <thead className="bg-gray-700/50 text-xs sm:text-sm">
              <tr>
                <th className="px-2 sm:px-4 py-2 text-left w-10 sm:w-14" scope="col">Pos</th>
                <th className="px-2 sm:px-4 py-2 text-left" scope="col">Team</th>
                <th className="px-2 sm:px-4 py-2 text-right" scope="col">Season</th>
                <th className="px-2 sm:px-4 py-2 text-right" scope="col">{getSegmentByDate()}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-700/50">
              {sortedTeams.map((team, index) => {
                const segmentPos = segmentStandings.findIndex(t => t.id === team.id) + 1;
                return (
                  <tr key={team.id} className="hover:bg-gray-700/30 transition-colors">
                    <td className="px-2 sm:px-4 py-2">
                      <div className={`w-7 h-7 sm:w-9 sm:h-9 rounded-full flex items-center justify-center font-bold text-xs sm:text-sm ${
                        index === 0 ? 'bg-yellow-500 text-gray-900' : index === 1 ? 'bg-gray-400 text-gray-900' : index === 2 ? 'bg-orange-600 text-white' : 'bg-gray-700 text-gray-300'
                      }`} aria-label={`Position ${team.position}`}>{team.position}</div>
                    </td>
                    <td className="px-2 sm:px-4 py-2">
                      <div className="font-semibold text-sm sm:text-base">{team.name}</div>
                      <div className="text-xs text-gray-400">{team.owner}</div>
                    </td>
                    <td className="px-2 sm:px-4 py-2 text-right">
                      <div className="text-base sm:text-lg font-bold text-green-400" style={{ fontVariantNumeric: 'tabular-nums' }}>${(team.earnings || 0).toLocaleString()}</div>
                    </td>
                    <td className="px-2 sm:px-4 py-2 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <span className="text-xs text-gray-500">#{segmentPos}</span>
                        <span className="text-xs sm:text-sm text-gray-400" style={{ fontVariantNumeric: 'tabular-nums' }}>${(team.segmentEarnings || 0).toLocaleString()}</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

const ResultsView = ({ teams, tournaments, headshots }) => {
  const [expandedTournament, setExpandedTournament] = useState(null);
  const completedTournaments = useMemo(() => [...tournaments.filter(t => t.completed)].reverse(), [tournaments]);
  const inProgressTournaments = useMemo(() => tournaments.filter(t => t.playing && !t.completed && isTournamentLocked(t)), [tournaments]);
  const hasContent = completedTournaments.length > 0 || inProgressTournaments.length > 0;

  return (
    <div className="space-y-3">
      {!hasContent ? (
        <div className="bg-gray-800/50 backdrop-blur rounded-xl border border-green-700/30 p-8 text-center">
          <Calendar className="w-16 h-16 text-gray-600 mx-auto mb-4" />
          <h3 className="text-xl font-bold text-gray-400 mb-2">No Completed Tournaments Yet</h3>
          <p className="text-gray-500">Tournament results will appear here after processing</p>
        </div>
      ) : (
        <>
          {inProgressTournaments.map((tournament) => {
            const isExpanded = expandedTournament === tournament.name;
            const teamsWithLineups = teams.filter(t => t.lineup?.length > 0).sort((a, b) => a.name.localeCompare(b.name));
            return (
              <div key={tournament.name} className="bg-gray-800/50 backdrop-blur rounded-xl border border-green-500/40 overflow-hidden shadow-lg shadow-green-900/20">
                <button onClick={() => setExpandedTournament(isExpanded ? null : tournament.name)} className="w-full px-4 py-3 bg-gradient-to-r from-green-600/20 to-transparent border-b border-green-600/30 flex items-center justify-between hover:bg-green-600/10 transition-colors" aria-expanded={isExpanded}>
                  <div className="flex items-center gap-3">
                    <div className="relative">
                      <Clock className="w-4 h-4 text-green-400 flex-shrink-0" />
                      <span className="absolute -top-1 -right-1 w-2 h-2 bg-green-400 rounded-full animate-pulse" />
                    </div>
                    <div className="text-left">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-bold text-green-300">{tournament.name}</h3>
                        <span className="px-1.5 py-0.5 bg-green-600/30 text-green-300 text-xs rounded font-semibold border border-green-500/40">In Progress</span>
                        {tournament.isMajor && <span className="px-1.5 py-0.5 bg-yellow-600 text-white text-xs rounded font-bold">M</span>}
                        {tournament.isSignature && !tournament.isMajor && <span className="px-1.5 py-0.5 bg-purple-600 text-white text-xs rounded">S</span>}
                      </div>
                      <p className="text-xs text-gray-400">{tournament.dates} · {tournament.location}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {!isExpanded && teamsWithLineups.length > 0 && (
                      <div className="text-right hidden sm:block">
                        <div className="text-xs text-gray-500">{teamsWithLineups.length} lineup{teamsWithLineups.length !== 1 ? 's' : ''} set</div>
                      </div>
                    )}
                    {isExpanded ? <ChevronDown className="w-4 h-4 text-green-400" /> : <ChevronRight className="w-4 h-4 text-green-400" />}
                  </div>
                </button>
                {isExpanded && (
                  <div className="divide-y divide-gray-700/40">
                    {teamsWithLineups.length === 0 ? (
                      <div className="px-4 py-4 text-center text-gray-500 text-sm">No teams have submitted lineups yet</div>
                    ) : (
                      teamsWithLineups.map((team) => {
                        const lineupPlayers = team.lineup.map(name => team.roster.find(p => p.name === name) || { name, limited: false });
                        const sortedLineup = getSortedRoster(lineupPlayers);
                        const slots = [0,1,2,3,4].map(i => sortedLineup[i] || null);
                        return (
                          <div key={team.id} className="px-4 py-2">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-xs font-bold w-5 text-center text-gray-500">—</span>
                              <span className="font-semibold text-sm">{team.name}</span>
                              <span className="text-green-400/50 text-xs italic">pending</span>
                            </div>
                            <div className="ml-7 grid grid-cols-5 gap-1">
                              {slots.map((p, pidx) => (
                                <div key={pidx} className="text-xs min-w-0 truncate">
                                  {p ? (
                                    <><span className={p.limited ? 'text-yellow-400/60' : 'text-gray-400'}>{shortName(p.name)}</span><br /><span className="text-gray-600">—</span></>
                                  ) : <span className="text-gray-700">—</span>}
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {completedTournaments.map((tournament) => {
            const isExpanded = expandedTournament === tournament.name;
            const results = tournament.results;
            const rankedTeams = teams.map(t => ({ ...t, result: results?.teams?.[t.id] })).filter(t => t.result).sort((a, b) => (b.result.totalEarnings || 0) - (a.result.totalEarnings || 0));
            return (
              <div key={tournament.name} className="bg-gray-800/50 backdrop-blur rounded-xl border border-purple-700/30 overflow-hidden">
                <button onClick={() => setExpandedTournament(isExpanded ? null : tournament.name)} className="w-full px-4 py-3 bg-gradient-to-r from-purple-600/20 to-transparent border-b border-purple-700/30 flex items-center justify-between hover:bg-purple-600/10 transition-colors" aria-expanded={isExpanded}>
                  <div className="flex items-center gap-3">
                    <Calendar className="w-4 h-4 text-purple-400 flex-shrink-0" />
                    <div className="text-left">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-bold">{tournament.name}</h3>
                        {tournament.isMajor && <span className="px-1.5 py-0.5 bg-yellow-600 text-white text-xs rounded font-bold">M</span>}
                        {tournament.isSignature && !tournament.isMajor && <span className="px-1.5 py-0.5 bg-purple-600 text-white text-xs rounded">S</span>}
                      </div>
                      <p className="text-xs text-gray-400">{tournament.dates} · {tournament.location}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {!isExpanded && rankedTeams.length > 0 && (
                      <div className="text-right hidden sm:block">
                        <div className="text-xs text-gray-500">Winner</div>
                        <div className="text-sm font-semibold text-green-400">{rankedTeams[0].name}</div>
                      </div>
                    )}
                    {isExpanded ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
                  </div>
                </button>
                {isExpanded && results && (
                  <div className="divide-y divide-gray-700/40">
                    {rankedTeams.map((team, rank) => {
                      const tr = team.result;
                      const players = tr.players || [];
                      const sortedPlayers = getSortedRoster(players);
                      const slots = [0,1,2,3,4].map(i => sortedPlayers[i] || null);
                      return (
                        <div key={team.id} className={'px-4 py-2 ' + (rank === 0 ? 'bg-green-600/5' : '')}>
                          <div className="flex items-center gap-2 mb-1">
                            <span className={'text-xs font-bold w-5 text-center ' + (rank === 0 ? 'text-yellow-400' : 'text-gray-500')}>{rank + 1}</span>
                            <span className="font-semibold text-sm">{team.name}</span>
                            <span className="text-green-400 font-bold text-sm">${(tr.totalEarnings || 0).toLocaleString()}</span>
                          </div>
                          <div className="ml-7 grid grid-cols-5 gap-1">
                            {slots.map((p, pidx) => (
                              <div key={pidx} className="text-xs min-w-0 truncate">
                                {p ? (
                                  <>
                                    <span className={p.limited ? (p.earnings > 0 ? 'text-yellow-400' : 'text-yellow-300/40') : (p.earnings > 0 ? 'text-gray-300' : 'text-gray-500')}>{shortName(p.name)}</span>
                                    {p.roundsLed?.map((rl, ri) => <span key={ri} className="ml-0.5 px-1 bg-blue-600/60 text-blue-200 rounded">R{rl.round}</span>)}
                                    <br />
                                    <span className={p.earnings > 0 ? 'text-green-400' : 'text-gray-500'}>${(p.earnings || 0).toLocaleString()}</span>
                                    {p.bonus > 0 && <span className="text-blue-300 ml-0.5">+{p.bonus.toLocaleString()}</span>}
                                  </>
                                ) : <span className="text-gray-700">—</span>}
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
};

const RostersView = ({ teams, selectedTeam, setSelectedTeam, updateTeams, tournaments, allPlayers, transactions, setTransactions, settings, loggedInUser, isCommissioner, globalPlayerStats, headshots }) => {
  const [lineupMode, setLineupMode] = useState(false);
  const [showAddDropModal, setShowAddDropModal] = useState(false);
  const [isWaiverMode, setIsWaiverMode] = useState(false);
  const [editingWaiverData, setEditingWaiverData] = useState(null);
  const [showMulliganModal, setShowMulliganModal] = useState(false);
  const [globalSearch, setGlobalSearch] = useState('');
  const dialog = useDialog();

  useEffect(() => {
    if (!selectedTeam && teams.length > 0) {
      if (loggedInUser) {
        const userTeam = teams.find(t => t.owner === loggedInUser);
        if (userTeam) { setSelectedTeam(userTeam.id); return; }
      }
      setSelectedTeam(teams[0].id);
    }
  }, [selectedTeam, teams, setSelectedTeam, loggedInUser]);

  const team = teams.find(t => t.id === selectedTeam);
  const activeTournament = tournaments.find(t => t.playing);
  const activeTournamentIndex = activeTournament ? tournaments.findIndex(t => t.name === activeTournament.name) : -1;

  const currentRoster = useMemo(() => {
    if (!team) return [];
    let roster = [...team.roster];
    if (activeTournamentIndex >= 0) {
      const teamTx = transactions
        .filter(tx => tx.team === team.name && tx.type !== 'mulligan' && tx.tournamentIndex !== undefined && tx.tournamentIndex <= activeTournamentIndex && tx.status !== 'pending')
        .sort((a, b) => a.tournamentIndex - b.tournamentIndex);
      teamTx.forEach(tx => {
        if (tx.droppedPlayer) roster = roster.filter(p => p.name !== tx.droppedPlayer);
        if (!roster.some(p => p.name === tx.player)) roster.push(makePlayer(tx.player));
      });
    }
    return roster;
  }, [team, transactions, activeTournamentIndex]);

  const searchResults = useMemo(() => {
    if (!globalSearch.trim()) return [];
    const term = globalSearch.toLowerCase();
    
    const allPlayerMap = new Map();
    allPlayers.forEach(p => allPlayerMap.set(p.name, { ...p, owner: 'Free Agent' }));
    
    teams.forEach(t => {
       t.roster.forEach(rp => {
           if (allPlayerMap.has(rp.name)) {
               allPlayerMap.get(rp.name).owner = t.name;
           } else {
               allPlayerMap.set(rp.name, { name: rp.name, worldRank: 999, owner: t.name });
           }
       });
    });

    return Array.from(allPlayerMap.values())
       .filter(p => p.name.toLowerCase().includes(term))
       .sort((a, b) => a.worldRank - b.worldRank);
  }, [globalSearch, allPlayers, teams]);

  const togglePlayerInLineup = useCallback(async (player) => {
    if (!team) return;
    const isInLineup = team.lineup.includes(player.name);
    if (!isInLineup && team.lineup.length >= 5) { dialog.showToast('You can only have 5 starters', 'error'); return; }
    if (!isInLineup && player.limited && player.starts >= 12) { dialog.showToast('This player has reached their 12-start limit', 'error'); return; }
    const newTeams = teams.map(t => {
      if (t.id !== team.id) return t;
      const newLineup = isInLineup ? t.lineup.filter(p => p !== player.name) : [...t.lineup, player.name];
      return { ...t, lineup: newLineup };
    });
    updateTeams(newTeams);
  }, [team, teams, updateTeams, dialog]);

  const handleUndoMulligan = async (tx) => {
    const ok = await dialog.showConfirm(
      'Undo Mulligan',
      `Are you sure you want to undo your mulligan?\n\nThis will restore ${tx.droppedPlayer} to your lineup and return ${tx.player} to the bench. Your mulligan count will be restored.`,
      { confirmText: 'Undo Mulligan' }
    );
    if (!ok) return;

    const newLineup = team.lineup.map(p => p === tx.player ? tx.droppedPlayer : p);

    const updatedRoster = team.roster.map(p => {
      if (p.name === tx.player && p.limited) return { ...p, starts: Math.max(0, p.starts - 1) };
      if (p.name === tx.droppedPlayer && p.limited) return { ...p, starts: p.starts + 1 };
      return p;
    });

    const mulliganKey = tx.mulliganType === 'signature/major' ? 'signatureMajor' : 'regular';
    const newMulligans = { ...team.mulligans, [mulliganKey]: (team.mulligans[mulliganKey] || 0) + 1 };

    const updatedTeams = teams.map(t => t.id === team.id ? { ...t, lineup: newLineup, roster: updatedRoster, mulligans: newMulligans } : t);
    updateTeams(updatedTeams);

    const txIndex = transactions.findIndex(t => t === tx);
    setTransactions(prev => prev.filter((_, i) => i !== txIndex));

    dialog.showToast('Mulligan successfully undone', 'success');
  };

  const isOwnTeam = (loggedInUser && team && team.owner === loggedInUser) || isCommissioner;

  return (
    <div className="space-y-4">
      {team && (
        <>
          <div className="bg-gradient-to-r from-green-600/20 to-gray-800/50 backdrop-blur rounded-xl border border-green-700/30 p-2">
            <div className="flex items-center justify-between mb-2 gap-2">
              <div className="flex items-center gap-1 flex-1 min-w-0">
                <select value={selectedTeam || ''} onChange={(e) => { setSelectedTeam(e.target.value); setLineupMode(false); }} className="bg-gray-800 text-base font-bold border border-gray-600 rounded-lg outline-none cursor-pointer px-2 py-1 pr-7 max-w-[140px] sm:max-w-[200px] truncate hover:border-green-50 transition-colors">
                  {teams.map(t => <option key={t.id} value={t.id} className="bg-gray-800">{t.name}</option>)}
                </select>
                {loggedInUser && !isOwnTeam && <span className="px-1.5 py-0.5 bg-gray-600 text-gray-300 rounded text-[10px] whitespace-nowrap">View Only</span>}
              </div>
              <div className="relative flex-shrink-0 w-36 sm:w-48">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                <input type="text" placeholder="Search player..." value={globalSearch} onChange={e => setGlobalSearch(e.target.value)} className="w-full bg-gray-900 border border-gray-600 rounded-lg pl-8 pr-2 py-1.5 text-xs text-white focus:outline-none focus:border-green-50 transition-colors" />
              </div>
            </div>
            {team.lineup.length > 0 ? (
              <div className="flex justify-center gap-4 sm:gap-6 pt-2 border-t border-gray-700/50">
                {getSortedRoster(currentRoster).filter(p => team.lineup.includes(p.name)).map(player => {
                    const lastName = player.name.split(' ').pop();
                    const nameClass = lastName.length > 9 ? 'text-[9px]' : lastName.length > 7 ? 'text-[10px]' : 'text-xs';
                    return (
                    <div key={player.name} className="flex flex-col items-center w-[52px] sm:w-[72px]">
                      <img src={getPlayerHeadshot(player.name, player.limited, headshots)} onError={(e) => { e.target.onerror=null; e.target.src=getPlayerHeadshotFallback(player.name, player.limited); }} alt="" className={'w-10 h-10 sm:w-12 sm:h-12 flex-shrink-0 rounded-full object-cover border-2 ' + (player.limited ? 'border-yellow-500' : player.unlimited ? 'border-blue-500' : 'border-green-500')} />
                      <div className={nameClass + ' font-medium mt-0.5 text-center w-full h-4 flex items-center justify-center truncate ' + (player.limited ? 'text-yellow-400' : player.unlimited ? 'text-blue-400' : '')}>{lastName}</div>
                    </div>
                    );
                })}
              </div>
            ) : (
              <div className="text-gray-500 text-xs text-center pt-2 border-t border-gray-700/50">No lineup set</div>
            )}
          </div>

          {(() => {
            const pendingWaivers = transactions.map((t, idx) => ({ ...t, _txIdx: idx })).filter(t => t.team === team.name && t.type === 'waiver' && t.status === 'pending').sort((a, b) => (a.priority || 999) - (b.priority || 999));
            if (pendingWaivers.length === 0) return null;
            const swapPriority = (fromIdx, toIdx) => {
              if (toIdx < 0 || toIdx >= pendingWaivers.length) return;
              const updated = [...transactions];
              const fromTxIdx = pendingWaivers[fromIdx]._txIdx;
              const toTxIdx = pendingWaivers[toIdx]._txIdx;
              const fromPriority = pendingWaivers[fromIdx].priority || fromIdx + 1;
              const toPriority = pendingWaivers[toIdx].priority || toIdx + 1;
              updated[fromTxIdx] = { ...updated[fromTxIdx], priority: toPriority };
              updated[toTxIdx] = { ...updated[toTxIdx], priority: fromPriority };
              setTransactions(updated);
            };
            return (
              <div className="bg-yellow-600/20 border border-yellow-600/50 rounded-xl p-3">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-bold text-yellow-300 text-sm flex items-center gap-2">⏰ Pending Waiver Claims ({pendingWaivers.length})</h3>
                  <div className="text-xs text-yellow-300">Processed Tue 8pm ET</div>
                </div>
                {pendingWaivers.length > 1 && isOwnTeam && <div className="text-xs text-gray-400 mb-2">↕ Use arrows to set priority order — #1 processes first</div>}
                <div className="space-y-2">
                  {pendingWaivers.map((waiver, index) => {
                    const transactionIndex = waiver._txIdx;
                    return (
                      <div key={transactionIndex} className="bg-gray-800/50 rounded-lg p-2 flex items-center gap-2">
                        {isOwnTeam && pendingWaivers.length > 1 && (
                          <div className="flex flex-col gap-0.5">
                            <button onClick={() => swapPriority(index, index - 1)} disabled={index === 0} className={`text-xs px-1 rounded ${index === 0 ? 'text-gray-600 cursor-not-allowed' : 'text-yellow-400 hover:bg-yellow-600/20'}`}>▲</button>
                            <div className="text-[10px] text-yellow-400 font-bold text-center">{index + 1}</div>
                            <button onClick={() => swapPriority(index, index + 1)} disabled={index === pendingWaivers.length - 1} className={`text-xs px-1 rounded ${index === pendingWaivers.length - 1 ? 'text-gray-600 cursor-not-allowed' : 'text-yellow-400 hover:bg-yellow-600/20'}`}>▼</button>
                          </div>
                        )}
                        <div className="flex-1 text-sm">
                          <span className="text-green-400 font-medium">Add: {waiver.player}</span>
                          {waiver.droppedPlayer && <><span className="text-gray-500 mx-1">→</span><span className="text-red-400">Drop: {waiver.droppedPlayer}</span></>}
                          <div className="text-xs text-gray-400 mt-0.5">${waiver.fee} fee • {waiver.segment || 'Current Swing'}</div>
                        </div>
                        {isOwnTeam && <div className="flex gap-1">
                          <button onClick={() => {
                              const updatedTransactions = transactions.filter((_, i) => i !== transactionIndex);
                              setTransactions(updatedTransactions);
                              const updatedTeams = teams.map(t => t.id === team.id ? { ...t, transactionFees: (t.transactionFees || 0) - waiver.fee } : t);
                              updateTeams(updatedTeams);
                              setEditingWaiverData({ player: waiver.player, droppedPlayer: waiver.droppedPlayer });
                              setIsWaiverMode(true);
                              setShowAddDropModal(true);
                            }} className="px-2 py-1 bg-blue-600 hover:bg-blue-700 rounded text-xs font-medium">✏️ Edit</button>
                          <button onClick={async () => {
                              const ok = await dialog.showConfirm('Delete Waiver', `Delete waiver claim for ${waiver.player}?`, { type: 'danger', confirmText: 'Delete' });
                              if (!ok) return;
                              const updatedTransactions = transactions.filter((_, i) => i !== transactionIndex);
                              setTransactions(updatedTransactions);
                              const updatedTeams = teams.map(t => t.id === team.id ? { ...t, transactionFees: (t.transactionFees || 0) - waiver.fee } : t);
                              updateTeams(updatedTeams);
                            }} className="px-2 py-1 bg-red-600 hover:bg-red-700 rounded text-xs font-medium">✕</button>
                        </div>}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          <div className="bg-gray-800/50 backdrop-blur rounded-xl border border-green-700/30 overflow-hidden">
            <div className="p-2 bg-gradient-to-r from-green-600/20 to-transparent border-b border-green-700/30">
              {activeTournament && (
                <div className="mb-2 px-1 truncate">
                  <span className="text-blue-300 font-semibold text-sm">{activeTournament.name}</span>
                  <span className="text-gray-400 text-xs ml-2">• {activeTournament.dates}</span>
                </div>
              )}
              <div className="grid grid-cols-4 gap-1.5 sm:gap-2">
                {/* Lineup */}
                {(() => {
                  const lineupOpen = isLineupEditingOpen(activeTournament);
                  const commishOverride = isCommissioner && !lineupOpen;
                  const canEdit = isOwnTeam && (lineupOpen || isCommissioner);
                  const status = getLineupStatus(activeTournament);
                  return <div className="flex flex-col items-center gap-1">
                    <button onClick={() => { if (lineupMode && team.lineup.length === 0) return; setLineupMode(!lineupMode); }} disabled={!canEdit || (lineupMode && team.lineup.length === 0)} className={`w-full h-14 flex flex-col items-center justify-center px-1 rounded-lg font-medium transition-all text-[11px] sm:text-xs text-center leading-none sm:leading-tight ${!canEdit ? 'bg-gray-800 text-gray-500 border border-gray-700 cursor-not-allowed' : lineupMode ? (team.lineup.length > 0 ? 'bg-green-600 text-white border border-green-500 hover:bg-green-700 shadow-md shadow-green-600/30' : 'bg-gray-800 text-gray-500 border border-gray-700 cursor-not-allowed') : commishOverride ? 'bg-gray-800 text-red-400 border border-red-600/40 hover:bg-red-600/10' : 'bg-gray-800 text-blue-400 border border-blue-600/40 hover:bg-blue-600/10'}`}>
                      <span>{lineupMode ? '✓ Save' : 'Lineup'}</span>
                      {!lineupMode && <span className="mt-0.5">{commishOverride ? '🔓' : isTournamentLocked(activeTournament) ? '🔒' : '✏️'}</span>}
                    </button>
                    <span className={`text-[9px] leading-tight text-center ${status.open ? 'text-blue-400' : 'text-gray-500'}`}>{status.label}</span>
                  </div>;
                })()}
                {/* Free Agent */}
                {(() => {
                  const faOpen = isFreeAgentWindowOpen(activeTournament);
                  const status = getFreeAgentWindowStatus(activeTournament);
                  return <div className="flex flex-col items-center gap-1">
                    <button onClick={() => { setIsWaiverMode(false); setShowAddDropModal(true); }} disabled={!isOwnTeam || !faOpen} className={`w-full h-14 flex flex-col items-center justify-center px-1 rounded-lg font-medium transition-colors text-[11px] sm:text-xs text-center leading-none sm:leading-tight ${isOwnTeam && faOpen ? 'bg-gray-800 text-green-400 border border-green-600/40 hover:bg-green-600/10' : 'bg-gray-800 text-gray-500 border border-gray-700 cursor-not-allowed'}`}>
                      <span>Free Agent</span>
                      <span className="mt-0.5">🏌️</span>
                    </button>
                    <span className={`text-[9px] leading-tight text-center ${status.open ? 'text-green-400' : 'text-gray-500'}`}>{status.open ? `🟢 ${status.label}` : `🔴 ${status.label}`}</span>
                  </div>;
                })()}
                {/* Waiver */}
                {(() => {
                  const wOpen = isWaiverWindowOpen();
                  return <div className="flex flex-col items-center gap-1">
                    <button onClick={() => { setIsWaiverMode(true); setShowAddDropModal(true); }} disabled={!isOwnTeam || !wOpen} className={`w-full h-14 flex flex-col items-center justify-center px-1 rounded-lg font-medium transition-colors text-[11px] sm:text-xs text-center leading-none sm:leading-tight ${isOwnTeam && wOpen ? 'bg-gray-800 text-yellow-400 border border-yellow-600/40 hover:bg-yellow-600/10' : 'bg-gray-800 text-gray-500 border border-gray-700 cursor-not-allowed'}`}>
                      <span>Waiver</span>
                      <span className="mt-0.5">⏰</span>
                    </button>
                    <span className={`text-[9px] leading-tight text-center ${wOpen ? 'text-yellow-400' : 'text-gray-500'}`}>{wOpen ? '🟢 until Tue 7:59pm' : '🔴 until Sun 9pm'}</span>
                  </div>;
                })()}
                {/* Mulligan */}
                {(() => {
                  const canMulligan = isOwnTeam && activeTournament && team.lineup.length > 0;
                  const isSignatureOrMajor = activeTournament?.isSignature || activeTournament?.isMajor;
                  const mulliganKey = isSignatureOrMajor ? 'signatureMajor' : 'regular';
                  const remaining = team.mulligans?.[mulliganKey] || 0;
                  const etDay = getETNow().getDay();
                  const isMulliganDay = etDay >= 4 && etDay <= 6;
                  
                  // Handle Undo Mulligan Check
                  const activeMulliganTx = activeTournamentIndex >= 0 ? transactions.find(tx => tx.type === 'mulligan' && tx.team === team.name && tx.tournamentIndex === activeTournamentIndex) : null;
                  const canUndo = activeMulliganTx && !isPastRoundStart(activeMulliganTx.afterRound + 1);

                  let statusText, statusColor, btnLabel, btnIcon, btnAction, isDisabled;

                  if (activeMulliganTx) {
                    btnLabel = 'Undo Mull.'; btnIcon = '↩️';
                    if (canUndo) {
                      statusText = `🟢 Undo available`; statusColor = 'text-blue-400'; btnAction = () => handleUndoMulligan(activeMulliganTx); isDisabled = false;
                    } else {
                      statusText = `🔴 Locked`; statusColor = 'text-gray-500'; isDisabled = true;
                    }
                  } else {
                    btnLabel = 'Mulligan'; btnIcon = '🚨';
                    btnAction = () => setShowMulliganModal(true);
                    if (remaining === 0) { statusText = `🔴 ${isSignatureOrMajor ? 'Signature' : 'Regular'} used`; statusColor = 'text-gray-500'; isDisabled = true; }
                    else if (!isMulliganDay) { statusText = '🔴 Thu–Sat only'; statusColor = 'text-gray-500'; isDisabled = true; }
                    else if (!canMulligan) { statusText = '🔴 Unavailable'; statusColor = 'text-gray-500'; isDisabled = true; }
                    else { statusText = `🟢 ${isSignatureOrMajor ? 'Signature' : 'Regular'}`; statusColor = 'text-gray-300'; isDisabled = false; }
                  }

                  return (
                    <div className="flex flex-col items-center gap-1">
                      <button onClick={btnAction} disabled={isDisabled} className={`w-full h-14 flex flex-col items-center justify-center px-1 rounded-lg font-medium transition-colors text-[11px] sm:text-xs text-center leading-none sm:leading-tight ${!isDisabled ? (activeMulliganTx ? 'bg-gray-800 text-blue-400 border border-blue-500/40 hover:bg-blue-600/10' : 'bg-gray-800 text-gray-300 border border-gray-500/40 hover:bg-gray-600/10') : 'bg-gray-800 text-gray-500 border border-gray-700 cursor-not-allowed'}`}>
                        <span>{btnLabel}</span>
                        <span className="mt-0.5">{btnIcon}</span>
                      </button>
                      <span className={`text-[9px] leading-tight text-center ${statusColor}`}>{statusText}</span>
                    </div>
                  );
                })()}
              </div>
            </div>

            {/* CONDITIONAL TABLE: SEARCH OR ROSTER */}
            {globalSearch.trim().length > 0 ? (
              <div>
                <div className="px-2 py-1.5 bg-gray-700/50 text-xs font-bold text-gray-400 border-b border-gray-700">
                  Global Search Results ({searchResults.length})
                </div>
                <table className="w-full text-sm" role="table">
                  <thead className="bg-gray-700/50 sticky top-0">
                    <tr>
                      <th className="px-2 py-1.5 text-left text-xs" scope="col">Player</th>
                      <th className="px-2 py-1.5 text-center hidden sm:table-cell text-xs" scope="col">Events</th>
                      <th className="px-2 py-1.5 text-center hidden sm:table-cell text-xs" scope="col">Cuts</th>
                      <th className="px-2 py-1.5 text-right text-xs" scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-700/50">
                    {searchResults.slice(0, 50).map((player) => (
                      <tr key={player.name} className="hover:bg-gray-700/30 transition-colors">
                        <td className="px-2 py-1.5">
                          <div className="flex items-center gap-2">
                            <img src={getPlayerHeadshot(player.name, player.limited, headshots)} onError={(e) => { e.target.onerror=null; e.target.src=getPlayerHeadshotFallback(player.name, player.limited); }} alt="" className={`w-8 h-8 flex-shrink-0 rounded-full object-cover border border-gray-600`} />
                            <div className="min-w-0">
                              <div className="font-semibold text-xs text-gray-300">{player.name}</div>
                              <div className="text-[10px] text-gray-500">#{player.worldRank === 999 ? 'NR' : player.worldRank}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-2 py-1.5 text-center hidden sm:table-cell text-xs text-gray-300">{globalPlayerStats[player.name]?.eventsPlayed || 0}</td>
                        <td className="px-2 py-1.5 text-center hidden sm:table-cell text-xs text-gray-300">{globalPlayerStats[player.name]?.cutsMade || 0}</td>
                        <td className="px-2 py-1.5 text-right text-xs">
                          {player.owner === 'Free Agent' ? (
                            <span className="text-green-400 font-medium">Free Agent</span>
                          ) : (
                            <span className="text-gray-400 font-medium">{getTeamAbbreviation(player.owner)}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                    {searchResults.length === 0 && (
                      <tr><td colSpan="4" className="text-center py-6 text-gray-500 text-xs">No matching players found</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            ) : (
              <div>
                <table className="w-full text-sm" role="table">
                  <thead className="bg-gray-700/50 sticky top-0">
                    <tr>
                      <th className="px-2 py-1.5 text-left text-xs" scope="col">Player</th>
                      <th className="px-2 py-1.5 text-center hidden sm:table-cell text-xs" scope="col">Events</th>
                      <th className="px-2 py-1.5 text-center hidden sm:table-cell text-xs" scope="col">Cuts</th>
                      <th className="px-2 py-1.5 text-right hidden md:table-cell text-xs" scope="col">PGA $</th>
                      <th className="px-2 py-1.5 text-right text-xs" scope="col">SFGL $</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-700/50">
                    {getSortedRoster(currentRoster).map((player) => {
                      const isInLineup = team.lineup.includes(player.name);
                      const canAddToLineup = team.lineup.length < 5 && (!player.limited || player.starts < 12);
                      const hasLineup = team.lineup.length > 0;
                      const isBenched = hasLineup && !isInLineup && !lineupMode;
                      return (
                        <tr key={player.name} className={'transition-colors ' + (isBenched ? '' : 'hover:bg-gray-700/30')}>
                          <td className="px-2 py-1.5">
                            <div className="flex items-center gap-2">
                              <button onClick={() => lineupMode && isOwnTeam && (isInLineup || canAddToLineup) && togglePlayerInLineup(player)} className={`relative ${lineupMode && isOwnTeam && (isInLineup || canAddToLineup) ? 'cursor-pointer' : 'cursor-default'}`} disabled={!lineupMode || !isOwnTeam || (!isInLineup && !canAddToLineup)}>
                                <img src={getPlayerHeadshot(player.name, player.limited, headshots)} onError={(e) => { e.target.onerror=null; e.target.src=getPlayerHeadshotFallback(player.name, player.limited); }} alt="" className={`w-8 h-8 flex-shrink-0 rounded-full object-cover transition-all ${lineupMode ? isInLineup ? ('border-4 opacity-100 ' + (player.limited ? 'border-yellow-500' : player.unlimited ? 'border-blue-500' : 'border-green-500')) : canAddToLineup ? 'border-2 border-gray-400 opacity-60 hover:opacity-100 hover:border-green-300' : 'border border-gray-600 opacity-40' : isBenched ? 'border border-gray-600 opacity-40' : isInLineup ? ('border-2 ' + (player.limited ? 'border-yellow-500' : player.unlimited ? 'border-blue-500' : 'border-green-500')) : ('border ' + (player.limited ? 'border-yellow-500' : player.unlimited ? 'border-blue-500' : 'border-gray-600'))}`} />
                                {lineupMode && isInLineup && <div className={'absolute -top-1 -right-1 w-4 h-4 rounded-full flex items-center justify-center ' + (player.limited ? 'bg-yellow-500' : player.unlimited ? 'bg-blue-500' : 'bg-green-500')}><span className="text-white text-xs font-bold">✓</span></div>}
                              </button>
                              <div className="min-w-0">
                                <div className={'font-semibold flex items-center gap-1 flex-wrap text-xs ' + (isBenched ? 'text-gray-500' : player.limited ? 'text-yellow-400' : player.unlimited ? 'text-blue-400' : '')}>
                                  {player.name}
                                  {player.limited && <span className={isBenched ? 'text-gray-500 text-xs' : 'text-yellow-400 text-xs'}>{'⭐'.repeat(player.stars || 1)}</span>}
                                  {player.unlimited && <span className={isBenched ? 'text-gray-500 text-xs' : 'text-blue-400 text-xs'}>♾️</span>}
                                </div>
                                <div className={'text-[10px] ' + (isBenched ? 'text-gray-600' : 'text-gray-400')}>
                                  {player.limited && <span className={isBenched ? 'text-gray-500' : 'text-yellow-400'}>{player.starts}/12 starts</span>}
                                  {player.yearsOfService > 1 && <span className="ml-1">(Yr {player.yearsOfService})</span>}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className={'px-2 py-1.5 text-center hidden sm:table-cell text-xs ' + (isBenched ? 'text-gray-500' : 'text-gray-300')}>{globalPlayerStats[player.name]?.eventsPlayed || 0}</td>
                          <td className={'px-2 py-1.5 text-center hidden sm:table-cell text-xs ' + (isBenched ? 'text-gray-500' : 'text-gray-300')}>{globalPlayerStats[player.name]?.cutsMade || 0}</td>
                          <td className={'px-2 py-1.5 text-right hidden md:table-cell text-xs ' + (isBenched ? 'text-gray-500' : 'text-gray-300')}>${(globalPlayerStats[player.name]?.pgaTourEarnings || 0).toLocaleString()}</td>
                          <td className={'px-2 py-1.5 text-right font-medium text-xs ' + (isBenched ? 'text-gray-500' : 'text-green-400')}>${(player.sfglEarnings || 0).toLocaleString()}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {showMulliganModal && activeTournament && (() => {
            const isSignatureOrMajor = activeTournament.isSignature || activeTournament.isMajor;
            const mulliganKey = isSignatureOrMajor ? 'signatureMajor' : 'regular';
            const remaining = team.mulligans?.[mulliganKey] || 0;
            const benchPlayers = currentRoster.filter(p => !team.lineup.includes(p.name));
            const lineupPlayers = currentRoster.filter(p => team.lineup.includes(p.name));

            const MulliganModalInner = () => {
              const [playerOut, setPlayerOut] = useState('');
              const [playerIn, setPlayerIn] = useState('');
              const [afterRound, setAfterRound] = useState('2');

              const handleConfirmMulligan = async () => {
                if (!playerOut || !playerIn) return;
                const ok = await dialog.showConfirm('Use Mulligan', 'Swap ' + playerOut + ' OUT → ' + playerIn + ' IN for ' + activeTournament.name + ' (after Round ' + afterRound + ')?', { confirmText: 'Use Mulligan' });
                if (!ok) return;

                const newLineup = team.lineup.map(p => p === playerOut ? playerIn : p);
                const updatedRoster = team.roster.map(p => {
                  if (p.name === playerOut && p.limited) return { ...p, starts: Math.max(0, p.starts - 1) };
                  if (p.name === playerIn && p.limited) return { ...p, starts: p.starts + 1 };
                  return p;
                });
                const newMulligans = { ...team.mulligans, [mulliganKey]: remaining - 1 };
                const updatedTeams = teams.map(t => t.id === team.id ? { ...t, lineup: newLineup, roster: updatedRoster, mulligans: newMulligans } : t);
                updateTeams(updatedTeams);

                const mulliganTx = {
                  team: team.name, type: 'mulligan', player: playerIn, droppedPlayer: playerOut, fee: 0,
                  segment: settings.currentSegment || '', date: new Date().toLocaleDateString(),
                  tournamentIndex: activeTournamentIndex, status: 'completed',
                  mulliganType: isSignatureOrMajor ? 'signature/major' : 'regular',
                  afterRound: parseInt(afterRound), tournament: activeTournament.name
                };
                setTransactions(prev => [...prev, mulliganTx]);
                setShowMulliganModal(false);
                dialog.showToast('Mulligan used: ' + playerOut + ' → ' + playerIn, 'success');
              };

              return (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowMulliganModal(false)}>
                  <div className="bg-gray-800 rounded-xl border border-gray-500/50 max-w-md w-full shadow-2xl" onClick={e => e.stopPropagation()}>
                    <div className="p-4 border-b border-gray-700">
                      <h2 className="text-lg font-bold">🚨 Use Mulligan</h2>
                    </div>
                    <div className="p-4 space-y-4">
                      <div>
                        <label className="text-xs font-semibold text-red-300 block mb-1">Player OUT</label>
                        <select value={playerOut} onChange={e => setPlayerOut(e.target.value)} className="w-full px-3 py-2 bg-gray-700 rounded-lg text-sm">
                          <option value="">Select...</option>
                          {lineupPlayers.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="text-xs font-semibold text-green-300 block mb-1">Player IN</label>
                        <select value={playerIn} onChange={e => setPlayerIn(e.target.value)} className="w-full px-3 py-2 bg-gray-700 rounded-lg text-sm">
                          <option value="">Select...</option>
                          {benchPlayers.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="text-xs font-semibold text-gray-300 block mb-1">Takes effect after...</label>
                        <div className="flex gap-2">
                          {['1', '2', '3'].map(r => (
                            <button key={r} onClick={() => setAfterRound(r)} className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-all ${afterRound === r ? 'bg-purple-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600 border border-gray-600'}`}>
                              Round {r}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                    <div className="p-4 border-t border-gray-700 flex gap-2">
                      <button onClick={() => setShowMulliganModal(false)} className="flex-1 py-2 bg-gray-700 rounded-lg">Cancel</button>
                      <button onClick={handleConfirmMulligan} disabled={!playerOut || !playerIn} className="flex-1 py-2 bg-purple-600 rounded-lg">Confirm</button>
                    </div>
                  </div>
                </div>
              );
            };
            return <MulliganModalInner />;
          })()}

          <AddDropPlayerModal isOpen={showAddDropModal} onClose={() => { setShowAddDropModal(false); setEditingWaiverData(null); }} team={team} currentRoster={currentRoster} allPlayers={allPlayers} teams={teams} updateTeams={updateTeams} transactions={transactions} setTransactions={setTransactions} isWaiverMode={isWaiverMode} activeTournamentIndex={activeTournamentIndex} editingWaiverData={editingWaiverData} headshots={headshots} />
        </>
      )}
    </div>
  );
};

const AddDropPlayerModal = ({ isOpen, onClose, team, currentRoster, allPlayers, teams, updateTeams, transactions, setTransactions, isWaiverMode, activeTournamentIndex, editingWaiverData, headshots }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedPlayerToAdd, setSelectedPlayerToAdd] = useState(null);
  const [selectedPlayerToDrop, setSelectedPlayerToDrop] = useState(null);
  const [step, setStep] = useState('browse');
  const dialog = useDialog();

  useEffect(() => {
    if (editingWaiverData && isOpen) {
      const playerToAdd = allPlayers.find(p => p.name === editingWaiverData.player);
      if (playerToAdd) setSelectedPlayerToAdd(playerToAdd);
      if (editingWaiverData.droppedPlayer) {
        const playerToDrop = currentRoster.find(p => p.name === editingWaiverData.droppedPlayer);
        if (playerToDrop) setSelectedPlayerToDrop(playerToDrop);
      }
      setStep('confirm');
    }
  }, [editingWaiverData, isOpen, allPlayers, currentRoster]);

  if (!isOpen || !team) return null;

  const rosteredPlayers = new Set();
  teams.forEach(t => {
    let effectiveRoster = t.roster.map(p => p.name);
    transactions.filter(tx => tx.team === t.name && tx.status !== 'pending').forEach(tx => {
      if (tx.droppedPlayer) effectiveRoster = effectiveRoster.filter(n => n !== tx.droppedPlayer);
      if (tx.player && !effectiveRoster.includes(tx.player)) effectiveRoster.push(tx.player);
    });
    effectiveRoster.forEach(name => rosteredPlayers.add(name));
  });
  transactions.filter(tx => tx.status === 'pending' && tx.player).forEach(tx => rosteredPlayers.add(tx.player));
  const availablePlayers = allPlayers.filter(p => !rosteredPlayers.has(p.name));
  const filteredPlayers = availablePlayers.filter(p => p.name.toLowerCase().includes(searchTerm.toLowerCase()));

  const handleConfirmTransaction = () => {
    const fee = isWaiverMode ? 2 : 1;
    const newTransaction = {
      team: team.name, type: isWaiverMode ? 'waiver' : 'free agent',
      player: selectedPlayerToAdd.name, droppedPlayer: selectedPlayerToDrop?.name || null,
      fee, segment: getSegmentByDate(), date: new Date().toLocaleDateString(),
      tournamentIndex: activeTournamentIndex, status: isWaiverMode ? 'pending' : 'processed',
      priority: isWaiverMode ? (transactions.filter(tx => tx.team === team.name && tx.type === 'waiver' && tx.status === 'pending').length + 1) : undefined,
      timestamp: Date.now()
    };
    const updatedTeams = teams.map(t => t.id === team.id ? { ...t, transactionFees: (t.transactionFees || 0) + fee } : t);
    updateTeams(updatedTeams);
    setTransactions(prev => [newTransaction, ...prev]);
    dialog.showToast(`${isWaiverMode ? 'Waiver claim' : 'Free agent add'}: ${selectedPlayerToAdd.name}`, 'success');
    resetAndClose();
  };

  const resetAndClose = () => { setStep('browse'); setSelectedPlayerToAdd(null); setSelectedPlayerToDrop(null); setSearchTerm(''); onClose(); };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-gray-900 rounded-xl border-2 border-green-600 w-full max-w-lg" style={{ height: '70vh' }}>
        <div className="flex flex-col h-full">
          <div className="p-4 border-b border-gray-700 bg-gradient-to-r from-green-600/20 to-gray-800/50 flex-shrink-0">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold">{isWaiverMode ? '⏰ Submit Waiver Claim ($2)' : '✅ Add Free Agent ($1)'}</h2>
                <p className="text-xs text-gray-400 mt-0.5">{step === 'browse' ? 'Search and select a player' : 'Confirm transaction'}</p>
              </div>
              <button onClick={resetAndClose} className="text-gray-400 hover:text-white text-xl">×</button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-4 min-h-0">
            {step === 'browse' ? (
              <>
                <div className="mb-3">
                  <input type="text" placeholder="Search players..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-sm" autoFocus />
                </div>
                <div className="space-y-1.5">
                  {filteredPlayers.slice(0, 50).map((player) => (
                    <div key={player.name} className="flex items-center justify-between p-2 bg-gray-800/50 hover:bg-gray-700/50 rounded-lg border border-gray-700">
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 bg-gray-700 rounded-full flex items-center justify-center text-xs font-bold">#{player.worldRank}</div>
                        <div className="text-sm font-semibold">{player.name}</div>
                      </div>
                      <button onClick={() => { setSelectedPlayerToAdd(player); setStep('confirm'); }} className="px-3 py-1.5 bg-green-600 rounded-lg text-sm">Add</button>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="space-y-3">
                <div className="p-3 bg-green-600/20 border-2 border-green-600 rounded-lg">
                  <div className="text-xs font-semibold text-green-300">✅ Adding: {selectedPlayerToAdd?.name}</div>
                </div>
                {currentRoster.length >= 13 && (
                  <div className="space-y-1.5">
                    <div className="text-xs text-gray-400">Select player to drop:</div>
                    {currentRoster.map((player) => (
                      <button key={player.name} onClick={() => setSelectedPlayerToDrop(player)} className={'w-full flex justify-between p-2 rounded-lg border-2 ' + (selectedPlayerToDrop?.name === player.name ? 'bg-red-600/20 border-red-600' : 'bg-gray-800/50 border-gray-700')}>
                        <div className="text-sm">{player.name}</div>
                        {selectedPlayerToDrop?.name === player.name && <span className="text-red-400 text-xs font-bold">Drop</span>}
                      </button>
                    ))}
                  </div>
                )}
                <div className="flex gap-2 mt-4">
                  <button onClick={() => setStep('browse')} className="flex-1 py-2 bg-gray-700 rounded-lg text-sm">Back</button>
                  <button onClick={handleConfirmTransaction} disabled={currentRoster.length >= 13 && !selectedPlayerToDrop} className="flex-1 py-2 bg-green-600 disabled:bg-gray-700 rounded-lg text-sm">Confirm</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

const TransactionsView = ({ transactions, teams, setTransactions, updateTeams, isCommissioner }) => {
  const [filterTeam, setFilterTeam] = useState('all');
  const dialog = useDialog();

  const teamFees = useMemo(() => {
    const currentSwing = getSegmentByDate();
    const fees = {};
    teams.forEach(team => { fees[team.name] = { seasonTotal: 0, swingTotal: 0, teamId: team.id, teamName: team.name }; });
    transactions.forEach(tx => { if (fees[tx.team]) { fees[tx.team].seasonTotal += tx.fee; if (tx.segment === currentSwing) fees[tx.team].swingTotal += tx.fee; } });
    return Object.values(fees).sort((a, b) => b.seasonTotal - a.seasonTotal);
  }, [teams, transactions]);

  const swingPot = useMemo(() => {
    const total = teamFees.reduce((sum, t) => sum + t.swingTotal, 0);
    const winner = [...teams].sort((a, b) => (b.segmentEarnings || 0) - (a.segmentEarnings || 0))[0];
    return { total, winner: winner?.name || 'TBD' };
  }, [teamFees, teams]);

  const filteredTransactions = filterTeam === 'all' ? transactions : transactions.filter(tx => tx.team === filterTeam);

  const undoTransaction = async (txIndex) => {
    const tx = filteredTransactions[txIndex];
    const ok = await dialog.showConfirm('Undo Transaction', `Undo: ${tx.team} added ${tx.player}?`, { type: 'danger', confirmText: 'Undo' });
    if (!ok) return;
    const actualIndex = transactions.indexOf(tx);
    const team = teams.find(t => t.name === tx.team);
    if (!team) return;
    let newRoster = team.roster.filter(p => p.name !== tx.player);
    if (tx.droppedPlayer) newRoster.push(makePlayer(tx.droppedPlayer));
    const updatedTeams = teams.map(t => t.id === team.id ? { ...t, roster: newRoster, transactionFees: Math.max(0, (t.transactionFees || 0) - tx.fee) } : t);
    updateTeams(updatedTeams);
    setTransactions(prev => prev.filter((_, i) => i !== actualIndex));
    dialog.showToast('Transaction undone', 'success');
  };

  return (
    <div className="space-y-4">
      <div className="bg-gray-800/50 backdrop-blur rounded-xl border border-purple-700/30 overflow-hidden p-3">
        <h2 className="text-lg font-bold mb-3">Transaction Fees</h2>
        <div className="grid grid-cols-2 gap-3">
          {teamFees.map((team) => (
            <div key={team.teamId} className="bg-gray-700/30 rounded-lg p-3">
              <div className="font-semibold text-sm mb-1">{team.teamName}</div>
              <div className="text-xs text-yellow-400">Season: ${team.seasonTotal}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="bg-gray-800/50 backdrop-blur rounded-xl border border-green-700/30 p-4">
        <h2 className="text-xl font-bold mb-3">Transaction History</h2>
        <div className="divide-y divide-gray-700/50">
          {filteredTransactions.map((tx, index) => (
            <div key={index} className="py-2.5 flex justify-between items-center">
              <div>
                <span className="font-semibold text-sm">{tx.team}</span>
                <div className="text-xs text-gray-400">{tx.type}: <span className="text-green-400">{tx.player}</span> {tx.droppedPlayer && <span>(dropped {tx.droppedPlayer})</span>}</div>
              </div>
              <div className="flex gap-2">
                {tx.type !== 'mulligan' && <span className="font-bold text-sm text-green-400">${tx.fee}</span>}
                {isCommissioner && tx.type !== 'mulligan' && <button onClick={() => undoTransaction(index)} className="text-[10px] text-red-400">Undo</button>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

const TournamentsView = ({ tournaments, isCommissioner, setTournaments }) => {
  const [editMode, setEditMode] = useState(false);
  const [localTournaments, setLocalTournaments] = useState([]);
  const dialog = useDialog();

  useEffect(() => { setLocalTournaments(tournaments); }, [tournaments]);

  const saveChanges = () => {
    setTournaments(localTournaments);
    setEditMode(false);
    dialog.showToast('Schedule updated!', 'success');
  };

  const getSwingColor = (swing, dateStr) => {
    if (swing) {
       if (swing === 'West Coast Swing') return 'text-red-400';
       if (swing === 'Florida Swing') return 'text-yellow-400';
       if (swing === 'Spring Swing') return 'text-green-400';
       if (swing === 'Summer Swing') return 'text-blue-400';
       return 'text-orange-400';
    }
    
    if (!dateStr) return 'text-gray-400';
    const month = dateStr.split(' ')[0];
    if (['Jan', 'Feb'].includes(month)) return 'text-red-400';
    if (['Mar', 'Apr', 'May'].includes(month)) return 'text-green-400';
    if (['Jun', 'Jul', 'Aug'].includes(month)) return 'text-blue-400';
    return 'text-orange-400';
  };

  const isAlternate = (t) => {
    if (t.isAlternate !== undefined) return t.isAlternate;
    const altNames = ['Puerto Rico', 'Zurich', 'Corales', 'Myrtle Beach', 'ISCO', 'Barracuda'];
    return altNames.some(name => t.name.includes(name));
  };

  const completed = localTournaments.filter(t => t.completed).slice().reverse();
  const upcoming = localTournaments.filter(t => !t.completed);

  const renderTable = (list, isCompleted) => (
    <table className="w-full text-sm text-left">
      <thead className="bg-gray-800/50 text-xs font-bold text-gray-400 border-b border-gray-700">
        <tr>
          {editMode ? (
             <>
               <th className="px-2 py-2">Active</th>
               <th className="px-2 py-2">Type</th>
               <th className="px-2 py-2">Tournament</th>
               <th className="px-2 py-2">Swing</th>
             </>
          ) : (
             <>
               <th className="px-3 py-3 w-10 text-center"></th>
               <th className="px-3 py-3">Tournament</th>
               <th className="px-3 py-3">Dates</th>
               <th className="px-3 py-3 hidden sm:table-cell">Location & Course</th>
             </>
          )}
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-700/50">
        {list.map((t) => {
          const realIndex = localTournaments.findIndex(lt => lt.name === t.name);
          const alt = isAlternate(t);
          
          if (editMode) {
             return (
               <tr key={t.name} className="hover:bg-gray-700/30">
                 <td className="px-2 py-2 text-center">
                   <input type="checkbox" checked={t.playing} onChange={e => {
                      const newT = [...localTournaments];
                      if (e.target.checked) newT.forEach(x => x.playing = false);
                      newT[realIndex].playing = e.target.checked;
                      setLocalTournaments(newT);
                   }} className="accent-green-500 w-4 h-4" />
                 </td>
                 <td className="px-2 py-2">
                   <div className="flex gap-1">
                     <button onClick={() => { const newT = [...localTournaments]; newT[realIndex].isSignature = !t.isSignature; setLocalTournaments(newT); }} className={`w-6 h-6 rounded font-bold text-[10px] ${t.isSignature ? 'bg-purple-600 text-white' : 'bg-gray-700 text-gray-500'}`}>S</button>
                     <button onClick={() => { const newT = [...localTournaments]; newT[realIndex].isMajor = !t.isMajor; setLocalTournaments(newT); }} className={`w-6 h-6 rounded font-bold text-[10px] ${t.isMajor ? 'bg-yellow-500 text-white' : 'bg-gray-700 text-gray-500'}`}>M</button>
                     <button onClick={() => { const newT = [...localTournaments]; newT[realIndex].isAlternate = !t.isAlternate; setLocalTournaments(newT); }} className={`w-6 h-6 rounded font-bold text-[10px] ${t.isAlternate ? 'bg-red-900/50 text-red-400 border border-red-500' : 'bg-gray-700 text-gray-500'}`}>Alt</button>
                   </div>
                 </td>
                 <td className="px-2 py-2">
                    <input value={t.name} onChange={e => { const newT = [...localTournaments]; newT[realIndex].name = e.target.value; setLocalTournaments(newT); }} className="bg-transparent border-b border-gray-600 w-full text-xs focus:outline-none focus:border-green-500" />
                    <div className="text-[10px] text-gray-500">{t.dates}</div>
                 </td>
                 <td className="px-2 py-2">
                    <select value={t.swing || getSegmentByDate()} onChange={e => { const newT = [...localTournaments]; newT[realIndex].swing = e.target.value; setLocalTournaments(newT); }} className="bg-gray-800 text-xs border border-gray-600 rounded p-1 w-full">
                       {SWINGS.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                 </td>
               </tr>
             );
          }

          return (
            <tr key={t.name} className={`hover:bg-gray-700/30 transition-colors ${alt ? 'opacity-50' : ''}`}>
              <td className="px-3 py-3 flex justify-center items-center h-full">
                {t.isMajor ? (
                  <span className="w-5 h-5 bg-yellow-500 text-white text-[10px] font-bold flex items-center justify-center rounded">M</span>
                ) : t.isSignature ? (
                  <span className="w-5 h-5 bg-purple-600 text-white text-[10px] font-bold flex items-center justify-center rounded">S</span>
                ) : null}
              </td>
              <td className="px-3 py-3 font-bold">
                <span className={alt ? "text-gray-500" : "text-gray-200"}>
                  {t.name}
                  {t.completed && <span className="ml-2 text-[10px] font-normal px-1.5 py-0.5 bg-gray-700 text-gray-300 rounded">Final</span>}
                  {t.playing && <span className="ml-2 text-[10px] font-normal px-1.5 py-0.5 bg-green-900/50 border border-green-500/50 text-green-400 rounded">Active</span>}
                </span>
              </td>
              <td className={`px-3 py-3 font-medium whitespace-nowrap ${alt ? 'text-gray-500' : getSwingColor(t.swing, t.dates)}`}>
                {t.dates}
              </td>
              <td className={`px-3 py-3 hidden sm:table-cell ${alt ? 'text-gray-600' : 'text-gray-400'}`}>
                <div className="font-semibold">{t.location}</div>
                {t.course && t.course !== 'TBD' && (
                   <div className="text-[10px] opacity-70">{t.course}</div>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
         <h2 className="text-xl font-bold">2026 Season Schedule</h2>
         {isCommissioner && (
           <button onClick={() => editMode ? saveChanges() : setEditMode(true)} className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${editMode ? 'bg-green-600 hover:bg-green-500 text-white' : 'bg-gray-700 hover:bg-gray-600 text-gray-300'}`}>
             {editMode ? <><Save className="w-3 h-3" /> Save Changes</> : <><Edit2 className="w-3 h-3" /> Edit Schedule</>}
           </button>
         )}
      </div>

      <div className="bg-gray-800/50 backdrop-blur rounded-xl border border-gray-700/50 overflow-hidden shadow-lg">
        <div className="p-4 bg-gray-700/30 border-b border-gray-700/50 flex items-center gap-2">
          <Calendar className="w-5 h-5 text-gray-400" />
          <h2 className="text-xl font-bold">Upcoming Events</h2>
        </div>
        <div className="overflow-x-auto">
          {renderTable(upcoming, false)}
        </div>
      </div>

      {completed.length > 0 && (
        <div className="bg-gray-800/50 backdrop-blur rounded-xl border border-gray-700/50 overflow-hidden shadow-lg">
          <div className="p-4 bg-gray-700/30 border-b border-gray-700/50 flex items-center gap-2">
            <Trophy className="w-5 h-5 text-yellow-400" />
            <h2 className="text-xl font-bold">Completed Tournaments</h2>
          </div>
          <div className="overflow-x-auto">
            {renderTable(completed, true)}
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// ADMIN VIEW
// ============================================================================
const AdminView = ({ isCommissioner, setIsCommissioner, setActiveTab, settings, setSettings, teams, updateTeams, tournaments, setTournaments, transactions, setTransactions, allPlayers, globalPlayerStats, setGlobalPlayerStats, updateRankings, rankingsLastUpdated, headshots, setHeadshots }) => {
  
  const [selectedTourneyForResults, setSelectedTourneyForResults] = useState('');
  const [manualEarnings, setManualEarnings] = useState('');
  const [overrideTournament, setOverrideTournament] = useState('');
  const [overrideTeam, setOverrideTeam] = useState('');
  const [editRosterTeamId, setEditRosterTeamId] = useState('');

  const [showDraftModal, setShowDraftModal] = useState(false);
  const [showOffseasonModal, setShowOffseasonModal] = useState(false);
  const [draftInProgress, setDraftInProgress] = useState(false);
  const [draftRound, setDraftRound] = useState(1);
  const [draftPick, setDraftPick] = useState(1);
  const [draftOrder] = useState(teams.map(t => t.id));
  const [draftSearch, setDraftSearch] = useState('');
  const [draftRosters, setDraftRosters] = useState({});
  const [keepers, setKeepers] = useState({});

  const dialog = useDialog();
  const activeTournament = tournaments.find(t => t.playing);

  useEffect(() => {
    if (!selectedTourneyForResults && activeTournament) {
      setSelectedTourneyForResults(activeTournament.name);
    }
  }, [activeTournament, selectedTourneyForResults]);

  const handleManualResultsEntry = async () => {
    dialog.showToast('Manual results processed', 'success');
  };

  const handleProcessWaivers = async () => {
    dialog.showToast('Waivers processed', 'success');
  };

  const resetMulligan = (teamId, type) => {
    const team = teams.find(t => t.id === teamId);
    if (!team) return;
    const key = type === 'sig' ? 'signatureMajor' : 'regular';
    const newMulligans = { ...team.mulligans, [key]: 1 };
    updateTeams(teams.map(t => t.id === teamId ? { ...t, mulligans: newMulligans } : t));
    dialog.showToast(`Reset ${type} mulligan for ${team.name}`, 'success');
  };

  const handleExport = () => {
    const data = { teams, tournaments, transactions, settings, globalPlayerStats, headshots };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `sfgl-backup-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    dialog.showToast('Data exported successfully', 'success');
  };

  const handleImport = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const data = JSON.parse(event.target.result);
        if (data.teams) updateTeams(data.teams);
        if (data.tournaments) setTournaments(data.tournaments);
        if (data.transactions) setTransactions(data.transactions);
        if (data.settings) { setSettings(data.settings); storage.set(STORAGE_KEYS.SETTINGS, data.settings); }
        if (data.globalPlayerStats) { setGlobalPlayerStats(data.globalPlayerStats); storage.set(STORAGE_KEYS.GLOBAL_PLAYER_STATS, data.globalPlayerStats); }
        if (data.headshots) { setHeadshots(data.headshots); storage.set(STORAGE_KEYS.HEADSHOTS, data.headshots); }
        dialog.showToast('Data imported successfully! Your league is restored.', 'success');
      } catch (err) {
        dialog.showToast('Failed to parse backup file.', 'error');
      }
    };
    reader.readAsText(file);
    e.target.value = null; 
  };

  const handleSyncSchedule = async () => {
    const ok = await dialog.showConfirm('Sync Schedule', 'Fetch the official PGA schedule?\n\nThis will cleanly build your tournament list, connect any imported past results, and truncate the season at the TOUR Championship.', { confirmText: 'Sync Schedule' });
    if (!ok) return;

    try {
      dialog.showToast('Fetching PGA Schedule...', 'success');
      let pgaData = await slashGolfFetch('schedule', { orgId: '1', year: '2026' });
      
      if (!pgaData?.schedule || pgaData.schedule.length === 0) {
          pgaData = await slashGolfFetch('schedule', { orgId: '1', year: '2025' });
      }

      let enrichedCount = 0;

      let formattedSchedule = (pgaData?.schedule || []).map(event => {
        let name = event.name || 'Unknown Tournament';
        let slashGolfId = event.tournId || event.id || '';
        
        let startDate = null;
        let endDate = null;
        let dateStr = 'TBD';
        let location = 'TBD';
        let courseName = 'TBD';

        const extractD = (dObj) => {
            if (!dObj) return null;
            if (typeof dObj === 'string') return dObj;
            if (typeof dObj === 'number') return new Date(dObj).toISOString();
            if (typeof dObj === 'object') {
                if (dObj.date) return dObj.date; 
                if (dObj.start) return dObj.start;
                if (dObj.timestamp) return new Date(dObj.timestamp).toISOString();
                if (dObj.display) return dObj.display;
            }
            return null;
        };

        const sStr = extractD(event.startDate || event.date?.start || event.date?.startDate || event.start);
        const eStr = extractD(event.endDate || event.date?.end || event.date?.endDate || event.end);

        const parseISO = (iso) => {
            if (!iso) return null;
            const str = String(iso);
            const parts = str.split('T')[0].split('-');
            if (parts.length === 3) return new Date(parts[0], parseInt(parts[1])-1, parseInt(parts[2]));
            const d = new Date(str);
            if (!isNaN(d)) return d;
            return null;
        };

        const sDate = parseISO(sStr);
        const eDate = parseISO(eStr);

        if (sDate && eDate) {
            startDate = sDate.toISOString();
            eDate.setHours(23, 59, 59); 
            endDate = eDate.toISOString();

            const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
            const sm = months[sDate.getMonth()];
            const em = months[eDate.getMonth()];
            const sd = sDate.getDate();
            const ed = eDate.getDate();

            if (sm === em) dateStr = `${sm} ${sd}-${ed}`;
            else dateStr = `${sm} ${sd}-${em} ${ed}`;
        } else if (event.date?.display) {
            dateStr = event.date.display;
        } else if (typeof event.date === 'string') {
            dateStr = event.date;
        }
        
        const courses = event.courses || event.courseDetails || [];
        if (courses.length > 0 && courses[0]) {
            courseName = courses[0].courseName || courses[0].name || 'TBD';
            const loc = courses[0].location || courses[0].address || courses[0];
            if (typeof loc === 'string') location = loc;
            else if (typeof loc === 'object') {
                const city = loc.city || loc.town || loc.municipality || '';
                const state = loc.state || loc.region || loc.country || '';
                if (city && state) location = `${city}, ${state}`;
                else if (city || state) location = city || state;
            }
        }

        // --- ENRICHMENT ENGINE ---
        // The API schedule endpoint omits Location and Course data to save payload size.
        // We inject them from our local dictionary so we don't burn 40 separate /tournament API calls.
        const fb = FALLBACK_SCHEDULE_DATA.find(f => name.includes(f.key));
        if (fb) {
            if (!location || location === 'TBD' || location.includes('[object Object]')) {
                location = fb.loc;
                enrichedCount++; 
            }
            if (!courseName || courseName === 'TBD' || courseName.includes('[object Object]')) {
                courseName = fb.course;
            }
            
            // Only overwrite dates if the API totally failed to provide them
            if (!dateStr || dateStr === 'TBD' || !startDate || dateStr.includes('[object Object]')) {
                dateStr = fb.d;
                const fbS = new Date(fb.s);
                startDate = fbS.toISOString();
                const fbE = new Date(fb.e);
                fbE.setHours(23, 59, 59);
                endDate = fbE.toISOString();
            }
        } else if (dateStr && dateStr.includes('[object Object]')) {
            dateStr = 'TBD';
        }

        // --- SMART MERGE / FUZZY MATCH ENGINE ---
        // This ensures imported backup results seamlessly connect to the fresh API schedule
        const normalizeForMatch = (str) => (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const apiNameNorm = normalizeForMatch(name);
        const fbNorm = fb ? normalizeForMatch(fb.key) : '';

        const existingT = tournaments.find(t => {
            const tNorm = normalizeForMatch(t.name);
            return tNorm === apiNameNorm || 
                   apiNameNorm.includes(tNorm) || 
                   tNorm.includes(apiNameNorm) ||
                   (fbNorm && (tNorm.includes(fbNorm) || apiNameNorm.includes(fbNorm)));
        });

        return {
            name, slashGolfId, dates: dateStr, location, startDate, endDate, course: courseName,
            isSignature: existingT && existingT.isSignature !== undefined ? existingT.isSignature : (event.purse > 15000000),
            isMajor: existingT && existingT.isMajor !== undefined ? existingT.isMajor : ['Masters Tournament', 'PGA Championship', 'U.S. Open', 'The Open Championship'].includes(name),
            isAlternate: existingT && existingT.isAlternate !== undefined ? existingT.isAlternate : ((event.purse && event.purse < 5000000) || ['Zurich', 'Barracuda', 'ISCO', 'Corales', 'Puerto Rico', 'Myrtle Beach'].some(n => name.includes(n))),
            swing: existingT ? existingT.swing : undefined,
            playing: existingT ? existingT.playing : false, 
            completed: existingT ? existingT.completed : false,
            results: existingT ? existingT.results : null
        };
      });

      // --- AUTO-TRUNCATOR ---
      // Automatically cuts the schedule off after the Tour Championship
      const tcIndex = formattedSchedule.findIndex(t => t.name.toLowerCase().includes('tour championship'));
      if (tcIndex !== -1) {
          formattedSchedule = formattedSchedule.slice(0, tcIndex + 1);
      }

      // Maintain Current Active Tournament
      const activeCount = formattedSchedule.filter(t => t.playing).length;
      if (activeCount !== 1) {
          formattedSchedule.forEach(t => t.playing = false);
          const nextIdx = formattedSchedule.findIndex(t => !t.completed && !t.isAlternate);
          if (nextIdx !== -1) formattedSchedule[nextIdx].playing = true;
      }

      setTournaments(formattedSchedule);
      const fallbackMsg = enrichedCount > 0 ? `(Enriched ${enrichedCount} events with offline location data to save API quota)` : `(100% API data)`;
      dialog.showToast(`Schedule synced successfully! ${fallbackMsg}`, 'success');

    } catch (error) { 
      console.error("Schedule Sync Error:", error);
      dialog.showToast(`API Error: ${error.message}`, 'error'); 
    }
  };

  const handleFetchApiResults = async () => {
    if (!selectedTourneyForResults) {
      dialog.showToast('Please select a tournament first', 'error');
      return;
    }
    
    const tournIndex = tournaments.findIndex(t => t.name === selectedTourneyForResults);
    if (tournIndex === -1) return;
    const t = tournaments[tournIndex];

    if (!t.slashGolfId) {
       dialog.showToast('No API ID found for this tournament. Please click "Sync Schedule" to attach the IDs.', 'error');
       return;
    }
    
    if (t.completed) {
        const ok = await dialog.showConfirm('Already Processed', 'This tournament has already been processed. Re-fetching will ADD the earnings to the teams again, doubling their money!\n\nAre you sure you want to proceed?', { type: 'danger', confirmText: 'Force Re-Fetch' });
        if (!ok) return;
    }

    dialog.showToast(`Fetching Leaderboard for ${t.name}...`, 'success');
    
    try {
      const data = await slashGolfFetch('leaderboard', { tournId: t.slashGolfId, year: '2026' });
      const apiPlayers = data.leaderboard || data.results || [];
      
      if (apiPlayers.length === 0) {
         dialog.showToast('No results found in API yet.', 'error');
         return;
      }

      const { newTeams, newStats, resultsData } = processTournamentData(t, apiPlayers, teams, globalPlayerStats, allPlayers.map(p=>p.name));

      const newTournaments = [...tournaments];
      newTournaments[tournIndex] = { ...t, completed: true, playing: false, results: resultsData };
      
      // Find next eligible tournament and make it the active one
      const nextTournIndex = newTournaments.findIndex((nt, idx) => idx > tournIndex && !nt.completed && !nt.isAlternate);
      if (nextTournIndex !== -1) {
          newTournaments.forEach(nt => nt.playing = false); 
          newTournaments[nextTournIndex].playing = true;
      }

      updateTeams(newTeams);
      setGlobalPlayerStats(newStats);
      setTournaments(newTournaments);
      dialog.showToast(`Successfully processed results for ${t.name}!`, 'success');

    } catch (error) {
      console.error("Results Sync Error:", error);
      dialog.showToast(`API Error: ${error.message}`, 'error');
    }
  };

  const handleSyncPlayers = async () => {
    const ok = await dialog.showConfirm('Sync OWGR Players', 'Fetch the current Top 250 OWGR players?\n\nThis will also dynamically fetch the LIV Golf roster to filter them out of the player pool.', { confirmText: 'Fetch Players' });
    if (!ok) return;

    try {
      dialog.showToast('Fetching LIV Golf Roster...', 'success');
      const livPlayers = new Set();
      for (const yr of ['2026', '2025']) {
        try {
          const livData = await slashGolfFetch('schedule', { orgId: '2', year: yr });
          if (livData?.schedule?.length > 0) {
            const firstLivEvent = livData.schedule[0].tournId;
            const livTourney = await slashGolfFetch('tournament', { orgId: '2', tournId: firstLivEvent, year: yr });
            livTourney.players?.forEach(p => {
              const pObj = p?.player || p || {};
              const fName = pObj.firstName || '';
              const lName = pObj.lastName || '';
              if (fName || lName) livPlayers.add(`${fName} ${lName}`.trim());
            });
            break;
          }
        } catch (e) { /* ignore and try next year */ }
      }

      dialog.showToast('Fetching World Rankings...', 'success');
      let details = [];
      for (const yr of ['2026', '2025', '2024']) {
        try {
          const owgrData = await slashGolfFetch('rankings', { statId: '186', year: yr });
          details = owgrData?.rankings?.[0]?.details || owgrData?.details || owgrData?.rankings || owgrData?.data || [];
          if (details.length === 0) {
            const statsData = await slashGolfFetch('stats', { statId: '186', year: yr });
            details = statsData?.stats?.[0]?.details || statsData?.details || [];
          }
          if (details.length > 0) break;
        } catch (e) { /* ignore and try next year */ }
      }

      const newPlayers = [];
      if (details.length > 0) {
        details.forEach(p => {
           const pObj = p?.player || p || {};
           let name = pObj?.fullName || pObj?.displayName || pObj?.name || '';
           if (!name) {
               const fName = pObj.firstName || '';
               const lName = pObj.lastName || '';
               name = `${fName} ${lName}`.trim();
           }
           if (!name && typeof p === 'string') name = p;

           const rankVal = parseInt(p?.rankValue || p?.rank || p?.curRank || pObj?.rank) || 999;
           
           if (name && !livPlayers.has(name) && newPlayers.length < 250) {
              newPlayers.push({ name, worldRank: rankVal });
           }
        });
      }

      if (newPlayers.length === 0) {
          Object.keys(PGA_TOUR_IDS).forEach((name, i) => {
              if (newPlayers.length < 250) newPlayers.push({ name, worldRank: i + 1 });
          });
          dialog.showToast(`API parsed 0 players. Fallback: Loaded ${newPlayers.length} players.`, 'success');
      } else {
          dialog.showToast(`Success! Loaded ${newPlayers.length} players.`, 'success');
      }
      
      updateRankings(newPlayers);
    } catch (error) { 
      console.error("Player Sync Error:", error);
      dialog.showToast(`API Error: ${error.message}`, 'error'); 
    }
  };

  const handleProcessOffseason = async () => {
    const ok = await dialog.showConfirm('Process Offseason', 'This will wipe all season data, lock in keepers, and prepare rosters for the draft. Cannot be undone!', { type: 'danger', confirmText: 'Process Offseason' });
    if (!ok) return;
    
    const resetTeams = teams.map(team => {
      const teamKeepers = keepers[team.id] || {};
      const newRoster = [];
      if (teamKeepers.yellow) {
         const p = team.roster.find(x => x.name === teamKeepers.yellow);
         newRoster.push({ ...p, yearsOfService: (p.yearsOfService || 1) + 1, starts: 0, eventsPlayed: 0, cutsMade: 0, pgaTourEarnings: 0, sfglEarnings: 0 });
      }
      if (teamKeepers.blue) {
         const p = team.roster.find(x => x.name === teamKeepers.blue);
         newRoster.push({ ...p, unlimited: true, yearsOfService: 2, starts: 0, eventsPlayed: 0, cutsMade: 0, pgaTourEarnings: 0, sfglEarnings: 0 });
      }
      return { ...team, earnings: 0, segmentEarnings: 0, transactionFees: 0, lineup: [], roster: newRoster, mulligans: { signatureMajor: 1, regular: 1 } };
    });
    
    updateTeams(resetTeams); setTransactions([]); setGlobalPlayerStats({}); setShowOffseasonModal(false);
    dialog.showToast('Offseason processed. Ready for Draft!', 'success');
  };

  const handleNextPick = useCallback(() => {
    if (draftPick < teams.length) { setDraftPick(prev => prev + 1); } 
    else if (draftRound < 13) { setDraftRound(prev => prev + 1); setDraftPick(1); } 
    else {
      const updatedTeams = teams.map(t => ({ ...t, roster: draftRosters[t.id] || [] }));
      updateTeams(updatedTeams);
      dialog.showToast('🎉 Draft Complete!', 'success');
      setDraftInProgress(false); setShowDraftModal(false);
    }
  }, [draftPick, draftRound, teams, draftRosters, updateTeams, dialog]);

  useEffect(() => {
    if (draftInProgress) {
      const cid = draftRound % 2 === 1 ? draftOrder[draftPick - 1] : draftOrder[teams.length - draftPick];
      if (draftRosters[cid] && draftRosters[cid].length >= 13) {
        const timer = setTimeout(() => handleNextPick(), 0);
        return () => clearTimeout(timer);
      }
    }
  }, [draftPick, draftRound, draftInProgress, draftRosters, draftOrder, teams.length, handleNextPick]);

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center bg-gray-800/50 p-4 rounded-xl border border-gray-700">
        <h2 className="text-xl font-bold flex items-center gap-2"><Settings className="w-5 h-5 text-gray-400" /> Commissioner Controls</h2>
        <button onClick={() => { setIsCommissioner(false); setActiveTab('standings'); }} className="bg-red-600 hover:bg-red-700 px-4 py-1.5 rounded-lg text-sm font-bold transition-colors">Logout</button>
      </div>

      {/* Enter Tournament Results */}
      <div className="bg-blue-900/20 border border-blue-700/50 p-4 rounded-xl">
        <h3 className="font-bold text-blue-400 flex items-center gap-2 mb-4">✏️ Enter Tournament Results</h3>
        <div className="space-y-4">
          <div>
            <label className="text-xs font-bold text-gray-400 block mb-1">Select Tournament</label>
            <select value={selectedTourneyForResults} onChange={e => setSelectedTourneyForResults(e.target.value)} className="w-full bg-gray-800 border border-gray-600 rounded p-2 text-sm">
              <option value="">Choose tournament...</option>
              {tournaments.map(t => <option key={t.name} value={t.name}>{t.name}</option>)}
            </select>
          </div>
          <button onClick={handleFetchApiResults} className="w-full py-2.5 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm font-bold border border-gray-600 transition-colors flex items-center justify-center gap-2"><span className="text-orange-500">⚡</span> Fetch Results from API</button>
        </div>
      </div>

      <div className="bg-teal-900/10 border border-teal-700/50 p-4 rounded-xl">
        <h3 className="font-bold text-teal-400 flex items-center gap-2 mb-2">🌎 World Rankings & Schedule Sync</h3>
        <div className="flex gap-2 mt-4">
          <button onClick={handleSyncSchedule} className="flex-1 bg-purple-600 hover:bg-purple-700 px-3 py-2 rounded text-xs sm:text-sm font-bold transition-colors">Sync Schedule</button>
          <button onClick={handleSyncPlayers} className="flex-1 bg-teal-600 hover:bg-teal-700 py-2 rounded-lg text-sm font-bold transition-colors flex justify-center items-center gap-2">Sync OWGR Top 250</button>
        </div>
      </div>
    </div>
  );
};

const FantasyGolfLeague = () => {
  const [activeTab, setActiveTab] = useState('standings');
  const [teams, setTeams] = useState([]);
  const [tournaments, setTournaments] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [settings, setSettings] = useState({ commissioner: 'Detroit Rock City', currentSegment: 'West Coast Swing' });
  const [selectedTeam, setSelectedTeam] = useState(null);
  const [isCommissioner, setIsCommissioner] = useState(false);
  const [loading, setLoading] = useState(true);
  const [globalPlayerStats, setGlobalPlayerStats] = useState({});
  const [loggedInUser, setLoggedInUser] = useState(null);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [allPlayers, setAllPlayers] = useState(DEFAULT_ELIGIBLE_PLAYERS);
  const [rankingsLastUpdated, setRankingsLastUpdated] = useState(null);
  const [headshots, setHeadshots] = useState(SEED_HEADSHOTS);
  
  const [isSyncing, setIsSyncing] = useState(false);
  const [showAdminLoginPopover, setShowAdminLoginPopover] = useState(false);
  const [adminPassword, setAdminPassword] = useState('');
  const dialog = useDialog();

  useEffect(() => {
    const loadData = async () => {
      try {
        const [teamsData, tournamentsData, transactionsData, settingsData, statsData, rankingsData, headshotsData] = await Promise.all([
          storage.get(STORAGE_KEYS.TEAMS, null), storage.get(STORAGE_KEYS.TOURNAMENTS, null), storage.get(STORAGE_KEYS.TRANSACTIONS, null),
          storage.get(STORAGE_KEYS.SETTINGS, null), storage.get(STORAGE_KEYS.GLOBAL_PLAYER_STATS, null), storage.get(STORAGE_KEYS.PLAYER_RANKINGS, null), storage.get(STORAGE_KEYS.HEADSHOTS, null)
        ]);
        setTeams(teamsData || INITIAL_TEAMS); setTournaments(tournamentsData || INITIAL_SCHEDULE); setTransactions(transactionsData || []);
        setSettings(settingsData || { commissioner: 'Detroit Rock City', currentSegment: 'West Coast Swing' }); setGlobalPlayerStats(statsData || {});
        if (headshotsData) setHeadshots(headshotsData);
        if (rankingsData?.players?.length > 0) { setAllPlayers(rankingsData.players); setRankingsLastUpdated(rankingsData.lastUpdated); }
      } catch (e) { setTeams(INITIAL_TEAMS); setTournaments(INITIAL_SCHEDULE); }
      setLoading(false);
    };
    loadData();
  }, []);

  const updateTeams = useCallback(async (newTeams) => { setTeams(newTeams); await storage.set(STORAGE_KEYS.TEAMS, newTeams, setIsSyncing); }, []);
  const safeSetTransactions = useCallback(async (newTxOrUpdater) => { setTransactions(prev => { const updated = typeof newTxOrUpdater === 'function' ? newTxOrUpdater(prev) : newTxOrUpdater; storage.set(STORAGE_KEYS.TRANSACTIONS, updated, setIsSyncing); return updated; }); }, []);
  const safeSetTournaments = useCallback(async (newTournaments) => { setTournaments(newTournaments); await storage.set(STORAGE_KEYS.TOURNAMENTS, newTournaments, setIsSyncing); }, []);

  const currentTournament = tournaments.find(t => t.playing);

  const TABS = [
    { id: 'standings', label: 'Standings', Icon: BarChart3 }, { id: 'results', label: 'Results', Icon: Trophy }, { id: 'rosters', label: 'Rosters', Icon: Users },
    { id: 'transactions', label: 'Transactions', Icon: DollarSign }, { id: 'tournaments', label: 'Tournaments', Icon: Calendar }, { id: 'admin', label: 'Admin', Icon: Settings }
  ];

  const handleAdminLogin = async () => {
    const hashed = await hashPassword(adminPassword);
    if (hashed === COMMISSIONER_PASSWORD_HASH) { setIsCommissioner(true); setShowAdminLoginPopover(false); setAdminPassword(''); setActiveTab('admin'); }
    else { dialog.showToast('Incorrect password', 'error'); setAdminPassword(''); }
  };

  if (loading) return <div className="min-h-screen bg-gradient-to-br from-gray-900 via-green-900 to-gray-900 flex flex-col items-center justify-center gap-3"><div className="text-white text-xl animate-pulse">Loading Season...</div></div>;

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-green-900 to-gray-900 text-white pb-20">
      <header className="bg-black/40 backdrop-blur-sm border-b border-green-700/30 sticky top-0 z-50">
        <div className="max-w-3xl mx-auto px-3 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2"><div className="w-11 h-11 rounded-full overflow-hidden flex-shrink-0 flex items-center justify-center bg-white"><img src={SFGL_LOGO_SRC} alt="SFGL" className="w-full h-full object-cover scale-[2.5]" /></div><div className="flex flex-col"><span className="text-xl font-bold text-green-400 leading-none">2026</span></div></div>
            {loggedInUser ? <button onClick={() => setLoggedInUser(null)} className="text-xs bg-red-600/20 px-3 py-1 rounded border border-red-600/50">Logout</button> : <button onClick={() => setShowLoginModal(true)} className="text-xs bg-green-600/20 px-3 py-1 rounded border border-green-600/50">Login</button>}
          </div>
        </div>
      </header>

      <div className="max-w-3xl mx-auto px-3 mt-4 mb-2 flex items-center gap-4">
        <div className="font-bold text-white text-sm sm:text-base">{getSegmentByDate()}</div>
        {currentTournament && <div className="font-bold text-yellow-400 text-sm sm:text-base flex items-center gap-1.5"><span className="text-green-400">⛳</span> {currentTournament.name}</div>}
      </div>

      <nav className="max-w-3xl mx-auto px-3 mt-2 relative">
        <div className="flex gap-1 pb-2 overflow-x-auto">
          {TABS.map(tab => (
            <button key={tab.id} onClick={() => { if (tab.id === 'admin' && !isCommissioner) { setShowAdminLoginPopover(!showAdminLoginPopover); return; } setShowAdminLoginPopover(false); setActiveTab(tab.id); }} className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-2.5 rounded-lg text-xs font-medium ${activeTab === tab.id ? 'bg-green-600' : 'bg-gray-800/50 text-gray-400'} ${tab.id === 'admin' && showAdminLoginPopover ? 'bg-gray-700 text-white' : ''}`}><tab.Icon className="w-4 h-4" /> <span className="hidden sm:inline">{tab.label}</span></button>
          ))}
        </div>
        {showAdminLoginPopover && !isCommissioner && (
          <div className="absolute right-3 top-full mt-1 bg-gray-800 p-2.5 rounded-xl shadow-2xl border border-green-600/50 z-50 flex gap-2 animate-[scaleIn_0.15s_ease-out]">
            <input type="password" autoFocus placeholder="Password..." value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleAdminLogin(); }} className="bg-gray-900 border border-gray-600 rounded-lg px-3 py-1.5 text-sm w-32 text-white focus:outline-none focus:border-green-500" />
            <button onClick={handleAdminLogin} className="bg-green-600 hover:bg-green-500 px-3 py-1.5 rounded-lg text-sm font-bold transition-colors">Go</button>
          </div>
        )}
      </nav>

      <main className="max-w-3xl mx-auto px-3 mt-4">
        <ErrorBoundary>
          {activeTab === 'standings' && <StandingsView teams={teams} settings={settings} />}
          {activeTab === 'results' && <ResultsView teams={teams} tournaments={tournaments} headshots={headshots} />}
          {activeTab === 'rosters' && <RostersView teams={teams} selectedTeam={selectedTeam} setSelectedTeam={setSelectedTeam} updateTeams={updateTeams} tournaments={tournaments} allPlayers={allPlayers} transactions={transactions} setTransactions={safeSetTransactions} settings={settings} loggedInUser={loggedInUser} isCommissioner={isCommissioner} globalPlayerStats={globalPlayerStats} headshots={headshots} />}
          {activeTab === 'transactions' && <TransactionsView transactions={transactions} teams={teams} isCommissioner={isCommissioner} />}
          {activeTab === 'tournaments' && <TournamentsView tournaments={tournaments} isCommissioner={isCommissioner} setTournaments={safeSetTournaments} />}
          {activeTab === 'admin' && <AdminView isCommissioner={isCommissioner} setIsCommissioner={setIsCommissioner} setActiveTab={setActiveTab} settings={settings} setSettings={setSettings} teams={teams} updateTeams={updateTeams} tournaments={tournaments} setTournaments={safeSetTournaments} transactions={transactions} setTransactions={safeSetTransactions} allPlayers={allPlayers} globalPlayerStats={globalPlayerStats} setGlobalPlayerStats={setGlobalPlayerStats} headshots={headshots} setHeadshots={setHeadshots} updateRankings={(p) => { setAllPlayers(p); storage.set(STORAGE_KEYS.PLAYER_RANKINGS, { players: p, lastUpdated: new Date().toISOString() }); }} rankingsLastUpdated={rankingsLastUpdated} />}
        </ErrorBoundary>
      </main>
      {showLoginModal && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50">
          <div className="bg-gray-800 p-6 rounded-xl w-full max-w-sm"><h3 className="text-xl font-bold mb-4">Select Team</h3><div className="space-y-2">{teams.map(t => <button key={t.id} onClick={() => { setLoggedInUser(t.owner); setShowLoginModal(false); }} className="w-full text-left p-3 bg-gray-700 hover:bg-gray-600 rounded"><div className="font-bold">{t.name}</div><div className="text-xs text-gray-400">{t.owner}</div></button>)}</div><button onClick={() => setShowLoginModal(false)} className="w-full mt-4 p-2 bg-gray-600 rounded text-sm">Cancel</button></div>
        </div>
      )}
    </div>
  );
};

const App = () => (
  <DialogProvider>
    <FantasyGolfLeague />
  </DialogProvider>
);

export default App;