import { useState, useEffect, useRef } from 'react';
import { X, MinusCircle } from 'lucide-react';
import { useDialog } from './DialogContext';
import { getSegmentByDate, isTournamentLocked, isWaiverWindowOpen, getTeamAbbreviation, normalizePlayerName } from '../utils/index.js';
import { TeamName } from '../components/TeamName';
import { getTransactionFee, buildPlayerAttributeIndex, hydratePlayer, buildEffectiveRoster, txBelongsToTeam } from '../utils/sharedHelpers';
// ROSTER_LIMIT and fees now come from leagueSettings prop
import { playersApi } from '../api/firebase';
import { sendManagerPush } from '../api/pushSend';
import { theme, colors, fonts, amber, gold, green, greenMuted, red, white, blueBright, fontSize } from '../theme.js';
import { LIV_GOLF_ROSTER } from '../constants';
import { BottomSheet } from '../components/BottomSheet';
import { activatable } from '../utils/a11y';

// Use shared LIV roster from constants instead of local duplicate
const LIV_PLAYERS = new Set(LIV_GOLF_ROSTER);

const accentColor   = (waiver) => waiver ? colors.warning              : colors.earningsGreen;
const accentBg      = (waiver) => waiver ? amber(0.08)      : green(0.08);
const accentBorder  = (waiver) => waiver ? amber(0.35)      : green(0.35);

// ── "Playing in current tourney" toggle — mirrors the All / ⛳ slider in
// RostersView. Boolean-backed: value=true means "field only". ─────────────────
const FieldToggle = ({ value, setter, disabled = false, width = 84 }) => (
  <div style={{ opacity: disabled ? 0.3 : 1, pointerEvents: disabled ? 'none' : 'auto', transition: 'opacity 0.18s', flexShrink: 0 }}>
    <div style={{ display: 'flex', gap: 2, background: white(0.04), border: `1px solid ${white(0.10)}`, borderRadius: 10, padding: 3, width }}>
      {[['all', 'All', blueBright(0.95)], ['field', '⛳', greenMuted(0.95)]].map(([val, label, color]) => {
        const active = (value ? 'field' : 'all') === val;
        return (
          <button key={val} type="button" onClick={() => setter(val === 'field')} style={{
            flex: 1, padding: '8px 0', borderRadius: 8,
            background: active ? white(0.08) : 'transparent',
            border: active ? `1px solid ${white(0.18)}` : '1px solid transparent',
            fontFamily: fonts.sans, fontSize: fontSize.caption, fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase',
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

// ── Headshot helpers (shared — single source of truth in headshotUtils.js) ──
import {
  getPlayerHeadshot,
  makeHeadshotErrorHandler,
  mergeHeadshotEntry,
} from '../utils/headshotUtils';

// Per-name merge so a response carrying only one id can't drop the other.
const mergeHeadshotMaps = (prev, found) => {
  const next = { ...(prev || {}) };
  Object.entries(found || {}).forEach(([name, entry]) => {
    next[name] = mergeHeadshotEntry(next[name], entry);
  });
  return next;
};

export const AddDropPlayerModal = ({
  isOpen, onClose, team, currentRoster, teams,
  updateTeams, transactions, setTransactions, tournaments,
  isWaiverMode, activeTournamentIndex, nextTournamentIndex, txSegment, editingWaiverData,
  headshots, tournamentField = null, leagueSettings = {}, onHeadshotsFound,
  allPlayers = [],
}) => {
  const ROSTER_LIMIT            = leagueSettings.rosterLimit ?? 13;
  const TRANSACTION_FEE_FREE_AGENT = leagueSettings.feeFA    ?? 1;
  const TRANSACTION_FEE_WAIVER  = leagueSettings.feeWaiver   ?? 2;
  const [searchTerm,           setSearchTerm]           = useState('');
  const [fieldOnly,            setFieldOnly]            = useState(false); // "playing in current tourney" toggle
  const [selectedPlayerToAdd,  setSelectedPlayerToAdd]  = useState(null);
  const [selectedPlayerToDrop, setSelectedPlayerToDrop] = useState(null);
  const [saving,               setSaving]               = useState(false);
  const [topPlayers,           setTopPlayers]           = useState([]); // top 50 free agents by OWGR
  const [searchResults,        setSearchResults]        = useState([]); // results from name search
  const [loadingPlayers,       setLoadingPlayers]       = useState(false);
  const [searching,            setSearching]            = useState(false);
  const bodyRef  = useRef(null);
  const [localHeadshots, setLocalHeadshots] = useState({});
  const searchTimerRef = useRef(null);
  const dialog   = useDialog();

  // Populate the browse list when the modal opens. Prefer the in-memory
  // `allPlayers` list — it's already loaded at app startup and localStorage-
  // cached, so the top-100 list appears INSTANTLY. This avoids re-downloading
  // the entire `players` collection (~700 docs) from Firestore on every open,
  // which was the cause of the long "Loading players…" hang on first open.
  // Fall back to a Firestore fetch only when allPlayers isn't available.
  useEffect(() => {
    if (!isOpen) return;
    const buildTop = (list) => (list || [])
      .filter(p => p && !p.isLiv && p.name && typeof p.name === 'string'
        && !/^\d+$/.test(p.name.trim()) && p.name.includes(' '))
      .sort((a, b) => (a.worldRank ?? 9999) - (b.worldRank ?? 9999))
      .slice(0, 100);

    if (allPlayers?.length) {
      setTopPlayers(buildTop(allPlayers));
      setLoadingPlayers(false);
      return;
    }

    setLoadingPlayers(true);
    playersApi.getTopRanked(100)
      .then(players => setTopPlayers(players))
      .catch(() => setTopPlayers([]))
      .finally(() => setLoadingPlayers(false));
  }, [isOpen, allPlayers]);

  // ── Escape key + body scroll lock (shared) ─────────────────────────────────

  // Pre-populate when editing an existing waiver claim
  useEffect(() => {
    if (editingWaiverData && isOpen) {
      // Try to find in topPlayers, or fetch directly by name
      const inTop = topPlayers.find(p => p.name === editingWaiverData.player);
      if (inTop) {
        setSelectedPlayerToAdd(inTop);
      } else if (editingWaiverData.player) {
        playersApi.getByName(editingWaiverData.player).then(p => {
          if (p) setSelectedPlayerToAdd({ name: p.name, worldRank: p.world_rank, isLiv: p.is_liv });
        }).catch(() => {});
      }
      if (editingWaiverData.droppedPlayer) {
        const toDrop = currentRoster.find(p => p.name === editingWaiverData.droppedPlayer);
        if (toDrop) setSelectedPlayerToDrop(toDrop);
      }
    }
  }, [editingWaiverData, isOpen, topPlayers, currentRoster]);

  // Scroll to top whenever drop selection changes (or add selection is made)
  useEffect(() => {
    if (selectedPlayerToDrop && bodyRef.current) {
      bodyRef.current.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [selectedPlayerToDrop]);

  // Fetch ESPN headshot IDs for top players not already in the headshots map
  useEffect(() => {
    if (!isOpen || !topPlayers.length) return;
    const missing = topPlayers
      .filter(p => p.name && !headshots?.[p.name])
      .map(p => p.name)
      .slice(0, 50);
    if (!missing.length) return;
    const encoded = missing.map(n => encodeURIComponent(n)).join(',');
    fetch(`/api/headshots?names=${encoded}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data?.results) return;
        setLocalHeadshots(prev => mergeHeadshotMaps(prev, data.results));
        onHeadshotsFound?.(data.results);
      })
      .catch(() => {});
  }, [isOpen, topPlayers]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced search — fetch from Firestore when user types
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    const term = searchTerm.trim();
    if (term.length < 2) { setSearchResults([]); return; }
    searchTimerRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const results = await playersApi.searchByName(term, 20);
        setSearchResults(results);
        // Fetch headshots for search results too
        const missing = results.filter(p => !headshots?.[p.name] && !localHeadshots[p.name]).map(p => p.name);
        if (missing.length) {
          fetch(`/api/headshots?names=${missing.map(n => encodeURIComponent(n)).join(',')}`)
            .then(r => r.ok ? r.json() : null)
            .then(data => { if (data?.results) { setLocalHeadshots(prev => mergeHeadshotMaps(prev, data.results)); onHeadshotsFound?.(data.results); } })
            .catch(() => {});
        }
      } catch { setSearchResults([]); }
      finally { setSearching(false); }
    }, 300);
    return () => clearTimeout(searchTimerRef.current);
  }, [searchTerm]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isOpen || !team) return null;

  // Merge prop headshots with locally fetched ones
  const mergedHeadshots = { ...localHeadshots, ...headshots };

  // ── Available players ──────────────────────────────────────────────────────
  // Effective roster comes from the CANONICAL buildEffectiveRoster helper, so
  // the modal's ownership/availability view can't diverge from the Rosters
  // screen, the waiver processor, or the admin panels. This was previously a
  // local re-implementation (the third of six) that resolved tournament
  // positions from the raw stored `tx.tournamentIndex` rather than the stable
  // tournament name, so a schedule reorder misaligned the cutoff.
  //
  // When no tournament is flagged `playing`, activeTournamentIndex is -1. The
  // old code skipped the replay entirely in that case, showing stale ownership
  // between events; passing `undefined` instead replays the full history,
  // which is the correct "who owns this player right now" answer.
  const rosterOpts = {
    tournaments,
    upToTournamentIndex: activeTournamentIndex >= 0 ? activeTournamentIndex : undefined,
  };
  const effectiveRosterNames = (t) => buildEffectiveRoster(t, transactions, rosterOpts);

  const rosteredPlayers = new Set(
    teams.flatMap(t => [...effectiveRosterNames(t)].map(normalizePlayerName))
  );

  // Players dropped via a processed FA/waiver whose tournament hasn't been completed yet
  // are "on waivers" — unavailable until that tournament is processed.
  // We consider a drop "in limbo" if its tournamentIndex maps to an incomplete tournament,
  // OR if it has no tournamentIndex but happened recently (this week).
  const limboPlayers = new Set(
    transactions
      .filter(tx => {
        if (tx.status !== 'processed' && tx.status !== 'completed') return false;
        if (tx.type === 'mulligan') return false;
        if (!tx.droppedPlayer) return false;
        // If we have a tournamentIndex, check if that tournament is completed
        if (tx.tournamentIndex !== undefined) {
          const t = tournaments?.[tx.tournamentIndex];
          return t && !t.completed; // limbo = tournament not yet completed
        }
        // No tournamentIndex: treat as current week (in limbo)
        return true;
      })
      .map(tx => normalizePlayerName(tx.droppedPlayer))
  );

  // Hide players this team already has a pending waiver claim for
  const thisTeamPendingClaims = new Set(
    transactions
      .filter(tx => tx.status === 'pending' && tx.type === 'waiver' && txBelongsToTeam(tx, team) && tx.player)
      .map(tx => normalizePlayerName(tx.player))
  );

  // Use search results when searching, otherwise top 50 free agents
  const playerPool = searchTerm.trim().length >= 2 ? searchResults : topPlayers;
  const availablePlayers = playerPool.filter(p => {
    if (!p.name || typeof p.name !== 'string') return false;
    if (p.isLiv || LIV_PLAYERS.has(p.name)) return false;
    if (thisTeamPendingClaims.has(normalizePlayerName(p.name))) return false;
    // "Playing in current tourney" toggle — restrict to this week's field
    if (fieldOnly && tournamentField && !tournamentField.has(p.name)) return false;
    return true;
  });

  // Build ownership map: playerName → teamName (same effective-roster logic as
  // RostersView, via effectiveRosterNames, so the owner badge matches the roster).
  const ownerMap = new Map();
  teams.forEach(t => {
    effectiveRosterNames(t).forEach(name => ownerMap.set(normalizePlayerName(name), t.name));
  });

  // Is the active tournament currently locked (Thu–Sun)?
  // In waiver mode, players can still be selected (that's the whole point of waivers during a locked tournament)
  const activeTournament = tournaments?.find(t => t.playing && !t.completed);
  const tournamentIsLocked = isWaiverMode ? false : isTournamentLocked(activeTournament);

  // When browsing (no search): show only free agents from top 50
  // When searching: show all results including rostered players (greyed out)
  const displayPlayers = searchTerm.trim().length >= 2
    ? availablePlayers
    : availablePlayers
        .filter(p => !rosteredPlayers.has(normalizePlayerName(p.name)) && !limboPlayers.has(normalizePlayerName(p.name)))
        .sort((a, b) => (a.worldRank ?? 9999) - (b.worldRank ?? 9999));

  const rosterFull   = currentRoster.length >= ROSTER_LIMIT;

  // Players already listed as the drop in another pending waiver for this team
  const pendingDropNames = new Set(
    transactions
      .filter(tx => txBelongsToTeam(tx, team) && tx.type === 'waiver' && tx.status === 'pending' && tx.droppedPlayer)
      .map(tx => tx.droppedPlayer)
  );
  const needsDrop    = rosterFull && selectedPlayerToAdd;
  const canConfirm   = selectedPlayerToAdd && (!rosterFull || selectedPlayerToDrop);
  const fee          = getTransactionFee(isWaiverMode ? 'waiver' : 'fa', leagueSettings);

  // ── Confirm & persist ──────────────────────────────────────────────────────
  const handleConfirm = async () => {
    if (!canConfirm) return;
    setSaving(true);

    // ── Defense in depth: re-derive waiver status at SUBMIT time ──────────────
    // `isWaiverMode` is computed once, when the modal opens, from the tournament
    // flagged `playing`. In the gap between an event being marked processed and
    // the next being flagged `playing` — which overlaps the waiver window — that
    // source tournament is undefined and the click-time prop comes back false,
    // which would write an INSTANT free-agent add and mutate the roster. We
    // re-check the window here against the date-anchored upcoming tournament so a
    // claim made during the waiver window can NEVER instant-apply. We trust an
    // open window over the prop (|| isWaiverMode keeps the normal FA path intact).
    const submitTournament = tournaments?.[nextTournamentIndex ?? activeTournamentIndex] || null;
    // Editing an existing pending waiver is always a waiver edit, even if the
    // window has since closed (e.g. editing after cutoff while awaiting the
    // round). Otherwise fall back to the live window check + click-time prop.
    const isEdit = !!editingWaiverData;
    const treatAsWaiver = isEdit || isWaiverWindowOpen(submitTournament, leagueSettings) || isWaiverMode;
    const submitFee = getTransactionFee(treatAsWaiver ? 'waiver' : 'fa', leagueSettings);

    const newTx = {
      // Stable identity from birth (same pattern as AddTransactionModal /
      // swingAward). Without it, sync() can't match this row against its
      // Firestore doc until a refetch attaches the doc id, causing re-insert
      // churn and defeating txId-based dedup.
      txId: `${treatAsWaiver ? 'waiver' : 'fa'}-${team.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      team:            team.name,
      // teamId is the STABLE key. `team` (the name) is manager-editable, and
      // matching history by name is what a rename used to break.
      teamId:          team.id || team.name,
      type:            treatAsWaiver ? 'waiver' : 'free agent',
      player:          selectedPlayerToAdd.name,
      droppedPlayer:   selectedPlayerToDrop?.name || null,
      fee:             submitFee,
      segment:         txSegment || getSegmentByDate(),
      date:            new Date().toLocaleDateString(),
      // fa/waiver tag the NEXT upcoming event (the one players will play in)
      tournamentIndex: nextTournamentIndex ?? activeTournamentIndex,
      // Stable tournament identity alongside the positional index (reorder-safe).
      tournament: tournaments?.[nextTournamentIndex ?? activeTournamentIndex]?.name || undefined,
      status:          treatAsWaiver ? 'pending' : 'processed',
      priority: treatAsWaiver
        ? (transactions.filter(tx => txBelongsToTeam(tx, team) && tx.type === 'waiver' && tx.status === 'pending').length + 1)
        : undefined,
      timestamp: Date.now(),
    };

    // Hydrate from the durable attribute index so a re-added LIMITED player
    // keeps limited status, stars, years of service, and accumulated SFGL data.
    // A limited player can never come back as unlimited.
    const newPlayer = hydratePlayer(
      selectedPlayerToAdd.name,
      buildPlayerAttributeIndex(teams, tournaments),
      selectedPlayerToAdd.headshot || '',
    );

    // When editing, replace the original pending waiver rather than adding a
    // second one: keep its queue priority, drop the old row, and apply only the
    // FEE DELTA (the original fee was already charged at first submission).
    let baseTransactions = transactions;
    let teamFeeDelta = submitFee;
    let replacedClaim = null; // the original pending waiver this edit replaces
    if (isEdit) {
      // Remove exactly ONE matching original claim — by id when present, else by
      // fields (same approach as deleteWaiver, robust to index shifts).
      const origId = editingWaiverData.id;
      baseTransactions = transactions.filter(t => {
        if (replacedClaim) return true;
        const match = origId != null
          ? t.id === origId
          : (txBelongsToTeam(t, team) && t.type === 'waiver' && t.status === 'pending'
             && t.player === editingWaiverData.player
             && (t.droppedPlayer || null) === (editingWaiverData.droppedPlayer || null));
        if (match) { replacedClaim = t; return false; }
        return true;
      });
      teamFeeDelta = submitFee - (editingWaiverData.fee || 0);
      newTx.priority = editingWaiverData.priority ?? newTx.priority;
    }

    const updatedTeams = teams.map(t => {
      if (t.id !== team.id) return t;
      let newRoster = [...t.roster];
      if (!treatAsWaiver) {
        if (selectedPlayerToDrop) newRoster = newRoster.filter(p => p.name !== selectedPlayerToDrop.name);
        if (!newRoster.some(p => p.name === newPlayer.name)) newRoster.push(newPlayer);
      }
      return { ...t, roster: newRoster, transactionFees: (t.transactionFees || 0) + teamFeeDelta };
    });

    const newTransactions = [newTx, ...baseTransactions];
    updateTeams(updatedTeams);
    // setTransactions IS updateTransactions — persists to Firebase + localStorage.
    // sync() never deletes by absence, so when editing we must explicitly pass
    // the original claim this edit replaces or its Firestore doc would survive.
    setTransactions(newTransactions, replacedClaim ? { deleted: [replacedClaim] } : undefined);

    // ── Push notification (Wave J Round 6 — freeAgent broadcast) ───────────
    // Only fires for IMMEDIATE free agent actions, NOT pending waivers.
    // Waivers fire their own 'waivers' summary push from cron.js after the
    // weekly processing job completes — pushing here would announce a claim
    // that hasn't won yet (and might never).
    //
    // Recipients: all teams EXCEPT the actor. A manager doesn't need a ping
    // about their own action they just took.
    //
    // Fire-and-forget: the transaction is already committed in Firestore.
    // A push failure (network blip, missing VAPID, etc) shouldn't undo the
    // transaction or block the success toast.
    if (!treatAsWaiver) {
      const recipientIds = teams
        .filter(t => t.id !== team.id)
        .map(t => t.id);
      const playerSummary = selectedPlayerToDrop
        ? `+${selectedPlayerToAdd.name} / -${selectedPlayerToDrop.name}`
        : `+${selectedPlayerToAdd.name}`;
      sendManagerPush({
        event: 'freeAgent',
        teamId: team.id,
        recipients: recipientIds,
        title: `🔄 ${team.name}`,
        body: playerSummary,
        deepLink: '#transactions',
      }).catch(err => console.warn('[push] freeAgent send failed:', err.message));
    }

    setSaving(false);
    dialog.showToast(
      `${isEdit ? 'Waiver claim updated' : treatAsWaiver ? 'Waiver claim submitted' : `Added ${selectedPlayerToAdd.name}`}${selectedPlayerToDrop ? `${isEdit ? ' · ' : ' / '}${isEdit ? 'drop ' : 'Dropped '}${selectedPlayerToDrop.name}` : ''}`,
      'success',
    );
    reset();
  };

  const reset = () => {
    setSelectedPlayerToAdd(null);
    setSelectedPlayerToDrop(null);
    setSearchTerm('');
    setFieldOnly(false);
    onClose();
  };

  const selectPlayerToAdd = (player) => {
    setSelectedPlayerToAdd(player);
    setSelectedPlayerToDrop(null);
    // Scroll to top to show the transaction tiles
    if (bodyRef.current) bodyRef.current.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // ── Confirm button (reused in header and inline) ──────────────────────────
  const ConfirmBtn = ({ compact = false }) => (
    <button
      onClick={handleConfirm}
      disabled={saving || !canConfirm}
      style={{
        fontFamily: fonts.sans,
        fontSize: compact ? 11 : 13,
        fontWeight: 600,
        padding: compact ? '7px 16px' : '12px 22px',
        borderRadius: 6,
        border: `1px solid ${canConfirm
          ? (isWaiverMode ? amber(0.45) : green(0.45))
          : colors.borderSubtle}`,
        background: canConfirm
          ? (isWaiverMode ? amber(0.14) : green(0.14))
          : white(0.03),
        color: canConfirm ? accentColor(isWaiverMode) : colors.textMuted,
        cursor: canConfirm && !saving ? 'pointer' : 'not-allowed',
        transition: 'background 0.15s, border-color 0.15s, transform 0.1s',
        whiteSpace: 'nowrap',
      }}
    >
      {saving ? 'Saving…' : 'Confirm'}
    </button>
  );

  const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;

  return (
    <BottomSheet
      isOpen={isOpen}
      onClose={onClose}
      variant="panel"
      accent={isWaiverMode ? colors.warning : colors.success}
      label={isWaiverMode ? 'Submit waiver claim' : 'Add or drop a player'}
    >

        {/* ── Header ── */}
        <div style={{
          padding: '14px 18px',
          borderBottom: `1px solid ${colors.borderSubtle}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexShrink: 0, gap: 10,
        }}>
          <div style={{ minWidth: 0 }}>
            {/* Mode eyebrow — small uppercase tag in accent color, matching
                the rest of the modal-feel aesthetic. The fee sits inline with
                the team name underneath. */}
            <div style={{
              fontFamily: fonts.sans,
              fontSize: fontSize.xs,
              fontWeight: 700,
              letterSpacing: '1.8px',
              textTransform: 'uppercase',
              color: accentColor(isWaiverMode),
            }}>
              {isWaiverMode ? '⏰ Waiver Claim' : '✅ Free Agent'}
            </div>
            <div style={{
              fontFamily: fonts.sans,
              fontSize: fontSize.base,
              fontWeight: 600,
              color: colors.textPrimary,
              marginTop: 2,
            }}>
              <TeamName name={team.name} />
              <span style={{ color: colors.textMuted, fontWeight: 400, marginLeft: 6 }}>
                · ${isWaiverMode
                  ? TRANSACTION_FEE_WAIVER.toLocaleString()
                  : TRANSACTION_FEE_FREE_AGENT.toLocaleString()} fee
              </span>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            {/* Confirm button in header — only when both players selected */}
            {canConfirm && <ConfirmBtn compact />}
            <button onClick={reset} style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.textSecondary, padding: 4 }}>
              <X style={{ width: 18, height: 18 }} />
            </button>
          </div>
        </div>

        {/* ── Transaction tiles (sticky below header once add is selected) ── */}
        {selectedPlayerToAdd && (
          <div style={{
            display: 'flex', gap: 8, padding: '10px 18px',
            borderBottom: `1px solid ${colors.borderSubtle}`,
            flexShrink: 0,
            background: '#0d1a2e',
          }}>
            {/* Adding tile */}
            <div style={{
              flex: 1, padding: '10px 12px',
              background: green(0.08),
              border: `1px solid ${green(0.3)}`,
              borderRadius: 6,
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: fonts.sans, fontSize: fontSize.xs, fontWeight: 700, letterSpacing: '1.5px', textTransform: 'uppercase', color: colors.success, marginBottom: 3 }}>
                  Adding
                </div>
                <div style={{ fontFamily: fonts.sans, fontSize: fontSize.base, color: colors.textPrimary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {selectedPlayerToAdd.name}
                </div>
              </div>
              <button
                onClick={() => { setSelectedPlayerToAdd(null); setSelectedPlayerToDrop(null); }}
                title="Remove selection"
                style={{
                  background: red(0.08),
                  border: `1px solid ${red(0.3)}`,
                  borderRadius: 6,
                  width: 26, height: 26,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: 'pointer',
                  color: red(0.8),
                  fontSize: fontSize.base, lineHeight: 1, fontWeight: 700,
                  flexShrink: 0,
                  transition: 'all 0.15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = red(0.18); e.currentTarget.style.borderColor = red(0.5); e.currentTarget.style.color = 'rgba(240,100,100,1)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = red(0.08); e.currentTarget.style.borderColor = red(0.3); e.currentTarget.style.color = red(0.8); }}
              >
                ✕
              </button>
            </div>

            {/* Drop tile — shows placeholder or selected player */}
            {rosterFull && (
              <div style={{
                flex: 1, padding: '10px 12px',
                background: selectedPlayerToDrop ? red(0.06) : white(0.02),
                border: `1px solid ${selectedPlayerToDrop ? red(0.3) : colors.borderSubtle}`,
                borderRadius: 6,
                display: 'flex', alignItems: 'center', gap: 8,
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: fonts.sans, fontSize: fontSize.xs, fontWeight: 700, letterSpacing: '1.5px', textTransform: 'uppercase', color: selectedPlayerToDrop ? colors.danger : colors.textMuted, marginBottom: 3 }}>
                    Dropping
                  </div>
                  <div style={{ fontFamily: fonts.sans, fontSize: fontSize.base, color: selectedPlayerToDrop ? colors.danger : colors.textMuted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {selectedPlayerToDrop ? selectedPlayerToDrop.name : '← tap a player'}
                  </div>
                </div>
                {selectedPlayerToDrop && (
                  <button
                    onClick={() => setSelectedPlayerToDrop(null)}
                    title="Clear drop selection"
                    style={{
                      background: red(0.08),
                      border: `1px solid ${red(0.3)}`,
                      borderRadius: 6, width: 26, height: 26,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      cursor: 'pointer', color: red(0.8),
                      fontSize: fontSize.base, lineHeight: 1, fontWeight: 700, flexShrink: 0,
                    }}
                  >✕</button>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Body ── */}
        <div ref={bodyRef} className="sfgl-modal-scroll" style={{ flex: 1, overflowY: 'auto', padding: '14px 18px', minHeight: 0 }}>

          {/* ── Drop list — shown when add player is selected and roster full ── */}
          {needsDrop && (
            <div style={{ marginBottom: 16 }}>
              <div style={{
                fontFamily: fonts.sans,
                fontSize: fontSize.xs,
                fontWeight: 700,
                letterSpacing: '1.8px',
                textTransform: 'uppercase',
                color: colors.textMuted,
                marginBottom: 8,
              }}>
                Roster full — select a player to drop
              </div>
              {currentRoster.filter(player => !player.limited).map(player => {
                const isSelected     = selectedPlayerToDrop?.name === player.name;
                const inPendingDrop  = pendingDropNames.has(player.name);
                return (
                  <div
                    key={player.name}
                    {...activatable(
                      () => setSelectedPlayerToDrop(isSelected ? null : player),
                      { selected: isSelected, label: `Drop ${player.name}` },
                    )}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '12px 14px', marginBottom: 6, borderRadius: 6,
                      background: isSelected ? red(0.08) : white(0.02),
                      border: `1px solid ${isSelected ? red(0.35) : colors.borderSubtle}`,
                      cursor: 'pointer',
                      transition: 'all 0.15s',
                    }}
                    onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = red(0.04); }}
                    onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = white(0.02); }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <MinusCircle style={{
                        width: 15, height: 15, flexShrink: 0,
                        color: isSelected ? 'rgba(240,90,90,0.95)' : red(0.6),
                      }} />
                      <span style={{
                        fontFamily: fonts.sans, fontSize: fontSize.base,
                        color: isSelected ? colors.danger : colors.textPrimary,
                      }}>
                        {player.name}
                      </span>
                      {tournamentField?.has(player.name) && (
                        <span title="In this week's field" style={{ fontSize: fontSize.base, lineHeight: 1, flexShrink: 0 }}>⛳</span>
                      )}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                      {inPendingDrop && (
                        <span style={{
                          fontFamily: fonts.sans, fontSize: 9, fontWeight: 700,
                          letterSpacing: 0.6, textTransform: 'uppercase',
                          color: amber(0.85),
                          border: `1px solid ${amber(0.35)}`,
                          borderRadius: 6, padding: '2px 6px', flexShrink: 0,
                        }}>
                          in waiver
                        </span>
                      )}
                      {isSelected && (
                        <span style={{ fontFamily: fonts.sans, fontSize: fontSize.xs, fontWeight: 700, color: colors.danger, letterSpacing: 1, textTransform: 'uppercase' }}>
                          DROP
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* ── Confirm row (inline, when drop not needed or already done) ── */}
          {selectedPlayerToAdd && !needsDrop && (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '10px 14px', marginBottom: 16,
              background: white(0.02), border: `1px solid ${colors.borderSubtle}`, borderRadius: 6,
              fontFamily: fonts.sans, fontSize: fontSize.sm, color: colors.textSecondary,
            }}>
              <span>Fee: <span style={{ color: '#f5c518' }}>${fee.toLocaleString()}</span> · <span style={{ color: accentColor(isWaiverMode) }}>{isWaiverMode ? 'Waiver (pending)' : 'Immediate'}</span></span>
              <ConfirmBtn compact />
            </div>
          )}

          {/* ── Browse list ── */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <input
              type="text"
              placeholder="Player Search"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              autoFocus={!selectedPlayerToAdd}
              style={{
                flex: 1,
                minWidth: 0,
                padding: '10px 12px',
                background: white(0.02),
                border: `1px solid ${colors.borderSubtle}`,
                borderRadius: 6,
                color: colors.textPrimary,
                fontFamily: fonts.sans,
                fontSize: fontSize.lg, // prevent iOS zoom
                transition: 'background 0.15s, border-color 0.15s',
              }}
              onFocus={e => { e.target.style.borderColor = white(0.25); e.target.style.background = white(0.04); }}
              onBlur={e => { e.target.style.borderColor = colors.borderSubtle; e.target.style.background = white(0.02); }}
            />
            <FieldToggle value={fieldOnly} setter={setFieldOnly} disabled={!tournamentField?.size} />
          </div>

          {loadingPlayers ? (
            <p style={{ ...theme.smallText, textAlign: 'center', padding: '24px 0', color: colors.textMuted }}>Loading players…</p>
          ) : searching ? (
            <p style={{ ...theme.smallText, textAlign: 'center', padding: '24px 0', color: colors.textMuted }}>Searching…</p>
          ) : displayPlayers.length === 0 ? (
            <p style={{ ...theme.smallText, textAlign: 'center', padding: '24px 0' }}>
              {searchTerm.trim().length >= 2 ? 'No players found' : 'No free agents available'}
            </p>
          ) : (
            displayPlayers.slice(0, 50).map(player => {
              const isCurrentlySelected = selectedPlayerToAdd?.name === player.name;
              const isLimbo = limboPlayers.has(normalizePlayerName(player.name));
              const playerOwner = ownerMap.get(normalizePlayerName(player.name));
              const isRostered = !!playerOwner;
              return (
                <div
                  key={player.name}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '12px 14px', marginBottom: 6, borderRadius: 6,
                    background: isCurrentlySelected ? accentBg(isWaiverMode) : white(0.02),
                    border: `1px solid ${isCurrentlySelected ? accentBorder(isWaiverMode) : colors.borderSubtle}`,
                    transition: 'all 0.15s',
                    cursor: (isLimbo || isRostered || tournamentIsLocked) ? 'default' : 'pointer',
                  }}
                  {...activatable(() => selectPlayerToAdd(player), {
                    disabled: isLimbo || isRostered || tournamentIsLocked,
                    selected: isCurrentlySelected,
                    label: isRostered ? `${player.name} — unavailable, on ${playerOwner}` : `Add ${player.name}`,
                  })}
                  onMouseEnter={e => { if (!isCurrentlySelected && !isMobile && !isLimbo && !isRostered && !tournamentIsLocked) { e.currentTarget.style.background = white(0.04); } }}
                  onMouseLeave={e => { if (!isCurrentlySelected && !isMobile && !isLimbo && !isRostered && !tournamentIsLocked) { e.currentTarget.style.background = white(0.02); } }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <img
                      src={getPlayerHeadshot(player.name, mergedHeadshots)}
                      onError={makeHeadshotErrorHandler(player.name, mergedHeadshots)}
                      alt=""
                      style={{
                        width: 28, height: 28, borderRadius: '50%', objectFit: 'cover',
                        border: `1px solid ${colors.borderSubtle}`,
                        flexShrink: 0,
                      }}
                    />
                    <span style={{ fontFamily: fonts.sans, fontSize: fontSize.base, fontWeight: 500, color: isCurrentlySelected ? accentColor(isWaiverMode) : colors.textPrimary }}>
                      {player.name}
                    </span>
                    {tournamentField?.has(player.name) && (
                      <span title="In this week's field" style={{ fontSize: fontSize.base, lineHeight: 1, flexShrink: 0 }}>⛳</span>
                    )}
                    {player.worldRank && !isRostered && (
                      <span style={{ fontFamily: fonts.mono, fontSize: fontSize.xs, color: colors.textMuted, marginLeft: 4 }}>
                        #{player.worldRank}
                      </span>
                    )}
                    {isRostered && (
                      <span style={{ fontFamily: fonts.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.5px', color: colors.danger, textTransform: 'uppercase' }}>
                        Unavailable
                      </span>
                    )}
                  </div>
                  {isRostered ? (
                    <span style={{
                      fontFamily: fonts.sans, fontSize: fontSize.xs, fontWeight: 700,
                      padding: '5px 10px', borderRadius: 6,
                      letterSpacing: '0.5px',
                      background: white(0.04),
                      border: `1px solid ${white(0.12)}`,
                      color: colors.textSecondary,
                      flexShrink: 0,
                    }}>
                      {getTeamAbbreviation(playerOwner)}
                    </span>
                  ) : isLimbo ? (
                    <span style={{
                      fontFamily: fonts.sans, fontSize: fontSize.caption, fontWeight: 600,
                      padding: '5px 0', borderRadius: 6,
                      width: 96, textAlign: 'center', flexShrink: 0,
                      background: gold(0.08),
                      border: `1px solid ${gold(0.3)}`,
                      color: colors.textGold,
                      letterSpacing: '0.3px',
                      display: 'inline-block',
                    }}>
                      On Waivers
                    </span>
                  ) : tournamentIsLocked ? (
                    <span style={{
                      fontFamily: fonts.sans, fontSize: fontSize.caption, fontWeight: 600,
                      padding: '5px 0', borderRadius: 6,
                      width: 96, textAlign: 'center', flexShrink: 0,
                      background: white(0.03),
                      border: `1px solid ${colors.borderSubtle}`,
                      color: colors.textMuted,
                      letterSpacing: '0.3px',
                      display: 'inline-block',
                    }}>
                      Locked
                    </span>
                  ) : (
                    <button
                      onClick={e => { e.stopPropagation(); selectPlayerToAdd(player); }}
                      style={{
                        fontFamily: fonts.sans, fontSize: fontSize.caption, fontWeight: 600,
                        padding: '6px 0', borderRadius: 6, cursor: 'pointer',
                        width: 96, textAlign: 'center', flexShrink: 0,
                        transition: 'all 0.15s',
                        background: isCurrentlySelected ? green(0.2) : green(0.08),
                        border: `1px solid ${isCurrentlySelected ? green(0.6) : green(0.3)}`,
                        color: colors.earningsGreen,
                      }}
                    >
                      {isCurrentlySelected ? '✓ Selected' : 'Select'}
                    </button>
                  )}
                </div>
                );
            })
          )}
        </div>

        {/* ── Footer — only when drop needed and not yet selected ── */}
        {needsDrop && !selectedPlayerToDrop && (
          <div style={{
            padding: '10px 18px',
            borderTop: `1px solid ${colors.borderSubtle}`,
            background: red(0.04),
            flexShrink: 0,
            fontFamily: fonts.sans, fontSize: fontSize.caption, color: colors.danger,
            textAlign: 'center',
          }}>
            Select a player to drop above to continue
          </div>
        )}

        {/* ── Footer confirm — when drop is selected ── */}
        {needsDrop && selectedPlayerToDrop && (
          <div style={{
            padding: '10px 18px', borderTop: `1px solid ${colors.borderSubtle}`,
            background: red(0.04), flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            fontFamily: fonts.sans, fontSize: fontSize.caption,
          }}>
            <span style={{ color: colors.textSecondary }}>
              Fee: <span style={{ color: '#f5c518' }}>${fee.toLocaleString()}</span>
              {' · '}
              <span style={{ color: accentColor(isWaiverMode) }}>{isWaiverMode ? 'Waiver (pending)' : 'Immediate'}</span>
            </span>
            <ConfirmBtn compact />
          </div>
        )}
    </BottomSheet>
  );
};
