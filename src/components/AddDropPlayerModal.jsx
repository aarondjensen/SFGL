import React, { useState, useEffect } from 'react';
import { useDialog } from './DialogContext';
import { getSegmentByDate, makePlayer } from '../utils/index.js';
import { ROSTER_LIMIT, TRANSACTION_FEE_FREE_AGENT, TRANSACTION_FEE_WAIVER } from '../constants/index.js';

export const AddDropPlayerModal = ({
  isOpen, onClose, team, currentRoster, allPlayers, teams,
  updateTeams, transactions, setTransactions,
  isWaiverMode, activeTournamentIndex, editingWaiverData,
}) => {
  const [searchTerm,          setSearchTerm]          = useState('');
  const [selectedPlayerToAdd, setSelectedPlayerToAdd] = useState(null);
  const [selectedPlayerToDrop,setSelectedPlayerToDrop]= useState(null);
  const [step,                setStep]                = useState('browse');
  const dialog = useDialog();

  // Pre-populate when editing an existing waiver
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

  // Build the set of all rostered / claimed players across the league
  const rosteredPlayers = new Set();
  teams.forEach(t => {
    let effective = t.roster.map(p => p.name);
    transactions.filter(tx => tx.status !== 'pending').forEach(tx => {
      if (tx.droppedPlayer) effective = effective.filter(n => n !== tx.droppedPlayer);
      if (tx.player && !effective.includes(tx.player)) effective.push(tx.player);
    });
    effective.forEach(name => rosteredPlayers.add(name));
  });
  transactions.filter(tx => tx.status === 'pending' && tx.player).forEach(tx => rosteredPlayers.add(tx.player));

  const availablePlayers = allPlayers.filter(p => !rosteredPlayers.has(p.name));
  const filteredPlayers  = availablePlayers.filter(p =>
    p.name.toLowerCase().includes(searchTerm.toLowerCase()),
  );

  const rosterFull = currentRoster.length >= ROSTER_LIMIT;

  const handleConfirm = () => {
    if (!selectedPlayerToAdd) return;
    if (rosterFull && !selectedPlayerToDrop) return;

    const fee = isWaiverMode ? TRANSACTION_FEE_WAIVER : TRANSACTION_FEE_FREE_AGENT;
    const newTx = {
      team: team.name,
      type: isWaiverMode ? 'waiver' : 'free agent',
      player:        selectedPlayerToAdd.name,
      droppedPlayer: selectedPlayerToDrop?.name || null,
      fee,
      segment:        getSegmentByDate(),
      date:           new Date().toLocaleDateString(),
      tournamentIndex: activeTournamentIndex,
      status:         isWaiverMode ? 'pending' : 'processed',
      priority: isWaiverMode
        ? (transactions.filter(tx => tx.team === team.name && tx.type === 'waiver' && tx.status === 'pending').length + 1)
        : undefined,
      timestamp: Date.now(),
    };

    updateTeams(teams.map(t =>
      t.id === team.id ? { ...t, transactionFees: (t.transactionFees || 0) + fee } : t,
    ));
    setTransactions(prev => [newTx, ...prev]);
    dialog.showToast(`${isWaiverMode ? 'Waiver claim' : 'Free agent add'}: ${selectedPlayerToAdd.name}`, 'success');
    reset();
  };

  const reset = () => {
    setStep('browse');
    setSelectedPlayerToAdd(null);
    setSelectedPlayerToDrop(null);
    setSearchTerm('');
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-gray-900 rounded-xl border-2 border-green-600 w-full max-w-lg" style={{ height: '70vh' }}>
        <div className="flex flex-col h-full">
          {/* Header */}
          <div className="p-4 border-b border-gray-700 bg-gradient-to-r from-green-600/20 to-gray-800/50 flex-shrink-0">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold">
                  {isWaiverMode ? `⏰ Submit Waiver Claim ($${TRANSACTION_FEE_WAIVER})` : `✅ Add Free Agent ($${TRANSACTION_FEE_FREE_AGENT})`}
                </h2>
                <p className="text-xs text-gray-400 mt-0.5">
                  {step === 'browse' ? 'Search and select a player' : 'Confirm transaction'}
                </p>
              </div>
              <button onClick={reset} className="text-gray-400 hover:text-white text-xl">×</button>
            </div>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-4 min-h-0">
            {step === 'browse' ? (
              <>
                <div className="mb-3">
                  <input
                    type="text"
                    placeholder="Search players..."
                    value={searchTerm}
                    onChange={e => setSearchTerm(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-sm"
                    autoFocus
                  />
                </div>
                <div className="space-y-1.5">
                  {filteredPlayers.slice(0, 50).map(player => (
                    <div key={player.name} className="flex items-center justify-between p-2 bg-gray-800/50 hover:bg-gray-700/50 rounded-lg border border-gray-700">
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 bg-gray-700 rounded-full flex items-center justify-center text-xs font-bold">
                          #{player.worldRank}
                        </div>
                        <div className="text-sm font-semibold">{player.name}</div>
                      </div>
                      <button
                        onClick={() => { setSelectedPlayerToAdd(player); setStep('confirm'); }}
                        className="px-3 py-1.5 bg-green-600 rounded-lg text-sm"
                      >
                        Add
                      </button>
                    </div>
                  ))}
                  {filteredPlayers.length === 0 && (
                    <p className="text-center text-gray-500 text-sm py-6">No available players found</p>
                  )}
                </div>
              </>
            ) : (
              <div className="space-y-3">
                <div className="p-3 bg-green-600/20 border-2 border-green-600 rounded-lg">
                  <div className="text-xs font-semibold text-green-300">✅ Adding: {selectedPlayerToAdd?.name}</div>
                </div>

                {rosterFull && (
                  <div className="space-y-1.5">
                    <div className="text-xs text-gray-400">
                      Roster is full ({ROSTER_LIMIT}). Select a player to drop:
                    </div>
                    {currentRoster.map(player => (
                      <button
                        key={player.name}
                        onClick={() => setSelectedPlayerToDrop(player)}
                        className={`w-full flex justify-between p-2 rounded-lg border-2 ${
                          selectedPlayerToDrop?.name === player.name
                            ? 'bg-red-600/20 border-red-600'
                            : 'bg-gray-800/50 border-gray-700'
                        }`}
                      >
                        <div className="text-sm">{player.name}</div>
                        {selectedPlayerToDrop?.name === player.name && (
                          <span className="text-red-400 text-xs font-bold">Drop</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}

                <div className="flex gap-2 mt-4">
                  <button onClick={() => setStep('browse')} className="flex-1 py-2 bg-gray-700 rounded-lg text-sm">Back</button>
                  <button
                    onClick={handleConfirm}
                    disabled={rosterFull && !selectedPlayerToDrop}
                    className="flex-1 py-2 bg-green-600 disabled:bg-gray-700 disabled:cursor-not-allowed rounded-lg text-sm"
                  >
                    Confirm
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
