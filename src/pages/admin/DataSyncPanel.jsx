// src/pages/admin/DataSyncPanel.jsx
// ============================================================================
// OWGR rankings sync + manual player add + transaction-fee repair.
//
//  • OWGR sync — refreshes world rankings. Also automated weekly via cron
//    (?action=owgr-rankings, Monday 2pm ET); this button is a "sync now"
//    override for off-cycle refreshes.
//
//  • Add Player Manually (NEW) — creates/updates a single /players/{name}
//    Firestore doc by hand. Used to surface a golfer who isn't in the OWGR
//    top-600 sync (fringe player, Monday qualifier, etc.) or to attach the
//    correct ESPN headshot ID to someone. Writes go straight through
//    playersApi.upsertMany (direct Firestore — no serverless function, so it
//    doesn't touch the 12-function cap). A live ESPN headshot preview lets the
//    commish confirm the ID points at the right golfer before saving.
//
//  • Repair Transaction Fees — restores the configured fee on completed
//    free-agent / waiver transactions that were saved with a $0 fee.
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
  transactions, setTransactions,
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
  // recommended — it's what drives the headshot. World rank is optional too,
  // but see the note in the UI: without a rank the player is findable via the
  // AddDropPlayerModal search box but won't appear in its top-50 browse list.
  const [addName, setAddName]       = React.useState('');
  const [addEspnId, setAddEspnId]   = React.useState('');
  const [addRank, setAddRank]       = React.useState('');
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
    // provided — upsertMany skips null/undefined espnId and treats a missing
    // worldRank as no-op, so partial records never clobber existing data.
    const record = { name: trimmedName };
    if (cleanEspnId) record.espnId = cleanEspnId;
    const parsedRank = parseInt(addRank, 10);
    if (Number.isFinite(parsedRank) && parsedRank > 0) record.worldRank = parsedRank;

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
          ...(record.worldRank !== undefined ? { worldRank: record.worldRank } : {}),
        };
      } else {
        next.push({
          name: trimmedName,
          worldRank: record.worldRank ?? null,
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
      bits.push(record.worldRank !== undefined ? `rank #${record.worldRank}` : 'unranked');
      setAddStatus('done');
      setAddSummary(`✓ ${existingPlayer ? 'Updated' : 'Added'} ${trimmedName} · ${bits.join(' · ')}`);
      dialog.showToast(`${existingPlayer ? 'Updated' : 'Added'} ${trimmedName}`, 'success');

      // Clear the form for the next entry.
      setAddName('');
      setAddEspnId('');
      setAddRank('');
    } catch (err) {
      setAddStatus('error');
      setAddSummary(err?.message || 'Add player failed');
      dialog.showToast('Add player failed', 'error');
    }
  };

  // ── One-time fee repair ───────────────────────────────────────────────────
  // Completed free-agent / waiver transactions should always carry their
  // configured fee. A type-mismatch in the manual Add Transaction modal
  // ('fa' vs 'free agent') previously saved some free-agent adds with a $0 fee,
  // which understated team fee totals and shrank the affected swing pots. This
  // finds those zero-fee adds and restores the correct fee. It only touches
  // transactions whose stored fee is exactly 0 (or missing) and never touches
  // failed/blocked records, so it can't overwrite an intentional amount.
  const [repairStatus, setRepairStatus] = React.useState(null);
  const [repairSummary, setRepairSummary] = React.useState('');

  const feeFA     = settings?.feeFA     ?? 1;
  const feeWaiver = settings?.feeWaiver ?? 2;

  const expectedFeeFor = (tx) => {
    if (tx.type === 'fa' || tx.type === 'free agent') return feeFA;
    if (tx.type === 'waiver') return feeWaiver;
    return null; // drop / mulligan / swing_winner etc. are legitimately fee-free
  };

  const findFeeRepairs = () => {
    const repairs = [];
    (transactions || []).forEach((tx, i) => {
      if (tx.status === 'failed') return;            // blocked/voided: no fee by design
      const expected = expectedFeeFor(tx);
      if (!expected || expected <= 0) return;
      const current = typeof tx.fee === 'number' ? tx.fee : 0;
      if (current !== 0) return;                      // only fix exactly-zero/missing fees
      repairs.push({ i, expected });
    });
    return repairs;
  };

  const handleRepairFees = async () => {
    const repairs = findFeeRepairs();
    if (!repairs.length) {
      dialog.showToast('No transactions need a fee repair', 'success');
      return;
    }

    // Build a per-team preview.
    const byTeam = {};
    let total = 0;
    repairs.forEach(({ i, expected }) => {
      const tx = transactions[i];
      const key = tx.team || '—';
      byTeam[key] = (byTeam[key] || 0) + expected;
      total += expected;
    });
    const teamLines = Object.entries(byTeam)
      .sort((a, b) => b[1] - a[1])
      .map(([team, amt]) => `• ${team}: +$${amt}`)
      .join('\n');

    const ok = await dialog.showConfirm(
      'Repair Transaction Fees',
      `${repairs.length} transaction${repairs.length !== 1 ? 's' : ''} ${repairs.length !== 1 ? 'have' : 'has'} a missing fee and will be corrected:\n\n${teamLines}\n\nTotal added: +$${total} across ${Object.keys(byTeam).length} team${Object.keys(byTeam).length !== 1 ? 's' : ''}.\n\nSwing pots that include these transactions recompute automatically. Swings already awarded won't be recalculated — re-check any swing-winner payouts for the affected swings.`,
      { confirmText: 'Repair Fees' }
    );
    if (!ok) return;

    try {
      setRepairStatus('working');
      setRepairSummary('');
      const fix = new Map(repairs.map(({ i, expected }) => [i, expected]));
      const updated = transactions.map((tx, i) => fix.has(i) ? { ...tx, fee: fix.get(i) } : tx);
      await setTransactions(updated);
      setRepairStatus('done');
      setRepairSummary(`Repaired ${repairs.length} transaction${repairs.length !== 1 ? 's' : ''} · +$${total} total`);
      dialog.showToast(`Repaired ${repairs.length} fee${repairs.length !== 1 ? 's' : ''} (+$${total})`, 'success');
    } catch (err) {
      setRepairStatus('error');
      setRepairSummary(err?.message || 'Repair failed');
      dialog.showToast('Fee repair failed', 'error');
    }
  };

  const pendingRepairCount = findFeeRepairs().length;

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
            style={M.input}
          />
        </div>

        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <label style={fieldLabel}>ESPN ID</label>
            <input
              type="text"
              inputMode="numeric"
              value={addEspnId}
              onChange={e => setAddEspnId(e.target.value)}
              placeholder="e.g. 4602673"
              style={M.input}
            />
            <label style={{ ...fieldLabel, marginTop: 12 }}>World Rank (optional)</label>
            <input
              type="text"
              inputMode="numeric"
              value={addRank}
              onChange={e => setAddRank(e.target.value)}
              placeholder="e.g. 85"
              style={M.input}
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
            : 'No rank? The player is still findable in the Add/Drop search box, but won\u2019t appear in its top-50 browse list until ranked.'}
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

      <div style={M.group}>
        <div style={M.eyebrow}>🧾 Repair Transaction Fees</div>
        <div style={M.descText}>
          Restores the configured fee on any completed free-agent or waiver
          transaction that was saved with a $0 fee. Only zero-fee records are
          touched; failed/blocked transactions are left alone.
        </div>
        <div style={M.descText}>
          {pendingRepairCount > 0
            ? `${pendingRepairCount} transaction${pendingRepairCount !== 1 ? 's' : ''} currently need repair.`
            : 'No transactions currently need repair.'}
        </div>
        <button
          onClick={handleRepairFees}
          disabled={repairStatus === 'working' || pendingRepairCount === 0}
          className="modal-feel-lift"
          style={{ ...M.btnSecondary, ...disabledBtn(repairStatus === 'working' || pendingRepairCount === 0) }}
        >
          {repairStatus === 'working' ? '⏳ Repairing…' : '🧾 Preview & Repair Fees'}
        </button>
        <SyncStatusBanner status={repairStatus} summary={repairSummary} />
      </div>
    </div>
  );
};
