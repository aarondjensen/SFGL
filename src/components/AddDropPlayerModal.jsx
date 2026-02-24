import React, { useState, useEffect, useRef } from 'react';
import { X, Trash2 } from 'lucide-react';
import { useDialog } from './DialogContext';
import { getSegmentByDate } from '../utils/index.js';
import { ROSTER_LIMIT, TRANSACTION_FEE_FREE_AGENT, TRANSACTION_FEE_WAIVER } from '../constants/index.js';
import { theme, colors, fonts } from '../theme.js';
import { storage } from '../api';
import { STORAGE_KEYS } from '../constants/index.js';

const accentColor   = (waiver) => waiver ? colors.warning         : colors.success;
const accentBg      = (waiver) => waiver ? 'rgba(220,170,60,0.12)' : 'rgba(80,180,120,0.12)';
const accentBorder  = (waiver) => waiver ? 'rgba(220,170,60,0.35)' : 'rgba(80,180,120,0.35)';

export const AddDropPlayerModal = ({
  isOpen, onClose, team, currentRoster, allPlayers, teams,
  updateTeams, transactions, setTransactions,
  isWaiverMode, activeTournamentIndex, nextTournamentIndex, editingWaiverData,
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
  const rosteredPlayers = new Set();
  teams.forEach(t => {
    let effective = t.roster.map(p => p.name);
    transactions.filter(tx => tx.status !== 'pending').forEach(tx => {
      if (tx.droppedPlayer) effective = effective.filter(n => n !== tx.droppedPlayer);
      if (tx.player && !effective.includes(tx.player)) effective.push(tx.player);
    });
    effective.forEach(name => rosteredPlayers.add(name));
  });
  transactions
    .filter(tx => tx.status === 'pending' && tx.player)
    .forEach(tx => rosteredPlayers.add(tx.player));

  const availablePlayers = allPlayers.filter(p => !rosteredPlayers.has(p.name));
  const filteredPlayers  = availablePlayers.filter(p =>
    p.name.toLowerCase().includes(searchTerm.toLowerCase()),
  );

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
      segment:         getSegmentByDate(),
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
    setTransactions(newTransactions);
    await storage.set(STORAGE_KEYS.TEAMS, updatedTeams);
    await storage.set(STORAGE_KEYS.TRANSACTIONS, newTransactions);

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
            }}>
              <div style={{ fontFamily: fonts.sans, fontSize: 9, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: accentColor(isWaiverMode), marginBottom: 3 }}>
                Adding
              </div>
              <div style={{ fontFamily: fonts.serif, fontSize: 13, color: colors.textPrimary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {selectedPlayerToAdd.name}
              </div>
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
                Roster full · select a player to drop (Limited players cannot be dropped)
              </p>
              {currentRoster.map(player => {
                const isSelected     = selectedPlayerToDrop?.name === player.name;
                const canDrop        = !player.limited;
                const inPendingDrop  = pendingDropNames.has(player.name);
                return (
                  <div
                    key={player.name}
                    onClick={() => canDrop && setSelectedPlayerToDrop(isSelected ? null : player)}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '9px 12px', marginBottom: 6, borderRadius: 3,
                      background: isSelected ? colors.dangerBg : 'rgba(255,255,255,0.03)',
                      border: `1px solid ${isSelected ? colors.dangerBorder : colors.borderSubtle}`,
                      cursor: canDrop ? 'pointer' : 'not-allowed',
                      opacity: canDrop ? 1 : 0.4,
                      transition: 'all 0.15s',
                    }}
                    onMouseEnter={e => { if (canDrop && !isSelected) e.currentTarget.style.background = 'rgba(180,60,60,0.08)'; }}
                    onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {/* Limited badge or drop icon */}
                      {player.limited ? (
                        <span style={{
                          fontFamily: fonts.sans, fontSize: 9, fontWeight: 700,
                          letterSpacing: 0.8, textTransform: 'uppercase',
                          color: 'rgba(245,197,24,0.75)',
                          border: '1px solid rgba(245,197,24,0.3)',
                          borderRadius: 2, padding: '2px 5px',
                          flexShrink: 0,
                        }}>
                          LTD
                        </span>
                      ) : (
                        <Trash2 style={{
                          width: 14, height: 14, flexShrink: 0,
                          color: isSelected ? colors.danger : 'rgba(220,80,80,0.55)',
                        }} />
                      )}
                      <span style={{
                        fontFamily: fonts.serif, fontSize: 13,
                        color: isSelected ? colors.danger : (player.limited ? colors.textGold : colors.textPrimary),
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
            style={{ ...theme.input, marginBottom: 12 }}
            onFocus={e => { e.target.style.borderColor = colors.borderFocus; e.target.style.background = colors.inputBgFocus; }}
            onBlur={e => { e.target.style.borderColor = colors.borderInput; e.target.style.background = colors.inputBg; }}
          />

          {filteredPlayers.length === 0 ? (
            <p style={{ ...theme.smallText, textAlign: 'center', padding: '24px 0' }}>No available players found</p>
          ) : (
            filteredPlayers.slice(0, 50).map(player => {
              const isCurrentlySelected = selectedPlayerToAdd?.name === player.name;
              return (
                <div
                  key={player.name}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '9px 12px', marginBottom: 6, borderRadius: 3,
                    background: isCurrentlySelected ? accentBg(isWaiverMode) : colors.cardBg,
                    border: `1px solid ${isCurrentlySelected ? accentBorder(isWaiverMode) : colors.borderSubtle}`,
                    transition: 'all 0.15s',
                  }}
                  onClick={() => selectPlayerToAdd(player)}
                  onMouseEnter={e => { if (!isCurrentlySelected && !isMobile) { e.currentTarget.style.background = colors.cardBgHover; e.currentTarget.style.borderColor = colors.borderInput; } }}
                  onMouseLeave={e => { if (!isCurrentlySelected && !isMobile) { e.currentTarget.style.background = colors.cardBg; e.currentTarget.style.borderColor = colors.borderSubtle; } }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{
                      width: 28, height: 28, borderRadius: '50%',
                      background: colors.buttonNavy, border: `1px solid ${colors.borderSubtle}`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontFamily: fonts.sans, fontSize: 10, color: colors.textSecondary, flexShrink: 0,
                    }}>
                      {player.worldRank === 999 ? 'NR' : `#${player.worldRank}`}
                    </div>
                    <span style={{ fontFamily: fonts.serif, fontSize: 13, color: isCurrentlySelected ? accentColor(isWaiverMode) : colors.textPrimary }}>
                      {player.name}
                    </span>
                  </div>
                  <button
                    onClick={() => selectPlayerToAdd(player)}
                    style={{
                      fontFamily: fonts.sans, fontSize: 11, fontWeight: 600,
                      padding: '5px 14px', borderRadius: 3, cursor: 'pointer',
                      transition: 'all 0.15s',
                      background: isCurrentlySelected ? accentBg(isWaiverMode) : (isWaiverMode ? 'rgba(220,170,60,0.1)' : 'rgba(80,180,120,0.1)'),
                      border: `1px solid ${isCurrentlySelected ? accentBorder(isWaiverMode) : (isWaiverMode ? 'rgba(220,170,60,0.3)' : 'rgba(80,180,120,0.3)')}`,
                      color: isCurrentlySelected ? accentColor(isWaiverMode) : (isWaiverMode ? colors.warning : colors.success),
                    }}
                  >
                    {isCurrentlySelected ? '✓ Selected' : 'Select'}
                  </button>
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
