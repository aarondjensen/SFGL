import React, { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { useDialog } from './DialogContext';
import { getSegmentByDate } from '../utils/index.js';
import { ROSTER_LIMIT, TRANSACTION_FEE_FREE_AGENT, TRANSACTION_FEE_WAIVER } from '../constants/index.js';
import { theme, colors, fonts } from '../theme.js';
import { storage } from '../api';
import { STORAGE_KEYS } from '../constants/index.js';

export const AddDropPlayerModal = ({
  isOpen, onClose, team, currentRoster, allPlayers, teams,
  updateTeams, transactions, setTransactions,
  isWaiverMode, activeTournamentIndex, editingWaiverData,
}) => {
  const [searchTerm,           setSearchTerm]           = useState('');
  const [selectedPlayerToAdd,  setSelectedPlayerToAdd]  = useState(null);
  const [selectedPlayerToDrop, setSelectedPlayerToDrop] = useState(null);
  const [step,                 setStep]                 = useState('browse');
  const [saving,               setSaving]               = useState(false);
  const dialog = useDialog();

  // Pre-populate when editing an existing waiver claim
  useEffect(() => {
    if (editingWaiverData && isOpen) {
      const toAdd = allPlayers.find(p => p.name === editingWaiverData.player);
      if (toAdd) setSelectedPlayerToAdd(toAdd);
      if (editingWaiverData.droppedPlayer) {
        const toDrop = currentRoster.find(p => p.name === editingWaiverData.droppedPlayer);
        if (toDrop) setSelectedPlayerToDrop(toDrop);
      }
      setStep('confirm');
    }
  }, [editingWaiverData, isOpen, allPlayers, currentRoster]);

  if (!isOpen || !team) return null;

  // ── Available players ────────────────────────────────────────────────────────
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

  const rosterFull = currentRoster.length >= ROSTER_LIMIT;
  const fee        = isWaiverMode ? TRANSACTION_FEE_WAIVER : TRANSACTION_FEE_FREE_AGENT;

  // ── Confirm & persist ────────────────────────────────────────────────────────
  const handleConfirm = async () => {
    if (!selectedPlayerToAdd) return;
    if (rosterFull && !selectedPlayerToDrop) return;
    setSaving(true);

    const newTx = {
      team:            team.name,
      type:            isWaiverMode ? 'waiver' : 'free agent',
      player:          selectedPlayerToAdd.name,
      droppedPlayer:   selectedPlayerToDrop?.name || null,
      fee,
      segment:         getSegmentByDate(),
      date:            new Date().toLocaleDateString(),
      tournamentIndex: activeTournamentIndex,
      status:          isWaiverMode ? 'pending' : 'processed',
      priority: isWaiverMode
        ? (transactions.filter(tx => tx.team === team.name && tx.type === 'waiver' && tx.status === 'pending').length + 1)
        : undefined,
      timestamp: Date.now(),
    };

    const updatedTeams = teams.map(t =>
      t.id === team.id ? { ...t, transactionFees: (t.transactionFees || 0) + fee } : t,
    );

    // Optimistic local update first
    updateTeams(updatedTeams);
    setTransactions(prev => [newTx, ...prev]);

    // Persist to sfgl_data so all devices see this
    await storage.set(STORAGE_KEYS.TEAMS, updatedTeams);
    await storage.set(STORAGE_KEYS.TRANSACTIONS, [newTx, ...transactions]);

    setSaving(false);
    dialog.showToast(
      `${isWaiverMode ? 'Waiver claim' : 'Free agent add'}: ${selectedPlayerToAdd.name}`,
      'success',
    );
    reset();
  };

  const reset = () => {
    setStep('browse');
    setSelectedPlayerToAdd(null);
    setSelectedPlayerToDrop(null);
    setSearchTerm('');
    onClose();
  };

  // ── Shared sub-styles ────────────────────────────────────────────────────────
  const playerRow = {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '9px 12px',
    background: colors.cardBg,
    border: `1px solid ${colors.borderSubtle}`,
    borderRadius: 3,
    marginBottom: 6,
    cursor: 'pointer',
    transition: 'background 0.15s, border-color 0.15s',
  };

  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'rgba(5,10,25,0.85)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 16, zIndex: 50,
    }}>
      <div style={{
        background: '#0f1d35',
        border: `2px solid ${isWaiverMode ? colors.warning : colors.success}`,
        borderRadius: 4,
        width: '100%', maxWidth: 480,
        maxHeight: '75vh',
        display: 'flex', flexDirection: 'column',
      }}>

        {/* ── Header ── */}
        <div style={{
          padding: '14px 18px',
          background: `linear-gradient(90deg, ${isWaiverMode ? 'rgba(220,170,60,0.12)' : 'rgba(80,180,120,0.12)'} 0%, transparent 100%)`,
          borderBottom: `1px solid ${colors.borderSubtle}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexShrink: 0,
        }}>
          <div>
            <h2 style={{ fontFamily: fonts.serif, fontSize: 15, color: isWaiverMode ? colors.warning : colors.success, margin: 0 }}>
              {isWaiverMode ? `⏰ Waiver Claim · $${TRANSACTION_FEE_WAIVER.toLocaleString()}` : `✅ Add Free Agent · $${TRANSACTION_FEE_FREE_AGENT.toLocaleString()}`}
            </h2>
            <p style={{ ...theme.smallText, marginTop: 3 }}>
              {team.name} · {step === 'browse' ? 'Search and select a player' : 'Confirm transaction'}
            </p>
          </div>
          <button onClick={reset} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: colors.textSecondary, padding: 4,
          }}>
            <X style={{ width: 18, height: 18 }} />
          </button>
        </div>

        {/* ── Body ── */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px', minHeight: 0 }}>

          {step === 'browse' ? (
            <>
              {/* Search input */}
              <input
                type="text"
                placeholder="Search players…"
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                autoFocus
                style={{ ...theme.input, marginBottom: 12 }}
                onFocus={e => { e.target.style.borderColor = colors.borderFocus; e.target.style.background = colors.inputBgFocus; }}
                onBlur={e => { e.target.style.borderColor = colors.borderInput; e.target.style.background = colors.inputBg; }}
              />

              {/* Player list */}
              {filteredPlayers.length === 0 ? (
                <p style={{ ...theme.smallText, textAlign: 'center', padding: '24px 0' }}>No available players found</p>
              ) : (
                filteredPlayers.slice(0, 50).map(player => (
                  <div
                    key={player.name}
                    style={playerRow}
                    onMouseEnter={e => { e.currentTarget.style.background = colors.cardBgHover; e.currentTarget.style.borderColor = colors.borderInput; }}
                    onMouseLeave={e => { e.currentTarget.style.background = colors.cardBg; e.currentTarget.style.borderColor = colors.borderSubtle; }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{
                        width: 28, height: 28, borderRadius: '50%',
                        background: colors.buttonNavy,
                        border: `1px solid ${colors.borderSubtle}`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontFamily: fonts.sans, fontSize: 10, color: colors.textSecondary,
                        flexShrink: 0,
                      }}>
                        {player.worldRank === 999 ? 'NR' : `#${player.worldRank}`}
                      </div>
                      <span style={{ fontFamily: fonts.serif, fontSize: 13, color: colors.textPrimary }}>
                        {player.name}
                      </span>
                    </div>
                    <button
                      onClick={() => { setSelectedPlayerToAdd(player); setStep('confirm'); }}
                      style={{
                        ...theme.btnPrimary,
                        padding: '5px 14px', fontSize: 11,
                        background: isWaiverMode ? 'rgba(220,170,60,0.15)' : 'rgba(80,180,120,0.15)',
                        border: `1px solid ${isWaiverMode ? 'rgba(220,170,60,0.4)' : 'rgba(80,180,120,0.4)'}`,
                        color: isWaiverMode ? colors.warning : colors.success,
                      }}
                    >
                      Select
                    </button>
                  </div>
                ))
              )}
            </>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

              {/* Adding pill */}
              <div style={{
                padding: '10px 14px',
                background: isWaiverMode ? 'rgba(220,170,60,0.1)' : 'rgba(80,180,120,0.1)',
                border: `1px solid ${isWaiverMode ? 'rgba(220,170,60,0.35)' : 'rgba(80,180,120,0.35)'}`,
                borderRadius: 3,
              }}>
                <span style={{ fontFamily: fonts.sans, fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: isWaiverMode ? colors.warning : colors.success }}>
                  Adding
                </span>
                <div style={{ fontFamily: fonts.serif, fontSize: 14, color: colors.textPrimary, marginTop: 3 }}>
                  {selectedPlayerToAdd?.name}
                </div>
              </div>

              {/* Drop selector (if roster full) */}
              {rosterFull && (
                <div>
                  <p style={{ ...theme.smallText, marginBottom: 8 }}>
                    Roster is full ({ROSTER_LIMIT}). Select a player to drop:
                  </p>
                  {currentRoster.map(player => {
                    const isSelected = selectedPlayerToDrop?.name === player.name;
                    return (
                      <button
                        key={player.name}
                        onClick={() => setSelectedPlayerToDrop(isSelected ? null : player)}
                        style={{
                          ...playerRow,
                          width: '100%', textAlign: 'left',
                          background: isSelected ? colors.dangerBg : colors.cardBg,
                          border: `1px solid ${isSelected ? colors.dangerBorder : colors.borderSubtle}`,
                          cursor: 'pointer',
                        }}
                        onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = colors.cardBgHover; }}
                        onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = colors.cardBg; }}
                      >
                        <span style={{ fontFamily: fonts.serif, fontSize: 13, color: isSelected ? colors.danger : colors.textPrimary }}>
                          {player.name}
                        </span>
                        {isSelected && (
                          <span style={{ fontFamily: fonts.sans, fontSize: 10, fontWeight: 700, letterSpacing: 1, color: colors.danger, textTransform: 'uppercase' }}>
                            Drop
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Summary */}
              <div style={{
                padding: '10px 14px',
                background: colors.cardBg,
                border: `1px solid ${colors.borderSubtle}`,
                borderRadius: 3,
                fontFamily: fonts.sans, fontSize: 12, color: colors.textSecondary,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span>Transaction fee</span>
                  <span style={{ color: colors.textGold }}>${fee.toLocaleString()}</span>
                </div>
                {selectedPlayerToDrop && (
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>Dropping</span>
                    <span style={{ color: colors.danger }}>{selectedPlayerToDrop.name}</span>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
                  <span>Type</span>
                  <span style={{ color: isWaiverMode ? colors.warning : colors.success }}>
                    {isWaiverMode ? 'Waiver (pending)' : 'Free agent (immediate)'}
                  </span>
                </div>
              </div>

              {/* Actions */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 4 }}>
                <button
                  onClick={() => setStep('browse')}
                  style={{ ...theme.btnSecondary, padding: '10px 0' }}
                >
                  ← Back
                </button>
                <button
                  onClick={handleConfirm}
                  disabled={saving || (rosterFull && !selectedPlayerToDrop)}
                  style={{
                    ...theme.btnPrimary,
                    padding: '10px 0',
                    background: (saving || (rosterFull && !selectedPlayerToDrop))
                      ? 'rgba(255,255,255,0.06)'
                      : (isWaiverMode ? 'rgba(220,170,60,0.18)' : 'rgba(80,180,120,0.18)'),
                    border: `1px solid ${(rosterFull && !selectedPlayerToDrop) ? colors.borderSubtle : (isWaiverMode ? 'rgba(220,170,60,0.5)' : 'rgba(80,180,120,0.5)')}`,
                    color: (saving || (rosterFull && !selectedPlayerToDrop))
                      ? colors.textMuted
                      : (isWaiverMode ? colors.warning : colors.success),
                    cursor: (saving || (rosterFull && !selectedPlayerToDrop)) ? 'not-allowed' : 'pointer',
                    opacity: 1,
                  }}
                >
                  {saving ? 'Saving…' : 'Confirm'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
