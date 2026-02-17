import React, { useState } from 'react';
import { useDialog } from './DialogContext';

/**
 * MulliganModal is now a proper top-level component.
 * Previously it was defined *inside* the RostersView render function,
 * which caused React to destroy and recreate it on every render.
 */
export const MulliganModal = ({
  isOpen,
  onClose,
  team,
  activeTournament,
  isSignatureOrMajor,
  lineupPlayers,
  benchPlayers,
  onConfirm,
}) => {
  const [playerOut,   setPlayerOut]   = useState('');
  const [playerIn,    setPlayerIn]    = useState('');
  const [afterRound,  setAfterRound]  = useState('2');
  const dialog = useDialog();

  if (!isOpen || !activeTournament) return null;

  const handleConfirm = async () => {
    if (!playerOut || !playerIn) return;
    const ok = await dialog.showConfirm(
      'Use Mulligan',
      `Swap ${playerOut} OUT → ${playerIn} IN for ${activeTournament.name} (after Round ${afterRound})?`,
      { confirmText: 'Use Mulligan' },
    );
    if (!ok) return;
    onConfirm({ playerOut, playerIn, afterRound: parseInt(afterRound, 10), isSignatureOrMajor });
    handleClose();
  };

  const handleClose = () => {
    setPlayerOut('');
    setPlayerIn('');
    setAfterRound('2');
    onClose();
  };

  return (
    <div
      className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={handleClose}
    >
      <div
        className="bg-gray-800 rounded-xl border border-gray-500/50 max-w-md w-full shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="p-4 border-b border-gray-700">
          <h2 className="text-lg font-bold">🚨 Use Mulligan</h2>
          <p className="text-xs text-gray-400 mt-1">
            {isSignatureOrMajor ? 'Signature/Major' : 'Regular'} mulligan · {activeTournament.name}
          </p>
        </div>

        <div className="p-4 space-y-4">
          <div>
            <label className="text-xs font-semibold text-red-300 block mb-1">Player OUT</label>
            <select
              value={playerOut}
              onChange={e => setPlayerOut(e.target.value)}
              className="w-full px-3 py-2 bg-gray-700 rounded-lg text-sm"
            >
              <option value="">Select...</option>
              {lineupPlayers.map(p => (
                <option key={p.name} value={p.name}>{p.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs font-semibold text-green-300 block mb-1">Player IN</label>
            <select
              value={playerIn}
              onChange={e => setPlayerIn(e.target.value)}
              className="w-full px-3 py-2 bg-gray-700 rounded-lg text-sm"
            >
              <option value="">Select...</option>
              {benchPlayers.map(p => (
                <option key={p.name} value={p.name}>{p.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs font-semibold text-gray-300 block mb-1">Takes effect after...</label>
            <div className="flex gap-2">
              {['1', '2', '3'].map(r => (
                <button
                  key={r}
                  onClick={() => setAfterRound(r)}
                  className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                    afterRound === r
                      ? 'bg-purple-600 text-white'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600 border border-gray-600'
                  }`}
                >
                  Round {r}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="p-4 border-t border-gray-700 flex gap-2">
          <button onClick={handleClose} className="flex-1 py-2 bg-gray-700 rounded-lg">Cancel</button>
          <button
            onClick={handleConfirm}
            disabled={!playerOut || !playerIn}
            className="flex-1 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-gray-700 disabled:cursor-not-allowed rounded-lg transition-colors"
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
};
