// src/pages/admin/SwingWinnerPanel.jsx
// ============================================================================
// Manual swing-winner override. The auto-award now happens automatically
// when the final tournament of a swing gets processed (see swingAward.js +
// TournamentResultsPanel). This panel is a safety net for the rare case
// where the auto-award didn't fire — same logic, manually triggered.
//
// Wave I.2: refactored to use computeSwingAward from swingAward.js — both
// auto and manual paths now share the same code.
// ============================================================================

import React from 'react';
import { useDialog } from '../DialogContext';
import { theme, colors } from '../../theme.js';
import { sfglDataApi } from '../../api/firebase';
import { SWINGS } from '../../theme.js';
import { S, disabledBtn } from './adminStyles';
import { getSwingLeader, getSwingPot } from '../../utils/sharedHelpers';
import { computeSwingAward } from '../../utils/swingAward';

export const SwingWinnerPanel = ({
  tournaments, teams, transactions, setTransactions, updateTeams,
  STORAGE_KEYS,
}) => {
  const dialog = useDialog();
  const [swingAwardSeg, setSwingAwardSeg] = React.useState('');

  const handleSwingWinner = async () => {
    if (!swingAwardSeg) return;

    // computeSwingAward gates everything: completion check, pot > 0,
    // idempotency, leader resolution. Returns null with no specific reason
    // when not eligible — we re-check the details below to surface a
    // helpful error message.
    const award = computeSwingAward({
      segment: swingAwardSeg,
      allTournaments: tournaments,
      transactions,
      teams,
    });

    if (!award) {
      // Surface the most likely reason
      const alreadyAwarded = transactions.some(tx => tx.type === 'swing_winner' && tx.segment === swingAwardSeg);
      if (alreadyAwarded) {
        dialog.showToast(swingAwardSeg + ' has already been awarded', 'warning');
        return;
      }
      const pot = getSwingPot(transactions, tournaments, swingAwardSeg);
      if (pot === 0) { dialog.showToast('No fees collected for ' + swingAwardSeg, 'error'); return; }
      // Most likely the swing isn't fully complete yet
      dialog.showToast(swingAwardSeg + ' isn\'t fully complete yet — wait until all tournaments are processed', 'error');
      return;
    }

    const msg = `${award.segment} complete. Winner: ${award.winnerTeam.name} (${award.winnerTeam.owner}). Swing: $${award.winnerEarnings.toLocaleString()}. Pot: $${award.pot.toLocaleString()}. Award pot?`;
    const ok = await dialog.showConfirm('Award Swing Winner', msg, { confirmText: 'Award $' + award.pot.toLocaleString() });
    if (!ok) return;

    // Debug logging — useful when results look unexpected
    console.log('[SwingWinner] Manual award:', award.segment, '→', award.winnerTeam.name, '$' + award.pot.toLocaleString());

    updateTeams(award.updatedTeams);
    setTransactions(prev => [...prev, award.newTx]);
    await sfglDataApi.set(STORAGE_KEYS.TRANSACTIONS, [...transactions, award.newTx]).catch(e => console.error('sfgl tx:', e));

    dialog.showToast('🏆 ' + award.winnerTeam.name + ' awarded $' + award.pot.toLocaleString() + ' for ' + award.segment, 'success');
    setSwingAwardSeg('');
  };

  return (
    <div style={S.section}>
      <div style={S.title}>🏆 Award Swing Winner (manual override)</div>
      <div style={{ ...theme.smallText, color: colors.textSecondary, marginBottom: 10 }}>
        Swing winners are awarded automatically when the final tournament of a swing gets processed.
        Use this panel only if the auto-award didn't fire for some reason.
      </div>
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
