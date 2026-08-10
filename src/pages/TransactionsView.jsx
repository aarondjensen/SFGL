import { useState, useMemo } from 'react';
import { X, Edit2 } from 'lucide-react';
import { useDialog } from './DialogContext';
import { getSegmentByDate, getSegmentForTournament, getTeamAbbreviation, abbreviateName as shortName } from '../utils/index.js';
import { TeamName } from '../components/TeamName';
import { buildPlayerAttributeIndex, hydratePlayer, resolveTxTournament,
         getSeasonFeesForTeam, getSwingFeesForTeam, getSwingPot,
         effectiveTransactionFee, txBelongsToTeam, resolveTxTeam } from '../utils/sharedHelpers';
import { theme, colors, fonts, getSwingColor, SWINGS, blue, green, greenMuted, red, white, fontSize } from '../theme.js';
import { BottomSheet } from '../components/BottomSheet';
import { AddTransactionModal } from './AddTransactionModal';

// shortName imported from utils (see abbreviateName)

// ── Inline edit modal ─────────────────────────────────────────────────────────
const EditTransactionModal = ({ tx, txIndex, teams, tournaments, allPlayers, transactions, setTransactions, updateTeams, onClose }) => {
  const dialog = useDialog();

  // ── Escape key + body scroll lock (shared) ────────────────────────────────

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

    // Update the transaction record.
    //
    // Matched by IDENTITY (doc id, then txId), not by the array position
    // captured when the modal opened. useLeague holds a live Firestore
    // subscription, so any change from any source — the cron, another
    // manager, this user on another device — replaces the transactions array
    // underneath an open modal. A positional `i === txIndex` write then lands
    // on whatever transaction happens to occupy that slot now, silently
    // rewriting the wrong record. Falls back to the index only when the row
    // has neither id nor txId (very old local-only rows).
    const newTourneyIdx = editTourneyIdx !== '' ? parseInt(editTourneyIdx) : tx.tournamentIndex;
    const isTarget = (t, i) => {
      if (tx.id)   return t.id === tx.id;
      if (tx.txId) return t.txId === tx.txId;
      return i === txIndex;
    };
    if (!transactions.some(isTarget)) {
      setSaving(false);
      dialog.showToast('That transaction no longer exists — it may have been deleted or reprocessed. Nothing was changed.', 'error');
      onClose();
      return;
    }
    // Reassigning the team must move teamId as well. txBelongsToTeam PREFERS
    // teamId over the name, so leaving a stale id behind would make the row
    // keep counting against the old team no matter what the name says — the
    // inverse of the rename bug, and just as silent.
    const newTeamId = teams.find(t => t.name === newTeam)?.id || newTeam;
    const updatedTx = transactions.map((t, i) =>
      isTarget(t, i)
        ? { ...t, team: newTeam, teamId: newTeamId, player: newAdd, droppedPlayer: newDrop || undefined, tournamentIndex: newTourneyIdx, tournament: tournaments[newTourneyIdx]?.name ?? t.tournament, segment: tournaments[newTourneyIdx]?.segment || t.segment }
        : t
    );

    // Restoring a dropped player hydrates from the durable attribute index, so
    // a LIMITED player comes back limited with their stars, years of service
    // and SFGL tallies intact. makePlayer() — used here previously — mints a
    // fresh UNLIMITED player with zeroed stats, which is the same data loss
    // the undo path already fixed by switching to hydratePlayer; this edit
    // path was simply never updated to match.
    const attrIndex = buildPlayerAttributeIndex(teams, tournaments);

    // Patch the old team's roster: undo old change, apply new change
    let updatedTeams = teams.map(t => {
      // Reverse old transaction on old team
      if (t.name === oldTeam) {
        let r = [...t.roster];
        // Remove the old added player
        r = r.filter(p => p.name !== oldAdd);
        // Re-add the old dropped player (if there was one)
        if (oldDrop && !r.some(p => p.name === oldDrop)) r.push(hydratePlayer(oldDrop, attrIndex));
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
        if (!r.some(p => p.name === newAdd)) r.push(hydratePlayer(newAdd, attrIndex));
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
    <BottomSheet isOpen onClose={onClose} variant="panel" accent={blue(0.5)} label="Edit transaction">
        {/* Header */}
        <div style={{
          padding: '14px 18px',
          background: blue(0.08),
          borderBottom: `1px solid ${colors.borderSubtle}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexShrink: 0,
        }}>
          <div>
            <h2 style={{ fontFamily: fonts.serif, fontSize: 15, color: 'rgba(150,190,255,0.9)', margin: 0 }}>
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
                      background: sel ? greenMuted(0.15) : white(0.03),
                      border: `1px solid ${sel ? greenMuted(0.4) : colors.borderSubtle}`,
                      fontFamily: fonts.serif, fontSize: fontSize.sm,
                      color: sel ? colors.success : colors.textPrimary,
                      transition: 'all 0.1s',
                    }}
                    onMouseEnter={e => { if (!sel) e.currentTarget.style.background = white(0.055); }}
                    onMouseLeave={e => { if (!sel) e.currentTarget.style.background = white(0.03); }}
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
                    background: !editDrop ? white(0.06) : white(0.03),
                    border: `1px solid ${!editDrop ? colors.borderInput : colors.borderSubtle}`,
                    fontFamily: fonts.sans, fontSize: fontSize.caption, color: colors.textMuted,
                  }}
                >
                  — None —
                </div>
                {droppableRoster.map(p => {
                  const sel = editDrop === p.name;
                  return (
                    <div
                      key={p.name}
                      onClick={() => setEditDrop(p.name)}
                      style={{
                        padding: '7px 10px', borderRadius: 2, cursor: 'pointer',
                        background: sel ? colors.dangerBg : white(0.03),
                        border: `1px solid ${sel ? colors.dangerBorder : colors.borderSubtle}`,
                        fontFamily: fonts.serif, fontSize: fontSize.sm,
                        color: sel ? colors.danger : colors.textPrimary,
                        transition: 'all 0.1s',
                      }}
                      onMouseEnter={e => { if (!sel) e.currentTarget.style.background = 'rgba(180,60,60,0.07)'; }}
                      onMouseLeave={e => { if (!sel) e.currentTarget.style.background = white(0.03); }}
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
              background: canSave ? blue(0.18) : white(0.04),
              border: `1px solid ${canSave ? blue(0.45) : colors.borderSubtle}`,
              color: canSave ? 'rgba(150,190,255,0.9)' : colors.textMuted,
              cursor: canSave && !saving ? 'pointer' : 'not-allowed',
            }}
          >
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
    </BottomSheet>
  );
};

// ── Main view ─────────────────────────────────────────────────────────────────
export const TransactionsView = ({ transactions, tournaments = [], teams, allPlayers = [], setTransactions, updateTeams, setTournaments, isCommissioner, settings = {}, loggedInUser, STORAGE_KEYS }) => {
  const [filterTeam,   setFilterTeam]   = useState('all');
  const [filterSwing,  setFilterSwing]  = useState('all');
  const [editingTx,    setEditingTx]    = useState(null); // { tx, txIndex }
  // showAddTx is the only piece of add-transaction state TransactionsView
  // owns. The modal manages everything else (team/type/tourney/players)
  // internally and resets on close. See AddTransactionModal.jsx.
  const [showAddTx,    setShowAddTx]    = useState(false);
  const dialog = useDialog();

  // ── Pending waivers live only on the Rosters page ───────────────────────────
  // A waiver claim that hasn't processed yet (status 'pending') is NEVER shown in
  // the transaction history — not in the feed, and not in the per-team fee cards —
  // for ANY viewer, commissioner included. Managers manage their own claims from
  // the Rosters page's "Pending Waiver Claims" box; the commissioner processes
  // them there too. A claim only surfaces here once the weekly round runs and its
  // status flips to 'processed' or 'failed'. We filter once and drive BOTH the fee
  // summary and the feed off the result so they can never disagree. Mutation paths
  // (delete/undo/edit) and realIndex() keep using the full `transactions` prop.
  const visibleTransactions = useMemo(
    () => transactions.filter(tx => !(tx.type === 'waiver' && tx.status === 'pending')),
    [transactions],
  );

  // Wave C.5: was a local re-implementation of segment-from-tournament
  // resolution that disagreed slightly with utils on the boundary handling.
  // The canonical version (getSegmentForTournament from utils) handles the
  // same cases plus also tries t.startDate before falling back to t.dates,
  // which is more robust. Aliased here to avoid touching every call site.
  const getSegForTourney = getSegmentForTournament;

  // Which swing the fee counter is currently reporting on:
  //   1. the swing of the last completed tournament, then
  //   2. if that swing has already been awarded, advance to the swing holding
  //      the next upcoming non-alternate event — which resets the counter to $0
  //      the moment the commish awards the pot.
  const currentSwing = useMemo(() => {
    const lastCompleted = [...(tournaments || [])].reverse().find(t => t.completed && t.results?.teams);
    const lastSeg = lastCompleted ? getSegForTourney(lastCompleted) : getSegmentByDate();
    const awarded = visibleTransactions.some(tx => tx.type === 'swing_winner' && tx.segment === lastSeg);
    if (!awarded) return lastSeg;
    const nextTourney = (tournaments || []).find(t => !t.completed && !t.isAlternate);
    return nextTourney ? (getSegForTourney(nextTourney) || lastSeg) : lastSeg;
  }, [tournaments, visibleTransactions, getSegForTourney]);

  // Per-team fee tallies.
  //
  // The season and swing sums come from sharedHelpers now. This memo used to
  // carry its own copy of the whole calculation — the in-segment name/index
  // sets, the alternate exclusion, the failed/swing_winner skips and the
  // stored-else-derived fee rule — duplicating getSwingPot line for line. The
  // two had already drifted once (getSwingPot was dropping fees from
  // in-progress events, so this panel and the swing pot showed different
  // totals for the same swing), and a second copy meant a second chance to
  // drift again. getSwingPot is now defined AS the sum of getSwingFeesByTeam,
  // the same map that feeds these cards, so the pot and the cards cannot
  // disagree by construction.
  const teamFees = useMemo(() =>
    teams
      .map(t => ({
        teamId: t.id,
        teamName: t.name,
        currentSwing,
        // Resolved per team via txBelongsToTeam rather than bucketed by the
        // tx.team string, so a row carrying a stable teamId lands on the right
        // card even if its name field is momentarily out of step (a rename
        // whose re-key has not finished, say).
        seasonTotal: getSeasonFeesForTeam(visibleTransactions, settings, t),
        swingTotal: getSwingFeesForTeam(visibleTransactions, tournaments, currentSwing, settings, t),
      }))
      .sort((a, b) => b.seasonTotal - a.seasonTotal),
    [teams, visibleTransactions, tournaments, currentSwing, settings]);

  // The headline pot, taken from the authoritative helper rather than by
  // re-summing the cards. Identical in the normal case; where they differ it is
  // because a transaction's tx.team no longer matches any current team name,
  // and this is the figure the swing winner is actually paid.
  const swingPot = useMemo(
    () => getSwingPot(visibleTransactions, tournaments, currentSwing, settings),
    [visibleTransactions, tournaments, currentSwing, settings]
  );

  const TYPE_ORDER = { 'waiver': 0, 'fa': 1, 'free agent': 1, 'drop': 2, 'mulligan': 3, 'swing_winner': 99 };
  // Build a map of segment → last tournamentIndex for sorting swing_winner records.
  const swingLastIndex = {};
  tournaments.forEach((t, i) => {
    const seg = t.segment || '';
    if (seg && t.completed) swingLastIndex[seg] = Math.max(swingLastIndex[seg] ?? -1, i);
  });

  const sortedTransactions = [...visibleTransactions].sort((a, b) => {
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
    // Same tournament: sort by type order. Mulligan is always last because it
    // happens after the event has started (Waiver → Waiver Blocked → Free Agent
    // → Drop → Mulligan).
    const ta = TYPE_ORDER[a.type?.toLowerCase()] ?? 1;
    const tb = TYPE_ORDER[b.type?.toLowerCase()] ?? 1;
    if (ta !== tb) return ta - tb;
    // Within waivers: successful first, then blocked (Waiver → Waiver Blocked)
    if (a.type === 'waiver' && b.type === 'waiver') {
      const sa = a.status === 'failed' ? 1 : 0;
      const sb = b.status === 'failed' ? 1 : 0;
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
    // Resolve by stable name (reorder-safe); legacy rows fall back to index.
    const t = resolveTxTournament(tx, tournaments);
    if (t) return getSegForTourney(t);
    return '';
  };

  const filteredTransactions = sortedTransactions
    .filter(tx => {
      if (filterTeam === 'all') return true;
      const t = teams.find(x => x.name === filterTeam);
      return t ? txBelongsToTeam(tx, t) : tx.team === filterTeam;
    })
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
    const team = resolveTxTeam(tx, teams);
    if (!team) return;

    // Remove the added player from the roster (filters all instances — defensive
    // against pre-existing duplicates from prior corruption)
    let newRoster = team.roster.filter(p => p.name !== tx.player);

    // Restore the dropped player — but ONLY if they're not already on the
    // roster. Without this guard, undoing two transactions that both dropped
    // the same player results in that player appearing twice (the bug that
    // put two Ryan Foxes on World #1).
    if (tx.droppedPlayer && !newRoster.some(p => p.name === tx.droppedPlayer)) {
      // Hydrate from the durable index so undoing a transaction that dropped a
      // LIMITED player restores them limited, with stars and SFGL data intact —
      // not as a fresh unlimited player (the old allPlayers lookup carried only
      // world rank, so limited status was silently lost on every undo).
      newRoster.push(hydratePlayer(tx.droppedPlayer, buildPlayerAttributeIndex(teams, tournaments)));
    }

    const newTeams = teams.map(t =>
      t.id === team.id
        ? { ...t, roster: newRoster, transactionFees: Math.max(0, (t.transactionFees || 0) - (tx.fee || 0)) }
        : t,
    );

    // Remove this transaction; also restore any blocked losers back to pending
    // so the commissioner can re-process the waiver round fairly.
    // Filter by id (not reference) — the delete handler synthesises a fresh
    // `liveTx` from a Firestore status refetch, which is a NEW object that
    // would never match `t !== tx` against the original array reference.
    const newTransactions = transactions
      .filter(t => tx.id ? t.id !== tx.id : t !== tx)
      .map(t => {
        if (
          t.status === 'failed' &&
          t.type === 'waiver' &&
          t.player === tx.player &&
          t.failReason?.toLowerCase().includes('lost tiebreaker')
        ) {
          // Re-queue the blocked claim so it can be processed again
          const { failReason, processedDate, ...rest } = t;
          return { ...rest, status: 'pending' };
        }
        return t;
      });

    updateTeams(newTeams);
    // sync() never deletes by absence — pass the removed tx explicitly.
    setTransactions(newTransactions, { deleted: [tx] });
    dialog.showToast('Undone: ' + tx.player + ' removed from ' + tx.team, 'success');
  };

  const txTypeColor = (type) => {
    if (type === 'drop') return colors.danger;
    return colors.textGold;  // mulligan, waiver, fa, free agent, swing_winner all gold
  };

  // Human-readable label for transaction type
  const txTypeLabel = (type) => {
    if (type === 'swing_winner') return 'swing winner';
    if (type === 'fa') return 'free agent';
    return type;
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

      {/* Commissioner-only Add Transaction modal. Replaces the previous
          inline panel — the form lives in its own component now and resets
          on close, so it behaves like every other modal in the app. */}
      <AddTransactionModal
        isOpen={isCommissioner && showAddTx}
        onClose={() => setShowAddTx(false)}
        teams={teams}
        tournaments={tournaments}
        setTournaments={setTournaments}
        allPlayers={allPlayers}
        transactions={transactions}
        setTransactions={setTransactions}
        updateTeams={updateTeams}
        settings={settings}
        loggedInUser={loggedInUser}
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

        {/* ── Fee summary ── */}
        <div style={theme.card}>
          <div style={{ ...theme.sectionHeaderBar, justifyContent: 'space-between' }}>
            <h2 style={{ ...theme.sectionTitle, margin: 0 }}>Transaction Fees</h2>
            {teamFees[0]?.currentSwing && (() => {
              const swingColor = getSwingColor(teamFees[0].currentSwing);
              return (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontFamily: fonts.sans, fontSize: fontSize.xs, letterSpacing: '0.3px', color: swingColor }}>
                    {teamFees[0].currentSwing}
                  </span>
                  {swingPot > 0 && (
                    <span style={{ fontFamily: fonts.mono, fontSize: fontSize.sm, fontWeight: 700, color: swingColor }}>
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
                    background: white(0.03),
                    border: `1px solid ${colors.borderSubtle}`,
                    borderRadius: 10, padding: '8px 6px', textAlign: 'center', minWidth: 0,
                  }}>
                    <div style={{ fontFamily: fonts.serif, fontSize: fontSize.base, color: colors.textPrimary }}>
                      {abbr}
                    </div>
                    <div style={{ ...theme.statNum, fontSize: fontSize.base, color: colors.textGold, marginTop: 2 }}>
                      ${team.seasonTotal}
                    </div>
                    <div style={{ fontFamily: fonts.sans, fontSize: fontSize.xs, color: getSwingColor(team.currentSwing), marginTop: 1 }}>
                      ${team.swingTotal} swing
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* ── Transaction history ── */}
        <div style={theme.card}>
          <div style={{ ...theme.sectionHeaderBar, justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {isCommissioner && (
                <button
                  onClick={() => setShowAddTx(true)}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    padding: '4px 10px', borderRadius: 6,
                    fontFamily: fonts.sans, fontSize: fontSize.caption, fontWeight: 700,
                    cursor: 'pointer',
                    transition: 'background 0.15s',
                    background: green(0.1),
                    border: `1px solid ${green(0.4)}`,
                    color: colors.earningsGreen,
                    letterSpacing: '0.2px',
                    lineHeight: 1,
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = green(0.2); }}
                  onMouseLeave={e => { e.currentTarget.style.background = green(0.1); }}
                  title="Add manual transaction"
                >
                  <span style={{ fontSize: fontSize.base, fontWeight: 800 }}>+</span>
                  <span>Add</span>
                </button>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, flex: 1 }}>
              <select
                value={filterSwing}
                onChange={e => setFilterSwing(e.target.value)}
                style={{ ...theme.select, flex: 1, minWidth: 0, fontSize: fontSize.caption, padding: '5px 10px', borderRadius: 8 }}
                onFocus={e => { e.target.style.borderColor = colors.borderFocus; }}
                onBlur={e => { e.target.style.borderColor = colors.borderInput; }}
              >
                <option value="all">All Swings</option>
                {/* Rendered from SWINGS rather than spelled out, so renaming or
                    reordering a swing can't leave this filter behind. */}
                {SWINGS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <select
                value={filterTeam}
                onChange={e => setFilterTeam(e.target.value)}
                style={{ ...theme.select, flex: 1, minWidth: 0, fontSize: fontSize.caption, padding: '5px 10px', borderRadius: 8 }}
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
                      <span style={{ fontFamily: fonts.serif, fontSize: 'clamp(13px, 1.1vw, 15px)', color: colors.textPrimary }}>
                        <TeamName name={tx.team} />
                      </span>
                      {(() => {
                        // swing_winner: show swing name; others: show tournament name
                        if (tx.type === 'swing_winner') {
                          return tx.segment
                            ? <span style={{ fontFamily: fonts.sans, fontSize: 'clamp(10px, 0.8vw, 12px)', color: white(0.45) }}>{tx.segment}</span>
                            : null;
                        }
                        const t = resolveTxTournament(tx, tournaments);
                        const name = t?.name || tx.tournament || null;
                        if (!name) return null;
                        return (
                          <span style={{ fontFamily: fonts.sans, fontSize: 'clamp(10px, 0.8vw, 12px)', color: white(0.45) }}>
                            {name}
                          </span>
                        );
                      })()}
                    </div>

                    {/* Transaction detail */}
                    <div style={{ fontFamily: fonts.sans, fontSize: 'clamp(11px, 0.9vw, 13px)', color: colors.textSecondary }}>
                      <span style={{ color: txTypeColor(tx.type) }}>{txTypeLabel(tx.type)}</span>
                      {tx.status === 'failed' && tx.type === 'waiver' && (
                        <span style={{ fontFamily: fonts.sans, fontSize: 'clamp(9px, 0.75vw, 11px)', fontWeight: 700, color: colors.textGold, marginLeft: 5, letterSpacing: '0.4px' }}>BLOCKED</span>
                      )}
                      {': '}
                      <span style={{ color: tx.status === 'failed' ? colors.danger : colors.success }}>
                        {tx.type === 'swing_winner'
                          ? (tx.player ? shortName(tx.player) : tx.team)
                          : shortName(tx.player)
                        }
                      </span>
                      {tx.droppedPlayer && !(tx.status === 'failed' && tx.type === 'waiver') && (
                        <>
                          <span style={{ color: colors.textMuted, margin: '0 3px' }}>→ {tx.type === 'mulligan' ? 'out' : 'drop'}</span>
                          <span style={{ color: colors.danger }}>{shortName(tx.droppedPlayer)}</span>
                        </>
                      )}
                    </div>
                    {tx.status === 'failed' && tx.failReason && (
                      <div style={{ fontFamily: fonts.sans, fontSize: 'clamp(9px, 0.7vw, 10px)', color: colors.textMuted, marginTop: 1 }}>
                        {tx.failReason}
                      </div>
                    )}
                  </div>

                  {/* Fee + commish actions */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                    {tx.type === 'mulligan' ? (
                      <span style={{ fontSize: fontSize.md, lineHeight: 1 }}>🚨</span>
                    ) : tx.type === 'swing_winner' ? (
                      <span style={{ ...theme.statNum, fontSize: fontSize.base, fontWeight: 600, color: colors.textGold }}>
                        +${(tx.amount || 0).toLocaleString()}
                      </span>
                    ) : (
                      <span style={{
                        ...theme.statNum, fontSize: fontSize.base, fontWeight: 600,
                        color: tx.status === 'failed' ? colors.textMuted
                          : (effectiveTransactionFee(tx, settings) > 0 ? colors.earningsGreen : colors.textMuted),
                      }}>
                        {tx.status === 'failed' ? '—' : `$${effectiveTransactionFee(tx, settings)}`}
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
                              color: blue(0.65),
                              padding: '3px 4px', borderRadius: 2,
                              display: 'flex', alignItems: 'center',
                              transition: 'color 0.15s',
                            }}
                            onMouseEnter={e => { e.currentTarget.style.color = 'rgba(150,190,255,0.9)'; }}
                            onMouseLeave={e => { e.currentTarget.style.color = blue(0.65); }}
                          >
                            <Edit2 style={{ width: 13, height: 13 }} />
                          </button>
                        )}

                        {/* Delete button — red ✕ for all types */}
                        <button
                          onClick={async () => {
                            // Refresh the live status from Firestore before deciding
                            // undo vs simple-delete. The cron may have processed this
                            // tx since last refresh; if so we MUST take the undo path
                            // to reverse the roster change. Without this check, a
                            // user looking at stale "pending" UI would simple-delete
                            // a transaction that had actually been processed,
                            // leaving the roster effect orphaned (the bug that put
                            // Ryan Fox on Hip Happens with no transaction record).
                            let liveTx = tx;
                            if (tx.id && tx.type !== 'mulligan' && tx.type !== 'swing_winner') {
                              try {
                                const { transactionsApi } = await import('../api/firebase');
                                const fresh = await transactionsApi.getById?.(tx.id);
                                if (fresh) liveTx = { ...tx, ...fresh };
                              } catch (e) {
                                console.warn('[TransactionsView] could not refresh tx status:', e);
                              }
                            }
                            const statusChanged = liveTx.status !== tx.status;
                            // FA/waiver/drop processed → roster + fee reversal
                            const isUndoPath = liveTx.status === 'processed' && !['mulligan', 'swing_winner'].includes(liveTx.type);
                            // swing_winner with positive amount → earnings reversal
                            const isSwingUndoPath = liveTx.type === 'swing_winner' && (liveTx.amount || 0) > 0;

                            const isMulligan = liveTx.type === 'mulligan';
                            const label = isMulligan
                              ? `Reverse mulligan for ${liveTx.team}?\n\nRestores ${liveTx.droppedPlayer} and removes ${liveTx.player}. This reverses the lineup, results, standings and starts, restores the mulligan allowance, and refunds the fee.`
                              : isSwingUndoPath
                                ? `Undo ${liveTx.segment || 'swing'} winner: ${liveTx.team}?\n\nThis will subtract $${(liveTx.amount || 0).toLocaleString()} from ${liveTx.team}'s total earnings and remove this transaction. The pot returns to "unawarded" status.`
                                : isUndoPath
                                  ? `${statusChanged ? '⚠️ This was processed since you last refreshed.\n\n' : ''}Undo ${liveTx.type}: ${liveTx.team} added ${liveTx.player}${liveTx.droppedPlayer ? ' / dropped ' + liveTx.droppedPlayer : ''}?\n\nThis will reverse the roster change and refund the $${liveTx.fee} fee.`
                                  : `Delete ${liveTx.type} record for ${liveTx.team}: ${liveTx.player}?`;
                            const ok = await dialog.showConfirm(
                              isMulligan ? 'Reverse Mulligan' : (isUndoPath || isSwingUndoPath) ? 'Undo Transaction' : 'Delete Transaction',
                              label,
                              { type: 'danger', confirmText: isMulligan ? 'Reverse' : (isUndoPath || isSwingUndoPath) ? 'Undo' : 'Delete' },
                            );
                            if (!ok) return;
                            // Mulligan: full reversal (lineup, results, standings,
                            // starts, earnings, allowance) + registry force-reset,
                            // then remove the record (its fee is derived, so it
                            // drops out of the pot automatically).
                            if (isMulligan) {
                              try {
                                const { computeMulliganReversal } = await import('../utils/mulliganReversal');
                                const r = computeMulliganReversal(liveTx, teams, tournaments);
                                if (r.error) { dialog.showToast(`Cannot reverse mulligan: ${r.error}`, 'error'); return; }
                                if (r.processed) setTournaments(r.newTournaments);
                                updateTeams(r.newTeams, r.registryOverrides);
                                const newTx = transactions.filter(t => liveTx.id ? t.id !== liveTx.id : t !== liveTx);
                                setTransactions(newTx, { deleted: [liveTx] });
                                const s = r.summary || {};
                                dialog.showToast(
                                  r.processed
                                    ? `Mulligan reversed: ${s.playerOut} restored, ${s.playerIn} removed (${(s.delta || 0) >= 0 ? '+' : '\u2212'}$${Math.abs(s.delta || 0).toLocaleString()} to ${liveTx.team})`
                                    : `Mulligan reversed: ${s.playerOut} restored to ${liveTx.team}'s lineup`,
                                  'success',
                                );
                              } catch (e) {
                                console.error('[TransactionsView] mulligan reversal failed:', e);
                                dialog.showToast('Mulligan reversal failed \u2014 see console. Nothing was changed.', 'error');
                              }
                              return;
                            }
                            // For processed FA/waiver/drop: full undo with roster reversal
                            if (isUndoPath) {
                              undoTransaction(liveTx, true); // skipConfirm
                            } else if (isSwingUndoPath) {
                              // Delete the swing_winner tx; the pot becomes
                              // "unawarded" again and the next auto-award trigger
                              // can re-award it.
                              //
                              // No team.earnings adjustment: the pot is a side
                              // prize carried on the transaction (tx.amount) and
                              // is no longer folded into team.earnings when
                              // awarded (see computeSwingAward). Subtracting here
                              // would now deduct money the award never added.
                              const newTx = transactions.filter(t => liveTx.id ? t.id !== liveTx.id : t !== liveTx);
                              setTransactions(newTx, { deleted: [liveTx] });
                              dialog.showToast(`Swing winner reversed: -$${(liveTx.amount || 0).toLocaleString()} from ${liveTx.team}`, 'success');
                            } else {
                              // Simple delete for everything else
                              const newTx = transactions.filter(t => tx.id ? t.id !== tx.id : t !== tx);
                              setTransactions(newTx, { deleted: [liveTx] });
                              dialog.showToast('Transaction deleted', 'success');
                            }
                          }}
                          title="Delete transaction"
                          style={{
                            background: 'none', border: 'none', cursor: 'pointer',
                            color: red(0.6),
                            padding: '3px 4px', borderRadius: 2,
                            display: 'flex', alignItems: 'center',
                            transition: 'color 0.15s',
                          }}
                          onMouseEnter={e => { e.currentTarget.style.color = 'rgba(240,100,100,0.95)'; }}
                          onMouseLeave={e => { e.currentTarget.style.color = red(0.6); }}
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

