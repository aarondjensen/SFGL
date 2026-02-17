import React, { useState, useMemo } from 'react';
import { useDialog } from './DialogContext';
import { getSegmentByDate, makePlayer, getTeamAbbreviation } from '../utils/index.js';

export const TransactionsView = ({ transactions, teams, setTransactions, updateTeams, isCommissioner }) => {
  const [filterTeam, setFilterTeam] = useState('all');
  const dialog = useDialog();

  const teamFees = useMemo(() => {
    const currentSwing = getSegmentByDate();
    const fees = {};
    teams.forEach(t => { fees[t.name] = { seasonTotal: 0, swingTotal: 0, teamId: t.id, teamName: t.name }; });
    transactions.forEach(tx => {
      if (fees[tx.team]) {
        fees[tx.team].seasonTotal += tx.fee;
        if (tx.segment === currentSwing) fees[tx.team].swingTotal += tx.fee;
      }
    });
    return Object.values(fees).sort((a, b) => b.seasonTotal - a.seasonTotal);
  }, [teams, transactions]);

  const filteredTransactions = filterTeam === 'all'
    ? transactions
    : transactions.filter(tx => tx.team === filterTeam);

  const undoTransaction = async (tx) => {
    const ok = await dialog.showConfirm(
      'Undo Transaction',
      `Undo: ${tx.team} added ${tx.player}?`,
      { type: 'danger', confirmText: 'Undo' },
    );
    if (!ok) return;

    const team = teams.find(t => t.name === tx.team);
    if (!team) return;

    let newRoster = team.roster.filter(p => p.name !== tx.player);
    if (tx.droppedPlayer) newRoster.push(makePlayer(tx.droppedPlayer));

    updateTeams(teams.map(t =>
      t.id === team.id
        ? { ...t, roster: newRoster, transactionFees: Math.max(0, (t.transactionFees || 0) - tx.fee) }
        : t,
    ));
    setTransactions(prev => prev.filter(t => t !== tx));
    dialog.showToast('Transaction undone', 'success');
  };

  return (
    <div className="space-y-4">
      {/* Fee summary */}
      <div className="bg-gray-800/50 backdrop-blur rounded-xl border border-purple-700/30 overflow-hidden p-3">
        <h2 className="text-lg font-bold mb-3">Transaction Fees</h2>
        <div className="flex gap-2 overflow-x-auto pb-1">
          {teamFees.map(team => {
            const abbr = getTeamAbbreviation(team.teamName);
            return (
              <div key={team.teamId} className="flex-shrink-0 bg-gray-700/30 rounded-lg px-3 py-2 text-center min-w-[64px]">
                <div className="font-bold text-sm text-green-400">{abbr}</div>
                <div className="text-xs text-yellow-400 mt-0.5">${team.seasonTotal}</div>
                <div className="text-[10px] text-gray-500">${team.swingTotal} swing</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Transaction history */}
      <div className="bg-gray-800/50 backdrop-blur rounded-xl border border-green-700/30 p-4">
        <div className="flex items-center justify-between mb-3 gap-2">
          <h2 className="text-xl font-bold">Transaction History</h2>
          <select
            value={filterTeam}
            onChange={e => setFilterTeam(e.target.value)}
            className="bg-gray-700 border border-gray-600 rounded-lg px-2 py-1 text-xs"
          >
            <option value="all">All Teams</option>
            {teams.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
          </select>
        </div>

        <div className="divide-y divide-gray-700/50">
          {filteredTransactions.length === 0 && (
            <p className="text-center text-gray-500 text-sm py-6">No transactions yet</p>
          )}
          {filteredTransactions.map((tx, index) => (
            <div key={index} className="py-2.5 flex justify-between items-start gap-2">
              <div className="min-w-0">
                <div className="font-semibold text-sm">{tx.team}</div>
                <div className="text-xs text-gray-400">
                  {tx.type}: <span className="text-green-400">{tx.player}</span>
                  {tx.droppedPlayer && <span className="text-gray-500"> (dropped <span className="text-red-400">{tx.droppedPlayer}</span>)</span>}
                </div>
                <div className="text-[10px] text-gray-600 mt-0.5">{tx.date} · {tx.segment}</div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {tx.type !== 'mulligan' && (
                  <span className="font-bold text-sm text-green-400">${tx.fee}</span>
                )}
                {isCommissioner && tx.type !== 'mulligan' && (
                  <button onClick={() => undoTransaction(tx)} className="text-[10px] text-red-400 hover:text-red-300">Undo</button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
