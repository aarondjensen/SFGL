import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { useDialog } from './DialogContext';
import { AddDropPlayerModal } from './AddDropPlayerModal';
import { TeamName } from '../components/TeamName';

import { useRoster, useWindowStatus } from '../hooks';
import { useIsMobile } from '../hooks/useIsMobile.js';
import {
  getSortedRoster,
  getFreeAgentWindowStatus,
  getSegmentByDate, isTournamentLocked,
  isWaiverWindowOpen,
  getCurrentTournamentIndex,
  abbreviateName,
} from '../utils';
// LINEUP_SIZE comes from the leagueSettings prop; the limited-start cap and
// the rule that enforces it come from api/_rules.js.
import { theme, colors, fonts, fontSize, gold, green, greenMuted, navy, red, steel, white, black, blueBright, yellow } from '../theme.js';
import { isBackupSpotEnabled, resolveTxTournamentIndex, resolveTxTournament, getETClock, txBelongsToTeam } from '../utils/sharedHelpers';
import { waiverCutoff, fmtWaiverCutoff } from '../../api/_league.js';
import { limitedStartsStatus, startsUsedByPlayer, maxLimitedStarts, lineupTargetIndex } from '../../api/_rules.js';
import { NameSet, NameMap } from '../../api/_playerNames.js';
import { activatable } from '../utils/a11y';

// ── Headshot helpers (shared — single source of truth in headshotUtils.js) ──
// Thin wrappers preserve the (name, isLimited, headshotMap) call signature
// used throughout this file — headshotUtils uses (name, headshotMap, isLimited).
import {
  getPlayerHeadshot as _getPlayerHeadshot,
  makeHeadshotErrorHandler as _makeHeadshotErrorHandler,
  mergeHeadshotEntry,
} from '../utils/headshotUtils';

const getPlayerHeadshot = (playerName, isLimited = false, headshotMap = {}) =>
  _getPlayerHeadshot(playerName, headshotMap, isLimited);

const makeHeadshotErrorHandler = (playerName, isLimited, headshotMap) =>
  _makeHeadshotErrorHandler(playerName, headshotMap, isLimited);

// ── Border color by player type ───────────────────────────────────────────────
const playerBorderColor = (player) =>
  player.limited   ? gold(0.9) :
  player.unlimited ? steel(0.9) :
  white(0.85);

// ── Mobile display name helper ───────────────────────────────────────────────
// useIsMobile moved to src/hooks/useIsMobile.js — the schedule editor needs the
// same breakpoint, and a second copy of a resize listener is how two surfaces
// end up disagreeing about what "mobile" is.

// ── Custom team dropdown — stays dark on all browsers ─────────────────────────
const TeamDropdown = ({ teams, value, onChange }) => {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef(null);
  const selected = teams.find(t => t.id === value);

  React.useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div ref={ref} style={{ position: 'relative', minWidth: 0 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          ...theme.sectionTitle,
          textTransform: 'uppercase', letterSpacing: '0.4px',
          gap: 6, padding: 0, border: 'none', background: 'transparent', cursor: 'pointer',
          textAlign: 'left', whiteSpace: 'nowrap', maxWidth: '100%',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selected ? <TeamName name={selected.name} /> : '—'}
        </span>
        <span style={{ fontSize: fontSize.caption, color: colors.textSecondary, opacity: 0.9, flexShrink: 0 }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, zIndex: 100, marginTop: 2,
          minWidth: '100%', width: 'max-content',
          maxHeight: '60vh', overflowY: 'auto',
          background: '#0f1d35', border: `1px solid ${white(0.15)}`, borderRadius: 2,
          boxShadow: `0 8px 24px ${black(0.5)}`,
        }} className="sfgl-modal-scroll">
          {teams.map(t => (
            <button key={t.id} onClick={() => { onChange(t.id); setOpen(false); }}
              style={{
                display: 'block', width: '100%', padding: '11px 14px', textAlign: 'left', cursor: 'pointer',
                whiteSpace: 'nowrap',
                background: t.id === value ? gold(0.12) : 'transparent',
                border: 'none', borderBottom: `1px solid ${white(0.06)}`,
                fontFamily: fonts.serif, fontSize: fontSize.base, fontWeight: t.id === value ? 700 : 400,
                color: t.id === value ? colors.textGold : white(0.85),
                transition: 'background 0.1s',
              }}
              onMouseEnter={e => { if (t.id !== value) e.currentTarget.style.background = white(0.07); }}
              onMouseLeave={e => { if (t.id !== value) e.currentTarget.style.background = 'transparent'; }}
            >
              <TeamName name={t.name} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// ── Waiver Priority Manager ───────────────────────────────────────────────────
const RosterSlider = ({ leftVal, leftLabel, rightVal, rightLabel, current, setter, leftColor, rightColor, disabled = false, width = 88, colors, fonts }) => (
  <div style={{ opacity: disabled ? 0.3 : 1, pointerEvents: disabled ? 'none' : 'auto', transition: 'opacity 0.18s' }}>
    <div style={{ display: 'flex', gap: 2, background: white(0.04), border: `1px solid ${white(0.10)}`, borderRadius: 10, padding: 3, width }}>
      {[[leftVal, leftLabel, leftColor], [rightVal, rightLabel, rightColor]].map(([val, label, color]) => {
        const active = current === val;
        return (
          <button key={val} onClick={() => setter(val)} style={{
            flex: 1, padding: '6px 0', borderRadius: 8,
            background: active ? white(0.08) : 'transparent',
            border: active ? `1px solid ${white(0.18)}` : '1px solid transparent',
            fontFamily: fonts.sans, fontSize: fontSize.xs, fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase',
            color: active ? color : colors.textMuted,
            cursor: 'pointer', transition: 'all 0.15s',
          }}
          onMouseEnter={e => { if (!active) e.currentTarget.style.background = white(0.05); }}
          onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}
          >{label}</button>
        );
      })}
    </div>
  </div>
);

// Ordinal suffix for waiver priority pills: 1 -> "1st", 2 -> "2nd", 3 -> "3rd"...
const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
};

const WaiverQueue = ({ team, pendingWaivers, transactions, setTransactions, updateTeams, teams, isOwnTeam, settings, onEdit, headshots = {} }) => {
  const dialog = useDialog();

  // NOTE: these handlers read the `transactions` PROP directly rather than a
  // ref mirror. The old `txRef.current = transactions` assignment happened
  // during render (which React forbids — refs aren't render-safe) and bought
  // nothing: handlers are recreated every render, so the prop is already the
  // freshest value at the moment one fires. Reading the prop also keeps them
  // consistent with `pendingWaivers._txIdx`, which is computed against this
  // same array — reading a ref that could differ is how those indexes drift.

  const persistTransactions = (newTx, opts) => {
    setTransactions(newTx, opts);
  };

  const deleteWaiver = (waiver) => {
    const current = transactions;
    // Match by fields to find the right transaction regardless of index shifts
    let removedTx = null;
    const newTx = current.filter(tx => {
      if (!removedTx && txBelongsToTeam(tx, team) && tx.player === waiver.player && tx.droppedPlayer === waiver.droppedPlayer && tx.status === 'pending' && tx.type === 'waiver') {
        removedTx = tx;
        return false;
      }
      return true;
    });
    if (!removedTx) return; // nothing matched
    const newTeams = teams.map(t => t.id === team.id ? { ...t, transactionFees: (t.transactionFees || 0) - (waiver.fee || 0) } : t);
    // sync() never deletes by absence — pass the removed claim explicitly.
    persistTransactions(newTx, { deleted: [removedTx] });
    updateTeams(newTeams);
  };

  const swapPriority = (fromIdx, toIdx) => {
    if (toIdx < 0 || toIdx >= pendingWaivers.length) return;
    const updated   = [...transactions];
    const fromTxIdx = pendingWaivers[fromIdx]._txIdx;
    const toTxIdx   = pendingWaivers[toIdx]._txIdx;
    const fromPri   = pendingWaivers[fromIdx].priority || fromIdx + 1;
    const toPri     = pendingWaivers[toIdx].priority   || toIdx + 1;
    updated[fromTxIdx] = { ...updated[fromTxIdx], priority: toPri };
    updated[toTxIdx]   = { ...updated[toTxIdx],   priority: fromPri };
    persistTransactions(updated);
  };

  if (pendingWaivers.length === 0) return null;

  // Waiver cutoff label + "have we passed it yet" status. This block used to
  // hand-roll all three of: the day-abbreviation array, the cutoff formatter,
  // and an ET clock — the last of which was the toLocaleString round-trip
  // variant, so this panel could disagree with the rest of the app about what
  // day it was. All three now come from the shared helpers.
  const { day: wDay, hour: wHour, minute: wMin } = waiverCutoff(settings);
  const cutoffLabel = fmtWaiverCutoff(settings);

  const waiverStatusLabel = (() => {
    const { day: d, totalMinutes: t } = getETClock();
    const cutoffMinutes = wHour * 60 + wMin;
    if (d < wDay || (d === wDay && t < cutoffMinutes)) return `${cutoffLabel} ET`;
    return 'Pending commish processing';
  })();

  return (
    <div style={{
      background: 'rgba(180,160,60,0.08)',
      border: '1px solid rgba(180,160,60,0.3)',
      borderRadius: 12, padding: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <h3 style={{ ...theme.label, color: yellow(0.9), fontSize: fontSize.sm }}>
          Pending claims ({pendingWaivers.length})
        </h3>
        <span style={{ ...theme.smallText, color: yellow(0.6) }}>{waiverStatusLabel}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {pendingWaivers.map((waiver, index) => (
          <div key={waiver._txIdx} style={{
            background: white(0.04),
            borderRadius: 10, padding: '8px 10px',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            {isOwnTeam && pendingWaivers.length > 1 && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0 }}>
                <button onClick={() => swapPriority(index, index - 1)} disabled={index === 0}
                  style={{ background: 'none', border: 'none', cursor: index === 0 ? 'not-allowed' : 'pointer',
                    color: index === 0 ? colors.textMuted : yellow(0.8), fontSize: fontSize.md, padding: '6px 10px', lineHeight: 1 }}>▲</button>
                <span style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  minWidth: 30, padding: '2px 7px', margin: '2px 0', borderRadius: 999,
                  background: yellow(0.16), border: `1px solid ${yellow(0.35)}`,
                  fontFamily: fonts.sans, fontSize: fontSize.xs, fontWeight: 700,
                  color: yellow(0.95), lineHeight: 1.3, letterSpacing: '0.2px',
                }}>{ordinal(index + 1)}</span>
                <button onClick={() => swapPriority(index, index + 1)} disabled={index === pendingWaivers.length - 1}
                  style={{ background: 'none', border: 'none', cursor: index === pendingWaivers.length - 1 ? 'not-allowed' : 'pointer',
                    color: index === pendingWaivers.length - 1 ? colors.textMuted : yellow(0.8), fontSize: fontSize.md, padding: '6px 10px', lineHeight: 1 }}>▼</button>
              </div>
            )}
            <img
              src={getPlayerHeadshot(waiver.player, false, headshots)}
              onError={makeHeadshotErrorHandler(waiver.player, false, headshots)}
              alt=""
              style={{
                width: 32, height: 32, borderRadius: '50%', objectFit: 'cover',
                flexShrink: 0, background: white(0.06),
                border: `1px solid ${white(0.10)}`,
              }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: colors.success, fontFamily: fonts.sans, fontSize: fontSize.sm, fontWeight: 500 }}>Add: {abbreviateName(waiver.player)}</div>
              {waiver.droppedPlayer && (
                <div style={{ color: colors.danger, fontFamily: fonts.sans, fontSize: fontSize.sm, marginTop: 2 }}>Drop: {abbreviateName(waiver.droppedPlayer)}</div>
              )}
            </div>
            {isOwnTeam && (
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => onEdit && onEdit(waiver)}
                  title="Edit this waiver claim"
                  aria-label="Edit this waiver claim"
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    width: 34, height: 34, borderRadius: 10, flexShrink: 0,
                    background: white(0.05),
                    border: `1px solid ${white(0.10)}`,
                    color: white(0.78), cursor: 'pointer',
                    fontSize: fontSize.sm, lineHeight: 1, transition: 'all 0.15s',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = white(0.10); e.currentTarget.style.borderColor = white(0.20); }}
                  onMouseLeave={e => { e.currentTarget.style.background = white(0.05); e.currentTarget.style.borderColor = white(0.10); }}
                >✎</button>
                <button onClick={async () => {
                  const ok = await dialog.showConfirm('Withdraw Waiver', `Withdraw the waiver claim for ${waiver.player}? The $${waiver.fee || 0} fee will be refunded.`, { type: 'danger', confirmText: 'Withdraw' });
                  if (!ok) return;
                  deleteWaiver(waiver);
                }}
                title="Withdraw this waiver claim"
                aria-label="Withdraw this waiver claim"
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: 34, height: 34, borderRadius: 10, flexShrink: 0,
                  background: red(0.10),
                  border: `1px solid ${red(0.28)}`,
                  color: 'rgba(232,120,120,0.95)', cursor: 'pointer',
                  fontSize: fontSize.sm, lineHeight: 1, transition: 'all 0.15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = red(0.18); e.currentTarget.style.borderColor = red(0.45); }}
                onMouseLeave={e => { e.currentTarget.style.background = red(0.10); e.currentTarget.style.borderColor = red(0.28); }}
                >✕</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

// ── Main RostersView ──────────────────────────────────────────────────────────
// ── LineupHeadshot — shows ×-remove button on hover when editable ─────────────
const LineupHeadshot = ({ player, lastName, nameFontSize, headshots, canEdit, onRemove }) => {
  const [hovered, setHovered] = React.useState(false);
  const [tapped, setTapped]   = React.useState(false);
  const [focused, setFocused] = React.useState(false);
  const containerRef = React.useRef(null);
  const isMobileDevice = typeof window !== 'undefined' && 'ontouchstart' in window;

  // Reset tapped state when user touches anywhere outside this headshot
  React.useEffect(() => {
    if (!tapped) return;
    const handler = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setTapped(false);
      }
    };
    document.addEventListener('touchstart', handler, { passive: true });
    return () => document.removeEventListener('touchstart', handler);
  }, [tapped]);

  // Reset tapped when lineup edit mode is exited
  React.useEffect(() => {
    if (!canEdit) setTapped(false);
  }, [canEdit]);

  // On mobile: first tap reveals the × badge, second tap (on the ×) removes.
  // Tapping elsewhere resets. On desktop: hover reveals ×.
  //
  // Keyboard gets the same reveal from focus. Without it the × is unreachable
  // by any route: it only mounts while hovered or tapped, so a keyboard user
  // could never Tab to a button that does not exist yet. Focusing the tile
  // mounts it, and the next Tab lands on it.
  const showRemove = canEdit && (hovered || tapped || focused);

  return (
    <div
      ref={containerRef}
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 56, overflow: 'visible' }}
      tabIndex={canEdit ? 0 : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setTapped(false); }}
      onFocus={() => setFocused(true)}
      // Focus moving to the × itself is still focus inside this tile — hiding
      // the button the moment it is focused would unmount it mid-Tab.
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false); }}
      onKeyDown={(e) => {
        if (!canEdit || e.target !== e.currentTarget) return;
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.stopPropagation();
        onRemove();
      }}
      onClick={(e) => {
        e.stopPropagation();
        if (!canEdit) return;
        if (isMobileDevice) {
          if (tapped) { onRemove(); setTapped(false); }
          else setTapped(true);
        }
      }}
    >
      <div style={{ position: 'relative', width: 44, height: 44, overflow: 'visible' }}>
        <img
          src={getPlayerHeadshot(player.name, player.limited, headshots)}
          onError={makeHeadshotErrorHandler(player.name, player.limited, headshots)}
          alt=""
          style={{
            width: 44, height: 44, borderRadius: '50%', objectFit: 'cover',
            border: `2px solid ${playerBorderColor(player)}`,
            transition: 'opacity 0.15s',
            opacity: showRemove ? 0.55 : 1,
          }}
        />
        {showRemove && (
          <button
            onClick={e => { e.stopPropagation(); onRemove(); setTapped(false); }}
            style={{
              position: 'absolute', top: -3, right: -3,
              width: 18, height: 18, borderRadius: '50%',
              background: 'rgba(220,60,60,0.92)',
              border: `1.5px solid ${white(0.25)}`,
              color: '#fff',
              fontSize: fontSize.sm, fontWeight: 700, lineHeight: 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer',
              boxShadow: `0 2px 6px ${black(0.5)}`,
              padding: 0,
              zIndex: 10,
              transition: 'transform 0.1s',
            }}
            onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.15)'; }}
            onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; }}
            title={'Remove ' + player.name + ' from lineup'}
            aria-label={'Remove ' + player.name + ' from lineup'}
          >
            {'\u00D7'}
          </button>
        )}
        {player.limited && (player.stars || 1) > 0 && (
          <div style={{
            position: 'absolute', bottom: -4, left: '50%', transform: 'translateX(-50%)',
            background: navy(0.88), borderRadius: 6,
            padding: '0px 3px', lineHeight: 1, zIndex: 5,
            fontSize: fontSize.badge, letterSpacing: 1,
          }}>
            {'⭐'.repeat(player.stars || 1)}
          </div>
        )}
      </div>
      <div style={{
        fontSize: nameFontSize, fontFamily: fonts.sans, marginTop: 3,
        textAlign: 'center', width: '100%',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        color: player.limited ? colors.textGold : player.unlimited ? steel(0.9) : colors.textPrimary,
      }}>
        {lastName}
      </div>
    </div>
  );
};

export const RostersView = ({
  teams, selectedTeam, setSelectedTeam, updateTeams,
  tournaments, allPlayers, transactions, setTransactions,
  // loggedInTeamId is the IMMUTABLE edit-permission key (Firebase uid → team,
  // via team_claims). App.jsx has always passed it, but this view used to
  // destructure only the EDITABLE owner name (loggedInUser) and key
  // permissions off `team.owner === loggedInUser` — so renaming an owner
  // locked that manager out of their own lineup, exactly what App.jsx's
  // comment on loggedInTeamId warns against. Nothing here needs the owner
  // name any more, so it is no longer destructured.
  loggedInTeamId, isCommissioner, globalPlayerStats, headshots,
  updateHeadshots,
  leagueSettings = {}, settings,
}) => {
  // leagueSettings may come from either prop name (App passes settings=)
  const resolvedSettings = settings || leagueSettings;
  // Destructure with fallbacks to constants for safety
  const LINEUP_SIZE       = resolvedSettings.lineupSize       ?? 5;
  // The limited-start cap is NOT read here. It comes out of limitedStartsStatus
  // (api/_rules.js) along with the count it is compared against, so the badge
  // and the lineup gate can never be looking at different numbers.
  const isMobile            = useIsMobile();
  const [statsView,         setStatsView]         = useState('sfgl');
  const [rosterView,        setRosterView]        = useState('full'); // 'full' | 'playing'
  const [infoView,          setInfoView]          = useState('info'); // 'info' | 'stats'
  const [sortCol,           setSortCol]           = useState(null);  // null | 'teeTime' | 'odds' | 'owgr' | 'cuts' | 'earnings'
  const [sortDir,           setSortDir]           = useState('asc');
  const [showAddDropModal,  setShowAddDropModal]  = useState(false);
  const [lineupMode,        setLineupMode]        = useState(false);
  // pickingBackup: explicit "next tap fills the backup slot" mode. Set when
  // the user taps the empty backup placeholder; cleared after a player is
  // picked or after Cancel is pressed. Lets the user designate a backup at
  // ANY point — not just after filling all 5 starters (which was the bug
  // in the original implementation).
  const [pickingBackup,     setPickingBackup]     = useState(false);
  // Lineup mode is exited by clicking anywhere in the background — two wrapper
  // <div>s carry that handler. Those wrappers are deliberately NOT given a tab
  // stop: a "click anywhere to cancel" region is not a control, and making the
  // whole roster card focusable would put a meaningless stop in front of every
  // real one. Escape is the keyboard's equivalent of clicking away.
  useEffect(() => {
    if (!lineupMode) return;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      // A modal on top owns Escape — closing the Add/Drop sheet should not
      // also silently discard the lineup edit underneath it.
      if (document.querySelector('[role="dialog"]')) return;
      setLineupMode(false);
      setPickingBackup(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [lineupMode]);

  const [isWaiverMode,      setIsWaiverMode]      = useState(false);
  const [editingWaiverData, setEditingWaiverData] = useState(null);
  // Field / tee time / odds lookups are keyed by player IDENTITY, not by
  // string. They were plain Set/object keyed on normalizeNordic(name), which
  // meant a roster entry spelled differently from the field payload — 'Nico
  // Echavarria' vs 'Nicolas Echavarria' — silently missed on every one of
  // them at once: no ⛳, hidden by the "Playing" filter, no tee time, no odds,
  // no live score, plus a bogus "not in this week's field" warning when the
  // manager tried to start them. NameSet/NameMap compare equivalence classes,
  // so .has()/.get() take the RAW roster name and do the matching themselves.
  const [tournamentField,   setTournamentField]   = useState(null); // NameSet
  const [teeTimeMap,        setTeeTimeMap]        = useState(() => new NameMap()); // → '8:04 AM'
  // No fieldPlayerIds state. It was fed from `data.playerIds`, a response key
  // /api/field stopped emitting when it split that mixed map into
  // namespace-pure pgaIds/espnIds/photos — so it had been {} ever since, and
  // neither consumer ever read the prop. Repointing it at `pgaIds` would have
  // been worse than deleting it: the prop is typed as ESPN ids, and a PGA id
  // used to build an ESPN URL resolves to a DIFFERENT REAL GOLFER's photo.
  // Headshots come from `headshots` (App.jsx) via getPlayerHeadshot.
  const [oddsMap,           setOddsMap]           = useState(() => new NameMap()); // → '+2000'
  const [liveData,          setLiveData]          = useState(null); // { players, round, state } from /api/live
  const dialog = useDialog();

  const activeTournament      = tournaments.find(t => t.playing);
  const activeTournamentIndex = activeTournament ? tournaments.findIndex(t => t.name === activeTournament.name) : -1;
  // Whether the optional 6th "backup" lineup slot is offered this week. Driven
  // by the commish's per-event-type toggles in Season Settings.
  const backupAllowed = isBackupSpotEnabled(activeTournament, resolvedSettings);
  // ── Date-based tournament week resolution ────────────────────────────────
  // Wave C.5: was a 36-line local implementation (`getAddDropTournamentIndex`)
  // duplicating logic in TransactionsView. Now uses the canonical
  // getCurrentTournamentIndex from utils — same Sun-Sat week semantics, same
  // fallback chain (next non-completed → last tournament).
  const addDropTournamentIndex = getCurrentTournamentIndex(tournaments);

  // Window math (waiver / free-agent) must survive the gap between an event being
  // marked processed/not-playing and the next being flagged `playing`. During
  // that gap `activeTournament` is undefined, so isWaiverWindowOpen() collapses
  // to false and an in-window claim would silently degrade to an instant
  // free-agent add. Fall back to the date-anchored upcoming tournament so the
  // window is evaluated against a real event regardless of the `playing` flag.
  const windowTournament = activeTournament || tournaments[addDropTournamentIndex] || null;

  // Switch to the logged-in manager's team when their claimed team resolves
  // (e.g. after login). Keyed on loggedInTeamId, not the owner name.
  const prevLoggedInTeamId = React.useRef(null);
  useEffect(() => {
    if (teams.length === 0) return;
    const userTeam = loggedInTeamId ? teams.find(t => t.id === loggedInTeamId) : null;
    if (loggedInTeamId && loggedInTeamId !== prevLoggedInTeamId.current && userTeam) {
      // User just signed in / their claim resolved — jump to their team
      setSelectedTeam(userTeam.id);
    } else if (!selectedTeam) {
      // No selection yet — default to user's team or first team
      setSelectedTeam(userTeam?.id ?? teams[0].id);
    }
    prevLoggedInTeamId.current = loggedInTeamId;
  }, [selectedTeam, teams, loggedInTeamId, setSelectedTeam]);

  const team          = teams.find(t => t.id === selectedTeam);
  const currentRoster = useRoster(team, transactions, activeTournamentIndex, tournaments) || [];
  const windowStatus  = useWindowStatus(activeTournament, resolvedSettings);
  // Ownership is the immutable uid→team claim, never the editable owner name.
  const isOwnTeam     = (!!loggedInTeamId && team?.id === loggedInTeamId) || isCommissioner;

  // Soft-warn before slotting a player who isn't in this week's field — but
  // ONLY once the app has actually learned the field. Before it's known (e.g. a
  // Monday-morning lineup set before the field is published) we stay silent so
  // early setters aren't nagged by a false alarm; the tournamentField?.size > 0
  // check is that "field known" gate, mirroring the ⛳ flag + field-only filter
  // elsewhere in this view. Always a confirm, never a hard block: a manager may
  // knowingly slot someone the source hasn't listed yet, and field data can lag
  // reality. Returns true when the caller should proceed.
  //
  // Shared by the starter and backup paths — a backup who isn't playing can't
  // cover a withdrawal, which is the entire reason the slot exists, so it earns
  // the same warning with its own copy.
  const confirmOutOfField = useCallback(async (player, role) => {
    if (!(tournamentField?.size > 0)) return true;
    // tournamentField is a NameSet — pass the RAW name and let it match by
    // identity, exactly as every other call site here does. Pre-normalizing
    // would hand it a spelling no source actually uses.
    if (tournamentField.has(player.name)) return true;
    return await dialog.showConfirm(
      "Not in this week's field",
      role === 'backup'
        ? `${player.name} isn't listed in this week's tournament field. If they've withdrawn or aren't playing, they can't cover a starter. Set as backup anyway?`
        : `${player.name} isn't listed in this week's tournament field. If they've withdrawn or aren't playing, they'll score nothing this week. Add to your lineup anyway?`,
      {
        type: 'warning',
        confirmText: role === 'backup' ? 'Set anyway' : 'Add anyway',
        cancelText: 'Cancel',
      }
    );
  }, [tournamentField, dialog]);

  // Starts committed to each player — scored events plus lineups already
  // frozen at lock. Deliberately NOT sfglStatsMap.starts, which counts only
  // what has been scored: results process Monday while lineup editing reopens
  // Sunday 9pm ET, so for most of a day a player's latest start exists only as
  // a locked lineup and a scored-only count is one short.
  //
  // Every team, not just this one — the cap follows the player across a drop
  // and re-add, which is also what makes this agree with the durable
  // player.starts tally. See startsUsedByPlayer in api/_rules.js.
  const startsUsed = useMemo(
    () => startsUsedByPlayer({ teams, tournaments, transactions }),
    [teams, tournaments, transactions]);

  // The same count stopped at the event this lineup is FOR. That event's own
  // locked lineup must not count against the player sitting in it: being
  // locked into your twelfth start is not the same as having used twelve, and
  // judging on the total told a manager their legal twelfth start was one too
  // many the moment the lineup froze. See lineupTargetIndex.
  const startsBefore = useMemo(
    () => startsUsedByPlayer({
      teams, tournaments, transactions,
      beforeIndex: lineupTargetIndex(tournaments),
    }),
    [teams, tournaments, transactions]);

  // Where each limited player stands against the start cap. One number, used
  // by the badge beside the player's name AND by the gate that keeps them out
  // of the lineup — they used to be two: the badge rendered the derived count
  // while the gate read the stored `player.starts` tally, so a maxed player
  // could read 12/12 on screen and still be addable. limitedStartsStatus takes
  // the higher of the two (see api/_rules.js for why both exist).
  const limitedStatus = useCallback((player) => limitedStartsStatus(player, {
    // Two counts, two jobs: the badge reports every start committed, the gate
    // asks whether another one may be spent.
    derivedStarts: startsUsed.get(player?.name),
    priorStarts: startsBefore.get(player?.name),
    settings: resolvedSettings,
  }), [startsUsed, startsBefore, resolvedSettings]);

  const togglePlayerInLineup = useCallback(async (player) => {
    if (!team) return;
    const isInLineup = (team.lineup || []).includes(player.name);
    const isBackup = team.backup === player.name;
    const activeLineupCount = (team.lineup || []).filter(name => currentRoster.some(p => p.name === name)).length;
    const allowBackup = backupAllowed;
    const lastName = player.name.split(' ').pop();

    // ── EXPLICIT "picking backup" mode ──────────────────────────────────────
    // User tapped the empty backup placeholder first → next player tap fills
    // backup, regardless of starter count. This was the bug: previously the
    // ONLY way to set backup was to fill all 5 starters then tap a 6th. Now
    // it's an intentional, discoverable action.
    if (pickingBackup) {
      // Clear mode now so any error path also exits the mode rather than
      // stranding the user in it.
      setPickingBackup(false);

      if (!allowBackup) {
        // Major flag toggled off mid-flow — silently ignore.
        return;
      }

      // If they tapped the player who's ALREADY the backup, treat as cancel
      // (they don't want to re-set themselves; nothing to do).
      if (isBackup) {
        dialog.showToast('Backup selection cancelled', 'info', { position: 'top' });
        return;
      }

      // Same field warning the starter path gets. A player already in the
      // lineup is exempt: they're being MOVED, not newly slotted, and if they
      // were out of field the manager was already warned when they were added.
      if (!isInLineup && !(await confirmOutOfField(player, 'backup'))) return;

      // If they tapped a player who's currently a starter, move them out of
      // starters and into the backup slot. (Avoids a player being in both.)
      const newTeams = teams.map(t => {
        if (t.id !== team.id) return t;
        return {
          ...t,
          backup: player.name,
          lineup: (t.lineup || []).filter(n => n !== player.name),
        };
      });
      updateTeams(newTeams);
      dialog.showToast(
        isInLineup
          ? `${lastName} moved from starter to backup`
          : `${lastName} set as backup`,
        'success',
        { position: 'top' }
      );
      return;
    }

    // ── Default mode (starter tap-to-toggle) ────────────────────────────────

    // Case 1: Player IS a starter — remove from lineup.
    if (isInLineup) {
      const newTeams = teams.map(t =>
        t.id !== team.id ? t : { ...t, lineup: t.lineup.filter(p => p !== player.name) }
      );
      updateTeams(newTeams);
      dialog.showToast(`${lastName} removed from lineup`, 'info', { position: 'top' });
      return;
    }

    // Case 2: Player IS the backup — clear backup.
    if (isBackup) {
      const newTeams = teams.map(t =>
        t.id !== team.id ? t : { ...t, backup: null }
      );
      updateTeams(newTeams);
      dialog.showToast(`${lastName} removed as backup`, 'info', { position: 'top' });
      return;
    }

    // Case 3: Adding new player. Starts full + Major + no backup yet → fill
    // backup (implicit overflow path — backup also gets set if user
    // organically fills the 6th tap after 5 starters). Otherwise: add to
    // starters if there's room, error if not.

    // A limited player who has used every start cannot be STARTED again, and
    // the manager is told so rather than left with a tap that does nothing.
    // This tap is the only place the cap needs defending: processing clears
    // team.lineup as it increments starts, so every lineup is built from empty
    // through here (see limitedStartsStatus in api/_rules.js).
    //
    // Checked before the roster-full branch so the reason reported is the one
    // that will still be true after a slot frees up — except when this tap
    // would fill the BACKUP slot, which the cap does not govern (see the note
    // in that branch).
    const wouldFillBackup = activeLineupCount >= LINEUP_SIZE && allowBackup && !team.backup;
    const starts = limitedStatus(player);
    if (starts.outOfStarts && !wouldFillBackup) {
      dialog.showToast(
        `${lastName} is out of starts — ${starts.used} of ${starts.max} used`,
        'error', { position: 'top' }
      );
      return;
    }

    if (activeLineupCount >= LINEUP_SIZE) {
      if (allowBackup && !team.backup) {
        // Limited start limit check ONLY applies when they'd actually start.
        // As a backup they sit on the bench; only counts if commish promotes
        // them, which happens via team.lineup → covered by the starter path.
        // The field warning DOES apply — an out-of-field backup is no cover.
        if (!(await confirmOutOfField(player, 'backup'))) return;
        const newTeams = teams.map(t =>
          t.id !== team.id ? t : { ...t, backup: player.name }
        );
        updateTeams(newTeams);
        dialog.showToast(`${lastName} set as backup`, 'success', { position: 'top' });
        return;
      }
      // No room and either not Major or backup already set → error.
      dialog.showToast(
        allowBackup ? `Lineup + backup full — tap a player to remove first` : `You can only have ${LINEUP_SIZE} starters`,
        'error', { position: 'top' }
      );
      return;
    }

    // Soft-warn when adding a starter who isn't in this week's field. See
    // confirmOutOfField for the field-known gate and why this is a confirm
    // rather than a hard block.
    if (!(await confirmOutOfField(player, 'starter'))) return;

    const newTeams = teams.map(t =>
      t.id !== team.id ? t : { ...t, lineup: [...(t.lineup || []), player.name] }
    );
    updateTeams(newTeams);
    dialog.showToast(`${lastName} added to lineup`, 'success', { position: 'top' });
    // `activeTournament` was listed here but is never read in this callback —
    // it only forced needless re-creation on every tournament-object identity
    // change (and blocked the React compiler from preserving the memo).
  }, [team, teams, updateTeams, dialog, currentRoster, LINEUP_SIZE, limitedStatus, pickingBackup, backupAllowed, confirmOutOfField]);


  const pendingWaivers = useMemo(() => {
    if (!team) return [];
    return transactions
      .map((t, idx) => ({ ...t, _txIdx: idx }))
      .filter(t => txBelongsToTeam(t, team) && t.type === 'waiver' && t.status === 'pending')
      .sort((a, b) => (a.priority || 999) - (b.priority || 999));
  }, [team, transactions]);

  // Derive SFGL cuts per player per team from completed tournament results
  // sfglStatsMap: { playerName: { cuts, starts, earnings } }
  // Source of truth for everything the Stats panel renders. Derived
  // entirely from tournament.results.teams[teamId].players + fullLineups,
  // matching the same pattern that already worked for cuts/starts.
  //
  // Why derive earnings instead of reading player.sfglEarnings off the
  // roster doc: that field is maintained by handleReprocess and the
  // add/drop modal, and can DRIFT from the underlying tournament data
  // when name matching produces a different result on the reversal pass
  // vs the new-processing pass. We've seen this in production — a player
  // showing 1/1 cuts/starts (derived correctly) but $0 sfglEarnings
  // (stored field stuck at 0 because the new-processing add didn't fire).
  // Deriving from tournament.results is self-healing; it always matches
  // what the Tournaments page shows.
  //
  // starts = appeared in lineup, cuts = appeared AND earned > $0,
  // earnings = sum of (base earnings + round-leader bonus) across all
  // tournaments where they started. Mulligan-out players are excluded.
  //
  // NOT the number the start cap is enforced against — that is startsUsed
  // above, which also counts a lineup frozen at lock for an event that has not
  // been scored yet. These read the same for most of the week and differ by
  // one between Thursday's lock and Monday's processing, which is correct for
  // both: this reports what has been SCORED, the cap counts what has been
  // COMMITTED.
  const sfglStatsMap = useMemo(() => {
    const map = {};
    if (!team) return map;

    // Build set of mulliganed-out players per tournament index
    const mulliganedOut = {};
    transactions.forEach(tx => {
      if (tx.type === 'mulligan' && tx.status !== 'failed' && tx.droppedPlayer) {
        // Key by the tournament's CURRENT position, resolved from its stable
        // name, so this aligns with the `tournaments.forEach((t, tIdx) => ...)`
        // consumer below regardless of schedule order. (Was keyed by the fragile
        // stored tx.tournamentIndex — the same misalignment that skewed starts.)
        const pos = resolveTxTournamentIndex(tx, tournaments);
        if (pos == null) return;
        if (!mulliganedOut[pos]) mulliganedOut[pos] = new Set();
        mulliganedOut[pos].add(tx.droppedPlayer);
      }
    });

    tournaments.forEach((t, tIdx) => {
      if (!t.completed || !t.results?.teams?.[team.id]) return;
      const teamResult = t.results.teams[team.id];
      const players = teamResult.players || [];
      const excluded = mulliganedOut[tIdx] || new Set();
      const fullLineup = t.results.fullLineups?.[team.id] || [];

      // Build earnings lookup from players array. Include bonus in totals
      // since the Tournaments page shows earnings as (base + bonus) too.
      const earningsLookup = {};
      players.forEach(p => {
        if (p?.name) earningsLookup[p.name] = (p.earnings || 0) + (p.bonus || 0);
      });

      // Union of players array names and fullLineup names — captures
      // anyone who started even if their entry is missing from the
      // top-5 players array (e.g. lineup of 6 with one $0 earner).
      const allStarted = new Set([
        ...players.map(p => p.name || p),
        ...fullLineup,
      ]);

      allStarted.forEach(name => {
        if (!name || excluded.has(name)) return;
        if (!map[name]) map[name] = { cuts: 0, starts: 0, earnings: 0 };
        map[name].starts += 1;
        const earned = earningsLookup[name] || 0;
        map[name].earnings += earned;
        if (earned > 0) map[name].cuts += 1;
      });
    });
    return map;
  }, [team, tournaments, transactions]);

  // Derive mulligans used by this team from the transaction history.
  // Source of truth = transactions array (matches how every other counter in
  // the app is derived: waiver fees, FA fees, segment earnings, etc.). The
  // legacy `team.mulligans` field on team docs is no longer trusted — manually
  // added mulligan transactions never decremented it, which caused the
  // counter to under-report.
  //
  // Classification: each mulligan tx is Sig/Major or Regular based on the
  // tournament it was applied to. Looks up the tournament by tx.tournamentIndex
  // (the field TransactionsView writes when adding a mulligan).
  const mulligansUsed = useMemo(() => {
    if (!team) return { regular: 0, signatureMajor: 0 };
    let regular = 0, signatureMajor = 0;
    transactions.forEach(tx => {
      if (tx.type !== 'mulligan') return;
      if (!txBelongsToTeam(tx, team)) return;
      if (tx.status === 'failed') return;
      const t = resolveTxTournament(tx, tournaments);
      const isSigOrMajor = !!(t && (t.isSignature || t.isMajor));
      if (isSigOrMajor) signatureMajor += 1; else regular += 1;
    });
    return { regular, signatureMajor };
  }, [team, transactions, tournaments]);

  // Headshot fetching is handled centrally in App.jsx — its useEffect at
  // module load fetches missing ESPN IDs for all rostered players, persists
  // them via playersApi.upsertMany, and pushes the result into the headshots
  // map via updateHeadshots. RostersView no longer maintains its own local
  // copy: it just reads `headshots` directly. (Wave A cleanup.)
  // We use a ref to track the last fetched tournament so re-renders don't re-trigger.
  const _fieldTournamentName = (
    tournaments.find(t => t.playing && !t.completed) ||
    tournaments.find(t => !t.completed)
  )?.name || null;
  const _lastFetchedTournament = React.useRef(null);
  useEffect(() => {
    if (!_fieldTournamentName) return;
    let cancelled = false;

    const fetchField = () => {
      // No cache-buster. /api/field sets `s-maxage=300, stale-while-revalidate=600`
      // so Vercel's CDN can serve the whole league from one origin hit, and the
      // origin is an HTML scrape of pgatour.com — the most expensive request the
      // app makes. Appending `?t=${Date.now()}` made every request a unique URL,
      // which meant that cache never once produced a hit: every manager, on every
      // poll, re-scraped pgatour.com.
      //
      // Nothing is lost by dropping it. This poll runs every 30 minutes, so the
      // CDN's 5-minute freshness window is already six times tighter than the
      // cadence it feeds — the buster was buying staleness we never had.
      fetch('/api/field')
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (cancelled || !data?.players?.length) return;
          _lastFetchedTournament.current = _fieldTournamentName;
          // Names go in as the source spelled them. NameSet/NameMap index every
          // equivalent rendering, so lookups below pass the roster's spelling
          // straight through — no normalizer for a call site to forget.
          setTournamentField(new NameSet(data.players));
          if (data.teeTimes?.length) {
            setTeeTimeMap(new NameMap(data.teeTimes.map(({ name, teeTime }) => [name, teeTime])));
          }
          if (data.odds?.length) {
            setOddsMap(new NameMap(data.odds.map(({ name, odds }) => [name, odds])));
          }
        })
        .catch(() => {});
    };

    // Skip only the IMMEDIATE fetch when this tournament's data is already
    // loaded — never the poll.
    //
    // This guard used to sit above, as an early return before the interval was
    // created, which quietly conflated "we already have this data" with "stop
    // refreshing it". The effect re-runs when the field tournament changes, so
    // the sequence that trips it is A → B → A with B's fetch failing or coming
    // back empty: `_lastFetchedTournament` is still A and teeTimeMap still
    // holds A's tee times, so returning to A takes the early return and no
    // interval is ever installed. Tee times and live field membership then stop
    // updating for the rest of the session, with nothing on screen to say so —
    // the table just keeps showing whatever it last had.
    const alreadyLoaded =
      _lastFetchedTournament.current === _fieldTournamentName && teeTimeMap.size > 0;
    if (!alreadyLoaded) fetchField();
    const interval = setInterval(fetchField, 30 * 60 * 1000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [_fieldTournamentName]); // eslint-disable-line react-hooks/exhaustive-deps

  // Odds are now fetched as part of the field fetch above

  // ── Lineup sync ──────────────────────────────────────────────────────────
  // REMOVED: a 90-second poll that called teamsApi.getAll() and, on any lineup
  // difference, passed the result to updateTeams(). Two problems:
  //
  //   1. Redundant. useLeague attaches a realtime teamsApi.subscribe()
  //      listener (hooks/index.js), so a lineup change on another device
  //      already lands here within a second — the poll was re-fetching data
  //      the snapshot listener had usually delivered already.
  //   2. It turned a read into a read + WRITE. updateTeams persists whatever
  //      it's handed, so every poll that saw a difference wrote the teams it
  //      had just read straight back to Firestore.
  //
  // The subscription is the single sync path now.

  // Fetch live leaderboard from /api/live during tournament week
  // Polls every 5 minutes while the tournament is in progress.
  // IMPORTANT: if the commish is behind on processing, the app's activeTournament
  // may differ from the real-world current event. We compare the tournament name
  // from /api/live against activeTournament.name and discard mismatched data
  // so we never show scores from the wrong event.
  useEffect(() => {
    // Clear stale data from previous tournament immediately. This is a
    // deliberate synchronous reset: the effect key is the tournament name, and
    // showing the PREVIOUS event's scores for even one frame after switching
    // is worse than the extra render pass this costs.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLiveData(null);

    if (!activeTournament) return;

    // Once results are processed, the event is finished for display purposes.
    // pgatour.com keeps serving the completed leaderboard until the NEXT event
    // begins, so without this gate the just-processed event's Score/Pos would
    // linger in the table. Suppress live data the moment processedAt is set so
    // the table falls back to Tee Time + Odds only — the correct state between
    // results processing and the next tournament's start.
    if (activeTournament.processedAt) { setLiveData(null); return; }

    let cancelled = false;
    let interval = null;

    // Fuzzy match: normalize both names and check if one contains the other's
    // significant words. Handles "RBC Heritage" vs "RBC Heritage presented by Boeing" etc.
    const fuzzyMatch = (liveName, appName) => {
      if (!liveName || !appName) return false;
      const norm = s => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
      const a = norm(liveName);
      const b = norm(appName);
      if (a === b) return true;
      if (a.includes(b) || b.includes(a)) return true;
      // Compare significant words (skip short ones like "the", "at", "of")
      const sig = s => s.split(/\s+/).filter(w => w.length > 2);
      const aw = sig(a);
      const bw = sig(b);
      // A single shared GENERIC word ("open", "championship"...) is not
      // enough to call it a match — otherwise "U.S. Open" matches "RBC
      // Canadian Open". Require a shared DISTINCTIVE word, or 2+ shared words.
      const GENERIC = new Set(['the','presented','open','championship','classic','invitational','challenge','tournament','cup','golf','am','proam']);
      const shared = bw.filter(w => aw.includes(w));
      const distinctiveShared = shared.filter(w => !GENERIC.has(w));
      return distinctiveShared.length >= 1 || shared.length >= 2;
    };

    const fetchLive = () => {
      fetch('/api/live')
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (cancelled) return;
          if (!data?.players?.length) { setLiveData(null); return; }
          // Guard: discard live data if it's from a different tournament
          const liveTournament = data.tournamentName || data.eventName || '';
          if (liveTournament && !fuzzyMatch(liveTournament, activeTournament.name)) {
            console.log(`[Rosters] Live data is for "${liveTournament}" but active tournament is "${activeTournament.name}" — skipping`);
            setLiveData(null);
            return;
          }
          setLiveData(data);
        })
        .catch(() => {});
    };

    fetchLive();
    // Poll every 5 min if tournament is in progress
    interval = setInterval(fetchLive, 5 * 60 * 1000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [activeTournament?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  // Leaderboard row lookup, keyed by player identity. Built once per poll
  // rather than re-scanning liveData.players inside every roster row — and,
  // more importantly, built ONCE so the Score column and the Position column
  // cannot resolve the same roster entry to two different leaderboard rows,
  // which the two separate fuzzy cascades they used to run could do.
  const liveByName = React.useMemo(
    () => new NameMap((liveData?.players || []).map(p => [p.name, p])),
    [liveData],
  );

  // Build a name->worldRank lookup from allPlayers for the OWGR stats column.
  // Declared before sortedRoster so the OWGR sort case can read from it.
  const worldRankMap = React.useMemo(() => {
    const map = {};
    (allPlayers || []).forEach(p => { if (p.worldRank) map[p.name] = p.worldRank; });
    return map;
  }, [allPlayers]);

  // Build a full player-directory lookup (name → full player record). The
  // Stats panel's PGAT view reads seasonEarnings/eventsPlayed/cutsMade from
  // here — those fields are synced from pgatour.com via the admin
  // "Sync PGAT Stats" button. Replaces the previous globalPlayerStats
  // path which drifted whenever SFGL processing missed a player.
  const playerDirectoryMap = React.useMemo(() => {
    const map = {};
    (allPlayers || []).forEach(p => { if (p.name) map[p.name] = p; });
    return map;
  }, [allPlayers]);

  const sortedRoster = React.useMemo(() => {
    const baseRoster = rosterView === 'playing'
      ? getSortedRoster(currentRoster).filter(p => tournamentField?.has(p.name))
      : getSortedRoster(currentRoster);
    const roster = baseRoster;
    if (!sortCol) return roster;
    return [...roster].sort((a, b) => {
      let av, bv, aHasData = true, bHasData = true;
      if (sortCol === 'teeTime') {
        const rawA = teeTimeMap.get(a.name); const rawB = teeTimeMap.get(b.name);
        aHasData = !!rawA; bHasData = !!rawB;
        const toMin = t => { if (!t) return 0; const m = t.match(/(\d+):(\d+)\s*(AM|PM)/i); if (!m) return 0; let h = parseInt(m[1]); if (m[3].toUpperCase() === 'PM' && h !== 12) h += 12; if (m[3].toUpperCase() === 'AM' && h === 12) h = 0; return h * 60 + parseInt(m[2]); };
        av = toMin(rawA); bv = toMin(rawB);
      } else if (sortCol === 'odds') {
        const rawA = oddsMap.get(a.name); const rawB = oddsMap.get(b.name);
        aHasData = !!rawA; bHasData = !!rawB;
        const toNum = o => { if (!o) return 0; const n = parseInt(String(o).replace('+',''), 10); return isNaN(n) ? 0 : n; };
        av = toNum(rawA); bv = toNum(rawB);
      } else if (sortCol === 'owgr') {
        // OWGR is a rank — lower is better. Players without a world rank
        // (no rank stored) get pushed to the bottom via the aHasData gate.
        const rA = worldRankMap[a.name]; const rB = worldRankMap[b.name];
        aHasData = !!rA; bHasData = !!rB;
        av = rA || 9999; bv = rB || 9999;
      } else if (sortCol === 'cuts') {
        // Cuts means different things per statsView:
        //   sfgl  → "in our lineup AND earned > $0" (tracked by sfglStatsMap)
        //   pgaTour → real cuts made (synced from pgatour.com, falls back to legacy stat)
        const ga = sfglStatsMap[a.name]?.cuts ?? 0;
        const gb = sfglStatsMap[b.name]?.cuts ?? 0;
        const pa = playerDirectoryMap[a.name]?.cutsMade ?? globalPlayerStats?.[a.name]?.cutsMade ?? 0;
        const pb = playerDirectoryMap[b.name]?.cutsMade ?? globalPlayerStats?.[b.name]?.cutsMade ?? 0;
        av = statsView === 'sfgl' ? ga : pa;
        bv = statsView === 'sfgl' ? gb : pb;
      } else if (sortCol === 'earnings') {
        // Earnings sort tracks the toggle — SFGL → derived from results,
        // PGAT → seasonEarnings from synced player directory (falls back to
        // legacy globalPlayerStats counter when the sync hasn't run yet).
        av = statsView === 'sfgl'
          ? (sfglStatsMap[a.name]?.earnings || 0)
          : (playerDirectoryMap[a.name]?.seasonEarnings ?? globalPlayerStats?.[a.name]?.pgaTourEarnings ?? 0);
        bv = statsView === 'sfgl'
          ? (sfglStatsMap[b.name]?.earnings || 0)
          : (playerDirectoryMap[b.name]?.seasonEarnings ?? globalPlayerStats?.[b.name]?.pgaTourEarnings ?? 0);
      }
      // Always push players without data to the bottom
      if (!aHasData && !bHasData) return 0;
      if (!aHasData) return 1;
      if (!bHasData) return -1;
      if (av === bv) return 0;
      return sortDir === 'asc' ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1);
    });
  }, [currentRoster, sortCol, sortDir, teeTimeMap, oddsMap, sfglStatsMap, rosterView, tournamentField, statsView, globalPlayerStats, worldRankMap, playerDirectoryMap]);

  if (!team) return null;

  const lineupOpen    = windowStatus.lineupOpen;
  const canEditLineup = isCommissioner || (isOwnTeam && lineupOpen);

  // Starters with no starts left. The add-time block cannot catch these,
  // because nobody is adding: a lineup counts against the cap the moment it
  // freezes at lock, and it then SITS there — from Sunday 9pm ET, when lineup
  // editing reopens, until Monday's processing clears it, last week's five are
  // still in team.lineup and one of them may have just spent their last start.
  // A commish who lowers maxLimitedStarts mid-week lands here too.
  //
  // Only players still on the roster are listed. A name left in the lineup by
  // a drop is a different problem with a different fix, and nothing here could
  // tell whether it belongs to a limited player anyway.
  const outOfStartsStarters = (team.lineup || [])
    .map(name => currentRoster.find(p => p.name === name))
    .filter(p => p && limitedStatus(p).outOfStarts);

  const toggleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  };

  const sortHeaderStyle = (col, baseColor) => ({
    cursor: 'pointer', userSelect: 'none',
    color: col === sortCol ? white(0.95) : (baseColor || undefined),
  });
  const sortArrow = (col) => col === sortCol ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';
  const faStatus      = getFreeAgentWindowStatus(activeTournament, resolvedSettings);
  const hasPendingWaivers = transactions.some(tx => tx.status === 'pending' && tx.type === 'waiver');
  const addDropBlocked = faStatus.open && hasPendingWaivers;



  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0, overflowX: 'clip' }}
      onClick={() => { if (lineupMode) { setLineupMode(false); setPickingBackup(false); } }}
    >      {/* ── Team selector + lineup headshots ── */}
      <div style={{
        ...theme.card,
        padding: 12,
        // opaque base (#111d2e page bg) layered under the translucent gradient so
        // the roster table scrolls UNDER this card, not THROUGH it, when sticky
        background: `linear-gradient(135deg, rgba(18,46,82,0.4) 0%, ${white(0.02)} 100%), #111d2e`,
        overflow: 'visible',
        position: 'sticky',
        top: 'var(--sfgl-header-h, 88px)',  // pin flush beneath the sticky app header
        zIndex: 40,                          // below header (50), above scrolling table
        boxShadow: `0 8px 20px ${black(0.35)}`,
      }}>
        {/* Row 1: Team selector + Add/Search button */}
        <div style={{ ...theme.sectionHeaderBar, justifyContent: 'space-between', overflow: 'visible', margin: '-12px -12px 10px', borderTopLeftRadius: 3, borderTopRightRadius: 3 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
            <TeamDropdown
              teams={teams}
              value={selectedTeam || ''}
              onChange={id => { setSelectedTeam(id); setLineupMode(false); setPickingBackup(false); setRosterView('full'); }}
            />
          </div>

          {/* Right cluster: mulligan badges grouped with the Add button so the
              team name has breathing room from the badges. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            {/* Mulligan status — stacked Reg + Sig/Maj indicators.
                Used count is derived from the transaction history (see
                `mulligansUsed` memo above). Each team gets 1 of each per
                season; once used, the icon greys out and the label gets a
                strikethrough. */}
            {team && (() => {
              const regUsed = mulligansUsed.regular >= 1;
              const sigUsed = mulligansUsed.signatureMajor >= 1;
              const activeColor = 'rgba(220,60,60,0.85)';
              const usedColor = white(0.18);
              return (
                <div style={{
                  display: 'flex', flexDirection: 'column', justifyContent: 'center',
                  gap: 3, flexShrink: 0, height: 32,
                }}>
                  {[
                    { label: 'Reg', used: regUsed },
                    { label: 'Sig', used: sigUsed },
                  ].map(({ label, used }) => (
                    <div key={label} style={{
                      display: 'flex', alignItems: 'center', gap: 3,
                      opacity: used ? 0.5 : 1,
                      transition: 'opacity 0.2s',
                    }}>
                      <span style={{
                        fontSize: fontSize.sm, lineHeight: 1,
                        filter: used ? 'grayscale(1)' : 'none',
                      }}>🚨</span>
                      <span style={{
                        fontFamily: fonts.sans, fontSize: fontSize.badge, fontWeight: 700,
                        letterSpacing: '0.3px', textTransform: 'uppercase',
                        color: used ? usedColor : activeColor,
                        textDecoration: used ? 'line-through' : 'none',
                      }}>{label}</span>
                    </div>
                  ))}
                </div>
              );
            })()}

          {/* Search/Add Player button — search always available, add gated by tournament state */}
          {isOwnTeam && (() => {
            // Tournament locked = in-progress (no adds until waiver window opens Tuesday 8pm ET)
            const tournLocked = isTournamentLocked(activeTournament);
            // Waiver window open but pending waivers exist — free agency blocked until processed
            const waiverPending = addDropBlocked;
            // Can add: not locked, not waiver-pending
            const canAdd = !tournLocked && !waiverPending;

            return (
              <button
                onClick={() => {
                  setIsWaiverMode(isWaiverWindowOpen(windowTournament, resolvedSettings));
                  setShowAddDropModal(true);
                }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '7px 14px', borderRadius: 4, flexShrink: 0,
                  fontFamily: fonts.sans, fontSize: fontSize.sm, fontWeight: 700,
                  cursor: 'pointer', transition: 'all 0.15s',
                  background: canAdd ? greenMuted(0.12) : white(0.04),
                  border: canAdd ? `1.5px solid ${greenMuted(0.5)}` : `1.5px solid ${white(0.12)}`,
                  color: canAdd ? greenMuted(0.9) : white(0.4),
                  letterSpacing: '0.2px',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = canAdd ? greenMuted(0.22) : white(0.08); }}
                onMouseLeave={e => { e.currentTarget.style.background = canAdd ? greenMuted(0.12) : white(0.04); }}
                title={tournLocked ? 'Adds unavailable during tournament — opens Tuesday 8pm ET' : waiverPending ? 'Waiver claims pending — free agency opens after Commish processes' : 'Add or drop a player'}
              >
                {canAdd && <span style={{ fontSize: fontSize.md, lineHeight: 1, fontWeight: 800 }}>+</span>}
                <span>{canAdd ? 'Add' : '🔍 Search'}</span>
              </button>
            );
          })()}
          </div>
          </div>

        {/* ── Out-of-starts warning ──
            Deliberately inside the sticky card rather than above it: a warning
            that scrolls away is a warning the manager can miss, and this one
            has a deadline on it (Thursday's lock). Sits directly over the
            lineup it is about. */}
        {outOfStartsStarters.length > 0 && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
            margin: '0 0 10px', padding: '8px 10px', borderRadius: 4,
            background: red(0.16), border: `1px solid ${red(0.55)}`,
          }}>
            <span style={{ fontSize: fontSize.md, lineHeight: 1, flexShrink: 0 }}>⚠</span>
            <div style={{ flex: 1, minWidth: 140 }}>
              <div style={{
                fontFamily: fonts.sans, fontSize: fontSize.xs, fontWeight: 800,
                letterSpacing: '0.6px', textTransform: 'uppercase', color: red(0.95),
              }}>
                Out of starts
              </div>
              <div style={{
                fontFamily: fonts.sans, fontSize: fontSize.sm, color: white(0.9), lineHeight: 1.35,
              }}>
                {outOfStartsStarters.map(p => p.name).join(', ')}
                {outOfStartsStarters.length > 1
                  ? ` have no starts left (max ${maxLimitedStarts(resolvedSettings)}) and are`
                  : ` has used ${limitedStatus(outOfStartsStarters[0]).used} of ${maxLimitedStarts(resolvedSettings)} starts and is`}
                {' '}still in{isOwnTeam ? ' your' : ' this'} lineup.
                {isOwnTeam && ' Swap them out before Thursday\u2019s lock.'}
              </div>
            </div>
            {/* Removing is offered, never done automatically. An auto-remove
                would be a Firestore write triggered by RENDERING a page — it
                would fire for whoever opened the roster first, including a
                commish looking at someone else's team, and would race
                updateTeams. The manager decides; this just makes it one tap. */}
            {canEditLineup && isOwnTeam && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  // One write, not a loop of togglePlayerInLineup calls: each
                  // of those recomputes from the same `teams` closure, so in a
                  // single tick every removal but the last is discarded.
                  const gone = new Set(outOfStartsStarters.map(p => p.name));
                  updateTeams(teams.map(t =>
                    t.id !== team.id ? t : { ...t, lineup: (t.lineup || []).filter(n => !gone.has(n)) }
                  ));
                  dialog.showToast(
                    `${outOfStartsStarters.map(p => p.name.split(' ').pop()).join(', ')} removed from lineup`,
                    'info', { position: 'top' }
                  );
                }}
                style={{
                  flexShrink: 0, padding: '6px 12px', borderRadius: 4, cursor: 'pointer',
                  fontFamily: fonts.sans, fontSize: fontSize.sm, fontWeight: 700,
                  background: red(0.22), border: `1px solid ${red(0.7)}`, color: white(0.95),
                }}
              >
                Remove
              </button>
            )}
          </div>
        )}

        {/* Lineup slots — always show 5: filled headshots + silhouette placeholders.
            When the backup spot is enabled for this event, render a 6th "Backup"
            slot afterward, visually
            subordinate (smaller, dotted border, labeled). */}
        <div style={{ borderTop: `1px solid ${colors.borderSubtle}`, paddingTop: 10, paddingBottom: 6, minHeight: 72 }}>
          <div style={{ display: 'flex', justifyContent: 'center', gap: isMobile ? 10 : 16, flexWrap: 'nowrap', overflow: 'visible' }}>
            {(() => {
              const lineupPlayers = getSortedRoster(currentRoster).filter(p => (team.lineup || []).includes(p.name));
              const emptySlots = Math.max(0, LINEUP_SIZE - lineupPlayers.length);
              const backupPlayer = team.backup
                ? currentRoster.find(p => p.name === team.backup)
                : null;
              const showBackupSlot = backupAllowed;
              return (
                <>
                  {lineupPlayers.map(player => {
                    const lastName = player.name.split(' ').pop();
                    const nameFontSize = lastName.length > 9 ? 9 : lastName.length > 7 ? 10 : 11;
                    return (
                      <LineupHeadshot
                        key={player.name}
                        player={player}
                        lastName={lastName}
                        nameFontSize={nameFontSize}
                        headshots={headshots}
                        canEdit={canEditLineup}
                        onRemove={() => togglePlayerInLineup(player)}
                      />
                    );
                  })}
                  {Array.from({ length: emptySlots }).map((_, i) => (
                    <div
                      key={`empty-${i}`}
                      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 56, cursor: canEditLineup ? 'pointer' : 'default' }}
                      {...activatable((e) => { e.stopPropagation(); setLineupMode(true); }, {
                        disabled: !canEditLineup,
                        label: 'Empty lineup spot — add a player',
                      })}
                    >
                      <div style={{
                        width: 44, height: 44, borderRadius: '50%',
                        background: lineupMode ? greenMuted(0.06) : white(0.04),
                        border: `2px dashed ${canEditLineup ? (lineupMode ? greenMuted(0.6) : greenMuted(0.35)) : white(0.12)}`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        transition: 'all 0.15s',
                      }}>
                        <span style={{
                          fontSize: fontSize.xl, fontWeight: 300, lineHeight: 1,
                          color: canEditLineup ? (lineupMode ? greenMuted(0.8) : greenMuted(0.45)) : white(0.15),
                        }}>+</span>
                      </div>
                      <div style={{
                        fontSize: fontSize.xs, fontFamily: fonts.sans, marginTop: 3,
                        textAlign: 'center', width: '100%',
                        color: canEditLineup ? greenMuted(0.5) : white(0.15),
                        letterSpacing: '0.3px',
                      }}>
                        {canEditLineup ? 'open' : '—'}
                      </div>
                    </div>
                  ))}

                  {/* ── Backup slot (when enabled for this event type) ──
                      Visually subordinate: divider on the left to separate it
                      from starters, smaller circle (38 vs 44), dotted gold
                      border, "Backup" label. Either renders the backup player
                      headshot (with remove on tap) or an empty placeholder. */}
                  {showBackupSlot && (
                    <>
                      <div style={{
                        alignSelf: 'center', width: 1, height: 36,
                        background: white(0.1),
                        margin: isMobile ? '0 2px' : '0 4px',
                      }} />
                      {backupPlayer ? (
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 48 }}>
                          <div
                            {...activatable((e) => { e.stopPropagation(); togglePlayerInLineup(backupPlayer); }, {
                              disabled: !canEditLineup,
                              label: `Remove ${backupPlayer.name} as backup`,
                            })}
                            style={{
                              width: 38, height: 38, borderRadius: '50%',
                              border: `2px dotted ${gold(0.55)}`,
                              padding: 1,
                              overflow: 'hidden',
                              cursor: canEditLineup ? 'pointer' : 'default',
                              position: 'relative',
                            }}
                            title={canEditLineup ? `Remove ${backupPlayer.name} as backup` : backupPlayer.name}
                          >
                            <img
                              src={getPlayerHeadshot(backupPlayer.name, backupPlayer.limited, headshots)}
                              alt={backupPlayer.name}
                              // Use the shared chain handler like every other
                              // avatar — this used to jump straight to the
                              // initials fallback, skipping the PGA Tour
                              // source entirely for the backup slot.
                              onError={makeHeadshotErrorHandler(backupPlayer.name, backupPlayer.limited, headshots)}
                              style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover', display: 'block' }}
                            />
                          </div>
                          <div style={{
                            fontSize: fontSize.xs, fontFamily: fonts.sans, marginTop: 3,
                            color: gold(0.85), letterSpacing: 0.3,
                            textAlign: 'center', width: '100%',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            fontWeight: 600,
                          }}>
                            {backupPlayer.name.split(' ').pop()}
                          </div>
                          <div style={{ fontSize: fontSize.badge, fontFamily: fonts.sans, color: gold(0.5), letterSpacing: 0.5, textTransform: 'uppercase' }}>
                            Backup
                          </div>
                        </div>
                      ) : (
                        <div
                          style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 48, cursor: canEditLineup ? 'pointer' : 'default' }}
                          {...activatable((e) => {
                            e.stopPropagation();
                            // Toggle picking-backup mode. Also ensure lineupMode
                            // is on so the roster table renders tap-to-add
                            // affordances (highlights, etc) and the user can
                            // see where to tap next.
                            setLineupMode(true);
                            setPickingBackup(prev => !prev);
                          }, {
                            disabled: !canEditLineup,
                            selected: pickingBackup,
                            label: 'Empty backup spot — choose a backup',
                          })}
                        >
                          <div style={{
                            width: 38, height: 38, borderRadius: '50%',
                            // When pickingBackup is on, the slot pulses gold to
                            // signal "this is where your next tap lands."
                            background: pickingBackup
                              ? gold(0.18)
                              : lineupMode ? gold(0.06) : white(0.03),
                            border: `2px dotted ${canEditLineup
                              ? (pickingBackup ? gold(0.95) : (lineupMode ? gold(0.6) : gold(0.35)))
                              : white(0.12)}`,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            transition: 'all 0.15s',
                            boxShadow: pickingBackup ? `0 0 0 3px ${gold(0.15)}` : 'none',
                          }}>
                            <span style={{
                              fontSize: fontSize.lg, fontWeight: 300, lineHeight: 1,
                              color: canEditLineup
                                ? (pickingBackup ? gold(1) : (lineupMode ? gold(0.85) : gold(0.45)))
                                : white(0.15),
                            }}>+</span>
                          </div>
                          <div style={{
                            fontSize: fontSize.badge, fontFamily: fonts.sans, marginTop: 3,
                            textAlign: 'center', width: '100%',
                            color: pickingBackup
                              ? gold(1)
                              : canEditLineup ? gold(0.6) : white(0.15),
                            letterSpacing: 0.5, textTransform: 'uppercase', fontWeight: 600,
                          }}>
                            {canEditLineup ? 'Backup' : '—'}
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </>
              );
            })()}
          </div>
        </div>
      </div>

      {/* ── Waiver queue — only visible to the team's own manager ── */}
      {isOwnTeam && (
        <WaiverQueue
          team={team} pendingWaivers={pendingWaivers} transactions={transactions}
          setTransactions={setTransactions} updateTeams={updateTeams} teams={teams}
          isOwnTeam={isOwnTeam} settings={resolvedSettings}
          onEdit={(waiver) => { setEditingWaiverData(waiver); setIsWaiverMode(true); setShowAddDropModal(true); }}
          headshots={headshots}
        />
      )}

      {/* ── Action buttons + roster table ── */}
      <div style={{ ...theme.card }} onClick={() => { if (lineupMode) { setLineupMode(false); setPickingBackup(false); } }}>



        {/* ── Mobile: all 3 toggles above the table in a flex row ── */}
        {isMobile && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 8px 4px', borderBottom: `1px solid ${colors.borderSubtle}` }}>
            <RosterSlider leftVal="full" leftLabel="All" rightVal="playing" rightLabel="⛳"
              current={rosterView} setter={(val) => { setRosterView(val); if (val === 'full') { setSortCol(null); setSortDir('asc'); } }}
              leftColor={blueBright(0.95)} rightColor={greenMuted(0.95)}
              disabled={!tournamentField?.size} width={80} colors={colors} fonts={fonts} />
            <RosterSlider leftVal="info" leftLabel="Info" rightVal="stats" rightLabel="Stats"
              current={infoView} setter={setInfoView}
              leftColor={white(0.95)} rightColor={blueBright(0.9)}
              width={80} colors={colors} fonts={fonts} />
            <RosterSlider leftVal="sfgl" leftLabel="SFGL" rightVal="pgat" rightLabel="PGAT"
              current={statsView} setter={setStatsView}
              leftColor={gold(0.9)} rightColor={greenMuted(0.9)}
              disabled={infoView !== 'stats'} width={80} colors={colors} fonts={fonts} />
          </div>
        )}

        {/* ── Roster table ── */}
        <>
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }} role="table">
            <colgroup>
              <col style={{ width: isMobile ? '49%' : '54%' }} />{/* Player */}
              <col style={{ width: isMobile ? '12%' : '11%' }} />{/* Tee Time / OWGR */}
              <col style={{ width: isMobile ? '19%' : '15%' }} />{/* Odds / Cuts — widened to push Tee Time left, opening a gap before Odds */}
              <col style={{ width: isMobile ? '20%' : '20%' }} />{/* Pos / Earnings */}
            </colgroup>
            <thead>
              {/* Row 1: desktop only — toggles in thead */}
              {!isMobile && (
                <tr>
                  <th style={{ padding: '6px 8px 4px', borderBottom: 'none', textAlign: 'left' }}>
                    <RosterSlider leftVal="full" leftLabel="All" rightVal="playing" rightLabel="⛳"
                      current={rosterView} setter={(val) => { setRosterView(val); if (val === 'full') { setSortCol(null); setSortDir('asc'); } }}
                      leftColor={blueBright(0.95)} rightColor={greenMuted(0.95)}
                      disabled={!tournamentField?.size} width={108} colors={colors} fonts={fonts} />
                  </th>
                  <th colSpan={2} style={{ padding: '6px 0 4px', borderBottom: 'none', textAlign: 'center' }}>
                    <div style={{ display: 'flex', justifyContent: 'center' }}>
                      <RosterSlider leftVal="info" leftLabel="Info" rightVal="stats" rightLabel="Stats"
                        current={infoView} setter={setInfoView}
                        leftColor={white(0.95)} rightColor={blueBright(0.9)}
                        width={108} colors={colors} fonts={fonts} />
                    </div>
                  </th>
                  <th style={{ padding: '6px 8px 4px', borderBottom: 'none', textAlign: 'right' }}>
                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <RosterSlider leftVal="sfgl" leftLabel="SFGL" rightVal="pgat" rightLabel="PGAT"
                        current={statsView} setter={setStatsView}
                        leftColor={gold(0.9)} rightColor={greenMuted(0.9)}
                        disabled={infoView !== 'stats'} width={108} colors={colors} fonts={fonts} />
                    </div>
                  </th>
                </tr>
              )}
              {/* Row 2: column headers */}
              <tr>
                <th scope="col" style={{ ...theme.tableHeaderCell, fontFamily: fonts.sans, fontSize: fontSize.xs, fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase', textAlign: 'left', color: white(0.85), borderTop: `1px solid ${colors.borderSubtle}` }}>Player</th>
                {infoView === 'info' ? (<>
                  <th scope="col" onClick={() => toggleSort('teeTime')} style={{ ...theme.tableHeaderCell, fontFamily: fonts.sans, fontSize: fontSize.xs, fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase', textAlign: isMobile ? 'right' : 'center', whiteSpace: 'nowrap', paddingRight: isMobile ? 4 : 0, ...sortHeaderStyle('teeTime', white(0.85)) }}>
                    {liveData?.players?.length && liveData.players.some(p => p.thru === 'F' || (!isNaN(parseInt(p.thru, 10)) && parseInt(p.thru, 10) >= 0))
                      ? 'Score'
                      : <>Tee Time{sortArrow('teeTime')}</>}
                  </th>
                  <th scope="col" onClick={() => toggleSort('odds')} style={{ ...theme.tableHeaderCell, fontFamily: fonts.sans, fontSize: fontSize.xs, fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase', textAlign: 'right', whiteSpace: 'nowrap', paddingRight: isMobile ? 6 : 8, ...sortHeaderStyle('odds', white(0.85)) }}>
                    Odds{sortArrow('odds')}
                  </th>
                  <th scope="col" style={{ ...theme.tableHeaderCell, fontFamily: fonts.sans, fontSize: fontSize.xs, fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase', textAlign: 'center', color: white(0.85) }}>
                    {(liveData?.state === 'in' || liveData?.state === 'post') ? 'Pos' : ''}
                  </th>
                </>) : (<>
                  <th scope="col" onClick={() => toggleSort('owgr')} style={{ ...theme.tableHeaderCell, fontFamily: fonts.sans, fontSize: fontSize.xs, fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase', textAlign: 'center', whiteSpace: 'nowrap', ...sortHeaderStyle('owgr', blueBright(0.9)) }}>
                    OWGR{sortArrow('owgr')}
                  </th>
                  <th scope="col" onClick={() => toggleSort('cuts')} style={{ ...theme.tableHeaderCell, fontFamily: fonts.sans, fontSize: fontSize.xs, fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase', textAlign: 'center', whiteSpace: 'nowrap', ...sortHeaderStyle('cuts', blueBright(0.9)) }}>
                    {isMobile ? 'Cuts' : 'Cuts / Starts'}{sortArrow('cuts')}
                  </th>
                  <th scope="col" onClick={() => toggleSort('earnings')} style={{ ...theme.tableHeaderCell, fontFamily: fonts.sans, fontSize: fontSize.xs, fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase', textAlign: 'right', paddingRight: isMobile ? 6 : 8, ...sortHeaderStyle('earnings', statsView === 'sfgl' ? gold(0.9) : gold(0.9)) }}>
                    Earnings{sortArrow('earnings')}
                  </th>
                </>)}
              </tr>
            </thead>
            <tbody>
              {sortedRoster.map(player => {
                const isInLineup     = (team.lineup || []).includes(player.name);
                const activeLineupCount = (team.lineup || []).filter(name => currentRoster.some(p => p.name === name)).length;
                const startsStatus   = limitedStatus(player);
                const outOfStarts    = startsStatus.outOfStarts;
                const canAddToLineup = activeLineupCount < LINEUP_SIZE && !outOfStarts;
                const hasLineup      = (team.lineup || []).length > 0;
                const isEditing      = canEditLineup && lineupMode;
                // Only dim benched players once the tournament week has actually
                // begun. Between events the lineup carries over from the prior
                // week and should not dim.
                //
                // This read `!!(firstTeeTime || lineupOpen)`, but firstTeeTime
                // has been undefined in production since Wave C.5 removed
                // fetchFirstTeeTime, so the first operand never contributed.
                // Dropping it changes no behaviour. If tee-time gating is ever
                // wanted here, source it from /api/field (teeTimeMap above)
                // rather than reviving the prop.
                const tournamentActive = !!lineupOpen;
                const isBenched      = tournamentActive && hasLineup && !isInLineup && !isEditing;
                const dimColor       = white(0.45);

                return (
                  <tr key={player.name}
                    style={{ borderBottom: `1px solid ${colors.borderSubtle}`, background: 'transparent', transition: 'background 0.15s, opacity 0.18s', opacity: pickingBackup && isInLineup ? 0.3 : 1 }}
                    onMouseEnter={e => { if (!isBenched) e.currentTarget.style.background = colors.rowHover; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    {/* Player cell */}
                    <td style={{ padding: isMobile ? '7px 10px' : '8px 16px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 6 : 8, minWidth: 0 }}>
                        {/* Headshot / lineup toggle */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (canEditLineup && isOwnTeam) {
                              // When pickingBackup is active, ALWAYS dispatch
                              // to togglePlayerInLineup — its pickingBackup
                              // branch handles routing to the backup slot. We
                              // need to bypass the canAddToLineup gate because
                              // a backup pick is valid even when starters are
                              // full.
                              if (pickingBackup) {
                                togglePlayerInLineup(player);
                                return;
                              }
                              // outOfStarts taps dispatch too. The gate used to
                              // be canAddToLineup alone, so tapping a limited
                              // player who had used every start did nothing
                              // at all — no lineup change and no explanation.
                              // togglePlayerInLineup is where the "out of
                              // starts" notification lives, so the tap has to
                              // reach it.
                              if (!lineupMode) {
                                setLineupMode(true);
                                // If clicking a non-lineup player with room, add them
                                if (!isInLineup && (canAddToLineup || outOfStarts)) togglePlayerInLineup(player);
                              } else if (isInLineup || canAddToLineup || outOfStarts) {
                                togglePlayerInLineup(player);
                              }
                            }
                          }}
                          style={{ position: 'relative', background: 'none', border: 'none', cursor: (canEditLineup && isOwnTeam) ? 'pointer' : 'default', padding: 0, width: 30, height: 30, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                        >
                          <img
                            src={getPlayerHeadshot(player.name, player.limited, headshots)}
                            onError={makeHeadshotErrorHandler(player.name, player.limited, headshots)}
                            alt=""
                            style={{
                              width: 30, height: 30, borderRadius: '50%', objectFit: 'cover',
                              opacity: pickingBackup ? 1 : isBenched ? 0.5 : isEditing && !isInLineup && !canAddToLineup ? 0.25 : isEditing && !isInLineup ? 0.55 : 1,
                              border: isEditing
                                ? isInLineup
                                  ? `3px solid ${playerBorderColor(player)}`
                                  : `2px solid ${colors.borderSubtle}`
                                : isInLineup
                                  ? `2px solid ${playerBorderColor(player)}`
                                  : `1px solid ${colors.borderSubtle}`,
                              transition: 'all 0.15s',
                            }}
                          />
                          {isEditing && isInLineup && (
                            <div style={{
                              position: 'absolute', top: -3, right: -3,
                              width: 14, height: 14, borderRadius: '50%',
                              background: 'rgba(220,60,60,0.9)',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                            }}>
                              <span style={{ color: '#fff', fontSize: fontSize.xs, fontWeight: 900 }}>✕</span>
                            </div>
                          )}
                          {isEditing && !isInLineup && canAddToLineup && (
                            <div style={{
                              position: 'absolute', top: -3, right: -3,
                              width: 14, height: 14, borderRadius: '50%',
                              background: green(0.9),
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                            }}>
                              <span style={{ color: '#fff', fontSize: fontSize.xs, fontWeight: 900, lineHeight: 1 }}>+</span>
                            </div>
                          )}
                          {player.limited && (player.stars || 1) > 0 && (
                            <div style={{
                              position: 'absolute', bottom: -4, left: '50%', transform: 'translateX(-50%)',
                              background: navy(0.88), borderRadius: 6,
                              padding: '0px 3px', lineHeight: 1, zIndex: 5,
                              fontSize: fontSize.badge, letterSpacing: 0.5,
                              pointerEvents: 'none',
                              opacity: isBenched ? 0.35 : 1,
                            }}>
                              {'⭐'.repeat(player.stars || 1)}
                            </div>
                          )}
                        </button>

                        {/* Name + metadata */}
                        <div style={{ minWidth: 0, overflow: 'hidden' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <span style={{
                              fontFamily: fonts.sans, fontSize: isMobile ? 14 : 15, fontWeight: 500,
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                              color: player.limited
                                ? (isBenched ? gold(0.4) : colors.textGold)
                                : player.unlimited
                                  ? (isBenched ? steel(0.4) : steel(0.9))
                                  : (isBenched ? dimColor : colors.textPrimary),
                            }}>
                              {isMobile ? abbreviateName(player.name) : player.name}
                            </span>
                            {tournamentField?.has(player.name) && (
                              <span title="In this week's field" style={{ fontSize: fontSize.sm, lineHeight: 1, flexShrink: 0, opacity: isBenched ? 0.35 : 1 }}>⛳</span>
                            )}
                            {player.limited && (
                              // Starts used / cap. Reads limitedStatus, the same
                              // call the lineup gate makes, so the badge can no
                              // longer say 12/12 while the player is still
                              // addable. Red once spent, because at that point
                              // it is a rule and not a statistic.
                              <span
                                title={outOfStarts ? `Out of starts — ${startsStatus.used} of ${startsStatus.max} used` : `${startsStatus.remaining} of ${startsStatus.max} starts left`}
                                style={{
                                  fontFamily: fonts.sans, fontSize: fontSize.xs, fontWeight: outOfStarts ? 700 : 600,
                                  color: outOfStarts
                                    ? (isBenched ? red(0.45) : red(0.9))
                                    : (isBenched ? gold(0.35) : colors.textGoldDim),
                                }}
                              >
                                {startsStatus.used}/{startsStatus.max}
                              </span>
                            )}
                            {player.unlimited && (
                              <span style={{
                                fontFamily: fonts.sans,
                                fontSize: fontSize.md,
                                fontWeight: 700,
                                lineHeight: 1,
                                color: isBenched ? steel(0.4) : steel(0.9),
                                flexShrink: 0,
                              }} title="Unlimited starts">∞</span>
                            )}
                          </div>
                          <div style={{ fontSize: fontSize.xs, fontFamily: fonts.sans, color: isBenched ? white(0.35) : colors.textMuted }}>
                            {player.yearsOfService > 1 && <span>(Yr {player.yearsOfService})</span>}
                          </div>
                        </div>
                      </div>
                    </td>

                    {/* ── Info columns: Tee Time/Score + Odds + empty Earnings ── */}
                    {infoView === 'info' && (() => {
                      const playerOdds = oddsMap.get(player.name);
                      const inField = tournamentField?.has(player.name);

                      // Col 1: Score (live) → Tee Time → ⛳ in field → —
                      let col1;
                      if (liveData?.players?.length) {
                        // Leaderboard lookup by player identity. This replaces a
                        // four-stage fuzzy cascade — exact, then surname-only,
                        // then SUBSTRING, then initials — whose fallbacks were
                        // each capable of handing a player another golfer's
                        // score:
                        //   • surname-only matched the Coody brothers to each
                        //     other, whichever the leaderboard listed first;
                        //   • substring matched 'Tom Kim' into 'Tom Kimura'.
                        // Both were gated on inField, which bounded the blast
                        // radius to players actually teeing it up but did not
                        // prevent the mix-up. NameMap resolves the abbreviated
                        // 'V. Hovland' rendering those fallbacks were really
                        // there for, and returns nothing when a name is
                        // genuinely ambiguous.
                        //
                        // The inField gate stays: a benched player who is not
                        // in the field must never pick up a leaderboard row.
                        const live = !inField ? null : (liveByName.get(player.name) || null);

                        // Determine display mode from thru field (golfUtils pattern):
                        // "F" or numeric → player has started, show score
                        // tee time string or empty → not started, show tee time
                        const thruNum = live?.thru ? parseInt(live.thru, 10) : NaN;
                        const hasStarted = live && (live.thru === 'F' || (!isNaN(thruNum) && thruNum >= 0) || live.isCut || live.isWD);

                        if (live?.isCut) {
                          col1 = <td style={{ padding: '7px 4px', textAlign: 'center', fontFamily: fonts.sans, fontSize: fontSize.xs, color: colors.textMuted }}>CUT</td>;
                        } else if (live?.isWD) {
                          col1 = <td style={{ padding: '7px 4px', textAlign: 'center', fontFamily: fonts.sans, fontSize: fontSize.xs, color: colors.textMuted }}>WD</td>;
                        } else if (hasStarted) {
                          // Live score coloring: under par (-) is highlighted in
                          // RED; even par ("E") and over par (+) render in muted
                          // light gray. No green is used for live tournament scores.
                          const isUnder = live.score?.startsWith('-');
                          const scoreColor = isUnder ? colors.danger : colors.textMuted;
                          col1 = (
                            <td style={{ padding: '7px 4px', textAlign: 'center', fontFamily: fonts.mono, fontSize: isMobile ? 13 : 15, color: isBenched ? dimColor : scoreColor, fontWeight: 600 }}>
                              {live.score || 'E'}
                            </td>
                          );
                        } else {
                          // Not started — show tee time from live data or teeTimeMap
                          const tt = live?.thru || teeTimeMap.get(player.name);
                          col1 = <td style={{ padding: '7px 4px', textAlign: isMobile ? 'right' : 'center', fontFamily: fonts.mono, fontSize: isMobile ? 12 : 14, color: isBenched ? dimColor : (tt ? colors.textPrimary : colors.textMuted) }}>{tt ? tt.replace(' AM', 'a').replace(' PM', 'p') : <span style={{ opacity: 0.25 }}>—</span>}</td>;
                        }
                      } else {
                        const teeTime = teeTimeMap.get(player.name);
                        col1 = (
                          <td style={{ padding: '7px 4px', textAlign: isMobile ? 'right' : 'center', fontFamily: fonts.mono, fontSize: isMobile ? 12 : 14, color: isBenched ? dimColor : (teeTime ? colors.textPrimary : inField ? colors.textSecondary : 'transparent') }}>
                            {teeTime ? teeTime.replace(' AM', 'a').replace(' PM', 'p') : inField ? 'TBD' : '—'}
                          </td>
                        );
                      }

                      // Col 2: Odds
                      const col2 = (
                        <td style={{ padding: '7px 4px', textAlign: 'right', paddingRight: isMobile ? 6 : 8, fontFamily: fonts.mono, fontSize: isMobile ? 12 : 14, color: isBenched ? dimColor : (playerOdds ? colors.textPrimary : colors.textMuted) }}>
                          {playerOdds || <span style={{ opacity: 0.25 }}>—</span>}
                        </td>
                      );

                      // Col 3: Position + thru indicator (when live data available).
                      // Previously this column rendered an empty <td/>. Now it
                      // surfaces the player's current tournament position (e.g.
                      // "T15") and how far they are through the current round
                      // (e.g. "thru 12" or "F" for finished). When there's no
                      // live data, it stays empty so the layout doesn't shift.
                      let col3 = <td />;
                      // 'post' = event concluded on tour, SFGL results not yet
                      // processed — final positions are still the most useful
                      // thing to show. (Once processed, the processedAt gate
                      // in the /api/live effect suppresses liveData entirely.)
                      if (liveData?.state === 'in' || liveData?.state === 'post') {
                        // Re-find the live entry through the same identity
                        // lookup col1 uses, so Score and Position can never
                        // disagree about which leaderboard row is this player.
                        // (The old code re-implemented a SHORTER fuzzy cascade
                        // here than in col1, so the two columns could resolve
                        // to different golfers for the same row.)
                        const live = !inField ? null : (liveByName.get(player.name) || null);
                        if (live && !live.isCut && !live.isWD) {
                          const thruNum = live.thru ? parseInt(live.thru, 10) : NaN;
                          const isFinished = live.thru === 'F';
                          const isMidRound = !isNaN(thruNum) && thruNum > 0 && thruNum < 18;
                          // Position alone is most useful piece. Thru indicator
                          // shows under it as small secondary text.
                          const pos = live.position || '';
                          col3 = (
                            <td style={{ padding: '7px 4px', textAlign: 'center', fontFamily: fonts.mono, fontSize: isMobile ? 11 : 13, color: isBenched ? dimColor : colors.textPrimary, lineHeight: 1.2 }}>
                              <div>{pos || <span style={{ opacity: 0.25 }}>—</span>}</div>
                              {(isFinished || isMidRound) && (
                                <div style={{ fontSize: fontSize.xs, color: isBenched ? dimColor : colors.textMuted, marginTop: 1 }}>
                                  {isFinished ? 'F' : `thru ${live.thru}`}
                                </div>
                              )}
                            </td>
                          );
                        }
                      }

                      return <>{col1}{col2}{col3}</>;
                    })()}

                    {/* ── Stats columns: OWGR + Cuts + Earnings ── */}
                    {infoView === 'stats' && (() => {
                      const owgr = worldRankMap[player.name] || null;
                      const sfglEntry = sfglStatsMap[player.name] || { cuts: 0, starts: 0, earnings: 0 };
                      // PGAT view: read from the player directory which is
                      // populated by the admin "Sync PGAT Stats" sync. These
                      // fields come from pgatour.com — real season earnings,
                      // real events-played, real cuts-made. Fall back to
                      // globalPlayerStats (the legacy incremental counter)
                      // when the sync hasn't run yet so old data shows
                      // something rather than $0 across the board.
                      const dir = playerDirectoryMap[player.name] || {};
                      const legacyPga = globalPlayerStats?.[player.name] || {};
                      const pgaEarnings = dir.seasonEarnings ?? legacyPga.pgaTourEarnings ?? 0;
                      const pgaCuts     = dir.cutsMade       ?? legacyPga.cutsMade       ?? 0;
                      const pgaEvents   = dir.eventsPlayed   ?? legacyPga.eventsPlayed   ?? 0;

                      // Cuts column: dual-meaning per statsView
                      //   sfgl  → "started in our lineup AND earned >$0" (cuts/starts ratio)
                      //   pgaTour → cuts made / events played (real PGA data)
                      let cutsDisplay;
                      if (statsView === 'sfgl') {
                        cutsDisplay = `${sfglEntry.cuts}/${sfglEntry.starts}`;
                      } else {
                        cutsDisplay = pgaEvents > 0 ? `${pgaCuts}/${pgaEvents}` : String(pgaCuts);
                      }

                      // Earnings column — SFGL from the derived sfglStatsMap
                      // (matches Tournaments page). PGA $ from the synced
                      // player directory (matches pgatour.com). Both use the
                      // same green so the visual weight is identical across
                      // the toggle.
                      const amount = statsView === 'sfgl'
                        ? (sfglEntry.earnings || 0)
                        : pgaEarnings;
                      const posColor = colors.earningsGreen;
                      return (
                        <>
                          <td style={{ padding: isMobile ? '7px 6px' : '8px 16px', textAlign: 'center', fontFamily: fonts.mono, fontSize: isMobile ? 12 : 14, color: isBenched ? dimColor : colors.textPrimary }}>{owgr ? `#${owgr}` : '—'}</td>
                          <td style={{ padding: isMobile ? '7px 4px' : '8px 16px', textAlign: 'center', fontFamily: fonts.sans, fontSize: isMobile ? 12 : 14, color: isBenched ? dimColor : colors.textPrimary }}>{cutsDisplay}</td>
                          <td style={{ padding: isMobile ? '7px 8px 7px 4px' : '8px 16px', textAlign: 'right', ...theme.statNum, fontSize: isMobile ? 13 : 15, fontWeight: 600, color: isBenched ? dimColor : (amount > 0 ? posColor : colors.textMuted) }}>${amount.toLocaleString()}</td>
                        </>
                      );
                    })()}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      </div>

      {/* ── Modals ── */}
      <AddDropPlayerModal
        isOpen={showAddDropModal}
        onClose={() => { setShowAddDropModal(false); setEditingWaiverData(null); }}
        team={team}
        currentRoster={currentRoster}
        teams={teams}
        updateTeams={updateTeams}
        transactions={transactions}
        setTransactions={setTransactions}
        tournaments={tournaments}
        isWaiverMode={isWaiverMode}
        activeTournamentIndex={activeTournamentIndex}
        nextTournamentIndex={addDropTournamentIndex}
        txSegment={tournaments[addDropTournamentIndex]?.segment || getSegmentByDate()}
        editingWaiverData={editingWaiverData}
        headshots={headshots}
        tournamentField={tournamentField}
        allPlayers={allPlayers}
        leagueSettings={resolvedSettings}
        onHeadshotsFound={found => updateHeadshots && updateHeadshots(prev => {
          const next = { ...(prev || {}) };
          Object.entries(found || {}).forEach(([name, entry]) => {
            next[name] = mergeHeadshotEntry(next[name], entry);
          });
          return next;
        })}
      />
    </div>
  );
};
