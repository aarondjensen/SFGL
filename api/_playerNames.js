// api/_playerNames.js — SINGLE SOURCE OF TRUTH for player-name identity.
// ============================================================================
// This module answers exactly one question, everywhere in the app:
//
//     "Are these two strings the same golfer?"
//
// It is imported by BOTH deploy targets:
//   • the serverless functions (api/*.js) — plain ESM, no node built-ins
//   • the browser bundle (src/**)         — via `import … from '../../api/_playerNames.js'`
// The leading underscore tells Vercel not to route it as a function.
//
// Having one physical file is the point. The bug this module exists to kill
// came from having SIX name normalizers and TWO contradictory alias tables
// spread across the two deploy targets, each with a "⚠ keep in sync" comment
// that nobody could keep in sync:
//
//   src/utils/sharedHelpers.js  normalizeNordic   — diacritics, no lowercase
//   src/utils/index.js          normalizePlayerName — lowercase, strips . and -
//   api/field.js                normName          — no ø/æ folding
//   api/cron.js                 normalizeName     — no hyphen handling
//   api/cron.js                 (inline norm)     — a 4th variant
//   src/constants/nameAliases.js NAME_ALIASES     — 'K.H. Lee' → 'Kyoung-Hoon Lee'
//   src/constants/index.js      PLAYER_NAME_ALIASES — 'kyoung-hoon lee' → 'K.H. Lee'
//                                                    (…pointing the other way)
//
// ── WHY ONE-WAY ALIASING FAILED ─────────────────────────────────────────────
// The old design rewrote incoming API names to a "canonical" form and then
// compared them to roster names RAW. That only works if every roster entry is
// already stored canonically. It never is — managers draft a player under
// whatever name the app showed them that week, so rosters accumulate both
// forms. When a roster held 'Nico Echavarria' and /api/field emitted the
// canonical 'Nicolas Echavarria', the ⛳ flag, the "Playing" filter, the tee
// time, the odds, the live score, the Wednesday "not in the field" push, AND
// the earnings attribution all silently disagreed with reality.
//
// So we do not rewrite names. We compute an EQUIVALENCE CLASS for each name —
// a set of match keys — and two names are the same golfer when their key sets
// intersect. That is symmetric: it does not matter which form is stored where.
//
// ── THE FOUR LAYERS OF EQUIVALENCE ──────────────────────────────────────────
//   1. Mechanical  — case, diacritics, Nordic letters, punctuation, "Last,
//                    First", (Am)/(Oct1994) suffixes, Jr/III suffixes.
//   2. Structural  — spaceless form (Sung-Jae Im ≡ Sungjae Im) and initials
//                    form (Kyoung-Hoon Lee ≡ K.H. Lee).
//   3. Nicknames   — given-name equivalence groups (nico ≡ nicolas,
//                    matt ≡ matthew, cam ≡ cameron …). This is the piece that
//                    generalizes: it fixes the NEXT Nico without an edit.
//   4. Explicit    — ALIAS_GROUPS, for the handful of pairs no rule can derive
//                    (Eric Cole / Edward Cole, Francesco / Francisco Molinari).
//
// ── SAFETY: AMBIGUITY IS DROPPED, NEVER GUESSED ─────────────────────────────
// Layers 2 and 3 are generative, so they can in principle collide (two
// different golfers producing the same derived key). buildNameIndex detects
// that and DROPS the colliding key rather than picking a winner. A collision
// therefore degrades to "no match found", never to "matched the wrong golfer".
// Showing a manager no tee time is a small bug; showing them another player's
// CUT status is a trust-destroying one.
// ============================================================================

// ── Layer 1: mechanical normalization ────────────────────────────────────────

// Letters that carry no combining mark, so NFD decomposition leaves them
// alone. api/field.js's normName folded only combining marks, which is why it
// matched 'Højgaard' but not 'Ludvig Åberg' vs a source spelling 'Aberg'
// inconsistently — ø and æ are precomposed codepoints, not a + mark.
const CHAR_FOLD = {
  'ø': 'o', 'Ø': 'o', 'æ': 'ae', 'Æ': 'ae', 'œ': 'oe', 'Œ': 'oe',
  'ß': 'ss', 'đ': 'd', 'Đ': 'd', 'ð': 'd', 'Ð': 'd',
  'þ': 'th', 'Þ': 'th', 'ł': 'l', 'Ł': 'l', 'ı': 'i', 'İ': 'i',
};
const CHAR_FOLD_RE = new RegExp(`[${Object.keys(CHAR_FOLD).join('')}]`, 'g');

// Generational suffixes stripped from the END of a name only. 'V' is
// deliberately excluded — a bare trailing "v" is far more likely to be part of
// a real name than a fifth-generation suffix.
const GENERATIONAL_SUFFIXES = new Set(['jr', 'jnr', 'sr', 'snr', 'ii', 'iii', 'iv']);

/**
 * The primary match key for a name: lowercase, unaccented, unpunctuated,
 * single-spaced, suffix-free.
 *
 *   nameKey('Nico Echavarria')      → 'nico echavarria'
 *   nameKey('Si-Woo Kim')           → 'si woo kim'
 *   nameKey('K.H. Lee')             → 'kh lee'
 *   nameKey('Ludvig Åberg')         → 'ludvig aberg'
 *   nameKey('Rasmus Højgaard')      → 'rasmus hojgaard'
 *   nameKey('Harold Varner III')    → 'harold varner'
 *   nameKey('Koivun, Jackson (Am)') → 'jackson koivun'
 *
 * Two names with the same primary key are always the same golfer. The reverse
 * does not hold — that is what nameVariants() is for.
 */
export function nameKey(name) {
  let s = String(name ?? '');
  if (!s) return '';

  // Parenthetical qualifiers: OWGR appends '(Am)' for amateurs and
  // '(Oct1994)' to disambiguate same-named players. Neither is part of the
  // name. AdminView used to strip these with its own regex before alias
  // lookup; that step lives here now so every caller gets it.
  s = s.replace(/\([^)]*\)/g, ' ');

  // "Last, First" → "First Last". Leaderboard and field payloads use both
  // orders, sometimes within the same __NEXT_DATA__ blob. Must run before
  // punctuation stripping, while the comma is still there to key on.
  const commaParts = s.split(',');
  if (commaParts.length === 2 && commaParts[0].trim() && commaParts[1].trim()) {
    s = `${commaParts[1].trim()} ${commaParts[0].trim()}`;
  }

  s = s.toLowerCase()
    .replace(CHAR_FOLD_RE, (c) => CHAR_FOLD[c] ?? c)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')  // strip combining marks
    .replace(/[^a-z0-9]+/g, ' ')       // periods, apostrophes, hyphens, symbols
    .trim();

  if (!s) return '';

  // Drop trailing generational suffixes, but never the only token — a lone
  // "III" is not a name we can do anything with, and blanking it would make
  // it match every other blank.
  const tokens = s.split(' ');
  while (tokens.length > 1 && GENERATIONAL_SUFFIXES.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }

  // Re-join runs of single-letter given-name tokens, so the two ways sources
  // punctuate an initialled name land on the SAME primary key rather than on
  // two keys that only meet via a derived variant:
  //   'K.H. Lee' → k h lee → 'kh lee'   ≡   'KH Lee' → 'kh lee'
  //   'J.J. Spaun' → j j spaun → 'jj spaun'
  // Only runs of 2+ are joined, and never the surname: 'Charles H. Howell'
  // keeps its lone middle initial as its own token.
  const joined = [];
  for (let i = 0; i < tokens.length; i++) {
    if (i < tokens.length - 1 && tokens[i].length === 1) {
      let run = tokens[i];
      while (i + 1 < tokens.length - 1 && tokens[i + 1].length === 1) { run += tokens[++i]; }
      joined.push(run);
    } else {
      joined.push(tokens[i]);
    }
  }
  return joined.join(' ');
}

// ── Layer 3: given-name equivalence groups ───────────────────────────────────
//
// Each row is a set of interchangeable renderings of the SAME given name.
// These are applied to the first token only, and only when the surname
// matches, so grouping 'nick' with 'nicolas' cannot merge two different
// golfers — it can only merge two spellings of one surname-sharing first name.
//
// This is the layer that makes the system general rather than a lookup table.
// Adding 'nico'/'nicolas' fixed Echavarria AND every future Nico; 'matt'/
// 'matthew' covers Fitzpatrick, Kuchar, Wallace and McCarty in one row, which
// is why those four disappear from the explicit alias list below.
//
// Rule for adding a row: only group renderings that are genuinely the same
// name. 'davis' is NOT short for 'david' (Davis Riley, Davis Thompson are
// their own name), and 'francisco' is NOT 'francesco' — those belong in
// ALIAS_GROUPS as one-off corrections, not here.
const GIVEN_NAME_GROUPS = [
  ['nico', 'nicolas', 'nicholas', 'nick', 'nicky'],
  ['matt', 'matthew', 'matty'],
  ['will', 'william', 'bill', 'billy', 'willie'],
  ['ben', 'benjamin', 'benny'],
  ['cam', 'cameron'],
  ['alex', 'alexander', 'xander'],
  ['chris', 'christopher'],
  ['joe', 'joseph', 'joey'],
  ['mike', 'michael', 'mikey'],
  ['dave', 'david', 'davey'],
  ['jim', 'james', 'jimmy'],
  ['tom', 'thomas', 'tommy'],
  ['rob', 'robert', 'bob', 'bobby', 'robby', 'robbie'],
  ['rick', 'richard', 'rich', 'richie'],
  ['steve', 'stephen', 'steven', 'stevie'],
  ['dan', 'daniel', 'danny'],
  ['sam', 'samuel', 'sammy'],
  ['doug', 'douglas'],
  ['greg', 'gregory'],
  ['jeff', 'jeffrey', 'geoff', 'geoffrey'],
  ['ted', 'theodore', 'teddy'],
  ['tony', 'anthony'],
  ['charlie', 'charles', 'charley', 'chuck'],
  ['andy', 'andrew', 'drew'],
  ['zach', 'zachary', 'zac', 'zack'],
  ['nate', 'nathan', 'nathaniel'],
  ['ken', 'kenneth', 'kenny'],
  ['ron', 'ronald', 'ronnie'],
  ['pat', 'patrick', 'paddy'],
  ['vince', 'vincent', 'vinny'],
  ['tim', 'timothy', 'timmy'],
  ['ed', 'edward', 'eddie'],
  ['phil', 'philip', 'phillip'],
  ['rafa', 'rafael', 'raphael'],
  ['seb', 'sebastian'],
  ['max', 'maximilian', 'maxwell'],
  ['jon', 'john', 'jonathan', 'johnny', 'jonny'],
  ['tony', 'antonio'],
  ['fred', 'frederick', 'freddie', 'freddy'],
  ['harry', 'harold'],
  ['larry', 'lawrence', 'laurence'],
  ['ollie', 'oliver'],
];

// given-name token → array of equivalent tokens (including itself).
// Rows sharing a token (e.g. the three 'tony' rows) are unioned, so
// 'tony' ≡ 'anthony' ≡ 'antonio' ≡ 'anton' all resolve together.
const GIVEN_NAME_EQUIV = (() => {
  const parent = new Map();
  const find = (x) => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(x) !== r) { const n = parent.get(x); parent.set(x, r); x = n; }
    return r;
  };
  const add = (x) => { if (!parent.has(x)) parent.set(x, x); };
  for (const group of GIVEN_NAME_GROUPS) {
    group.forEach(add);
    for (let i = 1; i < group.length; i++) parent.set(find(group[i]), find(group[0]));
  }
  const byRoot = new Map();
  for (const token of parent.keys()) {
    const root = find(token);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(token);
  }
  const out = new Map();
  for (const token of parent.keys()) out.set(token, byRoot.get(find(token)));
  return out;
})();

// ── Layer 4: explicit alias groups ───────────────────────────────────────────
//
// Only for pairs the mechanical + structural + nickname layers CANNOT derive.
// Each row is one golfer; the FIRST entry is the canonical form used as the
// /players/{name} Firestore document ID.
//
// ⚠ The first entry of each row is a Firestore document ID. Changing it
// orphans that player's doc (rankings, headshot ids, career stats). The eight
// rows carried over from the old src/constants/nameAliases.js keep their
// original canonical spelling for exactly that reason, even where the other
// spelling is what pgatour.com now uses.
export const ALIAS_GROUPS = [
  // ── Carried over from the previous NAME_ALIASES map (canonical preserved) ──
  ['Sam Stevens', 'Samuel Stevens'],
  ['Vince Whaley', 'Vincent Whaley'],
  ['Rafael Cabrera Bello', 'Rafa Cabrera Bello'],
  ['Si Woo Kim', 'Si-Woo Kim'],
  ['Byeong-Hun An', 'Byeong Hun An', 'Ben An'],
  ['Nicolas Echavarria', 'Nico Echavarria'],
  ['Kyoung-Hoon Lee', 'K.H. Lee', 'KH Lee'],
  ['Sung-Hyun Kim', 'S.H. Kim', 'SH Kim'],

  // ── Folded in from constants/index.js PLAYER_NAME_ALIASES ──────────────────
  // That table pointed the OPPOSITE way for two of these ('kyoung-hoon lee' →
  // 'K.H. Lee', 'byeong hun an' → 'Byeong Hun An'), so whichever table a code
  // path happened to consult decided which spelling won. It fed only
  // resolvePlayerName(), which had zero call sites — dead code with a live
  // contradiction in it. Both tables are now this one list, and because
  // matching is by equivalence class rather than by rewrite, the direction no
  // longer changes any answer.
  ['Sungjae Im', 'Sung-Jae Im', 'Seung-Jae Im'],
  ['Min Woo Lee', 'Min-Woo Lee'],
  ['C.T. Pan', 'Cheng-Tsung Pan', 'CT Pan'],
  ['Eric Cole', 'Edward Cole'],              // not a nickname — a real mismatch
  ['Francesco Molinari', 'Francisco Molinari'], // Italian vs Spanish spelling
  ['Robert MacIntyre', 'Bob MacIntyre'],
  ['Haotong Li', 'Hao Tong Li', 'Li Haotong'],
];

/** Alternate spelling → canonical spelling. Derived from ALIAS_GROUPS. */
export const NAME_ALIASES = (() => {
  const out = {};
  for (const [canonical, ...alternates] of ALIAS_GROUPS) {
    for (const alt of alternates) out[alt] = canonical;
  }
  return out;
})();

// primary key → every name in that alias group (both directions).
const ALIAS_EQUIV = (() => {
  const out = new Map();
  for (const group of ALIAS_GROUPS) {
    for (const name of group) out.set(nameKey(name), group);
  }
  return out;
})();

/**
 * Resolve an alternate spelling to its canonical form, for the paths that
 * genuinely need a single winner — picking the /players/{name} document ID.
 * Everything that merely COMPARES names should use namesMatch/NameSet instead;
 * those do not care which spelling is canonical.
 */
export function resolveAlias(name) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) return trimmed;
  if (NAME_ALIASES[trimmed]) return NAME_ALIASES[trimmed];
  const group = ALIAS_EQUIV.get(nameKey(trimmed));
  return group ? group[0] : trimmed;
}

// ── Layer 2 + assembly: the variant set ──────────────────────────────────────

/**
 * The match keys for a name, split into two confidence tiers.
 *
 *   strong — keys that preserve the name's information: the primary key, the
 *            other spellings in its alias group, the spaceless form, and
 *            given-name nickname swaps. A meeting on any of these is a match.
 *
 *   weak   — the initials form only. This derivation is LOSSY: 'Jin Man Smith'
 *            and 'Jae Min Smith' both reduce to 'jm smith', so a weak key is
 *            trusted only when it meets a STRONG key on the other side — i.e.
 *            when the other name is genuinely written in initials form
 *            ('K.H. Lee'). Two weak keys meeting proves nothing and is never
 *            treated as a match.
 *
 * That tier split is what lets 'Kyoung-Hoon Lee' ≡ 'K.H. Lee' coexist with
 * 'Jin Man Smith' ≢ 'Jae Min Smith'.
 */
export function nameVariantTiers(name) {
  const strong = new Set();
  const weak = new Set();
  const primary = nameKey(name);
  if (!primary) return { strong, weak };

  // Seed with the primary key plus every spelling in the same alias group.
  const seeds = new Set([primary]);
  const group = ALIAS_EQUIV.get(primary);
  if (group) for (const alt of group) { const k = nameKey(alt); if (k) seeds.add(k); }

  for (const seed of seeds) {
    strong.add(seed);
    const tokens = seed.split(' ');
    if (tokens.length < 2) continue;

    const last = tokens[tokens.length - 1];
    const given = tokens.slice(0, -1);

    // Spaceless form. Unifies the East-Asian given names that sources render
    // as one token or two — 'Sung-Jae Im' / 'Sungjae Im' / 'Sung Jae Im' all
    // collapse to 'sungjaeim'. Lossless (no letters discarded), so it is
    // strong: two names with the same letters in the same order are one
    // golfer.
    strong.add(seed.replace(/ /g, ''));

    // Initials forms. Both are LOSSY, so both are weak: they only count when
    // they meet a STRONG key on the other side — i.e. when the other name is
    // genuinely written in initials form.
    //
    //   full initials  'Kyoung-Hoon Lee' → 'kh lee'   meets 'K.H. Lee'
    //   first initial  'Viktor Hovland'  → 'v hovland' meets 'V. Hovland',
    //                  which is how pgatour.com's leaderboard abbreviates on
    //                  narrow layouts.
    //
    // Being weak is what keeps 'Sam Stevens' and 'Scott Stevens' apart: both
    // produce 's stevens', but two weak keys meeting proves nothing. And a
    // leaderboard row literally named 'S. Stevens' is genuinely ambiguous
    // between them — buildNameIndex drops that key rather than guessing.
    if (given.length >= 2) {
      weak.add(`${given.map((t) => t[0]).join('')} ${last}`);
    }
    weak.add(`${given[0][0]} ${last}`);

    // Nicknames: swap the first token through its equivalence group. Later
    // tokens are left alone — middle names and surnames are not nicknamed.
    // Strong: the surname is untouched and the given name is a known
    // rendering of the same name, not an abbreviation of an unknown one.
    const equivalents = GIVEN_NAME_EQUIV.get(given[0]);
    if (equivalents) {
      const rest = tokens.slice(1).join(' ');
      for (const alt of equivalents) {
        if (alt === given[0]) continue;
        const swapped = `${alt} ${rest}`;
        strong.add(swapped);
        strong.add(swapped.replace(/ /g, ''));
      }
    }
  }
  return { strong, weak };
}

/**
 * Every match key for a name, both tiers flattened. Handy for inspection and
 * for the audit; matching itself should go through namesMatch or NameSet,
 * which respect the tier rules.
 */
export function nameVariants(name) {
  const { strong, weak } = nameVariantTiers(name);
  return new Set([...strong, ...weak]);
}

/**
 * True when both strings denote the same golfer. Symmetric, and safe on empty
 * input (two blanks never match).
 *
 * Matches on strong∩strong, strong∩weak or weak∩strong — never weak∩weak.
 */
export function namesMatch(a, b) {
  const va = nameVariantTiers(a);
  if (!va.strong.size) return false;
  const vb = nameVariantTiers(b);
  if (!vb.strong.size) return false;
  for (const key of vb.strong) if (va.strong.has(key) || va.weak.has(key)) return true;
  for (const key of vb.weak) if (va.strong.has(key)) return true;
  return false;
}

// ── Index: many-names-vs-many-names matching ─────────────────────────────────

/**
 * Build a variant-key → name index over a list of names.
 *
 * Names are first collapsed into EQUIVALENCE GROUPS by their strong keys, so a
 * list carrying two spellings of one golfer ('Nico Echavarria' AND 'Nicolas
 * Echavarria', which the field parser can emit when two page sections disagree)
 * indexes as a single entity instead of being reported as a conflict. The
 * group's representative is the first spelling seen, so lookups stay stable.
 *
 * Ambiguity is then only possible on WEAK (initials) keys, and it is the
 * safety property of the module: when a weak key is claimed by two different
 * groups, that key is DROPPED rather than resolved to whichever was inserted
 * first. Both golfers still match on their own strong keys. A collision
 * degrades to "no match", never to "matched the wrong golfer" — showing a
 * manager a blank tee time is a small bug; showing them another player's CUT
 * status destroys their trust in the page.
 *
 * Returns { index: Map<key, name>, ambiguous: Map<key, string[]>,
 *           groups: string[][] }.
 */
export function buildNameIndex(names) {
  // Dedupe by primary key, preserving input order.
  const primaries = new Map(); // primary key → name as given
  for (const name of names || []) {
    const primary = nameKey(name);
    if (!primary) continue;
    if (!primaries.has(primary)) primaries.set(primary, name);
  }

  const tiers = new Map();     // primary key → { strong, weak }
  for (const [primary, name] of primaries) tiers.set(primary, nameVariantTiers(name));

  // Union primaries that share any strong key — those are one golfer.
  const parent = new Map([...primaries.keys()].map((p) => [p, p]));
  const find = (x) => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(x) !== r) { const n = parent.get(x); parent.set(x, r); x = n; }
    return r;
  };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

  const strongClaims = new Map(); // strong key → first claiming primary
  for (const [primary, { strong }] of tiers) {
    for (const key of strong) {
      if (strongClaims.has(key)) union(primary, strongClaims.get(key));
      else strongClaims.set(key, primary);
    }
  }

  // Representative per group: the earliest-seen spelling, so the resolved name
  // is deterministic regardless of how the source ordered its payload.
  const representative = new Map(); // root → name
  const groups = new Map();         // root → [names]
  for (const [primary, name] of primaries) {
    const root = find(primary);
    if (!representative.has(root)) { representative.set(root, name); groups.set(root, []); }
    groups.get(root).push(name);
  }

  // Strong keys can no longer conflict — anything that collided was unioned.
  const index = new Map();
  for (const [key, primary] of strongClaims) index.set(key, representative.get(find(primary)));

  // Weak keys: keep only those claimed by exactly one group.
  const weakClaims = new Map(); // weak key → Set<root>
  for (const [primary, { weak }] of tiers) {
    for (const key of weak) {
      if (!weakClaims.has(key)) weakClaims.set(key, new Set());
      weakClaims.get(key).add(find(primary));
    }
  }

  const weakIndex = new Map();
  const ambiguous = new Map();
  for (const [key, roots] of weakClaims) {
    if (index.has(key)) continue;                 // a real strong key wins outright
    if (roots.size === 1) weakIndex.set(key, representative.get([...roots][0]));
    else ambiguous.set(key, [...roots].map((r) => representative.get(r)));
  }

  return { index, weakIndex, ambiguous, groups: [...groups.values()] };
}

/**
 * A Set of player names that matches by identity rather than by string.
 *
 *   const field = new NameSet(['Nicolas Echavarria', 'Ludvig Åberg']);
 *   field.has('Nico Echavarria')  // → true
 *   field.has('Ludvig Aberg')     // → true
 *
 * Drop-in for the `tournamentField` Set the views already carry: same .has()
 * and .size, except .has() takes the RAW name and does the normalizing itself.
 * Call sites therefore stop needing to remember which normalizer to apply —
 * forgetting that is how the whole class of bug got in.
 */
export class NameSet {
  constructor(names = []) {
    this._names = [...names];
    const { index, weakIndex, ambiguous, groups } = buildNameIndex(this._names);
    this._index = index;
    this._weakIndex = weakIndex;
    this.ambiguous = ambiguous;
    this.groups = groups;
  }

  /**
   * The name as stored in this set, or null when there is no match.
   *
   * Lookup order enforces the tier rule — a weak key on one side is only ever
   * trusted against a strong key on the other, never against another weak key.
   */
  resolve(name) {
    const { strong, weak } = nameVariantTiers(name);
    for (const key of strong) { const hit = this._index.get(key); if (hit) return hit; }
    for (const key of strong) { const hit = this._weakIndex.get(key); if (hit) return hit; }
    for (const key of weak) { const hit = this._index.get(key); if (hit) return hit; }
    return null;
  }

  has(name) { return this.resolve(name) !== null; }

  /** Number of distinct golfers, after collapsing equivalent spellings. */
  get size() { return this.groups.length; }

  toArray() { return [...this._names]; }
}

/**
 * A Map keyed by player identity — tee times, odds, earnings, headshots.
 *
 *   const tee = new NameMap([['Nicolas Echavarria', '8:24 AM']]);
 *   tee.get('Nico Echavarria')  // → '8:24 AM'
 *
 * Built once from entries; the variant index is computed up front so lookups
 * stay O(variants) rather than O(entries).
 */
export class NameMap {
  constructor(entries = []) {
    const pairs = entries instanceof Map ? [...entries] : (entries || []);
    this._values = new Map();
    const names = [];
    for (const [name, value] of pairs) {
      const primary = nameKey(name);
      if (!primary) continue;
      if (!this._values.has(primary)) names.push(name);
      this._values.set(primary, value);
    }
    this._set = new NameSet(names);
    this.ambiguous = this._set.ambiguous;
  }

  get(name) {
    const hit = this._set.resolve(name);
    return hit === null ? undefined : this._values.get(nameKey(hit));
  }

  has(name) { return this._set.resolve(name) !== null; }

  get size() { return this._values.size; }
}

// ── Audit: find the mismatches nobody has taught the system about yet ────────

/**
 * Levenshtein distance, capped — used only to rank audit suggestions, never to
 * decide a match. Fuzzy edit distance is exactly the kind of thing that
 * confidently pairs 'Alex Fitzpatrick' with 'Matt Fitzpatrick', so it stays
 * strictly advisory: a human confirms every suggestion through Merge Players.
 */
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * Rank candidate names by how plausibly they are the same golfer as `name`,
 * for a name that did NOT match. Ordered best-first, already filtered to
 * plausible ones.
 *
 * Scores above SUSPECTED_MISMATCH_SCORE mean "this is probably a name problem
 * on our end". Callers use that to decide whether to bother a manager: a
 * starter missing from the field with a high-scoring namesake IN the field is
 * a data problem, and telling the manager to bench them would be wrong.
 *
 * The scoring deliberately ranks a SURNAME TYPO above a SHARED SURNAME. Two
 * players with the same surname and unrelated given names are more likely to
 * be two people — the Fitzpatrick brothers, the Coody brothers, the Højgaard
 * twins — than one person spelled two ways. Whereas an identical given name
 * beside a one-character surname difference is almost always one person typed
 * twice. Getting that ordering backwards would suppress a legitimate "your
 * starter isn't playing" alert every time a roster and a field held two
 * different members of the same golfing family.
 */
export const SUSPECTED_MISMATCH_SCORE = 70;

export function suggestMatches(name, candidates, limit = 3) {
  const key = nameKey(name);
  if (!key) return [];
  const tokens = key.split(' ');
  const last = tokens[tokens.length - 1];
  const first = tokens[0];

  const scored = [];
  for (const candidate of candidates || []) {
    const ck = nameKey(candidate);
    if (!ck || ck === key) continue;
    const ct = ck.split(' ');
    const clast = ct[ct.length - 1];
    const cfirst = ct[0];

    const lastD = editDistance(last, clast);
    const firstD = Math.min(editDistance(first, cfirst), 10);

    let score = 0;
    let reason = '';
    if (lastD === 0) {
      if (cfirst[0] === first[0] && firstD <= 3) {
        // 'Nico' vs 'Nicolas' — a given-name rendering our rules don't know.
        score = 95 - firstD;
        reason = 'same surname, near-identical given name';
      } else if (cfirst[0] === first[0]) {
        // Same initial but a genuinely different name ('Sam' vs 'Scott').
        // Worth showing, not worth acting on unprompted.
        score = 62 - firstD;
        reason = 'same surname, same first initial';
      } else {
        // The brothers case. Surfaced as a candidate, deliberately scored
        // below the suspected-mismatch threshold.
        score = 55 - firstD;
        reason = 'same surname';
      }
    } else if (lastD <= 2) {
      if (cfirst === first) {
        // 'Kiradech Aphibarnat' vs 'Kiradech Aphibarnrat' — a typo.
        score = 92 - lastD * 6;
        reason = `same given name, ${lastD}-character surname difference`;
      } else if (cfirst[0] === first[0] && firstD <= 3) {
        score = 80 - lastD * 6 - firstD;
        reason = 'similar given name and surname';
      } else {
        score = 40 - lastD * 5;
        reason = 'similar surname';
      }
    } else {
      const d = editDistance(key, ck);
      if (d <= 3) { score = 45 - d * 3; reason = `${d}-character difference`; }
    }
    if (score > 0) scored.push({ name: candidate, score, reason });
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Cross-reference a list of names against a reference list and report what
 * could not be matched, with suggestions.
 *
 * This is the automatic half of the fix. The matching layers above handle
 * every mismatch we know how to describe; this handles the ones we don't, by
 * making them VISIBLE — to the commissioner, before a manager notices their
 * player is missing — instead of silently rendering as "not playing".
 *
 *   auditNames({ names: rosterNames, reference: fieldNames })
 *     → { checked, matched, unmatched: [{ name, suggestions: [{name, reason}] }],
 *         ambiguous: [{ key, names }] }
 */
export function auditNames({ names = [], reference = [] }) {
  const set = new NameSet(reference);
  const unmatched = [];
  let matched = 0;

  for (const name of names) {
    if (!nameKey(name)) continue;
    if (set.has(name)) { matched++; continue; }
    unmatched.push({ name, suggestions: suggestMatches(name, reference) });
  }

  return {
    checked: matched + unmatched.length,
    matched,
    unmatched,
    ambiguous: [...set.ambiguous].map(([key, names_]) => ({ key, names: names_ })),
  };
}
