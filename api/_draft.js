// api/_draft.js — keepers, the draft, and the season rollover.
// ============================================================================
// SHARED BY BOTH DEPLOY TARGETS. See api/_league.js for why a shared module has
// to live under api/ (short version: api/ cannot import from src/, but Vite can
// bundle api/ into the browser build, so api/ is the only directory both sides
// can reach).
//
// _league.js holds constants and the wall clock, _rules.js holds the in-season
// rules. This file holds the BETWEEN-SEASONS rules: who may be kept, what a
// keeper or a draft pick is worth in stars, what order the draft runs in, and
// what a team looks like on the first day of the new season.
//
// Everything here is pure. No Firebase, no DOM, no Node built-ins — the draft
// screen in the browser and any future server-side rollover run the same code,
// which is the whole reason the swing rules moved here in the first place.
//
// ── The rules, as the league states them ────────────────────────────────────
//
//   • Each manager tags TWO keepers: one yellow and one blue.
//   • ANYONE can be the yellow keeper, whatever colour he is now, unless he
//     already has three years of service.
//   • The blue keeper can only be an existing WHITE player, tagged blue at
//     declaration. Blue is a one-year designation and cannot be renewed.
//   • Everyone not kept goes back into the draft with NOTHING — no colour, no
//     stars, no years of service. The pool is uniform.
//   • The draft order is REVERSE final standings (last place picks first) and
//     SNAKES every round.
//   • The first two rounds are the yellow rounds; everything after them is
//     white. The ROUND decides the colour, and nothing a player was before
//     carries into it.
//   • Picks are tradeable, so a pick's owner and the team whose slot it is are
//     two different things.
//
// ── Years of service is the only quantity here ──────────────────────────────
//
// There is one number, and the stars ARE it. A yellow player's star count is
// his years of service, three is the ceiling, and every rule above is a
// statement about that number:
//
//   white   0 years — uncommitted
//   blue    1 year  — the designation year counts, though it shows no star
//   yellow  1-3     — one star per year of service
//
// This is why a blue keeper tagged yellow arrives on TWO stars, and why that
// needed no special case in the end: his blue season was year one, so one more
// makes two. It was modelled here for a while as a "retroactive star" granted
// on promotion, which produced the same answer by a longer route and needed a
// separate rule to say which players had earned it. Years of service answers
// it directly, and keeper eligibility is then the same test for everybody:
// fewer than three.
//
// ── The tiers, and every move between them ──────────────────────────────────
//
// Three tiers, and the middle one is a designation rather than a description.
// Yellow is limited: start-capped, starred, on a keeper clock. BLUE is the
// unlimited keeper — one per team per year, a one-year option. White is
// everybody else, uncapped and uncommitted. All three render distinctly (blue
// is checked first, then yellow, then the fall-through to white).
//
//   from → to         allowed  how, and what it costs
//   ───────────────────────────────────────────────────────────────────────
//   any → yellow      yes      the yellow keeper slot, if he has fewer than
//                              three years of service. +1 year, +1 star:
//                              white → 1, blue → 2, yellow → his next
//   white → blue      yes      the blue keeper slot. No star, but the season
//                              is year one of his service
//   released → pool   yes      not kept: he re-enters the draft STRIPPED —
//                              no colour, no stars, no years. The pool is
//                              uniform, so what he used to be cannot follow
//                              him onto his next roster
//   drafted → yellow  yes      rounds 1-2. One star, one year, always
//   drafted → white   yes      rounds 3+. Nothing, always
//   blue → blue       NO       one year only. Tag him yellow or release him
//   yellow → blue     NO       no path anywhere, a correction included — see
//                              starCorrectionOverrides
//   blue → white      NO       not a move a manager makes. An unkept blue is
//                              RELEASED and wiped, not demoted in place
//   4 years of svc    NO       three is the ceiling for the keeper slot
//
// The old "once limited, always limited" rule still holds WITHIN a season —
// buildPlayerAttributeIndex and hydratePlayer refuse to downgrade a yellow, so
// dropping and re-adding him mid-season cannot shed his start cap. It does not
// reach across the draft: the rollover strips everyone it does not keep, and
// the round decides what a drafted player is.
//
// Every row has a test in scripts/test-draft.mjs, the refusals included.
// ============================================================================

import { getSeasonEarningsByTeam } from './_rules.js';
import { NameSet, NameMap } from './_playerNames.js';

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Three years of service is the ceiling for the keeper slot; the fourth is
 * not offered. Named for years rather than for stars because years is the
 * quantity the rule is about — the stars are how a yellow player's years are
 * drawn.
 */
export const KEEPER_MAX_YEARS = 3;

/** One limited keeper, one unlimited keeper. Order matters for display only. */
export const KEEPER_SLOTS = ['limited', 'unlimited'];

/** Rounds at the top of the draft that produce LIMITED players. */
export const DEFAULT_LIMITED_ROUNDS = 2;

/** Draft lifecycle. `setup` → `keepers` → `drafting` → `complete`. */
export const DRAFT_STATUS = {
  SETUP:    'setup',
  KEEPERS:  'keepers',
  DRAFTING: 'drafting',
  COMPLETE: 'complete',
};

// ── Player tier helpers ──────────────────────────────────────────────────────

/**
 * The star count the app actually SHOWS for a player, which is not always the
 * one stored.
 *
 * RostersView renders `'⭐'.repeat(player.stars || 1)` for a limited player, and
 * makePlayer stores `limited ? (stars || 1) : 0` — so a limited roster entry
 * carrying `stars: 0` reads as ONE star everywhere a manager can see it. Rows
 * predating the star field are exactly that shape. Judging keeper eligibility
 * on the raw field would let such a player be kept a season longer than the
 * badge beside his name says he has left, and there is no way for a manager to
 * discover that except by counting seasons by hand.
 */
export const effectiveStars = (player) => {
  if (!player?.limited) return 0;
  const n = Number(player.stars);
  return Number.isFinite(n) && n > 0 ? n : 1;
};

/**
 * Does this player start without a cap?
 *
 * `!limited` rather than `unlimited === true`, deliberately: limitedStartsStatus
 * caps `limited` players and nobody else, so to every START rule in the app
 * "not gold" IS "uncapped", and that covers blue and plain white alike. Rows
 * written before the tier flags existed are the same shape.
 *
 * This answers a question about STARTS. It is not the keeper question — see
 * canBeMadeUnlimited, which is narrower, because the blue designation is a
 * thing you spend rather than a description of a start cap.
 */
export const isUnlimitedTier = (player) => !!player && !player.limited;

/**
 * May this player be made the team's UNLIMITED keeper?
 *
 * Only a plain white player. Blue is a ONE-YEAR designation: when the year is
 * up he is either tagged into the limited slot — collecting the retroactive
 * star for it — or he goes back into the draft. He cannot be parked in blue a
 * second time.
 *
 * That rule is what gives the designation its cost. Without it a manager could
 * hold a player at zero stars indefinitely and start his keeper clock whenever
 * it suited them, which is three seasons of control for the price of one slot
 * a year. With it, blue is a one-year option that must be exercised.
 */
export const canBeMadeUnlimited = (player) =>
  !!player && !player.limited && !player.unlimited;

/**
 * A player's YEARS OF SERVICE — the one number the keeper rule is about.
 *
 * Derived from his colour rather than read off the `yearsOfService` field,
 * deliberately. That field counts seasons on a roster, which is a different
 * thing: it is incremented for white players too, it was never maintained by
 * anything (see the note on `stars`), and the 2026 seed lifted from the sheet
 * carries star counts with no years beside them. Colour is the authority the
 * league actually keeps, so colour is what this reads.
 *
 *   yellow  his star count — one star per year served
 *   blue    1 — the designation year counts, though it shows no star
 *   white   0 — uncommitted
 *
 * The blue year counting is the whole of the "retroactive star": tag a blue
 * keeper yellow and `years + 1` is two, with no special case to maintain.
 */
export const yearsOfServiceOf = (player) => {
  if (!player) return 0;
  if (player.limited) return effectiveStars(player);
  if (player.unlimited) return 1;
  return 0;
};

// ── Keeper eligibility ───────────────────────────────────────────────────────

/**
 * Where a player stands as a keeper candidate.
 *
 * Returns:
 *   tier               'limited' (yellow) | 'unlimited' (blue) | 'plain' (white)
 *   years              years of service — the number the rule is about
 *   stars              the badge count; for a yellow player, the same number
 *   maxYears           the league's keeper ceiling
 *   limited            { eligible, starsIfKept, promotion, reason }
 *   unlimited          { eligible, reason }
 *
 * `reason` is filled in ONLY when the slot is unavailable, and it is written
 * for a manager rather than for a log — it is what the keeper sheet shows
 * under a greyed-out player.
 */
export const keeperStatus = (player, { maxYears = KEEPER_MAX_YEARS } = {}) => {
  const limited = !!player?.limited;
  const years = yearsOfServiceOf(player);
  const promotion = !limited;

  // ANYONE may be the yellow keeper — whatever colour he is now — unless he
  // already has the maximum years of service. One test for all three tiers,
  // which is what collapsed when years of service became the only quantity:
  // this used to ask about colour first and then apply a different star sum to
  // each answer.
  const limitedEligible = years < maxYears;

  return {
    tier: limited ? 'limited' : player?.unlimited ? 'unlimited' : 'plain',
    years,
    // Kept under its old name as well: the badge, the keeper sheet and the
    // seed all talk in stars, and for a yellow player the two are the same
    // number by construction.
    stars: effectiveStars(player),
    maxYears,
    // His blue year is spent: this is the last offseason he can be kept at
    // all, because blue cannot be renewed. Surfaced here rather than
    // recomputed in the view, so the warning and the eligibility it is warning
    // about come from one place.
    unlimitedYearExpiring: !limited && !!player?.unlimited,
    limited: {
      eligible: limitedEligible,
      starsIfKept: years + 1,
      promotion,
      reason: limitedEligible
        ? null
        : `${years} years of service — ${maxYears} is the maximum`,
    },
    unlimited: {
      eligible: canBeMadeUnlimited(player),
      // Two different refusals, because they call for two different things
      // from the manager. A yellow player was never a candidate; a blue player
      // is one whose year is UP, and the useful thing to tell his manager is
      // what the alternative now is.
      reason: canBeMadeUnlimited(player)
        ? null
        : limited
          ? 'already yellow — only a white player can be tagged blue'
          : 'his blue year is up — tag him yellow now, or he goes back into the draft',
    },
  };
};

/** Convenience: may this player fill this slot? */
export const canKeep = (player, slot, opts) => {
  const status = keeperStatus(player, opts);
  return slot === 'limited' ? status.limited.eligible
       : slot === 'unlimited' ? status.unlimited.eligible
       : false;
};

// ── What a player looks like in the new season ───────────────────────────────

/**
 * Season tallies that are reset by the rollover, and the ones that are not.
 *
 * `starts` is the limited-start cap's counter and the cap is PER SEASON, so it
 * has to go back to zero — and it has to go back to zero through
 * registryOverrides, because the durable registry merges tallies with Math.max
 * and would otherwise re-inflate it on the very next team save.
 *
 * eventsPlayed / cutsMade / pgaTourEarnings / sfglEarnings are career figures
 * (that is what the registry header calls them, and what the Rosters stats
 * columns display), so the rollover leaves them alone.
 */
export const SEASON_RESET_FIELDS = { starts: 0 };

const carriedTallies = (prior) => ({
  eventsPlayed:    Number(prior?.eventsPlayed)    || 0,
  cutsMade:        Number(prior?.cutsMade)        || 0,
  pgaTourEarnings: Number(prior?.pgaTourEarnings) || 0,
  sfglEarnings:    Number(prior?.sfglEarnings)    || 0,
  headshot:        prior?.headshot || '',
});

/**
 * The roster entry a KEPT player carries into the new season.
 *
 * Throws on a slot the player is not eligible for rather than silently
 * producing an illegal roster entry — every caller here is a deliberate
 * commissioner or manager action with a UI that already knows the answer, so
 * reaching this with a bad slot is a bug, not a user mistake.
 */
export const keptPlayerAttrs = (player, slot, { maxYears = KEEPER_MAX_YEARS } = {}) => {
  if (!player?.name) throw new Error('keptPlayerAttrs: no player');
  const status = keeperStatus(player, { maxYears });
  if (slot === 'limited' && !status.limited.eligible) {
    throw new Error(`${player.name} cannot be kept as a yellow keeper: ${status.limited.reason}`);
  }
  if (slot === 'unlimited' && !status.unlimited.eligible) {
    throw new Error(`${player.name} cannot be kept as a blue keeper: ${status.unlimited.reason}`);
  }

  if (slot === 'limited') {
    // One more year of service, drawn as one more star. stars and
    // yearsOfService are written to the SAME number here so they cannot drift:
    // they are two renderings of one quantity, and the app shows both (the
    // badge on the headshot, the "(Yr N)" line beneath the name).
    const years = status.years + 1;
    return {
      name: player.name,
      limited: true,
      unlimited: false,
      stars: years,
      yearsOfService: years,
      ...SEASON_RESET_FIELDS,
      ...carriedTallies(player),
    };
  }

  // Blue: no star to show, but the season counts. That is what makes him
  // arrive on two if he is tagged yellow next year.
  return {
    name: player.name,
    limited: false,
    unlimited: true,
    stars: 0,
    yearsOfService: 1,
    ...SEASON_RESET_FIELDS,
    ...carriedTallies(player),
  };
};

/**
 * The roster entry a DRAFTED player carries into the new season.
 *
 * The ROUND decides the colour, and nothing the player was before reaches
 * into it. Rounds one and two are the yellow rounds — one star, one year, for
 * everybody taken there. Every round after is white, at nothing.
 *
 * `prior` is consulted ONLY for career tallies (SFGL earnings, cuts, events),
 * which belong to the golfer rather than to a roster spot. His colour, his
 * stars and his years of service are not read, because the rollover has
 * already stripped them: everyone not kept re-enters the pool with nothing, so
 * the pool is uniform and a player's history with his last team cannot follow
 * him onto his next one.
 *
 * This used to carry two rules forward from the old model, and both were
 * wrong once the pool was uniform:
 *
 *   • "once limited, always limited" made an unkept yellow come back yellow
 *     however late he was taken — so a 3-star player nobody kept could be
 *     drafted in round seven and give that team a FOURTH yellow, which the
 *     roster shape (three yellow, one blue, nine white) does not allow. That
 *     rule governs dropping and re-adding WITHIN a season, where it stops a
 *     manager shedding a start cap, and it has no business at the draft.
 *   • a "retroactive star" for a formerly-blue player, which double-counted
 *     once his blue year became a year of service in its own right.
 */
export const draftedPlayerAttrs = (name, {
  round, limitedRounds = DEFAULT_LIMITED_ROUNDS, prior = null,
} = {}) => {
  if (!name) throw new Error('draftedPlayerAttrs: no player name');
  const yellowRound = Number(round) <= Number(limitedRounds);

  return {
    name,
    limited: yellowRound,
    unlimited: false,
    stars: yellowRound ? 1 : 0,
    yearsOfService: yellowRound ? 1 : 0,
    ...SEASON_RESET_FIELDS,
    ...carriedTallies(prior),
  };
};

// ── Final standings → draft order ────────────────────────────────────────────

/**
 * The closing season's final standings, first place first.
 *
 * Earnings come from getSeasonEarningsByTeam — the same derivation StandingsView
 * displays and the waiver tie-breaker runs on — so the draft order cannot
 * disagree with the table the league read all year.
 *
 * Ties break on team id, which is arbitrary but STABLE: regenerating the order
 * must not reshuffle it. A real tie is the commissioner's to settle, and the
 * rollover panel lets them reorder by hand.
 */
export const seasonStandings = ({ teams = [], tournaments = [] } = {}) => {
  const earnings = getSeasonEarningsByTeam(tournaments);
  return (teams || [])
    .filter(t => t && (t.id || t.name))
    .map(t => ({
      teamId: t.id || t.name,
      name: t.name || t.id,
      earnings: earnings[t.id || t.name] || 0,
    }))
    .sort((a, b) => (b.earnings - a.earnings) || String(a.teamId).localeCompare(String(b.teamId)))
    .map((row, i) => ({ ...row, position: i + 1 }));
};

/** Reverse standings: last place picks first. */
export const draftOrderTeamIds = (standings = []) =>
  [...standings].sort((a, b) => b.position - a.position).map(r => r.teamId);

// ── The board ────────────────────────────────────────────────────────────────

/**
 * The full snake board, before any trades.
 *
 * `teamId` and `originalTeamId` start out the same. Trades move the first and
 * never the second — "Detroit's third-rounder" stays Detroit's slot however
 * many times it changes hands, which is what makes a traded pick describable.
 */
export const buildDraftOrder = ({
  teamIds = [], rounds = 0, limitedRounds = DEFAULT_LIMITED_ROUNDS,
} = {}) => {
  const order = [];
  const ids = (teamIds || []).filter(Boolean);
  if (!ids.length || rounds <= 0) return order;

  let overall = 1;
  for (let round = 1; round <= rounds; round++) {
    // Odd rounds run the order as given; even rounds run it backwards. That is
    // the snake, and it is applied to EVERY round — including the two limited
    // rounds at the top, which are not exempt from it.
    const sequence = round % 2 === 1 ? ids : [...ids].reverse();
    sequence.forEach((teamId, i) => {
      order.push({
        overall: overall++,
        round,
        pickInRound: i + 1,
        teamId,
        originalTeamId: teamId,
        limited: round <= limitedRounds,
      });
    });
  }
  return order;
};

/**
 * How many rounds the draft runs, given the roster limit and what was kept.
 *
 * A team fills a roster of `rosterLimit`, and every keeper is a roster spot it
 * does not have to draft. The count is UNIFORM across the league — a snake
 * needs every round to have the same teams in it — so it keys on the number of
 * keeper SLOTS, not on how many each team actually used. A team that tags
 * fewer keepers than it could simply carries a shorter roster, which is the
 * consequence of its own choice and not something the board can absorb.
 *
 * The commissioner can override the result; this is the default the rollover
 * panel offers.
 */
export const defaultDraftRounds = ({ rosterLimit = 13, keeperSlots = KEEPER_SLOTS.length } = {}) =>
  Math.max(0, (Number(rosterLimit) || 0) - (Number(keeperSlots) || 0));

/**
 * Apply pick trades to a board.
 *
 * A trade is `{ round, originalTeamId, toTeamId }` — "the pick that is
 * originally team X's in round N now belongs to team Y". Keying on the SLOT
 * rather than on an overall pick number is what lets the commissioner
 * regenerate or reorder the board (a corrected standing, a settled tie)
 * without every recorded trade sliding onto the wrong pick.
 *
 * Trades are applied in order, so a pick traded twice ends with its last
 * owner, and a trade naming a slot that no longer exists is ignored rather
 * than throwing — shortening the draft must not make the board unbuildable.
 */
export const applyPickTrades = (order = [], trades = []) => {
  const next = (order || []).map(p => ({ ...p }));
  (trades || []).forEach(trade => {
    if (!trade?.toTeamId || !trade?.originalTeamId) return;
    const round = Number(trade.round);
    const pick = next.find(p => p.round === round && p.originalTeamId === trade.originalTeamId);
    if (!pick) return;
    pick.teamId = trade.toTeamId;
  });
  return next;
};

/** The board with trades applied, from the stored draft state. */
export const resolveDraftOrder = (state = {}) => applyPickTrades(
  buildDraftOrder({
    teamIds: state.orderTeamIds || [],
    rounds: state.rounds || 0,
    limitedRounds: state.limitedRounds ?? DEFAULT_LIMITED_ROUNDS,
  }),
  state.trades || [],
);

/** Has this pick been made? Picks are keyed by their overall number. */
export const pickByOverall = (picks = []) => {
  const map = new Map();
  (picks || []).forEach(p => { if (p && p.overall != null) map.set(Number(p.overall), p); });
  return map;
};

/**
 * The pick that is on the clock: the lowest-numbered slot with no selection.
 *
 * Deliberately NOT "the slot after the last one made". A commissioner
 * correcting an earlier pick deletes it, and the clock has to go back to it
 * rather than sailing past a hole in the board.
 */
export const currentPick = (order = [], picks = []) => {
  const made = pickByOverall(picks);
  return (order || []).find(p => !made.has(Number(p.overall))) || null;
};

/** "R3.02 · 17th overall" — the label used on the board and in the log. */
export const pickLabel = (pick) =>
  pick ? `R${pick.round}.${String(pick.pickInRound).padStart(2, '0')}` : '';

/** Every pick a team owns, in board order. */
export const picksForTeam = (order = [], teamId) =>
  (order || []).filter(p => p.teamId === teamId);

/**
 * A name → prior-attributes resolver over the durable player registry.
 *
 * The registry is keyed by the ROSTER spelling of a name; the draft pool comes
 * from OWGR, which spells several golfers differently ('Nico Echavarria' vs
 * 'Nicolas Echavarria'). A plain `registry[name]` lookup misses those, and the
 * miss is not harmless: a player with no prior attributes reads as new to the
 * league, which costs him the retroactive star the promotion rule owes him and
 * silently resets a limited player to unlimited. Same reason every other name
 * lookup in the app goes through NameMap.
 *
 * Built once and reused — the variant index is computed up front, so a lookup
 * per pick is cheap and rebuilding it per lookup would not be.
 */
export const registryLookup = (registry = {}) => {
  const map = new NameMap(Object.entries(registry || {}));
  return (name) => (name ? (map.get(name) || null) : null);
};

// ── Rollover ─────────────────────────────────────────────────────────────────

/**
 * The players a team carries into the new season, keepers first then picks in
 * board order.
 *
 * Keeper names are matched against the roster through NameSet, not by string
 * equality: a keeper tag is stored as the name the manager saw, and the roster
 * entry may be spelled differently by whichever source last wrote it. This is
 * the same equivalence every other name lookup in the app uses, and the reason
 * `===` on a golfer name is a hard no here.
 */
export const rolloverRoster = ({
  team, keepers = {}, picks = [], registry = {}, limitedRounds = DEFAULT_LIMITED_ROUNDS,
} = {}) => {
  const roster = team?.roster || [];
  const resolver = new NameSet(roster.map(p => p?.name).filter(Boolean));
  const findEntry = (name) => {
    if (!name) return null;
    const target = resolver.resolve(name) || name;
    return roster.find(p => p?.name === target) || null;
  };

  const priorOf = registryLookup(registry);
  const out = [];
  const kept = [];

  KEEPER_SLOTS.forEach(slot => {
    const name = keepers?.[slot];
    if (!name) return;
    const entry = findEntry(name);
    if (!entry) throw new Error(`${team?.name || team?.id}: kept "${name}" is not on the roster`);
    // One golfer, one slot. The two tags are stored independently, so the only
    // thing stopping a manager from spending both on the same player is a
    // check — and a roster carrying him twice would double every tally he
    // touches for the rest of the season.
    if (kept.some(k => resolver.resolve(k) === resolver.resolve(entry.name))) {
      throw new Error(`${team?.name || team?.id}: ${entry.name} is tagged in both keeper slots`);
    }
    kept.push(entry.name);
    out.push(keptPlayerAttrs(entry, slot));
  });

  (picks || [])
    .slice()
    .sort((a, b) => Number(a.overall) - Number(b.overall))
    .forEach(pick => {
      if (!pick?.player) return;
      out.push(draftedPlayerAttrs(pick.player, {
        round: pick.round,
        limitedRounds,
        prior: priorOf(pick.player),
      }));
    });

  return out;
};

/**
 * The whole team document for the new season.
 *
 * Everything a season accumulates is cleared: the lineup and its backup, the
 * money columns, and the mulligan allowance. `mulligans` is passed in rather
 * than defaulted here so the value lives in exactly one place — src/constants'
 * DEFAULT_MULLIGANS — instead of being spelled a second time in a module the
 * client and the server both import.
 *
 * `keepers` is cleared too: the tags were an instruction for THIS rollover and
 * leaving them behind would make the next one start pre-filled with names that
 * are a season out of date.
 */
export const rolloverTeam = ({ team, roster = [], mulligans = null } = {}) => {
  const next = {
    ...team,
    roster,
    lineup: [],
    earnings: 0,
    segmentEarnings: 0,
    segmentFees: 0,
    transactionFees: 0,
    keepers: null,
  };
  // set() without merge replaces the doc, so dropping the key is the clear.
  delete next.backup;
  if (mulligans) next.mulligans = { ...mulligans };
  return next;
};

/**
 * Force-set overrides for a star / tier CORRECTION, and nothing else.
 *
 * Deliberately not rolloverRegistryOverrides, which also zeroes `starts`
 * because a rollover begins a new season. A correction made BEFORE the
 * rollover must leave the start counts alone: the season being closed out
 * still owns them, the limited-start audit still reads them, and zeroing them
 * here would make the archive disagree with what was actually played.
 *
 * The force-set is the whole point. buildPlayerAttributeIndex merges `stars`
 * with Math.max, so LOWERING a count through an ordinary save is a silent
 * no-op — the roster entry changes, the next save reads the old higher value
 * back out of the registry, and the number returns. Overrides are the
 * documented way to make a monotonic tally go down, and a star correction is
 * the second operation in the app that needs it.
 *
 * Takes corrected roster entries and emits only their tier fields. `limited`
 * is never written false: once limited, always limited is a league rule the
 * whole codebase enforces, and this is not the place to add the one path
 * through it.
 *
 * Nor does a correction ever MINT a blue designation. It used to derive
 * `unlimited: !limited`, which is the same mistake draftedPlayerAttrs made —
 * it treats blue as "whatever is not gold" when blue is a one-year option a
 * manager spends through the unlimited keeper slot and nowhere else. White
 * can become blue; yellow cannot, and neither can a correction. So the flag is
 * carried over untouched, except that becoming gold clears it, because the two
 * tiers are exclusive.
 */
export const starCorrectionOverrides = (players = []) => {
  const overrides = {};
  (players || []).forEach(p => {
    if (!p?.name) return;
    const limited = !!p.limited;
    overrides[p.name] = {
      limited,
      unlimited: limited ? false : !!p.unlimited,
      stars: limited ? Math.max(1, Number(p.stars) || 1) : 0,
    };
  });
  return overrides;
};

/**
 * Force-clear the tier of every player going back into the pool.
 *
 * "Everyone not kept goes back into the draft with no colour, stars or years
 * of service" is not something the rollover gets for free by leaving them off
 * the new rosters. The durable registry outlives rosters on purpose — it is
 * what stops a drop-and-re-add shedding a start cap mid-season — and
 * buildPlayerAttributeIndex NEVER downgrades `limited`. So a released yellow
 * keeps his colour and his stars in the registry, and the first free-agent add
 * of the new season hands them straight back through hydratePlayer: he arrives
 * start-capped, starred, and on a keeper clock nobody granted him.
 *
 * The draft itself is safe without this — draftedPlayerAttrs reads no prior
 * tier, the round decides — which is exactly what makes the gap easy to miss.
 * It opens on the first waiver claim instead.
 *
 * Career tallies are left alone. These overrides name only the tier fields,
 * and registryUpkeep merges per key, so SFGL earnings, cuts and events played
 * survive — they belong to the golfer, not to a roster spot.
 */
export const releasedRegistryOverrides = (names = []) => {
  const overrides = {};
  (names || []).forEach(name => {
    if (!name) return;
    overrides[name] = {
      limited: false,
      unlimited: false,
      stars: 0,
      yearsOfService: 0,
      starts: 0,
    };
  });
  return overrides;
};

/**
 * Force-set registry values for a rolled-over roster.
 *
 * updateTeams merges the registry with Math.max, so a start count reset to
 * zero on the roster would be pulled straight back up to last season's total
 * on the very next save. registryOverrides is the documented escape hatch for
 * exactly that, and the rollover is the one operation in the app that has to
 * make a monotonic tally go DOWN.
 */
export const rolloverRegistryOverrides = (rosters = []) => {
  const overrides = {};
  rosters.flat().forEach(p => {
    if (!p?.name) return;
    overrides[p.name] = {
      limited: p.limited,
      unlimited: p.unlimited,
      stars: p.stars,
      yearsOfService: p.yearsOfService,
      starts: 0,
    };
  });
  return overrides;
};
