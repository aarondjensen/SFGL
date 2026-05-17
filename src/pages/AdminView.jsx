// src/pages/admin/DataSyncPanel.jsx
// ============================================================================
// OWGR rankings sync. Single-purpose panel now — LIV roster sync moved into
// LivIneligiblePanel where the rest of LIV management lives, and the
// one-shot Static Aliases migration was removed (served its purpose; the
// Merge Players feature handles new aliases going forward).
//
// OWGR is also automated weekly via cron (?action=owgr-rankings, Monday 2pm
// ET), so this button is now primarily a "sync now" override for off-cycle
// refreshes.
// ============================================================================

import React from 'react';
import { playersApi, playerRankingsApi } from '../../api/firebase';
import { M, SyncStatusBanner, LastSyncedLine, disabledBtn } from './adminStyles';

export const DataSyncPanel = ({
  allPlayers, setAllPlayers, teams,
  rankingsLastUpdated,
  settings, setSettings,
}) => {
  // The "last synced" timestamp lives in settings.owgrLastSynced (same
  // pattern as livRosterLastSynced) so it survives page reloads via the
  // settings subscription. We previously persisted to a separate
  // app_metadata/players_last_updated doc, but useLeague doesn't subscribe
  // to that doc — so the prop never refreshed after a sync. The settings
  // path is the reliable source. We still call setLastUpdated() on the old
  // doc for backward compat with any reader that hasn't migrated yet.
  const [owgrStatus, setOwgrStatus] = React.useState(null);
  const [owgrSummary, setOwgrSummary] = React.useState('');
  const [owgrLastSynced, setOwgrLastSynced] = React.useState(() => settings?.owgrLastSynced || null);

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

      // Also fetch ESPN IDs for all rostered players (for headshots).
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
      const owgrTs = new Date().toISOString();
      // Back-compat: keep updating the legacy app_metadata doc so any old
      // reader still gets a value. The authoritative source going forward
      // is settings.owgrLastSynced, written below.
      await playerRankingsApi.setLastUpdated(owgrTs).catch(() => {});
      await playerRankingsApi.invalidateCache().catch(() => {});
      setOwgrLastSynced(owgrTs);
      setSettings({ ...settings, owgrLastSynced: owgrTs }).catch(() => {});
      setOwgrStatus('done');
      setOwgrSummary(`✓ ${fetched.length} rankings synced · ${updated} updated · ${added} new`);
    } catch (err) {
      setOwgrStatus('error');
      setOwgrSummary(err.message || 'OWGR sync failed');
    }
  };

  return (
    <div style={M.page}>
      <div style={M.descText}>
        Refresh OWGR world rankings. Runs automatically every Monday at 2pm ET — use this button to force an off-cycle refresh.
      </div>

      <div style={M.group}>
        <div style={M.eyebrow}>🌍 OWGR Rankings</div>
        <LastSyncedLine timestamp={owgrLastSynced || settings?.owgrLastSynced || rankingsLastUpdated} />
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
    </div>
  );
};
