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
import { useDialog } from '../DialogContext';

export const DataSyncPanel = ({
  allPlayers, setAllPlayers, teams,
  rankingsLastUpdated,
  settings, setSettings,
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
