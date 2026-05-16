import React, { useMemo } from 'react';
import { useDialog } from './DialogContext';
import { getSegmentForTournament } from '../utils';
import { sfglDataApi, playersApi, teamsApi } from '../api/firebase';
// (DraftModal import removed — now used only by SeasonSettingsPanel.)
// (seedAliasesToFirestore and LIV_GOLF_ROSTER imports removed — now used
//  only by DataSyncPanel.)
// (BONUSES_REGULAR/BONUSES_MAJOR/normalizePlayerName/SWINGS/getSegmentByDate/
//  tournamentResultsApi imports removed — now only used by extracted panels,
//  not AdminView itself. Batch 3g swap.)
import { theme, colors, fonts } from '../theme.js';
import { STORAGE_KEYS } from '../constants';

// Wave I cleanup: CollapsibleGroup and the admin S/disabledBtn style tokens
// used to live inline in this file. They've been moved to siblings in the
// ./admin/ subfolder so other panels (DataSyncPanel, etc.) can share them as
// we wire them up. CollapsibleGroup supports an optional `badge` prop for
// showing pending counts on the group header — Tournament Operations uses it
// for the "N pending" waiver count.
import { CollapsibleGroup } from './admin/CollapsibleGroup';
import { S, disabledBtn } from './admin/adminStyles';
import { DataSyncPanel } from './admin/DataSyncPanel';
import { LivIneligiblePanel } from './admin/LivIneligiblePanel';
import { ManagerAccountsPanel } from './admin/ManagerAccountsPanel';
import { MergePlayersPanel } from './admin/MergePlayersPanel';
import { ScheduleImportPanel } from './admin/ScheduleImportPanel';
import { SeasonSettingsPanel } from './admin/SeasonSettingsPanel';
import { SwingWinnerPanel } from './admin/SwingWinnerPanel';
import { TournamentResultsPanel } from './admin/TournamentResultsPanel';
import { WaiverProcessingPanel } from './admin/WaiverProcessingPanel';

// ── Effective-roster helper ─────────────────────────────────────────────────
// Used by the useMemo below to feed TournamentResultsPanel a roster snapshot
// that matches what RostersView shows — current team.roster augmented by any
// processed transactions that haven't synced back into team.roster yet.
// Mirrors the same logic used by AddDropPlayerModal (lines 195-203 in
// /mnt/project) and RostersView's useRoster hook so the three views agree on
// roster contents.
//
// Strategy: start from team.roster as the baseline (persisted live roster),
// then apply every processed-or-completed transaction for this team.
// Idempotent for synced data; corrective for de-synced data (e.g. a waiver
// was processed but team.roster hasn't been written back to Firestore yet).
//
// Permissive on matching to avoid edge cases where team names have trailing
// whitespace or case mismatches between transaction records and team docs.
const getEffectiveRoster = (team, allTransactions) => {
  if (!team) return [];
  const teamKey = String(team.name || '').trim().toLowerCase();
  // Only keep roster entries with a usable string name; downstream code
  // sorts by name and crashes on undefined/non-string values.
  let roster = (team.roster || []).filter(p => p && typeof p.name === 'string' && p.name.length > 0);
  // Defensive copy so we don't mutate the prop
  roster = roster.map(p => ({ ...p }));

  (allTransactions || [])
    .filter(tx => {
      // Match team (normalized for whitespace/case)
      if (String(tx.team || '').trim().toLowerCase() !== teamKey) return false;
      // Exclude transaction types that don't represent roster changes
      if (tx.type === 'mulligan') return false;       // lineup swap, not roster
      if (tx.type === 'swing_winner') return false;   // tx.player is owner name, not a player
      // Exclude pending (not yet effective) and failed (didn't go through)
      if (tx.status === 'pending') return false;
      if (tx.status === 'failed')  return false;
      return true;
    })
    .sort((a, b) => (a.tournamentIndex ?? 0) - (b.tournamentIndex ?? 0))
    .forEach(tx => {
      // Drop first, then add — handles add-then-drop and drop-then-readd
      // sequences correctly when sorted by tournament index.
      if (tx.droppedPlayer && typeof tx.droppedPlayer === 'string') {
        roster = roster.filter(p => p.name !== tx.droppedPlayer);
      }
      // Only accept string player values, never undefined/objects/etc.
      if (typeof tx.player === 'string' && tx.player.length > 0 && !roster.some(p => p.name === tx.player)) {
        roster.push({ name: tx.player, limited: !!tx.limited });
      }
    });

  return roster;
};

export const AdminView = ({
  isCommissioner, setIsCommissioner, setActiveTab,
  settings, setSettings,
  teams, updateTeams,
  tournaments, setTournaments,
  transactions, setTransactions,
  allPlayers, setAllPlayers, globalPlayerStats, setGlobalPlayerStats,
  headshots, setHeadshots,
  updateRankings, rankingsLastUpdated,
}) => {
  // (selectedTourney, manualEntry, pgaFetching state + the active-tournament
  //  useEffect ALL moved into ./admin/TournamentResultsPanel — Batch 3g swap)
  // (mgCred* state moved into ./admin/ManagerAccountsPanel — Batch 3d extraction)
  // (showDraftModal moved into ./admin/SeasonSettingsPanel — the panel
  // owns the "Open Draft Room" button and renders the modal itself.)
  // (swingAwardSeg moved into ./admin/SwingWinnerPanel — Batch 3f extraction)
  // (waiverRevealed moved into ./admin/WaiverProcessingPanel — Batch 3h extraction)
  // (livSearch / livSaving used to live here. They moved INTO
  // ./admin/LivIneligiblePanel — only that panel reads them, so the
  // state belongs there.)
  const dialog = useDialog();

  // ── Effective roster snapshot ──
  // The TournamentResultsPanel's lineup editor needs the same roster
  // RostersView shows — current team.roster augmented by any processed
  // transactions that haven't synced back into team.roster yet. Without
  // this, players added via waivers mid-week are invisible in the lineup
  // dropdowns even though RostersView displays them. See getEffectiveRoster's
  // comment for details. Computed here so it's memoized once per teams+tx
  // change, then passed down to the panel as a prop.
  const rostersByTeamIdForSelectedTourney = useMemo(() => {
    const map = {};
    const safeTeams = Array.isArray(teams) ? teams : [];
    const safeTx    = Array.isArray(transactions) ? transactions : [];
    safeTeams.forEach(t => {
      if (!t || !t.id) return;
      try {
        map[t.id] = getEffectiveRoster(t, safeTx);
      } catch (err) {
        // Catch keeps a single bad team from crashing the whole editor.
        console.warn('[AdminView] roster snapshot failed for', t.name, err);
        map[t.id] = t.roster || [];
      }
    });
    return map;
  }, [teams, transactions]);

  // (S and disabledBtn used to be defined here inline. They moved to
  // ./admin/adminStyles.jsx — see imports at the top of this file. The
  // tokens are identical to what was here; only the source location changed.)



  // ── Results: PGA Tour fetch ───────────────────────────────────────

  // ── Results: manual entry ────────────────────────────────────────────────

  // ── Results: reprocess completed tournament ─────────────────────────────

  // ── Resend results email for an already-completed tournament ─────────────
  // Used when (a) the auto-cron email failed to render properly, or (b) the
  // commish wants to test changes to the email template without waiting for
  // next Monday. Doesn't touch any data — only re-fires the email via the
  // notify-results endpoint, which has no same-day lockout.



  // ── Waivers ──────────────────────────────────────────────────────────────
  // buildRoster, applyWaiver, handleProcessSingle, handleProcessAll, and
  // the waiverRevealed state ALL moved into ./admin/WaiverProcessingPanel
  // (Batch 3h). The panel computes `pending` internally; AdminView also
  // computes it once below so it can pass `${pending.length} pending` as
  // a badge on the Tournament Operations CollapsibleGroup header (so the
  // commish sees the attention-needed count before expanding).

  // ── Manager Login ────────────────────────────────────────────────────────
  // handleSetLogin moved into ./admin/ManagerAccountsPanel (Batch 3d)

  // ── Award Swing Winner ──────────────────────────────────────────────────
  // handleSwingWinner + swingAwardSeg state moved into ./admin/SwingWinnerPanel
  // (Batch 3f). The panel uses computeSwingAward from utils/swingAward.js
  // (same helper the auto-award path uses) — single source of truth.

  // ── Data sync state/handlers ─────────────────────────────────────────────
  // OWGR, PGAT Stats, Headshot Rebuild, LIV Roster, and Static Alias sync are
  // ALL extracted into ./admin/DataSyncPanel.jsx (Batch 3e). The panel owns
  // its own state and uses the SyncStatusBanner/LastSyncedLine helpers from
  // ./admin/adminStyles for visual consistency.

  // ── Merge Players ─────────────────────────────────────────────────────────
  const [mergeOpen, setMergeOpen] = useState(false);

  // ── Season / Waiver / Results / Draft state + handlers ────────────────────
  // All moved INTO ./admin/SeasonSettingsPanel.jsx. The panel owns the editor
  // state for season settings, waiver schedule, results email schedule, and
  // the draft modal toggle. AdminView no longer needs to declare or save them.
  //
  // The persisted values still live on `settings` (Firestore), so anywhere
  // outside the panel that needs them reads via `settings.waiverDay ?? 2`
  // (see e.g. the "process now!" banner in the WaiverProcessingPanel area).
  //
  // DAY_NAMES and fmtETTime are now imported from utils/sharedHelpers.js
  // (was duplicated inline before).
  // (emailDraft state moved into ./admin/ManagerAccountsPanel — Batch 3d)


  const pending = transactions.map((tx, i) => ({ ...tx, _idx: i })).filter(tx => tx.status === 'pending' && tx.type === 'waiver');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 40 }}>

      <CollapsibleGroup
        title="Tournament Operations"
        icon="🏆"
        badge={pending.length > 0 ? `${pending.length} pending` : undefined}
      >

      {/* ── 1. Tournament Results ── */}
      <TournamentResultsPanel
        tournaments={tournaments}
        setTournaments={setTournaments}
        teams={teams}
        updateTeams={updateTeams}
        transactions={transactions}
        setTransactions={setTransactions}
        globalPlayerStats={globalPlayerStats}
        setGlobalPlayerStats={setGlobalPlayerStats}
        settings={settings}
        rostersByTeamId={rostersByTeamIdForSelectedTourney}
      />

      {/* ── 2. Process Waivers ── */}
      <WaiverProcessingPanel
        transactions={transactions}
        setTransactions={setTransactions}
        teams={teams}
        updateTeams={updateTeams}
        tournaments={tournaments}
        settings={settings}
      />

      {/* ── 4. Award Swing Winner ── */}
      <SwingWinnerPanel
        tournaments={tournaments}
        teams={teams}
        transactions={transactions}
        setTransactions={setTransactions}
      />
      </CollapsibleGroup>

      <CollapsibleGroup title="Data Sync" icon="🔄">
      <DataSyncPanel
        allPlayers={allPlayers}
        setAllPlayers={setAllPlayers}
        teams={teams}
        rankingsLastUpdated={rankingsLastUpdated}
        settings={settings}
        setSettings={setSettings}
        setHeadshots={setHeadshots}
      />

      {/* ── 6. LIV Golf Ineligible Players ── */}
      {/* Extracted to ./admin/LivIneligiblePanel.jsx in Wave I cleanup.
          The panel renders its own S.section wrapper + title; AdminView
          just hands it the player list and a setter. */}
      <LivIneligiblePanel allPlayers={allPlayers} setAllPlayers={setAllPlayers} />

      {/* ── 7. Draft ── */}
      {/* ── Merge Players ── */}
      <div style={S.section}>
        <button onClick={() => setMergeOpen(o => !o)}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
          <div style={S.title}>🔀 Merge Players</div>
          <span style={{ fontFamily: fonts.sans, fontSize: 11, color: colors.textMuted, paddingBottom: 12 }}>{mergeOpen ? '▲' : '▼'}</span>
        </button>
        {mergeOpen && <MergePlayersPanel
          allPlayers={allPlayers} teams={teams} transactions={transactions}
          updateTeams={updateTeams} setTransactions={setTransactions}
        />}
      </div>
      </CollapsibleGroup>

      <CollapsibleGroup title="Manager Accounts" icon="👥">
      <ManagerAccountsPanel teams={teams} settings={settings} setSettings={setSettings} />
      {/* ── Commissioner Status ── */}
      <div style={S.section}>
        <div style={S.title}>👑 Commissioner Status</div>
        <div style={{ ...theme.smallText, color: colors.textSecondary, marginBottom: 12 }}>
          Tag managers as commissioners. Tagged managers see the Commish tab automatically when logged in — no password required.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {teams.map(t => {
            const tagged = !!t.isCommissioner;
            return (
              <label key={t.id} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 10px',
                background: tagged ? 'rgba(245,197,24,0.06)' : 'transparent',
                border: `1px solid ${tagged ? 'rgba(245,197,24,0.3)' : colors.borderSubtle}`,
                borderRadius: 4,
                cursor: 'pointer',
                transition: 'background 0.15s, border-color 0.15s',
              }}>
                <input
                  type="checkbox"
                  checked={tagged}
                  onChange={e => {
                    const next = e.target.checked;
                    const newTeams = teams.map(tt =>
                      tt.id === t.id ? { ...tt, isCommissioner: next } : tt
                    );
                    updateTeams(newTeams);
                    dialog.showToast(
                      next
                        ? `${t.name} is now a commissioner`
                        : `${t.name} is no longer a commissioner`,
                      'success'
                    );
                  }}
                  style={{ accentColor: colors.textGold, width: 16, height: 16, cursor: 'pointer', flexShrink: 0 }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: fonts.sans, fontSize: 13, fontWeight: 600, color: colors.textPrimary }}>
                    {t.name}
                  </div>
                  <div style={{ fontFamily: fonts.sans, fontSize: 11, color: colors.textMuted }}>
                    {t.owner}
                  </div>
                </div>
                {tagged && (
                  <span style={{
                    fontFamily: fonts.sans, fontSize: 9, fontWeight: 700,
                    letterSpacing: '1px', textTransform: 'uppercase',
                    color: 'rgba(245,197,24,0.95)',
                    border: '1px solid rgba(245,197,24,0.4)',
                    padding: '2px 6px', borderRadius: 2,
                    flexShrink: 0,
                  }}>
                    Commish
                  </span>
                )}
              </label>
            );
          })}
        </div>
      </div>
      </CollapsibleGroup>

      <CollapsibleGroup title="League Settings" icon="⚙️">
      {/* All four sections (Season Settings, Waiver Schedule, Results Email
          Schedule, Draft) are now rendered by SeasonSettingsPanel — Wave I
          extraction. The panel also owns the DraftModal lifecycle, so AdminView
          no longer has a `showDraftModal` state or trailing `<DraftModal />`
          render at the bottom of this view. */}
      <SeasonSettingsPanel
        settings={settings}
        setSettings={setSettings}
        teams={teams}
        allPlayers={allPlayers}
        updateTeams={updateTeams}
        headshots={headshots}
      />
      {/* ── Schedule Import ──
          Bulk-import a season's PGA Tour schedule from pgatour.com. Used at
          season rollover to populate the new year's tournaments without
          typing each one by hand. */}
      <ScheduleImportPanel
        tournaments={tournaments}
        setTournaments={setTournaments}
      />
      </CollapsibleGroup>
    </div>
  );
};

