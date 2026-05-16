// src/pages/admin/MergePlayersPanel.jsx
// ============================================================================
// Merge two player names into one canonical entry. Extracted from AdminView.
// Wave I cleanup — was already a self-contained sub-component, now in its own file.
//
// Contract: this panel renders ONLY the form contents (description + inputs +
// merge button) as a fragment. The callsite is responsible for the surrounding
// S.section box, the S.title header, and any collapse-toggle behaviour.
// This matches the historic inline structure so the swap is a pure refactor
// with no DOM-level changes.
// ============================================================================

import React from 'react';
import { useDialog } from '../DialogContext';
import { theme, colors, fonts } from '../../theme.js';
import { sfglDataApi, playersApi, teamsApi } from '../../api/firebase';
import { STORAGE_KEYS } from '../../constants';
import { S, disabledBtn } from './adminStyles';

export const MergePlayersPanel = ({
  allPlayers, teams, transactions,
  updateTeams, setTransactions,
}) => {
  const dialog = useDialog();

  const [search1, setSearch1] = React.useState('');
  const [search2, setSearch2] = React.useState('');
  const [player1, setPlayer1] = React.useState(null);
  const [player2, setPlayer2] = React.useState(null);
  const [status,  setStatus]  = React.useState('');
  const [error,   setError]   = React.useState('');

  const allNames = React.useMemo(() =>
    [...new Set([
      ...allPlayers.map(p => p.name),
      ...teams.flatMap(t => (t.roster || []).map(p => p.name)),
    ])].sort(),
    [allPlayers, teams]
  );

  const f1 = search1.length >= 2
    ? allNames.filter(n => n.toLowerCase().includes(search1.toLowerCase())).slice(0, 8)
    : [];
  const f2 = search2.length >= 2
    ? allNames.filter(n => n.toLowerCase().includes(search2.toLowerCase())).slice(0, 8)
    : [];

  const iStyle = (sel) => ({
    ...theme.input, width: '100%', fontSize: 13,
    border: sel ? `1px solid ${colors.textGold}` : undefined,
  });
  const dStyle = {
    position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50,
    background: '#0f1d35',
    border: `1px solid ${colors.border}`,
    borderRadius: 3,
    boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
    overflow: 'hidden',
  };
  const oStyle = {
    display: 'block', width: '100%', textAlign: 'left',
    padding: '8px 12px', background: 'none', border: 'none',
    fontFamily: fonts.sans, fontSize: 12, color: colors.textPrimary,
    cursor: 'pointer',
    borderBottom: `1px solid ${colors.borderSubtle}`,
  };

  const doMerge = async () => {
    if (!player1 || !player2 || player1 === player2) {
      setError('Select two different players');
      return;
    }
    const ok = await dialog.showConfirm(
      'Merge Players',
      `Rename "${player1}" → "${player2}" everywhere?`,
      { type: 'danger', confirmText: 'Merge' }
    );
    if (!ok) return;

    setStatus('merging');
    setError('');
    try {
      const uTeams = teams.map(t => ({
        ...t,
        roster: (t.roster || []).map(p => p.name === player1 ? { ...p, name: player2 } : p),
        lineup: (t.lineup || []).map(n => n === player1 ? player2 : n),
      }));
      const uTx = transactions.map(tx => ({
        ...tx,
        ...(tx.player === player1 && { player: player2 }),
        ...(tx.droppedPlayer === player1 && { droppedPlayer: player2 }),
      }));

      await Promise.all([
        ...uTeams.map(t => teamsApi.update(t.id, t)),
        sfglDataApi.set(STORAGE_KEYS.TRANSACTIONS, uTx),
        playersApi.addAlias(player2, player1).catch(() => {}),
        playersApi.delete(player1).catch(() => {}),
      ]);

      updateTeams(uTeams);
      setTransactions(uTx);
      setStatus('done');
      dialog.showToast(`Merged "${player1}" → "${player2}"`, 'success');
      setPlayer1(null); setPlayer2(null);
      setSearch1(''); setSearch2('');
    } catch (err) {
      setStatus('error');
      setError(err.message || 'Merge failed');
    }
  };

  return (
    <>
      <div style={{ ...theme.smallText, color: colors.textSecondary, marginBottom: 12 }}>
        Fix name mismatches — renames a player everywhere in rosters, transactions and Firebase.
      </div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <label style={S.lbl}>Rename this player...</label>
          <div style={{ position: 'relative' }}>
            <input
              value={player1 || search1}
              onChange={e => { setSearch1(e.target.value); setPlayer1(null); }}
              placeholder="Search..."
              style={iStyle(player1)}
            />
            {!player1 && f1.length > 0 && (
              <div style={dStyle}>
                {f1.map(n => (
                  <button key={n}
                    onClick={() => { setPlayer1(n); setSearch1(n); }}
                    style={oStyle}
                    onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.07)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'none'}
                  >
                    {n}
                  </button>
                ))}
              </div>
            )}
          </div>
          {player1 && (
            <button onClick={() => { setPlayer1(null); setSearch1(''); }}
              style={{ ...theme.btnSecondary, marginTop: 4, padding: '2px 8px', fontSize: 10 }}>
              ✕ Clear
            </button>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', paddingTop: 20, color: colors.textMuted, fontSize: 16 }}>→</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <label style={S.lbl}>...to this name</label>
          <div style={{ position: 'relative' }}>
            <input
              value={player2 || search2}
              onChange={e => { setSearch2(e.target.value); setPlayer2(null); }}
              placeholder="Search..."
              style={iStyle(player2)}
            />
            {!player2 && f2.length > 0 && (
              <div style={dStyle}>
                {f2.map(n => (
                  <button key={n}
                    onClick={() => { setPlayer2(n); setSearch2(n); }}
                    style={oStyle}
                    onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.07)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'none'}
                  >
                    {n}
                  </button>
                ))}
              </div>
            )}
          </div>
          {player2 && (
            <button onClick={() => { setPlayer2(null); setSearch2(''); }}
              style={{ ...theme.btnSecondary, marginTop: 4, padding: '2px 8px', fontSize: 10 }}>
              ✕ Clear
            </button>
          )}
        </div>
      </div>
      {error && (
        <div style={{ ...theme.smallText, color: colors.danger, marginBottom: 8 }}>
          {error}
        </div>
      )}
      <button
        onClick={doMerge}
        disabled={!player1 || !player2 || status === 'merging'}
        style={{
          ...S.btn,
          background: 'rgba(180,100,100,0.15)',
          border: '1px solid rgba(200,80,80,0.4)',
          color: 'rgba(220,120,120,0.95)',
          ...disabledBtn(!player1 || !player2 || status === 'merging'),
        }}
      >
        {status === 'merging' ? '⏳ Merging…' : '🔀 Merge Players'}
      </button>
    </>
  );
};
