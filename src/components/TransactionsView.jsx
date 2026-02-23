import React, { useState, useMemo } from 'react';
import { X, Edit2, Siren } from 'lucide-react';
import { useDialog } from './DialogContext';
import { getSegmentByDate, makePlayer, getTeamAbbreviation } from '../utils/index.js';
import { storage } from '../api';
import { sfglDataApi } from '../api/supabase';
import { STORAGE_KEYS } from '../constants/index.js';
import { theme, colors, fonts } from '../theme.js';

// ── Inline edit modal ─────────────────────────────────────────────────────────
const EditTransactionModal = ({ tx, txIndex, teams, allPlayers, transactions, setTransactions, updateTeams, onClose }) => {
  const dialog = useDialog();

  // Derive initial values from the transaction
  const [editTeam,   setEditTeam]   = useState(tx.team);
  const [editAdd,    setEditAdd]    = useState(tx.player || '');
  const [editDrop,   setEditDrop]   = useState(tx.droppedPlayer || '');
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
      !rosteredNames.has(p.name) || p.name === tx.player // keep original selectable
    );
  }, [allPlayers, rosteredNames, tx.player]);

  const filteredAdd = addSearch.trim()
    ? availableToAdd.filter(p => p.name.toLowerCase().includes(addSearch.toLowerCase()))
    : availableToAdd.slice(0, 30);

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
    const updatedTx = transactions.map((t, i) =>
      i === txIndex
        ? { ...t, team: newTeam, player: newAdd, droppedPlayer: newDrop || undefined }
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
    await storage.set(STORAGE_KEYS.TRANSACTIONS, updatedTx);
    await storage.set(STORAGE_KEYS.TEAMS, updatedTeams);

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
                      fontFamily: fonts.serif, fontSize: 12,
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
                    fontFamily: fonts.sans, fontSize: 11, color: colors.textMuted,
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
                        fontFamily: fonts.serif, fontSize: 12,
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
export const TransactionsView = ({ transactions, tournaments = [], teams, allPlayers = [], setTransactions, updateTeams, isCommissioner }) => {
  const [filterTeam,   setFilterTeam]   = useState('all');
  const [editingTx,    setEditingTx]    = useState(null); // { tx, txIndex }
  const [addTxOpen,        setAddTxOpen]        = useState(false);
  const [addTxTeam,        setAddTxTeam]        = useState('');
  const [addTxType,        setAddTxType]        = useState('mulligan');
  const [addTxPlayerIn,    setAddTxPlayerIn]    = useState(null);   // selected player object
  const [addTxPlayerOut,   setAddTxPlayerOut]   = useState(null);   // selected player object
  const [addTxTourney,     setAddTxTourney]     = useState('');
  const [addTxSearchIn,    setAddTxSearchIn]    = useState('');
  const [addTxSearchOut,   setAddTxSearchOut]   = useState('');
  const dialog = useDialog();

  const teamFees = useMemo(() => {
    // Determine which swing to show on team cards:
    // Use the swing of the most recent completed tournament (not today's calendar date).
    // This means after WCS ends and before Spring Swing starts, cards still show WCS fees.
    const ALL_SWINGS = ['West Coast Swing', 'Spring Swing', 'Summer Swing', 'Fall Finish'];
    const getSegForTourney = (t) => {
      if (t.segment) return t.segment;
      if (t.dates) {
        const m = t.dates.match(/^([A-Za-z]+)/);
        if (m) {
          const mo = {Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12}[m[1]];
          if (mo) {
            if (mo <= 3) return 'West Coast Swing';
            if (mo <= 6) return 'Spring Swing';
            if (mo <= 9) return 'Summer Swing';
            return 'Fall Finish';
          }
        }
      }
      return null;
    };
    // Find last completed tournament's swing
    const lastCompleted = [...(tournaments || [])].reverse().find(t => t.completed && t.results?.teams);
    const currentSwing = lastCompleted ? getSegForTourney(lastCompleted) : getSegmentByDate();
    const fees = {};
    teams.forEach(t => { fees[t.name] = { seasonTotal: 0, swingTotal: 0, currentSwing, teamId: t.id, teamName: t.name }; });
    transactions.forEach(tx => {
      if (fees[tx.team] && typeof tx.fee === 'number') {
        fees[tx.team].seasonTotal += tx.fee;
        if (tx.segment === currentSwing) fees[tx.team].swingTotal += tx.fee;
      }
    });
    return Object.values(fees).sort((a, b) => b.seasonTotal - a.seasonTotal);
  }, [teams, transactions, tournaments]);

  const TYPE_ORDER = { 'waiver': 0, 'fa': 0, 'free agent': 0, 'drop': 1, 'mulligan': 2 };
  const sortedTransactions = [...transactions].sort((a, b) => {
    // Most recent event first — highest tournamentIndex at top.
    // Transactions without an index (e.g. swing_winner) sort to top.
    const ai = a.tournamentIndex ?? 9999;
    const bi = b.tournamentIndex ?? 9999;
    if (bi !== ai) return bi - ai;
    // Within same tournament: waivers/FA first, then drops, then mulligans
    const ta = TYPE_ORDER[a.type?.toLowerCase()] ?? 1;
    const tb = TYPE_ORDER[b.type?.toLowerCase()] ?? 1;
    return ta - tb;
  });
  const filteredTransactions = filterTeam === 'all'
    ? sortedTransactions
    : sortedTransactions.filter(tx => tx.team === filterTeam);

  const undoTransaction = async (tx) => {
    const ok = await dialog.showConfirm(
      'Undo Transaction',
      'Undo ' + tx.type + ': ' + tx.team + ' added ' + tx.player + (tx.droppedPlayer ? ' / dropped ' + tx.droppedPlayer : '') + '?\n\nThis will reverse the roster change and refund the $' + tx.fee + ' fee.',
      { type: 'danger', confirmText: 'Undo' },
    );
    if (!ok) return;
    const team = teams.find(t => t.name === tx.team);
    if (!team) return;

    let newRoster = team.roster.filter(p => p.name !== tx.player);
    if (tx.droppedPlayer) newRoster.push(makePlayer(tx.droppedPlayer));
    const newTeams = teams.map(t =>
      t.id === team.id
        ? { ...t, roster: newRoster, transactionFees: Math.max(0, (t.transactionFees || 0) - tx.fee) }
        : t,
    );
    const newTransactions = transactions.filter(t => t !== tx);

    updateTeams(newTeams);
    setTransactions(newTransactions);
    await storage.set(STORAGE_KEYS.TEAMS, newTeams);
    await storage.set(STORAGE_KEYS.TRANSACTIONS, newTransactions);
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
    const newTx = {
      team: addTxTeam,
      type: addTxType,
      player: playerInName  || playerOutName || '—',
      droppedPlayer: addTxType === 'mulligan' ? playerOutName || undefined
                   : addTxType === 'drop'     ? undefined
                   : undefined,
      fee: 0,
      segment: tournaments[tournamentIndex]?.segment || '',
      date: new Date().toLocaleDateString(),
      tournamentIndex,
      status: 'completed',
      manualEntry: true,
    };

    const fresh = await storage.get(STORAGE_KEYS.TRANSACTIONS, []);
    const base = Array.isArray(fresh) && fresh.length >= transactions.length ? fresh : transactions;
    const copy = [...base];
    const insertAt = copy.reduce((last, tx, i) =>
      (tx.tournamentIndex !== undefined && tx.tournamentIndex <= tournamentIndex) ? i + 1 : last
    , 0);
    copy.splice(insertAt, 0, newTx);

    setTransactions(copy);
    await storage.set(STORAGE_KEYS.TRANSACTIONS, copy);
    try { await sfglDataApi.set(STORAGE_KEYS.TRANSACTIONS, copy); } catch(e) { console.error('sfgl tx sync failed:', e); }

    dialog.showToast('Transaction added', 'success');
    setAddTxOpen(false);
    setAddTxTeam(''); setAddTxType('mulligan');
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
          <div style={theme.cardHeader}>
            <h2 style={theme.h2}>Transaction Fees</h2>
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
                    <div style={{ fontFamily: fonts.serif, fontSize: 13, color: colors.textPrimary }}>
                      {abbr}
                    </div>
                    <div style={{ ...theme.statNum, fontSize: 13, color: colors.earningsGreen, marginTop: 2 }}>
                      ${team.seasonTotal}
                    </div>
                    <div style={{ fontFamily: fonts.sans, fontSize: 10, color: colors.textMuted, marginTop: 1 }}>
                      ${team.swingTotal} {team.currentSwing ? team.currentSwing.replace(' Swing','').replace('Fall Finish','Fall') : 'swing'}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* ── Commissioner: Add Manual Transaction ── */}
        {isCommissioner && (
          <div style={theme.card}>
            <div
              style={{ ...theme.cardHeader, cursor: 'pointer', userSelect: 'none' }}
              onClick={() => setAddTxOpen(!addTxOpen)}
            >
              <h2 style={theme.h2}>+ Add Transaction</h2>
              <span style={{ fontFamily: fonts.sans, fontSize: 11, color: colors.textMuted }}>
                {addTxOpen ? '▲' : '▼'}
              </span>
            </div>

            {addTxOpen && (
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
                  <div style={{ display: 'flex', gap: 6 }}>
                    {['mulligan', 'waiver', 'fa', 'drop'].map(type => (
                      <button key={type} onClick={() => {
                        setAddTxType(type);
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
                        flex: 1, padding: '7px 4px', borderRadius: 2, fontSize: 11,
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

                {/* Player IN search */}
                {addTxType !== 'drop' && (() => {
                  const teamObj  = teams.find(t => t.name === addTxTeam);
                  const rostered = new Set(teamObj?.roster?.map(p => p.name) || []);
                  // For mulligan IN: search from the team's roster (bench players)
                  // For waiver/fa: search from allPlayers not on any roster
                  const pool = addTxType === 'mulligan'
                    ? (teamObj?.roster || [])  // whole roster — any player could be the swap-in
                    : allPlayers.filter(p => {
                        const allRostered = new Set(teams.flatMap(t => t.roster.map(r => r.name)));
                        return !allRostered.has(p.name);
                      });
                  const filtered = pool.filter(p =>
                    (p.name || p).toLowerCase().includes(addTxSearchIn.toLowerCase())
                  );
                  const label = addTxType === 'mulligan' ? 'Player IN (from roster)' : 'Player Added';
                  return (
                    <div>
                      <div style={{ ...theme.label, marginBottom: 4 }}>{label}</div>
                      {addTxPlayerIn ? (
                        <div style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          padding: '8px 12px', borderRadius: 3, marginBottom: 4,
                          background: 'rgba(80,180,120,0.12)', border: '1px solid rgba(80,180,120,0.35)',
                        }}>
                          <span style={{ fontFamily: fonts.serif, fontSize: 13, color: colors.success }}>{addTxPlayerIn.name}</span>
                          <button onClick={() => { setAddTxPlayerIn(null); setAddTxSearchIn(''); }}
                            style={{ background: 'none', border: 'none', color: colors.textMuted, cursor: 'pointer', fontSize: 12, padding: '0 2px' }}>✕</button>
                        </div>
                      ) : (
                        <>
                          <input
                            type="text"
                            placeholder={'Search ' + (addTxType === 'mulligan' ? 'roster' : 'free agents') + '…'}
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
                                      <span style={{ fontFamily: fonts.sans, fontSize: 10, color: colors.textMuted, minWidth: 26 }}>
                                        {p.worldRank === 999 ? 'NR' : '#' + p.worldRank}
                                      </span>
                                    )}
                                    <span style={{ fontFamily: fonts.serif, fontSize: 13, color: colors.textPrimary }}>{name}</span>
                                  </div>
                                );
                              })}
                              {filtered.length === 0 && (
                                <div style={{ padding: '10px 12px', fontFamily: fonts.sans, fontSize: 11, color: colors.textMuted }}>No players found</div>
                              )}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  );
                })()}

                {/* Player OUT search (mulligan only) */}
                {addTxType === 'mulligan' && (() => {
                  const teamObj = teams.find(t => t.name === addTxTeam);
                  const pool = teamObj?.roster || [];
                  const filtered = pool.filter(p =>
                    (p.name || p).toLowerCase().includes(addTxSearchOut.toLowerCase())
                  );
                  return (
                    <div>
                      <div style={{ ...theme.label, marginBottom: 4 }}>Player OUT (from lineup)</div>
                      {addTxPlayerOut ? (
                        <div style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          padding: '8px 12px', borderRadius: 3, marginBottom: 4,
                          background: colors.dangerBg, border: '1px solid ' + colors.dangerBorder,
                        }}>
                          <span style={{ fontFamily: fonts.serif, fontSize: 13, color: colors.danger }}>{addTxPlayerOut.name}</span>
                          <button onClick={() => { setAddTxPlayerOut(null); setAddTxSearchOut(''); }}
                            style={{ background: 'none', border: 'none', color: colors.textMuted, cursor: 'pointer', fontSize: 12, padding: '0 2px' }}>✕</button>
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
                                    <span style={{ fontFamily: fonts.serif, fontSize: 13, color: colors.textPrimary }}>{name}</span>
                                  </div>
                                );
                              })}
                              {filtered.length === 0 && (
                                <div style={{ padding: '10px 12px', fontFamily: fonts.sans, fontSize: 11, color: colors.textMuted }}>No players found</div>
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
            )}
          </div>
        )}

        {/* ── Transaction history ── */}
        <div style={theme.card}>
          <div style={{ ...theme.cardHeader, justifyContent: 'space-between' }}>
            <h2 style={theme.h2}>Transaction History</h2>
            <select
              value={filterTeam}
              onChange={e => setFilterTeam(e.target.value)}
              style={{ ...theme.select, width: 'auto', fontSize: 11, padding: '5px 10px' }}
              onFocus={e => { e.target.style.borderColor = colors.borderFocus; }}
              onBlur={e => { e.target.style.borderColor = colors.borderInput; }}
            >
              <option value="all">All Teams</option>
              {teams.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
            </select>
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
                    {/* Team name */}
                    <div style={{ fontFamily: fonts.serif, fontSize: 13, color: colors.textPrimary, marginBottom: 2 }}>
                      {tx.team}
                    </div>

                    {/* Transaction detail */}
                    <div style={{ fontFamily: fonts.sans, fontSize: 11, color: colors.textSecondary }}>
                      <span style={{ color: txTypeColor(tx.type) }}>{txTypeLabel(tx.type)}</span>
                      {': '}
                      <span style={{ color: colors.success }}>{tx.player}</span>
                      {tx.droppedPlayer && (
                        <>
                          <span style={{ color: colors.textMuted, margin: '0 3px' }}>→ drop</span>
                          <span style={{ color: colors.danger }}>{tx.droppedPlayer}</span>
                        </>
                      )}
                    </div>

                    {/* Date + tournament + status */}
                    <div style={{ fontFamily: fonts.sans, fontSize: 10, color: colors.textMuted, marginTop: 2, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span>{tx.date}</span>
                      {(() => {
                        const t = tx.tournamentIndex != null ? tournaments[tx.tournamentIndex] : null;
                        const name = t?.name || tx.tournament || null;
                        if (!name) return null;
                        return (
                          <span style={{ color: 'rgba(180,180,210,0.6)' }}>
                            · {name}
                          </span>
                        );
                      })()}
                      {tx.segment && <span>· {tx.segment}</span>}
                      {tx.status && tx.status !== 'processed' && (
                        <span style={{ color: statusColor(tx.status), fontWeight: 600 }}>
                          {tx.status}{tx.failReason ? ' — ' + tx.failReason : ''}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Fee + commish actions */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                    {tx.type === 'mulligan' ? (
                      <Siren style={{ width: 14, height: 14, color: colors.danger, flexShrink: 0 }} />
                    ) : tx.type === 'swing_winner' ? (
                      <span style={{ ...theme.statNum, fontSize: 13, fontWeight: 600, color: colors.textGold }}>
                        +${(tx.amount || 0).toLocaleString()}
                      </span>
                    ) : (
                      <span style={{
                        ...theme.statNum, fontSize: 13, fontWeight: 600,
                        color: tx.fee > 0 ? colors.earningsGreen : colors.textMuted,
                      }}>
                        ${tx.fee}
                      </span>
                    )}

                    {isCommissioner && tx.type !== 'mulligan' && (
                      <>
                        {/* Edit button */}
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

                        {/* Undo button */}
                        <button
                          onClick={() => undoTransaction(tx)}
                          title="Undo transaction"
                          style={{
                            background: 'none', border: 'none', cursor: 'pointer',
                            fontFamily: fonts.sans, fontSize: 10, fontWeight: 600,
                            letterSpacing: '0.5px', color: colors.danger,
                            padding: '2px 0', transition: 'opacity 0.15s',
                          }}
                          onMouseEnter={e => { e.currentTarget.style.opacity = '0.7'; }}
                          onMouseLeave={e => { e.currentTarget.style.opacity = '1'; }}
                        >
                          Undo
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
