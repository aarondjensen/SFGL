// src/components/OffseasonBar.jsx
// ============================================================================
// The one thing a manager needs to see between seasons, on whatever tab they
// happen to be on: tag your keepers, or you are on the clock.
//
// It sits in App.jsx above the tab content rather than inside RostersView
// because neither of those two deadlines is a rosters-tab concern — a manager
// who opens the app on Standings in November has to find out that the draft
// has started, and a banner that only exists on one tab does not tell them.
//
// The bar renders NOTHING outside the rollover window (draft status `keepers`
// or `drafting`), which is most of the year. Both sheets it opens are
// React.lazy: a manager who never opens them never downloads them, and the
// first-load budget guard (scripts/test-bundle-budget.mjs) asserts the set of
// chunks on the critical path, so a static import here would fail the build's
// own test rather than quietly costing every visitor the draft room.
// ============================================================================

import { useState, useMemo, Suspense, lazy } from 'react';
import { NEXT_SEASON } from '../../api/_league.js';
import { DRAFT_STATUS, KEEPER_SLOTS, pickLabel } from '../../api/_draft.js';
import { useDraft } from '../hooks/useDraft';
import { useDialog } from '../pages/DialogContext';
import { draftApi } from '../api/firebase';
import { hydratedRoster, buildPlayerAttributeIndex, getPlayerRegistry } from '../utils/sharedHelpers';
import { colors, fonts, fontSize, gold, green, white } from '../theme.js';

const LazyKeeperTagModal = lazy(() => import('../pages/KeeperTagModal').then(m => ({ default: m.KeeperTagModal })));
const LazyDraftModal     = lazy(() => import('../pages/DraftModal').then(m => ({ default: m.DraftModal })));

export const OffseasonBar = ({
  teams = [], transactions = [], tournaments = [], allPlayers = [],
  loggedInTeamId, isCommissioner = false, updateTeam,
}) => {
  const dialog = useDialog();
  const draft = useDraft(NEXT_SEASON);
  const [sheet, setSheet] = useState(null);   // null | 'keepers' | 'draft'

  const myTeam = useMemo(
    () => teams.find(t => (t.id || t.name) === loggedInTeamId) || null,
    [teams, loggedInTeamId],
  );

  // One attribute index for the whole bar. Building it per team would rebuild
  // the registry merge once per roster for no benefit — every team's keeper
  // eligibility is judged against the same durable index.
  const attrIndex = useMemo(
    () => buildPlayerAttributeIndex(teams, tournaments, getPlayerRegistry()),
    [teams, tournaments],
  );

  const myRoster = useMemo(
    () => (myTeam ? hydratedRoster(myTeam, transactions, { tournaments, attrIndex }) : []),
    [myTeam, transactions, tournaments, attrIndex],
  );

  // Every player anybody has tagged. The draft pool has to exclude all of them,
  // not just this manager's — a kept player is off the board league-wide.
  const keptNames = useMemo(
    () => teams.flatMap(t => KEEPER_SLOTS.map(slot => t?.keepers?.[slot]).filter(Boolean)),
    [teams],
  );

  const myTagged = KEEPER_SLOTS.filter(s => myTeam?.keepers?.[s]).length;
  const teamName = (id) => teams.find(t => (t.id || t.name) === id)?.name || id;

  const saveKeepers = async (keepers) => {
    if (!myTeam) throw new Error('No team to tag keepers for.');
    await updateTeam(myTeam.id || myTeam.name, {
      keepers: { ...keepers, season: NEXT_SEASON, taggedAt: new Date().toISOString() },
    });
  };

  const makePick = async (slot, player) => {
    await draftApi.makePick(NEXT_SEASON, {
      overall: slot.overall,
      round: slot.round,
      pickInRound: slot.pickInRound,
      teamId: slot.teamId,
      originalTeamId: slot.originalTeamId,
      limited: !!slot.limited,
      player,
    });
    dialog.showToast(`✓ ${player} — ${pickLabel(slot)}`, 'success');
  };

  // Trades and undos are commissioner writes (firestore.rules), so the buttons
  // that call these only render for one. Reaching them any other way fails at
  // the database rather than here, which is the intended order.
  const recordTrade = async (trade) => {
    const trades = [...(draft.state?.trades || []), { ...trade, at: new Date().toISOString() }];
    await draftApi.set(NEXT_SEASON, { trades });
    dialog.showToast('✓ Trade recorded', 'success');
  };

  const reverseTrade = async (index) => {
    const trades = (draft.state?.trades || []).filter((_, i) => i !== index);
    await draftApi.set(NEXT_SEASON, { trades });
    dialog.showToast('Trade reversed', 'info');
  };

  const undoPick = async (overall) => {
    await draftApi.undoPick(NEXT_SEASON, overall);
    dialog.showToast('Pick undone', 'info');
  };

  // Most of the year there is no rollover in progress and this is invisible.
  if (draft.loading || (!draft.keepersOpen && !draft.drafting)) return null;

  const keepersMode = draft.status === DRAFT_STATUS.KEEPERS;
  const myClock = draft.onTheClock && draft.onTheClock.teamId === loggedInTeamId;
  const accent = keepersMode ? colors.textGold : colors.earningsGreen;

  const headline = keepersMode
    ? (myTeam
        ? `${NEXT_SEASON} keepers — ${myTagged} of ${KEEPER_SLOTS.length} tagged`
        : `${NEXT_SEASON} keepers are open`)
    : draft.onTheClock
      ? `${pickLabel(draft.onTheClock)} — ${myClock ? 'you are on the clock' : `${teamName(draft.onTheClock.teamId)} on the clock`}`
      : `${NEXT_SEASON} draft — every pick is in`;

  return (
    <>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 14px', marginBottom: 12, borderRadius: 6,
        background: myClock ? green(0.1) : keepersMode ? gold(0.07) : white(0.035),
        border: `1px solid ${myClock ? green(0.45) : keepersMode ? colors.border : colors.borderSubtle}`,
      }}>
        <span style={{ fontSize: fontSize.lg, lineHeight: 1, flexShrink: 0 }} aria-hidden="true">
          {keepersMode ? '🏷️' : '📋'}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontFamily: fonts.sans, fontSize: fontSize.xs, fontWeight: 700,
            letterSpacing: '1.6px', textTransform: 'uppercase', color: accent,
          }}>
            Offseason
          </div>
          <div style={{
            fontFamily: fonts.sans, fontSize: fontSize.base, color: colors.textPrimary,
            overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {headline}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setSheet(keepersMode ? 'keepers' : 'draft')}
          disabled={keepersMode && !myTeam}
          style={{
            flexShrink: 0,
            padding: '7px 14px', borderRadius: 4, cursor: 'pointer',
            background: accent === colors.textGold ? gold(0.15) : green(0.15),
            border: `1px solid ${accent}`,
            color: accent,
            fontFamily: fonts.sans, fontSize: fontSize.sm, fontWeight: 700,
            letterSpacing: '0.5px',
            opacity: (keepersMode && !myTeam) ? 0.4 : 1,
          }}
        >
          {keepersMode ? 'Tag keepers' : 'Open draft'}
        </button>
      </div>

      {sheet && (
        <Suspense fallback={null}>
          {sheet === 'keepers' ? (
            <LazyKeeperTagModal
              isOpen
              onClose={() => setSheet(null)}
              team={myTeam}
              roster={myRoster}
              season={NEXT_SEASON}
              onSave={saveKeepers}
            />
          ) : (
            <LazyDraftModal
              isOpen
              onClose={() => setSheet(null)}
              season={NEXT_SEASON}
              state={draft.state}
              picks={draft.picks}
              order={draft.order}
              onTheClock={draft.onTheClock}
              teams={teams}
              allPlayers={allPlayers}
              registry={attrIndex}
              keptNames={keptNames}
              isCommissioner={isCommissioner}
              myTeamId={loggedInTeamId}
              onMakePick={makePick}
              onUndoPick={undoPick}
              onTrade={recordTrade}
              onUntrade={reverseTrade}
            />
          )}
        </Suspense>
      )}
    </>
  );
};

export default OffseasonBar;
