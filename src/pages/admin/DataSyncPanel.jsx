// src/pages/admin/DataSyncPanel.jsx
// ============================================================================
// Three sync operations grouped together:
//   1. OWGR Rankings — refreshes world rankings + headshot espnIds
//   2. LIV Roster   — flags/unflags LIV defectors based on LIV_GOLF_ROSTER constant
//   3. Static Aliases — one-shot migration of nameAliases.js into Firestore
//
// Wave J Round 6 follow-up: restyled to modal-feel — flat page, eyebrow
// headings, lifted buttons, lighter status banners. Functional behavior
// unchanged.
// ============================================================================

import React from 'react';
import { playersApi, playerRankingsApi } from '../../api/firebase';
import { seedAliasesToFirestore } from '../../constants/nameAliases';
import { LIV_GOLF_ROSTER } from '../../constants';
import { M, SyncStatusBanner, LastSyncedLine, disabledBtn } from './adminStyles';

export const DataSyncPanel = ({
  allPlayers, setAllPlayers, teams,
  rankingsLastUpdated,
  settings, setSettings,
}) => {
  // ── OWGR sync state ──
  const [owgrStatus, setOwgrStatus] = React.useState(null);
  const [owgrSummary, setOwgrSummary] = React.useState('');
  const [owgrLastSynced, setOwgrLastSynced] = React.useState(null);

  // ── LIV sync state ──
  const [livSyncStatus, setLivSyncStatus] = React.useState(null);
  const [livSyncSummary, setLivSyncSummary] = React.useState('');
  const [livLastSynced, setLivLastSynced] = React.useState(() => settings?.livRosterLastSynced || null);

  // ── Alias sync state ──
  const [aliasSyncStatus, setAliasSyncStatus] = React.useState(null);
  const [aliasSyncSummary, setAliasSyncSummary] = React.useState('');

  const handleSyncOwgr = async () => {
    setOwgrStatus('fetching');
    setOwgrSummary('');
    try {
      const resp = await fetch('/api/owgr');
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'OWGR fetch failed');

      const cleanName = n => n.replace(/\s*\([^)]*\)\s*$/, '').trim();
      const fetched = (data.players || [])
        .map(({ name, worldRank }) => ({ name: cleanName(name), worldRank }))
        .filter(p => p.name && p.name.includes(' '));
      if (!fetched.length) throw new Error('No ranking data returned');

      let updatedPlayers = [...allPlayers];
      let updated = 0, added = 0;
      fetched.forEach(({ name, worldRank }) => {
        const idx = updatedPlayers.findIndex(p => p.name.toLowerCase() === name.toLowerCase());
        if (idx >= 0) { updatedPlayers[idx] = { ...updatedPlayers[idx], worldRank }; updated++; }
        else { updatedPlayers.push({ name, worldRank }); added++; }
      });
      await playersApi.upsertMany(fetched.map(({ name, worldRank }) => ({ name, worldRank })));

      // Also fetch ESPN IDs for all rostered players (for headshots)
      try {
        const allRostered = [...new Set(teams.flatMap(t => (t.roster || []).map(p => p.name)))];
        if (allRostered.length) {
          const hsResp = await fetch(`/api/headshots?names=${allRostered.map(n => encodeURIComponent(n)).join(',')}`);
          if (hsResp.ok) {
            const hsData = await hsResp.json();
            const toSave = Object.entries(hsData.results || {}).map(([name, espnId]) => ({ name, espnId }));
            if (toSave.length) await playersApi.upsertMany(toSave);
          }
        }
      } catch (_) { /* non-critical */ }

      setAllPlayers(updatedPlayers);
      await playerRankingsApi.setLastUpdated(new Date().toISOString()).catch(() => {});
      await playerRankingsApi.invalidateCache().catch(() => {});
      setOwgrLastSynced(new Date().toISOString());
      setOwgrStatus('done');
      setOwgrSummary(`✓ ${fetched.length} rankings synced · ${updated} updated · ${added} new`);
    } catch (err) {
      setOwgrStatus('error');
      setOwgrSummary(err.message || 'OWGR sync failed');
    }
  };

  const handleSyncLiv = async () => {
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
      setSettings({ ...settings, livRosterLastSynced: livTs }).catch(() => {});
      setLivSyncStatus('done');
      setLivSyncSummary(`✓ LIV roster synced · ${parts}`);
    } catch (err) {
      setLivSyncStatus('error');
      setLivSyncSummary(err.message || 'LIV sync failed');
    }
  };

  const handleSeedAliases = async () => {
    setAliasSyncStatus('fetching');
    setAliasSyncSummary('');
    try {
      const r = await seedAliasesToFirestore(playersApi);
      const parts = [
        r.added          > 0 ? `${r.added} added` : '',
        r.alreadyPresent > 0 ? `${r.alreadyPresent} already present` : '',
        r.skipped        > 0 ? `${r.skipped} skipped` : '',
      ].filter(Boolean).join(' · ') || 'no entries to process';
      const detail = r.errors.length ? '\n• ' + r.errors.join('\n• ') : '';
      setAliasSyncStatus(r.errors.length && r.added === 0 && r.alreadyPresent === 0 ? 'error' : 'done');
      setAliasSyncSummary(`✓ Static aliases synced · ${parts}${detail}`);
    } catch (err) {
      setAliasSyncStatus('error');
      setAliasSyncSummary(err.message || 'Alias sync failed');
    }
  };

  return (
    <div style={M.page}>
      <div style={M.descText}>
        Refresh data from external sources. Sync operations are idempotent — safe to re-run anytime.
      </div>

      {/* ── OWGR Rankings ── */}
      <div style={M.group}>
        <div style={M.eyebrow}>🌍 OWGR Rankings</div>
        <LastSyncedLine timestamp={owgrLastSynced || rankingsLastUpdated} />
        <button
          onClick={handleSyncOwgr}
          disabled={owgrStatus === 'fetching'}
          className="modal-feel-lift modal-feel-primary"
          style={{ ...M.btnPrimary, ...disabledBtn(owgrStatus === 'fetching') }}
        >
          {owgrStatus === 'fetching' ? '⏳ Fetching…' : '🔄 Sync OWGR Rankings'}
        </button>
        <SyncStatusBanner status={owgrStatus} summary={owgrSummary} />
      </div>

      {/* ── LIV Roster Sync ── */}
      <div style={M.group}>
        <div style={M.eyebrow}>🚫 LIV Golf Roster</div>
        <LastSyncedLine timestamp={livLastSynced || settings?.livRosterLastSynced} />
        <button
          onClick={handleSyncLiv}
          disabled={livSyncStatus === 'fetching'}
          className="modal-feel-lift modal-feel-primary"
          style={{ ...M.btnPrimary, ...disabledBtn(livSyncStatus === 'fetching') }}
        >
          {livSyncStatus === 'fetching' ? '⏳ Syncing…' : '🔄 Sync LIV Roster'}
        </button>
        <SyncStatusBanner status={livSyncStatus} summary={livSyncSummary} />
      </div>

      {/* ── Static Alias Sync ── */}
      <div style={M.group}>
        <div style={M.eyebrow}>🔗 Static Aliases</div>
        <div style={M.descText}>
          Copies the historical aliases hard-coded in <code style={{ fontFamily: 'monospace', fontSize: 11, opacity: 0.9 }}>nameAliases.js</code> into Firestore as dynamic aliases on each canonical player doc. Run once after deploying. New aliases going forward should use the Merge Players feature instead.
        </div>
        <button
          onClick={handleSeedAliases}
          disabled={aliasSyncStatus === 'fetching'}
          className="modal-feel-lift modal-feel-primary"
          style={{ ...M.btnPrimary, ...disabledBtn(aliasSyncStatus === 'fetching') }}
        >
          {aliasSyncStatus === 'fetching' ? '⏳ Syncing…' : '🔄 Sync Static Aliases'}
        </button>
        <SyncStatusBanner status={aliasSyncStatus} summary={aliasSyncSummary} />
      </div>
    </div>
  );
};
