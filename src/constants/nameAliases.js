// src/constants/nameAliases.js
// Single source of truth for player name variants across OWGR, PGA Tour, and rosters.
// Key = alternate name (from OWGR or PGA Tour field page)
// Value = canonical name (as stored on rosters in Firebase)
//
// To add a new alias: just add an entry here. All consumers update automatically.

export const NAME_ALIASES = {
  // OWGR name variants
  'Samuel Stevens':        'Sam Stevens',
  'Vincent Whaley':        'Vince Whaley',
  'Rafa Cabrera Bello':    'Rafael Cabrera Bello',
  'Si Woo Kim':            'Si-Woo Kim',
  'Byeong Hun An':         'Byeong-Hun An',

  // PGA Tour field page name variants
  'Nico Echavarria':       'Nicolas Echavarria',

  // OWGR bracket suffixes (birth dates, amateur status)
  // These are also stripped by cleanName() in AdminView, but kept here as a safety net
  'Jackson Koivun(Am)':    'Jackson Koivun',
  'Daniel Brown(Oct1994)': 'Daniel Brown',
  'Trace Crowe(Oct1996)':  'Trace Crowe',
  'Tyler Duncan(Jul1989)': 'Tyler Duncan',
  'Sanghyun Park(Apr1983)':'Sanghyun Park',
};

// Reverse map: canonical name -> alternate name
export const NAME_ALIASES_REVERSE = Object.fromEntries(
  Object.entries(NAME_ALIASES).map(([alt, canonical]) => [canonical, alt])
);

// Resolve a name to its canonical form
export function resolveAlias(name) {
  return NAME_ALIASES[name?.trim()] || name?.trim();
}

// Get all known variants of a name (canonical + any alternates)
export function allNameVariants(name) {
  const variants = new Set([name]);
  if (NAME_ALIASES[name]) variants.add(NAME_ALIASES[name]);
  if (NAME_ALIASES_REVERSE[name]) variants.add(NAME_ALIASES_REVERSE[name]);
  return variants;
}
