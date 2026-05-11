import React, { useState, useMemo } from 'react';
import { useDialog } from './DialogContext';
import { getSegmentByDate, getSegmentForTournament, normalizePlayerName } from '../utils';
import { DraftModal } from './DraftModal';
import { managerAuthApi, tournamentResultsApi, sfglDataApi, playersApi, playerRankingsApi, teamsApi } from '../api/firebase';
import { seedAliasesToFirestore } from '../constants/nameAliases';
import { theme, colors, fonts, SWINGS } from '../theme.js';
import { BONUSES_REGULAR, BONUSES_MAJOR, LIV_GOLF_ROSTER } from '../constants';


// ── Wave E: CollapsibleGroup ────────────────────────────────────────────────
// Wraps a set of related admin sections into a collapsible accordion group.
// Persists open/closed state in localStorage so a refresh remembers what the
// commish had collapsed.
const CG_STATE_KEY = 'sfgl-admin-group-state';
const _readGroupState = () => {
  try { return JSON.parse(localStorage.getItem(CG_STATE_KEY) || '{}') || {}; }
  catch { return {}; }
};
const _writeGroupState = (state) => {
  try { localStorage.setItem(CG_STATE_KEY, JSON.stringify(state)); } catch {}
};

const CollapsibleGroup = ({ title, icon, children }) => {
  // Default each group to OPEN. Commish can collapse to focus on one group.
  const [open, setOpen] = React.useState(() => {
    const s = _readGroupState();
    return s[title] !== false; // treat undefined or true as open
  });
  const toggle = () => {
    const next = !open;
    setOpen(next);
    const s = _readGroupState();
    s[title] = next;
    _writeGroupState(s);
  };
  return (
    <div style={{ marginBottom: open ? 0 : 4 }}>
      <button
        onClick={toggle}
        aria-expanded={open}
        aria-label={(open ? 'Collapse ' : 'Expand ') + title + ' group'}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          width: '100%', padding: '10px 14px', marginBottom: open ? 8 : 0,
          background: 'rgba(20, 45, 80, 0.45)',
          border: '1px solid rgba(180,160,100,0.18)',
          borderRadius: 4,
          cursor: 'pointer',
          fontFamily: fonts.sans,
          fontSize: 11, fontWeight: 700,
          letterSpacing: '2px', textTransform: 'uppercase',
          color: 'rgba(245,197,24,0.92)',
          transition: 'background 0.15s, border-color 0.15s',
        }}
        onMouseEnter={e => { e.currentTarget.style.background = 'rgba(20,45,80,0.65)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'rgba(20,45,80,0.45)'; }}
      >
        <span style={{ fontSize: 13 }}>{icon}</span>
        <span style={{ flex: 1, textAlign: 'left' }}>{title}</span>
        <span style={{
          fontSize: 11, color: 'rgba(245,197,24,0.6)',
          transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
          transition: 'transform 0.15s',
        }}>▼</span>
      </button>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 12 }}>
          {children}
        </div>
      )}
    </div>
  );
};



// ── Tournament processing helpers ────────────────────────────────────────────

const matchPlayerName = (a, b) => {
  const na = normalizePlayerName(a);
  const nb = normalizePlayerName(b);
  if (na === nb) return true;
  const wa = na.split(' '); const wb = nb.split(' ');
  if (wa.length === wb.length) return wa.every(w => wb.includes(w));
  return false;
};

// Compute a team's effective current roster. Mirrors the same logic used by
// AddDropPlayerModal (lines 195-203 in /mnt/project) and RostersView's
// useRoster hook so the three views agree on roster contents.
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

/**
 * Core tournament processing. Mirrors the original processTournamentResults logic.
 * Returns { newTeams, newStats, resultsData }.
 */
const processTournamentData = (tournament, tournamentData, teams, globalPlayerStats, _unusedNames, transactions = []) => {
  const bonuses = tournament.isMajor ? BONUSES_MAJOR : BONUSES_REGULAR;

  // Build earningsMap from the tournamentData
  const earningsMap = {};
  if (tournamentData.earningsMap instanceof Map) {
    tournamentData.earningsMap.forEach((earnings, name) => { earningsMap[name] = earnings; });
  } else if (tournamentData.earningsMap && typeof tournamentData.earningsMap === 'object') {
    Object.assign(earningsMap, tournamentData.earningsMap);
  } else if (Array.isArray(tournamentData.competitors)) {
    tournamentData.competitors.forEach(p => {
      const name = p.athlete?.displayName;
      const earn = p.earnings || 0;
      if (name && earn > 0) earningsMap[name] = earn;
    });
  }

  // Update global stats
  const newStats = { ...globalPlayerStats };
  Object.entries(earningsMap).forEach(([playerName, earnings]) => {
    if (!newStats[playerName]) newStats[playerName] = { eventsPlayed: 0, cutsMade: 0, pgaTourEarnings: 0 };
    newStats[playerName] = {
      ...newStats[playerName],
      eventsPlayed: newStats[playerName].eventsPlayed + 1,
      cutsMade:     newStats[playerName].cutsMade + (earnings > 0 ? 1 : 0),
      pgaTourEarnings: newStats[playerName].pgaTourEarnings + earnings,
    };
  });

  const resultsData = { teams: {}, earningsMap: { ...earningsMap }, roundLeaders: tournamentData.roundLeaders || {}, fullLineups: {} };

  const newTeams = teams.map(team => {
    if (!team.lineup || team.lineup.length === 0) return team;

    resultsData.fullLineups[team.id] = [...team.lineup];

    const starterResults = team.lineup.map(playerName => {
      let earnings = earningsMap[playerName];
      if (earnings === undefined) {
        const mk = Object.keys(earningsMap).find(k => matchPlayerName(k, playerName));
        earnings = mk !== undefined ? earningsMap[mk] : 0;
      }
      return { playerName, earnings: earnings || 0 };
    });

    const topStarters = [...starterResults].sort((a, b) => b.earnings - a.earnings).slice(0, 5);
    let totalEarnings = topStarters.reduce((s, p) => s + p.earnings, 0);
    const bonusEarnings = { round1: 0, round2: 0, round3: 0 };
    const playersWithBonuses = {};

    if (tournamentData.roundLeaders) {
      ['round1', 'round2', 'round3'].forEach(round => {
        const leaders = Array.isArray(tournamentData.roundLeaders[round])
          ? tournamentData.roundLeaders[round]
          : (tournamentData.roundLeaders[round] ? [tournamentData.roundLeaders[round]] : []);
        leaders.forEach(leaderName => {
          if (!leaderName) return;
          const actual = team.lineup.find(pn => normalizePlayerName(pn) === normalizePlayerName(leaderName));
          if (actual) {
            bonusEarnings[round] = bonuses[round];
            totalEarnings += bonuses[round];
            if (!playersWithBonuses[actual]) playersWithBonuses[actual] = { total: 0, rounds: [] };
            playersWithBonuses[actual].total  += bonuses[round];
            playersWithBonuses[actual].rounds.push({ round: round.replace('round', ''), bonus: bonuses[round] });
          }
        });
      });
    }

    resultsData.teams[team.id] = {
      totalEarnings,
      bonuses: bonusEarnings,
      players: topStarters.map(s => ({
        name: s.playerName,
        earnings: s.earnings,
        limited: team.roster.find(p => p.name === s.playerName)?.limited || false,
        bonus: playersWithBonuses[s.playerName]?.total || 0,
        roundsLed: playersWithBonuses[s.playerName]?.rounds || [],
        wasRoundLeader: (playersWithBonuses[s.playerName]?.total || 0) > 0,
      })),
    };

    const updatedRoster = team.roster.map(player => {
      if (!team.lineup.includes(player.name)) return player;
      let pe = earningsMap[player.name];
      if (pe === undefined) { const mk = Object.keys(earningsMap).find(k => matchPlayerName(k, player.name)); if (mk) pe = earningsMap[mk]; }
      return { ...player, starts: (player.starts || 0) + 1, sfglEarnings: (player.sfglEarnings || 0) + (pe || 0) };
    });

    return {
      ...team,
      roster: updatedRoster,
      earnings: (team.earnings || 0) + totalEarnings,
      segmentEarnings: (team.segmentEarnings || 0) + totalEarnings,
      lineup: [],
    };
  });

  return { newTeams, newStats, resultsData };
};

const MergePlayersPanel = ({
  allPlayers, teams, transactions,
  dialog, updateTeams, setTransactions,
  theme, colors, fonts, S, sfglDataApi, playersApi, STORAGE_KEYS, disabledBtn,
}) => {
  const [search1, setSearch1] = React.useState('');
  const [search2, setSearch2] = React.useState('');
  const [player1, setPlayer1] = React.useState(null);
  const [player2, setPlayer2] = React.useState(null);
  const [status,  setStatus]  = React.useState('');
  const [error,   setError]   = React.useState('');

  const allNames = React.useMemo(() =>
    [...new Set([...allPlayers.map(p => p.name), ...teams.flatMap(t => (t.roster||[]).map(p => p.name))])].sort(),
    [allPlayers, teams]
  );
  const f1 = search1.length >= 2 ? allNames.filter(n => n.toLowerCase().includes(search1.toLowerCase())).slice(0, 8) : [];
  const f2 = search2.length >= 2 ? allNames.filter(n => n.toLowerCase().includes(search2.toLowerCase())).slice(0, 8) : [];
  const iStyle = (sel) => ({ ...theme.input, width: '100%', fontSize: 13, border: sel ? `1px solid ${colors.textGold}` : undefined });
  const dStyle = { position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50, background: '#0f1d35', border: `1px solid ${colors.border}`, borderRadius: 3, boxShadow: '0 8px 24px rgba(0,0,0,0.5)', overflow: 'hidden' };
  const oStyle = { display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', background: 'none', border: 'none', fontFamily: fonts.sans, fontSize: 12, color: colors.textPrimary, cursor: 'pointer', borderBottom: `1px solid ${colors.borderSubtle}` };

  const doMerge = async () => {
    if (!player1 || !player2 || player1 === player2) { setError('Select two different players'); return; }
    if (!await dialog.showConfirm('Merge Players', `Rename "${player1}" → "${player2}" everywhere?`, { type: 'danger', confirmText: 'Merge' })) return;
    setStatus('merging'); setError('');
    try {
      const uTeams = teams.map(t => ({ ...t, roster: (t.roster||[]).map(p => p.name===player1?{...p,name:player2}:p), lineup: (t.lineup||[]).map(n=>n===player1?player2:n) }));
      const uTx = transactions.map(tx => ({ ...tx, ...(tx.player===player1&&{player:player2}), ...(tx.droppedPlayer===player1&&{droppedPlayer:player2}) }));
      await Promise.all([...uTeams.map(t=>teamsApi.update(t.id,t)), sfglDataApi.set(STORAGE_KEYS.TRANSACTIONS,uTx), playersApi.addAlias(player2,player1).catch(()=>{}), playersApi.delete(player1).catch(()=>{})]);
      updateTeams(uTeams); setTransactions(uTx); setStatus('done');
      dialog.showToast(`Merged "${player1}" → "${player2}"`, 'success');
      setPlayer1(null); setPlayer2(null); setSearch1(''); setSearch2('');
    } catch (err) { setStatus('error'); setError(err.message||'Merge failed'); }
  };

  return (
    <>
      <div style={{ ...theme.smallText, color: colors.textSecondary, marginBottom: 12 }}>Fix name mismatches — renames a player everywhere in rosters, transactions and Firebase.</div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <label style={S.lbl}>Rename this player...</label>
          <div style={{ position: 'relative' }}>
            <input value={player1||search1} onChange={e=>{setSearch1(e.target.value);setPlayer1(null);}} placeholder="Search..." style={iStyle(player1)} />
            {!player1&&f1.length>0&&<div style={dStyle}>{f1.map(n=><button key={n} onClick={()=>{setPlayer1(n);setSearch1(n);}} style={oStyle} onMouseEnter={e=>e.currentTarget.style.background='rgba(255,255,255,0.07)'} onMouseLeave={e=>e.currentTarget.style.background='none'}>{n}</button>)}</div>}
          </div>
          {player1&&<button onClick={()=>{setPlayer1(null);setSearch1('');}} style={{...theme.btnSecondary,marginTop:4,padding:'2px 8px',fontSize:10}}>✕ Clear</button>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', paddingTop: 20, color: colors.textMuted, fontSize: 16 }}>→</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <label style={S.lbl}>...to this name</label>
          <div style={{ position: 'relative' }}>
            <input value={player2||search2} onChange={e=>{setSearch2(e.target.value);setPlayer2(null);}} placeholder="Search..." style={iStyle(player2)} />
            {!player2&&f2.length>0&&<div style={dStyle}>{f2.map(n=><button key={n} onClick={()=>{setPlayer2(n);setSearch2(n);}} style={oStyle} onMouseEnter={e=>e.currentTarget.style.background='rgba(255,255,255,0.07)'} onMouseLeave={e=>e.currentTarget.style.background='none'}>{n}</button>)}</div>}
          </div>
          {player2&&<button onClick={()=>{setPlayer2(null);setSearch2('');}} style={{...theme.btnSecondary,marginTop:4,padding:'2px 8px',fontSize:10}}>✕ Clear</button>}
        </div>
      </div>
      {error&&<div style={{...theme.smallText,color:colors.danger,marginBottom:8}}>{error}</div>}
      <button onClick={doMerge} disabled={!player1||!player2||status==='merging'}
        style={{...S.btn,background:'rgba(180,100,100,0.15)',border:'1px solid rgba(200,80,80,0.4)',color:'rgba(220,120,120,0.95)',...disabledBtn(!player1||!player2||status==='merging')}}>
        {status==='merging'?'⏳ Merging…':'🔀 Merge Players'}
      </button>
    </>
  );
};

// ── TeamLineupsEditor ──────────────────────────────────────────────────────
// Inline editor for the selected tournament's team lineups. Used during both
// manual processing (first time the tournament is scored) and reprocessing
// (correcting an already-completed tournament). Edits flow directly into
// `manualEntry.teamLineups` which both handlers already consume.
//
// Roster pool per team = union of current roster + names already in the
// saved lineup. This preserves edit access to players who were rostered
// during the tournament but have since been dropped — without this, editing
// an old lineup would silently lose any player no longer on the active
// roster.
//
// Lives at module level (not inside the AdminView render) so internal state
// — and the dropdown elements — don't remount and lose focus between
// keystrokes when the parent re-renders.
const TeamLineupsEditor = ({ teams, manualEntry, setManualEntry, lineupSize, rostersByTeamId, S }) => {
  const [expanded, setExpanded] = useState(false);

  const updateTeamLineup = (teamId, slotIndex, playerName) => {
    setManualEntry(prev => {
      const current = prev.teamLineups?.[teamId] || [];
      // Pad to lineupSize so partial lineups don't collapse when editing slot N
      const next = [...current];
      while (next.length < lineupSize) next.push('');
      next[slotIndex] = playerName;
      // Filter out empties for storage, keeping the array compact for downstream code
      const compact = next.filter(n => n);
      return { ...prev, teamLineups: { ...(prev.teamLineups || {}), [teamId]: compact } };
    });
  };

  // Summary stats for the collapsed header — at a glance, the commish should
  // see how many teams are missing or partial lineups before expanding.
  const summary = teams.reduce((acc, t) => {
    const lu = manualEntry.teamLineups?.[t.id] || [];
    if (lu.length === 0) acc.missing++;
    else if (lu.length < lineupSize) acc.partial++;
    else acc.complete++;
    return acc;
  }, { missing: 0, partial: 0, complete: 0 });

  return (
    <div style={{ marginBottom: 14, border: `1px solid ${colors.borderSubtle}`, borderRadius: 4, overflow: 'hidden' }}>
      {/* Header — tap to toggle expanded */}
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        style={{
          width: '100%', padding: '10px 14px',
          background: 'rgba(255,255,255,0.03)',
          border: 'none', borderBottom: expanded ? `1px solid ${colors.borderSubtle}` : 'none',
          cursor: 'pointer', textAlign: 'left',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
          fontFamily: fonts.sans,
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '1.5px', textTransform: 'uppercase', color: colors.textPrimary }}>
          👥 Team Lineups
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 10, color: summary.missing > 0 ? colors.warning : colors.textMuted, letterSpacing: 0.5 }}>
            {summary.complete}/{teams.length} set
            {summary.missing > 0 && <span style={{ marginLeft: 6, color: colors.warning }}>· {summary.missing} missing</span>}
            {summary.partial > 0 && <span style={{ marginLeft: 6, color: colors.textGoldDim }}>· {summary.partial} partial</span>}
          </span>
          <span style={{ fontSize: 12, color: colors.textMuted, transition: 'transform 0.15s', display: 'inline-block', transform: expanded ? 'rotate(90deg)' : 'none' }}>▸</span>
        </span>
      </button>

      {/* Expanded panel — one row per team. Each row's render is wrapped in
          try/catch so a single bad team can't take down the whole editor —
          the broken team shows an inline error and the others render normally. */}
      {expanded && (
        <div style={{ padding: '8px 12px 12px', background: 'rgba(0,0,0,0.12)' }}>
          {teams.map(team => {
            try {
            const lineup = manualEntry.teamLineups?.[team.id] || [];
            // Effective roster — transactions-aware roster snapshot. Falls
            // back to team.roster if the caller didn't supply a precomputed
            // map (defensive).
            const effectiveRoster = (rostersByTeamId?.[team.id] || team.roster || [])
              .filter(p => p && typeof p.name === 'string' && p.name.length > 0);
            const rosterNames = effectiveRoster.map(p => p.name);
            // Roster pool: effective roster + any lineup names that aren't in
            // it, so editing a saved lineup doesn't drop legacy players (e.g.
            // someone rostered for the tournament but dropped after). Filter
            // out anything that isn't a non-empty string so the sort below
            // can't crash on undefined.
            const extras = (lineup || []).filter(n => typeof n === 'string' && n.length > 0 && !rosterNames.includes(n));
            const pool = [...rosterNames, ...extras]
              .filter(n => typeof n === 'string' && n.length > 0)
              // Defensive localeCompare — String() coerces any oddball value
              // that slipped past the filter so the sort can't blow up the
              // entire editor mid-render.
              .sort((a, b) => String(a).localeCompare(String(b)));

            // Track currently-picked names so the same player can't be picked twice
            const picked = new Set((lineup || []).filter(n => typeof n === 'string' && n.length > 0));

            const isComplete = lineup.length === lineupSize;
            const isEmpty = lineup.length === 0;

            return (
              <div key={team.id}
                style={{
                  padding: '8px 10px', marginBottom: 6,
                  background: isEmpty ? 'rgba(200,80,80,0.06)' : isComplete ? 'rgba(80,180,120,0.04)' : 'rgba(220,180,80,0.05)',
                  border: `1px solid ${isEmpty ? 'rgba(200,80,80,0.25)' : isComplete ? 'rgba(80,180,120,0.18)' : 'rgba(220,180,80,0.2)'}`,
                  borderRadius: 3,
                }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
                  <span style={{ fontFamily: fonts.sans, fontSize: 12, fontWeight: 600, color: colors.textPrimary }}>
                    {team.name}
                  </span>
                  {/* Right cluster: status counter + clear button (when applicable),
                      kept together on a single row so the team card doesn't
                      grow a second row of chrome once a player is picked. */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{
                      fontFamily: fonts.sans, fontSize: 9, letterSpacing: 1, textTransform: 'uppercase',
                      color: isEmpty ? colors.warning : isComplete ? colors.earningsGreen : colors.textGoldDim,
                    }}>
                      {isEmpty ? 'No lineup' : `${lineup.length}/${lineupSize}`}
                    </span>
                    {!isEmpty && (
                      <button
                        type="button"
                        onClick={() => setManualEntry(prev => ({
                          ...prev,
                          teamLineups: { ...(prev.teamLineups || {}), [team.id]: [] },
                        }))}
                        style={{
                          padding: '3px 8px',
                          background: 'transparent', border: `1px solid ${colors.borderSubtle}`,
                          borderRadius: 2, color: colors.textMuted,
                          fontFamily: fonts.sans, fontSize: 9, letterSpacing: 0.5,
                          textTransform: 'uppercase', cursor: 'pointer',
                        }}
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>

                {/* Lineup slot dropdowns — one per lineupSize slot.
                    Slot value pulls from lineup[i]; '' if not set. */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 6 }}>
                  {Array.from({ length: lineupSize }).map((_, slot) => {
                    const currentValue = lineup[slot] || '';
                    return (
                      <select
                        key={slot}
                        value={currentValue}
                        onChange={e => updateTeamLineup(team.id, slot, e.target.value)}
                        style={{ ...S.select, marginBottom: 0, padding: '6px 8px', fontSize: 12 }}
                      >
                        <option value="">— Slot {slot + 1} —</option>
                        {pool.map(name => {
                          // limited flag may live on the effective roster
                          // entry or on team.roster (waiver-added players
                          // don't carry the flag through transactions, so
                          // fall back to team.roster as a secondary lookup)
                          const player = effectiveRoster.find(p => p.name === name)
                            || (team.roster || []).find(p => p.name === name);
                          const limited = player?.limited;
                          const offRoster = !rosterNames.includes(name);
                          // Disable if picked elsewhere in this team's lineup (but not this slot)
                          const pickedElsewhere = picked.has(name) && name !== currentValue;
                          return (
                            <option key={name} value={name} disabled={pickedElsewhere}>
                              {limited ? '★ ' : ''}{name}{offRoster ? ' (dropped)' : ''}{pickedElsewhere ? ' — used' : ''}
                            </option>
                          );
                        })}
                      </select>
                    );
                  })}
                </div>
              </div>
            );
            } catch (rowErr) {
              // One team's row crashed — log, render a placeholder, and let
              // the other rows continue. Without this catch a single bad
              // team object would blank the entire editor.
              console.error('[TeamLineupsEditor] row crashed for', team?.name, rowErr);
              return (
                <div key={team?.id || Math.random()} style={{
                  padding: '10px 14px', marginBottom: 6,
                  background: 'rgba(200,80,80,0.08)',
                  border: '1px solid rgba(200,80,80,0.35)',
                  borderRadius: 3,
                  fontFamily: fonts.sans, fontSize: 11, color: 'rgba(220,140,140,0.9)',
                }}>
                  ⚠ Couldn't render {team?.name || 'this team'} — see console for details
                </div>
              );
            }
          })}
        </div>
      )}
    </div>
  );
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
  STORAGE_KEYS,
}) => {
  const [selectedTourney, setSelectedTourney] = useState('');
  const [manualEntry, setManualEntry] = useState({ round1Leaders: [''], round2Leaders: [''], round3Leaders: [''], playerEarnings: '', teamLineups: {} });
  const [mgCredTeam, setMgCredTeam] = useState('');


  const [mgCredName, setMgCredName] = useState('');
  const [mgCredPass, setMgCredPass] = useState('');
  const [mgCredSaving, setMgCredSaving] = useState(false);
  const [showDraftModal, setShowDraftModal] = useState(false);
  const [swingAwardSeg, setSwingAwardSeg]   = useState('');
  const [waiverRevealed, setWaiverRevealed] = useState(false);
  const [livSearch, setLivSearch] = useState('');
  const [livSaving, setLivSaving] = useState({});
  const [pgaFetching, setPgaFetching] = useState(false);
  const dialog = useDialog();

  // ── Effective roster snapshot ──
  // The lineup editor needs the same roster RostersView shows — current
  // team.roster augmented by any processed transactions that haven't synced
  // back into team.roster yet. Without this, players added via waivers
  // mid-week are invisible in the lineup dropdowns even though RostersView
  // displays them. See getEffectiveRoster's comment for details.
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

  React.useEffect(() => {
    const active = tournaments.find(t => t.playing);
    if (active && !selectedTourney) setSelectedTourney(active.name);
  }, [tournaments, selectedTourney]);

  const S = {
    section: { background: colors.cardBg, border: `1px solid ${colors.border}`, borderRadius: 4, padding: '16px 18px', marginBottom: 12 },
    title: { fontFamily: fonts.sans, fontSize: 11, fontWeight: 700, letterSpacing: '1.8px', textTransform: 'uppercase', color: colors.sectionHeaderBlue, marginBottom: 12 },
    btn: { ...theme.btnPrimary, width: '100%', padding: '10px 16px', textAlign: 'center', display: 'block', cursor: 'pointer' },
    btnSec: { ...theme.btnSecondary, width: '100%', padding: '10px 16px', textAlign: 'center', display: 'block', cursor: 'pointer' },
    btnDgr: { ...theme.btnDanger, width: '100%', padding: '10px 16px', textAlign: 'center', display: 'block', cursor: 'pointer' },
    input: { ...theme.input, marginBottom: 8 },
    select: { ...theme.select, marginBottom: 8, color: colors.textPrimary, backgroundColor: '#0d1b2e', appearance: 'none', WebkitAppearance: 'none' },
    lbl: { ...theme.label, display: 'block', marginBottom: 6 },
  };
  const disabledBtn = (disabled) => disabled ? { opacity: 0.4, cursor: 'not-allowed', pointerEvents: 'none' } : {};



  // ── Results: PGA Tour fetch ───────────────────────────────────────
  const handleFetchPGAResults = async () => {
    if (!selectedTourney) { dialog.showToast('Select a tournament first', 'error'); return; }
    const ti = tournaments.findIndex(t => t.name === selectedTourney);
    const t = tournaments[ti];

    const params = new URLSearchParams({ name: t.name, year: '2026' });

    setPgaFetching(true);
    try {
      dialog.showToast('Fetching results…', 'info');
      const resp = await fetch(`/api/pga-results?${params.toString()}`);
      const data = await resp.json();

      if (!resp.ok) {
        dialog.showToast(data.error || 'Fetch failed', 'error');
        return;
      }

      const { players, roundLeaders } = data;

      // Pre-fill earnings textarea and round leaders
      const earningsLines = players
        .sort((a, b) => b.earnings - a.earnings)
        .map(p => `${p.name}, ${p.earnings}`)
        .join('\n');

      // Only keep leaders who were actually in an SFGL starting lineup —
      // same rule as the manual dropdown. Filter against current team lineups.
      const startedPlayers = new Set(teams.flatMap(t => t.lineup || []));
      const filterToStarted = (names) => {
        if (!names?.length) return [''];
        const filtered = names.filter(n => startedPlayers.has(n));
        return filtered.length ? filtered : [''];
      };

      const rl = roundLeaders || {};
      setManualEntry(prev => ({
        ...prev,
        playerEarnings: earningsLines,
        round1Leaders: filterToStarted(rl.round1),
        round2Leaders: filterToStarted(rl.round2),
        round3Leaders: filterToStarted(rl.round3),
      }));

      dialog.showToast(`✓ ${players.length} players loaded`, 'success');
    } catch (err) {
      dialog.showToast('Error: ' + err.message, 'error');
    } finally {
      setPgaFetching(false);
    }
  };

  // ── Results: manual entry ────────────────────────────────────────────────
  const handleManualEntry = async () => {
    try {
      if (!selectedTourney) { dialog.showToast('Select a tournament first', 'error'); return; }
      const tournament = tournaments.find(t => t.name === selectedTourney);
      if (!tournament) { dialog.showToast('Tournament not found', 'error'); return; }
      if (tournament.completed) {
        const ok = await dialog.showConfirm('Already Processed', 'Re-entering will ADD earnings again (doubling them). Continue?', { type: 'danger', confirmText: 'Re-enter Results' });
        if (!ok) return;
      }
      // Parse earnings lines: "Player Name, 123456" or "Player Name, 1,234,567"
      const earningsMap = new Map();
      manualEntry.playerEarnings.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (!trimmed) return;
        const m = trimmed.match(/^(.+?),\s*([\d,]+)$/);
        if (m) {
          const amt = parseInt(m[2].replace(/,/g, ''));
          if (!isNaN(amt) && amt >= 0) earningsMap.set(m[1].trim(), amt);
        }
      });
      if (!earningsMap.size) {
        dialog.showToast('No valid earnings lines found. Format: "Player Name, 123456"', 'error');
        return;
      }
      const ti = tournaments.findIndex(t => t.name === selectedTourney);
      const manualData = {
        name: selectedTourney, status: 'post', competitors: [],
        roundLeaders: {
          round1: manualEntry.round1Leaders.filter(l => l.trim()),
          round2: manualEntry.round2Leaders.filter(l => l.trim()),
          round3: manualEntry.round3Leaders.filter(l => l.trim()),
        },
        earningsMap, isManualEntry: true,
      };
      const names = teams.flatMap(t => t.roster.map(p => p.name));
      const { newTeams, newStats, resultsData } = processTournamentData(tournament, manualData, teams, globalPlayerStats, names, transactions);
      // Mark tournament completed, advance playing to next non-alternate
      const newT = tournaments.map((nt, i) => i === ti ? { ...nt, completed: true, playing: false, results: resultsData } : nt);
      const nx = newT.findIndex((nt, i) => i > ti && !nt.completed && !nt.isAlternate);
      if (nx !== -1) { newT.forEach(nt => { nt.playing = false; }); newT[nx].playing = true; }
      updateTeams(newTeams); setGlobalPlayerStats(newStats); setTournaments(newT);
      // Persistence (localStorage + dedicated Firestore collections) handled by the
      // updaters above. The sfglDataApi writes below are belt-and-suspenders backups
      // to the key-value fallback path that useLeague's cascade loader checks.
      sfglDataApi.set(STORAGE_KEYS.TOURNAMENTS, newT).catch(() => {});
      sfglDataApi.set(STORAGE_KEYS.GLOBAL_PLAYER_STATS, newStats).catch(() => {});
      dialog.showToast('Results processed! ' + earningsMap.size + ' players · ' + Object.keys(resultsData.teams).length + ' teams scored', 'success');
      // Send results email to all managers
      try {
        const teamResultsForEmail = newTeams.filter(t => resultsData.teams[t.id]).map(t => ({
          team: t.name,
          totalEarnings: resultsData.teams[t.id].totalEarnings || 0,
        }));
        await fetch('/api/cron?action=notify-results', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tournamentName: selectedTourney, teamResults: teamResultsForEmail }),
        });
        dialog.showToast('📧 Results emails sent', 'success');
      } catch (emailErr) {
        console.warn('Results email failed:', emailErr);
      }
      setManualEntry({ round1Leaders: [''], round2Leaders: [''], round3Leaders: [''], playerEarnings: '', teamLineups: {} });
    } catch (err) {
      console.error('handleManualEntry error:', err);
      dialog.showToast('Error processing results: ' + err.message, 'error');
    }
  };

  // ── Results: reprocess completed tournament ─────────────────────────────
  const handleReprocess = async () => {
    if (!selectedTourney) { dialog.showToast('Select a tournament first', 'error'); return; }
    const tournament = tournaments.find(t => t.name === selectedTourney);
    if (!tournament?.completed) { dialog.showToast('Tournament is not yet completed', 'error'); return; }
    const ti = tournaments.findIndex(t => t.name === selectedTourney);

    // Will reprocessing this tournament cascade into a swing-winner change?
    // It does whenever a swing_winner tx already exists for this tournament's
    // segment — meaning the swing was awarded, and recalculated earnings
    // could shift the winner. The user is told before they confirm.
    const tSegment = getTournamentSegment(tournament);
    const existingSwingTx = transactions.find(tx => tx.type === 'swing_winner' && tx.segment === tSegment);
    const swingCascade = !!existingSwingTx;

    const confirmMsg = swingCascade
      ? 'This will reverse the existing results for ' + selectedTourney + ' and apply the corrected earnings below. Team scores, player stats, and standings will all update.\n\nThe ' + tSegment + ' swing winner ($' + (existingSwingTx.amount || 0).toLocaleString() + ' to ' + existingSwingTx.team + ') will be automatically recalculated and re-awarded based on the new totals.'
      : 'This will reverse the existing results for ' + selectedTourney + ' and apply the corrected earnings below. Team scores, player stats, and standings will all update.';

    const ok = await dialog.showConfirm(
      'Reprocess Tournament',
      confirmMsg,
      { confirmText: 'Reprocess' }
    );
    if (!ok) return;

    try {
      // Parse corrected earnings
      const earningsMap = new Map();
      manualEntry.playerEarnings.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (!trimmed) return;
        const m = trimmed.match(/^(.+?),\s*([\d,]+)$/);
        if (m) {
          const amt = parseInt(m[2].replace(/,/g, ''));
          if (!isNaN(amt) && amt >= 0) earningsMap.set(m[1].trim(), amt);
        }
      });
      if (!earningsMap.size) { dialog.showToast('No valid earnings lines found', 'error'); return; }

      // Step 1: Reverse old results from all teams
      const oldResults = tournament.results;
      let reversedTeams = teams.map(team => {
        const oldTeamResult = oldResults?.teams?.[team.id];
        if (!oldTeamResult) return team;
        // Reverse team earnings
        const earningsDelta = -(oldTeamResult.totalEarnings || 0);
        // Reverse per-player sfglEarnings and starts
        // Use fullLineups for start reversal (all starters), players list for earnings
        const oldLineup = new Set(oldResults.fullLineups?.[team.id] || (oldTeamResult.players || []).map(p => p.name || p));
        const oldEarningsByPlayer = {};
        (oldTeamResult.players || []).forEach(p => { oldEarningsByPlayer[p.name || p] = p.earnings || 0; });
        const newRoster = team.roster.map(p => {
          const wasInLineup = oldLineup.has(p.name);
          if (!wasInLineup) return p;
          return {
            ...p,
            sfglEarnings: Math.max(0, (p.sfglEarnings || 0) - (oldEarningsByPlayer[p.name] || 0)),
            starts: Math.max(0, (p.starts || 0) - 1),
          };
        });
        return {
          ...team,
          roster: newRoster,
          earnings: Math.max(0, (team.earnings || 0) + earningsDelta),
          segmentEarnings: Math.max(0, (team.segmentEarnings || 0) + earningsDelta),
          lineup: (manualEntry.teamLineups[team.id] || oldResults.fullLineups?.[team.id] || []),
        };
      });

      // Reverse global stats from old earningsMap
      const oldEarningsMap = oldResults?.earningsMap || {};
      const reversedStats = { ...globalPlayerStats };
      Object.entries(oldEarningsMap).forEach(([playerName, earnings]) => {
        if (!reversedStats[playerName]) return;
        reversedStats[playerName] = {
          ...reversedStats[playerName],
          eventsPlayed: Math.max(0, (reversedStats[playerName].eventsPlayed || 0) - 1),
          cutsMade: Math.max(0, (reversedStats[playerName].cutsMade || 0) - (earnings > 0 ? 1 : 0)),
          pgaTourEarnings: Math.max(0, (reversedStats[playerName].pgaTourEarnings || 0) - earnings),
        };
      });

      // Step 2: Apply corrected results
      const manualData = {
        name: selectedTourney, status: 'post', competitors: [],
        roundLeaders: {
          round1: manualEntry.round1Leaders.filter(l => l.trim()),
          round2: manualEntry.round2Leaders.filter(l => l.trim()),
          round3: manualEntry.round3Leaders.filter(l => l.trim()),
        },
        earningsMap, isManualEntry: true,
      };
      const names = teams.flatMap(t => t.roster.map(p => p.name));
      const { newTeams, newStats, resultsData } = processTournamentData(tournament, manualData, reversedTeams, reversedStats, names, transactions);

      // Mark tournament with new results (keep completed, don't change playing)
      const newT = tournaments.map((nt, i) => i === ti ? { ...nt, results: resultsData } : nt);

      // ── Swing winner cascade ──
      // When the segment already had its swing_winner awarded, the recalculated
      // tournament earnings may shift the winner. Same workflow the commish
      // would otherwise do manually: reverse old credit, recompute, re-award.
      // All wrapped into this single Reprocess action so it's never out of sync.
      //
      // The cascade is its own try/catch — if anything in here fails we log a
      // warning, skip the swing recalc, and let the base reprocess still
      // persist. Better to have correct tournament results + a stale swing
      // award than a half-applied write that corrupts state.
      let finalTeams = newTeams;
      let finalTransactions = transactions;
      let swingRecalcSummary = null;

      if (swingCascade) {
        try {
          // 1. Reverse old swing pot credit from whoever was awarded
          const oldWinnerTeam = finalTeams.find(t => t.name === existingSwingTx.team);
          if (oldWinnerTeam) {
            finalTeams = finalTeams.map(t =>
              t.id === oldWinnerTeam.id
                ? { ...t, earnings: Math.max(0, (t.earnings || 0) - (existingSwingTx.amount || 0)) }
                : t
            );
          }

          // 2. Recompute swing standings against the NEW tournament results (newT)
          const segmentTournaments = newT.filter(tt => tt.completed && getTournamentSegment(tt) === tSegment && tt.results?.teams);
          const byTeam = {};
          segmentTournaments.forEach(tt => {
            Object.entries(tt.results.teams).forEach(([id, tr]) => {
              byTeam[id] = (byTeam[id] || 0) + (tr.totalEarnings || 0);
            });
          });
          const winnerEntry = Object.entries(byTeam).sort((a, b) => b[1] - a[1])[0];

          if (winnerEntry) {
            const [winnerId] = winnerEntry;
            const newWinnerTeam = finalTeams.find(t => t.id === winnerId);

            // 3. Recompute pot from fee transactions across the segment.
            const segmentIndexes = new Set(segmentTournaments.map(tt => newT.indexOf(tt)));
            const newPot = transactions
              .filter(tx => {
                if ((tx.fee || 0) <= 0) return false;
                if (tx.status === 'failed') return false;
                if (tx.type === 'swing_winner') return false;
                return tx.tournamentIndex !== undefined
                  ? segmentIndexes.has(tx.tournamentIndex)
                  : tx.segment === tSegment;
              })
              .reduce((sum, tx) => sum + tx.fee, 0);

            // 4. Drop the old swing_winner tx, append the new one.
            // Includes txId + timestamp to match the shape that
            // TransactionsView and the Firebase sync code expect.
            const lastSegTourney = segmentTournaments.reduce((last, tt) => {
              const idx = newT.indexOf(tt);
              return idx > (last?.idx ?? -1) ? { t: tt, idx } : last;
            }, null);

            const newSwingTx = {
              txId: `swing-${tSegment}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              team: newWinnerTeam?.name || existingSwingTx.team,
              type: 'swing_winner',
              player: newWinnerTeam?.owner || existingSwingTx.player,
              fee: 0,
              amount: newPot,
              segment: tSegment,
              date: new Date().toLocaleDateString(),
              timestamp: Date.now(),
              status: 'completed',
              tournamentIndex: lastSegTourney?.idx ?? existingSwingTx.tournamentIndex,
              note: tSegment + ' winner pot (auto-recalculated)',
            };
            finalTransactions = transactions
              .filter(tx => !(tx.type === 'swing_winner' && tx.segment === tSegment))
              .concat(newSwingTx);

            // 5. Credit the new winner with the (re)computed pot
            if (newWinnerTeam) {
              finalTeams = finalTeams.map(t =>
                t.id === winnerId
                  ? { ...t, earnings: (t.earnings || 0) + newPot }
                  : t
              );
            }

            // For the toast — surface whether the winner actually changed
            const sameWinner = newWinnerTeam?.name === existingSwingTx.team;
            swingRecalcSummary = sameWinner
              ? `${tSegment}: ${newWinnerTeam.name} retains $${newPot.toLocaleString()}`
              : `${tSegment}: ${existingSwingTx.team} → ${newWinnerTeam?.name} ($${newPot.toLocaleString()})`;
          }
        } catch (cascadeErr) {
          // Cascade failed — log, but keep going so the base reprocess
          // still applies. Reverts finalTeams/finalTransactions to the
          // pre-cascade state so we don't persist half-applied changes.
          console.error('[handleReprocess] Swing cascade failed:', cascadeErr);
          finalTeams = newTeams;
          finalTransactions = transactions;
          swingRecalcSummary = '(swing recalc skipped — see console)';
        }
      }

      // Persist — sequenced and individually try/caught so a single failure
      // in one writer doesn't leave us in a half-applied state where some
      // state is updated and the rest isn't. Each writer is fired and we
      // continue even if one fails, surfacing the error in the toast.
      const writerErrors = [];
      try { updateTeams(finalTeams); }       catch (e) { writerErrors.push('teams: ' + e.message); }
      try { setGlobalPlayerStats(newStats); } catch (e) { writerErrors.push('stats: ' + e.message); }
      try { setTournaments(newT); }          catch (e) { writerErrors.push('tournaments: ' + e.message); }
      if (finalTransactions !== transactions) {
        try {
          setTransactions(finalTransactions);
          sfglDataApi.set(STORAGE_KEYS.TRANSACTIONS, finalTransactions).catch(e => console.warn('tx backup failed:', e));
        } catch (e) { writerErrors.push('transactions: ' + e.message); }
      }
      sfglDataApi.set(STORAGE_KEYS.TOURNAMENTS, newT).catch(e => console.warn('tournaments backup failed:', e));
      sfglDataApi.set(STORAGE_KEYS.GLOBAL_PLAYER_STATS, newStats).catch(e => console.warn('stats backup failed:', e));

      if (writerErrors.length > 0) {
        console.error('[handleReprocess] Persistence errors:', writerErrors);
        dialog.showToast('Reprocessed with warnings — see console for details', 'warning');
      } else {
        dialog.showToast(
          swingRecalcSummary
            ? '✓ Reprocessed ' + selectedTourney + ' · ' + swingRecalcSummary
            : '✓ Reprocessed ' + selectedTourney + ' with corrected earnings',
          'success'
        );
      }
      setManualEntry({ round1Leaders: [''], round2Leaders: [''], round3Leaders: [''], playerEarnings: '', teamLineups: {} });
    } catch (err) {
      console.error('handleReprocess error:', err);
      dialog.showToast('Error reprocessing: ' + err.message, 'error');
    }
  };

  // ── Resend results email for an already-completed tournament ─────────────
  // Used when (a) the auto-cron email failed to render properly, or (b) the
  // commish wants to test changes to the email template without waiting for
  // next Monday. Doesn't touch any data — only re-fires the email via the
  // notify-results endpoint, which has no same-day lockout.
  const handleResendResultsEmail = async () => {
    if (!selectedTourney) { dialog.showToast('Select a tournament first', 'error'); return; }
    const t = tournaments.find(tt => tt.name === selectedTourney);
    if (!t?.completed || !t?.results?.teams) {
      dialog.showToast('Tournament must be completed and have results', 'error');
      return;
    }
    const ok = await dialog.showConfirm(
      'Resend Results Email',
      `Send the ${selectedTourney} results email to all managers? This does not modify any data — only re-sends the email.`,
      { confirmText: 'Send Email', type: 'warning' }
    );
    if (!ok) return;
    try {
      const teamResultsForEmail = teams
        .filter(team => t.results.teams[team.id])
        .map(team => ({
          team: team.name,
          totalEarnings: t.results.teams[team.id].totalEarnings || 0,
          // Include player breakdown so the new email template can render it
          players: (t.results.teams[team.id].players || []).map(p => ({
            name: p.name, earnings: p.earnings || 0, limited: !!p.limited,
          })),
        }));
      const resp = await fetch('/api/cron?action=notify-results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tournamentName: selectedTourney, teamResults: teamResultsForEmail }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || 'Resend failed');
      dialog.showToast(`📧 Sent to ${data.emailsSent || 0} manager${data.emailsSent === 1 ? '' : 's'}`, 'success');
    } catch (err) {
      console.error('handleResendResultsEmail error:', err);
      dialog.showToast('Error: ' + err.message, 'error');
    }
  };

    const RoundLeaderSelect = ({ label, leaders, onChange, round }) => {
    // Use the stored tournament lineups (manualEntry.teamLineups) instead of current live lineups.
    // This ensures we show players who were actually in the lineup for that tournament.
    const teamLineups = manualEntry.teamLineups || {};

    // Build mulligan map for the selected tournament
    const selectedTIdx = tournaments.findIndex(t => t.name === selectedTourney);
    const tourneyMulligans = transactions.filter(tx =>
      tx.type === 'mulligan' && tx.tournamentIndex === selectedTIdx && tx.status === 'processed'
    );

    const players = teams.flatMap(team => {
      const lineup = teamLineups[team.id] || team.lineup || [];
      let names = [...lineup];

      // For R3+, include mulliganed-in players (they replace someone mid-tournament)
      if (round >= 3) {
        tourneyMulligans
          .filter(tx => tx.team === team.name && tx.player)
          .forEach(tx => {
            if (!names.includes(tx.player)) names.push(tx.player);
          });
      }

      return names.map(name => ({ name, team: team.name }));
    }).sort((a, b) => a.name.localeCompare(b.name));

    return (
      <div style={{ flex: 1 }}>
        <div style={S.lbl}>{label}</div>
        {leaders.map((leader, idx) => (
          <div key={idx} style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
            <select value={leader} onChange={e => { const n = [...leaders]; n[idx] = e.target.value; onChange(n); }}
              style={{ ...theme.select, flex: 1, marginBottom: 0, fontSize: 12, padding: '7px 8px' }}>
              <option value="">(none)</option>
              {players.map(p => <option key={p.name + p.team} value={p.name}>{p.name} — {p.team}</option>)}
            </select>
            {idx > 0 && <button onClick={() => onChange(leaders.filter((_, i) => i !== idx))}
              style={{ background: 'none', border: `1px solid ${colors.dangerBorder}`, color: colors.danger, borderRadius: 2, padding: '4px 7px', cursor: 'pointer', fontSize: 11 }}>✕</button>}
          </div>
        ))}
        <button onClick={() => onChange([...leaders, ''])}
          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: colors.textGoldDim, padding: 0 }}>+ co-leader</button>
      </div>
    );
  };

  // ── Waivers ──────────────────────────────────────────────────────────────
  const buildRoster = (team) => {
    let r = team.roster.map(p => p.name);
    transactions.filter(tx => tx.team === team.name && tx.status === 'processed' && tx.type !== 'mulligan').forEach(tx => {
      if (tx.droppedPlayer) r = r.filter(n => n !== tx.droppedPlayer);
      if (!r.includes(tx.player)) r.push(tx.player);
    });
    return new Set(r);
  };
  const applyWaiver = (t, w) => {
    if (t.name !== w.team) return t;
    let r = [...t.roster];
    if (w.droppedPlayer) r = r.filter(p => p.name !== w.droppedPlayer);
    if (!r.some(p => p.name === w.player)) r.push({ name: w.player, limited: false, unlimited: false, stars: 0, starts: 0, eventsPlayed: 0, cutsMade: 0, pgaTourEarnings: 0, sfglEarnings: 0 });
    return { ...t, roster: r };
  };
  const handleProcessSingle = async (w) => {
    const allRostered = new Set(); teams.forEach(t => t.roster.forEach(p => allRostered.add(p.name)));
    if (allRostered.has(w.player)) {
      const tx2 = transactions.map((tx, i) => i === w._idx ? { ...tx, status: 'failed', failReason: 'Player already rostered', processedDate: new Date().toLocaleDateString() } : tx);
      setTransactions(tx2); sfglDataApi.set(STORAGE_KEYS.TRANSACTIONS, tx2).catch(() => {});
      dialog.showToast(w.player + ' already rostered', 'error'); return;
    }
    if (w.droppedPlayer && !teams.find(t => t.name === w.team)?.roster.some(p => p.name === w.droppedPlayer)) {
      const tx2 = transactions.map((tx, i) => i === w._idx ? { ...tx, status: 'failed', failReason: w.droppedPlayer + ' already dropped', processedDate: new Date().toLocaleDateString() } : tx);
      setTransactions(tx2); sfglDataApi.set(STORAGE_KEYS.TRANSACTIONS, tx2).catch(() => {});
      dialog.showToast(w.droppedPlayer + ' already dropped', 'error'); return;
    }

    // Check for competing pending claims from other teams on the same player
    const competing = transactions
      .map((tx, i) => ({ ...tx, _idx: i }))
      .filter(tx => tx.status === 'pending' && tx.type === 'waiver' && tx.player === w.player && tx.team !== w.team);

    // Determine tiebreaker: lowest earnings wins
    const earningsMap = {}; teams.forEach(t => { earningsMap[t.name] = t.earnings || 0; });
    const allClaims = [w, ...competing].sort((a, b) => (earningsMap[a.team] || 0) - (earningsMap[b.team] || 0));
    const winner = allClaims[0];
    const losers = allClaims.slice(1);

    let tx2 = [...transactions];
    // Mark winner as processed
    tx2[winner._idx] = { ...tx2[winner._idx], status: 'processed', processedDate: new Date().toLocaleDateString() };
    // Mark losers as blocked
    losers.forEach(l => {
      const winEarn = '$' + (earningsMap[winner.team] || 0).toLocaleString();
      const loseEarn = '$' + (earningsMap[l.team] || 0).toLocaleString();
      tx2[l._idx] = { ...tx2[l._idx], status: 'failed', failReason: `Lost tiebreaker to ${winner.team} (${winEarn} vs ${loseEarn})`, processedDate: new Date().toLocaleDateString() };
    });

    // Only apply the winner's roster change
    const t2 = teams.map(t => applyWaiver(t, winner));
    setTransactions(tx2); updateTeams(t2);
    sfglDataApi.set(STORAGE_KEYS.TRANSACTIONS, tx2).catch(() => {});
    if (losers.length) {
      dialog.showToast(winner.team + ' wins claim · ' + losers.map(l => l.team).join(', ') + ' blocked', 'success');
    } else {
      dialog.showToast(winner.team + ' adds ' + winner.player + (winner.droppedPlayer ? ' / drops ' + winner.droppedPlayer : ''), 'success');
    }
  };
  const handleProcessAll = async (pending) => {
    if (!pending.length) return;
    if (!await dialog.showConfirm('Process All Waivers', 'Process ' + pending.length + ' pending claim' + (pending.length !== 1 ? 's' : '') + '?\n\nTie-breaker: reverse standings (lowest earnings = highest priority). Winners move to back of the line for subsequent claims.', { confirmText: 'Process All' })) return;
    const em = {}; teams.forEach(t => { em[t.name] = t.earnings || 0; });
    const pm = {}; [...teams].sort((a, b) => (a.earnings || 0) - (b.earnings || 0)).forEach((t, i) => { pm[t.name] = i; });
    let nextLastPlace = teams.length; // counter for pushing winners to back of priority
    const byTeam = {}; pending.forEach(w => { if (!byTeam[w.team]) byTeam[w.team] = []; byTeam[w.team].push(w); });
    Object.values(byTeam).forEach(c => c.sort((a, b) => (a.priority || 999) - (b.priority || 999)));
    const allR = new Set(); teams.forEach(t => buildRoster(t).forEach(n => allR.add(n)));
    const dropped = new Set(), done = new Set(), failed = new Set(), applied = [];
    const tx2 = [...transactions]; let p = 0, f = 0, more = true;
    while (more) {
      more = false;
      const round = []; Object.entries(byTeam).forEach(([tn, claims]) => { const top = claims.find(c => !done.has(c._idx) && !failed.has(c._idx)); if (top) round.push({ tn, claim: top, o: pm[tn] ?? 999 }); });
      if (!round.length) break;
      const byP = {}; round.forEach(rc => { if (!byP[rc.claim.player]) byP[rc.claim.player] = []; byP[rc.claim.player].push(rc); });
      Object.entries(byP).forEach(([player, cs]) => {
        cs.sort((a, b) => a.o - b.o); const w = cs[0];
        if (allR.has(player)) { cs.forEach(c => { failed.add(c.claim._idx); tx2[c.claim._idx] = { ...tx2[c.claim._idx], status: 'failed', failReason: 'Player already rostered', processedDate: new Date().toLocaleDateString() }; f++; }); more = true; return; }
        if (w.claim.droppedPlayer && (dropped.has(w.claim.droppedPlayer) || !allR.has(w.claim.droppedPlayer))) { failed.add(w.claim._idx); tx2[w.claim._idx] = { ...tx2[w.claim._idx], status: 'failed', failReason: w.claim.droppedPlayer + ' already dropped', processedDate: new Date().toLocaleDateString() }; f++; more = true; return; }
        if (w.claim.droppedPlayer) { allR.delete(w.claim.droppedPlayer); dropped.add(w.claim.droppedPlayer); }
        allR.add(player); done.add(w.claim._idx); tx2[w.claim._idx] = { ...tx2[w.claim._idx], status: 'processed', processedDate: new Date().toLocaleDateString() }; applied.push(w.claim); p++;
        pm[w.tn] = nextLastPlace++; // winner moves to back of priority line
        const winEarn = '$' + (em[w.tn] || 0).toLocaleString();
        cs.slice(1).forEach(l => {
          const loseEarn = '$' + (em[l.tn] || 0).toLocaleString();
          failed.add(l.claim._idx); tx2[l.claim._idx] = { ...tx2[l.claim._idx], status: 'failed', failReason: `Lost tiebreaker to ${w.tn} (${winEarn} vs ${loseEarn})`, processedDate: new Date().toLocaleDateString() }; f++;
        }); more = true;
      });
    }
    let t2 = [...teams]; applied.forEach(w => { t2 = t2.map(t => applyWaiver(t, w)); });
    setTransactions(tx2); updateTeams(t2);
    sfglDataApi.set(STORAGE_KEYS.TRANSACTIONS, tx2).catch(() => {}); sfglDataApi.set(STORAGE_KEYS.TEAMS, t2).catch(() => {});
    dialog.showToast('Processed ' + p + (f ? ' · ' + f + ' failed' : ''), p > 0 ? 'success' : 'error');
  };

  // ── Manager Login ────────────────────────────────────────────────────────
  const handleSetLogin = async () => {
    if (!mgCredTeam || !mgCredName || !mgCredPass) return;
    setMgCredSaving(true);
    try { await managerAuthApi.setCredentials(mgCredTeam, mgCredName, mgCredPass); dialog.showToast('Login set for ' + mgCredName, 'success'); setMgCredTeam(''); setMgCredName(''); setMgCredPass(''); }
    catch (e) { dialog.showToast('Failed: ' + e.message, 'error'); }
    setMgCredSaving(false);
  };

  // ── Award Swing Winner ──────────────────────────────────────────────────
  // SWINGS now imported from theme — single source of truth (was duplicated here)
  // Segment-from-tournament resolution uses the canonical helper from utils.
  // (Wave C.5 — was a local re-implementation here that disagreed with
  // utils on edge cases. Both supported t.dates fallback; the utils version
  // also tries t.startDate which is more robust.)
  const getTournamentSegment = getSegmentForTournament;

  const handleSwingWinner = async () => {
    if (!swingAwardSeg) return;

    // Sum all transaction fees for this swing using tournamentIndex range,
    // matching the same logic as TransactionsView's fee counter.
    const swingTournaments = tournaments.filter(t => t.completed && getTournamentSegment(t) === swingAwardSeg && t.results?.teams);
    if (!swingTournaments.length) {
      dialog.showToast('No completed results found for ' + swingAwardSeg, 'error');
      return;
    }
    const swingIndexes = new Set(swingTournaments.map(t => tournaments.indexOf(t)));
    const pot = transactions
      .filter(tx => {
        if ((tx.fee || 0) <= 0) return false;
        if (tx.status === 'failed') return false;
        if (tx.type === 'swing_winner') return false;
        // Match by tournamentIndex if available, fall back to segment string
        return tx.tournamentIndex !== undefined
          ? swingIndexes.has(tx.tournamentIndex)
          : tx.segment === swingAwardSeg;
      })
      .reduce((sum, tx) => sum + tx.fee, 0);

    if (pot === 0) {
      dialog.showToast('No fees collected for ' + swingAwardSeg, 'error');
      return;
    }

    const byTeam = {};
    swingTournaments.forEach(t => {
      Object.entries(t.results.teams).forEach(([id, tr]) => {
        byTeam[id] = (byTeam[id] || 0) + (tr.totalEarnings || 0);
      });
    });

    // Debug: log what we found so issues are visible in console
    console.log('[SwingWinner] Swing:', swingAwardSeg);
    console.log('[SwingWinner] Tournaments found:', swingTournaments.map(t => t.name + ' (segment=' + t.segment + ', dates=' + t.dates + ')'));
    console.log('[SwingWinner] Earnings by team:', Object.entries(byTeam).map(([id, e]) => { const t = teams.find(x => x.id === id); return (t?.name || id) + ': $' + e.toLocaleString(); }));

    const winnerEntry = Object.entries(byTeam).sort((a, b) => b[1] - a[1])[0];
    if (!winnerEntry) { dialog.showToast('Could not determine winner', 'error'); return; }
    const [winnerId, winnerEarnings] = winnerEntry;
    const winnerTeam = teams.find(t => t.id === winnerId);
    if (!winnerTeam) { dialog.showToast('Winner team not found', 'error'); return; }

    const msg = swingAwardSeg + ' complete. Winner: ' + winnerTeam.name + ' (' + winnerTeam.owner + '). Swing: $' + winnerEarnings.toLocaleString() + '. Pot: $' + pot.toLocaleString() + '. Award pot?';
    const ok = await dialog.showConfirm('Award Swing Winner', msg, { confirmText: 'Award $' + pot.toLocaleString() });
    if (!ok) return;

    const lastSwingTournament = swingTournaments.reduce((last, t) => {
      const idx = tournaments.indexOf(t);
      return idx > (last?.idx ?? -1) ? { t, idx } : last;
    }, null);

    const newTx = {
      team: winnerTeam.name, type: 'swing_winner', player: winnerTeam.owner,
      fee: 0, amount: pot, segment: swingAwardSeg,
      date: new Date().toLocaleDateString(), status: 'completed',
      tournamentIndex: lastSwingTournament?.idx ?? undefined,
      note: swingAwardSeg + ' winner pot',
    };

    const newTeams = teams.map(t =>
      t.id === winnerId
        ? { ...t, earnings: (t.earnings || 0) + pot }
        : t
    );

    updateTeams(newTeams);
    setTransactions(prev => [...prev, newTx]);
    // Persistence handled by setTransactions (= updateTransactions); sfglDataApi write below is backup.
    await sfglDataApi.set(STORAGE_KEYS.TRANSACTIONS, [...transactions, newTx]).catch(e => console.error('sfgl tx:', e));

    dialog.showToast('🏆 ' + winnerTeam.name + ' awarded $' + pot.toLocaleString() + ' for ' + swingAwardSeg, 'success');
    setSwingAwardSeg('');
  };

  // ── Combined OWGR + LIV sync ─────────────────────────────────────────────
  const [owgrStatus, setOwgrStatus] = useState(null);
  const [owgrSummary, setOwgrSummary] = useState('');
  const [owgrLastSynced, setOwgrLastSynced] = useState(null);

  // ── Merge Players ─────────────────────────────────────────────────────────
  const [mergeOpen, setMergeOpen] = useState(false);

  // ── Season Settings ────────────────────────────────────────────────────────
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsOpen,   setSettingsOpen]   = useState(false);
  const [settingsDraft,  setSettingsDraft]  = useState(null);

  const getSettingsDraft = () => ({
    bonusR1Regular:   settings?.bonusR1Regular   ?? 20000,
    bonusR2Regular:   settings?.bonusR2Regular   ?? 40000,
    bonusR3Regular:   settings?.bonusR3Regular   ?? 60000,
    bonusR1Major:     settings?.bonusR1Major     ?? 40000,
    bonusR2Major:     settings?.bonusR2Major     ?? 80000,
    bonusR3Major:     settings?.bonusR3Major     ?? 120000,
    feeFA:            settings?.feeFA            ?? 1,
    feeWaiver:        settings?.feeWaiver        ?? 2,
    rosterLimit:      settings?.rosterLimit      ?? 13,
    lineupSize:       settings?.lineupSize       ?? 5,
    maxLimitedStarts: settings?.maxLimitedStarts ?? 12,
  });

  const handleSaveSettings = async () => {
    if (!settingsDraft) return;
    setSettingsSaving(true);
    try {
      await setSettings({ ...settings, ...settingsDraft });
      setSettingsDraft(null);
      dialog.showToast('✓ Season settings saved', 'success');
    } catch (err) {
      dialog.showToast('Error: ' + err.message, 'error');
    } finally { setSettingsSaving(false); }
  };

  // ── Waiver Schedule ────────────────────────────────────────────────────────
  const [waiverDay,    setWaiverDay]    = useState(() => settings?.waiverDay    ?? 2); // 0=Sun…6=Sat, default Tue=2
  const [waiverHour,   setWaiverHour]   = useState(() => settings?.waiverHour   ?? 20); // 24h ET, default 20=8pm
  const [waiverMinute, setWaiverMinute] = useState(() => settings?.waiverMinute ?? 0);  // 0–59, default :00
  const [waiverSaving, setWaiverSaving] = useState(false);
  const [emailDraft,   setEmailDraft]   = useState(null); // { teamId: 'email@...' } — null = no unsaved changes

  // ── Results Email Schedule ────────────────────────────────────────────────
  // Mirrors the waiver pattern: governs when handleProcessResults in cron.js
  // will fire (it computes earnings, marks the tournament complete, advances
  // the schedule, and emails all managers their results). Defaults to Monday
  // 9:00 AM ET — gives Sunday tournaments a buffer for Monday weather
  // finishes while still emailing managers before the workday gets rolling.
  const [resultsDay,    setResultsDay]    = useState(() => settings?.resultsDay    ?? 1); // default Mon=1
  const [resultsHour,   setResultsHour]   = useState(() => settings?.resultsHour   ?? 9);  // 24h ET, default 9am
  const [resultsMinute, setResultsMinute] = useState(() => settings?.resultsMinute ?? 0);
  const [resultsSaving, setResultsSaving] = useState(false);

  const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const fmtWaiverTime = (h, m) => {
    const hr = h % 12 || 12;
    const ampm = h < 12 ? 'AM' : 'PM';
    const min = String(m).padStart(2, '0');
    return `${hr}:${min} ${ampm}`;
  };

  const handleSaveWaiverSchedule = async () => {
    setWaiverSaving(true);
    try {
      await setSettings({ ...settings, waiverDay, waiverHour, waiverMinute });
      dialog.showToast(`✓ Waivers process ${DAY_NAMES[waiverDay]} at ${fmtWaiverTime(waiverHour, waiverMinute)} ET`, 'success');
    } catch (err) {
      dialog.showToast('Error: ' + err.message, 'error');
    } finally { setWaiverSaving(false); }
  };

  const handleSaveResultsSchedule = async () => {
    setResultsSaving(true);
    try {
      await setSettings({ ...settings, resultsDay, resultsHour, resultsMinute });
      dialog.showToast(`✓ Results email ${DAY_NAMES[resultsDay]} at ${fmtWaiverTime(resultsHour, resultsMinute)} ET`, 'success');
    } catch (err) {
      dialog.showToast('Error: ' + err.message, 'error');
    } finally { setResultsSaving(false); }
  };

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

      // Fetch ESPN IDs for all rostered players and save them
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
      await playerRankingsApi.setLastUpdated(new Date().toISOString()).catch(() => {});
      await playerRankingsApi.invalidateCache().catch(() => {});
      setOwgrLastSynced(new Date().toISOString());
      setOwgrStatus('done');
      setOwgrSummary(`✓ ${fetched.length} rankings synced · ${updated} updated · ${added} new`);
    } catch (err) {
      setOwgrStatus('error');
      setOwgrSummary(err.message || 'OWGR sync failed');
    }
  };

  // ── LIV roster sync ───────────────────────────────────────────────────────
  const [livSyncStatus, setLivSyncStatus] = useState(null);
  const [livSyncSummary, setLivSyncSummary] = useState('');
  const [livLastSynced, setLivLastSynced] = useState(() => settings?.livRosterLastSynced || null);

  const handleSyncLiv = async () => {
    setLivSyncStatus('fetching');
    setLivSyncSummary('');
    try {
      const livRosterLower = new Set(LIV_GOLF_ROSTER.map(n => n.toLowerCase()));
      const toFlag = LIV_GOLF_ROSTER.filter(name =>
        !allPlayers.find(p => p.name.toLowerCase() === name.toLowerCase())?.isLiv
      );
      const toUnflag = allPlayers.filter(p =>
        p.isLiv && !livRosterLower.has(p.name.toLowerCase())
      );
      if (toFlag.length === 0 && toUnflag.length === 0) {
        setLivSyncStatus('done');
        setLivSyncSummary('✓ LIV roster already matches DB — no changes needed');
        return;
      }
      const livWrites = [
        ...toFlag.map(name => ({ name, isLiv: true })),
        ...toUnflag.map(p => ({ name: p.name, isLiv: false })),
      ];
      await playersApi.upsertMany(livWrites);
      setAllPlayers(prev => {
        const updated = [...prev];
        toFlag.forEach(name => {
          const idx = updated.findIndex(p => p.name.toLowerCase() === name.toLowerCase());
          if (idx >= 0) updated[idx] = { ...updated[idx], isLiv: true };
          else updated.push({ name, isLiv: true, worldRank: null });
        });
        toUnflag.forEach(u => {
          const idx = updated.findIndex(p => p.name === u.name);
          if (idx >= 0) updated[idx] = { ...updated[idx], isLiv: false };
        });
        return updated;
      });
      const parts = [
        toFlag.length   > 0 ? `${toFlag.length} tagged` : '',
        toUnflag.length > 0 ? `${toUnflag.length} unflagged` : '',
      ].filter(Boolean).join(' · ');
      const livTs = new Date().toISOString();
      setLivLastSynced(livTs);
      setSettings({ ...settings, livRosterLastSynced: livTs }).catch(() => {});
      setLivSyncStatus('done');
      setLivSyncSummary(`✓ LIV roster synced · ${parts}`);
    } catch (err) {
      setLivSyncStatus('error');
      setLivSyncSummary(err.message || 'LIV sync failed');
    }
  };

  // ── Static alias sync ─────────────────────────────────────────────────────
  // One-shot migration: pushes the historical entries from
  // src/constants/nameAliases.js into Firestore as dynamic aliases on each
  // canonical player doc. Idempotent — safe to re-run. Once Aaron has run
  // this and confirmed all entries migrated, the static map becomes a pure
  // fallback (still used by upsertMany when the dynamic map misses).
  const [aliasSyncStatus, setAliasSyncStatus] = useState(null);
  const [aliasSyncSummary, setAliasSyncSummary] = useState('');
  const handleSeedAliases = async () => {
    setAliasSyncStatus('fetching');
    setAliasSyncSummary('');
    try {
      const r = await seedAliasesToFirestore(playersApi);
      const parts = [
        r.added          > 0 ? `${r.added} added` : '',
        r.alreadyPresent > 0 ? `${r.alreadyPresent} already present` : '',
        r.skipped        > 0 ? `${r.skipped} skipped` : '',
      ].filter(Boolean).join(' · ') || 'no entries to process';
      const detail = r.errors.length ? '\n• ' + r.errors.join('\n• ') : '';
      setAliasSyncStatus(r.errors.length && r.added === 0 && r.alreadyPresent === 0 ? 'error' : 'done');
      setAliasSyncSummary(`✓ Static aliases synced · ${parts}${detail}`);
    } catch (err) {
      setAliasSyncStatus('error');
      setAliasSyncSummary(err.message || 'Alias sync failed');
    }
  };

  const pending = transactions.map((tx, i) => ({ ...tx, _idx: i })).filter(tx => tx.status === 'pending' && tx.type === 'waiver');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 40 }}>

      <CollapsibleGroup title="Tournament Operations" icon="🏆">
      {/* ── 1. Tournament Results ── */}
      <div style={S.section}>
        <div style={S.title}>🏆 Tournament Results</div>
        <label style={S.lbl}>Tournament</label>
        <select value={selectedTourney} onChange={e => {
          const name = e.target.value;
          setSelectedTourney(name);
          const t = tournaments.find(t => t.name === name);
          if (t?.completed && t.results) {
            const lines = t.results.earningsMap
              ? Object.entries(t.results.earningsMap).sort((a,b) => b[1]-a[1]).map(([p,a]) => `${p}, ${a}`).join('\n')
              : '';
            const teamLineups = {};
            if (t.results.fullLineups) Object.entries(t.results.fullLineups).forEach(([id, lu]) => { teamLineups[id] = [...lu]; });
            setManualEntry(prev => ({
              ...prev, playerEarnings: lines, teamLineups,
              round1Leaders: t.results.roundLeaders?.round1?.length ? t.results.roundLeaders.round1 : [''],
              round2Leaders: t.results.roundLeaders?.round2?.length ? t.results.roundLeaders.round2 : [''],
              round3Leaders: t.results.roundLeaders?.round3?.length ? t.results.roundLeaders.round3 : [''],
            }));
          } else {
            setManualEntry({ round1Leaders: [''], round2Leaders: [''], round3Leaders: [''], playerEarnings: '', teamLineups: {} });
          }
        }} style={S.select}>
          <option value="">Choose tournament...</option>
          {tournaments.map(t => <option key={t.name} value={t.name}>{t.completed ? '✓ ' : t.playing ? '▶ ' : ''}{t.name}</option>)}
        </select>

        {/* Fetch button — auto-fills earnings + round leaders */}
        <button onClick={handleFetchPGAResults} disabled={pgaFetching || !selectedTourney}
          style={{ ...S.btn, marginBottom: 14, ...(!selectedTourney || pgaFetching ? { opacity: 0.4, cursor: 'not-allowed' } : {}) }}>
          {pgaFetching ? '⏳ Fetching…' : selectedTourney ? `⛳ Get ${selectedTourney} Results` : '⛳ Get Tournament Results'}
        </button>

        {/* Round leader overrides — auto-filled by fetch, commish can correct */}
        {manualEntry.playerEarnings.trim() && (
          <>
            <div style={{ ...theme.smallText, color: colors.textSecondary, marginBottom: 8 }}>
              Round leaders auto-detected — override if incorrect:
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
              <RoundLeaderSelect label="R1 Leader" round={1} leaders={manualEntry.round1Leaders} onChange={r => setManualEntry({ ...manualEntry, round1Leaders: r })} />
              <RoundLeaderSelect label="R2 Leader" round={2} leaders={manualEntry.round2Leaders} onChange={r => setManualEntry({ ...manualEntry, round2Leaders: r })} />
              <RoundLeaderSelect label="R3 Leader" round={3} leaders={manualEntry.round3Leaders} onChange={r => setManualEntry({ ...manualEntry, round3Leaders: r })} />
            </div>

            {/* ── Team Lineups editor ──
                Lets the commish set or correct each team's lineup for the
                selected tournament before (re)processing. Edits flow into
                manualEntry.teamLineups, which both handleManualEntry and
                handleReprocess already consume — no new persistence wiring
                needed. Roster pool is the union of each team's current
                roster + any names already saved in the lineup, so legacy
                tournaments don't lose previously-rostered players that have
                since been dropped. Collapsed by default to keep the panel
                compact; expand to edit.
                Once edits are made + Reprocess is run, the new lineups are
                used to compute earnings. If the swing is affected, manually
                reverse the old swing_winner transaction in the Transactions
                tab and re-run "Award Swing Winner" to redistribute the pot. */}
            <TeamLineupsEditor
              teams={teams}
              manualEntry={manualEntry}
              setManualEntry={setManualEntry}
              lineupSize={settings?.lineupSize ?? 5}
              rostersByTeamId={rostersByTeamIdForSelectedTourney}
              S={S}
            />

            {/* Process / Reprocess */}
            {!tournaments.find(t => t.name === selectedTourney)?.completed ? (
              <button onClick={handleManualEntry} disabled={!selectedTourney}
                style={{ ...S.btn, ...disabledBtn(!selectedTourney) }}>
                ✅ Process Results
              </button>
            ) : (
              <>
                <button onClick={handleReprocess} disabled={!selectedTourney}
                  style={{ ...S.btn, background: 'rgba(220,150,50,0.12)', border: '1px solid rgba(220,150,50,0.4)', color: 'rgba(220,180,80,0.9)', ...disabledBtn(!selectedTourney) }}>
                  ✏️ Reprocess Tournament
                </button>
                {/* Resend the email without touching any data — useful for
                    re-sending after a broken template render, or testing
                    template changes without waiting for next Monday. */}
                <button onClick={handleResendResultsEmail} disabled={!selectedTourney}
                  style={{ ...S.btn, marginTop: 6, background: 'rgba(80,140,200,0.10)', border: '1px solid rgba(80,140,200,0.35)', color: 'rgba(150,200,255,0.9)', ...disabledBtn(!selectedTourney) }}>
                  📧 Resend Results Email
                </button>
              </>
            )}
          </>
        )}
      </div>

      {/* ── 2. Process Waivers ── */}
      <div style={S.section}>
        {/* Waiver processing reminder — uses configurable schedule */}
        {(() => {
          const now = new Date();
          const etOffset = -4;
          const etHour = (now.getUTCHours() + 24 + etOffset) % 24;
          const etMin  = now.getUTCMinutes();
          const etDay  = new Date(now.getTime() + etOffset * 3600 * 1000).getUTCDay();
          const wd = waiverDay ?? 2;
          const wh = waiverHour ?? 20;
          const wm = waiverMinute ?? 0;
          const isReadyToProcess = etDay === wd && (etHour * 60 + etMin) >= (wh * 60 + wm) && pending.length > 0;
          if (!isReadyToProcess) return null;
          return (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', marginBottom: 10, borderRadius: 3,
              background: 'rgba(220,170,60,0.1)', border: '1px solid rgba(220,170,60,0.45)',
            }}>
              <span style={{ fontSize: 14 }}>⏰</span>
              <div style={{ flex: 1, fontFamily: fonts.sans, fontSize: 11, color: 'rgba(220,190,80,0.9)', fontWeight: 600 }}>
                Past {fmtWaiverTime(wh, wm)} ET {DAY_NAMES[wd]} — process now!
              </div>
            </div>
          );
        })()}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={S.title}>⏰ Process Waivers</div>
          {pending.length > 0 && <span style={{ ...theme.badge, ...theme.badgeWarning }}>{pending.length} pending</span>}
        </div>
        {pending.length === 0 ? (
          <div style={{ ...theme.smallText, textAlign: 'center', padding: '8px 0', color: colors.success }}>✓ No pending waiver claims</div>
        ) : !waiverRevealed ? (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
              {pending.map(w => (
                <div key={w._idx} style={{ display: 'flex', alignItems: 'center', gap: 8, background: colors.inputBg, border: `1px solid ${colors.borderSubtle}`, borderRadius: 3, padding: '6px 12px' }}>
                  <div style={{ width: 18, height: 18, borderRadius: '50%', background: 'rgba(220,170,60,0.1)', border: '1px solid rgba(220,170,60,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700, color: colors.warning, flexShrink: 0 }}>{w.priority || '?'}</div>
                  <div style={{ fontFamily: fonts.sans, fontSize: 12, fontWeight: 600, color: colors.textPrimary }}>{w.team}</div>
                  <div style={{ flex: 1 }} />
                  <span style={{ fontFamily: fonts.sans, fontSize: 10, color: colors.textMuted }}>claim pending</span>
                </div>
              ))}
            </div>
            {(() => {
              const now = new Date();
              const etOffset = -4;
              const etHour = (now.getUTCHours() + 24 + etOffset) % 24;
              const etMin  = now.getUTCMinutes();
              const etDay  = new Date(now.getTime() + etOffset * 3600 * 1000).getUTCDay();
              const wd = waiverDay ?? 2;
              const wh = waiverHour ?? 20;
              const wm = waiverMinute ?? 0;
              const ready = etDay === wd && (etHour * 60 + etMin) >= (wh * 60 + wm);
              return (
                <button onClick={() => setWaiverRevealed(true)} style={ready
                  ? { ...S.btn, fontSize: 13, fontWeight: 700, padding: '12px 20px', background: 'rgba(220,170,60,0.2)', border: '2px solid rgba(220,170,60,0.7)', color: 'rgba(255,220,80,1)', boxShadow: '0 0 12px rgba(220,170,60,0.25)' }
                  : { ...S.btnSec, fontSize: 11 }
                }>
                  {ready ? `⚡ Process Claims (${pending.length})` : `Process Claims (${pending.length})`}
                </button>
              );
            })()}
          </>
        ) : (
          <>
            {/* Tiebreaker summary — show competing claims */}
            {(() => {
              // Group claims by player to find conflicts
              const byPlayer = {};
              pending.forEach(w => {
                if (!byPlayer[w.player]) byPlayer[w.player] = [];
                byPlayer[w.player].push(w);
              });
              const conflicts = Object.entries(byPlayer).filter(([, claims]) => claims.length > 1);
              if (conflicts.length === 0) return null;

              const earningsMap = {};
              teams.forEach(t => { earningsMap[t.name] = t.earnings || 0; });
              const fmtEarnings = (n) => '$' + (n || 0).toLocaleString();

              return (
                <div style={{
                  background: 'rgba(220,100,60,0.08)', border: '1px solid rgba(220,100,60,0.35)',
                  borderRadius: 3, padding: '10px 14px', marginBottom: 10,
                }}>
                  <div style={{ fontFamily: fonts.sans, fontSize: 11, fontWeight: 700, letterSpacing: '1.5px', textTransform: 'uppercase', color: 'rgba(220,140,80,0.9)', marginBottom: 8 }}>
                    ⚠️ Competing Claims ({conflicts.length})
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {conflicts.map(([player, claims]) => {
                      const sorted = [...claims].sort((a, b) => (earningsMap[a.team] || 0) - (earningsMap[b.team] || 0));
                      return (
                        <div key={player} style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 2, padding: '8px 10px' }}>
                          <div style={{ fontFamily: fonts.sans, fontSize: 12, fontWeight: 600, color: colors.textPrimary, marginBottom: 4 }}>
                            {player} — {claims.length} teams competing
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            {sorted.map((c, i) => (
                              <div key={c.team} style={{ fontFamily: fonts.sans, fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>
                                <span style={{
                                  fontSize: 9, fontWeight: 700, width: 14, textAlign: 'center',
                                  color: i === 0 ? colors.earningsGreen : colors.textMuted,
                                }}>{i + 1}.</span>
                                <span style={{ color: i === 0 ? colors.textPrimary : colors.textMuted, fontWeight: i === 0 ? 600 : 400 }}>
                                  {c.team}
                                </span>
                                <span style={{ color: colors.textMuted, fontSize: 10 }}>
                                  {fmtEarnings(earningsMap[c.team])}
                                </span>
                                {i === 0 && <span style={{ color: colors.earningsGreen, fontSize: 10, fontWeight: 600 }}>← wins</span>}
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ ...theme.smallText, color: colors.textMuted, marginTop: 6 }}>
                    Tiebreaker: lowest total SFGL earnings wins. Winner moves to back of line.
                  </div>
                </div>
              );
            })()}
            <button onClick={() => handleProcessAll(pending)} style={{ ...S.btn, marginBottom: 8 }}>⚡ Process All ({pending.length})</button>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {pending.map(w => (
                <div key={w._idx} style={{ display: 'flex', alignItems: 'center', gap: 10, background: colors.inputBg, border: `1px solid ${colors.borderSubtle}`, borderRadius: 3, padding: '8px 12px' }}>
                  <div style={{ width: 20, height: 20, borderRadius: '50%', background: 'rgba(220,170,60,0.1)', border: '1px solid rgba(220,170,60,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, color: colors.warning, flexShrink: 0 }}>{w.priority || '?'}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: fonts.sans, fontSize: 12, fontWeight: 600, color: colors.textPrimary }}>{w.team}</div>
                    <div style={{ fontSize: 11 }}>
                      <span style={{ color: colors.earningsGreen }}>+{w.player}</span>
                      {w.droppedPlayer && <span style={{ color: colors.danger }}> / -{w.droppedPlayer}</span>}
                    </div>
                  </div>
                  <button onClick={() => handleProcessSingle(w)} style={{ ...theme.btnSecondary, padding: '5px 10px', fontSize: 11, flexShrink: 0 }}>Process</button>
                </div>
              ))}
            </div>
            <button onClick={() => setWaiverRevealed(false)} style={{ ...theme.btnSecondary, marginTop: 8, fontSize: 10, padding: '4px 12px', width: 'auto', display: 'inline-block' }}>Hide Claims</button>
          </>
        )}
      </div>

      {/* ── 4. Award Swing Winner ── */}
      <div style={S.section}>
        <div style={S.title}>🏆 Award Swing Winner</div>
        <label style={S.lbl}>Swing</label>
        <select value={swingAwardSeg} onChange={e => setSwingAwardSeg(e.target.value)} style={S.select}>
          <option value="">Select swing...</option>
          {SWINGS.map(s => {
            const pot = transactions.filter(tx => tx.segment === s && (tx.fee || 0) > 0).reduce((sum, tx) => sum + tx.fee, 0);
            const alreadyAwarded = transactions.some(tx => tx.type === 'swing_winner' && tx.segment === s);
            return (
              <option key={s} value={s} disabled={alreadyAwarded}>
                {s}{pot > 0 ? ' · $' + pot.toLocaleString() + ' pot' : ''}{alreadyAwarded ? ' ✓ awarded' : ''}
              </option>
            );
          })}
        </select>
        {swingAwardSeg && (() => {
          const pot = transactions.filter(tx => tx.segment === swingAwardSeg && (tx.fee || 0) > 0).reduce((sum, tx) => sum + tx.fee, 0);
          const swingTourneys = tournaments.filter(t => t.completed && getTournamentSegment(t) === swingAwardSeg && t.results?.teams);
          const byTeam = {};
          swingTourneys.forEach(t => Object.entries(t.results.teams).forEach(([id, tr]) => { byTeam[id] = (byTeam[id] || 0) + (tr.totalEarnings || 0); }));
          const topEntry = Object.entries(byTeam).sort((a, b) => b[1] - a[1])[0];
          const leader = topEntry ? teams.find(t => t.id === topEntry[0]) : null;
          return (
            <div style={{ ...theme.smallText, marginBottom: 10, padding: '8px 10px', background: colors.inputBg, borderRadius: 3, border: `1px solid ${colors.borderSubtle}` }}>
              {leader
                ? <span>🏆 Leader: <span style={{ color: colors.textGold, fontWeight: 600 }}>{leader.name}</span> · ${(topEntry[1] || 0).toLocaleString()} · <span style={{ color: colors.earningsGreen }}>Pot: ${pot.toLocaleString()}</span></span>
                : <span style={{ color: colors.textMuted }}>No completed results for this swing yet</span>
              }
            </div>
          );
        })()}
        <button onClick={handleSwingWinner} disabled={!swingAwardSeg}
          style={{ ...S.btn, ...disabledBtn(!swingAwardSeg) }}>
          🏆 Award Swing Winner
        </button>
      </div>
      </CollapsibleGroup>

      <CollapsibleGroup title="Data Sync" icon="🔄">

      {/* ── 3. Update OWGR Rankings ── */}
      <div style={S.section}>
        <div style={S.title}>🌍 Update OWGR Rankings</div>
        {(owgrLastSynced || rankingsLastUpdated) && (
          <div style={{ ...theme.smallText, color: colors.textGoldDim, marginBottom: 10 }}>
            Last synced: {new Date(owgrLastSynced || rankingsLastUpdated).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
          </div>
        )}
        <button
          onClick={handleSyncOwgr}
          disabled={owgrStatus === 'fetching'}
          style={{ ...S.btn, ...(owgrStatus === 'fetching' ? { opacity: 0.5, cursor: 'not-allowed' } : {}) }}
        >
          {owgrStatus === 'fetching' ? '⏳ Fetching…' : '🔄 Sync OWGR Rankings'}
        </button>
        {owgrSummary && (
          <div style={{
            marginTop: 10, padding: '8px 12px', borderRadius: 3, fontSize: 12, fontFamily: fonts.sans,
            background: owgrStatus === 'error' ? colors.dangerBg : 'rgba(80,160,100,0.1)',
            border: `1px solid ${owgrStatus === 'error' ? colors.dangerBorder : 'rgba(80,160,100,0.3)'}`,
            color: owgrStatus === 'error' ? colors.danger : colors.success,
          }}>
            {owgrSummary}
          </div>
        )}
      </div>

      {/* ── 4. LIV Golf Sync ── */}
      <div style={S.section}>
        <div style={S.title}>🚫 LIV Golf — Sync Roster</div>
        {(livLastSynced || settings?.livRosterLastSynced) && (
          <div style={{ ...theme.smallText, color: colors.textGoldDim, marginBottom: 10 }}>
            Last synced: {new Date(livLastSynced || settings?.livRosterLastSynced).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
          </div>
        )}
        <button
          onClick={handleSyncLiv}
          disabled={livSyncStatus === 'fetching'}
          style={{ ...S.btn, ...(livSyncStatus === 'fetching' ? { opacity: 0.5, cursor: 'not-allowed' } : {}) }}
        >
          {livSyncStatus === 'fetching' ? '⏳ Syncing…' : '🔄 Sync LIV Roster'}
        </button>
        {livSyncSummary && (
          <div style={{
            marginTop: 10, padding: '8px 12px', borderRadius: 3, fontSize: 12, fontFamily: fonts.sans,
            background: livSyncStatus === 'error' ? colors.dangerBg : 'rgba(80,160,100,0.1)',
            border: `1px solid ${livSyncStatus === 'error' ? colors.dangerBorder : 'rgba(80,160,100,0.3)'}`,
            color: livSyncStatus === 'error' ? colors.danger : colors.success,
          }}>
            {livSyncSummary}
          </div>
        )}
      </div>

      {/* ── 5. Static Alias Sync (one-time migration) ── */}
      <div style={S.section}>
        <div style={S.title}>🔗 Static Aliases — Sync to Firestore</div>
        <div style={{ ...theme.smallText, marginBottom: 10, color: colors.textSecondary }}>
          Copies the historical aliases hard-coded in <code>nameAliases.js</code> into Firestore as dynamic aliases on each canonical player doc. Run once after deploying. Idempotent — safe to re-run. New aliases going forward should use the Merge Players feature instead.
        </div>
        <button
          onClick={handleSeedAliases}
          disabled={aliasSyncStatus === 'fetching'}
          style={{ ...S.btn, ...(aliasSyncStatus === 'fetching' ? { opacity: 0.5, cursor: 'not-allowed' } : {}) }}
        >
          {aliasSyncStatus === 'fetching' ? '⏳ Syncing…' : '🔄 Sync Static Aliases'}
        </button>
        {aliasSyncSummary && (
          <div style={{
            marginTop: 10, padding: '8px 12px', borderRadius: 3, fontSize: 12, fontFamily: fonts.sans, whiteSpace: 'pre-wrap',
            background: aliasSyncStatus === 'error' ? colors.dangerBg : 'rgba(80,160,100,0.1)',
            border: `1px solid ${aliasSyncStatus === 'error' ? colors.dangerBorder : 'rgba(80,160,100,0.3)'}`,
            color: aliasSyncStatus === 'error' ? colors.danger : colors.success,
          }}>
            {aliasSyncSummary}
          </div>
        )}
      </div>

      {/* ── 6. LIV Golf Ineligible Players ── */}
      <div style={S.section}>
        <div style={S.title}>🚫 LIV Golf — Ineligible Players</div>
        <div style={{ ...theme.smallText, marginBottom: 10, color: colors.textSecondary }}>
          Players flagged as LIV are hidden from the add/drop modal and waiver system.
        </div>
        <input type="text" placeholder="Search players to add/remove LIV flag…"
          value={livSearch} onChange={e => setLivSearch(e.target.value)}
          style={{ ...theme.input, marginBottom: 10, fontSize: 12 }}
        />
        {(() => {
          const livPlayers = allPlayers.filter(p => p.isLiv).sort((a, b) => a.name.localeCompare(b.name));
          // Search: show non-LIV players from allPlayers, plus LIV_GOLF_ROSTER names not yet in DB
          const searchResults = livSearch.trim().length >= 2
            ? (() => {
                const q = livSearch.toLowerCase();
                const livNames = new Set(allPlayers.filter(p => p.isLiv).map(p => p.name));
                // Players in allPlayers that aren't LIV
                const fromAll = allPlayers
                  .filter(p => p.name && p.name.toLowerCase().includes(q) && !p.isLiv)
                  .map(p => ({ name: p.name, worldRank: p.worldRank }));
                // LIV_GOLF_ROSTER names not yet in allPlayers at all
                const existingNames = new Set(allPlayers.map(p => p.name));
                const fromConst = LIV_GOLF_ROSTER
                  .filter(name => name.toLowerCase().includes(q) && !existingNames.has(name) && !livNames.has(name))
                  .map(name => ({ name, worldRank: null }));
                return [...fromAll, ...fromConst].slice(0, 10);
              })()
            : [];
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {/* Search results — players to add to LIV list */}
              {searchResults.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontFamily: fonts.sans, fontSize: 10, color: colors.textMuted, letterSpacing: '0.5px', textTransform: 'uppercase', marginBottom: 4 }}>
                    Add to LIV list
                  </div>
                  {searchResults.map(p => (
                    <div key={p.name} style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '6px 10px', marginBottom: 2, borderRadius: 3,
                      background: 'rgba(80,180,120,0.06)', border: `1px solid rgba(80,180,120,0.2)`,
                    }}>
                      <span style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.textPrimary }}>
                        {p.name}
                        {p.worldRank && <span style={{ color: colors.textMuted, fontSize: 10, marginLeft: 6 }}>#{p.worldRank}</span>}
                      </span>
                      <button
                        disabled={livSaving[p.name]}
                        onClick={async () => {
                          setLivSaving(prev => ({ ...prev, [p.name]: true }));
                          try {
                            await playersApi.upsertMany([{ name: p.name, isLiv: true }]);
                            setAllPlayers(prev => {
                              const exists = prev.some(x => x.name === p.name);
                              if (exists) return prev.map(x => x.name === p.name ? { ...x, isLiv: true } : x);
                              return [...prev, { name: p.name, worldRank: p.worldRank || null, isLiv: true }];
                            });
                            dialog.showToast('Flagged ' + p.name + ' as LIV', 'success');
                            setLivSearch('');
                          } catch(err) { dialog.showToast('Error: ' + err.message, 'error'); }
                          finally { setLivSaving(prev => ({ ...prev, [p.name]: false })); }
                        }}
                        style={{ fontFamily: fonts.sans, fontSize: 10, padding: '3px 8px', background: 'rgba(220,60,60,0.15)', border: '1px solid rgba(220,60,60,0.35)', color: colors.danger, borderRadius: 2, cursor: 'pointer' }}
                      >
                        {livSaving[p.name] ? '…' : '+ Flag LIV'}
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Current LIV roster */}
              <div style={{ fontFamily: fonts.sans, fontSize: 10, color: colors.textMuted, letterSpacing: '0.5px', textTransform: 'uppercase', marginBottom: 4 }}>
                {livPlayers.length} flagged player{livPlayers.length !== 1 ? 's' : ''}
              </div>
              {livPlayers.length === 0 ? (
                <div style={{ ...theme.smallText, textAlign: 'center', padding: '8px 0', color: colors.textMuted }}>No LIV players flagged</div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {livPlayers.map(p => (
                    <div key={p.name} style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                      padding: '4px 8px', borderRadius: 3,
                      background: 'rgba(220,60,60,0.08)', border: `1px solid rgba(220,60,60,0.2)`,
                      fontSize: 11, fontFamily: fonts.sans, color: colors.textSecondary,
                    }}>
                      {p.name}
                      <button
                        disabled={livSaving[p.name]}
                        onClick={async () => {
                          setLivSaving(prev => ({ ...prev, [p.name]: true }));
                          try {
                            await playersApi.update(p.name, { isLiv: false });
                            setAllPlayers(prev => prev.map(x => x.name === p.name ? { ...x, isLiv: false } : x));
                            dialog.showToast('Removed LIV flag from ' + p.name, 'success');
                          } catch(err) { dialog.showToast('Error: ' + err.message, 'error'); }
                          finally { setLivSaving(prev => ({ ...prev, [p.name]: false })); }
                        }}
                        style={{ background: 'none', border: 'none', color: 'rgba(220,100,80,0.7)', cursor: 'pointer', fontSize: 12, padding: 0, lineHeight: 1 }}
                        title={'Remove LIV flag from ' + p.name}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })()}
      </div>

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
          dialog={dialog} updateTeams={updateTeams} setTransactions={setTransactions}
          theme={theme} colors={colors} fonts={fonts} S={S}
          sfglDataApi={sfglDataApi} playersApi={playersApi}
          STORAGE_KEYS={STORAGE_KEYS} disabledBtn={disabledBtn}
        />}
      </div>
      </CollapsibleGroup>

      <CollapsibleGroup title="Manager Accounts" icon="👥">
      {/* ── 7. Manager Login Credentials ── */}
      <div style={S.section}>
        <div style={S.title}>🔑 Manager Login Credentials</div>
        <label style={S.lbl}>Team</label>
        <select value={mgCredTeam} onChange={e => { setMgCredTeam(e.target.value); setMgCredName(teams.find(x => x.id === e.target.value)?.owner || ''); }} style={S.select}>
          <option value="">Select team...</option>
          {teams.map(t => <option key={t.id} value={t.id}>{t.name} — {t.owner}</option>)}
        </select>
        <input value={mgCredName} onChange={e => setMgCredName(e.target.value)} placeholder="Login name" style={S.input} />
        <input type="password" value={mgCredPass} onChange={e => setMgCredPass(e.target.value)} placeholder="Password" style={S.input} />
        <button onClick={handleSetLogin} disabled={mgCredSaving || !mgCredTeam || !mgCredName || !mgCredPass}
          style={{ ...S.btn, ...disabledBtn(mgCredSaving || !mgCredTeam || !mgCredName || !mgCredPass) }}>
          {mgCredSaving ? 'Saving...' : 'Set Login'}
        </button>
      </div>

      {/* ── Manager Emails ── */}
      <div style={S.section}>
        <div style={S.title}>📧 Manager Emails</div>
        <div style={{ ...theme.smallText, color: colors.textSecondary, marginBottom: 12 }}>
          Set email addresses for each manager. Used for waiver results, tournament results, and lineup reminders.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
          {teams.map(t => {
            const currentEmail = (settings.managerEmails || {})[t.id] || '';
            return (
              <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontFamily: fonts.sans, fontSize: 12, fontWeight: 600, color: colors.textPrimary, width: 120, flexShrink: 0 }}>{t.name}</span>
                <input
                  type="email"
                  placeholder="email@example.com"
                  value={emailDraft?.[t.id] ?? currentEmail}
                  onChange={e => setEmailDraft(prev => ({ ...(prev || {}), [t.id]: e.target.value }))}
                  style={{ ...theme.input, flex: 1, fontSize: 12, padding: '7px 10px' }}
                />
              </div>
            );
          })}
        </div>
        <button
          onClick={async () => {
            if (!emailDraft) return;
            const merged = { ...(settings.managerEmails || {}), ...emailDraft };
            try {
              await setSettings({ ...settings, managerEmails: merged });
              dialog.showToast('✓ Manager emails saved', 'success');
              setEmailDraft(null);
            } catch (err) {
              dialog.showToast('Error: ' + err.message, 'error');
            }
          }}
          disabled={!emailDraft}
          style={{ ...S.btn, ...(!emailDraft ? { opacity: 0.4, cursor: 'not-allowed' } : {}) }}
        >
          💾 Save Emails
        </button>
      </div>
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
      {/* ── Season Settings ── */}
      <div style={S.section}>
        <button onClick={() => { setSettingsOpen(o => !o); setSettingsDraft(null); }}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
          <div style={S.title}>⚙️ Season Settings</div>
          <span style={{ fontFamily: fonts.sans, fontSize: 11, color: colors.textMuted, paddingBottom: 12 }}>{settingsOpen ? '▲ close' : '▼ edit'}</span>
        </button>
        {settingsOpen && (() => {
          const isEditing = settingsDraft !== null && typeof settingsDraft === 'object';
          const draft = settingsDraft || getSettingsDraft();
          const set = (key, val) => setSettingsDraft({ ...(settingsDraft || getSettingsDraft()), [key]: val });
          const numInput = (key, label, min = 0, dollar = false) => (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <label style={{ fontFamily: fonts.sans, fontSize: 10, color: colors.textMuted, letterSpacing: '0.5px', textTransform: 'uppercase' }}>{label}</label>
              <div style={{ position: 'relative' }}>
                {dollar && <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', fontFamily: fonts.mono, fontSize: 13, color: colors.textMuted, pointerEvents: 'none' }}>$</span>}
                <input type="number" min={min} value={draft[key]} onChange={e => set(key, Number(e.target.value))}
                  style={{ ...theme.input, marginBottom: 0, fontSize: 13, textAlign: dollar ? 'right' : 'center', paddingLeft: dollar ? 18 : undefined, width: '100%', border: isEditing ? '1px solid rgba(220,170,60,0.5)' : undefined }} />
              </div>
            </div>
          );
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 4 }}>
              <div style={{ ...theme.smallText, color: colors.textMuted }}>⚠️ Changes apply immediately to all league calculations.</div>
              <div>
                <div style={{ fontFamily: fonts.sans, fontSize: 10, fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', color: colors.textGold, marginBottom: 8 }}>Round Leader Bonuses</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 8 }}>
                  {numInput('bonusR1Regular', 'R1 — Regular', 0, true)}
                  {numInput('bonusR2Regular', 'R2 — Regular', 0, true)}
                  {numInput('bonusR3Regular', 'R3 — Regular', 0, true)}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                  {numInput('bonusR1Major', 'R1 — Major', 0, true)}
                  {numInput('bonusR2Major', 'R2 — Major', 0, true)}
                  {numInput('bonusR3Major', 'R3 — Major', 0, true)}
                </div>
              </div>
              <div>
                <div style={{ fontFamily: fonts.sans, fontSize: 10, fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', color: colors.textGold, marginBottom: 8 }}>Transaction Fees ($)</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {numInput('feeFA', 'Free Agent', 0, true)}
                  {numInput('feeWaiver', 'Waiver Claim', 0, true)}
                </div>
              </div>
              <div>
                <div style={{ fontFamily: fonts.sans, fontSize: 10, fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', color: colors.textGold, marginBottom: 8 }}>Roster Rules</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                  {numInput('rosterLimit', 'Roster Size', 1)}
                  {numInput('lineupSize', 'Lineup Size', 1)}
                  {numInput('maxLimitedStarts', 'Max ★ Starts', 1)}
                </div>
              </div>
              {isEditing && (
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={async () => { const ok = await dialog.showConfirm('Save Season Settings', 'These changes affect all league calculations immediately. Are you sure?', { confirmText: 'Yes, Save', type: 'warning' }); if (ok) handleSaveSettings(); }}
                    disabled={settingsSaving} style={{ ...S.btn, flex: 1, ...(settingsSaving ? { opacity: 0.5, cursor: 'not-allowed' } : {}) }}>
                    {settingsSaving ? '⏳ Saving…' : '✓ Save Season Settings'}
                  </button>
                  <button onClick={() => setSettingsDraft(null)} style={{ ...theme.btnSecondary, flex: 0, padding: '10px 16px', whiteSpace: 'nowrap' }}>Discard</button>
                </div>
              )}
            </div>
          );
        })()}
      </div>

      {/* ── Waiver Schedule ── */}
      <div style={S.section}>
        <div style={S.title}>🗓️ Waiver Schedule</div>
        <div style={{ ...theme.smallText, color: colors.textSecondary, marginBottom: 12 }}>
          Set the day and time (ET) that waiver claims are processed each week. Default is Tuesday at 8:00 PM ET.
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <label style={S.lbl}>Day</label>
            <select value={waiverDay} onChange={e => setWaiverDay(Number(e.target.value))} style={S.select}>
              {DAY_NAMES.map((d, i) => <option key={i} value={i}>{d}</option>)}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label style={S.lbl}>Hour (ET)</label>
            <select value={waiverHour} onChange={e => setWaiverHour(Number(e.target.value))} style={S.select}>
              {Array.from({ length: 24 }, (_, i) => (
                <option key={i} value={i}>{i === 0 ? '12 AM' : i < 12 ? `${i} AM` : i === 12 ? '12 PM' : `${i - 12} PM`}</option>
              ))}
            </select>
          </div>
          <div style={{ flex: '0 0 80px' }}>
            <label style={S.lbl}>Minute</label>
            <select value={waiverMinute} onChange={e => setWaiverMinute(Number(e.target.value))} style={S.select}>
              {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map(m => (
                <option key={m} value={m}>:{String(m).padStart(2, '0')}</option>
              ))}
            </select>
          </div>
        </div>
        <div style={{ ...theme.smallText, color: colors.textGoldDim, marginBottom: 10 }}>
          Current: waivers process {DAY_NAMES[waiverDay]} at {fmtWaiverTime(waiverHour, waiverMinute)} ET
          {settings?.waiverDay !== undefined && (settings.waiverDay !== waiverDay || settings.waiverHour !== waiverHour || (settings.waiverMinute ?? 0) !== waiverMinute) && (
            <span style={{ color: colors.warning }}> · unsaved changes</span>
          )}
        </div>
        <button onClick={handleSaveWaiverSchedule} disabled={waiverSaving}
          style={{ ...S.btn, ...(waiverSaving ? { opacity: 0.5, cursor: 'not-allowed' } : {}) }}>
          {waiverSaving ? '⏳ Saving…' : '💾 Save Waiver Schedule'}
        </button>
      </div>

      {/* ── Results Email Schedule ── */}
      <div style={S.section}>
        <div style={S.title}>📧 Results Email Schedule</div>
        <div style={{ ...theme.smallText, color: colors.textSecondary, marginBottom: 12 }}>
          Set the day and time (ET) that tournament results are processed and emailed to managers. Default is Monday at 9:00 AM ET.
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <label style={S.lbl}>Day</label>
            <select value={resultsDay} onChange={e => setResultsDay(Number(e.target.value))} style={S.select}>
              {DAY_NAMES.map((d, i) => <option key={i} value={i}>{d}</option>)}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label style={S.lbl}>Hour (ET)</label>
            <select value={resultsHour} onChange={e => setResultsHour(Number(e.target.value))} style={S.select}>
              {Array.from({ length: 24 }, (_, i) => (
                <option key={i} value={i}>{i === 0 ? '12 AM' : i < 12 ? `${i} AM` : i === 12 ? '12 PM' : `${i - 12} PM`}</option>
              ))}
            </select>
          </div>
          <div style={{ flex: '0 0 80px' }}>
            <label style={S.lbl}>Minute</label>
            <select value={resultsMinute} onChange={e => setResultsMinute(Number(e.target.value))} style={S.select}>
              {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map(m => (
                <option key={m} value={m}>:{String(m).padStart(2, '0')}</option>
              ))}
            </select>
          </div>
        </div>
        <div style={{ ...theme.smallText, color: colors.textGoldDim, marginBottom: 10 }}>
          Current: results email {DAY_NAMES[resultsDay]} at {fmtWaiverTime(resultsHour, resultsMinute)} ET
          {settings?.resultsDay !== undefined && (settings.resultsDay !== resultsDay || settings.resultsHour !== resultsHour || (settings.resultsMinute ?? 0) !== resultsMinute) && (
            <span style={{ color: colors.warning }}> · unsaved changes</span>
          )}
        </div>
        <button onClick={handleSaveResultsSchedule} disabled={resultsSaving}
          style={{ ...S.btn, ...(resultsSaving ? { opacity: 0.5, cursor: 'not-allowed' } : {}) }}>
          {resultsSaving ? '⏳ Saving…' : '💾 Save Results Schedule'}
        </button>
      </div>

      <div style={S.section}>
        <div style={S.title}>🎯 Draft</div>
        <button onClick={() => setShowDraftModal(true)} style={S.btn}>Open Draft Room</button>
      </div>
      </CollapsibleGroup>

      {showDraftModal && <DraftModal teams={teams} allPlayers={allPlayers} updateTeams={updateTeams} onClose={() => setShowDraftModal(false)} headshots={headshots} />}
    </div>
  );
};

