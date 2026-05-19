import React, { useState, useEffect, useRef, useMemo } from 'react';
import { X, MinusCircle } from 'lucide-react';
import { useDialog } from './DialogContext';
import { getSegmentByDate, isTournamentLocked, getTeamAbbreviation } from '../utils/index.js';
// ROSTER_LIMIT and fees now come from leagueSettings prop
import { playersApi } from '../api/firebase';
import { sendManagerPush } from '../api/pushNotifications';
import { theme, colors, fonts } from '../theme.js';
import { LIV_GOLF_ROSTER } from '../constants';
import { useModalBehavior } from '../utils/modalUtils';

// Use shared LIV roster from constants instead of local duplicate
const LIV_PLAYERS = new Set(LIV_GOLF_ROSTER);

const accentColor   = (waiver) => waiver ? colors.warning              : colors.earningsGreen;
const accentBg      = (waiver) => waiver ? 'rgba(220,170,60,0.08)'      : 'rgba(80,195,120,0.08)';
const accentBorder  = (waiver) => waiver ? 'rgba(220,170,60,0.35)'      : 'rgba(80,195,120,0.35)';

// ── Headshot helpers (shared — single source of truth in headshotUtils.js) ──
import {
  getPlayerHeadshot,
  makeHeadshotErrorHandler,
} from '../utils/headshotUtils';

export const AddDropPlayerModal = ({
  isOpen, onClose, team, currentRoster, teams,
  updateTeams, transactions, setTransactions, tournaments,
  isWaiverMode, activeTournamentIndex, nextTournamentIndex, txSegment, editingWaiverData,
  headshots, fieldPlayerIds = {}, leagueSettings = {}, onHeadshotsFound,
}) => {
  const ROSTER_LIMIT            = leagueSettings.rosterLimit ?? 13;
  const TRANSACTION_FEE_FREE_AGENT = leagueSettings.feeFA    ?? 1;
  const TRANSACTION_FEE_WAIVER  = leagueSettings.feeWaiver   ?? 2;
  const [searchTerm,           setSearchTerm]           = useState('');
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

  // Load top 50 free agents when modal opens
  useEffect(() => {
    if (!isOpen) return;
    setLoadingPlayers(true);
    playersApi.getTopRanked(100)
      .then(players => setTopPlayers(players))
      .catch(() => setTopPlayers([]))
      .finally(() => setLoadingPlayers(false));
  }, [isOpen]);

  // ── Escape key + body scroll lock (shared) ─────────────────────────────────
  useModalBehavior(isOpen, onClose);

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
        setLocalHeadshots(prev => ({ ...prev, ...data.results }));
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
            .then(data => { if (data?.results) { setLocalHeadshots(prev => ({ ...prev, ...data.results })); onHeadshotsFound?.(data.results); } })
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
  // Build the effective roster for EVERY team by replaying processed transactions,
  // matching the same logic as useRoster. This prevents players added via FA/waiver
  // (who live in transactions but not in team.roster) from appearing as available.
  //
  // Skips:
  //   • mulligan — restores a previously-dropped player; the original add/drop
  //     pair already accounts for the roster movement.
  //   • swing_winner — tx.player on these is the manager's owner name (used
  //     for "Jensen won the pot" display copy), NOT an actual golfer.
  const rosteredPlayers = new Set(
    teams.flatMap(t => {
      let roster = (t.roster || []).map(p => p.name);
      const rosterSet = new Set(roster);
      transactions
        .filter(tx =>
          tx.team === t.name &&
          tx.type !== 'mulligan' &&
          tx.type !== 'swing_winner' &&
          (tx.status === 'processed' || tx.status === 'completed')
        )
        .forEach(tx => {
          if (tx.droppedPlayer) rosterSet.delete(tx.droppedPlayer);
          if (tx.player) rosterSet.add(tx.player);
        });
      // Defensive: drop any phantom entry matching the team's own owner
      // (historic swing_winner pollution before the type filter was added).
      if (t.owner) rosterSet.delete(t.owner);
      return [...rosterSet];
    })
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
      .map(tx => tx.droppedPlayer)
  );

  // Hide players this team already has a pending waiver claim for
  const thisTeamPendingClaims = new Set(
    transactions
      .filter(tx => tx.status === 'pending' && tx.type === 'waiver' && tx.team === team.name && tx.player)
      .map(tx => tx.player)
  );

  // Use search results when searching, otherwise top 50 free agents
  const playerPool = searchTerm.trim().length >= 2 ? searchResults : topPlayers;
  const availablePlayers = playerPool.filter(p => {
    if (!p.name || typeof p.name !== 'string') return false;
    if (p.isLiv || LIV_PLAYERS.has(p.name)) return false;
    if (thisTeamPendingClaims.has(p.name)) return false;
    return true;
  });

  // Build ownership map: playerName → teamName
  const ownerMap = new Map();
  teams.forEach(t => {
    const rosterSet = new Set((t.roster || []).map(p => p.name));
    transactions
      .filter(tx => tx.team === t.name && tx.type !== 'mulligan' && (tx.status === 'processed' || tx.status === 'completed'))
      .forEach(tx => {
        if (tx.droppedPlayer) rosterSet.delete(tx.droppedPlayer);
        if (tx.player) rosterSet.add(tx.player);
      });
    rosterSet.forEach(name => ownerMap.set(name, t.name));
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
        .filter(p => !rosteredPlayers.has(p.name) && !limboPlayers.has(p.name))
        .sort((a, b) => (a.worldRank ?? 9999) - (b.worldRank ?? 9999));

  const rosterFull   = currentRoster.length >= ROSTER_LIMIT;

  // Players already listed as the drop in another pending waiver for this team
  const pendingDropNames = new Set(
    transactions
      .filter(tx => tx.team === team.name && tx.type === 'waiver' && tx.status === 'pending' && tx.droppedPlayer)
      .map(tx => tx.droppedPlayer)
  );
  const needsDrop    = rosterFull && selectedPlayerToAdd;
  const canConfirm   = selectedPlayerToAdd && (!rosterFull || selectedPlayerToDrop);
  const fee          = isWaiverMode ? TRANSACTION_FEE_WAIVER : TRANSACTION_FEE_FREE_AGENT;

  // ── Confirm & persist ──────────────────────────────────────────────────────
  const handleConfirm = async () => {
    if (!canConfirm) return;
    setSaving(true);

    const newTx = {
      team:            team.name,
      type:            isWaiverMode ? 'waiver' : 'free agent',
      player:          selectedPlayerToAdd.name,
      droppedPlayer:   selectedPlayerToDrop?.name || null,
      fee,
      segment:         txSegment || getSegmentByDate(),
      date:            new Date().toLocaleDateString(),
      // fa/waiver tag the NEXT upcoming event (the one players will play in)
      tournamentIndex: nextTournamentIndex ?? activeTournamentIndex,
      status:          isWaiverMode ? 'pending' : 'processed',
      priority: isWaiverMode
        ? (transactions.filter(tx => tx.team === team.name && tx.type === 'waiver' && tx.status === 'pending').length + 1)
        : undefined,
      timestamp: Date.now(),
    };

    const newPlayer = {
      name: selectedPlayerToAdd.name,
      limited: false, unlimited: false, stars: 0,
      starts: 0, eventsPlayed: 0, cutsMade: 0,
      pgaTourEarnings: 0, sfglEarnings: 0,
    };

    const updatedTeams = teams.map(t => {
      if (t.id !== team.id) return t;
      let newRoster = [...t.roster];
      if (!isWaiverMode) {
        if (selectedPlayerToDrop) newRoster = newRoster.filter(p => p.name !== selectedPlayerToDrop.name);
        if (!newRoster.some(p => p.name === newPlayer.name)) newRoster.push(newPlayer);
      }
      return { ...t, roster: newRoster, transactionFees: (t.transactionFees || 0) + fee };
    });

    const newTransactions = [newTx, ...transactions];
    updateTeams(updatedTeams);
    setTransactions(newTransactions); // setTransactions IS updateTransactions — persists to Firebase + localStorage

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
    if (!isWaiverMode) {
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
      `${isWaiverMode ? 'Waiver claim submitted' : `Added ${selectedPlayerToAdd.name}`}${selectedPlayerToDrop ? ` / Dropped ${selectedPlayerToDrop.name}` : ''}`,
      'success',
    );
    reset();
  };

  const reset = () => {
    setSelectedPlayerToAdd(null);
    setSelectedPlayerToDrop(null);
    setSearchTerm('');
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
          ? (isWaiverMode ? 'rgba(220,170,60,0.45)' : 'rgba(80,195,120,0.45)')
          : colors.borderSubtle}`,
        background: canConfirm
          ? (isWaiverMode ? 'rgba(220,170,60,0.14)' : 'rgba(80,195,120,0.14)')
          : 'rgba(255,255,255,0.03)',
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
    <div style={{
      position: 'fixed', inset: 0,
      background: 'rgba(5,10,25,0.85)', backdropFilter: 'blur(4px)',
      display: 'flex',
      alignItems: isMobile ? 'flex-end' : 'center',
      justifyContent: 'center',
      padding: isMobile ? 0 : 16,
      zIndex: 60,
    }}>
      <div style={{
        background: '#0f1d35',
        border: `1px solid ${colors.borderSubtle}`,
        // Mode accent lives as a thin top stripe instead of a heavy 2px
        // border all the way around — same indicator, lighter chrome.
        borderTop: `2px solid ${isWaiverMode ? colors.warning : colors.success}`,
        borderRadius: isMobile ? '12px 12px 0 0' : 10,
        width: '100%', maxWidth: isMobile ? '100%' : 480,
        height: isMobile ? '90vh' : 'auto',
        maxHeight: isMobile ? '90vh' : '82vh',
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      }}>

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
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '1.8px',
              textTransform: 'uppercase',
              color: accentColor(isWaiverMode),
            }}>
              {isWaiverMode ? '⏰ Waiver Claim' : '✅ Free Agent'}
            </div>
            <div style={{
              fontFamily: fonts.sans,
              fontSize: 13,
              fontWeight: 600,
              color: colors.textPrimary,
              marginTop: 2,
            }}>
              {team.name}
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
              background: 'rgba(80,195,120,0.08)',
              border: '1px solid rgba(80,195,120,0.3)',
              borderRadius: 6,
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: fonts.sans, fontSize: 10, fontWeight: 700, letterSpacing: '1.5px', textTransform: 'uppercase', color: colors.success, marginBottom: 3 }}>
                  Adding
                </div>
                <div style={{ fontFamily: fonts.sans, fontSize: 13, color: colors.textPrimary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {selectedPlayerToAdd.name}
                </div>
              </div>
              <button
                onClick={() => { setSelectedPlayerToAdd(null); setSelectedPlayerToDrop(null); }}
                title="Remove selection"
                style={{
                  background: 'rgba(220,80,80,0.08)',
                  border: `1px solid rgba(220,80,80,0.3)`,
                  borderRadius: 6,
                  width: 26, height: 26,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: 'pointer',
                  color: 'rgba(230,90,90,0.8)',
                  fontSize: 13, lineHeight: 1, fontWeight: 700,
                  flexShrink: 0,
                  transition: 'all 0.15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(220,80,80,0.18)'; e.currentTarget.style.borderColor = 'rgba(220,80,80,0.5)'; e.currentTarget.style.color = 'rgba(240,100,100,1)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'rgba(220,80,80,0.08)'; e.currentTarget.style.borderColor = 'rgba(220,80,80,0.3)'; e.currentTarget.style.color = 'rgba(230,90,90,0.8)'; }}
              >
                ✕
              </button>
            </div>

            {/* Drop tile — shows placeholder or selected player */}
            {rosterFull && (
              <div style={{
                flex: 1, padding: '10px 12px',
                background: selectedPlayerToDrop ? 'rgba(220,80,80,0.06)' : 'rgba(255,255,255,0.02)',
                border: `1px solid ${selectedPlayerToDrop ? 'rgba(220,80,80,0.3)' : colors.borderSubtle}`,
                borderRadius: 6,
                display: 'flex', alignItems: 'center', gap: 8,
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: fonts.sans, fontSize: 10, fontWeight: 700, letterSpacing: '1.5px', textTransform: 'uppercase', color: selectedPlayerToDrop ? colors.danger : colors.textMuted, marginBottom: 3 }}>
                    Dropping
                  </div>
                  <div style={{ fontFamily: fonts.sans, fontSize: 13, color: selectedPlayerToDrop ? colors.danger : colors.textMuted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {selectedPlayerToDrop ? selectedPlayerToDrop.name : '← tap a player'}
                  </div>
                </div>
                {selectedPlayerToDrop && (
                  <button
                    onClick={() => setSelectedPlayerToDrop(null)}
                    title="Clear drop selection"
                    style={{
                      background: 'rgba(220,80,80,0.08)',
                      border: '1px solid rgba(220,80,80,0.3)',
                      borderRadius: 6, width: 26, height: 26,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      cursor: 'pointer', color: 'rgba(230,90,90,0.8)',
                      fontSize: 13, lineHeight: 1, fontWeight: 700, flexShrink: 0,
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
                fontSize: 10,
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
                    onClick={() => setSelectedPlayerToDrop(isSelected ? null : player)}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '12px 14px', marginBottom: 6, borderRadius: 6,
                      background: isSelected ? 'rgba(220,80,80,0.08)' : 'rgba(255,255,255,0.02)',
                      border: `1px solid ${isSelected ? 'rgba(220,80,80,0.35)' : colors.borderSubtle}`,
                      cursor: 'pointer',
                      transition: 'all 0.15s',
                    }}
                    onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'rgba(220,80,80,0.04)'; }}
                    onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'rgba(255,255,255,0.02)'; }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <MinusCircle style={{
                        width: 15, height: 15, flexShrink: 0,
                        color: isSelected ? 'rgba(240,90,90,0.95)' : 'rgba(230,85,85,0.6)',
                      }} />
                      <span style={{
                        fontFamily: fonts.sans, fontSize: 13,
                        color: isSelected ? colors.danger : colors.textPrimary,
                      }}>
                        {player.name}
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                      {inPendingDrop && (
                        <span style={{
                          fontFamily: fonts.sans, fontSize: 9, fontWeight: 700,
                          letterSpacing: 0.6, textTransform: 'uppercase',
                          color: 'rgba(220,170,60,0.85)',
                          border: '1px solid rgba(220,170,60,0.35)',
                          borderRadius: 6, padding: '2px 6px', flexShrink: 0,
                        }}>
                          in waiver
                        </span>
                      )}
                      {isSelected && (
                        <span style={{ fontFamily: fonts.sans, fontSize: 10, fontWeight: 700, color: colors.danger, letterSpacing: 1, textTransform: 'uppercase' }}>
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
              background: 'rgba(255,255,255,0.02)', border: `1px solid ${colors.borderSubtle}`, borderRadius: 6,
              fontFamily: fonts.sans, fontSize: 12, color: colors.textSecondary,
            }}>
              <span>Fee: <span style={{ color: '#f5c518' }}>${fee.toLocaleString()}</span> · <span style={{ color: accentColor(isWaiverMode) }}>{isWaiverMode ? 'Waiver (pending)' : 'Immediate'}</span></span>
              <ConfirmBtn compact />
            </div>
          )}

          {/* ── Browse list ── */}
          <input
            type="text"
            placeholder="Search by name…"
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            autoFocus={!selectedPlayerToAdd}
            style={{
              width: '100%',
              padding: '10px 12px',
              background: 'rgba(255,255,255,0.02)',
              border: `1px solid ${colors.borderSubtle}`,
              borderRadius: 6,
              color: colors.textPrimary,
              fontFamily: fonts.sans,
              fontSize: 16, // prevent iOS zoom
              marginBottom: 12,
              outline: 'none',
              transition: 'background 0.15s, border-color 0.15s',
            }}
            onFocus={e => { e.target.style.borderColor = 'rgba(255,255,255,0.25)'; e.target.style.background = 'rgba(255,255,255,0.04)'; }}
            onBlur={e => { e.target.style.borderColor = colors.borderSubtle; e.target.style.background = 'rgba(255,255,255,0.02)'; }}
          />

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
              const isLimbo = limboPlayers.has(player.name);
              const playerOwner = ownerMap.get(player.name);
              const isRostered = !!playerOwner;
              return (
                <div
                  key={player.name}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '12px 14px', marginBottom: 6, borderRadius: 6,
                    background: isCurrentlySelected ? accentBg(isWaiverMode) : 'rgba(255,255,255,0.02)',
                    border: `1px solid ${isCurrentlySelected ? accentBorder(isWaiverMode) : colors.borderSubtle}`,
                    transition: 'all 0.15s',
                    cursor: (isLimbo || isRostered || tournamentIsLocked) ? 'default' : 'pointer',
                  }}
                  onClick={() => { if (!isLimbo && !isRostered && !tournamentIsLocked) selectPlayerToAdd(player); }}
                  onMouseEnter={e => { if (!isCurrentlySelected && !isMobile && !isLimbo && !isRostered && !tournamentIsLocked) { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; } }}
                  onMouseLeave={e => { if (!isCurrentlySelected && !isMobile && !isLimbo && !isRostered && !tournamentIsLocked) { e.currentTarget.style.background = 'rgba(255,255,255,0.02)'; } }}
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
                    <span style={{ fontFamily: fonts.sans, fontSize: 13, fontWeight: 500, color: isCurrentlySelected ? accentColor(isWaiverMode) : colors.textPrimary }}>
                      {player.name}
                    </span>
                    {player.worldRank && !isRostered && (
                      <span style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.textMuted, marginLeft: 4 }}>
                        #{player.worldRank}
                      </span>
                    )}
                    {isRostered && (
                      <span style={{ fontFamily: fonts.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.5px', color: colors.danger, textTransform: 'uppercase' }}>
                        Unavailable
                      </span>
                    )}
                    {isLimbo && !isRostered && (
                      // Mirror the rostered "Unavailable" inline indicator so
                      // limbo players (recently-dropped, on-waivers state)
                      // are visually unmistakable in search results. The
                      // right-side "On Waivers" badge already exists, but the
                      // inline tag matches the rostered treatment for
                      // visual rhythm — a glance at the row is enough to
                      // know the player can't be selected without having to
                      // notice the right-side badge.
                      <span style={{ fontFamily: fonts.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.5px', color: colors.textGold, textTransform: 'uppercase' }}>
                        Unavailable
                      </span>
                    )}
                  </div>
                  {isRostered ? (
                    <span style={{
                      fontFamily: fonts.sans, fontSize: 10, fontWeight: 700,
                      padding: '5px 10px', borderRadius: 6,
                      letterSpacing: '0.5px',
                      background: 'rgba(255,255,255,0.04)',
                      border: '1px solid rgba(255,255,255,0.12)',
                      color: colors.textSecondary,
                      flexShrink: 0,
                    }}>
                      {getTeamAbbreviation(playerOwner)}
                    </span>
                  ) : isLimbo ? (
                    <span style={{
                      fontFamily: fonts.sans, fontSize: 11, fontWeight: 600,
                      padding: '5px 0', borderRadius: 6,
                      width: 96, textAlign: 'center', flexShrink: 0,
                      background: 'rgba(245,197,24,0.08)',
                      border: '1px solid rgba(245,197,24,0.3)',
                      color: colors.textGold,
                      letterSpacing: '0.3px',
                      display: 'inline-block',
                    }}>
                      On Waivers
                    </span>
                  ) : tournamentIsLocked ? (
                    <span style={{
                      fontFamily: fonts.sans, fontSize: 11, fontWeight: 600,
                      padding: '5px 0', borderRadius: 6,
                      width: 96, textAlign: 'center', flexShrink: 0,
                      background: 'rgba(255,255,255,0.03)',
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
                        fontFamily: fonts.sans, fontSize: 11, fontWeight: 600,
                        padding: '6px 0', borderRadius: 6, cursor: 'pointer',
                        width: 96, textAlign: 'center', flexShrink: 0,
                        transition: 'all 0.15s',
                        background: isCurrentlySelected ? 'rgba(80,195,120,0.2)' : 'rgba(80,195,120,0.08)',
                        border: `1px solid ${isCurrentlySelected ? 'rgba(80,195,120,0.6)' : 'rgba(80,195,120,0.3)'}`,
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
            background: 'rgba(220,80,80,0.04)',
            flexShrink: 0,
            fontFamily: fonts.sans, fontSize: 11, color: colors.danger,
            textAlign: 'center',
          }}>
            Select a player to drop above to continue
          </div>
        )}

        {/* ── Footer confirm — when drop is selected ── */}
        {needsDrop && selectedPlayerToDrop && (
          <div style={{
            padding: '10px 18px', borderTop: `1px solid ${colors.borderSubtle}`,
            background: 'rgba(220,80,80,0.04)', flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            fontFamily: fonts.sans, fontSize: 11,
          }}>
            <span style={{ color: colors.textSecondary }}>
              Fee: <span style={{ color: '#f5c518' }}>${fee.toLocaleString()}</span>
              {' · '}
              <span style={{ color: accentColor(isWaiverMode) }}>{isWaiverMode ? 'Waiver (pending)' : 'Immediate'}</span>
            </span>
            <ConfirmBtn compact />
          </div>
        )}
      </div>
    </div>
  );
};
