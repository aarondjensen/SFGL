// src/pages/AdminView.jsx
// ============================================================================
// Wave I refactor: AdminView is now a thin layout shell that wires panels
// together. The previous 1615-line monolith has been split into:
//
//   admin/CollapsibleGroup.jsx       — accordion wrapper (with localStorage state)
//   admin/adminStyles.js             — shared S tokens + Sync banners
//   admin/processTournamentData.js   — pure helper for result processing
//   admin/TournamentResultsPanel.jsx — fetch / process / reprocess flows
//   admin/WaiverProcessingPanel.jsx  — pending claims + tiebreaker UI
//   admin/SwingWinnerPanel.jsx       — pot calculation + award
//   admin/DataSyncPanel.jsx          — OWGR + LIV + Aliases sync (3 buttons)
//   admin/LivIneligiblePanel.jsx     — flag/unflag LIV defectors
//   admin/MergePlayersPanel.jsx      — player name merge
//   admin/ManagerAccountsPanel.jsx   — credentials + emails
//   admin/SeasonSettingsPanel.jsx    — bonuses + fees + waiver schedule + draft
//
// All cross-panel state has been pushed into the panels themselves.
// AdminView only orchestrates layout.
// ============================================================================

import React from 'react';

import { CollapsibleGroup }          from './admin/CollapsibleGroup';
import { TournamentResultsPanel }    from './admin/TournamentResultsPanel';
import { WaiverProcessingPanel }     from './admin/WaiverProcessingPanel';
import { SwingWinnerPanel }          from './admin/SwingWinnerPanel';
import { DataSyncPanel }             from './admin/DataSyncPanel';
import { LivIneligiblePanel }        from './admin/LivIneligiblePanel';
import { MergePlayersPanel }         from './admin/MergePlayersPanel';
import { ManagerAccountsPanel }      from './admin/ManagerAccountsPanel';
import { SeasonSettingsPanel }       from './admin/SeasonSettingsPanel';

export const AdminView = ({
  // (isCommissioner / setIsCommissioner / setActiveTab were always present
  // in the props but never used inside AdminView — visibility of this view is
  // controlled by App.jsx. Kept on the signature for backward compat.)
  isCommissioner: _isCommissioner,
  setIsCommissioner: _setIsCommissioner,
  setActiveTab: _setActiveTab,

  settings, setSettings,
  teams, updateTeams,
  tournaments, setTournaments,
  transactions, setTransactions,
  allPlayers, setAllPlayers,
  globalPlayerStats, setGlobalPlayerStats,
  headshots, setHeadshots: _setHeadshots,
  updateRankings: _updateRankings,
  rankingsLastUpdated,
  STORAGE_KEYS,
}) => {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 40 }}>

      {/* ── 1. Tournament Operations ──────────────────────────────────────── */}
      <CollapsibleGroup title="Tournament Operations" icon="🏆">
        <TournamentResultsPanel
          tournaments={tournaments}
          setTournaments={setTournaments}
          teams={teams}
          updateTeams={updateTeams}
          transactions={transactions}
          globalPlayerStats={globalPlayerStats}
          setGlobalPlayerStats={setGlobalPlayerStats}
          STORAGE_KEYS={STORAGE_KEYS}
        />
        <WaiverProcessingPanel
          transactions={transactions}
          setTransactions={setTransactions}
          teams={teams}
          updateTeams={updateTeams}
          settings={settings}
          STORAGE_KEYS={STORAGE_KEYS}
        />
        <SwingWinnerPanel
          tournaments={tournaments}
          teams={teams}
          transactions={transactions}
          setTransactions={setTransactions}
          updateTeams={updateTeams}
          STORAGE_KEYS={STORAGE_KEYS}
        />
      </CollapsibleGroup>

      {/* ── 2. Data Sync ──────────────────────────────────────────────────── */}
      <CollapsibleGroup title="Data Sync" icon="🔄">
        <DataSyncPanel
          allPlayers={allPlayers}
          setAllPlayers={setAllPlayers}
          teams={teams}
          rankingsLastUpdated={rankingsLastUpdated}
          settings={settings}
          setSettings={setSettings}
        />
        <LivIneligiblePanel
          allPlayers={allPlayers}
          setAllPlayers={setAllPlayers}
        />
        <MergePlayersPanel
          allPlayers={allPlayers}
          teams={teams}
          transactions={transactions}
          updateTeams={updateTeams}
          setTransactions={setTransactions}
          STORAGE_KEYS={STORAGE_KEYS}
        />
      </CollapsibleGroup>

      {/* ── 3. Manager Accounts ───────────────────────────────────────────── */}
      <CollapsibleGroup title="Manager Accounts" icon="👥">
        <ManagerAccountsPanel
          teams={teams}
          settings={settings}
          setSettings={setSettings}
        />
      </CollapsibleGroup>

      {/* ── 4. League Settings ────────────────────────────────────────────── */}
      <CollapsibleGroup title="League Settings" icon="⚙️">
        <SeasonSettingsPanel
          settings={settings}
          setSettings={setSettings}
          teams={teams}
          allPlayers={allPlayers}
          updateTeams={updateTeams}
          headshots={headshots}
        />
      </CollapsibleGroup>

    </div>
  );
};
