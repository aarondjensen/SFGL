import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { Search } from 'lucide-react';
import { useDialog } from './DialogContext';
import { AddDropPlayerModal } from './AddDropPlayerModal';
import { MulliganModal } from './MulliganModal';
import { useRoster, useWindowStatus } from '../hooks';
import {
  getSortedRoster, shortName, getPlayerHeadshot, getPlayerHeadshotFallback,
  getTeamAbbreviation, getLineupStatus, getFreeAgentWindowStatus, getWaiverWindowStatus,
  isPastRoundStart, getSegmentByDate, isTournamentLocked,
} from '../utils';
import { MAX_LIMITED_STARTS, LINEUP_SIZE } from '../constants';

// ─── Waiver Priority Manager ───────────────────────────────────────────────
const WaiverQueue = ({ team, pendingWaivers, transactions, setTransactions, updateTeams, teams, isOwnTeam }) => {
  const dialog = useDialog();

  const swapPriority = (fromIdx, toIdx) => {
    if (toIdx < 0 || toIdx >= pendingWaivers.length) return;
    const updated    = [...transactions];
    const fromTxIdx  = pendingWaivers[fromIdx]._txIdx;
    const toTxIdx    = pendingWaivers[toIdx]._txIdx;
    const fromPri    = pendingWaivers[fromIdx].priority || fromIdx + 1;
    const toPri      = pendingWaivers[toIdx].priority   || toIdx + 1;
    updated[fromTxIdx] = { ...updated[fromTxIdx], priority: toPri };
    updated[toTxIdx]   = { ...updated[toTxIdx],   priority: fromPri };
    setTransactions(updated);
  };

  if (pendingWaivers.length === 0) return null;

  return (
    <div className="bg-yellow-600/20 border border-yellow-600/50 rounded-xl p-3">
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-bold text-yellow-300 text-sm flex items-center gap-2">
          ⏰ Pending Waiver Claims ({pendingWaivers.length})
        </h3>
        <div className="text-xs text-yellow-300">Processed Tue 8pm ET</div>
      </div>
      {pendingWaivers.length > 1 && isOwnTeam && (
        <div className="text-xs text-gray-400 mb-2">↕ Use arrows to set priority — #1 processes first</div>
      )}
      <div className="space-y-2">
        {pendingWaivers.map((waiver, index) => (
          <div key={waiver._txIdx} className="bg-gray-800/50 rounded-lg p-2 flex items-center gap-2">
            {isOwnTeam && pendingWaivers.length > 1 && (
              <div className="flex flex-col gap-0.5">
                <button onClick={() => swapPriority(index, index - 1)} disabled={index === 0}
                  className={`text-xs px-1 rounded ${index === 0 ? 'text-gray-600 cursor-not-allowed' : 'text-yellow-400 hover:bg-yellow-600/20'}`}>▲</button>
                <div className="text-[10px] text-yellow-400 font-bold text-center">{index + 1}</div>
                <button onClick={() => swapPriority(index, index + 1)} disabled={index === pendingWaivers.length - 1}
                  className={`text-xs px-1 rounded ${index === pendingWaivers.length - 1 ? 'text-gray-600 cursor-not-allowed' : 'text-yellow-400 hover:bg-yellow-600/20'}`}>▼</button>
              </div>
            )}
            <div className="flex-1 text-sm">
              <span className="text-green-400 font-medium">Add: {waiver.player}</span>
              {waiver.droppedPlayer && (
                <><span className="text-gray-500 mx-1">→</span><span className="text-red-400">Drop: {waiver.droppedPlayer}</span></>
              )}
              <div className="text-xs text-gray-400 mt-0.5">${waiver.fee} fee · {waiver.segment || 'Current Swing'}</div>
            </div>
            {isOwnTeam && (
              <div className="flex gap-1">
                <button
                  onClick={() => {
                    // Revert fee and re-open the modal pre-filled
                    setTransactions(transactions.filter((_, i) => i !== waiver._txIdx));
                    updateTeams(teams.map(t => t.id === team.id ? { ...t, transactionFees: (t.transactionFees || 0) - waiver.fee } : t));
                    // Parent handles re-opening via editingWaiverData
                  }}
                  className="px-2 py-1 bg-blue-600 hover:bg-blue-700 rounded text-xs font-medium"
                >✏️</button>
                <button
                  onClick={async () => {
                    const ok = await dialog.showConfirm('Delete Waiver', `Delete waiver claim for ${waiver.player}?`, { type: 'danger', confirmText: 'Delete' });
                    if (!ok) return;
                    setTransactions(transactions.filter((_, i) => i !== waiver._txIdx));
                    updateTeams(teams.map(t => t.id === team.id ? { ...t, transactionFees: (t.transactionFees || 0) - waiver.fee } : t));
                  }}
                  className="px-2 py-1 bg-red-600 hover:bg-red-700 rounded text-xs font-medium"
                >✕</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

// ─── Main RostersView ──────────────────────────────────────────────────────
export const RostersView = ({
  teams, selectedTeam, setSelectedTeam, updateTeams,
  tournaments, allPlayers, transactions, setTransactions,
  settings, loggedInUser, isCommissioner, globalPlayerStats, headshots,
}) => {
  const [lineupMode,        setLineupMode]        = useState(false);
  const [showAddDropModal,  setShowAddDropModal]  = useState(false);
  const [isWaiverMode,      setIsWaiverMode]      = useState(false);
  const [editingWaiverData, setEditingWaiverData] = useState(null);
  const [showMulliganModal, setShowMulliganModal] = useState(false);
  const [globalSearch,      setGlobalSearch]      = useState('');
  const dialog = useDialog();

  const activeTournament      = tournaments.find(t => t.playing);
  const activeTournamentIndex = activeTournament ? tournaments.findIndex(t => t.name === activeTournament.name) : -1;

  // Default to logged-in user's team
  useEffect(() => {
    if (!selectedTeam && teams.length > 0) {
      const userTeam = loggedInUser ? teams.find(t => t.owner === loggedInUser) : null;
      setSelectedTeam(userTeam?.id ?? teams[0].id);
    }
  }, [selectedTeam, teams, loggedInUser, setSelectedTeam]);

  const team         = teams.find(t => t.id === selectedTeam);
  const currentRoster = useRoster(team, transactions, activeTournamentIndex);
  const windowStatus  = useWindowStatus(activeTournament);
  const isOwnTeam     = (loggedInUser && team?.owner === loggedInUser) || isCommissioner;

  // ── Global player search ──────────────────────────────────────────────────
  const searchResults = useMemo(() => {
    if (!globalSearch.trim()) return [];
    const term = globalSearch.toLowerCase();
    const allPlayerMap = new Map(allPlayers.map(p => [p.name, { ...p, owner: 'Free Agent' }]));
    teams.forEach(t => {
      t.roster.forEach(rp => {
        if (allPlayerMap.has(rp.name)) allPlayerMap.get(rp.name).owner = t.name;
        else allPlayerMap.set(rp.name, { name: rp.name, worldRank: 999, owner: t.name });
      });
    });
    return [...allPlayerMap.values()]
      .filter(p => p.name.toLowerCase().includes(term))
      .sort((a, b) => a.worldRank - b.worldRank);
  }, [globalSearch, allPlayers, teams]);

  // ── Lineup toggle ─────────────────────────────────────────────────────────
  const togglePlayerInLineup = useCallback(async (player) => {
    if (!team) return;
    const isInLineup = team.lineup.includes(player.name);
    if (!isInLineup && team.lineup.length >= LINEUP_SIZE) {
      dialog.showToast(`You can only have ${LINEUP_SIZE} starters`, 'error'); return;
    }
    if (!isInLineup && player.limited && player.starts >= MAX_LIMITED_STARTS) {
      dialog.showToast('This player has reached their 12-start limit', 'error'); return;
    }
    updateTeams(teams.map(t => {
      if (t.id !== team.id) return t;
      const newLineup = isInLineup
        ? t.lineup.filter(p => p !== player.name)
        : [...t.lineup, player.name];
      return { ...t, lineup: newLineup };
    }));
  }, [team, teams, updateTeams, dialog]);

  // ── Mulligan ──────────────────────────────────────────────────────────────
  const handleMulliganConfirm = useCallback(({ playerOut, playerIn, afterRound, isSignatureOrMajor }) => {
    const mulliganKey = isSignatureOrMajor ? 'signatureMajor' : 'regular';
    const newLineup   = team.lineup.map(p => p === playerOut ? playerIn : p);
    const updatedRoster = team.roster.map(p => {
      if (p.name === playerOut && p.limited) return { ...p, starts: Math.max(0, p.starts - 1) };
      if (p.name === playerIn  && p.limited) return { ...p, starts: p.starts + 1 };
      return p;
    });
    const newMulligans = { ...team.mulligans, [mulliganKey]: (team.mulligans?.[mulliganKey] || 1) - 1 };
    updateTeams(teams.map(t =>
      t.id === team.id ? { ...t, lineup: newLineup, roster: updatedRoster, mulligans: newMulligans } : t,
    ));
    setTransactions(prev => [...prev, {
      team: team.name, type: 'mulligan', player: playerIn, droppedPlayer: playerOut,
      fee: 0, segment: settings.currentSegment || '', date: new Date().toLocaleDateString(),
      tournamentIndex: activeTournamentIndex, status: 'completed',
      mulliganType: isSignatureOrMajor ? 'signature/major' : 'regular',
      afterRound, tournament: activeTournament.name,
    }]);
    dialog.showToast(`Mulligan used: ${playerOut} → ${playerIn}`, 'success');
  }, [team, teams, updateTeams, setTransactions, activeTournament, activeTournamentIndex, settings, dialog]);

  const handleUndoMulligan = async (tx) => {
    const ok = await dialog.showConfirm(
      'Undo Mulligan',
      `Undo mulligan?\n\nThis will restore ${tx.droppedPlayer} to your lineup and return ${tx.player} to the bench. Your mulligan will be restored.`,
      { confirmText: 'Undo Mulligan' },
    );
    if (!ok) return;
    const newLineup      = team.lineup.map(p => p === tx.player ? tx.droppedPlayer : p);
    const updatedRoster  = team.roster.map(p => {
      if (p.name === tx.player      && p.limited) return { ...p, starts: Math.max(0, p.starts - 1) };
      if (p.name === tx.droppedPlayer && p.limited) return { ...p, starts: p.starts + 1 };
      return p;
    });
    const mulliganKey    = tx.mulliganType === 'signature/major' ? 'signatureMajor' : 'regular';
    const newMulligans   = { ...team.mulligans, [mulliganKey]: (team.mulligans?.[mulliganKey] || 0) + 1 };
    updateTeams(teams.map(t => t.id === team.id ? { ...t, lineup: newLineup, roster: updatedRoster, mulligans: newMulligans } : t));
    setTransactions(prev => prev.filter(t => t !== tx));
    dialog.showToast('Mulligan successfully undone', 'success');
  };

  // ── Derived mulligan state ────────────────────────────────────────────────
  const isSignatureOrMajor  = activeTournament?.isSignature || activeTournament?.isMajor;
  const mulliganKey         = isSignatureOrMajor ? 'signatureMajor' : 'regular';
  const mulliganRemaining   = team?.mulligans?.[mulliganKey] ?? 0;
  const activeMulliganTx    = activeTournamentIndex >= 0
    ? transactions.find(tx => tx.type === 'mulligan' && tx.team === team?.name && tx.tournamentIndex === activeTournamentIndex)
    : null;
  const canUndoMulligan     = activeMulliganTx && !isPastRoundStart(activeTournament, activeMulliganTx.afterRound + 1);

  // Pending waivers with stable indices into the full transactions array
  const pendingWaivers = useMemo(() => {
    if (!team) return [];
    return transactions
      .map((t, idx) => ({ ...t, _txIdx: idx }))
      .filter(t => t.team === team.name && t.type === 'waiver' && t.status === 'pending')
      .sort((a, b) => (a.priority || 999) - (b.priority || 999));
  }, [team, transactions]);

  if (!team) return null;

  const lineupOpen         = windowStatus.lineupOpen;
  const canEditLineup      = isOwnTeam && (lineupOpen || isCommissioner);
  const lineupStatus       = getLineupStatus(activeTournament);
  const faStatus           = getFreeAgentWindowStatus(activeTournament);
  const waiverStatus       = getWaiverWindowStatus();
  const lineupPlayers      = currentRoster.filter(p => team.lineup.includes(p.name));
  const benchPlayers       = currentRoster.filter(p => !team.lineup.includes(p.name));

  const renderMulliganButton = () => {
    const etDay       = new Date().getDay(); // raw local — close enough for day-of-week display
    const isMulliganDay = etDay >= 4 && etDay <= 6;
    let btnLabel, btnIcon, btnAction, isDisabled, statusText, statusColor;

    if (activeMulliganTx) {
      btnLabel = 'Undo Mull.'; btnIcon = '↩️';
      if (canUndoMulligan) {
        statusText = '🟢 Undo available'; statusColor = 'text-blue-400';
        btnAction = () => handleUndoMulligan(activeMulliganTx); isDisabled = false;
      } else {
        statusText = '🔴 Locked'; statusColor = 'text-gray-500'; isDisabled = true;
      }
    } else {
      btnLabel = 'Mulligan'; btnIcon = '🚨'; btnAction = () => setShowMulliganModal(true);
      if (mulliganRemaining === 0)     { statusText = `🔴 ${isSignatureOrMajor ? 'Signature' : 'Regular'} used`; statusColor = 'text-gray-500'; isDisabled = true; }
      else if (!isMulliganDay)          { statusText = '🔴 Thu–Sat only'; statusColor = 'text-gray-500'; isDisabled = true; }
      else if (!isOwnTeam || !activeTournament || team.lineup.length === 0)
                                        { statusText = '🔴 Unavailable'; statusColor = 'text-gray-500'; isDisabled = true; }
      else                              { statusText = `🟢 ${isSignatureOrMajor ? 'Signature' : 'Regular'}`; statusColor = 'text-gray-300'; isDisabled = false; }
    }

    return (
      <div className="flex flex-col items-center gap-1">
        <button
          onClick={btnAction}
          disabled={isDisabled}
          className={`w-full h-14 flex flex-col items-center justify-center px-1 rounded-lg font-medium transition-colors text-[11px] sm:text-xs text-center leading-none sm:leading-tight ${
            !isDisabled
              ? activeMulliganTx
                ? 'bg-gray-800 text-blue-400 border border-blue-500/40 hover:bg-blue-600/10'
                : 'bg-gray-800 text-gray-300 border border-gray-500/40 hover:bg-gray-600/10'
              : 'bg-gray-800 text-gray-500 border border-gray-700 cursor-not-allowed'
          }`}
        >
          <span>{btnLabel}</span>
          <span className="mt-0.5">{btnIcon}</span>
        </button>
        <span className={`text-[9px] leading-tight text-center ${statusColor}`}>{statusText}</span>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {/* Team selector + lineup summary */}
      <div className="bg-gradient-to-r from-green-600/20 to-gray-800/50 backdrop-blur rounded-xl border border-green-700/30 p-2">
        <div className="flex items-center justify-between mb-2 gap-2">
          <div className="flex items-center gap-1 flex-1 min-w-0">
            <select
              value={selectedTeam || ''}
              onChange={e => { setSelectedTeam(e.target.value); setLineupMode(false); }}
              className="bg-gray-800 text-base font-bold border border-gray-600 rounded-lg outline-none cursor-pointer px-2 py-1 pr-7 max-w-[140px] sm:max-w-[200px] truncate hover:border-green-500 transition-colors"
            >
              {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            {loggedInUser && !isOwnTeam && (
              <span className="px-1.5 py-0.5 bg-gray-600 text-gray-300 rounded text-[10px] whitespace-nowrap">View Only</span>
            )}
          </div>
          <div className="relative flex-shrink-0 w-36 sm:w-48">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
            <input
              type="text"
              placeholder="Search player..."
              value={globalSearch}
              onChange={e => setGlobalSearch(e.target.value)}
              className="w-full bg-gray-900 border border-gray-600 rounded-lg pl-8 pr-2 py-1.5 text-xs text-white focus:outline-none focus:border-green-500 transition-colors"
            />
          </div>
        </div>

        {/* Current lineup headshots */}
        {team.lineup.length > 0 ? (
          <div className="flex justify-center gap-4 sm:gap-6 pt-2 border-t border-gray-700/50">
            {getSortedRoster(currentRoster)
              .filter(p => team.lineup.includes(p.name))
              .map(player => {
                const lastName  = player.name.split(' ').pop();
                const nameClass = lastName.length > 9 ? 'text-[9px]' : lastName.length > 7 ? 'text-[10px]' : 'text-xs';
                return (
                  <div key={player.name} className="flex flex-col items-center w-[52px] sm:w-[72px]">
                    <img
                      src={getPlayerHeadshot(player.name, player.limited, headshots)}
                      onError={e => { e.target.onerror = null; e.target.src = getPlayerHeadshotFallback(player.name, player.limited); }}
                      alt=""
                      className={`w-10 h-10 sm:w-12 sm:h-12 flex-shrink-0 rounded-full object-cover border-2 ${
                        player.limited ? 'border-yellow-500' : player.unlimited ? 'border-blue-500' : 'border-green-500'
                      }`}
                    />
                    <div className={`${nameClass} font-medium mt-0.5 text-center w-full h-4 flex items-center justify-center truncate ${
                      player.limited ? 'text-yellow-400' : player.unlimited ? 'text-blue-400' : ''
                    }`}>{lastName}</div>
                  </div>
                );
              })}
          </div>
        ) : (
          <div className="text-gray-500 text-xs text-center pt-2 border-t border-gray-700/50">No lineup set</div>
        )}
      </div>

      {/* Waiver queue */}
      <WaiverQueue
        team={team} pendingWaivers={pendingWaivers} transactions={transactions}
        setTransactions={setTransactions} updateTeams={updateTeams} teams={teams}
        isOwnTeam={isOwnTeam}
      />

      {/* Action buttons + roster table */}
      <div className="bg-gray-800/50 backdrop-blur rounded-xl border border-green-700/30 overflow-hidden">
        <div className="p-2 bg-gradient-to-r from-green-600/20 to-transparent border-b border-green-700/30">
          {activeTournament && (
            <div className="mb-2 px-1 truncate">
              <span className="text-blue-300 font-semibold text-sm">{activeTournament.name}</span>
              <span className="text-gray-400 text-xs ml-2">· {activeTournament.dates}</span>
            </div>
          )}

          <div className="grid grid-cols-4 gap-1.5 sm:gap-2">
            {/* Lineup button */}
            <div className="flex flex-col items-center gap-1">
              <button
                onClick={() => { if (lineupMode && team.lineup.length === 0) return; setLineupMode(!lineupMode); }}
                disabled={!canEditLineup || (lineupMode && team.lineup.length === 0)}
                className={`w-full h-14 flex flex-col items-center justify-center px-1 rounded-lg font-medium transition-all text-[11px] sm:text-xs text-center leading-none sm:leading-tight ${
                  !canEditLineup
                    ? 'bg-gray-800 text-gray-500 border border-gray-700 cursor-not-allowed'
                    : lineupMode
                      ? team.lineup.length > 0
                        ? 'bg-green-600 text-white border border-green-500 hover:bg-green-700 shadow-md shadow-green-600/30'
                        : 'bg-gray-800 text-gray-500 border border-gray-700 cursor-not-allowed'
                      : isCommissioner && !lineupOpen
                        ? 'bg-gray-800 text-red-400 border border-red-600/40 hover:bg-red-600/10'
                        : 'bg-gray-800 text-blue-400 border border-blue-600/40 hover:bg-blue-600/10'
                }`}
              >
                <span>{lineupMode ? '✓ Save' : 'Lineup'}</span>
                {!lineupMode && <span className="mt-0.5">{isCommissioner && isTournamentLocked(activeTournament) ? '🔓' : isTournamentLocked(activeTournament) ? '🔒' : '✏️'}</span>}
              </button>
              <span className={`text-[9px] leading-tight text-center ${lineupStatus.open ? 'text-blue-400' : 'text-gray-500'}`}>
                {lineupStatus.label}
              </span>
            </div>

            {/* Free agent button */}
            <div className="flex flex-col items-center gap-1">
              <button
                onClick={() => { setIsWaiverMode(false); setShowAddDropModal(true); }}
                disabled={!isOwnTeam || !windowStatus.faOpen}
                className={`w-full h-14 flex flex-col items-center justify-center px-1 rounded-lg font-medium transition-colors text-[11px] sm:text-xs text-center leading-none sm:leading-tight ${
                  isOwnTeam && windowStatus.faOpen
                    ? 'bg-gray-800 text-green-400 border border-green-600/40 hover:bg-green-600/10'
                    : 'bg-gray-800 text-gray-500 border border-gray-700 cursor-not-allowed'
                }`}
              >
                <span>Free Agent</span><span className="mt-0.5">🏌️</span>
              </button>
              <span className={`text-[9px] leading-tight text-center ${faStatus.open ? 'text-green-400' : 'text-gray-500'}`}>
                {faStatus.open ? `🟢 ${faStatus.label}` : `🔴 ${faStatus.label}`}
              </span>
            </div>

            {/* Waiver button */}
            <div className="flex flex-col items-center gap-1">
              <button
                onClick={() => { setIsWaiverMode(true); setShowAddDropModal(true); }}
                disabled={!isOwnTeam || !windowStatus.waiverOpen}
                className={`w-full h-14 flex flex-col items-center justify-center px-1 rounded-lg font-medium transition-colors text-[11px] sm:text-xs text-center leading-none sm:leading-tight ${
                  isOwnTeam && windowStatus.waiverOpen
                    ? 'bg-gray-800 text-yellow-400 border border-yellow-600/40 hover:bg-yellow-600/10'
                    : 'bg-gray-800 text-gray-500 border border-gray-700 cursor-not-allowed'
                }`}
              >
                <span>Waiver</span><span className="mt-0.5">⏰</span>
              </button>
              <span className={`text-[9px] leading-tight text-center ${waiverStatus.open ? 'text-yellow-400' : 'text-gray-500'}`}>
                {waiverStatus.open ? '🟢 until Tue 7:59pm' : '🔴 until Sun 9pm'}
              </span>
            </div>

            {/* Mulligan button */}
            {renderMulliganButton()}
          </div>
        </div>

        {/* Player table — global search OR roster */}
        {globalSearch.trim().length > 0 ? (
          <div>
            <div className="px-2 py-1.5 bg-gray-700/50 text-xs font-bold text-gray-400 border-b border-gray-700">
              Global Search Results ({searchResults.length})
            </div>
            <table className="w-full text-sm" role="table">
              <thead className="bg-gray-700/50 sticky top-0">
                <tr>
                  <th className="px-2 py-1.5 text-left text-xs"                  scope="col">Player</th>
                  <th className="px-2 py-1.5 text-center hidden sm:table-cell text-xs" scope="col">Events</th>
                  <th className="px-2 py-1.5 text-center hidden sm:table-cell text-xs" scope="col">Cuts</th>
                  <th className="px-2 py-1.5 text-right text-xs"                 scope="col">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700/50">
                {searchResults.slice(0, 50).map(player => (
                  <tr key={player.name} className="hover:bg-gray-700/30 transition-colors">
                    <td className="px-2 py-1.5">
                      <div className="flex items-center gap-2">
                        <img
                          src={getPlayerHeadshot(player.name, player.limited, headshots)}
                          onError={e => { e.target.onerror = null; e.target.src = getPlayerHeadshotFallback(player.name, player.limited); }}
                          alt="" className="w-8 h-8 flex-shrink-0 rounded-full object-cover border border-gray-600"
                        />
                        <div className="min-w-0">
                          <div className="font-semibold text-xs text-gray-300">{player.name}</div>
                          <div className="text-[10px] text-gray-500">#{player.worldRank === 999 ? 'NR' : player.worldRank}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-2 py-1.5 text-center hidden sm:table-cell text-xs text-gray-300">{globalPlayerStats[player.name]?.eventsPlayed || 0}</td>
                    <td className="px-2 py-1.5 text-center hidden sm:table-cell text-xs text-gray-300">{globalPlayerStats[player.name]?.cutsMade || 0}</td>
                    <td className="px-2 py-1.5 text-right text-xs">
                      {player.owner === 'Free Agent'
                        ? <span className="text-green-400 font-medium">Free Agent</span>
                        : <span className="text-gray-400 font-medium">{getTeamAbbreviation(player.owner)}</span>}
                    </td>
                  </tr>
                ))}
                {searchResults.length === 0 && (
                  <tr><td colSpan="4" className="text-center py-6 text-gray-500 text-xs">No matching players found</td></tr>
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <table className="w-full text-sm" role="table">
            <thead className="bg-gray-700/50 sticky top-0">
              <tr>
                <th className="px-2 py-1.5 text-left text-xs"                        scope="col">Player</th>
                <th className="px-2 py-1.5 text-center hidden sm:table-cell text-xs"  scope="col">Events</th>
                <th className="px-2 py-1.5 text-center hidden sm:table-cell text-xs"  scope="col">Cuts</th>
                <th className="px-2 py-1.5 text-right hidden md:table-cell text-xs"   scope="col">PGA $</th>
                <th className="px-2 py-1.5 text-right text-xs"                        scope="col">SFGL $</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-700/50">
              {getSortedRoster(currentRoster).map(player => {
                const isInLineup    = team.lineup.includes(player.name);
                const canAddToLineup = team.lineup.length < LINEUP_SIZE && (!player.limited || player.starts < MAX_LIMITED_STARTS);
                const hasLineup     = team.lineup.length > 0;
                const isBenched     = hasLineup && !isInLineup && !lineupMode;
                return (
                  <tr key={player.name} className={`transition-colors ${isBenched ? '' : 'hover:bg-gray-700/30'}`}>
                    <td className="px-2 py-1.5">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => lineupMode && isOwnTeam && (isInLineup || canAddToLineup) && togglePlayerInLineup(player)}
                          className={`relative ${lineupMode && isOwnTeam && (isInLineup || canAddToLineup) ? 'cursor-pointer' : 'cursor-default'}`}
                          disabled={!lineupMode || !isOwnTeam || (!isInLineup && !canAddToLineup)}
                        >
                          <img
                            src={getPlayerHeadshot(player.name, player.limited, headshots)}
                            onError={e => { e.target.onerror = null; e.target.src = getPlayerHeadshotFallback(player.name, player.limited); }}
                            alt=""
                            className={`w-8 h-8 flex-shrink-0 rounded-full object-cover transition-all ${
                              lineupMode
                                ? isInLineup
                                  ? `border-4 opacity-100 ${player.limited ? 'border-yellow-500' : player.unlimited ? 'border-blue-500' : 'border-green-500'}`
                                  : canAddToLineup
                                    ? 'border-2 border-gray-400 opacity-60 hover:opacity-100 hover:border-green-300'
                                    : 'border border-gray-600 opacity-40'
                                : isBenched
                                  ? 'border border-gray-600 opacity-40'
                                  : isInLineup
                                    ? `border-2 ${player.limited ? 'border-yellow-500' : player.unlimited ? 'border-blue-500' : 'border-green-500'}`
                                    : `border ${player.limited ? 'border-yellow-500' : player.unlimited ? 'border-blue-500' : 'border-gray-600'}`
                            }`}
                          />
                          {lineupMode && isInLineup && (
                            <div className={`absolute -top-1 -right-1 w-4 h-4 rounded-full flex items-center justify-center ${player.limited ? 'bg-yellow-500' : player.unlimited ? 'bg-blue-500' : 'bg-green-500'}`}>
                              <span className="text-white text-xs font-bold">✓</span>
                            </div>
                          )}
                        </button>
                        <div className="min-w-0">
                          <div className={`font-semibold flex items-center gap-1 flex-wrap text-xs ${isBenched ? 'text-gray-500' : player.limited ? 'text-yellow-400' : player.unlimited ? 'text-blue-400' : ''}`}>
                            {player.name}
                            {player.limited   && <span className={isBenched ? 'text-gray-500 text-xs' : 'text-yellow-400 text-xs'}>{'⭐'.repeat(player.stars || 1)}</span>}
                            {player.unlimited && <span className={isBenched ? 'text-gray-500 text-xs' : 'text-blue-400 text-xs'}>♾️</span>}
                          </div>
                          <div className={`text-[10px] ${isBenched ? 'text-gray-600' : 'text-gray-400'}`}>
                            {player.limited && <span className={isBenched ? 'text-gray-500' : 'text-yellow-400'}>{player.starts}/{MAX_LIMITED_STARTS} starts</span>}
                            {player.yearsOfService > 1 && <span className="ml-1">(Yr {player.yearsOfService})</span>}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className={`px-2 py-1.5 text-center hidden sm:table-cell text-xs ${isBenched ? 'text-gray-500' : 'text-gray-300'}`}>{globalPlayerStats[player.name]?.eventsPlayed || 0}</td>
                    <td className={`px-2 py-1.5 text-center hidden sm:table-cell text-xs ${isBenched ? 'text-gray-500' : 'text-gray-300'}`}>{globalPlayerStats[player.name]?.cutsMade || 0}</td>
                    <td className={`px-2 py-1.5 text-right hidden md:table-cell text-xs ${isBenched ? 'text-gray-500' : 'text-gray-300'}`}>${(globalPlayerStats[player.name]?.pgaTourEarnings || 0).toLocaleString()}</td>
                    <td className={`px-2 py-1.5 text-right font-medium text-xs ${isBenched ? 'text-gray-500' : 'text-green-400'}`}>${(player.sfglEarnings || 0).toLocaleString()}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Modals */}
      <MulliganModal
        isOpen={showMulliganModal}
        onClose={() => setShowMulliganModal(false)}
        team={team}
        activeTournament={activeTournament}
        isSignatureOrMajor={isSignatureOrMajor}
        lineupPlayers={lineupPlayers}
        benchPlayers={benchPlayers}
        onConfirm={handleMulliganConfirm}
      />

      <AddDropPlayerModal
        isOpen={showAddDropModal}
        onClose={() => { setShowAddDropModal(false); setEditingWaiverData(null); }}
        team={team}
        currentRoster={currentRoster}
        allPlayers={allPlayers}
        teams={teams}
        updateTeams={updateTeams}
        transactions={transactions}
        setTransactions={setTransactions}
        isWaiverMode={isWaiverMode}
        activeTournamentIndex={activeTournamentIndex}
        editingWaiverData={editingWaiverData}
      />
    </div>
  );
};
