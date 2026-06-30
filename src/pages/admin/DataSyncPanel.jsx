// src/pages/admin/DataSyncPanel.jsx
// ============================================================================
// OWGR rankings sync + manual player add.
//
//  • OWGR sync — refreshes world rankings. Also automated weekly via cron
//    (?action=owgr-rankings, Monday 5pm ET); this button is a "sync now"
//    override for off-cycle refreshes.
//
//  • Add Player Manually — creates/updates a single /players/{name}
//    Firestore doc by hand. Used to surface a golfer who isn't in the OWGR
//    top-600 sync (fringe player, Monday qualifier, etc.) or to attach the
//    correct ESPN headshot ID to someone. Writes go straight through
//    playersApi.upsertMany (direct Firestore — no serverless function, so it
//    doesn't touch the 12-function cap). A live ESPN headshot preview lets the
//    commish confirm the ID points at the right golfer before saving.
//
// The one-time "Repair Transaction Fees" tool was removed once the underlying
// 'fa' vs 'free agent' fee-type mismatch was fixed at the source.
//
// LIV roster sync lives in LivIneligiblePanel; the one-shot Static Aliases
// migration was removed (Merge Players handles new aliases going forward).
// ============================================================================

import React from 'react';
import { playersApi, playerRankingsApi } from '../../api/firebase';
import { colors, fonts } from '../../theme.js';
import { M, SyncStatusBanner, LastSyncedLine, disabledBtn } from './adminStyles';
import { useDialog } from '../DialogContext';

// ESPN headshot base — same URL the rest of the app resolves IDs against
// (see utils/headshotUtils.js). A numeric ESPN athlete ID becomes:
//   https://a.espncdn.com/i/headshots/golf/players/full/{id}.png
const ESPN_HEADSHOT_BASE = 'https://a.espncdn.com/i/headshots/golf/players/full';

export const DataSyncPanel = ({
  allPlayers, setAllPlayers, teams,
  rankingsLastUpdated,
  settings, setSettings,
  setHeadshots,
}) => {
  const dialog = useDialog();

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

  // ── Manual add player ───────────────────────────────────────────────────────
  // Adds (or updates) a single player doc by hand. Persists through the same
  // playersApi.upsertMany path the OWGR sync uses, so alias resolution and the
  // players_last_updated stamp are handled for us. ESPN ID is optional but
  // recommended — it's what drives the headshot. World rank is intentionally
  // not set here; the weekly OWGR sync assigns it.
  const [addName, setAddName]       = React.useState('');
  const [addEspnId, setAddEspnId]   = React.useState('');
  const [addStatus, setAddStatus]   = React.useState(null);
  const [addSummary, setAddSummary] = React.useState('');

  // ESPN IDs are numeric — strip anything else so a pasted profile URL
  // fragment or stray space doesn't break the headshot lookup.
  const cleanEspnId = (addEspnId || '').replace(/\D/g, '');
  const trimmedName = (addName || '').trim();

  // Does a player with this name already exist (case-insensitive)? If so the
  // save is an update/merge rather than a brand-new add.
  const existingPlayer = React.useMemo(() => {
    if (!trimmedName) return null;
    return (allPlayers || []).find(
      p => p.name && p.name.toLowerCase() === trimmedName.toLowerCase()
    ) || null;
  }, [allPlayers, trimmedName]);

  const canAdd = trimmedName.length > 0 && addStatus !== 'saving';

  const handleAddPlayer = async () => {
    if (!trimmedName) {
      setAddStatus('error');
      setAddSummary('Enter a player name.');
      return;
    }

    // Build the upsert record. Only include fields the commish actually
    // provided — upsertMany skips null/undefined espnId so partial records
    // never clobber existing data. World rank is left to the OWGR sync.
    const record = { name: trimmedName };
    if (cleanEspnId) record.espnId = cleanEspnId;

    // Confirm when overwriting an existing player so a typo'd name that
    // collides with someone real can't silently edit them.
    if (existingPlayer) {
      const ok = await dialog.showConfirm(
        'Player Already Exists',
        `"${existingPlayer.name}" is already in the database. Saving will update that player ` +
        `with the values you entered (blank fields are left unchanged). Continue?`,
        { confirmText: 'Update Player' }
      );
      if (!ok) return;
    }

    try {
      setAddStatus('saving');
      setAddSummary('');

      await playersApi.upsertMany([record]);

      // Reflect locally so the new/updated player shows immediately without a
      // full reload — mirrors handleSyncOwgr's in-memory merge.
      let next = [...(allPlayers || [])];
      const idx = next.findIndex(
        p => p.name && p.name.toLowerCase() === trimmedName.toLowerCase()
      );
      if (idx >= 0) {
        next[idx] = {
          ...next[idx],
          name: trimmedName,
          ...(record.espnId   !== undefined ? { espnId: record.espnId } : {}),
        };
      } else {
        next.push({
          name: trimmedName,
          espnId: record.espnId ?? null,
          isLiv: false,
        });
      }
      setAllPlayers(next);

      // Update the in-memory headshot map so the avatar resolves right away.
      // setHeadshots === useLeague.updateHeadshots, which accepts a functional
      // merge updater and persists the merged map. Map value = ESPN ID string.
      if (cleanEspnId && typeof setHeadshots === 'function') {
        setHeadshots(prev => ({ ...(prev || {}), [trimmedName]: cleanEspnId }));
      }

      // Drop the cached player list so the next consumer re-reads Firestore.
      await playerRankingsApi.invalidateCache().catch(() => {});

      const bits = [];
      bits.push(cleanEspnId ? `ESPN ID ${cleanEspnId}` : 'no ESPN ID');
      setAddStatus('done');
      setAddSummary(`✓ ${existingPlayer ? 'Updated' : 'Added'} ${trimmedName} · ${bits.join(' · ')}`);
      dialog.showToast(`${existingPlayer ? 'Updated' : 'Added'} ${trimmedName}`, 'success');

      // Clear the form for the next entry.
      setAddName('');
      setAddEspnId('');
    } catch (err) {
      setAddStatus('error');
      setAddSummary(err?.message || 'Add player failed');
      dialog.showToast('Add player failed', 'error');
    }
  };

  // Small gold uppercase field label, matching the SeasonSettingsPanel sub-label
  // treatment so the manual-add fields read as part of the same design system.
  const fieldLabel = {
    fontFamily: fonts.sans,
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '1px',
    textTransform: 'uppercase',
    color: colors.textGold,
    marginBottom: 6,
    display: 'block',
  };

  return (
    <div style={M.page}>
      <div style={M.descText}>
        Refresh OWGR world rankings. Runs automatically every Monday at 5pm ET — use this button to force an off-cycle refresh.
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

      {/* ── Manual add player ── */}
      <div style={M.group}>
        <div style={M.eyebrow}>➕ Add Player Manually</div>
        <div style={M.descText}>
          Create or update a single player in the database — handy for a golfer
          who isn't in the OWGR top-600 sync, or to attach the right headshot.
          The ESPN ID is the number in the player's ESPN profile URL
          (espn.com/golf/player/_/id/<b>1234567</b>) and drives the headshot.
        </div>

        <div>
          <label style={fieldLabel}>Player Name</label>
          <input
            type="text"
            value={addName}
            onChange={e => setAddName(e.target.value)}
            placeholder="e.g. Michael Thorbjornsen"
            style={{ ...M.input, boxSizing: 'border-box' }}
          />
        </div>

        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <label style={fieldLabel}>ESPN ID</label>
            <input
              type="text"
              inputMode="numeric"
              value={addEspnId}
              onChange={e => setAddEspnId(e.target.value)}
              placeholder="e.g. 4602673"
              style={{ ...M.input, boxSizing: 'border-box' }}
            />
          </div>

          {/* Live headshot preview — lets the commish confirm the ID resolves
              to the correct golfer before saving. */}
          <div style={{ width: 76, flexShrink: 0, textAlign: 'center' }}>
            <label style={fieldLabel}>Preview</label>
            <div
              style={{
                width: 72,
                height: 72,
                borderRadius: '50%',
                overflow: 'hidden',
                border: `1px solid ${colors.borderSubtle}`,
                background: 'rgba(255,255,255,0.03)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto',
              }}
            >
              {cleanEspnId ? (
                <img
                  key={cleanEspnId}
                  src={`${ESPN_HEADSHOT_BASE}/${cleanEspnId}.png`}
                  alt="ESPN headshot preview"
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  onError={e => { e.currentTarget.style.display = 'none'; }}
                  onLoad={e => { e.currentTarget.style.display = 'block'; }}
                />
              ) : (
                <span style={{ fontSize: 22, opacity: 0.4 }}>👤</span>
              )}
            </div>
          </div>
        </div>

        <div style={{ ...M.descText, color: colors.textMuted }}>
          {existingPlayer
            ? `⚠ "${existingPlayer.name}" already exists — saving will update them (blank fields left as-is).`
            : 'Added players are findable in the Add/Drop search box right away. They join its ranked browse list once the next OWGR sync assigns a world rank.'}
        </div>

        <button
          onClick={handleAddPlayer}
          disabled={!canAdd}
          className="modal-feel-lift modal-feel-primary"
          style={{ ...M.btnPrimary, ...disabledBtn(!canAdd) }}
        >
          {addStatus === 'saving'
            ? '⏳ Saving…'
            : existingPlayer ? '➕ Update Player' : '➕ Add Player'}
        </button>
        <SyncStatusBanner status={addStatus === 'saving' ? 'working' : addStatus} summary={addSummary} />
      </div>
    </div>
  );
};
