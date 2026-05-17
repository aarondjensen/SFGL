// src/pages/admin/LivIneligiblePanel.jsx
// ============================================================================
// LIV-flagged player management. Three operations:
//   1. Bulk sync from LIV_GOLF_ROSTER constant — applies code-level changes
//      to Firestore (used after deploying an updated LIV roster).
//   2. Search to add — find a single non-LIV player and flag them.
//   3. List of currently-flagged players — remove individual flags.
// ============================================================================

import React from 'react';
import { useDialog } from '../DialogContext';
import { colors, fonts } from '../../theme.js';
import { playersApi } from '../../api/firebase';
import { LIV_GOLF_ROSTER } from '../../constants';
import { M, SyncStatusBanner, LastSyncedLine, disabledBtn } from './adminStyles';

export const LivIneligiblePanel = ({ allPlayers, setAllPlayers, settings, setSettings }) => {
  const dialog = useDialog();
  const [livSearch, setLivSearch] = React.useState('');
  const [livSaving, setLivSaving] = React.useState({});

  // ── Bulk roster sync state (moved from DataSyncPanel) ──
  // Reads LIV_GOLF_ROSTER from the codebase, then flags any unflagged player
  // in the constant AND unflags any DB-flagged player no longer in it. The
  // "last synced" timestamp persists via settings.livRosterLastSynced so it
  // survives reloads.
  const [livSyncStatus, setLivSyncStatus] = React.useState(null);
  const [livSyncSummary, setLivSyncSummary] = React.useState('');
  const [livLastSynced, setLivLastSynced] = React.useState(() => settings?.livRosterLastSynced || null);

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

  // Bulk sync: make Firestore match LIV_GOLF_ROSTER. Computes the diff, then
  // batch-upserts. Idempotent — a no-op when the DB already matches.
  const handleSyncLivRoster = async () => {
    setLivSyncStatus('fetching');
    setLivSyncSummary('');
    try {
      const livRosterLower = new Set(LIV_GOLF_ROSTER.map(n => n.toLowerCase()));
      const toFlag = LIV_GOLF_ROSTER.filter(name =>
        !allPlayers.find(p => p.name.toLowerCase() === name.toLowerCase())?.isLiv
      );
      const toUnflag = allPlayers.filter(p =>
        p.isLiv && !livRosterLower.has(p.name.toLowerCase())
      );
      if (toFlag.length === 0 && toUnflag.length === 0) {
        setLivSyncStatus('done');
        setLivSyncSummary('✓ LIV roster already matches DB — no changes needed');
        return;
      }
      const livWrites = [
        ...toFlag.map(name => ({ name, isLiv: true })),
        ...toUnflag.map(p => ({ name: p.name, isLiv: false })),
      ];
      await playersApi.upsertMany(livWrites);
      setAllPlayers(prev => {
        const updated = [...prev];
        toFlag.forEach(name => {
          const idx = updated.findIndex(p => p.name.toLowerCase() === name.toLowerCase());
          if (idx >= 0) updated[idx] = { ...updated[idx], isLiv: true };
          else updated.push({ name, isLiv: true, worldRank: null });
        });
        toUnflag.forEach(u => {
          const idx = updated.findIndex(p => p.name === u.name);
          if (idx >= 0) updated[idx] = { ...updated[idx], isLiv: false };
        });
        return updated;
      });
      const parts = [
        toFlag.length   > 0 ? `${toFlag.length} tagged` : '',
        toUnflag.length > 0 ? `${toUnflag.length} unflagged` : '',
      ].filter(Boolean).join(' · ');
      const livTs = new Date().toISOString();
      setLivLastSynced(livTs);
      if (setSettings) {
        setSettings({ ...settings, livRosterLastSynced: livTs }).catch(() => {});
      }
      setLivSyncStatus('done');
      setLivSyncSummary(`✓ LIV roster synced · ${parts}`);
    } catch (err) {
      setLivSyncStatus('error');
      setLivSyncSummary(err.message || 'LIV sync failed');
    }
  };

  return (
    <div style={M.page}>
      <div style={M.descText}>
        Players flagged as LIV are hidden from the add/drop modal and waiver system.
      </div>

      {/* ── Bulk roster sync (from constants) ── */}
      <div style={M.group}>
        <div style={M.eyebrow}>🔄 Sync from LIV roster</div>
        <div style={M.descText}>
          Applies the latest <code style={{ fontFamily: 'monospace', fontSize: 11, opacity: 0.9 }}>LIV_GOLF_ROSTER</code> from the codebase. Flags any new defectors and unflags anyone who left LIV. Run after deploying a roster update.
        </div>
        <LastSyncedLine timestamp={livLastSynced || settings?.livRosterLastSynced} />
        <button
          onClick={handleSyncLivRoster}
          disabled={livSyncStatus === 'fetching'}
          className="modal-feel-lift modal-feel-primary"
          style={{ ...M.btnPrimary, ...disabledBtn(livSyncStatus === 'fetching') }}
        >
          {livSyncStatus === 'fetching' ? '⏳ Syncing…' : '🔄 Sync LIV Roster'}
        </button>
        <SyncStatusBanner status={livSyncStatus} summary={livSyncSummary} />
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
          // iOS Settings-style list. The faint danger-tinted container
          // background subtly signals "these are flagged" without being
          // loud. Rows use a top border (except the first) so dividers
          // appear between names but not on the outer edges.
          <div style={{
            border: `1px solid ${colors.borderSubtle}`,
            borderRadius: 8,
            overflow: 'hidden',
            background: 'rgba(220,80,80,0.02)',
          }}>
            {livPlayers.map((p, idx) => (
              <div
                key={p.name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '10px 12px',
                  borderTop: idx === 0 ? 'none' : `1px solid ${colors.borderSubtle}`,
                  fontFamily: fonts.sans,
                }}
              >
                <span style={{
                  flex: 1,
                  fontSize: 13,
                  fontWeight: 500,
                  color: colors.textPrimary,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {p.name}
                </span>
                <button
                  disabled={livSaving[p.name]}
                  onClick={() => unflagLiv(p)}
                  title={'Remove LIV flag from ' + p.name}
                  aria-label={'Remove LIV flag from ' + p.name}
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 6,
                    background: 'rgba(220,80,80,0.06)',
                    border: '1px solid rgba(220,80,80,0.25)',
                    color: 'rgba(220,100,80,0.85)',
                    cursor: livSaving[p.name] ? 'wait' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 12,
                    lineHeight: 1,
                    padding: 0,
                    flexShrink: 0,
                    transition: 'background 0.15s, border-color 0.15s',
                  }}
                  onMouseEnter={e => {
                    if (livSaving[p.name]) return;
                    e.currentTarget.style.background = 'rgba(220,80,80,0.14)';
                    e.currentTarget.style.borderColor = 'rgba(220,80,80,0.4)';
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.background = 'rgba(220,80,80,0.06)';
                    e.currentTarget.style.borderColor = 'rgba(220,80,80,0.25)';
                  }}
                >
                  {livSaving[p.name] ? '…' : '✕'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
