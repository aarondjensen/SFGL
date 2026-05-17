// src/pages/admin/MergePlayersPanel.jsx
// ============================================================================
// Merge two player names into one canonical entry. Fix name mismatches —
// renames a player everywhere in rosters, transactions, and Firebase.
//
// Wave J Round 6 follow-up: restyled to modal-feel — flat page, eyebrow
// headings, lighter inputs, danger-tinted merge button. Functional behavior
// unchanged.
// ============================================================================

import React from 'react';
import { useDialog } from '../DialogContext';
import { colors, fonts } from '../../theme.js';
import { sfglDataApi, playersApi, teamsApi } from '../../api/firebase';
import { M, disabledBtn } from './adminStyles';

export const MergePlayersPanel = ({
  allPlayers, teams, transactions,
  updateTeams, setTransactions,
  STORAGE_KEYS,
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

  // Input styling that highlights the field when a player is locked in.
  // Gold accent border = "this slot is committed."
  const iStyle = (sel) => ({
    ...M.input,
    border: sel
      ? `1px solid ${colors.textGold}`
      : `1px solid ${colors.borderSubtle}`,
  });

  // Autocomplete dropdown — appears beneath the input.
  const dStyle = {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    zIndex: 50,
    marginTop: 2,
    background: '#0f1d35',
    border: `1px solid ${colors.borderSubtle}`,
    borderRadius: 6,
    boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
    overflow: 'hidden',
  };

  const oStyle = {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    padding: '10px 12px',
    background: 'none',
    border: 'none',
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textPrimary,
    cursor: 'pointer',
    borderBottom: `1px solid ${colors.borderSubtle}`,
    transition: 'background 0.12s',
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

  // Reusable autocomplete-search field
  const renderSearchField = (eyebrowText, value, search, setSearch, selectedPlayer, setSelectedPlayer, filteredNames) => (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={M.eyebrow}>{eyebrowText}</div>
      <div style={{ position: 'relative' }}>
        <input
          value={selectedPlayer || search}
          onChange={e => { setSearch(e.target.value); setSelectedPlayer(null); }}
          placeholder="Search…"
          style={iStyle(selectedPlayer)}
        />
        {!selectedPlayer && filteredNames.length > 0 && (
          <div style={dStyle}>
            {filteredNames.map(n => (
              <button
                key={n}
                onClick={() => { setSelectedPlayer(n); setSearch(n); }}
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
      {selectedPlayer && (
        <button
          onClick={() => { setSelectedPlayer(null); setSearch(''); }}
          style={{
            alignSelf: 'flex-start',
            background: 'none',
            border: 'none',
            color: colors.textMuted,
            fontSize: 11,
            padding: '2px 0',
            cursor: 'pointer',
            fontFamily: fonts.sans,
          }}
        >
          ✕ Clear
        </button>
      )}
    </div>
  );

  return (
    <div style={M.page}>
      <div style={M.descText}>
        Fix name mismatches — renames a player everywhere in rosters, transactions, and Firebase. This action cannot be undone.
      </div>

      <div style={M.group}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'stretch' }}>
          {renderSearchField('Rename this player…', player1, search1, setSearch1, player1, setPlayer1, f1)}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            paddingTop: 22,
            color: colors.textMuted,
            fontSize: 18,
            flexShrink: 0,
          }}>
            →
          </div>
          {renderSearchField('…to this name', player2, search2, setSearch2, player2, setPlayer2, f2)}
        </div>

        {error && (
          <div style={{
            fontFamily: fonts.sans,
            fontSize: 11,
            color: colors.danger,
            padding: '6px 0',
          }}>
            {error}
          </div>
        )}
      </div>

      <button
        onClick={doMerge}
        disabled={!player1 || !player2 || status === 'merging'}
        className="modal-feel-lift modal-feel-danger"
        style={{
          ...M.btnDanger,
          ...disabledBtn(!player1 || !player2 || status === 'merging'),
        }}
      >
        {status === 'merging' ? '⏳ Merging…' : '🔀 Merge Players'}
      </button>
    </div>
  );
};
