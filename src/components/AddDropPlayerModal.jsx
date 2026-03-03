import React, { useState, useEffect, useRef } from 'react';
import { X, MinusCircle } from 'lucide-react';
import { useDialog } from './DialogContext';
import { getSegmentByDate, isTournamentLocked, getTeamAbbreviation } from '../utils/index.js';
import { ROSTER_LIMIT, TRANSACTION_FEE_FREE_AGENT, TRANSACTION_FEE_WAIVER } from '../constants/index.js';
import { theme, colors, fonts } from '../theme.js';

const accentColor   = (waiver) => waiver ? colors.warning         : colors.success;
const accentBg      = (waiver) => waiver ? 'rgba(220,170,60,0.12)' : 'rgba(80,180,120,0.12)';
const accentBorder  = (waiver) => waiver ? 'rgba(220,170,60,0.35)' : 'rgba(80,180,120,0.35)';

// ── Headshot helpers ─────────────────────────────────────────────────────────
const getPlayerHeadshotUrls = (playerName, headshotMap = {}) => {
  const val = headshotMap[playerName];
  if (!val) return [];
  if (typeof val === 'string' && (val.startsWith('http') || val.startsWith('/'))) return [val];
  return [
    `https://pga-tour-res.cloudinary.com/image/upload/c_thumb,g_face,z_0.7,q_auto,f_auto,dpr_2.0,w_96,h_96,b_rgb:F2F2F2,d_stub:default_avatar_light.webp/headshots_${val}`,
    `https://res.cloudinary.com/pgatour-prod/image/upload/c_thumb,g_face,z_0.7,q_auto,f_auto,dpr_2.0,w_96,h_96/headshots_${val}.png`,
  ];
};

const getPlayerHeadshot = (playerName, headshotMap = {}) => {
  const urls = getPlayerHeadshotUrls(playerName, headshotMap);
  if (urls.length > 0) return urls[0];
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(playerName)}&background=1c3a5e&color=ffffff&size=96&bold=true&font-size=0.38`;
};

const makeHeadshotErrorHandler = (playerName, headshotMap) => {
  const urls = getPlayerHeadshotUrls(playerName, headshotMap);
  let attempt = 0;
  return function handler(e) {
    attempt++;
    if (attempt < urls.length) {
      e.target.src = urls[attempt];
      e.target.onerror = handler;
    } else {
      e.target.onerror = null;
      e.target.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(playerName)}&background=1c3a5e&color=ffffff&size=96&bold=true&font-size=0.38`;
    }
  };
};

export const AddDropPlayerModal = ({
  isOpen, onClose, team, currentRoster, allPlayers, teams,
  updateTeams, transactions, setTransactions, tournaments,
  isWaiverMode, activeTournamentIndex, nextTournamentIndex, txSegment, editingWaiverData,
  headshots,
}) => {
  const [searchTerm,           setSearchTerm]           = useState('');
  const [selectedPlayerToAdd,  setSelectedPlayerToAdd]  = useState(null);
  const [selectedPlayerToDrop, setSelectedPlayerToDrop] = useState(null);
  const [saving,               setSaving]               = useState(false);
  const bodyRef  = useRef(null);
  const dialog   = useDialog();

  // Pre-populate when editing an existing waiver claim
  useEffect(() => {
    if (editingWaiverData && isOpen) {
      const toAdd = allPlayers.find(p => p.name === editingWaiverData.player);
      if (toAdd) setSelectedPlayerToAdd(toAdd);
      if (editingWaiverData.droppedPlayer) {
        const toDrop = currentRoster.find(p => p.name === editingWaiverData.droppedPlayer);
        if (toDrop) setSelectedPlayerToDrop(toDrop);
      }
    }
  }, [editingWaiverData, isOpen, allPlayers, currentRoster]);

  // Scroll to top whenever drop selection changes (or add selection is made)
  useEffect(() => {
    if (selectedPlayerToDrop && bodyRef.current) {
      bodyRef.current.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [selectedPlayerToDrop]);

  if (!isOpen || !team) return null;

  // ── Available players ──────────────────────────────────────────────────────
  // Build the effective roster for EVERY team by replaying processed transactions,
  // matching the same logic as useRoster. This prevents players added via FA/waiver
  // (who live in transactions but not in team.roster) from appearing as available.
  const rosteredPlayers = new Set(
    teams.flatMap(t => {
      let roster = t.roster.map(p => p.name);
      const rosterSet = new Set(roster);
      transactions
        .filter(tx =>
          tx.team === t.name &&
          tx.type !== 'mulligan' &&
          (tx.status === 'processed' || tx.status === 'completed')
        )
        .forEach(tx => {
          if (tx.droppedPlayer) rosterSet.delete(tx.droppedPlayer);
          if (tx.player) rosterSet.add(tx.player);
        });
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

  const availablePlayers = allPlayers.filter(p => {
    if (!p.name || typeof p.name !== 'string') return false;
    if (/^\d+$/.test(p.name.trim())) return false;
    if (p.isLiv) return false;
    if (thisTeamPendingClaims.has(p.name)) return false;
    return true;
  });

  // Build ownership map: playerName → teamName
  const ownerMap = new Map();
  teams.forEach(t => {
    const rosterSet = new Set(t.roster.map(p => p.name));
    transactions
      .filter(tx => tx.team === t.name && tx.type !== 'mulligan' && (tx.status === 'processed' || tx.status === 'completed'))
      .forEach(tx => {
        if (tx.droppedPlayer) rosterSet.delete(tx.droppedPlayer);
        if (tx.player) rosterSet.add(tx.player);
      });
    rosterSet.forEach(name => ownerMap.set(name, t.name));
  });

  // Is the active tournament currently locked (Thu–Sun)?
  const activeTournament = tournaments?.find(t => t.playing && !t.completed);
  const tournamentIsLocked = isTournamentLocked(activeTournament);

  const filteredPlayers  = availablePlayers.filter(p =>
    p.name.toLowerCase().includes(searchTerm.toLowerCase()),
  );

  // When not searching, hide rostered players from the browse list so it starts
  // with the highest-ranked available free agent.  When searching by name, show
  // rostered players (greyed out with team badge) so the user can see who owns them.
  const displayPlayers = searchTerm.trim()
    ? filteredPlayers                                          // search: show all matches (rostered shown greyed)
    : filteredPlayers.filter(p => !rosteredPlayers.has(p.name) && !limboPlayers.has(p.name)); // browse: free agents only

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
      txId:            `${team.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
      pgaTourEarnings: 0, sfglEarnings: 0, headshot: '',
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
    setTransactions(newTransactions); // setTransactions IS updateTransactions — persists to Supabase + localStorage

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
        padding: compact ? '6px 14px' : '10px 20px',
        borderRadius: 3,
        border: `1px solid ${canConfirm ? accentBorder(isWaiverMode) : colors.borderSubtle}`,
        background: canConfirm
          ? (isWaiverMode ? 'rgba(220,170,60,0.18)' : 'rgba(80,180,120,0.18)')
          : 'rgba(255,255,255,0.04)',
        color: canConfirm ? accentColor(isWaiverMode) : colors.textMuted,
        cursor: canConfirm && !saving ? 'pointer' : 'not-allowed',
        transition: 'all 0.15s',
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
      zIndex: 50,
    }}>
      <div style={{
        background: '#0f1d35',
        border: `2px solid ${isWaiverMode ? colors.warning : colors.success}`,
        borderRadius: isMobile ? '12px 12px 0 0' : 4,
        width: '100%', maxWidth: isMobile ? '100%' : 480,
        height: isMobile ? '80vh' : 'auto',
        maxHeight: isMobile ? '80vh' : '82vh',
        display: 'flex', flexDirection: 'column',
      }}>

        {/* ── Header ── */}
        <div style={{
          padding: '14px 18px',
          background: `linear-gradient(90deg, ${accentBg(isWaiverMode)} 0%, transparent 100%)`,
          borderBottom: `1px solid ${colors.borderSubtle}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexShrink: 0, gap: 10,
        }}>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ fontFamily: fonts.serif, fontSize: 15, color: accentColor(isWaiverMode), margin: 0 }}>
              {isWaiverMode
                ? `⏰ Waiver Claim · $${TRANSACTION_FEE_WAIVER.toLocaleString()}`
                : `✅ Free Agent · $${TRANSACTION_FEE_FREE_AGENT.toLocaleString()}`}
            </h2>
            <p style={{ ...theme.smallText, marginTop: 2 }}>{team.name}</p>
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
              flex: 1, padding: '8px 12px',
              background: accentBg(isWaiverMode),
              border: `1px solid ${accentBorder(isWaiverMode)}`,
              borderRadius: 3,
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: fonts.sans, fontSize: 9, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: accentColor(isWaiverMode), marginBottom: 3 }}>
                  Adding
                </div>
                <div style={{ fontFamily: fonts.serif, fontSize: 13, color: colors.textPrimary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {selectedPlayerToAdd.name}
                </div>
              </div>
              <button
                onClick={() => { setSelectedPlayerToAdd(null); setSelectedPlayerToDrop(null); }}
                title="Remove selection"
                style={{
                  background: 'rgba(220,80,80,0.1)',
                  border: `1px solid rgba(220,80,80,0.3)`,
                  borderRadius: 3,
                  width: 26, height: 26,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: 'pointer',
                  color: 'rgba(230,90,90,0.8)',
                  fontSize: 13, lineHeight: 1, fontWeight: 700,
                  flexShrink: 0,
                  transition: 'all 0.15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(220,80,80,0.25)'; e.currentTarget.style.borderColor = 'rgba(220,80,80,0.5)'; e.currentTarget.style.color = 'rgba(240,100,100,1)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'rgba(220,80,80,0.1)'; e.currentTarget.style.borderColor = 'rgba(220,80,80,0.3)'; e.currentTarget.style.color = 'rgba(230,90,90,0.8)'; }}
              >
                ✕
              </button>
            </div>

            {/* Drop tile — shows placeholder or selected player */}
            {rosterFull && (
              <div style={{
                flex: 1, padding: '8px 12px',
                background: selectedPlayerToDrop ? colors.dangerBg : 'rgba(255,255,255,0.02)',
                border: `1px solid ${selectedPlayerToDrop ? colors.dangerBorder : 'rgba(255,255,255,0.06)'}`,
                borderRadius: 3,
                display: 'flex', flexDirection: 'column', justifyContent: 'center',
              }}>
                <div style={{ fontFamily: fonts.sans, fontSize: 9, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: selectedPlayerToDrop ? colors.danger : colors.textMuted, marginBottom: 3 }}>
                  Dropping
                </div>
                <div style={{ fontFamily: fonts.serif, fontSize: 13, color: selectedPlayerToDrop ? colors.danger : colors.textMuted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {selectedPlayerToDrop ? selectedPlayerToDrop.name : '← tap a player'}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Body ── */}
        <div ref={bodyRef} style={{ flex: 1, overflowY: 'auto', padding: '14px 18px', minHeight: 0 }}>

          {/* ── Drop list — shown when add player is selected and roster full ── */}
          {needsDrop && (
            <div style={{ marginBottom: 16 }}>
              <p style={{ ...theme.smallText, marginBottom: 8, color: colors.textSecondary }}>
                Roster full · select a player to drop
              </p>
              {currentRoster.filter(player => !player.limited).map(player => {
                const isSelected     = selectedPlayerToDrop?.name === player.name;
                const inPendingDrop  = pendingDropNames.has(player.name);
                return (
                  <div
                    key={player.name}
                    onClick={() => setSelectedPlayerToDrop(isSelected ? null : player)}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '9px 12px', marginBottom: 6, borderRadius: 3,
                      background: isSelected ? colors.dangerBg : 'rgba(255,255,255,0.03)',
                      border: `1px solid ${isSelected ? colors.dangerBorder : colors.borderSubtle}`,
                      cursor: 'pointer',
                      transition: 'all 0.15s',
                    }}
                    onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'rgba(180,60,60,0.08)'; }}
                    onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <MinusCircle style={{
                        width: 15, height: 15, flexShrink: 0,
                        color: isSelected ? 'rgba(240,90,90,0.95)' : 'rgba(230,85,85,0.65)',
                      }} />
                      <span style={{
                        fontFamily: fonts.serif, fontSize: 13,
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
                          borderRadius: 2, padding: '2px 5px', flexShrink: 0,
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
              background: colors.cardBg, border: `1px solid ${colors.borderSubtle}`, borderRadius: 3,
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
            style={{ ...theme.input, marginBottom: 12, fontSize: 16 }}
            onFocus={e => { e.target.style.borderColor = colors.borderFocus; e.target.style.background = colors.inputBgFocus; }}
            onBlur={e => { e.target.style.borderColor = colors.borderInput; e.target.style.background = colors.inputBg; }}
          />

          {displayPlayers.length === 0 ? (
            <p style={{ ...theme.smallText, textAlign: 'center', padding: '24px 0' }}>No players found</p>
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
                    padding: '9px 12px', marginBottom: 6, borderRadius: 3,
                    background: isCurrentlySelected ? accentBg(isWaiverMode) : colors.cardBg,
                    border: `1px solid ${isCurrentlySelected ? accentBorder(isWaiverMode) : colors.borderSubtle}`,
                    transition: 'all 0.15s',
                    cursor: (isLimbo || isRostered || tournamentIsLocked) ? 'default' : 'pointer',
                  }}
                  onClick={() => { if (!isLimbo && !isRostered && !tournamentIsLocked) selectPlayerToAdd(player); }}
                  onMouseEnter={e => { if (!isCurrentlySelected && !isMobile && !isLimbo && !isRostered && !tournamentIsLocked) { e.currentTarget.style.background = colors.cardBgHover; e.currentTarget.style.borderColor = colors.borderInput; } }}
                  onMouseLeave={e => { if (!isCurrentlySelected && !isMobile && !isLimbo && !isRostered && !tournamentIsLocked) { e.currentTarget.style.background = colors.cardBg; e.currentTarget.style.borderColor = colors.borderSubtle; } }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <img
                      src={getPlayerHeadshot(player.name, headshots)}
                      onError={makeHeadshotErrorHandler(player.name, headshots)}
                      alt=""
                      style={{
                        width: 28, height: 28, borderRadius: '50%', objectFit: 'cover',
                        border: `1px solid ${colors.borderSubtle}`,
                        flexShrink: 0,
                      }}
                    />
                    <span style={{ fontFamily: fonts.serif, fontSize: 13, color: isCurrentlySelected ? accentColor(isWaiverMode) : colors.textPrimary }}>
                      {player.name}
                    </span>
                    {isRostered && (
                      <span style={{ fontFamily: fonts.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.5px', color: colors.danger, textTransform: 'uppercase' }}>
                        Unavailable
                      </span>
                    )}
                  </div>
                  {isRostered ? (
                    <span style={{
                      fontFamily: fonts.sans, fontSize: 10, fontWeight: 700,
                      padding: '4px 8px', borderRadius: 3,
                      letterSpacing: '0.5px',
                      background: 'rgba(255,255,255,0.06)',
                      border: '1px solid rgba(255,255,255,0.12)',
                      color: colors.textSecondary,
                      flexShrink: 0,
                    }}>
                      {getTeamAbbreviation(playerOwner)}
                    </span>
                  ) : isLimbo ? (
                    <span style={{
                      fontFamily: fonts.sans, fontSize: 11, fontWeight: 600,
                      padding: '5px 0', borderRadius: 3,
                      width: 90, textAlign: 'center', flexShrink: 0,
                      background: 'rgba(245,197,24,0.1)',
                      border: '1px solid rgba(245,197,24,0.35)',
                      color: colors.textGold,
                      letterSpacing: '0.3px',
                      display: 'inline-block',
                    }}>
                      On Waivers
                    </span>
                  ) : tournamentIsLocked ? (
                    <span style={{
                      fontFamily: fonts.sans, fontSize: 11, fontWeight: 600,
                      padding: '5px 0', borderRadius: 3,
                      width: 90, textAlign: 'center', flexShrink: 0,
                      background: 'rgba(255,255,255,0.04)',
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
                        padding: '5px 0', borderRadius: 3, cursor: 'pointer',
                        width: 90, textAlign: 'center', flexShrink: 0,
                        transition: 'all 0.15s',
                        background: isCurrentlySelected ? 'rgba(80,180,120,0.2)' : 'rgba(80,180,120,0.1)',
                        border: `1px solid ${isCurrentlySelected ? 'rgba(80,180,120,0.6)' : 'rgba(80,180,120,0.3)'}`,
                        color: colors.success,
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
            background: 'rgba(180,60,60,0.06)',
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
            background: 'rgba(180,60,60,0.06)', flexShrink: 0,
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
