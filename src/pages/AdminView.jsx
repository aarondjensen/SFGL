// src/pages/AdminView.jsx
// ============================================================================
// Wave I refactor: AdminView is a thin layout shell that wires panels together.
//
// Wave I.2:
//   • Dropped WaiverProcessingPanel — waivers are fully automated by
//     api/cron.js (Tuesday 8pm ET). Pending claims still visible in the
//     Transactions tab. The cron is the source of truth.
//   • TournamentResultsPanel now needs setTransactions to write the
//     auto-awarded swing winner transaction.
// ============================================================================

import React from 'react';

import { CollapsibleGroup }          from './admin/CollapsibleGroup';
import { TournamentResultsPanel }    from './admin/TournamentResultsPanel';
import { SwingWinnerPanel }          from './admin/SwingWinnerPanel';
import { DataSyncPanel }             from './admin/DataSyncPanel';
import { LivIneligiblePanel }        from './admin/LivIneligiblePanel';
import { MergePlayersPanel }         from './admin/MergePlayersPanel';
import { ManagerAccountsPanel }      from './admin/ManagerAccountsPanel';
import { SeasonSettingsPanel }       from './admin/SeasonSettingsPanel';

export const AdminView = ({
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
          setTransactions={setTransactions}
          globalPlayerStats={globalPlayerStats}
          setGlobalPlayerStats={setGlobalPlayerStats}
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
