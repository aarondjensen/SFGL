// src/pages/admin/SwingWinnerPanel.jsx
// ============================================================================
// Award swing pots — calculates fees collected during a given swing and
// awards the pot to the team with the highest swing earnings.
// Wave I extraction from AdminView.
// ============================================================================

import React from 'react';
import { useDialog } from '../DialogContext';
import { theme, colors } from '../../theme.js';
import { sfglDataApi } from '../../api/firebase';
import { SWINGS } from '../../theme.js';
import { getSegmentForTournament } from '../../utils';
import { S, disabledBtn } from './adminStyles';
import { getSwingTournaments, getSwingEarningsByTeam, getSwingPot, getSwingLeader } from '../../utils/sharedHelpers';

export const SwingWinnerPanel = ({
  tournaments, teams, transactions, setTransactions, updateTeams,
  STORAGE_KEYS,
}) => {
  const dialog = useDialog();
  const [swingAwardSeg, setSwingAwardSeg] = React.useState('');

  const handleSwingWinner = async () => {
    if (!swingAwardSeg) return;

    const swingTournaments = getSwingTournaments(tournaments, swingAwardSeg);
    if (!swingTournaments.length) {
      dialog.showToast('No completed results found for ' + swingAwardSeg, 'error');
      return;
    }

    const pot = getSwingPot(transactions, tournaments, swingAwardSeg);
    if (pot === 0) {
      dialog.showToast('No fees collected for ' + swingAwardSeg, 'error');
      return;
    }

    const byTeam = getSwingEarningsByTeam(tournaments, swingAwardSeg);
    const leader = getSwingLeader(tournaments, swingAwardSeg);
    if (!leader) { dialog.showToast('Could not determine winner', 'error'); return; }

    const winnerTeam = teams.find(t => t.id === leader.teamId);
    if (!winnerTeam) { dialog.showToast('Winner team not found', 'error'); return; }

    // Debug logging — useful when results look unexpected
    console.log('[SwingWinner] Swing:', swingAwardSeg);
    console.log('[SwingWinner] Tournaments found:', swingTournaments.map(t => t.name + ' (segment=' + t.segment + ', dates=' + t.dates + ')'));
    console.log('[SwingWinner] Earnings by team:', Object.entries(byTeam).map(([id, e]) => {
      const t = teams.find(x => x.id === id); return (t?.name || id) + ': $' + e.toLocaleString();
    }));

    const msg = swingAwardSeg + ' complete. Winner: ' + winnerTeam.name + ' (' + winnerTeam.owner + '). Swing: $' + leader.earnings.toLocaleString() + '. Pot: $' + pot.toLocaleString() + '. Award pot?';
    const ok = await dialog.showConfirm('Award Swing Winner', msg, { confirmText: 'Award $' + pot.toLocaleString() });
    if (!ok) return;

    const lastSwingTournament = swingTournaments.reduce((last, t) => {
      const idx = tournaments.indexOf(t);
      return idx > (last?.idx ?? -1) ? { t, idx } : last;
    }, null);

    const newTx = {
      team: winnerTeam.name, type: 'swing_winner', player: winnerTeam.owner,
      fee: 0, amount: pot, segment: swingAwardSeg,
      date: new Date().toLocaleDateString(), status: 'completed',
      tournamentIndex: lastSwingTournament?.idx ?? undefined,
      note: swingAwardSeg + ' winner pot',
    };

    const newTeams = teams.map(t =>
      t.id === leader.teamId
        ? { ...t, earnings: (t.earnings || 0) + pot }
        : t
    );

    updateTeams(newTeams);
    setTransactions(prev => [...prev, newTx]);
    await sfglDataApi.set(STORAGE_KEYS.TRANSACTIONS, [...transactions, newTx]).catch(e => console.error('sfgl tx:', e));

    dialog.showToast('🏆 ' + winnerTeam.name + ' awarded $' + pot.toLocaleString() + ' for ' + swingAwardSeg, 'success');
    setSwingAwardSeg('');
  };

  return (
    <div style={S.section}>
      <div style={S.title}>🏆 Award Swing Winner</div>
      <label style={S.lbl}>Swing</label>
      <select value={swingAwardSeg} onChange={e => setSwingAwardSeg(e.target.value)} style={S.select}>
        <option value="">Select swing...</option>
        {SWINGS.map(s => {
          const pot = transactions.filter(tx => tx.segment === s && (tx.fee || 0) > 0).reduce((sum, tx) => sum + tx.fee, 0);
          const alreadyAwarded = transactions.some(tx => tx.type === 'swing_winner' && tx.segment === s);
          return (
            <option key={s} value={s} disabled={alreadyAwarded}>
              {s}{pot > 0 ? ' · $' + pot.toLocaleString() + ' pot' : ''}{alreadyAwarded ? ' ✓ awarded' : ''}
            </option>
          );
        })}
      </select>

      {swingAwardSeg && (() => {
        const pot = transactions.filter(tx => tx.segment === swingAwardSeg && (tx.fee || 0) > 0).reduce((sum, tx) => sum + tx.fee, 0);
        const leader = getSwingLeader(tournaments, swingAwardSeg);
        const leaderTeam = leader ? teams.find(t => t.id === leader.teamId) : null;
        return (
          <div style={{ ...theme.smallText, marginBottom: 10, padding: '8px 10px', background: colors.inputBg, borderRadius: 3, border: `1px solid ${colors.borderSubtle}` }}>
            {leaderTeam
              ? <span>🏆 Leader: <span style={{ color: colors.textGold, fontWeight: 600 }}>{leaderTeam.name}</span> · ${(leader.earnings || 0).toLocaleString()} · <span style={{ color: colors.earningsGreen }}>Pot: ${pot.toLocaleString()}</span></span>
              : <span style={{ color: colors.textMuted }}>No completed results for this swing yet</span>
            }
          </div>
        );
      })()}

      <button
        onClick={handleSwingWinner}
        disabled={!swingAwardSeg}
        style={{ ...S.btn, ...disabledBtn(!swingAwardSeg) }}
      >
        🏆 Award Swing Winner
      </button>
    </div>
  );
};
