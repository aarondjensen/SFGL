import React, { useState, useMemo } from 'react';
import { useDialog } from './DialogContext';
import { getSegmentByDate, makePlayer, getTeamAbbreviation } from '../utils/index.js';
import { theme, colors, fonts } from '../theme.js';

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

  // Label for transaction type
  const txTypeColor = (type) => {
    if (type === 'mulligan') return colors.textGoldDim;
    if (type === 'waiver')   return 'rgba(220,200,80,0.8)';
    if (type === 'drop')     return colors.danger;
    return colors.success;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* ── Fee summary ── */}
      <div style={theme.card}>
        <div style={theme.cardHeader}>
          <h2 style={theme.h2}>Transaction Fees</h2>
        </div>
        <div style={{ padding: '12px 16px' }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'nowrap' }}>
            {teamFees.map(team => {
              const abbr = getTeamAbbreviation(team.teamName);
              return (
                <div key={team.teamId} style={{
                  flex: 1,
                  background: 'rgba(255,255,255,0.03)',
                  border: `1px solid ${colors.borderSubtle}`,
                  borderRadius: 2,
                  padding: '8px 6px',
                  textAlign: 'center',
                  minWidth: 0,
                }}>
                  <div style={{ fontFamily: fonts.serif, fontSize: 13, fontWeight: 400, color: colors.textPrimary }}>
                    {abbr}
                  </div>
                  <div style={{ ...theme.statNum, fontSize: 13, color: colors.earningsGreen, marginTop: 2 }}>
                    ${team.seasonTotal}
                  </div>
                  <div style={{ fontFamily: fonts.sans, fontSize: 10, color: colors.textMuted, marginTop: 1 }}>
                    ${team.swingTotal} swing
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Transaction history ── */}
      <div style={theme.card}>
        <div style={{ ...theme.cardHeader, justifyContent: 'space-between' }}>
          <h2 style={theme.h2}>Transaction History</h2>
          <select
            value={filterTeam}
            onChange={e => setFilterTeam(e.target.value)}
            style={{ ...theme.select, width: 'auto', fontSize: 11, padding: '5px 10px' }}
            onFocus={e => { e.target.style.borderColor = colors.borderFocus; }}
            onBlur={e => { e.target.style.borderColor = colors.borderInput; }}
          >
            <option value="all">All Teams</option>
            {teams.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
          </select>
        </div>

        <div style={{ padding: '0 4px' }}>
          {filteredTransactions.length === 0 && (
            <div style={theme.emptyState}>No transactions yet</div>
          )}
          {filteredTransactions.map((tx, index) => (
            <div key={index} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
              padding: '10px 16px', gap: 8,
              borderBottom: `1px solid ${colors.borderSubtle}`,
              transition: 'background 0.15s',
            }}
              onMouseEnter={e => { e.currentTarget.style.background = colors.rowHover; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
            >
              <div style={{ minWidth: 0 }}>
                {/* Team name */}
                <div style={{ fontFamily: fonts.serif, fontSize: 13, color: colors.textPrimary, marginBottom: 2 }}>
                  {tx.team}
                </div>

                {/* Transaction detail */}
                <div style={{ fontFamily: fonts.sans, fontSize: 11, color: colors.textSecondary }}>
                  <span style={{ color: txTypeColor(tx.type) }}>{tx.type}</span>
                  {': '}
                  <span style={{ color: colors.success }}>{tx.player}</span>
                  {tx.droppedPlayer && (
                    <>
                      <span style={{ color: colors.textMuted, margin: '0 3px' }}>→ drop</span>
                      <span style={{ color: colors.danger }}>{tx.droppedPlayer}</span>
                    </>
                  )}
                </div>

                {/* Date + segment */}
                <div style={{ fontFamily: fonts.sans, fontSize: 10, color: colors.textMuted, marginTop: 2 }}>
                  {tx.date}{tx.segment ? ` · ${tx.segment}` : ''}
                </div>
              </div>

              {/* Fee + undo */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                {tx.type !== 'mulligan' && (
                  <span style={{
                    ...theme.statNum, fontSize: 13, fontWeight: 600,
                    color: tx.fee > 0 ? colors.earningsGreen : colors.textMuted,
                  }}>
                    ${tx.fee}
                  </span>
                )}
                {isCommissioner && tx.type !== 'mulligan' && (
                  <button onClick={() => undoTransaction(tx)} style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    fontFamily: fonts.sans, fontSize: 10, fontWeight: 600,
                    letterSpacing: '0.5px', color: colors.danger,
                    padding: '2px 0', transition: 'opacity 0.15s',
                  }}
                    onMouseEnter={e => { e.currentTarget.style.opacity = '0.7'; }}
                    onMouseLeave={e => { e.currentTarget.style.opacity = '1'; }}
                  >
                    Undo
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
