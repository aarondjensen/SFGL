// src/pages/admin/KeeperYearsStep.jsx
// ============================================================================
// Years of service — verifying the star counts BEFORE keeper tagging opens.
//
// WHY THIS STEP EXISTS AT ALL
// ---------------------------
// `stars` is the number keeper eligibility is judged on: three of them and a
// limited player cannot be kept. It is also a number nothing in the app has
// ever written. Every path only carries it forward — registryUpkeep merges it
// with Math.max, and makePlayer, the only function that mints one, has had no
// call sites since it came out of TransactionsView. So the counts in Firestore
// are whatever the long-deleted draft UI or a human last put there, and the
// rollover advances from them.
//
// That is a quiet way to get something loud wrong. A count one too low hands a
// manager a fourth keeper season; one too high takes away a season they are
// owed. Neither announces itself — the badge, the keeper sheet and the rollover
// would all agree on the same wrong number.
//
// The league's Google Sheet HAS kept the count honest, as a `keeper` column of
// asterisks. scripts/derive-keeper-seed-2026.mjs lifts those into
// keeperSeed2026.js, and this step puts the two side by side so the
// commissioner adopts, overrides or ignores each one deliberately.
//
// TWO RULES THIS SCREEN IS CAREFUL ABOUT
// --------------------------------------
//  1. A DECREASE only sticks through registryOverrides. The registry merges
//     stars with Math.max, so lowering one with an ordinary save changes the
//     roster entry and is then quietly undone by the next save. See
//     starCorrectionOverrides in api/_draft.js.
//  2. Nobody is demoted. Once limited, always limited is enforced everywhere
//     in this codebase, so a limited player's floor here is one star. Going
//     the other way — promoting a player the sheet lists as limited but the
//     app has as unlimited — is allowed, because that mismatch is exactly the
//     eligibility bug this step is for.
// ============================================================================

import { useMemo, useState } from 'react';
import { useDialog } from '../DialogContext';
import { M, disabledBtn } from './adminStyles';
import { colors, fonts, fontSize, green, steel, white } from '../../theme.js';
import { NameSet } from '../../../api/_playerNames.js';
import { effectiveStars, starCorrectionOverrides, KEEPER_MAX_STARS } from '../../../api/_draft.js';
import { KEEPER_SEED_2026, KEEPER_SEED_SEASON, keeperSeedForTeam } from './keeperSeed2026';

// A row's state, named so the badge and the save path cannot disagree about
// what "needs attention" means.
const STATUS = {
  OK:          'ok',           // app and sheet agree
  DIFFERS:     'differs',      // both have a count, they disagree
  UNLIMITED:   'unlimited',    // sheet says limited, the app does not
  OFF_ROSTER:  'off_roster',   // seeded player is no longer on the roster
  UNSEEDED:    'unseeded',     // limited in the app, absent from the sheet
};

const STATUS_LABEL = {
  [STATUS.OK]:         { text: 'matches the sheet', color: colors.textMuted },
  [STATUS.DIFFERS]:    { text: 'differs from the sheet', color: colors.warning },
  [STATUS.UNLIMITED]:  { text: 'unlimited in the app — the sheet has him limited', color: colors.warning },
  [STATUS.OFF_ROSTER]: { text: 'on the sheet, not on the roster — dropped since the snapshot', color: colors.textMuted },
  [STATUS.UNSEEDED]:   { text: 'limited in the app, not on the sheet', color: colors.warning },
};

// A local empty-row style rather than theme.emptyState: that one is a padded
// block sized for a whole card, and this sits inside a step among tight rows.
const emptyRow = {
  fontFamily: fonts.sans,
  fontSize: fontSize.sm,
  color: colors.textMuted,
  padding: '6px 9px',
};

const Stars = ({ n }) => (
  <span style={{ letterSpacing: 1, fontSize: fontSize.badge }}>
    {n > 0 ? '⭐'.repeat(n) : '—'}
  </span>
);

export const KeeperYearsStep = ({ teams = [], rosters = {}, updateTeams }) => {
  const dialog = useDialog();
  const [edits, setEdits] = useState({});   // `${teamId}::${name}` → stars
  const [saving, setSaving] = useState(false);

  const keyFor = (teamId, name) => `${teamId}::${name}`;

  // Rows per team: every seeded player, then any limited player on the roster
  // the sheet does not list.
  //
  // Seed names are matched to roster names through NameSet, never with ===.
  // The sheet spells three of these players differently from the app on a good
  // day ('Ludvig Åberg', 'Nicolai Højgaard', 'Nico Echavarria'), and a string
  // compare would report every one of them as "not on the roster" and offer to
  // seed a duplicate.
  const byTeam = useMemo(() => teams.map(team => {
    const teamId = team.id || team.name;
    const roster = rosters[teamId] || [];
    const resolver = new NameSet(roster.map(p => p?.name).filter(Boolean));
    const matched = new Set();
    const rows = [];

    keeperSeedForTeam(teamId).forEach(seed => {
      const resolved = resolver.resolve(seed.player);
      const entry = resolved ? roster.find(p => p.name === resolved) : null;
      if (entry) matched.add(entry.name);
      const appStars = entry ? effectiveStars(entry) : null;
      let status;
      if (!entry)                         status = STATUS.OFF_ROSTER;
      else if (!entry.limited)            status = STATUS.UNLIMITED;
      else if (appStars !== seed.stars)   status = STATUS.DIFFERS;
      else                                status = STATUS.OK;
      rows.push({
        name: entry?.name || seed.player,
        sheetName: seed.player,
        entry,
        appStars,
        seedStars: seed.stars,
        status,
      });
    });

    roster
      .filter(p => p?.limited && !matched.has(p.name))
      .forEach(entry => rows.push({
        name: entry.name,
        sheetName: null,
        entry,
        appStars: effectiveStars(entry),
        seedStars: null,
        status: STATUS.UNSEEDED,
      }));

    return { team, teamId, rows };
  }), [teams, rosters]);

  // What a row will be saved as: the pending edit, else what the app already
  // has. The sheet's number is a SUGGESTION until it is adopted — adopting it
  // automatically would defeat the point of the review.
  const valueFor = (teamId, row) => {
    const pending = edits[keyFor(teamId, row.name)];
    if (pending !== undefined) return pending;
    return row.appStars ?? 0;
  };

  const setValue = (teamId, row, next) => {
    // A limited player's floor is one star, not zero: zero would read as a
    // demotion to unlimited, which the league does not allow and which every
    // merge in this codebase refuses anyway.
    const floor = row.entry?.limited ? 1 : 0;
    const clamped = Math.max(floor, Math.min(9, Number(next) || 0));
    setEdits(prev => ({ ...prev, [keyFor(teamId, row.name)]: clamped }));
  };

  const adoptable = useMemo(() => byTeam.flatMap(({ teamId, rows }) =>
    rows
      .filter(r => r.seedStars !== null && r.entry && valueFor(teamId, r) !== r.seedStars)
      .map(r => ({ teamId, row: r }))
  ), [byTeam, edits]); // eslint-disable-line react-hooks/exhaustive-deps

  const adoptAll = () => {
    const next = { ...edits };
    adoptable.forEach(({ teamId, row }) => { next[keyFor(teamId, row.name)] = row.seedStars; });
    setEdits(next);
  };

  const pendingCount = useMemo(() => byTeam.reduce((n, { teamId, rows }) =>
    n + rows.filter(r => r.entry && valueFor(teamId, r) !== (r.appStars ?? 0)).length, 0),
    [byTeam, edits]); // eslint-disable-line react-hooks/exhaustive-deps

  const needsAttention = byTeam.reduce((n, { rows }) =>
    n + rows.filter(r => r.status !== STATUS.OK).length, 0);

  const handleSave = async () => {
    setSaving(true);
    try {
      const corrected = [];
      const nextTeams = teams.map(team => {
        const teamId = team.id || team.name;
        const teamRows = byTeam.find(b => b.teamId === teamId)?.rows || [];
        const changes = new Map();
        teamRows.forEach(row => {
          if (!row.entry) return;                       // off-roster: nothing to write
          const stars = valueFor(teamId, row);
          if (stars === (row.appStars ?? 0)) return;    // untouched
          const limited = stars > 0;
          changes.set(row.name, {
            ...row.entry,
            limited,
            // Carried over, not derived from !limited. Blue is granted by the
            // unlimited keeper slot and by nothing else — a data correction
            // must not hand a player a designation his manager never spent.
            // Becoming gold clears it, the two tiers being exclusive.
            unlimited: limited ? false : !!row.entry.unlimited,
            stars: limited ? stars : 0,
          });
        });
        if (!changes.size) return team;
        corrected.push(...changes.values());
        // Only the team's OWN roster array is rewritten here. A corrected
        // player who arrived by transaction is not in it — the effective
        // roster is replayed, not stored — and for them the registry override
        // below is what carries the correction. hydratePlayer reads the index,
        // so they come back corrected either way.
        return {
          ...team,
          roster: (team.roster || []).map(p => changes.get(p.name) || p),
        };
      });

      if (!corrected.length) {
        dialog.showToast('Nothing to save — no counts changed', 'info');
        return;
      }

      // The overrides are what make a DECREASE survive. Without them the
      // registry's Math.max merge reads the old, higher count straight back
      // over the roster entry on the very next team save.
      await updateTeams(nextTeams, starCorrectionOverrides(corrected));
      setEdits({});
      dialog.showToast(`✓ ${corrected.length} star count${corrected.length === 1 ? '' : 's'} corrected`, 'success');
    } catch (err) {
      dialog.showToast('Error: ' + err.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div style={M.descText}>
        The stars ARE the keeper years: {KEEPER_MAX_STARS} closes the limited slot. Nothing in the
        app has ever written this number — it is only ever carried forward — so it is
        checked against the {KEEPER_SEED_SEASON} sheet here before tagging opens.
        A count that is wrong by one silently gives or takes a keeper season.
      </div>

      <div style={M.statusRow}>
        <span style={M.statusDot(needsAttention ? colors.warning : colors.earningsGreen)} />
        <span style={{ fontFamily: fonts.sans, fontSize: fontSize.sm, color: colors.textSecondary }}>
          {needsAttention === 0
            ? `All ${KEEPER_SEED_2026.length} limited players match the sheet`
            : `${needsAttention} row${needsAttention === 1 ? '' : 's'} need a look`}
        </span>
      </div>

      {byTeam.map(({ team, teamId, rows }) => (
        <div key={teamId} style={{ marginBottom: 12 }}>
          <div style={{
            fontFamily: fonts.sans, fontSize: fontSize.xs, fontWeight: 700,
            letterSpacing: '1.6px', textTransform: 'uppercase',
            color: colors.textMuted, marginBottom: 5,
          }}>
            {team.name}
          </div>

          {rows.length === 0 ? (
            <div style={emptyRow}>No limited players.</div>
          ) : rows.map(row => {
            const value = valueFor(teamId, row);
            const changed = row.entry && value !== (row.appStars ?? 0);
            const atCap = value >= KEEPER_MAX_STARS;
            const label = STATUS_LABEL[row.status];
            return (
              <div
                key={row.name}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '7px 9px', marginBottom: 3, borderRadius: 4,
                  background: changed ? green(0.08) : white(0.025),
                  border: `1px solid ${changed ? green(0.4) : colors.borderSubtle}`,
                  opacity: row.entry ? 1 : 0.5,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontFamily: fonts.sans, fontSize: fontSize.md,
                    color: row.entry?.limited || value > 0 ? colors.textGold : steel(0.9),
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {row.name}
                    {/* The sheet's spelling, when it differs — so a matched-by-
                        identity row is visibly a match and not a mystery. */}
                    {row.sheetName && row.sheetName !== row.name && (
                      <span style={{ color: colors.textMuted, fontSize: fontSize.xs }}> (sheet: {row.sheetName})</span>
                    )}
                  </div>
                  <div style={{ fontFamily: fonts.sans, fontSize: fontSize.xs, color: label.color }}>
                    {label.text}
                    {atCap && row.entry && (
                      <span style={{ color: colors.warning }}> · at the cap, cannot be kept</span>
                    )}
                  </div>
                </div>

                {/* What the sheet says, and a one-tap adopt for this row. */}
                {row.seedStars !== null && (
                  <button
                    type="button"
                    onClick={() => row.entry && setValue(teamId, row, row.seedStars)}
                    disabled={!row.entry || value === row.seedStars}
                    title={row.entry ? `Use the sheet's ${row.seedStars}` : 'Not on the roster'}
                    style={{
                      ...M.btnSecondary, padding: '3px 8px', flexShrink: 0,
                      ...disabledBtn(!row.entry || value === row.seedStars),
                    }}
                  >
                    sheet <Stars n={row.seedStars} />
                  </button>
                )}

                {row.entry && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                    <button
                      type="button" aria-label={`One fewer star for ${row.name}`}
                      onClick={() => setValue(teamId, row, value - 1)}
                      style={{ ...M.btnSecondary, padding: '2px 8px' }}
                    >−</button>
                    <span style={{
                      minWidth: 52, textAlign: 'center',
                      fontFamily: fonts.sans, fontSize: fontSize.sm,
                      color: atCap ? colors.warning : colors.textPrimary,
                    }}>
                      <Stars n={value} />
                    </span>
                    <button
                      type="button" aria-label={`One more star for ${row.name}`}
                      onClick={() => setValue(teamId, row, value + 1)}
                      style={{ ...M.btnSecondary, padding: '2px 8px' }}
                    >+</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}

      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button
          type="button"
          onClick={adoptAll}
          disabled={adoptable.length === 0}
          style={{ ...M.btnSecondary, flex: 1, ...disabledBtn(adoptable.length === 0) }}
        >
          {adoptable.length === 0
            ? 'Nothing left to adopt'
            : `Adopt the sheet for ${adoptable.length} row${adoptable.length === 1 ? '' : 's'}`}
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || pendingCount === 0}
          className="modal-feel-lift modal-feel-primary"
          style={{ ...M.btnPrimary, flex: 1, ...disabledBtn(saving || pendingCount === 0) }}
        >
          {saving ? '⏳ Saving…' : pendingCount === 0 ? 'No changes' : `Save ${pendingCount} change${pendingCount === 1 ? '' : 's'}`}
        </button>
      </div>
    </div>
  );
};

export default KeeperYearsStep;
