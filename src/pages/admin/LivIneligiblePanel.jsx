// src/pages/admin/LivIneligiblePanel.jsx
// ============================================================================
// LIV-flagged player management. Search for non-LIV players to flag, and
// display existing flags as removable chips.
// Wave I extraction from AdminView.
// ============================================================================

import React from 'react';
import { useDialog } from '../DialogContext';
import { theme, colors, fonts } from '../../theme.js';
import { playersApi } from '../../api/firebase';
import { LIV_GOLF_ROSTER } from '../../constants';
import { S } from './adminStyles';

export const LivIneligiblePanel = ({ allPlayers, setAllPlayers }) => {
  const dialog = useDialog();
  const [livSearch, setLivSearch] = React.useState('');
  const [livSaving, setLivSaving] = React.useState({});

  const livPlayers = allPlayers.filter(p => p.isLiv).sort((a, b) => a.name.localeCompare(b.name));

  const searchResults = livSearch.trim().length >= 2
    ? (() => {
        const q = livSearch.toLowerCase();
        const livNames = new Set(allPlayers.filter(p => p.isLiv).map(p => p.name));
        const fromAll = allPlayers
          .filter(p => p.name && p.name.toLowerCase().includes(q) && !p.isLiv)
          .map(p => ({ name: p.name, worldRank: p.worldRank }));
        const existingNames = new Set(allPlayers.map(p => p.name));
        const fromConst = LIV_GOLF_ROSTER
          .filter(name => name.toLowerCase().includes(q) && !existingNames.has(name) && !livNames.has(name))
          .map(name => ({ name, worldRank: null }));
        return [...fromAll, ...fromConst].slice(0, 10);
      })()
    : [];

  const flagAsLiv = async (p) => {
    setLivSaving(prev => ({ ...prev, [p.name]: true }));
    try {
      await playersApi.upsertMany([{ name: p.name, isLiv: true }]);
      setAllPlayers(prev => {
        const exists = prev.some(x => x.name === p.name);
        if (exists) return prev.map(x => x.name === p.name ? { ...x, isLiv: true } : x);
        return [...prev, { name: p.name, worldRank: p.worldRank || null, isLiv: true }];
      });
      dialog.showToast('Flagged ' + p.name + ' as LIV', 'success');
      setLivSearch('');
    } catch (err) {
      dialog.showToast('Error: ' + err.message, 'error');
    } finally {
      setLivSaving(prev => ({ ...prev, [p.name]: false }));
    }
  };

  const unflagLiv = async (p) => {
    setLivSaving(prev => ({ ...prev, [p.name]: true }));
    try {
      await playersApi.update(p.name, { isLiv: false });
      setAllPlayers(prev => prev.map(x => x.name === p.name ? { ...x, isLiv: false } : x));
      dialog.showToast('Removed LIV flag from ' + p.name, 'success');
    } catch (err) {
      dialog.showToast('Error: ' + err.message, 'error');
    } finally {
      setLivSaving(prev => ({ ...prev, [p.name]: false }));
    }
  };

  return (
    <div style={S.section}>
      <div style={S.title}>🚫 LIV Golf — Ineligible Players</div>
      <div style={{ ...theme.smallText, marginBottom: 10, color: colors.textSecondary }}>
        Players flagged as LIV are hidden from the add/drop modal and waiver system.
      </div>

      <input
        type="text"
        placeholder="Search players to add/remove LIV flag…"
        value={livSearch}
        onChange={e => setLivSearch(e.target.value)}
        style={{ ...theme.input, marginBottom: 10, fontSize: 12 }}
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {searchResults.length > 0 && (
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontFamily: fonts.sans, fontSize: 10, color: colors.textMuted, letterSpacing: '0.5px', textTransform: 'uppercase', marginBottom: 4 }}>
              Add to LIV list
            </div>
            {searchResults.map(p => (
              <div key={p.name} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '6px 10px', marginBottom: 2, borderRadius: 3,
                background: 'rgba(80,180,120,0.06)', border: '1px solid rgba(80,180,120,0.2)',
              }}>
                <span style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.textPrimary }}>
                  {p.name}
                  {p.worldRank && <span style={{ color: colors.textMuted, fontSize: 10, marginLeft: 6 }}>#{p.worldRank}</span>}
                </span>
                <button
                  disabled={livSaving[p.name]}
                  onClick={() => flagAsLiv(p)}
                  style={{
                    fontFamily: fonts.sans, fontSize: 10, padding: '3px 8px',
                    background: 'rgba(220,60,60,0.15)', border: '1px solid rgba(220,60,60,0.35)',
                    color: colors.danger, borderRadius: 2, cursor: 'pointer',
                  }}
                >
                  {livSaving[p.name] ? '…' : '+ Flag LIV'}
                </button>
              </div>
            ))}
          </div>
        )}

        <div style={{ fontFamily: fonts.sans, fontSize: 10, color: colors.textMuted, letterSpacing: '0.5px', textTransform: 'uppercase', marginBottom: 4 }}>
          {livPlayers.length} flagged player{livPlayers.length !== 1 ? 's' : ''}
        </div>
        {livPlayers.length === 0 ? (
          <div style={{ ...theme.smallText, textAlign: 'center', padding: '8px 0', color: colors.textMuted }}>
            No LIV players flagged
          </div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {livPlayers.map(p => (
              <div key={p.name} style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '4px 8px', borderRadius: 3,
                background: 'rgba(220,60,60,0.08)', border: '1px solid rgba(220,60,60,0.2)',
                fontSize: 11, fontFamily: fonts.sans, color: colors.textSecondary,
              }}>
                {p.name}
                <button
                  disabled={livSaving[p.name]}
                  onClick={() => unflagLiv(p)}
                  style={{ background: 'none', border: 'none', color: 'rgba(220,100,80,0.7)', cursor: 'pointer', fontSize: 12, padding: 0, lineHeight: 1 }}
                  title={'Remove LIV flag from ' + p.name}
                  aria-label={'Remove LIV flag from ' + p.name}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
