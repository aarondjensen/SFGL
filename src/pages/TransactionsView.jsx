import React, { useState, useMemo } from 'react';
import { X, Edit2 } from 'lucide-react';
import { useDialog } from './DialogContext';
import { getSegmentByDate, getSegmentForTournament, makePlayer, getTeamAbbreviation, abbreviateName as shortName } from '../utils/index.js';
import { theme, colors, fonts, fontSize, getSwingColor } from '../theme.js';
import { useModalBehaviorAlways } from '../utils/modalUtils';

// shortName imported from utils (see abbreviateName)

// ── Inline edit modal ─────────────────────────────────────────────────────────
const EditTransactionModal = ({ tx, txIndex, teams, tournaments, allPlayers, transactions, setTransactions, updateTeams, onClose }) => {
  const dialog = useDialog();

  // ── Escape key + body scroll lock (shared) ────────────────────────────────
  useModalBehaviorAlways(onClose);

  // Derive initial values from the transaction
  const [editTeam,   setEditTeam]   = useState(tx.team);
  const [editAdd,    setEditAdd]    = useState(tx.player || '');
  const [editDrop,   setEditDrop]   = useState(tx.droppedPlayer || '');
  const [editTourneyIdx, setEditTourneyIdx] = useState(tx.tournamentIndex != null ? String(tx.tournamentIndex) : '');
  const [addSearch,  setAddSearch]  = useState('');
  const [saving,     setSaving]     = useState(false);

  const team = teams.find(t => t.name === editTeam);

  // All players not currently on any roster (available to be added)
  const rosteredNames = useMemo(() => {
    const s = new Set();
    teams.forEach(t => t.roster.forEach(p => s.add(p.name)));
    // Also include the original tx.player so it stays in the list even if on a roster
    return s;
  }, [teams]);

  const availableToAdd = useMemo(() => {
    return allPlayers.filter(p =>
      p.name && typeof p.name === 'string' && !/^\d+$/.test(p.name.trim()) &&
      (!rosteredNames.has(p.name) || p.name === tx.player) // keep original selectable
    );
  }, [allPlayers, rosteredNames, tx.player]);

  const filteredAdd = addSearch.trim()
    ? availableToAdd.filter(p => p.name.toLowerCase().includes(addSearch.toLowerCase()))
    : [];

  const currentRoster = team?.roster || [];
  // Droppable: all roster players except Limited, plus the original dropped player
  const droppableRoster = currentRoster.filter(p => !p.limited || p.name === tx.droppedPlayer);

  const canSave = editAdd.trim() && (!tx.droppedPlayer || editDrop.trim());

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);

    // Build old and new state
    const oldAdd  = tx.player;
    const oldDrop = tx.droppedPlayer;
    const newAdd  = editAdd.trim();
    const newDrop = editDrop.trim() || null;
    const oldTeam = tx.team;
    const newTeam = editTeam;

    // Update the transaction record
    const newTourneyIdx = editTourneyIdx !== '' ? parseInt(editTourneyIdx) : tx.tournamentIndex;
    const updatedTx = transactions.map((t, i) =>
      i === txIndex
        ? { ...t, team: newTeam, player: newAdd, droppedPlayer: newDrop || undefined, tournamentIndex: newTourneyIdx, segment: tournaments[newTourneyIdx]?.segment || t.segment }
        : t
    );

    // Patch the old team's roster: undo old change, apply new change
    let updatedTeams = teams.map(t => {
      // Reverse old transaction on old team
      if (t.name === oldTeam) {
        let r = [...t.roster];
        // Remove the old added player
        r = r.filter(p => p.name !== oldAdd);
        // Re-add the old dropped player (if there was one)
        if (oldDrop && !r.some(p => p.name === oldDrop)) r.push(makePlayer(oldDrop));
        return { ...t, roster: r };
      }
      return t;
    });

    updatedTeams = updatedTeams.map(t => {
      // Apply new transaction on new team
      if (t.name === newTeam) {
        let r = [...t.roster];
        // Remove new dropped player
        if (newDrop) r = r.filter(p => p.name !== newDrop);
        // Add new added player
        if (!r.some(p => p.name === newAdd)) r.push(makePlayer(newAdd));
        return { ...t, roster: r };
      }
      return t;
    });

    setTransactions(updatedTx);
    updateTeams(updatedTeams);

    setSaving(false);
    dialog.showToast('Transaction updated', 'success');
    onClose();
  };

  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'rgba(5,10,25,0.85)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 16, zIndex: 60,
    }}>
      <div style={{
        background: '#0f1d35',
        border: `2px solid rgba(100,160,255,0.5)`,
        borderRadius: 4, width: '100%', maxWidth: 460,
        maxHeight: '80vh', display: 'flex', flexDirection: 'column',
      }}>
        {/* Header */}
        <div style={{
          padding: '14px 18px',
          background: 'rgba(100,160,255,0.08)',
          borderBottom: `1px solid ${colors.borderSubtle}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexShrink: 0,
        }}>
          <div>
            <h2 style={{ fontFamily: fonts.serif, fontSize: fontSize.lg, color: 'rgba(150,190,255,0.9)', margin: 0 }}>
              ✏️ Edit Transaction
            </h2>
            <p style={{ ...theme.smallText, marginTop: 2 }}>
              {tx.type} · {tx.date}
            </p>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.textSecondary, padding: 4 }}>
            <X style={{ width: 18, height: 18 }} />
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0 }}>

          {/* Team selector */}
          <div>
            <label style={{ ...theme.label, display: 'block', marginBottom: 5 }}>Team</label>
            <select
              value={editTeam}
              onChange={e => { setEditTeam(e.target.value); setEditDrop(''); }}
              style={{ ...theme.select, colorScheme: 'dark' }}
              onFocus={e => e.target.style.borderColor = colors.borderFocus}
              onBlur={e => e.target.style.borderColor = colors.borderInput}
            >
              {teams.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
            </select>
          </div>

          {/* Tournament selector */}
          <div>
            <label style={{ ...theme.label, display: 'block', marginBottom: 5 }}>Tournament</label>
            <select
              value={editTourneyIdx}
              onChange={e => setEditTourneyIdx(e.target.value)}
              style={{ ...theme.select, colorScheme: 'dark' }}
              onFocus={e => e.target.style.borderColor = colors.borderFocus}
              onBlur={e => e.target.style.borderColor = colors.borderInput}
            >
              <option value="">—</option>
              {tournaments.map((t, i) => <option key={i} value={i}>{t.name}</option>)}
            </select>
          </div>

          {/* Player added */}
          <div>
            <label style={{ ...theme.label, display: 'block', marginBottom: 5 }}>
              Player Added
              <span style={{ color: colors.success, marginLeft: 6, fontWeight: 400 }}>{editAdd || '—'}</span>
            </label>
            <input
              type="text"
              placeholder="Search free agents…"
              value={addSearch}
              onChange={e => setAddSearch(e.target.value)}
              style={{ ...theme.input, marginBottom: 6 }}
              onFocus={e => { e.target.style.borderColor = colors.borderFocus; e.target.style.background = colors.inputBgFocus; }}
              onBlur={e => { e.target.style.borderColor = colors.borderInput; e.target.style.background = colors.inputBg; }}
            />
            <div style={{ maxHeight: 150, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 3 }}>
              {filteredAdd.map(p => {
                const sel = editAdd === p.name;
                return (
                  <div
                    key={p.name}
                    onClick={() => setEditAdd(p.name)}
                    style={{
                      padding: '7px 10px', borderRadius: 2, cursor: 'pointer',
                      background: sel ? 'rgba(80,180,120,0.15)' : 'rgba(255,255,255,0.03)',
                      border: `1px solid ${sel ? 'rgba(80,180,120,0.4)' : colors.borderSubtle}`,
                      fontFamily: fonts.serif, fontSize: fontSize.base,
                      color: sel ? colors.success : colors.textPrimary,
                      transition: 'all 0.1s',
                    }}
                    onMouseEnter={e => { if (!sel) e.currentTarget.style.background = 'rgba(255,255,255,0.055)'; }}
                    onMouseLeave={e => { if (!sel) e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}
                  >
                    {p.name}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Player dropped — only if original tx had a drop */}
          {tx.droppedPlayer !== undefined && (
            <div>
              <label style={{ ...theme.label, display: 'block', marginBottom: 5 }}>
                Player Dropped
                <span style={{ color: colors.danger, marginLeft: 6, fontWeight: 400 }}>{editDrop || '—'}</span>
              </label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <div
                  onClick={() => setEditDrop('')}
                  style={{
                    padding: '7px 10px', borderRadius: 2, cursor: 'pointer',
                    background: !editDrop ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.03)',
                    border: `1px solid ${!editDrop ? colors.borderInput : colors.borderSubtle}`,
                    fontFamily: fonts.sans, fontSize: fontSize.base, color: colors.textMuted,
                  }}
                >
                  — None —
                </div>
                {currentRoster.filter(p => !p.limited || p.name === tx.droppedPlayer).map(p => {
                  const sel = editDrop === p.name;
                  return (
                    <div
                      key={p.name}
                      onClick={() => setEditDrop(p.name)}
                      style={{
                        padding: '7px 10px', borderRadius: 2, cursor: 'pointer',
                        background: sel ? colors.dangerBg : 'rgba(255,255,255,0.03)',
                        border: `1px solid ${sel ? colors.dangerBorder : colors.borderSubtle}`,
                        fontFamily: fonts.serif, fontSize: fontSize.base,
                        color: sel ? colors.danger : colors.textPrimary,
                        transition: 'all 0.1s',
                      }}
                      onMouseEnter={e => { if (!sel) e.currentTarget.style.background = 'rgba(180,60,60,0.07)'; }}
                      onMouseLeave={e => { if (!sel) e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}
                    >
                      {p.name}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '10px 18px', borderTop: `1px solid ${colors.borderSubtle}`,
          display: 'flex', gap: 8, flexShrink: 0,
        }}>
          <button onClick={onClose} style={{ ...theme.btnSecondary, flex: 1, padding: '9px 0' }}>
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !canSave}
            style={{
              ...theme.btnPrimary, flex: 2, padding: '9px 0',
              background: canSave ? 'rgba(100,160,255,0.18)' : 'rgba(255,255,255,0.04)',
              border: `1px solid ${canSave ? 'rgba(100,160,255,0.45)' : colors.borderSubtle}`,
              color: canSave ? 'rgba(150,190,255,0.9)' : colors.textMuted,
              cursor: canSave && !saving ? 'pointer' : 'not-allowed',
            }}
          >
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ── Main view ─────────────────────────────────────────────────────────────────
export const TransactionsView = ({ transactions, tournaments = [], teams, allPlayers = [], setTransactions, updateTeams, setTournaments, isCommissioner, STORAGE_KEYS, settings = {} }) => {
  const [filterTeam,   setFilterTeam]   = useState('all');
  const [filterSwing,  setFilterSwing]  = useState('all');
  const [editingTx,    setEditingTx]    = useState(null); // { tx, txIndex }
  const [addTxOpen,        setAddTxOpen]        = useState(false);
  const [addTxTeam,        setAddTxTeam]        = useState('');
  const [addTxType,        setAddTxType]        = useState('waiver');
  const [addTxPlayerIn,    setAddTxPlayerIn]    = useState(null);   // selected player object
  const [addTxPlayerOut,   setAddTxPlayerOut]   = useState(null);   // selected player object
  const [addTxTourney,     setAddTxTourney]     = useState('');
  const [addTxSearchIn,    setAddTxSearchIn]    = useState('');
  const [addTxSearchOut,   setAddTxSearchOut]   = useState('');
  const dialog = useDialog();

  // Wave 7: getSegForTourney removed — now uses canonical getSegmentForTournament from utils.

  const teamFees = useMemo(() => {
    // Determine current swing for the fee counter:
    // 1. Find the swing of the last completed tournament
    // 2. If that swing has been awarded (swing_winner tx exists), advance to the
    //    next swing — the one containing the next upcoming non-alternate tournament
    // 3. This resets the counter to $0 as soon as the commish awards the pot
    const lastCompleted = [...(tournaments || [])].reverse().find(t => t.completed && t.results?.teams);
    const lastSeg = lastCompleted ? getSegmentForTournament(lastCompleted) : getSegmentByDate();
    const lastSwingAwarded = transactions.some(tx => tx.type === 'swing_winner' && tx.segment === lastSeg);

    let currentSwing = lastSeg;
    if (lastSwingAwarded) {
      // Advance to next swing: find first non-alternate upcoming tournament
      const nextTourney = (tournaments || []).find(t => !t.completed && !t.isAlternate);
      currentSwing = nextTourney ? (getSegmentForTournament(nextTourney) || lastSeg) : lastSeg;
    }

    const fees = {};
    teams.forEach(t => { fees[t.name] = { seasonTotal: 0, swingTotal: 0, currentSwing, teamId: t.id, teamName: t.name }; });

    // Build the set of tournamentIndexes that belong to the current swing
    const currentSwingIndexes = new Set(
      (tournaments || [])
        .map((t, i) => ({ t, i }))
        .filter(({ t }) => getSegmentForTournament(t) === currentSwing)
        .map(({ i }) => i)
    );

    transactions.forEach(tx => {
      // swing_winner uses tx.amount not tx.fee — don't count it in season/swing fees
      if (tx.type === 'swing_winner') return;
      if (tx.status === 'failed') return; // blocked waivers have no fee
      if (fees[tx.team] && typeof tx.fee === 'number' && tx.fee > 0) {
        fees[tx.team].seasonTotal += tx.fee;
        // Count toward current swing if the transaction's tournament is in this swing
        const inCurrentSwing = tx.tournamentIndex !== undefined
          ? currentSwingIndexes.has(tx.tournamentIndex)
          : tx.segment === currentSwing; // fallback for old transactions without tournamentIndex
        if (inCurrentSwing) fees[tx.team].swingTotal += tx.fee;
      }
    });
    return Object.values(fees).sort((a, b) => b.seasonTotal - a.seasonTotal);
  }, [teams, transactions, tournaments]);

  const TYPE_ORDER = { 'fa': 0, 'free agent': 0, 'waiver': 1, 'mulligan': 2, 'drop': 3, 'swing_winner': 99 };
  // Build a map of segment → last tournamentIndex for sorting swing_winner records.
  const swingLastIndex = {};
  tournaments.forEach((t, i) => {
    const seg = t.segment || '';
    if (seg && t.completed) swingLastIndex[seg] = Math.max(swingLastIndex[seg] ?? -1, i);
  });

  const sortedTransactions = [...transactions].sort((a, b) => {
    const resolveKey = tx => {
      if (tx.type === 'swing_winner') {
        const lastIdx = tx.tournamentIndex ?? (tx.segment ? swingLastIndex[tx.segment] : undefined);
        return lastIdx !== undefined ? lastIdx + 0.5 : -1;
      }
      return tx.tournamentIndex ?? -1;
    };
    const ak = resolveKey(a);
    const bk = resolveKey(b);
    if (bk !== ak) return bk - ak;
    // Same tournament: sort by type order (waiver → FA → mulligan)
    const ta = TYPE_ORDER[a.type?.toLowerCase()] ?? 1;
    const tb = TYPE_ORDER[b.type?.toLowerCase()] ?? 1;
    if (ta !== tb) return ta - tb;
    // Within waivers: blocked before successful (blocked is the consequence)
    if (a.type === 'waiver' && b.type === 'waiver') {
      const sa = a.status === 'failed' ? 0 : 1;
      const sb = b.status === 'failed' ? 0 : 1;
      if (sa !== sb) return sa - sb;
    }
    // Final tiebreak: timestamp, most recent first
    const toMs = tx => {
      if (tx.timestamp) return typeof tx.timestamp === 'number' ? tx.timestamp : new Date(tx.timestamp).getTime();
      if (tx.date) return new Date(tx.date).getTime();
      return 0;
    };
    return toMs(b) - toMs(a);
  });
  const getTxSegment = (tx) => {
    if (tx.segment) return tx.segment;
    if (tx.tournamentIndex !== undefined && tournaments[tx.tournamentIndex]) {
      return getSegmentForTournament(tournaments[tx.tournamentIndex]);
    }
    return '';
  };

  const filteredTransactions = sortedTransactions
    .filter(tx => filterTeam === 'all' || tx.team === filterTeam)
    .filter(tx => {
      if (filterSwing === 'all') return true;
      return getTxSegment(tx) === filterSwing;
    });

  const undoTransaction = async (tx, skipConfirm = false) => {
    if (tx.status !== 'processed') return; // only reverse completed transactions
    if (!skipConfirm) {
      const ok = await dialog.showConfirm(
        'Undo Transaction',
        'Undo ' + tx.type + ': ' + tx.team + ' added ' + tx.player + (tx.droppedPlayer ? ' / dropped ' + tx.droppedPlayer : '') + '?\n\nThis will reverse the roster change and refund the $' + tx.fee + ' fee.',
        { type: 'danger', confirmText: 'Undo' },
      );
      if (!ok) return;
    }
    const team = teams.find(t => t.name === tx.team);
    if (!team) return;

    // Remove the added player from the roster
    let newRoster = team.roster.filter(p => p.name !== tx.player);

    // Restore the dropped player — use allPlayers data if available, else makePlayer
    if (tx.droppedPlayer) {
      const playerData = allPlayers?.find(p => p.name === tx.droppedPlayer);
      newRoster.push(playerData
        ? { name: playerData.name, limited: playerData.limited || false, unlimited: playerData.unlimited || false, stars: playerData.stars || 0, starts: playerData.starts || 0, eventsPlayed: playerData.eventsPlayed || 0, cutsMade: playerData.cutsMade || 0, pgaTourEarnings: playerData.pgaTourEarnings || 0, sfglEarnings: playerData.sfglEarnings || 0 }
        : makePlayer(tx.droppedPlayer)
      );
    }

    const newTeams = teams.map(t =>
      t.id === team.id
        ? { ...t, roster: newRoster, transactionFees: Math.max(0, (t.transactionFees || 0) - (tx.fee || 0)) }
        : t,
    );

    // Remove this transaction; also restore any blocked losers back to pending
    // so the commissioner can re-process the waiver round fairly
    const newTransactions = transactions
      .filter(t => t !== tx)
      .map(t => {
        if (
          t.status === 'failed' &&
          t.type === 'waiver' &&
          t.player === tx.player &&
          t.failReason?.includes('lost tiebreaker')
        ) {
          // Re-queue the blocked claim so it can be processed again
          const { failReason, processedDate, ...rest } = t;
          return { ...rest, status: 'pending' };
        }
        return t;
      });

    updateTeams(newTeams);
    setTransactions(newTransactions);
    dialog.showToast('Undone: ' + tx.player + ' removed from ' + tx.team, 'success');
  };

  const handleAddTx = async () => {
    if (!addTxTeam || !addTxType || !addTxTourney) return;
    const team = teams.find(t => t.name === addTxTeam);
    if (!team) return;

    const playerInName  = addTxPlayerIn?.name  || null;
    const playerOutName = addTxPlayerOut?.name || null;

    const ok = await dialog.showConfirm(
      'Add Manual Transaction',
      'Add ' + addTxType + ' for ' + addTxTeam + ' at ' + tournaments[parseInt(addTxTourney)]?.name +
      (playerInName  ? ' · IN: '  + playerInName  : '') +
      (playerOutName ? ' · OUT: ' + playerOutName : '') + '?',
      { confirmText: 'Add' }
    );
    if (!ok) return;

    const tournamentIndex = parseInt(addTxTourney);
    const isBlocked = addTxType === 'waiver blocked';
    // Wave 6: auto-calculate fee based on transaction type, defaulting to the
    // league settings (feeFA: 1, feeWaiver: 2). Previous code hardcoded 0 for
    // every type, so manually-added FA transactions never charged the $1 fee.
    const feeFA     = settings?.feeFA     ?? 1;
    const feeWaiver = settings?.feeWaiver ?? 2;
    const computedFee = isBlocked       ? 0
                      : addTxType === 'fa'        ? feeFA
                      : addTxType === 'waiver'    ? feeWaiver
                      : 0; // mulligan, drop, etc. — no fee
    const newTx = {
      txId: `manual-${addTxTeam}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      team: addTxTeam,
      type: isBlocked ? 'waiver' : addTxType,
      player: playerInName  || playerOutName || '—',
      droppedPlayer: addTxType === 'mulligan' ? playerOutName || undefined
                   : addTxType === 'drop'     ? undefined
                   : playerOutName || undefined,
      fee: computedFee,
      segment: tournaments[tournamentIndex]?.segment || '',
      date: new Date().toLocaleDateString(),
      timestamp: Date.now(),
      tournamentIndex,
      status: isBlocked ? 'failed' : 'completed',
      ...(isBlocked ? { failReason: 'Manually voided by commissioner' } : {}),
      manualEntry: true,
    };

    const copy = [...transactions];
    const insertAt = copy.reduce((last, tx, i) =>
      (tx.tournamentIndex !== undefined && tx.tournamentIndex <= tournamentIndex) ? i + 1 : last
    , 0);
    copy.splice(insertAt, 0, newTx);

    // For mulligans: swap lineup, decrement mulligan counter, update tournament results if already processed
    let updatedTeams = teams;
    let updatedTournaments = tournaments;
    if (addTxType === 'mulligan' && (playerInName || playerOutName)) {
      const mulliganTeam = teams.find(t => t.name === addTxTeam);
      const tournament = tournaments[tournamentIndex];
      const alreadyProcessed = !!tournament?.completed;

      // Detect if this mulligan was already applied (e.g. re-adding a lost transaction record).
      // If the IN player is already in the stored results for this team, skip re-application.
      const storedPlayers = tournament?.results?.teams?.[mulliganTeam?.id]?.players || [];
      const alreadyApplied = playerInName && storedPlayers.some(p => (p.name || p) === playerInName);

      if (alreadyApplied) {
        console.log(`[Mulligan] Already applied: ${playerInName} is already in ${addTxTeam}'s results for ${tournament?.name}. Recording transaction only.`);
        dialog.showToast('Mulligan already applied — recording transaction only', 'info');
      } else {
        updatedTeams = teams.map(t => {
          if (t.name !== addTxTeam) return t;
          return {
            ...t,
            // Swap in the active lineup
            lineup: playerOutName && playerInName
              ? t.lineup.map(p => p === playerOutName ? playerInName : p)
              : t.lineup,
            // Only adjust limited starts if results were ALREADY processed
            // (if not yet processed, processResults will handle starts via team.lineup)
            roster: alreadyProcessed
              ? t.roster.map(p => {
                  if (p.name === playerOutName && p.limited)
                    return { ...p, starts: Math.max(0, (p.starts || 0) - 1) };
                  if (p.name === playerInName && p.limited)
                    return { ...p, starts: (p.starts || 0) + 1 };
                  return p;
                })
              : t.roster,
            // Wave 8: no longer write to team.mulligans. RostersView now derives
            // remaining mulligans from the transactions array (single source of
            // truth), so a manually-added mulligan tx in Firestore correctly
            // counts against the team's quota — same as one added via this UI.
          };
        });

        // Swap player in stored tournament results (only if tournament already processed)
        if (alreadyProcessed && mulliganTeam && playerOutName && playerInName) {
          updatedTournaments = tournaments.map((t, i) => {
            if (i !== tournamentIndex || !t.results?.teams?.[mulliganTeam.id]) return t;
            const teamResult = t.results.teams[mulliganTeam.id];

            // Try to find IN player's actual earnings from the tournament earnings map
            const earningsMap = t.results?.earningsMap || {};
            let inPlayerEarnings = earningsMap[playerInName] ?? 0;
            // Fuzzy match if exact name not found
            if (inPlayerEarnings === 0) {
              const fuzzyKey = Object.keys(earningsMap).find(k =>
                k.toLowerCase().replace(/[^a-z]/g, '') === playerInName.toLowerCase().replace(/[^a-z]/g, '')
              );
              if (fuzzyKey) inPlayerEarnings = earningsMap[fuzzyKey];
            }

            const updatedPlayers = (teamResult.players || []).map(p => {
              const name = p.name || p;
              if (name !== playerOutName) return p;
              return typeof p === 'string'
                ? { name: playerInName, earnings: inPlayerEarnings, mulliganIn: true, replacedPlayer: playerOutName }
                : { ...p, name: playerInName, earnings: inPlayerEarnings, bonus: 0, roundsLed: [], wasRoundLeader: false, mulliganIn: true, replacedPlayer: playerOutName };
            });

            // Recalculate team totalEarnings from updated players
            const newTotal = updatedPlayers.reduce((sum, p) => sum + (p.earnings || 0) + (p.bonus || 0), 0);

            return {
              ...t,
              results: {
                ...t.results,
                teams: {
                  ...t.results.teams,
                  [mulliganTeam.id]: { ...teamResult, players: updatedPlayers, totalEarnings: newTotal },
                },
              },
            };
          });
          setTournaments(updatedTournaments);

          // Also adjust team earnings + roster sfglEarnings to reflect the swap
          const oldResult = tournaments[tournamentIndex]?.results?.teams?.[mulliganTeam.id];
          const newResult = updatedTournaments[tournamentIndex]?.results?.teams?.[mulliganTeam.id];
          if (oldResult && newResult) {
            const earningsDiff = (newResult.totalEarnings || 0) - (oldResult.totalEarnings || 0);
            const outPlayerOldEarnings = (oldResult.players || []).find(p => (p.name || p) === playerOutName)?.earnings || 0;
            const inPlayerNewEarnings = (newResult.players || []).find(p => (p.name || p) === playerInName)?.earnings || 0;
            updatedTeams = updatedTeams.map(t => {
              if (t.name !== addTxTeam) return t;
              return {
                ...t,
                earnings: (t.earnings || 0) + earningsDiff,
                segmentEarnings: (t.segmentEarnings || 0) + earningsDiff,
                roster: t.roster.map(p => {
                  if (p.name === playerOutName) return { ...p, sfglEarnings: Math.max(0, (p.sfglEarnings || 0) - outPlayerOldEarnings) };
                  if (p.name === playerInName) return { ...p, sfglEarnings: (p.sfglEarnings || 0) + inPlayerNewEarnings };
                  return p;
                }),
              };
            });
          }
        }

        updateTeams(updatedTeams);
      }
    }

    setTransactions(copy);
    // setTransactions is updateTransactions from useLeague — it handles
    // both local state, localStorage, and Firebase sync internally.
    // No separate sfglDataApi.set needed (that caused race conditions).

    dialog.showToast('Transaction added', 'success');
    setAddTxOpen(false);
    setAddTxTeam(''); setAddTxType('waiver');
    setAddTxPlayerIn(null); setAddTxPlayerOut(null);
    setAddTxSearchIn(''); setAddTxSearchOut('');
    setAddTxTourney('');
  };

  const txTypeColor = (type) => {
    if (type === 'drop') return colors.danger;
    return colors.textGold;  // mulligan, waiver, fa, free agent, swing_winner all gold
  };

  // Human-readable label for transaction type
  const txTypeLabel = (type) => {
    if (type === 'swing_winner') return 'swing winner';
    if (type === 'fa')           return 'free agent';
    return type;
  };

  const statusColor = (status) => {
    if (status === 'pending')   return 'rgba(220,200,80,0.75)';
    if (status === 'failed')    return colors.danger;
    if (status === 'processed') return colors.success;
    return colors.textMuted;
  };

  // Find the real index in the full transactions array for a filtered tx
  const realIndex = (tx) => transactions.indexOf(tx);

  return (
    <>
      {editingTx && (
        <EditTransactionModal
          tx={editingTx.tx}
          txIndex={editingTx.txIndex}
          teams={teams}
          tournaments={tournaments}
          allPlayers={allPlayers}
          transactions={transactions}
          setTransactions={setTransactions}
          updateTeams={updateTeams}
          onClose={() => setEditingTx(null)}
        />
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

        {/* ── Fee summary ── */}
        <div style={theme.card}>
          <div style={{ ...theme.cardHeader, justifyContent: 'space-between' }}>
            <h2 style={theme.h2}>Transaction Fees</h2>
            {teamFees[0]?.currentSwing && (() => {
              const swingColor = getSwingColor(teamFees[0].currentSwing);
              const swingPot = teamFees.reduce((sum, t) => sum + (t.swingTotal || 0), 0);
              return (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontFamily: fonts.sans, fontSize: fontSize.sm, letterSpacing: '0.3px', color: swingColor }}>
                    {teamFees[0].currentSwing}
                  </span>
                  {swingPot > 0 && (
                    <span style={{ fontFamily: fonts.mono, fontSize: fontSize.base, fontWeight: 700, color: swingColor }}>
                      ${swingPot}
                    </span>
                  )}
                </div>
              );
            })()}
          </div>
          <div style={{ padding: '12px 16px' }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'nowrap' }}>
              {teamFees.map(team => {
                const abbr = getTeamAbbreviation(team.teamName);
                return (
                  <div key={team.teamId} style={{
                    flex: 1,
                    background: 'rgba(255,255,255,0.03)',
                    border: `1px solid ${colors.borderSubtle}`,
                    borderRadius: 2, padding: '8px 6px', textAlign: 'center', minWidth: 0,
                  }}>
                    <div style={{ fontFamily: fonts.serif, fontSize: fontSize.md, color: colors.textPrimary }}>
                      {abbr}
                    </div>
                    <div style={{ ...theme.statNum, fontSize: fontSize.md, color: colors.textGold, marginTop: 2 }}>
                      ${team.seasonTotal}
                    </div>
                    <div style={{ fontFamily: fonts.sans, fontSize: fontSize.sm, color: getSwingColor(team.currentSwing), marginTop: 1 }}>
                      ${team.swingTotal} swing
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* ── Commissioner: Add Manual Transaction (form only — toggle moved
            inline with the Transaction History header below) ── */}
        {isCommissioner && (
          <>
            {addTxOpen && (
          <div style={theme.card}>
            <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                {/* Team */}
                <div>
                  <div style={{ ...theme.label, marginBottom: 4 }}>Team</div>
                  <select value={addTxTeam} onChange={e => setAddTxTeam(e.target.value)} style={{ ...theme.select, width: '100%' }}>
                    <option value="">Select team...</option>
                    {teams.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
                  </select>
                </div>

                {/* Tournament */}
                <div>
                  <div style={{ ...theme.label, marginBottom: 4 }}>Tournament</div>
                  <select value={addTxTourney} onChange={e => setAddTxTourney(e.target.value)} style={{ ...theme.select, width: '100%' }}>
                    <option value="">Select tournament...</option>
                    {(() => {
                      // Date-based: which week are we in for add/drop?
                      const parseStart = (t) => {
                        if (!t?.dates) return null;
                        const m = t.dates.match(/^([A-Za-z]+)\s+(\d+)/);
                        if (!m) return null;
                        const months = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
                        const mo = months[m[1]];
                        if (mo === undefined) return null;
                        return new Date(2026, mo, parseInt(m[2]));
                      };
                      const etStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
                      const now = new Date(etStr);
                      let dateWeekIdx = -1;
                      tournaments.forEach((t, i) => {
                        const start = parseStart(t);
                        if (!start) return;
                        const end = new Date(start); end.setDate(end.getDate() + 13);
                        if (now >= start && now <= end) dateWeekIdx = i;
                      });
                      return tournaments.map((t, i) => {
                        let hint = '';
                        if (t.playing) hint = ' (active)';
                        if (i === dateWeekIdx) hint = ' ← this week';
                        return (
                          <option key={t.name} value={i}>
                            {t.completed ? '✓ ' : t.playing ? '▶ ' : ''}{t.name}{hint}
                          </option>
                        );
                      });
                    })()}
                  </select>
                </div>

                {/* Type */}
                <div>
                  <div style={{ ...theme.label, marginBottom: 4 }}>Type</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {['waiver', 'waiver blocked', 'fa', 'mulligan'].map(type => (
                      <button key={type} onClick={() => {
                        // Only reset tournament/players when type ACTUALLY changes
                        if (type === addTxType) return;
                        setAddTxType(type);
                        setAddTxPlayerIn(null); setAddTxSearchIn('');
                        setAddTxPlayerOut(null); setAddTxSearchOut('');
                        // Always re-default tournament when type changes (commish can still override)
                        {
                          if (type === 'mulligan') {
                            // Mulligan → current playing tournament
                            const idx = tournaments.findIndex(t => t.playing);
                            if (idx >= 0) setAddTxTourney(String(idx));
                          } else {
                            // FA/waiver/drop → date-based current tournament week
                            const parseStart = (t) => {
                              if (!t?.dates) return null;
                              const m = t.dates.match(/^([A-Za-z]+)\s+(\d+)/);
                              if (!m) return null;
                              const months = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
                              const mo = months[m[1]];
                              if (mo === undefined) return null;
                              return new Date(2026, mo, parseInt(m[2]));
                            };
                            const etStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
                            const now = new Date(etStr);
                            let found = -1;
                            tournaments.forEach((t, i) => {
                              const start = parseStart(t);
                              if (!start) return;
                              const end = new Date(start); end.setDate(end.getDate() + 13);
                              if (now >= start && now <= end) found = i;
                            });
                            if (found < 0) found = tournaments.findIndex(t => !t.completed);
                            if (found >= 0) setAddTxTourney(String(found));
                          }
                        }
                      }} style={{
                        flex: 1, padding: '7px 4px', borderRadius: 2, fontSize: fontSize.base,
                        fontFamily: fonts.sans, fontWeight: 600, cursor: 'pointer',
                        background: addTxType === type ? colors.buttonNavy : 'transparent',
                        border: '1px solid ' + (addTxType === type ? colors.border : colors.borderInput),
                        color: addTxType === type ? colors.textGold : colors.textSecondary,
                      }}>
                        {type}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Player IN — dropdown for mulligan (roster is small), search for others */}
                {(addTxType !== 'drop') && (() => {
                  const teamObj  = teams.find(t => t.name === addTxTeam);
                  const validPlayer = p => p.name && typeof p.name === 'string' && !/^\d+$/.test(p.name.trim());

                  // Mulligan: show a simple dropdown of the team's full roster.
                  // Wave 8: previously filtered to bench-only (roster minus lineup),
                  // but commish wanted the full roster visible — use roster directly.
                  // Annotates each name with "(in lineup)" so the original distinction
                  // is still visible without restricting the choice.
                  if (addTxType === 'mulligan') {
                    const roster = (teamObj?.roster || []).filter(validPlayer);
                    // Determine the ORIGINAL lineup for the selected tournament for
                    // the annotation. If results already processed, lineup was cleared
                    // — pull from stored results. If a mulligan was already applied,
                    // reconstruct the original lineup by undoing the swap.
                    const tournIdx = addTxTourney ? parseInt(addTxTourney) : -1;
                    const tournament = tournIdx >= 0 ? tournaments[tournIdx] : null;
                    const storedPlayers = tournament?.results?.teams?.[teamObj?.id]?.players || [];
                    const originalLineup = storedPlayers.map(p => {
                      if (p.mulliganIn && p.replacedPlayer) return p.replacedPlayer;
                      return p.name || p;
                    }).filter(Boolean);
                    const currentLineup = teamObj?.lineup || [];
                    const lineup = new Set(originalLineup.length > 0 ? originalLineup : currentLineup);
                    return (
                      <div>
                        <div style={{ ...theme.label, marginBottom: 4 }}>Player IN</div>
                        <select
                          value={addTxPlayerIn?.name || ''}
                          onChange={e => {
                            const name = e.target.value;
                            setAddTxPlayerIn(name ? { name } : null);
                          }}
                          style={{ ...theme.input, width: '100%', boxSizing: 'border-box', marginBottom: 4, cursor: 'pointer' }}
                        >
                          <option value="">— select player —</option>
                          {roster.sort((a, b) => a.name.localeCompare(b.name)).map(p => (
                            <option key={p.name} value={p.name}>
                              {p.name}{p.limited ? ' ⭐' : ''}{lineup.has(p.name) ? ' (in lineup)' : ''}
                            </option>
                          ))}
                        </select>
                      </div>
                    );
                  }

                  // Non-mulligan: search UI for free agents / all players
                  const pool = addTxType === 'waiver blocked'
                    ? allPlayers.filter(validPlayer)
                    : allPlayers.filter(p => {
                        if (!validPlayer(p)) return false;
                        const allRostered = new Set(teams.flatMap(t => t.roster.map(r => r.name)));
                        return !allRostered.has(p.name);
                      });
                  const filtered = pool.filter(p =>
                    (p.name || p).toLowerCase().includes(addTxSearchIn.toLowerCase())
                  );
                  const label = addTxType === 'waiver blocked' ? 'Player Claimed (blocked)'
                              : 'Player Added';
                  return (
                    <div>
                      <div style={{ ...theme.label, marginBottom: 4 }}>{label}</div>
                      {addTxPlayerIn ? (
                        <div style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          padding: '8px 12px', borderRadius: 3, marginBottom: 4,
                          background: 'rgba(80,180,120,0.12)', border: '1px solid rgba(80,180,120,0.35)',
                        }}>
                          <span style={{ fontFamily: fonts.serif, fontSize: fontSize.md, color: colors.success }}>{addTxPlayerIn.name}</span>
                          <button onClick={() => { setAddTxPlayerIn(null); setAddTxSearchIn(''); }}
                            style={{ background: 'none', border: 'none', color: colors.textMuted, cursor: 'pointer', fontSize: fontSize.base, padding: '0 2px' }}>✕</button>
                        </div>
                      ) : (
                        <>
                          <input
                            type="text"
                            placeholder="Search free agents…"
                            value={addTxSearchIn}
                            onChange={e => setAddTxSearchIn(e.target.value)}
                            style={{ ...theme.input, width: '100%', boxSizing: 'border-box', marginBottom: 4 }}
                            onFocus={e => { e.target.style.borderColor = colors.borderFocus; }}
                            onBlur={e => { e.target.style.borderColor = colors.borderInput; }}
                          />
                          {addTxSearchIn.length > 0 && (
                            <div style={{ maxHeight: 160, overflowY: 'auto', border: '1px solid ' + colors.borderSubtle, borderRadius: 3, marginBottom: 4 }}>
                              {filtered.slice(0, 20).map(p => {
                                const name = p.name || p;
                                return (
                                  <div key={name}
                                    onClick={() => { setAddTxPlayerIn({ name }); setAddTxSearchIn(''); }}
                                    style={{
                                      padding: '8px 12px', cursor: 'pointer',
                                      borderBottom: '1px solid ' + colors.borderSubtle,
                                      display: 'flex', alignItems: 'center', gap: 8,
                                      transition: 'background 0.1s',
                                    }}
                                    onMouseEnter={e => { e.currentTarget.style.background = colors.rowHover; }}
                                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                                  >
                                    {p.worldRank && (
                                      <span style={{ fontFamily: fonts.sans, fontSize: fontSize.sm, color: colors.textMuted, minWidth: 26 }}>
                                        {p.worldRank === 999 ? 'NR' : '#' + p.worldRank}
                                      </span>
                                    )}
                                    <span style={{ fontFamily: fonts.serif, fontSize: fontSize.md, color: colors.textPrimary }}>{name}</span>
                                  </div>
                                );
                              })}
                              {filtered.length === 0 && (
                                <div style={{ padding: '10px 12px', fontFamily: fonts.sans, fontSize: fontSize.base, color: colors.textMuted }}>No players found</div>
                              )}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  );
                })()}

                {/* Player OUT / Dropped — dropdown for mulligan, search for fa/waiver */}
                {(addTxType === 'mulligan' || addTxType === 'fa' || addTxType === 'waiver') && (() => {
                  const teamObj = teams.find(t => t.name === addTxTeam);

                  // Mulligan: dropdown of the team's full roster.
                  // Wave 8: previously restricted to lineup-only — commish wanted
                  // full roster visible. Annotate each non-lineup player with
                  // "(on bench)" so the distinction is still clear.
                  if (addTxType === 'mulligan') {
                    const roster = (teamObj?.roster || []).filter(p => p.name && typeof p.name === 'string' && !/^\d+$/.test(p.name.trim()));
                    // Determine ORIGINAL lineup for annotation (same logic as Player IN).
                    const tournIdx = addTxTourney ? parseInt(addTxTourney) : -1;
                    const tournament = tournIdx >= 0 ? tournaments[tournIdx] : null;
                    const storedPlayers = tournament?.results?.teams?.[teamObj?.id]?.players || [];
                    const originalLineup = storedPlayers.map(p => {
                      if (p.mulliganIn && p.replacedPlayer) return p.replacedPlayer;
                      return p.name || p;
                    }).filter(Boolean);
                    const currentLineup = teamObj?.lineup || [];
                    const lineup = new Set(originalLineup.length > 0 ? originalLineup : currentLineup);
                    return (
                      <div>
                        <div style={{ ...theme.label, marginBottom: 4 }}>Player OUT</div>
                        <select
                          value={addTxPlayerOut?.name || ''}
                          onChange={e => {
                            const name = e.target.value;
                            setAddTxPlayerOut(name ? { name } : null);
                          }}
                          style={{ ...theme.input, width: '100%', boxSizing: 'border-box', marginBottom: 4, cursor: 'pointer' }}
                        >
                          <option value="">— select player —</option>
                          {roster.sort((a, b) => a.name.localeCompare(b.name)).map(p => (
                            <option key={p.name} value={p.name}>
                              {p.name}{p.limited ? ' ⭐' : ''}{lineup.has(p.name) ? '' : ' (on bench)'}
                            </option>
                          ))}
                        </select>
                      </div>
                    );
                  }

                  // FA / Waiver: search the team's roster for who to drop
                  const pool = teamObj?.roster || [];
                  const filtered = pool.filter(p =>
                    (p.name || p).toLowerCase().includes(addTxSearchOut.toLowerCase())
                  );
                  return (
                    <div>
                      <div style={{ ...theme.label, marginBottom: 4 }}>Player Dropped</div>
                      {addTxPlayerOut ? (
                        <div style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          padding: '8px 12px', borderRadius: 3, marginBottom: 4,
                          background: colors.dangerBg, border: '1px solid ' + colors.dangerBorder,
                        }}>
                          <span style={{ fontFamily: fonts.serif, fontSize: fontSize.md, color: colors.danger }}>{addTxPlayerOut.name}</span>
                          <button onClick={() => { setAddTxPlayerOut(null); setAddTxSearchOut(''); }}
                            style={{ background: 'none', border: 'none', color: colors.textMuted, cursor: 'pointer', fontSize: fontSize.base, padding: '0 2px' }}>✕</button>
                        </div>
                      ) : (
                        <>
                          <input
                            type="text"
                            placeholder="Search roster…"
                            value={addTxSearchOut}
                            onChange={e => setAddTxSearchOut(e.target.value)}
                            style={{ ...theme.input, width: '100%', boxSizing: 'border-box', marginBottom: 4 }}
                            onFocus={e => { e.target.style.borderColor = colors.borderFocus; }}
                            onBlur={e => { e.target.style.borderColor = colors.borderInput; }}
                          />
                          {addTxSearchOut.length > 0 && (
                            <div style={{ maxHeight: 160, overflowY: 'auto', border: '1px solid ' + colors.borderSubtle, borderRadius: 3, marginBottom: 4 }}>
                              {filtered.slice(0, 20).map(p => {
                                const name = p.name || p;
                                return (
                                  <div key={name}
                                    onClick={() => { setAddTxPlayerOut({ name }); setAddTxSearchOut(''); }}
                                    style={{
                                      padding: '8px 12px', cursor: 'pointer',
                                      borderBottom: '1px solid ' + colors.borderSubtle,
                                      display: 'flex', alignItems: 'center', gap: 8,
                                      transition: 'background 0.1s',
                                    }}
                                    onMouseEnter={e => { e.currentTarget.style.background = colors.rowHover; }}
                                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                                  >
                                    <span style={{ fontFamily: fonts.serif, fontSize: fontSize.md, color: colors.textPrimary }}>{name}</span>
                                  </div>
                                );
                              })}
                              {filtered.length === 0 && (
                                <div style={{ padding: '10px 12px', fontFamily: fonts.sans, fontSize: fontSize.base, color: colors.textMuted }}>No players found</div>
                              )}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  );
                })()}

                <button
                  onClick={handleAddTx}
                  disabled={!addTxTeam || !addTxTourney}
                  style={{
                    ...theme.btnPrimary, width: '100%', padding: '9px 16px',
                    opacity: (!addTxTeam || !addTxTourney) ? 0.4 : 1,
                    cursor: (!addTxTeam || !addTxTourney) ? 'not-allowed' : 'pointer',
                  }}
                >
                  Add Transaction
                </button>
              </div>
          </div>
            )}
          </>
        )}

        {/* ── Transaction history ── */}
        <div style={theme.card}>
          <div style={{ ...theme.cardHeader, justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
              <h2 style={theme.h2}>Transaction History</h2>
              {isCommissioner && (
                <button
                  onClick={() => setAddTxOpen(!addTxOpen)}
                  title={addTxOpen ? 'Close add transaction form' : 'Add manual transaction'}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    padding: '3px 9px', borderRadius: 3,
                    fontFamily: fonts.sans, fontSize: fontSize.sm, fontWeight: 700,
                    letterSpacing: '0.4px', textTransform: 'uppercase',
                    cursor: 'pointer',
                    transition: 'all 0.15s',
                    background: addTxOpen ? 'rgba(80,180,120,0.22)' : 'rgba(80,180,120,0.1)',
                    border: '1px solid rgba(80,180,120,0.45)',
                    color: 'rgba(80,180,120,0.9)',
                    flexShrink: 0,
                    lineHeight: 1.2,
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'rgba(80,180,120,0.22)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = addTxOpen ? 'rgba(80,180,120,0.22)' : 'rgba(80,180,120,0.1)'; }}
                >
                  <span style={{ fontSize: fontSize.base, lineHeight: 1, fontWeight: 800 }}>{addTxOpen ? '−' : '+'}</span>
                  <span>Add</span>
                </button>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
              <select
                value={filterSwing}
                onChange={e => setFilterSwing(e.target.value)}
                style={{ ...theme.select, width: 'auto', fontSize: fontSize.base, padding: '5px 10px' }}
                onFocus={e => { e.target.style.borderColor = colors.borderFocus; }}
                onBlur={e => { e.target.style.borderColor = colors.borderInput; }}
              >
                <option value="all">All Swings</option>
                <option value="West Coast Swing">West Coast Swing</option>
                <option value="Spring Swing">Spring Swing</option>
                <option value="Summer Swing">Summer Swing</option>
                <option value="Fall Finish">Fall Finish</option>
              </select>
              <select
                value={filterTeam}
                onChange={e => setFilterTeam(e.target.value)}
                style={{ ...theme.select, width: 'auto', fontSize: fontSize.base, padding: '5px 10px' }}
                onFocus={e => { e.target.style.borderColor = colors.borderFocus; }}
                onBlur={e => { e.target.style.borderColor = colors.borderInput; }}
              >
                <option value="all">All Teams</option>
                {teams.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
              </select>
            </div>
          </div>

          <div style={{ padding: '0 4px' }}>
            {filteredTransactions.length === 0 && (
              <div style={theme.emptyState}>No transactions yet</div>
            )}
            {filteredTransactions.map((tx) => {
              const idx = realIndex(tx);
              return (
                <div key={idx} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '10px 16px', gap: 8,
                  borderBottom: `1px solid ${colors.borderSubtle}`,
                  transition: 'background 0.15s',
                }}
                  onMouseEnter={e => { e.currentTarget.style.background = colors.rowHover; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    {/* Team name + tournament or swing name */}
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 2 }}>
                      <span style={{ fontFamily: fonts.serif, fontSize: fontSize.md, color: colors.textPrimary }}>
                        {tx.team}
                      </span>
                      {(() => {
                        // swing_winner: show swing name; others: show tournament name
                        if (tx.type === 'swing_winner') {
                          return tx.segment
                            ? <span style={{ fontFamily: fonts.sans, fontSize: fontSize.sm, color: getSwingColor(tx.segment) }}>{tx.segment}</span>
                            : null;
                        }
                        const t = tx.tournamentIndex != null ? tournaments[tx.tournamentIndex] : null;
                        const name = t?.name || tx.tournament || null;
                        if (!name) return null;
                        return (
                          <span style={{ fontFamily: fonts.sans, fontSize: fontSize.sm, color: 'rgba(255,255,255,0.45)' }}>
                            {name}
                          </span>
                        );
                      })()}
                    </div>

                    {/* Transaction detail */}
                    <div style={{ fontFamily: fonts.sans, fontSize: fontSize.base, color: colors.textSecondary }}>
                      <span style={{ color: txTypeColor(tx.type) }}>{txTypeLabel(tx.type)}</span>
                      {tx.status === 'failed' && tx.type === 'waiver' && (
                        <span style={{ fontFamily: fonts.sans, fontSize: fontSize.xs, fontWeight: 700, color: colors.textGold, marginLeft: 5, letterSpacing: '0.4px' }}>BLOCKED</span>
                      )}
                      {': '}
                      <span style={{ color: tx.status === 'failed' ? colors.danger : colors.success }}>{tx.type === 'swing_winner' ? tx.team : shortName(tx.player)}</span>
                      {tx.droppedPlayer && !(tx.status === 'failed' && tx.type === 'waiver') && (
                        <>
                          <span style={{ color: colors.textMuted, margin: '0 3px' }}>→ {tx.type === 'mulligan' ? 'out' : 'drop'}</span>
                          <span style={{ color: colors.danger }}>{shortName(tx.droppedPlayer)}</span>
                        </>
                      )}
                    </div>
                    {tx.status === 'failed' && tx.failReason && (
                      <div style={{ fontFamily: fonts.sans, fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1 }}>
                        {tx.failReason}
                      </div>
                    )}
                  </div>

                  {/* Fee + commish actions */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                    {tx.type === 'mulligan' ? (
                      <span style={{ fontSize: 14, lineHeight: 1 }}>🚨</span>
                    ) : tx.type === 'swing_winner' ? (
                      <span style={{ ...theme.statNum, fontSize: fontSize.md, fontWeight: 600, color: colors.textGold }}>
                        +${(tx.amount || 0).toLocaleString()}
                      </span>
                    ) : (
                      <span style={{
                        ...theme.statNum, fontSize: fontSize.md, fontWeight: 600,
                        color: tx.status === 'failed' ? colors.textMuted : (tx.fee > 0 ? colors.earningsGreen : colors.textMuted),
                      }}>
                        {tx.status === 'failed' ? '—' : `$${tx.fee}`}
                      </span>
                    )}

                    {/* Commish actions */}
                    {isCommissioner && (
                      <>
                        {/* Edit button — only for FA/waiver/drop (not mulligan, swing_winner) */}
                        {!['mulligan', 'swing_winner'].includes(tx.type) && (
                          <button
                            onClick={() => setEditingTx({ tx, txIndex: idx })}
                            title="Edit transaction"
                            style={{
                              background: 'none', border: 'none', cursor: 'pointer',
                              color: 'rgba(100,160,255,0.65)',
                              padding: '3px 4px', borderRadius: 2,
                              display: 'flex', alignItems: 'center',
                              transition: 'color 0.15s',
                            }}
                            onMouseEnter={e => { e.currentTarget.style.color = 'rgba(150,190,255,0.9)'; }}
                            onMouseLeave={e => { e.currentTarget.style.color = 'rgba(100,160,255,0.65)'; }}
                          >
                            <Edit2 style={{ width: 13, height: 13 }} />
                          </button>
                        )}

                        {/* Delete button — red ✕ for all types */}
                        <button
                          onClick={async () => {
                            const label = tx.type === 'mulligan'
                              ? `Delete mulligan for ${tx.team}?\n\n${tx.player} IN → ${tx.droppedPlayer} OUT`
                              : tx.type === 'swing_winner'
                                ? `Delete swing winner: ${tx.team}?`
                                : tx.status === 'processed'
                                  ? `Undo ${tx.type}: ${tx.team} added ${tx.player}${tx.droppedPlayer ? ' / dropped ' + tx.droppedPlayer : ''}?\n\nThis will reverse the roster change and refund the $${tx.fee} fee.`
                                  : `Delete ${tx.type} record for ${tx.team}: ${tx.player}?`;
                            const ok = await dialog.showConfirm(
                              tx.status === 'processed' && !['mulligan', 'swing_winner'].includes(tx.type) ? 'Undo Transaction' : 'Delete Transaction',
                              label,
                              { type: 'danger', confirmText: tx.status === 'processed' && !['mulligan', 'swing_winner'].includes(tx.type) ? 'Undo' : 'Delete' },
                            );
                            if (!ok) return;
                            // For processed FA/waiver/drop: full undo with roster reversal
                            if (tx.status === 'processed' && !['mulligan', 'swing_winner'].includes(tx.type)) {
                              undoTransaction(tx, true); // skipConfirm
                            } else {
                              // Simple delete for everything else
                              const newTx = transactions.filter(t => t !== tx);
                              setTransactions(newTx);
                              dialog.showToast('Transaction deleted', 'success');
                            }
                          }}
                          title="Delete transaction"
                          style={{
                            background: 'none', border: 'none', cursor: 'pointer',
                            color: 'rgba(220,80,80,0.6)',
                            padding: '3px 4px', borderRadius: 2,
                            display: 'flex', alignItems: 'center',
                            transition: 'color 0.15s',
                          }}
                          onMouseEnter={e => { e.currentTarget.style.color = 'rgba(240,100,100,0.95)'; }}
                          onMouseLeave={e => { e.currentTarget.style.color = 'rgba(220,80,80,0.6)'; }}
                        >
                          <X style={{ width: 14, height: 14 }} />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
};

