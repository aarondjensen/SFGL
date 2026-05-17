// src/pages/admin/LivIneligiblePanel.jsx
// ============================================================================
// LIV-flagged player management. Search for non-LIV players to flag, and
// display existing flags as removable chips.
//
// Wave J Round 6 follow-up: restyled to modal-feel — flat container, eyebrow
// headings, lifted rows, lighter chrome. Functional behavior unchanged.
// ============================================================================

import React from 'react';
import { useDialog } from '../DialogContext';
import { colors, fonts } from '../../theme.js';
import { playersApi } from '../../api/firebase';
import { LIV_GOLF_ROSTER } from '../../constants';
import { M } from './adminStyles';

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
    <div style={M.page}>
      <div style={M.descText}>
        Players flagged as LIV are hidden from the add/drop modal and waiver system.
      </div>

      {/* Search field */}
      <div style={M.group}>
        <div style={M.eyebrow}>Add to LIV list</div>
        <input
          type="text"
          placeholder="Search players…"
          value={livSearch}
          onChange={e => setLivSearch(e.target.value)}
          style={M.input}
        />

        {/* Search results — appear as light rows beneath the input. Only
            render when there's something to show; the empty state would be
            visual noise. */}
        {searchResults.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
            {searchResults.map(p => (
              <div
                key={p.name}
                style={{
                  ...M.statusRow,
                  background: 'rgba(80,180,120,0.04)',
                  borderColor: 'rgba(80,180,120,0.2)',
                  gap: 8,
                }}
              >
                <span style={{
                  flex: 1,
                  fontFamily: fonts.sans,
                  fontSize: 12,
                  color: colors.textPrimary,
                }}>
                  {p.name}
                  {p.worldRank && (
                    <span style={{ color: colors.textMuted, fontSize: 10, marginLeft: 6 }}>
                      #{p.worldRank}
                    </span>
                  )}
                </span>
                <button
                  disabled={livSaving[p.name]}
                  onClick={() => flagAsLiv(p)}
                  className="modal-feel-lift modal-feel-danger"
                  style={{
                    fontFamily: fonts.sans,
                    fontSize: 11,
                    padding: '5px 10px',
                    background: 'rgba(220,80,80,0.08)',
                    border: '1px solid rgba(220,80,80,0.35)',
                    color: colors.danger,
                    borderRadius: 6,
                    cursor: livSaving[p.name] ? 'wait' : 'pointer',
                    fontWeight: 600,
                    transition: 'background 0.15s, border-color 0.15s, transform 0.1s',
                    width: 'auto',
                    flexShrink: 0,
                  }}
                >
                  {livSaving[p.name] ? '…' : '+ Flag LIV'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Existing flagged players */}
      <div style={M.group}>
        <div style={M.eyebrow}>
          {livPlayers.length} Flagged Player{livPlayers.length !== 1 ? 's' : ''}
        </div>
        {livPlayers.length === 0 ? (
          <div style={{
            ...M.descText,
            textAlign: 'center',
            padding: '14px 0',
            color: colors.textMuted,
            fontStyle: 'italic',
          }}>
            No LIV players flagged
          </div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {livPlayers.map(p => (
              <div
                key={p.name}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 10px',
                  borderRadius: 6,
                  background: 'rgba(220,80,80,0.06)',
                  border: '1px solid rgba(220,80,80,0.25)',
                  fontSize: 12,
                  fontFamily: fonts.sans,
                  color: colors.textSecondary,
                }}
              >
                {p.name}
                <button
                  disabled={livSaving[p.name]}
                  onClick={() => unflagLiv(p)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'rgba(220,100,80,0.7)',
                    cursor: livSaving[p.name] ? 'wait' : 'pointer',
                    fontSize: 13,
                    padding: 0,
                    lineHeight: 1,
                  }}
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
