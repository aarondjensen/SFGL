import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { useDialog } from './DialogContext';
import { AddDropPlayerModal } from './AddDropPlayerModal';
import { TeamName } from '../components/TeamName';

import { useRoster, useWindowStatus } from '../hooks';
import {
  getSortedRoster,
  getFreeAgentWindowStatus,
  getSegmentByDate, isTournamentLocked,
  isWaiverWindowOpen,
  getCurrentTournamentIndex,
} from '../utils';
// MAX_LIMITED_STARTS and LINEUP_SIZE now come from leagueSettings prop
import { theme, colors, fonts, fontSize } from '../theme.js';
import { teamsApi } from '../api/firebase';
import { STORAGE_KEYS } from '../constants';
import { isBackupSpotEnabled } from '../utils/sharedHelpers';

// ── Headshot helpers (shared — single source of truth in headshotUtils.js) ──
// Thin wrappers preserve the (name, isLimited, headshotMap) call signature
// used throughout this file — headshotUtils uses (name, headshotMap, isLimited).
import {
  getPlayerHeadshot as _getPlayerHeadshot,
  makeHeadshotErrorHandler as _makeHeadshotErrorHandler,
  getPlayerHeadshotFallback,
} from '../utils/headshotUtils';

const getPlayerHeadshot = (playerName, isLimited = false, headshotMap = {}) =>
  _getPlayerHeadshot(playerName, headshotMap, isLimited);

const makeHeadshotErrorHandler = (playerName, isLimited, headshotMap) =>
  _makeHeadshotErrorHandler(playerName, headshotMap, isLimited);

// ── Nordic name normalization (single definition, used throughout) ────────────
// Normalizes Nordic and other diacritics, plus hyphens and whitespace, so
// roster names match field/leaderboard names regardless of source format.
//   • Diacritics: NFD decompose + strip combining marks (Höjgaard → Hojgaard)
//   • Nordic special letters: ø/Ø → o/O, æ/Æ → ae/Ae, ß → ss
//   • Hyphens to spaces ("Si-Woo Kim" → "Si Woo Kim") — PGA Tour renders
//     Korean names hyphenated; rosters often use spaces (especially after
//     a merge canonicalised to the spaced form). Without this, the playing
//     badge and tee-time lookup silently miss those players.
//   • Collapse whitespace so the hyphen->space replacement doesn't leave
//     double spaces.
const normalizeNordic = (s) => (s || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/ø/g, 'o').replace(/Ø/g, 'O')
  .replace(/æ/g, 'ae').replace(/Æ/g, 'Ae')
  .replace(/ß/g, 'ss')
  .replace(/-/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// ── Border color by player type ───────────────────────────────────────────────
const playerBorderColor = (player) =>
  player.limited   ? 'rgba(245,197,24,0.9)' :
  player.unlimited ? 'rgba(100,140,220,0.9)' :
  'rgba(255,255,255,0.85)';

// ── Mobile display name helper ───────────────────────────────────────────────
const useIsMobile = () => {
  const [isMobile, setIsMobile] = React.useState(() => window.innerWidth < 640);
  React.useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 640);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);
  return isMobile;
};

const displayName = (fullName, isMobile) => {
  if (!isMobile || !fullName) return fullName;
  const parts = fullName.trim().split(' ');
  if (parts.length < 2) return fullName;
  return parts[0][0] + '. ' + parts[parts.length - 1];
};

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
        <span style={{ fontSize: 11, color: colors.textSecondary, opacity: 0.9, flexShrink: 0 }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, zIndex: 100, marginTop: 2,
          minWidth: '100%', width: 'max-content',
          maxHeight: '60vh', overflowY: 'auto',
          background: '#0f1d35', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 2,
          boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
        }} className="sfgl-modal-scroll">
          {teams.map(t => (
            <button key={t.id} onClick={() => { onChange(t.id); setOpen(false); }}
              style={{
                display: 'block', width: '100%', padding: '11px 14px', textAlign: 'left', cursor: 'pointer',
                whiteSpace: 'nowrap',
                background: t.id === value ? 'rgba(245,197,24,0.12)' : 'transparent',
                border: 'none', borderBottom: '1px solid rgba(255,255,255,0.06)',
                fontFamily: fonts.serif, fontSize: fontSize.base, fontWeight: t.id === value ? 700 : 400,
                color: t.id === value ? colors.textGold : 'rgba(255,255,255,0.85)',
                transition: 'background 0.1s',
              }}
              onMouseEnter={e => { if (t.id !== value) e.currentTarget.style.background = 'rgba(255,255,255,0.07)'; }}
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
    <div style={{ display: 'flex', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, padding: 2, width }}>
      <button onClick={() => setter(leftVal)} style={{
        flex: 1, padding: '6px 0', borderRadius: 2,
        background: current === leftVal ? 'rgba(255,255,255,0.08)' : 'none',
        border: current === leftVal ? '1px solid rgba(255,255,255,0.18)' : '1px solid transparent',
        fontFamily: fonts.sans, fontSize: fontSize.xs, fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase',
        color: current === leftVal ? leftColor : colors.textMuted,
        cursor: 'pointer', transition: 'color 0.15s, background 0.15s',
      }}>{leftLabel}</button>
      <button onClick={() => setter(rightVal)} style={{
        flex: 1, padding: '6px 0', borderRadius: 2,
        background: current === rightVal ? 'rgba(255,255,255,0.08)' : 'none',
        border: current === rightVal ? '1px solid rgba(255,255,255,0.18)' : '1px solid transparent',
        fontFamily: fonts.sans, fontSize: fontSize.xs, fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase',
        color: current === rightVal ? rightColor : colors.textMuted,
        cursor: 'pointer', transition: 'color 0.15s, background 0.15s',
      }}>{rightLabel}</button>
    </div>
  </div>
);

const WaiverQueue = ({ team, pendingWaivers, transactions, setTransactions, updateTeams, teams, isOwnTeam, settings }) => {
  const dialog = useDialog();
  const txRef = React.useRef(transactions);
  txRef.current = transactions; // always up to date

  const persistTransactions = (newTx) => {
    setTransactions(newTx);
  };

  const deleteWaiver = (waiver) => {
    const current = txRef.current;
    // Match by fields to find the right transaction regardless of index shifts
    let removed = false;
    const newTx = current.filter(tx => {
      if (!removed && tx.team === team.name && tx.player === waiver.player && tx.droppedPlayer === waiver.droppedPlayer && tx.status === 'pending' && tx.type === 'waiver') {
        removed = true;
        return false;
      }
      return true;
    });
    if (!removed) return; // nothing matched
    const newTeams = teams.map(t => t.id === team.id ? { ...t, transactionFees: (t.transactionFees || 0) - (waiver.fee || 0) } : t);
    persistTransactions(newTx);
    updateTeams(newTeams);
  };

  const swapPriority = (fromIdx, toIdx) => {
    if (toIdx < 0 || toIdx >= pendingWaivers.length) return;
    const updated   = [...txRef.current];
    const fromTxIdx = pendingWaivers[fromIdx]._txIdx;
    const toTxIdx   = pendingWaivers[toIdx]._txIdx;
    const fromPri   = pendingWaivers[fromIdx].priority || fromIdx + 1;
    const toPri     = pendingWaivers[toIdx].priority   || toIdx + 1;
    updated[fromTxIdx] = { ...updated[fromTxIdx], priority: toPri };
    updated[toTxIdx]   = { ...updated[toTxIdx],   priority: fromPri };
    persistTransactions(updated);
  };

  if (pendingWaivers.length === 0) return null;

  // Build dynamic waiver cutoff label from settings
  const wDay  = settings?.waiverDay    ?? 2;
  const wHour = settings?.waiverHour   ?? 20;
  const wMin  = settings?.waiverMinute ?? 0;
  const dayAbbrs = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const hr12 = wHour % 12 || 12;
  const ampm = wHour < 12 ? 'am' : 'pm';
  const minStr = wMin > 0 ? `:${String(wMin).padStart(2, '0')}` : '';
  const cutoffLabel = `${dayAbbrs[wDay]} ${hr12}${minStr}${ampm}`;

  const waiverStatusLabel = (() => {
    const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const d = et.getDay();
    const t = et.getHours() * 60 + et.getMinutes();
    const cutoffMinutes = wHour * 60 + wMin;
    if (d < wDay || (d === wDay && t < cutoffMinutes)) return `Waiver window closes ${cutoffLabel} ET`;
    return 'Pending commish processing';
  })();

  return (
    <div style={{
      background: 'rgba(180,160,60,0.08)',
      border: '1px solid rgba(180,160,60,0.3)',
      borderRadius: 3, padding: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <h3 style={{ ...theme.label, color: 'rgba(220,200,80,0.9)', fontSize: fontSize.sm }}>
          ⏰ Pending Waiver Claims ({pendingWaivers.length})
        </h3>
        <span style={{ ...theme.smallText, color: 'rgba(220,200,80,0.6)' }}>{waiverStatusLabel}</span>
      </div>
      {pendingWaivers.length > 1 && isOwnTeam && (
        <p style={{ ...theme.smallText, marginBottom: 8 }}>↕ Use arrows to set priority — #1 processes first</p>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {pendingWaivers.map((waiver, index) => (
          <div key={waiver._txIdx} style={{
            background: 'rgba(255,255,255,0.04)',
            borderRadius: 2, padding: '8px 10px',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            {isOwnTeam && pendingWaivers.length > 1 && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0 }}>
                <button onClick={() => swapPriority(index, index - 1)} disabled={index === 0}
                  style={{ background: 'none', border: 'none', cursor: index === 0 ? 'not-allowed' : 'pointer',
                    color: index === 0 ? colors.textMuted : 'rgba(220,200,80,0.8)', fontSize: fontSize.md, padding: '6px 10px', lineHeight: 1 }}>▲</button>
                <span style={{ fontSize: fontSize.xs, color: 'rgba(220,200,80,0.8)', fontWeight: 700 }}>{index + 1}</span>
                <button onClick={() => swapPriority(index, index + 1)} disabled={index === pendingWaivers.length - 1}
                  style={{ background: 'none', border: 'none', cursor: index === pendingWaivers.length - 1 ? 'not-allowed' : 'pointer',
                    color: index === pendingWaivers.length - 1 ? colors.textMuted : 'rgba(220,200,80,0.8)', fontSize: fontSize.md, padding: '6px 10px', lineHeight: 1 }}>▼</button>
              </div>
            )}
            <div style={{ flex: 1 }}>
              <span style={{ color: colors.success, fontFamily: fonts.sans, fontSize: fontSize.sm, fontWeight: 500 }}>Add: {waiver.player}</span>
              {waiver.droppedPlayer && (
                <>
                  <span style={{ color: colors.textMuted, margin: '0 4px' }}>→</span>
                  <span style={{ color: colors.danger, fontFamily: fonts.sans, fontSize: fontSize.sm }}>Drop: {waiver.droppedPlayer}</span>
                </>
              )}
              <div style={{ ...theme.smallText, marginTop: 2 }}>${waiver.fee} fee · {waiver.segment || 'Current Swing'}</div>
            </div>
            {isOwnTeam && (
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => deleteWaiver(waiver)}
                  title="Withdraw this waiver claim"
                  aria-label="Withdraw this waiver claim"
                  style={{ ...theme.btnSecondary, padding: '8px 12px', fontSize: fontSize.sm, minHeight: 36 }}>✏️</button>
                <button onClick={async () => {
                  const ok = await dialog.showConfirm('Delete Waiver', `Delete waiver claim for ${waiver.player}?`, { type: 'danger', confirmText: 'Delete' });
                  if (!ok) return;
                  deleteWaiver(waiver);
                }}
                title="Delete waiver claim (with confirmation)"
                aria-label="Delete waiver claim"
                style={{ ...theme.btnDanger, padding: '8px 12px', fontSize: fontSize.sm, minHeight: 36 }}>✕</button>
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
const LineupHeadshot = ({ player, lastName, nameFontSize, headshots, fieldPlayerIds = {}, canEdit, onRemove }) => {
  const [hovered, setHovered] = React.useState(false);
  const [tapped, setTapped]   = React.useState(false);
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
  const showRemove = canEdit && (hovered || tapped);

  return (
    <div
      ref={containerRef}
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 56, overflow: 'visible' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setTapped(false); }}
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
              border: '1.5px solid rgba(255,255,255,0.25)',
              color: '#fff',
              fontSize: fontSize.sm, fontWeight: 700, lineHeight: 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer',
              boxShadow: '0 2px 6px rgba(0,0,0,0.5)',
              padding: 0,
              zIndex: 10,
              transition: 'transform 0.1s',
            }}
            onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.15)'; }}
            onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; }}
            title={'Remove ' + player.name + ' from lineup'}
          >
            {'\u00D7'}
          </button>
        )}
        {player.limited && (player.stars || 1) > 0 && (
          <div style={{
            position: 'absolute', bottom: -4, left: '50%', transform: 'translateX(-50%)',
            background: 'rgba(15,25,45,0.88)', borderRadius: 6,
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
        color: player.limited ? colors.textGold : player.unlimited ? 'rgba(100,140,220,0.9)' : colors.textPrimary,
      }}>
        {lastName}
      </div>
    </div>
  );
};

export const RostersView = ({
  teams, selectedTeam, setSelectedTeam, updateTeams,
  tournaments, allPlayers, transactions, setTransactions,
  loggedInUser, isCommissioner, globalPlayerStats, headshots,
  updateHeadshots,
  leagueSettings = {}, settings, firstTeeTime,
}) => {
  // leagueSettings may come from either prop name (App passes settings=)
  const resolvedSettings = settings || leagueSettings;
  // Destructure with fallbacks to constants for safety
  const LINEUP_SIZE       = resolvedSettings.lineupSize       ?? 5;
  const MAX_LIMITED_STARTS = resolvedSettings.maxLimitedStarts ?? 12;
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
  const [isWaiverMode,      setIsWaiverMode]      = useState(false);
  const [editingWaiverData, setEditingWaiverData] = useState(null);
  const [pendingAddPlayer,  setPendingAddPlayer]  = useState(null);
  const [tournamentField,   setTournamentField]   = useState(null);
  const [teeTimeMap,        setTeeTimeMap]        = useState({}); // { playerName: '8:04 AM' }
  const [fieldPlayerIds,    setFieldPlayerIds]    = useState({}); // { playerName: espnId }
  const [oddsMap,           setOddsMap]           = useState({}); // { playerName: '+2000' }
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

  // Switch to the logged-in manager's team whenever loggedInUser changes (e.g. after login)
  const prevLoggedInUser = React.useRef(null);
  useEffect(() => {
    if (teams.length === 0) return;
    const userTeam = loggedInUser ? teams.find(t => t.owner === loggedInUser) : null;
    if (loggedInUser && loggedInUser !== prevLoggedInUser.current && userTeam) {
      // User just logged in — jump to their team
      setSelectedTeam(userTeam.id);
    } else if (!selectedTeam) {
      // No selection yet — default to user's team or first team
      setSelectedTeam(userTeam?.id ?? teams[0].id);
    }
    prevLoggedInUser.current = loggedInUser;
  }, [selectedTeam, teams, loggedInUser, setSelectedTeam]);

  const team          = teams.find(t => t.id === selectedTeam);
  const currentRoster = useRoster(team, transactions, activeTournamentIndex) || [];
  const windowStatus  = useWindowStatus(activeTournament, resolvedSettings);
  const isOwnTeam     = (loggedInUser && team?.owner === loggedInUser) || isCommissioner;

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
    if (activeLineupCount >= LINEUP_SIZE) {
      if (allowBackup && !team.backup) {
        // Limited start limit check ONLY applies when they'd actually start.
        // As a backup they sit on the bench; only counts if commish promotes
        // them, which happens via team.lineup → covered by the starter path.
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

    // Adding to starters — Limited start limit check applies here.
    if (player.limited && player.starts >= MAX_LIMITED_STARTS) {
      dialog.showToast('This player has reached their 12-start limit', 'error', { position: 'top' });
      return;
    }

    const newTeams = teams.map(t =>
      t.id !== team.id ? t : { ...t, lineup: [...(t.lineup || []), player.name] }
    );
    updateTeams(newTeams);
    dialog.showToast(`${lastName} added to lineup`, 'success', { position: 'top' });
  }, [team, teams, updateTeams, dialog, activeTournament, currentRoster, LINEUP_SIZE, pickingBackup, backupAllowed]);


  const pendingWaivers = useMemo(() => {
    if (!team) return [];
    return transactions
      .map((t, idx) => ({ ...t, _txIdx: idx }))
      .filter(t => t.team === team.name && t.type === 'waiver' && t.status === 'pending')
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
  const sfglStatsMap = useMemo(() => {
    const map = {};
    if (!team) return map;

    // Build set of mulliganed-out players per tournament index
    const mulliganedOut = {};
    transactions.forEach(tx => {
      if (tx.type === 'mulligan' && tx.status !== 'failed' && tx.droppedPlayer && tx.tournamentIndex != null) {
        if (!mulliganedOut[tx.tournamentIndex]) mulliganedOut[tx.tournamentIndex] = new Set();
        mulliganedOut[tx.tournamentIndex].add(tx.droppedPlayer);
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

  // Backwards-compat alias — older code references sfglCutsMap directly.
  // Same object shape (cuts/starts), just doesn't expose earnings to
  // existing callers. Anything new should reach for sfglStatsMap.
  const sfglCutsMap = sfglStatsMap;

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
      if (tx.team !== team.name) return;
      if (tx.status === 'failed') return;
      const t = tx.tournamentIndex != null ? tournaments[tx.tournamentIndex] : null;
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
    // Don't re-run if we already have tee times for this tournament
    if (_lastFetchedTournament.current === _fieldTournamentName && Object.keys(teeTimeMap).length > 0) return;
    let cancelled = false;
    const normalize = normalizeNordic;

    const fetchField = () => {
      fetch('/api/field?t=' + Date.now())
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (cancelled || !data?.players?.length) return;
          _lastFetchedTournament.current = _fieldTournamentName;
          setTournamentField(new Set(data.players.map(normalize)));
          if (data.teeTimes?.length) {
            const ttMap = {};
            data.teeTimes.forEach(({ name, teeTime }) => { ttMap[normalize(name)] = teeTime; });
            setTeeTimeMap(ttMap);
          }
          if (data.playerIds && Object.keys(data.playerIds).length) {
            setFieldPlayerIds(data.playerIds);
          }
          if (data.odds?.length) {
            const oMap = {};
            data.odds.forEach(({ name, odds }) => { oMap[normalize(name)] = odds; });
            setOddsMap(oMap);
          }
        })
        .catch(() => {});
    };

    fetchField();
    const interval = setInterval(fetchField, 30 * 60 * 1000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [_fieldTournamentName]); // eslint-disable-line react-hooks/exhaustive-deps

  // Odds are now fetched as part of the field fetch above

  // Real-time lineup sync — polls Firebase every 30s so changes on desktop
  // appear on mobile without a manual refresh
  useEffect(() => {
    if (!team) return;
    let cancelled = false;
    const poll = () => {
      teamsApi.getAll().then(freshTeams => {
        if (cancelled) return;
        const fresh = freshTeams.find(t => t.id === team.id);
        const freshLineup = fresh?.lineup || [];
        const currentLineup = team.lineup || [];
        if (fresh && JSON.stringify(freshLineup) !== JSON.stringify(currentLineup)) {
          updateTeams(freshTeams.map(t => ({ ...t, lineup: t.lineup || [] })));
        }
      }).catch(() => {});
    };
    const interval = setInterval(poll, 90000); // every 90s (was 30s — reduces Firebase reads)
    return () => { cancelled = true; clearInterval(interval); };
  }, [team?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch live leaderboard from /api/live during tournament week
  // Polls every 5 minutes while the tournament is in progress.
  // IMPORTANT: if the commish is behind on processing, the app's activeTournament
  // may differ from the real-world current event. We compare the tournament name
  // from /api/live against activeTournament.name and discard mismatched data
  // so we never show scores from the wrong event.
  useEffect(() => {
    // Clear stale data from previous tournament immediately
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
      ? getSortedRoster(currentRoster).filter(p => tournamentField?.has(
          normalizeNordic(p.name)
        ))
      : getSortedRoster(currentRoster);
    const roster = baseRoster;
    if (!sortCol) return roster;
    const normalize = normalizeNordic;
    return [...roster].sort((a, b) => {
      let av, bv, aHasData = true, bHasData = true;
      if (sortCol === 'teeTime') {
        const rawA = teeTimeMap[normalize(a.name)]; const rawB = teeTimeMap[normalize(b.name)];
        aHasData = !!rawA; bHasData = !!rawB;
        const toMin = t => { if (!t) return 0; const m = t.match(/(\d+):(\d+)\s*(AM|PM)/i); if (!m) return 0; let h = parseInt(m[1]); if (m[3].toUpperCase() === 'PM' && h !== 12) h += 12; if (m[3].toUpperCase() === 'AM' && h === 12) h = 0; return h * 60 + parseInt(m[2]); };
        av = toMin(rawA); bv = toMin(rawB);
      } else if (sortCol === 'odds') {
        const rawA = oddsMap[normalize(a.name)]; const rawB = oddsMap[normalize(b.name)];
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
  }, [currentRoster, sortCol, sortDir, teeTimeMap, oddsMap, sfglStatsMap, rosterView, tournamentField, statsView, globalPlayerStats, worldRankMap, playerDirectoryMap]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!team) return null;

  const lineupOpen    = windowStatus.lineupOpen;
  const canEditLineup = isCommissioner || (isOwnTeam && lineupOpen);

  const toggleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  };

  const sortHeaderStyle = (col, baseColor) => ({
    cursor: 'pointer', userSelect: 'none',
    color: col === sortCol ? 'rgba(255,255,255,0.95)' : (baseColor || undefined),
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
        background: 'linear-gradient(135deg, rgba(18,46,82,0.4) 0%, rgba(255,255,255,0.02) 100%), #111d2e',
        overflow: 'visible',
        position: 'sticky',
        top: 'var(--sfgl-header-h, 88px)',  // pin flush beneath the sticky app header
        zIndex: 40,                          // below header (50), above scrolling table
        boxShadow: '0 8px 20px rgba(0,0,0,0.35)',
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
              const usedColor = 'rgba(255,255,255,0.18)';
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
                  background: canAdd ? 'rgba(80,180,120,0.12)' : 'rgba(255,255,255,0.04)',
                  border: canAdd ? '1.5px solid rgba(80,180,120,0.5)' : '1.5px solid rgba(255,255,255,0.12)',
                  color: canAdd ? 'rgba(80,180,120,0.9)' : 'rgba(255,255,255,0.4)',
                  letterSpacing: '0.2px',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = canAdd ? 'rgba(80,180,120,0.22)' : 'rgba(255,255,255,0.08)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = canAdd ? 'rgba(80,180,120,0.12)' : 'rgba(255,255,255,0.04)'; }}
                title={tournLocked ? 'Adds unavailable during tournament — opens Tuesday 8pm ET' : waiverPending ? 'Waiver claims pending — free agency opens after Commish processes' : 'Add or drop a player'}
              >
                {canAdd && <span style={{ fontSize: fontSize.md, lineHeight: 1, fontWeight: 800 }}>+</span>}
                <span>{canAdd ? 'Add' : '🔍 Search'}</span>
              </button>
            );
          })()}
          </div>
          </div>

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
                        fieldPlayerIds={fieldPlayerIds}
                        canEdit={canEditLineup}
                        onRemove={() => togglePlayerInLineup(player)}
                      />
                    );
                  })}
                  {Array.from({ length: emptySlots }).map((_, i) => (
                    <div
                      key={`empty-${i}`}
                      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 56, cursor: canEditLineup ? 'pointer' : 'default' }}
                      onClick={(e) => { e.stopPropagation(); if (canEditLineup) setLineupMode(true); }}
                    >
                      <div style={{
                        width: 44, height: 44, borderRadius: '50%',
                        background: lineupMode ? 'rgba(80,180,120,0.06)' : 'rgba(255,255,255,0.04)',
                        border: `2px dashed ${canEditLineup ? (lineupMode ? 'rgba(80,180,120,0.6)' : 'rgba(80,180,120,0.35)') : 'rgba(255,255,255,0.12)'}`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        transition: 'all 0.15s',
                      }}>
                        <span style={{
                          fontSize: fontSize.xl, fontWeight: 300, lineHeight: 1,
                          color: canEditLineup ? (lineupMode ? 'rgba(80,180,120,0.8)' : 'rgba(80,180,120,0.45)') : 'rgba(255,255,255,0.15)',
                        }}>+</span>
                      </div>
                      <div style={{
                        fontSize: fontSize.xs, fontFamily: fonts.sans, marginTop: 3,
                        textAlign: 'center', width: '100%',
                        color: canEditLineup ? 'rgba(80,180,120,0.5)' : 'rgba(255,255,255,0.15)',
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
                        background: 'rgba(255,255,255,0.1)',
                        margin: isMobile ? '0 2px' : '0 4px',
                      }} />
                      {backupPlayer ? (
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 48 }}>
                          <div
                            onClick={(e) => {
                              e.stopPropagation();
                              if (canEditLineup) togglePlayerInLineup(backupPlayer);
                            }}
                            style={{
                              width: 38, height: 38, borderRadius: '50%',
                              border: `2px dotted rgba(245,197,24,0.55)`,
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
                              onError={(e) => { e.currentTarget.src = getPlayerHeadshotFallback(backupPlayer.name, backupPlayer.limited); }}
                              style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover', display: 'block' }}
                            />
                          </div>
                          <div style={{
                            fontSize: fontSize.xs, fontFamily: fonts.sans, marginTop: 3,
                            color: 'rgba(245,197,24,0.85)', letterSpacing: 0.3,
                            textAlign: 'center', width: '100%',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            fontWeight: 600,
                          }}>
                            {backupPlayer.name.split(' ').pop()}
                          </div>
                          <div style={{ fontSize: fontSize.badge, fontFamily: fonts.sans, color: 'rgba(245,197,24,0.5)', letterSpacing: 0.5, textTransform: 'uppercase' }}>
                            Backup
                          </div>
                        </div>
                      ) : (
                        <div
                          style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 48, cursor: canEditLineup ? 'pointer' : 'default' }}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (!canEditLineup) return;
                            // Toggle picking-backup mode. Also ensure lineupMode
                            // is on so the roster table renders tap-to-add
                            // affordances (highlights, etc) and the user can
                            // see where to tap next.
                            setLineupMode(true);
                            setPickingBackup(prev => !prev);
                          }}
                        >
                          <div style={{
                            width: 38, height: 38, borderRadius: '50%',
                            // When pickingBackup is on, the slot pulses gold to
                            // signal "this is where your next tap lands."
                            background: pickingBackup
                              ? 'rgba(245,197,24,0.18)'
                              : lineupMode ? 'rgba(245,197,24,0.06)' : 'rgba(255,255,255,0.03)',
                            border: `2px dotted ${canEditLineup
                              ? (pickingBackup ? 'rgba(245,197,24,0.95)' : (lineupMode ? 'rgba(245,197,24,0.6)' : 'rgba(245,197,24,0.35)'))
                              : 'rgba(255,255,255,0.12)'}`,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            transition: 'all 0.15s',
                            boxShadow: pickingBackup ? '0 0 0 3px rgba(245,197,24,0.15)' : 'none',
                          }}>
                            <span style={{
                              fontSize: fontSize.lg, fontWeight: 300, lineHeight: 1,
                              color: canEditLineup
                                ? (pickingBackup ? 'rgba(245,197,24,1)' : (lineupMode ? 'rgba(245,197,24,0.85)' : 'rgba(245,197,24,0.45)'))
                                : 'rgba(255,255,255,0.15)',
                            }}>+</span>
                          </div>
                          <div style={{
                            fontSize: fontSize.badge, fontFamily: fonts.sans, marginTop: 3,
                            textAlign: 'center', width: '100%',
                            color: pickingBackup
                              ? 'rgba(245,197,24,1)'
                              : canEditLineup ? 'rgba(245,197,24,0.6)' : 'rgba(255,255,255,0.15)',
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
        />
      )}

      {/* ── Action buttons + roster table ── */}
      <div style={{ ...theme.card }} onClick={() => { if (lineupMode) { setLineupMode(false); setPickingBackup(false); } }}>



        {/* ── Mobile: all 3 toggles above the table in a flex row ── */}
        {isMobile && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 8px 4px', borderBottom: `1px solid ${colors.borderSubtle}` }}>
            <RosterSlider leftVal="full" leftLabel="All" rightVal="playing" rightLabel="⛳"
              current={rosterView} setter={(val) => { setRosterView(val); if (val === 'full') { setSortCol(null); setSortDir('asc'); } }}
              leftColor="rgba(100,180,255,0.95)" rightColor="rgba(80,180,120,0.95)"
              disabled={!tournamentField?.size} width={80} colors={colors} fonts={fonts} />
            <RosterSlider leftVal="info" leftLabel="Info" rightVal="stats" rightLabel="Stats"
              current={infoView} setter={setInfoView}
              leftColor="rgba(255,255,255,0.95)" rightColor="rgba(100,180,255,0.9)"
              width={80} colors={colors} fonts={fonts} />
            <RosterSlider leftVal="sfgl" leftLabel="SFGL" rightVal="pgat" rightLabel="PGAT"
              current={statsView} setter={setStatsView}
              leftColor="rgba(245,197,24,0.9)" rightColor="rgba(80,180,120,0.9)"
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
                      leftColor="rgba(100,180,255,0.95)" rightColor="rgba(80,180,120,0.95)"
                      disabled={!tournamentField?.size} width={108} colors={colors} fonts={fonts} />
                  </th>
                  <th colSpan={2} style={{ padding: '6px 0 4px', borderBottom: 'none', textAlign: 'center' }}>
                    <div style={{ display: 'flex', justifyContent: 'center' }}>
                      <RosterSlider leftVal="info" leftLabel="Info" rightVal="stats" rightLabel="Stats"
                        current={infoView} setter={setInfoView}
                        leftColor="rgba(255,255,255,0.95)" rightColor="rgba(100,180,255,0.9)"
                        width={108} colors={colors} fonts={fonts} />
                    </div>
                  </th>
                  <th style={{ padding: '6px 8px 4px', borderBottom: 'none', textAlign: 'right' }}>
                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <RosterSlider leftVal="sfgl" leftLabel="SFGL" rightVal="pgat" rightLabel="PGAT"
                        current={statsView} setter={setStatsView}
                        leftColor="rgba(245,197,24,0.9)" rightColor="rgba(80,180,120,0.9)"
                        disabled={infoView !== 'stats'} width={108} colors={colors} fonts={fonts} />
                    </div>
                  </th>
                </tr>
              )}
              {/* Row 2: column headers */}
              <tr>
                <th scope="col" style={{ ...theme.tableHeaderCell, fontFamily: fonts.sans, fontSize: fontSize.xs, fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase', textAlign: 'left', color: 'rgba(255,255,255,0.85)', borderTop: `1px solid ${colors.borderSubtle}` }}>Player</th>
                {infoView === 'info' ? (<>
                  <th scope="col" onClick={() => toggleSort('teeTime')} style={{ ...theme.tableHeaderCell, fontFamily: fonts.sans, fontSize: fontSize.xs, fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase', textAlign: isMobile ? 'right' : 'center', whiteSpace: 'nowrap', paddingRight: isMobile ? 4 : 0, ...sortHeaderStyle('teeTime', 'rgba(255,255,255,0.85)') }}>
                    {liveData?.players?.length && liveData.players.some(p => p.thru === 'F' || (!isNaN(parseInt(p.thru, 10)) && parseInt(p.thru, 10) >= 0))
                      ? 'Score'
                      : <>Tee Time{sortArrow('teeTime')}</>}
                  </th>
                  <th scope="col" onClick={() => toggleSort('odds')} style={{ ...theme.tableHeaderCell, fontFamily: fonts.sans, fontSize: fontSize.xs, fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase', textAlign: 'right', whiteSpace: 'nowrap', paddingRight: isMobile ? 6 : 8, ...sortHeaderStyle('odds', 'rgba(255,255,255,0.85)') }}>
                    Odds{sortArrow('odds')}
                  </th>
                  <th scope="col" style={{ ...theme.tableHeaderCell, fontFamily: fonts.sans, fontSize: fontSize.xs, fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase', textAlign: 'center', color: 'rgba(255,255,255,0.85)' }}>
                    {liveData?.state === 'in' ? 'Pos' : ''}
                  </th>
                </>) : (<>
                  <th scope="col" onClick={() => toggleSort('owgr')} style={{ ...theme.tableHeaderCell, fontFamily: fonts.sans, fontSize: fontSize.xs, fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase', textAlign: 'center', whiteSpace: 'nowrap', ...sortHeaderStyle('owgr', 'rgba(100,180,255,0.9)') }}>
                    OWGR{sortArrow('owgr')}
                  </th>
                  <th scope="col" onClick={() => toggleSort('cuts')} style={{ ...theme.tableHeaderCell, fontFamily: fonts.sans, fontSize: fontSize.xs, fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase', textAlign: 'center', whiteSpace: 'nowrap', ...sortHeaderStyle('cuts', 'rgba(100,180,255,0.9)') }}>
                    {isMobile ? 'Cuts' : 'Cuts / Starts'}{sortArrow('cuts')}
                  </th>
                  <th scope="col" onClick={() => toggleSort('earnings')} style={{ ...theme.tableHeaderCell, fontFamily: fonts.sans, fontSize: fontSize.xs, fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase', textAlign: 'right', paddingRight: isMobile ? 6 : 8, ...sortHeaderStyle('earnings', statsView === 'sfgl' ? 'rgba(245,197,24,0.9)' : 'rgba(245,197,24,0.9)') }}>
                    Earnings{sortArrow('earnings')}
                  </th>
                </>)}
              </tr>
            </thead>
            <tbody>
              {sortedRoster.map(player => {
                const isInLineup     = (team.lineup || []).includes(player.name);
                const activeLineupCount = (team.lineup || []).filter(name => currentRoster.some(p => p.name === name)).length;
                const canAddToLineup = activeLineupCount < LINEUP_SIZE && (!player.limited || player.starts < MAX_LIMITED_STARTS);
                const hasLineup      = (team.lineup || []).length > 0;
                const isEditing      = canEditLineup && lineupMode;
                // Only dim benched players once the tournament week has actually begun —
                // i.e. tee times are posted (firstTeeTime exists) or lineup window is open.
                // Between events the lineup carries over from the prior week and should not dim.
                const tournamentActive = !!(firstTeeTime || lineupOpen);
                const isBenched      = tournamentActive && hasLineup && !isInLineup && !isEditing;
                const dimColor       = 'rgba(255,255,255,0.45)';
                const rowClickable   = isEditing && isOwnTeam && (isInLineup || canAddToLineup);

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
                              if (!lineupMode) {
                                setLineupMode(true);
                                // If clicking a non-lineup player with room, add them
                                if (!isInLineup && canAddToLineup) togglePlayerInLineup(player);
                              } else if (isInLineup || canAddToLineup) {
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
                              background: 'rgba(80,195,120,0.9)',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                            }}>
                              <span style={{ color: '#fff', fontSize: fontSize.xs, fontWeight: 900, lineHeight: 1 }}>+</span>
                            </div>
                          )}
                          {player.limited && (player.stars || 1) > 0 && (
                            <div style={{
                              position: 'absolute', bottom: -4, left: '50%', transform: 'translateX(-50%)',
                              background: 'rgba(15,25,45,0.88)', borderRadius: 6,
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
                                ? (isBenched ? 'rgba(245,197,24,0.4)' : colors.textGold)
                                : player.unlimited
                                  ? (isBenched ? 'rgba(100,140,220,0.4)' : 'rgba(100,140,220,0.9)')
                                  : (isBenched ? dimColor : colors.textPrimary),
                            }}>
                              {displayName(player.name, isMobile)}
                            </span>
                            {tournamentField?.has(normalizeNordic(player.name)) && (
                              <span title="In this week's field" style={{ fontSize: fontSize.sm, lineHeight: 1, flexShrink: 0, opacity: isBenched ? 0.35 : 1 }}>⛳</span>
                            )}
                            {player.limited && (
                              <span style={{
                                fontFamily: fonts.sans, fontSize: fontSize.xs, fontWeight: 600,
                                color: isBenched ? 'rgba(245,197,24,0.35)' : colors.textGoldDim,
                              }}>
                                {sfglCutsMap[player.name]?.starts ?? 0}/{MAX_LIMITED_STARTS}
                              </span>
                            )}
                            {player.unlimited && (
                              <span style={{
                                fontFamily: fonts.sans,
                                fontSize: fontSize.md,
                                fontWeight: 700,
                                lineHeight: 1,
                                color: isBenched ? 'rgba(100,140,220,0.4)' : 'rgba(100,140,220,0.9)',
                                flexShrink: 0,
                              }} title="Unlimited starts">∞</span>
                            )}
                          </div>
                          <div style={{ fontSize: fontSize.xs, fontFamily: fonts.sans, color: isBenched ? 'rgba(255,255,255,0.35)' : colors.textMuted }}>
                            {player.yearsOfService > 1 && <span>(Yr {player.yearsOfService})</span>}
                          </div>
                        </div>
                      </div>
                    </td>

                    {/* ── Info columns: Tee Time/Score + Odds + empty Earnings ── */}
                    {infoView === 'info' && (() => {
                      const normalize = normalizeNordic;
                      const normName = normalize(player.name);
                      const playerOdds = oddsMap[normName];
                      const inField = tournamentField?.has(normName);

                      // Col 1: Score (live) → Tee Time → ⛳ in field → —
                      let col1;
                      if (liveData?.players?.length) {
                        // Multi-strategy name matching from golfUtils pattern
                        const buildInitialsKey = (name) => {
                          const parts = normalize(name).split(' ');
                          if (parts.length < 2) return null;
                          const initials = parts.slice(0, -1).map(p => p[0]).join('');
                          return `${initials} ${parts[parts.length - 1]}`;
                        };
                        const rosterLast = normName.split(' ').slice(-1)[0];
                        const rosterInitialsKey = buildInitialsKey(player.name);
                        // Only match roster players who are actually in this week's
                        // field (i.e. those that earn the ⛳ flag). A non-field
                        // player must never pick up a leaderboard entry via the
                        // fuzzy last-name / substring fallbacks below — that caused
                        // a benched "B. Brown" who isn't playing to inherit another
                        // Brown's CUT status from the live leaderboard.
                        const live = !inField ? null : (
                          liveData.players.find(p => normalize(p.name) === normName)
                          || liveData.players.find(p => {
                            const ln = normalize(p.name).split(' ').slice(-1)[0];
                            return ln === rosterLast && rosterLast.length > 3;
                          })
                          || liveData.players.find(p => {
                            const ln = normalize(p.name);
                            return ln.includes(normName) || normName.includes(ln);
                          })
                          || (rosterInitialsKey ? liveData.players.find(p => buildInitialsKey(p.name) === rosterInitialsKey) : null)
                        );

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
                          const tt = live?.thru || teeTimeMap[normName];
                          col1 = <td style={{ padding: '7px 4px', textAlign: isMobile ? 'right' : 'center', fontFamily: fonts.mono, fontSize: isMobile ? 12 : 14, color: isBenched ? dimColor : (tt ? colors.textPrimary : colors.textMuted) }}>{tt ? tt.replace(' AM', 'a').replace(' PM', 'p') : <span style={{ opacity: 0.25 }}>—</span>}</td>;
                        }
                      } else {
                        const teeTime = teeTimeMap[normName];
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
                      if (liveData?.state === 'in') {
                        // Re-find live entry (same field-gated match logic as col1)
                        const rosterLast = normName.split(' ').slice(-1)[0];
                        const live = !inField ? null : (
                          liveData.players.find(p => normalize(p.name) === normName)
                          || liveData.players.find(p => {
                            const ln = normalize(p.name).split(' ').slice(-1)[0];
                            return ln === rosterLast && rosterLast.length > 3;
                          })
                        );
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
        onClose={() => { setShowAddDropModal(false); setEditingWaiverData(null); setPendingAddPlayer(null); }}
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
        fieldPlayerIds={fieldPlayerIds}
        tournamentField={tournamentField}
        leagueSettings={resolvedSettings}
        onHeadshotsFound={found => updateHeadshots && updateHeadshots(prev => ({ ...(prev || {}), ...found }))}
      />
    </div>
  );
};
