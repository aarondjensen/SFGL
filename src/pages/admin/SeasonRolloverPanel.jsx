// src/pages/admin/SeasonRolloverPanel.jsx
// ============================================================================
// Rolling the league into the next season, as an ordered checklist.
//
// The steps are ordered because each one depends on the last, and two of them
// are irreversible in ways that matter:
//
//   1  Archive          snapshot the closing season before anything is reset
//   2  Years of service verify the star counts eligibility is judged on, against
//                       the league's sheet — nothing in the app has ever
//                       written them
//   3  Draft order      final standings, reversed; the commissioner can settle
//                       a tie by hand
//   4  Keepers          open tagging, watch it come in
//   5  Draft            run the board
//   6  Apply            keepers + picks become the new rosters, and the
//                       closing season's transactions are cleared
//
// Step 6 is the one to be careful about, and the reason step 1 gates it. It
// rewrites every roster in the league AND deletes every transaction — which it
// has to, because buildEffectiveRoster replays processed transactions on top of
// `team.roster`, so leaving last season's add/drops in place would replay them
// over the new rosters and hand back players who were never drafted. The
// archive is the only copy of the season after that, so the button refuses to
// run without one.
//
// What this panel deliberately does NOT do:
//
//   • bump SEASON. It is a build-time constant (vite.config.ts substitutes it
//     into index.html) and it keys tournament_results ids, the results-fetch
//     URL and the page title to the season still being finished. The rollover
//     runs in the gap BEFORE that bump on purpose — see NEXT_SEASON in
//     api/_league.js. The checklist at the bottom says so on screen.
//   • import the new schedule. Import Schedule already does that, and doing it
//     twice from two places is how the two would drift.
// ============================================================================

import React, { useMemo, useState, Suspense } from 'react';
import { useDialog } from '../DialogContext';
import { M, S, disabledBtn } from './adminStyles';
import { colors, fonts, fontSize, green, steel, white } from '../../theme.js';
import { SEASON, NEXT_SEASON } from '../../../api/_league.js';
import { NameSet } from '../../../api/_playerNames.js';
import {
  DRAFT_STATUS, KEEPER_SLOTS, DEFAULT_LIMITED_ROUNDS,
  seasonStandings, draftOrderTeamIds, defaultDraftRounds,
  resolveDraftOrder, currentPick, pickLabel,
  rolloverRoster, rolloverTeam, rolloverRegistryOverrides, releasedRegistryOverrides,
} from '../../../api/_draft.js';
import { DEFAULT_MULLIGANS } from '../../constants';
import { draftApi, seasonArchiveApi } from '../../api/firebase';
import { useDraft } from '../../hooks/useDraft';
import { KeeperYearsStep } from './KeeperYearsStep';
import { hydratedRoster, buildPlayerAttributeIndex, getPlayerRegistry } from '../../utils/sharedHelpers';

// Both sheets are imported dynamically HERE as well as from OffseasonBar. That
// is deliberate: a static import in one place and a dynamic one in the other
// makes rollup emit "dynamically imported but also statically imported", which
// this repo treats as a build failure — two of its bundle regressions announced
// themselves as exactly that warning.
const LazyKeeperTagModal = React.lazy(() => import('../KeeperTagModal').then(m => ({ default: m.KeeperTagModal })));
const LazyDraftModal     = React.lazy(() => import('../DraftModal').then(m => ({ default: m.DraftModal })));

const StepHeader = ({ n, title, done }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
    <span style={{
      width: 20, height: 20, borderRadius: '50%', flexShrink: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: done ? green(0.9) : white(0.08),
      border: `1px solid ${done ? green(0.9) : white(0.18)}`,
      color: done ? '#fff' : colors.textMuted,
      fontFamily: fonts.sans, fontSize: fontSize.xs, fontWeight: 800, lineHeight: 1,
    }}>
      {done ? '✓' : n}
    </span>
    <span style={M.eyebrow}>{title}</span>
  </div>
);

export const SeasonRolloverPanel = ({
  teams = [], tournaments = [], transactions = [], allPlayers = [], settings = {},
  updateTeams, setTransactions,
}) => {
  const dialog = useDialog();
  const draft = useDraft(NEXT_SEASON);
  const [busy, setBusy] = useState(null);       // which step is running
  // undefined = "ask the draft state"; true once this session has archived.
  const [archivedHere, setArchivedHere] = useState(undefined);
  const [tagging, setTagging] = useState(null); // team being tagged by the commish
  const [showDraft, setShowDraft] = useState(false);

  // Draft config, seeded from the stored state and editable until the draft
  // starts. Changing either re-derives the whole board — nothing about the
  // board is stored, so there is no stale snapshot to migrate.
  const [rounds, setRounds] = useState(null);
  const [limitedRounds, setLimitedRounds] = useState(null);

  const rosterLimit = settings?.rosterLimit ?? 13;
  const suggestedRounds = defaultDraftRounds({ rosterLimit });
  const effRounds = rounds ?? draft.state?.rounds ?? suggestedRounds;
  const effLimitedRounds = limitedRounds ?? draft.state?.limitedRounds ?? DEFAULT_LIMITED_ROUNDS;

  const standings = useMemo(
    () => seasonStandings({ teams, tournaments }),
    [teams, tournaments],
  );

  // The order the commissioner is editing: whatever is stored, else the
  // reversed standings. Stored wins so a hand-settled tie survives a re-render.
  const [orderDraft, setOrderDraft] = useState(null);
  const effOrder = orderDraft || draft.state?.orderTeamIds || draftOrderTeamIds(standings);

  const attrIndex = useMemo(
    () => buildPlayerAttributeIndex(teams, tournaments, getPlayerRegistry()),
    [teams, tournaments],
  );

  const rosters = useMemo(() => {
    const map = {};
    teams.forEach(t => {
      map[t.id || t.name] = hydratedRoster(t, transactions, { tournaments, attrIndex });
    });
    return map;
  }, [teams, transactions, tournaments, attrIndex]);

  const keptNames = useMemo(
    () => teams.flatMap(t => KEEPER_SLOTS.map(s => t?.keepers?.[s]).filter(Boolean)),
    [teams],
  );

  // The board comes from the SAVED state, never from the unsaved inputs above.
  // A commissioner typing 20 into the rounds box would otherwise be looking at
  // a board that has slots nobody else's client has — and a pick made against
  // one of them lands on an overall number the real board does not contain.
  // The inputs are a form; the board is the league's.
  const board = useMemo(() => (draft.state ? resolveDraftOrder(draft.state) : []), [draft.state]);
  const savedLimitedRounds = draft.state?.limitedRounds ?? DEFAULT_LIMITED_ROUNDS;
  const onTheClock = useMemo(() => currentPick(board, draft.picks), [board, draft.picks]);
  const picksMade = draft.picks.length;
  const teamName = (id) => teams.find(t => (t.id || t.name) === id)?.name || id;

  const status = draft.state?.status || null;
  const archived = archivedHere !== undefined ? archivedHere : !!draft.state?.archivedAt;

  const run = async (step, fn) => {
    setBusy(step);
    try { await fn(); }
    catch (err) { dialog.showToast('Error: ' + err.message, 'error'); }
    finally { setBusy(null); }
  };

  // ── 1 · Archive ───────────────────────────────────────────────────────────
  const handleArchive = () => run('archive', async () => {
    // seasonArchiveApi splits this across documents and writes the manifest
    // last, so a part-way failure leaves nothing the archive view will offer
    // to open. Teams are archived with the rosters they ACTUALLY finished on —
    // the replayed effective rosters, not the stored arrays, which drift from
    // each other as soon as a transaction lands.
    const { archivedAt } = await seasonArchiveApi.save(SEASON, {
      standings,
      teams: teams.map(t => ({ ...t, roster: rosters[t.id || t.name] || t.roster || [] })),
      tournaments,
      transactions,
    });
    await draftApi.set(NEXT_SEASON, {
      priorSeason: SEASON,
      archivedAt,
      status: draft.state?.status || DRAFT_STATUS.SETUP,
    });
    setArchivedHere(true);
    dialog.showToast(`✓ ${SEASON} archived and readable in Season Archive`, 'success');
  });

  // ── 3 · Order ─────────────────────────────────────────────────────────────
  const move = (index, delta) => {
    const next = [...effOrder];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setOrderDraft(next);
  };

  const handleSaveOrder = () => run('order', async () => {
    await draftApi.set(NEXT_SEASON, {
      orderTeamIds: effOrder,
      rounds: effRounds,
      limitedRounds: effLimitedRounds,
      status: draft.state?.status || DRAFT_STATUS.SETUP,
    });
    setOrderDraft(null);
    setRounds(null);
    setLimitedRounds(null);
    dialog.showToast('✓ Draft order saved', 'success');
  });

  // ── 4 / 5 · Status transitions ────────────────────────────────────────────
  const setStatus = (next, label) => run('status', async () => {
    await draftApi.set(NEXT_SEASON, { status: next, [`${next}At`]: new Date().toISOString() });
    dialog.showToast(`✓ ${label}`, 'success');
  });

  // ── 6 · Apply ─────────────────────────────────────────────────────────────
  //
  // Built in full BEFORE anything is written. rolloverRoster throws on an
  // illegal keeper (a name that is not on the roster, one player tagged in
  // both slots), and a half-applied league — three teams on next season's
  // rosters and two still on last season's — is not a state anything in the
  // app knows how to read. Either every team rolls over or none does.
  const handleApply = () => run('apply', async () => {
    if (!archived) throw new Error('Archive the season first — this deletes every transaction.');

    const nextTeams = [];
    const builtRosters = [];
    for (const team of teams) {
      const id = team.id || team.name;
      const roster = rolloverRoster({
        team: { ...team, roster: rosters[id] || team.roster || [] },
        keepers: team.keepers || {},
        picks: board.filter(p => p.teamId === id).map(p => ({
          ...p,
          player: draft.picks.find(x => Number(x.overall) === Number(p.overall))?.player,
        })).filter(p => p.player),
        registry: attrIndex,
        limitedRounds: savedLimitedRounds,
      });
      builtRosters.push(roster);
      nextTeams.push(rolloverTeam({ team, roster, mulligans: DEFAULT_MULLIGANS }));
    }

    const ok = await dialog.showConfirm(
      `Roll the league into ${NEXT_SEASON}?`,
      `Every roster is replaced with its keepers and draft picks, and all ${transactions.length} ` +
      `${SEASON} transactions are deleted (they would otherwise replay onto the new rosters). ` +
      `The ${SEASON} archive is the only copy after this.`,
      { type: 'danger', confirmText: 'Roll over' },
    );
    if (!ok) return;

    // Everyone the rollover did NOT keep or draft goes back into the pool with
    // nothing. Leaving them off the new rosters is not enough: the durable
    // registry outlives rosters by design, and it never downgrades `limited`,
    // so a released yellow would be handed his colour and stars straight back
    // by the first free-agent add of the new season. The draft is safe either
    // way — the round decides a drafted player's colour — which is what makes
    // this easy to miss until a waiver claim turns up start-capped.
    const keptNow = new NameSet(builtRosters.flat().map(p => p?.name).filter(Boolean));
    const released = Object.keys(attrIndex).filter(name => name && !keptNow.has(name));

    // Rosters first. registryOverrides force-sets the start counts back to
    // zero — the durable registry merges tallies with Math.max, so without it
    // every limited player would arrive in the new season already carrying
    // last season's starts against a cap that is supposed to have reset.
    await updateTeams(nextTeams, {
      ...releasedRegistryOverrides(released),
      // Kept and drafted players last: a name in both lists must end up with
      // the roster's value, not the cleared one.
      ...rolloverRegistryOverrides(builtRosters),
    });

    // Then the transactions, and only explicitly: sync() is upsert-only and
    // never infers a deletion from a row's absence, so the rows have to be
    // named or they simply stay.
    if (transactions.length) {
      await setTransactions([], { deleted: transactions });
    }

    await draftApi.set(NEXT_SEASON, {
      status: DRAFT_STATUS.COMPLETE,
      completedAt: new Date().toISOString(),
    });
    dialog.showToast(`✓ ${NEXT_SEASON} rosters are live`, 'success');
  });

  const tagTeam = tagging ? teams.find(t => (t.id || t.name) === tagging) : null;

  return (
    <div style={M.page}>
      {/* ── Where we are ── */}
      <div style={M.group}>
        <div style={M.eyebrow}>{SEASON} → {NEXT_SEASON}</div>
        <div style={M.descText}>
          {status === DRAFT_STATUS.COMPLETE
            ? `${NEXT_SEASON} rosters are live. Finish the checklist at the bottom.`
            : status === DRAFT_STATUS.DRAFTING
              ? `Draft running — ${picksMade} of ${board.length} picks in.`
              : status === DRAFT_STATUS.KEEPERS
                ? 'Keeper tagging is open to managers.'
                : 'Nothing has been started yet.'}
        </div>
        <div style={M.statusRow}>
          <span style={M.statusDot(archived ? colors.earningsGreen : colors.textMuted)} />
          <span style={{ fontFamily: fonts.sans, fontSize: fontSize.sm, color: colors.textSecondary }}>
            {archived ? `${SEASON} archived` : `${SEASON} not archived`}
          </span>
        </div>
      </div>

      {/* ── 1 · Archive ── */}
      <div style={M.group}>
        <StepHeader n={1} title="Archive the season" done={archived} />
        <div style={M.descText}>
          Writes the final standings, the rosters teams finished on, the schedule with
          its results and every transaction. Managers can read it afterwards under
          More → Season Archive, which is the only way back to {SEASON} once step 6 has
          deleted the transactions and the schedule import has replaced the events.
          Step 6 will not run without it.
        </div>
        <button
          onClick={handleArchive}
          disabled={busy === 'archive'}
          className="modal-feel-lift modal-feel-primary"
          style={{ ...M.btnPrimary, ...disabledBtn(busy === 'archive') }}
        >
          {busy === 'archive' ? '⏳ Archiving…' : archived ? `Re-archive ${SEASON}` : `Archive ${SEASON}`}
        </button>
      </div>

      {/* ── 2 · Years of service ── */}
      <div style={M.group}>
        <StepHeader
          n={2}
          title="Years of service"
          done={status === DRAFT_STATUS.DRAFTING || status === DRAFT_STATUS.COMPLETE}
        />
        <KeeperYearsStep teams={teams} rosters={rosters} updateTeams={updateTeams} />
      </div>

      {/* ── 3 · Draft order ── */}
      <div style={M.group}>
        <StepHeader n={3} title="Draft order" done={!!draft.state?.orderTeamIds?.length} />
        <div style={M.descText}>
          Reverse final standings — last place picks first — and it snakes every round.
          Ties break on team id, so settle a real one with the arrows.
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <div style={{ flex: 1 }}>
            <label style={S.lbl} htmlFor="sfgl-rounds">Rounds</label>
            <input
              id="sfgl-rounds"
              type="number" min="1" max="30"
              value={effRounds}
              onChange={e => setRounds(Number(e.target.value))}
              style={{ ...M.input, width: '100%', boxSizing: 'border-box' }}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label style={S.lbl} htmlFor="sfgl-limited-rounds">Limited rounds</label>
            <input
              id="sfgl-limited-rounds"
              type="number" min="0" max="30"
              value={effLimitedRounds}
              onChange={e => setLimitedRounds(Number(e.target.value))}
              style={{ ...M.input, width: '100%', boxSizing: 'border-box' }}
            />
          </div>
        </div>
        <div style={{ fontFamily: fonts.sans, fontSize: fontSize.caption, color: colors.textGoldDim, marginBottom: 8 }}>
          {suggestedRounds} rounds fills a {rosterLimit}-man roster around {KEEPER_SLOTS.length} keepers.
          The first {effLimitedRounds} round{effLimitedRounds === 1 ? '' : 's'} make their picks limited.
        </div>

        {effOrder.map((teamId, i) => {
          const row = standings.find(s => s.teamId === teamId);
          return (
            <div
              key={teamId}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '7px 9px', marginBottom: 3, borderRadius: 4,
                background: white(0.025), border: `1px solid ${colors.borderSubtle}`,
              }}
            >
              <span style={{
                width: 22, fontFamily: fonts.sans, fontSize: fontSize.sm,
                fontWeight: 700, color: colors.textMuted, flexShrink: 0,
              }}>
                {i + 1}
              </span>
              <span style={{
                flex: 1, minWidth: 0, fontFamily: fonts.sans, fontSize: fontSize.md,
                color: colors.textPrimary,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {teamName(teamId)}
                <span style={{ color: colors.textMuted, fontSize: fontSize.xs, marginLeft: 6 }}>
                  {row ? `${row.position}${row.position === 1 ? 'st' : row.position === 2 ? 'nd' : row.position === 3 ? 'rd' : 'th'} in ${SEASON}` : ''}
                </span>
              </span>
              <button type="button" onClick={() => move(i, -1)} disabled={i === 0}
                style={{ ...M.btnSecondary, padding: '2px 8px', opacity: i === 0 ? 0.3 : 1 }}
                aria-label={`Move ${teamName(teamId)} up`}>↑</button>
              <button type="button" onClick={() => move(i, 1)} disabled={i === effOrder.length - 1}
                style={{ ...M.btnSecondary, padding: '2px 8px', opacity: i === effOrder.length - 1 ? 0.3 : 1 }}
                aria-label={`Move ${teamName(teamId)} down`}>↓</button>
            </div>
          );
        })}

        <button
          onClick={handleSaveOrder}
          disabled={busy === 'order' || status === DRAFT_STATUS.DRAFTING || status === DRAFT_STATUS.COMPLETE}
          className="modal-feel-lift modal-feel-primary"
          style={{
            ...M.btnPrimary, marginTop: 8,
            ...disabledBtn(busy === 'order' || status === DRAFT_STATUS.DRAFTING || status === DRAFT_STATUS.COMPLETE),
          }}
        >
          {busy === 'order' ? '⏳ Saving…' : 'Save order & rounds'}
        </button>
        {(status === DRAFT_STATUS.DRAFTING || status === DRAFT_STATUS.COMPLETE) && (
          <div style={{ fontFamily: fonts.sans, fontSize: fontSize.caption, color: colors.warning, marginTop: 4 }}>
            Locked — the draft has started. Reversing it would move picks that are already made.
          </div>
        )}
      </div>

      {/* ── 4 · Keepers ── */}
      <div style={M.group}>
        <StepHeader n={4} title="Keeper tagging" done={status === DRAFT_STATUS.DRAFTING || status === DRAFT_STATUS.COMPLETE} />
        <div style={M.descText}>
          One limited keeper and one unlimited keeper per manager. A limited player on
          three stars cannot be kept; an unlimited player promoted into the limited slot
          picks up a retroactive star for his unlimited season.
        </div>

        {teams.map(t => {
          const id = t.id || t.name;
          const k = t.keepers || {};
          return (
            <div
              key={id}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '7px 9px', marginBottom: 3, borderRadius: 4,
                background: white(0.025), border: `1px solid ${colors.borderSubtle}`,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: fonts.sans, fontSize: fontSize.md, color: colors.textPrimary }}>
                  {t.name}
                </div>
                <div style={{ fontFamily: fonts.sans, fontSize: fontSize.xs, marginTop: 1 }}>
                  <span style={{ color: k.limited ? colors.textGold : colors.textMuted }}>
                    {k.limited || 'no limited keeper'}
                  </span>
                  <span style={{ color: colors.textMuted }}> · </span>
                  <span style={{ color: k.unlimited ? steel(0.9) : colors.textMuted }}>
                    {k.unlimited || 'no unlimited keeper'}
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setTagging(id)}
                style={{ ...M.btnSecondary, padding: '4px 10px', flexShrink: 0 }}
              >
                Tag
              </button>
            </div>
          );
        })}

        <button
          onClick={() => setStatus(DRAFT_STATUS.KEEPERS, 'Keeper tagging is open')}
          disabled={busy === 'status' || status === DRAFT_STATUS.KEEPERS}
          className="modal-feel-lift modal-feel-primary"
          style={{ ...M.btnPrimary, marginTop: 8, ...disabledBtn(busy === 'status' || status === DRAFT_STATUS.KEEPERS) }}
        >
          {status === DRAFT_STATUS.KEEPERS ? 'Tagging is open' : 'Open keeper tagging'}
        </button>
      </div>

      {/* ── 5 · Draft ── */}
      <div style={M.group}>
        <StepHeader n={5} title="Run the draft" done={status === DRAFT_STATUS.COMPLETE || (board.length > 0 && picksMade >= board.length)} />
        <div style={M.descText}>
          {board.length === 0
            ? 'Save an order first — there is no board to run.'
            : onTheClock
              ? `${pickLabel(onTheClock)} · ${teamName(onTheClock.teamId)} on the clock. ${picksMade} of ${board.length} picks in.`
              : `All ${board.length} picks are in.`}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => setStatus(DRAFT_STATUS.DRAFTING, 'The draft is open')}
            disabled={busy === 'status' || board.length === 0 || status === DRAFT_STATUS.DRAFTING}
            className="modal-feel-lift modal-feel-primary"
            style={{
              ...M.btnPrimary, flex: 1,
              ...disabledBtn(busy === 'status' || board.length === 0 || status === DRAFT_STATUS.DRAFTING),
            }}
          >
            {status === DRAFT_STATUS.DRAFTING ? 'Draft is open' : 'Start the draft'}
          </button>
          <button
            onClick={() => setShowDraft(true)}
            disabled={board.length === 0}
            style={{ ...M.btnSecondary, flex: 1, ...disabledBtn(board.length === 0) }}
          >
            Open the board
          </button>
        </div>
      </div>

      {/* ── 6 · Apply ── */}
      <div style={M.group}>
        <StepHeader n={6} title="Apply the rollover" done={status === DRAFT_STATUS.COMPLETE} />
        <div style={M.descText}>
          Replaces every roster with its keepers and picks, clears lineups, money and
          mulligans, resets the limited-start counts, and deletes the {SEASON} transactions
          so they cannot replay onto the new rosters. Everyone not kept or drafted is
          stripped of colour, stars and years of service — they go back into the pool
          with nothing.
        </div>
        {!archived && (
          <div style={{
            padding: '8px 11px', borderRadius: 4, marginBottom: 8,
            background: colors.warningBg, border: `1px solid ${colors.warningBorder}`,
            fontFamily: fonts.sans, fontSize: fontSize.sm, color: colors.warning,
          }}>
            Archive {SEASON} first (step 1). The archive is the only copy after this runs.
          </div>
        )}
        <button
          onClick={handleApply}
          disabled={busy === 'apply' || !archived || status === DRAFT_STATUS.COMPLETE}
          className="modal-feel-lift"
          style={{
            ...M.btnDanger,
            ...disabledBtn(busy === 'apply' || !archived || status === DRAFT_STATUS.COMPLETE),
          }}
        >
          {busy === 'apply' ? '⏳ Rolling over…'
            : status === DRAFT_STATUS.COMPLETE ? `${NEXT_SEASON} rosters are live`
            : `Roll the league into ${NEXT_SEASON}`}
        </button>
      </div>

      {/* ── What is left, and what only a deploy can do ── */}
      <div style={M.group}>
        <div style={M.eyebrow}>Then, by hand</div>
        <ol style={{
          margin: 0, paddingLeft: 20,
          fontFamily: fonts.sans, fontSize: fontSize.sm,
          color: colors.textSecondary, lineHeight: 1.7,
        }}>
          <li>
            Import the {NEXT_SEASON} schedule (Import Schedule). It replaces the schedule
            wholesale, which is what retires {SEASON}&apos;s results from the standings.
          </li>
          <li>
            Bump <code>SEASON</code> to {NEXT_SEASON} in <code>api/_league.js</code> and
            deploy. It is a build-time constant — <code>vite.config.ts</code> substitutes it
            into the page title — and it keys the results-fetch URL, so it moves LAST,
            once nothing is left to process for {SEASON}.
          </li>
          <li>
            Update <code>LIV_GOLF_ROSTER</code> in <code>src/constants/index.js</code> for
            the new LIV season, then re-run the OWGR sync from Data Sync.
          </li>
        </ol>
      </div>

      {tagTeam && (
        <Suspense fallback={null}>
          <LazyKeeperTagModal
            isOpen
            onClose={() => setTagging(null)}
            team={tagTeam}
            roster={rosters[tagTeam.id || tagTeam.name] || []}
            season={NEXT_SEASON}
            onSave={async (keepers) => {
              await updateTeams(teams.map(t => ((t.id || t.name) === (tagTeam.id || tagTeam.name)
                ? { ...t, keepers: { ...keepers, season: NEXT_SEASON, taggedAt: new Date().toISOString() } }
                : t)));
            }}
          />
        </Suspense>
      )}

      {showDraft && (
        <Suspense fallback={null}>
          <LazyDraftModal
            isOpen
            onClose={() => setShowDraft(false)}
            season={NEXT_SEASON}
            state={draft.state}
            picks={draft.picks}
            order={board}
            onTheClock={onTheClock}
            teams={teams}
            allPlayers={allPlayers}
            registry={attrIndex}
            keptNames={keptNames}
            isCommissioner
            myTeamId={null}
            onMakePick={async (slot, player) => {
              await draftApi.makePick(NEXT_SEASON, {
                overall: slot.overall, round: slot.round, pickInRound: slot.pickInRound,
                teamId: slot.teamId, originalTeamId: slot.originalTeamId,
                limited: !!slot.limited, player,
              });
            }}
            onUndoPick={(overall) => draftApi.undoPick(NEXT_SEASON, overall)}
            onTrade={(trade) => draftApi.set(NEXT_SEASON, {
              trades: [...(draft.state?.trades || []), { ...trade, at: new Date().toISOString() }],
            })}
            onUntrade={(i) => draftApi.set(NEXT_SEASON, {
              trades: (draft.state?.trades || []).filter((_, idx) => idx !== i),
            })}
          />
        </Suspense>
      )}
    </div>
  );
};

export default SeasonRolloverPanel;
