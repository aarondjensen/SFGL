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
//   • A LIMITED (yellow) player may be kept for at most three seasons. The
//     star badges beside his name ARE those seasons, so three stars in the
//     closing season means he cannot be kept into the next draft.
//   • An UNLIMITED (blue) player promoted to limited receives a RETROACTIVE
//     star for his year as unlimited — so he arrives in his first limited
//     season already on two, and has one keeper season left rather than three.
//   • Each manager keeps ONE limited player and ONE unlimited player.
//     Everyone else goes back into the pool.
//   • The draft order is REVERSE final standings (last place picks first) and
//     SNAKES every round.
//   • The first two rounds are limited rounds: whoever is taken there becomes
//     a limited player and gets his first star.
//   • Picks are tradeable, so a pick's owner and the team whose slot it is are
//     two different things.
//
// ── The tiers, and every move between them ──────────────────────────────────
//
// There are THREE tiers, not two, and the middle one is a designation rather
// than a description. Gold is limited: start-capped, starred, on a keeper
// clock. BLUE is the unlimited keeper — one per team per year, a one-year
// option that must be exercised. White is everybody else, uncapped and
// uncommitted. All three render distinctly (blue is checked first, then gold,
// then the fall-through to white).
//
//   from → to        allowed  how, and what it costs
//   ───────────────────────────────────────────────────────────────────────
//   white → blue     yes      the unlimited keeper slot. 0 stars, but the
//                             season IS his first year of service — the star
//                             for it appears retroactively on promotion
//   white → gold     yes      tagged limited, or drafted in a limited round.
//                             1 star: no unlimited season to credit, so three
//                             keeper seasons ahead rather than two
//   blue  → gold     yes      tagged limited, or drafted in a limited round.
//                             2 stars — one retroactive for the blue year
//   gold  → gold     yes      kept again: +1 star AND +1 year of service, to
//                             a ceiling of three. This is the ordinary keep,
//                             and the one most of the league does every year
//   blue  → white    yes      not tagged: the designation is spent, he goes
//                             back into the draft and may be taken again
//   blue  → blue     NO       one year only. Tag him limited or lose him
//   gold  → blue     NO       no path anywhere. A correction will not do it
//                             either — see starCorrectionOverrides
//   gold  → white    NO       once limited, always limited. Enforced on every
//                             drop and re-add by buildPlayerAttributeIndex,
//                             and by draftedPlayerAttrs on a late-round pick
//
// Every row has a test in scripts/test-draft.mjs, the refusals included.
// ============================================================================

import { getSeasonEarningsByTeam } from './_rules.js';
import { NameSet, NameMap } from './_playerNames.js';

// ── Constants ────────────────────────────────────────────────────────────────

/** A limited player may be KEPT for three seasons; the fourth is not offered. */
export const KEEPER_MAX_STARS = 3;

/** One limited keeper, one unlimited keeper. Order matters for display only. */
export const KEEPER_SLOTS = ['limited', 'unlimited'];

/** Rounds at the top of the draft that produce LIMITED players. */
export const DEFAULT_LIMITED_ROUNDS = 2;

/**
 * The star an unlimited player is awarded, retroactively, for the season he
 * spent unlimited when he is promoted to limited. Named rather than spelled as
 * a bare 1 at the two places that grant it (keeping into the limited slot, and
 * being drafted into a limited round), because those two must never drift.
 */
export const RETROACTIVE_UNLIMITED_STAR = 1;

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
 * Has this player served a season as a designated UNLIMITED keeper?
 *
 * The league runs three tiers, not two: gold (limited, start-capped, starred),
 * BLUE (unlimited — a scarce, deliberate designation, one per team per year),
 * and plain white (everybody else). All three render distinctly, blue checked
 * first (see the colour cascade in api/cron.js and TournamentsView).
 *
 * The keeper clock starts at BLUE, not at being on a roster: "the first year
 * of service is the year he's kept as unlimited". So this asks whether the
 * player carries the designation, and nothing else.
 *
 * It used to fall back to `yearsOfService >= 1`, which made every white player
 * who had been around a season read as having served — and handed him the
 * retroactive star that belongs only to a blue keeper. A white player taken in
 * a limited round is starting his service, so he starts on one.
 */
const servedAsUnlimited = (player) => !!player && !player.limited && !!player.unlimited;

// ── Keeper eligibility ───────────────────────────────────────────────────────

/**
 * Where a player stands as a keeper candidate.
 *
 * Returns:
 *   tier               'limited' (gold) | 'unlimited' (blue) | 'plain' (white)
 *   stars              the badge count (effectiveStars)
 *   maxStars           the league's keeper ceiling
 *   limited            { eligible, starsIfKept, promotion, reason }
 *   unlimited          { eligible, reason }
 *
 * `reason` is filled in ONLY when the slot is unavailable, and it is written
 * for a manager rather than for a log — it is what the keeper sheet shows
 * under a greyed-out player.
 */
export const keeperStatus = (player, { maxStars = KEEPER_MAX_STARS } = {}) => {
  const limited = !!player?.limited;
  const stars = effectiveStars(player);
  const promotion = !limited;

  // A promoted BLUE keeper starts his limited career on two: the retroactive
  // star for the season he served as unlimited, plus the one he earns for the
  // season ahead. A white player has served nothing yet, so he starts on one.
  //
  // This condition has to be the same one draftedPlayerAttrs uses, or being
  // named a keeper and being taken in a limited round would value the same
  // player differently — and the keeper sheet would promise a star count the
  // rollover then declined to write.
  const starsIfKept = limited
    ? stars + 1
    : servedAsUnlimited(player) ? RETROACTIVE_UNLIMITED_STAR + 1 : 1;

  const limitedEligible = limited ? stars < maxStars : true;

  return {
    tier: limited ? 'limited' : player?.unlimited ? 'unlimited' : 'plain',
    stars,
    maxStars,
    // His blue year is spent: this is the last offseason he can be kept at
    // all. Surfaced here rather than recomputed in the view, so the warning
    // and the eligibility it is warning about come from one place.
    unlimitedYearExpiring: !limited && !!player?.unlimited,
    limited: {
      eligible: limitedEligible,
      starsIfKept,
      promotion,
      reason: limitedEligible
        ? null
        : `${stars} star${stars === 1 ? '' : 's'} — a limited player may be kept ${maxStars} seasons`,
    },
    unlimited: {
      eligible: canBeMadeUnlimited(player),
      // Two different refusals, because they call for two different things
      // from the manager. A gold player was never a candidate; a blue player
      // is one whose year is UP, and the useful thing to tell his manager is
      // what the alternative now is.
      reason: canBeMadeUnlimited(player)
        ? null
        : limited
          ? 'already limited — a limited player cannot fill the unlimited slot'
          : 'his unlimited year is up — tag him limited now, or he goes back into the draft',
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
export const keptPlayerAttrs = (player, slot, { maxStars = KEEPER_MAX_STARS } = {}) => {
  if (!player?.name) throw new Error('keptPlayerAttrs: no player');
  const status = keeperStatus(player, { maxStars });
  if (slot === 'limited' && !status.limited.eligible) {
    throw new Error(`${player.name} cannot be kept as a limited keeper: ${status.limited.reason}`);
  }
  if (slot === 'unlimited' && !status.unlimited.eligible) {
    throw new Error(`${player.name} cannot be kept as an unlimited keeper: ${status.unlimited.reason}`);
  }

  const yearsOfService = (Number(player.yearsOfService) || 0) + 1;

  if (slot === 'limited') {
    return {
      name: player.name,
      limited: true,
      unlimited: false,
      stars: status.limited.starsIfKept,
      yearsOfService,
      ...SEASON_RESET_FIELDS,
      ...carriedTallies(player),
    };
  }

  return {
    name: player.name,
    limited: false,
    unlimited: true,
    stars: 0,
    yearsOfService,
    ...SEASON_RESET_FIELDS,
    ...carriedTallies(player),
  };
};

/**
 * The roster entry a DRAFTED player carries into the new season.
 *
 * `prior` is whatever the durable player registry knows about him — undefined
 * for a golfer new to the league.
 *
 * Two rules meet here:
 *
 *   1. A limited round makes its pick limited. A player with no SFGL history
 *      gets his first star; one who spent a season unlimited is being PROMOTED
 *      and gets the retroactive star as well, exactly as he would if his
 *      manager had kept him into the limited slot. Which of the two happened —
 *      kept or re-drafted — is not a distinction the promotion rule draws.
 *
 *   2. Once limited, always limited. A limited player who went back into the
 *      pool and is taken in a LATER round does not come back unlimited; that
 *      is the same league rule buildPlayerAttributeIndex enforces on every
 *      drop and re-add, and it costs him another star because it is another
 *      season of limited service.
 */
export const draftedPlayerAttrs = (name, {
  round, limitedRounds = DEFAULT_LIMITED_ROUNDS, prior = null,
} = {}) => {
  if (!name) throw new Error('draftedPlayerAttrs: no player name');
  const limitedRound = Number(round) <= Number(limitedRounds);
  const wasLimited = !!prior?.limited;
  const limited = limitedRound || wasLimited;

  let stars = 0;
  if (limited) {
    if (wasLimited) stars = effectiveStars(prior) + 1;
    else stars = servedAsUnlimited(prior) ? RETROACTIVE_UNLIMITED_STAR + 1 : 1;
  }

  // Drafted outside a limited round means PLAIN, not blue. Blue is a keeper
  // designation a manager spends — one per team per year — and a draft that
  // handed it to all nine late-round picks would wipe out the tier the rule
  // depends on: "one non-limited player can be made unlimited" says nothing at
  // all if every non-limited player already is one.
  //
  // A player who arrives blue is one who was KEPT blue (keptPlayerAttrs with
  // the unlimited slot), never one who was drafted.
  return {
    name,
    limited,
    unlimited: false,
    stars,
    yearsOfService: (Number(prior?.yearsOfService) || 0) + 1,
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
