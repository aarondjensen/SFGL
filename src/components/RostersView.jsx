import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { Search } from 'lucide-react';
import { useDialog } from './DialogContext';
import { AddDropPlayerModal } from './AddDropPlayerModal';
import { MulliganModal } from './MulliganModal';
import { useRoster, useWindowStatus } from '../hooks';
import {
  getSortedRoster, shortName,
  getTeamAbbreviation, getLineupStatus, getFreeAgentWindowStatus, getWaiverWindowStatus,
  isPastRoundStart, getSegmentByDate, isTournamentLocked,
} from '../utils';
import { MAX_LIMITED_STARTS, LINEUP_SIZE } from '../constants';
import { theme, colors, fonts } from '../theme.js';
import { storage } from '../api';
import { sfglDataApi } from '../api/supabase';
import { STORAGE_KEYS } from '../constants';

// ── Headshot helpers (Cloudinary PGA Tour CDN — no ESPN 400 errors) ─────────
const getPlayerHeadshotUrls = (playerName, headshotMap = {}) => {
  const val = headshotMap[playerName];
  if (!val) return [];
  if (typeof val === 'string' && (val.startsWith('http') || val.startsWith('/'))) return [val];
  // Numeric ID — try both CDN formats
  return [
    `https://pga-tour-res.cloudinary.com/image/upload/c_thumb,g_face,z_0.7,q_auto,f_auto,dpr_2.0,w_96,h_96,b_rgb:F2F2F2,d_stub:default_avatar_light.webp/headshots_${val}`,
    `https://res.cloudinary.com/pgatour-prod/image/upload/c_thumb,g_face,z_0.7,q_auto,f_auto,dpr_2.0,w_96,h_96/headshots_${val}.png`,
    `https://media.pgatour.com/headshots/${val}.png`,
  ];
};

const getPlayerHeadshot = (playerName, isLimited = false, headshotMap = {}) => {
  const urls = getPlayerHeadshotUrls(playerName, headshotMap);
  if (urls.length > 0) return urls[0];
  const bg = isLimited ? '8B6914' : '1c3a5e';
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(playerName)}&background=${bg}&color=ffffff&size=96&bold=true&font-size=0.38`;
};

const makeHeadshotErrorHandler = (playerName, isLimited, headshotMap) => {
  const urls = getPlayerHeadshotUrls(playerName, headshotMap);
  let attempt = 0;
  return function handler(e) {
    attempt++;
    if (attempt < urls.length) {
      e.target.src = urls[attempt];
      e.target.onerror = handler;
    } else {
      e.target.onerror = null;
      const bg = isLimited ? '8B6914' : '1c3a5e';
      e.target.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(playerName)}&background=${bg}&color=ffffff&size=96&bold=true&font-size=0.38`;
    }
  };
};

const getPlayerHeadshotFallback = (playerName, isLimited = false) => {
  const bg = isLimited ? '8B6914' : '1c3a5e';
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(playerName)}&background=${bg}&color=ffffff&size=96&bold=true&font-size=0.38`;
};

// ── Border color by player type ───────────────────────────────────────────────
const playerBorderColor = (player) =>
  player.limited   ? 'rgba(245,197,24,0.9)' :
  player.unlimited ? 'rgba(100,140,220,0.9)' :
  'rgba(255,255,255,0.85)';

// ── Mobile display name helper ───────────────────────────────────────────────
const useIsMobile = () => {
  const [isMobile, setIsMobile] = React.useState(() => window.innerWidth < 640);
  React.useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 640);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);
  return isMobile;
};

const displayName = (fullName, isMobile) => {
  if (!isMobile || !fullName) return fullName;
  const parts = fullName.trim().split(' ');
  if (parts.length < 2) return fullName;
  return parts[0][0] + '. ' + parts[parts.length - 1];
};

// ── Custom team dropdown — stays dark on all browsers ─────────────────────────
const TeamDropdown = ({ teams, value, onChange }) => {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef(null);
  const selected = teams.find(t => t.id === value);

  React.useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div ref={ref} style={{ position: 'relative', minWidth: 160 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          padding: '6px 10px', borderRadius: 2, cursor: 'pointer', width: '100%',
          background: '#0f1d35', border: `1px solid ${open ? colors.border : 'rgba(255,255,255,0.12)'}`,
          fontFamily: fonts.serif, fontSize: 14, fontWeight: 700,
          color: 'rgba(255,255,255,0.9)', textAlign: 'left',
          transition: 'border-color 0.15s', whiteSpace: 'nowrap',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selected?.name ?? '—'}
        </span>
        <span style={{ fontSize: 9, opacity: 0.6, flexShrink: 0 }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, zIndex: 100, marginTop: 2,
          minWidth: '100%', width: 'max-content',
          background: '#0f1d35', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 2,
          boxShadow: '0 8px 24px rgba(0,0,0,0.5)', overflow: 'hidden',
        }}>
          {teams.map(t => (
            <button key={t.id} onClick={() => { onChange(t.id); setOpen(false); }}
              style={{
                display: 'block', width: '100%', padding: '9px 12px', textAlign: 'left', cursor: 'pointer',
                whiteSpace: 'nowrap',
                background: t.id === value ? 'rgba(245,197,24,0.12)' : 'transparent',
                border: 'none', borderBottom: '1px solid rgba(255,255,255,0.06)',
                fontFamily: fonts.serif, fontSize: 13, fontWeight: t.id === value ? 700 : 400,
                color: t.id === value ? colors.textGold : 'rgba(255,255,255,0.85)',
                transition: 'background 0.1s',
              }}
              onMouseEnter={e => { if (t.id !== value) e.currentTarget.style.background = 'rgba(255,255,255,0.07)'; }}
              onMouseLeave={e => { if (t.id !== value) e.currentTarget.style.background = 'transparent'; }}
            >
              {t.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// ── Waiver Priority Manager ───────────────────────────────────────────────────
const WaiverQueue = ({ team, pendingWaivers, transactions, setTransactions, updateTeams, teams, isOwnTeam }) => {
  const dialog = useDialog();

  const persistTransactions = (newTx) => {
    setTransactions(newTx);
    storage.set(STORAGE_KEYS.TRANSACTIONS, newTx);
  };

  const swapPriority = (fromIdx, toIdx) => {
    if (toIdx < 0 || toIdx >= pendingWaivers.length) return;
    const updated   = [...transactions];
    const fromTxIdx = pendingWaivers[fromIdx]._txIdx;
    const toTxIdx   = pendingWaivers[toIdx]._txIdx;
    const fromPri   = pendingWaivers[fromIdx].priority || fromIdx + 1;
    const toPri     = pendingWaivers[toIdx].priority   || toIdx + 1;
    updated[fromTxIdx] = { ...updated[fromTxIdx], priority: toPri };
    updated[toTxIdx]   = { ...updated[toTxIdx],   priority: fromPri };
    persistTransactions(updated);
  };

  if (pendingWaivers.length === 0) return null;

  return (
    <div style={{
      background: 'rgba(180,160,60,0.08)',
      border: '1px solid rgba(180,160,60,0.3)',
      borderRadius: 3, padding: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <h3 style={{ ...theme.label, color: 'rgba(220,200,80,0.9)', fontSize: 11 }}>
          ⏰ Pending Waiver Claims ({pendingWaivers.length})
        </h3>
        <span style={{ ...theme.smallText, color: 'rgba(220,200,80,0.6)' }}>Processed Tue 8pm ET</span>
      </div>
      {pendingWaivers.length > 1 && isOwnTeam && (
        <p style={{ ...theme.smallText, marginBottom: 8 }}>↕ Use arrows to set priority — #1 processes first</p>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {pendingWaivers.map((waiver, index) => (
          <div key={waiver._txIdx} style={{
            background: 'rgba(255,255,255,0.04)',
            borderRadius: 2, padding: '8px 10px',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            {isOwnTeam && pendingWaivers.length > 1 && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                <button onClick={() => swapPriority(index, index - 1)} disabled={index === 0}
                  style={{ background: 'none', border: 'none', cursor: index === 0 ? 'not-allowed' : 'pointer',
                    color: index === 0 ? colors.textMuted : 'rgba(220,200,80,0.8)', fontSize: 11, padding: '0 2px' }}>▲</button>
                <span style={{ fontSize: 10, color: 'rgba(220,200,80,0.8)', fontWeight: 700 }}>{index + 1}</span>
                <button onClick={() => swapPriority(index, index + 1)} disabled={index === pendingWaivers.length - 1}
                  style={{ background: 'none', border: 'none', cursor: index === pendingWaivers.length - 1 ? 'not-allowed' : 'pointer',
                    color: index === pendingWaivers.length - 1 ? colors.textMuted : 'rgba(220,200,80,0.8)', fontSize: 11, padding: '0 2px' }}>▼</button>
              </div>
            )}
            <div style={{ flex: 1 }}>
              <span style={{ color: colors.success, fontFamily: fonts.sans, fontSize: 12, fontWeight: 500 }}>Add: {waiver.player}</span>
              {waiver.droppedPlayer && (
                <>
                  <span style={{ color: colors.textMuted, margin: '0 4px' }}>→</span>
                  <span style={{ color: colors.danger, fontFamily: fonts.sans, fontSize: 12 }}>Drop: {waiver.droppedPlayer}</span>
                </>
              )}
              <div style={{ ...theme.smallText, marginTop: 2 }}>${waiver.fee} fee · {waiver.segment || 'Current Swing'}</div>
            </div>
            {isOwnTeam && (
              <div style={{ display: 'flex', gap: 4 }}>
                <button onClick={() => {
                  const newTx = transactions.filter((_, i) => i !== waiver._txIdx);
                  const newTeams = teams.map(t => t.id === team.id ? { ...t, transactionFees: (t.transactionFees || 0) - waiver.fee } : t);
                  persistTransactions(newTx);
                  updateTeams(newTeams);
                }} style={{ ...theme.btnSecondary, padding: '4px 8px', fontSize: 10 }}>✏️</button>
                <button onClick={async () => {
                  const ok = await dialog.showConfirm('Delete Waiver', `Delete waiver claim for ${waiver.player}?`, { type: 'danger', confirmText: 'Delete' });
                  if (!ok) return;
                  const newTx = transactions.filter((_, i) => i !== waiver._txIdx);
                  const newTeams = teams.map(t => t.id === team.id ? { ...t, transactionFees: (t.transactionFees || 0) - waiver.fee } : t);
                  persistTransactions(newTx);
                  updateTeams(newTeams);
                }} style={{ ...theme.btnDanger, padding: '4px 8px', fontSize: 10 }}>✕</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

// ── Main RostersView ──────────────────────────────────────────────────────────
// ── LineupHeadshot — shows ×-remove button on hover when editable ─────────────
const LineupHeadshot = ({ player, lastName, nameFontSize, headshots, canEdit, onRemove }) => {
  const [hovered, setHovered] = React.useState(false);
  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 56 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={{ position: 'relative', width: 44, height: 44 }}>
        <img
          src={getPlayerHeadshot(player.name, player.limited, headshots)}
          onError={makeHeadshotErrorHandler(player.name, player.limited, headshots)}
          alt=""
          style={{
            width: 44, height: 44, borderRadius: '50%', objectFit: 'cover',
            border: `2px solid ${playerBorderColor(player)}`,
            transition: 'opacity 0.15s',
            opacity: canEdit && hovered ? 0.55 : 1,
          }}
        />
        {canEdit && hovered && (
          <button
            onClick={e => { e.stopPropagation(); onRemove(); }}
            style={{
              position: 'absolute', top: -3, right: -3,
              width: 18, height: 18, borderRadius: '50%',
              background: 'rgba(220,60,60,0.92)',
              border: '1.5px solid rgba(255,255,255,0.25)',
              color: '#fff',
              fontSize: 11, fontWeight: 700, lineHeight: 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer',
              boxShadow: '0 2px 6px rgba(0,0,0,0.5)',
              padding: 0,
              zIndex: 10,
              transition: 'transform 0.1s',
            }}
            onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.15)'; }}
            onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; }}
            title={'Remove ' + player.name + ' from lineup'}
          >
            {'\u00D7'}
          </button>
        )}
        {player.limited && (player.stars || 1) > 0 && (
          <div style={{
            position: 'absolute', bottom: -4, left: '50%', transform: 'translateX(-50%)',
            background: 'rgba(15,25,45,0.88)', borderRadius: 6,
            padding: '0px 3px', lineHeight: 1, zIndex: 5,
            fontSize: 8, letterSpacing: 1,
          }}>
            {'⭐'.repeat(player.stars || 1)}
          </div>
        )}
      </div>
      <div style={{
        fontSize: nameFontSize, fontFamily: fonts.sans, marginTop: 3,
        textAlign: 'center', width: '100%',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        color: player.limited ? colors.textGold : player.unlimited ? 'rgba(100,140,220,0.9)' : colors.textPrimary,
      }}>
        {lastName}
      </div>
    </div>
  );
};

export const RostersView = ({
  teams, selectedTeam, setSelectedTeam, updateTeams,
  tournaments, allPlayers, transactions, setTransactions,
  settings, loggedInUser, isCommissioner, globalPlayerStats, headshots,
  firstTeeTime,
}) => {
  const isMobile            = useIsMobile();
  const [statsView,         setStatsView]         = useState('sfgl');
  const [lineupMode,        setLineupMode]        = useState(false);
  const [showAddDropModal,  setShowAddDropModal]  = useState(false);
  const [isWaiverMode,      setIsWaiverMode]      = useState(false);
  const [editingWaiverData, setEditingWaiverData] = useState(null);
  const [showMulliganModal, setShowMulliganModal] = useState(false);
  const [globalSearch,      setGlobalSearch]      = useState('');
  const dialog = useDialog();

  const activeTournament      = tournaments.find(t => t.playing);
  const activeTournamentIndex = activeTournament ? tournaments.findIndex(t => t.name === activeTournament.name) : -1;
  // ── Date-based tournament week resolution ────────────────────────────────
  // Add/drop/waiver belong to whichever tournament's week we're currently in,
  // based on calendar date — regardless of whether that tournament is "playing" yet.
  // Tournament dates format: "Feb 9-15" → startDate = Feb 9 (Mon of that week)
  // The add/drop window is Mon–Wed of that week (before Thursday tee time).
  // We search by date so late result processing by the commish doesn't shift the tag.
  const getAddDropTournamentIndex = () => {
    const parseStart = (t) => {
      if (!t?.dates) return null;
      const m = t.dates.match(/^([A-Za-z]+)\s+(\d+)/);
      if (!m) return null;
      const months = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
      const mo = months[m[1]];
      if (mo === undefined) return null;
      return new Date(2026, mo, parseInt(m[2]));
    };
    // ET now
    const etStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
    const now   = new Date(etStr);
    // Find the tournament whose window contains today.
    // Window = [startDate, startDate + 13] (full 2-week buffer so late processing is safe)
    let best = -1;
    tournaments.forEach((t, i) => {
      const start = parseStart(t);
      if (!start) return;
      const end = new Date(start); end.setDate(end.getDate() + 13);
      if (now >= start && now <= end) best = i;
    });
    if (best >= 0) return best;
    // Fallback: first upcoming non-completed tournament
    const upcoming = tournaments.findIndex(t => !t.completed);
    return upcoming >= 0 ? upcoming : Math.max(0, tournaments.length - 1);
  };
  const addDropTournamentIndex = getAddDropTournamentIndex();

  // Switch to the logged-in manager's team whenever loggedInUser changes (e.g. after login)
  const prevLoggedInUser = React.useRef(null);
  useEffect(() => {
    if (teams.length === 0) return;
    const userTeam = loggedInUser ? teams.find(t => t.owner === loggedInUser) : null;
    if (loggedInUser && loggedInUser !== prevLoggedInUser.current && userTeam) {
      // User just logged in — jump to their team
      setSelectedTeam(userTeam.id);
    } else if (!selectedTeam) {
      // No selection yet — default to user's team or first team
      setSelectedTeam(userTeam?.id ?? teams[0].id);
    }
    prevLoggedInUser.current = loggedInUser;
  }, [selectedTeam, teams, loggedInUser, setSelectedTeam]);

  const team          = teams.find(t => t.id === selectedTeam);
  const currentRoster = useRoster(team, transactions, activeTournamentIndex);
  const windowStatus  = useWindowStatus(activeTournament);
  const isOwnTeam     = (loggedInUser && team?.owner === loggedInUser) || isCommissioner;

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

  const togglePlayerInLineup = useCallback(async (player) => {
    if (!team) return;
    const isInLineup = team.lineup.includes(player.name);
    if (!isInLineup && team.lineup.length >= LINEUP_SIZE) {
      dialog.showToast(`You can only have ${LINEUP_SIZE} starters`, 'error'); return;
    }
    if (!isInLineup && player.limited && player.starts >= MAX_LIMITED_STARTS) {
      dialog.showToast('This player has reached their 12-start limit', 'error'); return;
    }
    const newTeams = teams.map(t => {
      if (t.id !== team.id) return t;
      const newLineup = isInLineup ? t.lineup.filter(p => p !== player.name) : [...t.lineup, player.name];
      return { ...t, lineup: newLineup };
    });
    updateTeams(newTeams);
    storage.set(STORAGE_KEYS.TEAMS, newTeams);
    sfglDataApi.set(STORAGE_KEYS.TEAMS, newTeams).catch(e => console.warn('Lineup sync failed:', e.message));
  }, [team, teams, updateTeams, dialog]);

  const handleMulliganConfirm = useCallback(({ playerOut, playerIn, afterRound, isSignatureOrMajor }) => {
    const mulliganKey   = isSignatureOrMajor ? 'signatureMajor' : 'regular';
    const newLineup     = team.lineup.map(p => p === playerOut ? playerIn : p);
    const updatedRoster = team.roster.map(p => {
      if (p.name === playerOut && p.limited) return { ...p, starts: Math.max(0, p.starts - 1) };
      if (p.name === playerIn  && p.limited) return { ...p, starts: p.starts + 1 };
      return p;
    });
    const newMulligans = { ...team.mulligans, [mulliganKey]: (team.mulligans?.[mulliganKey] || 1) - 1 };
    const newTeams = teams.map(t => t.id === team.id ? { ...t, lineup: newLineup, roster: updatedRoster, mulligans: newMulligans } : t);
    const newTx = {
      team: team.name, type: 'mulligan', player: playerIn, droppedPlayer: playerOut,
      fee: 0, segment: settings.currentSegment || '', date: new Date().toLocaleDateString(),
      tournamentIndex: activeTournamentIndex, status: 'completed',
      mulliganType: isSignatureOrMajor ? 'signature/major' : 'regular',
      afterRound, tournament: activeTournament.name,
    };
    updateTeams(newTeams);
    setTransactions(prev => [...prev, newTx]);
    storage.set(STORAGE_KEYS.TEAMS, newTeams);
    sfglDataApi.set(STORAGE_KEYS.TEAMS, newTeams).catch(e => console.warn('Mulligan sync failed:', e.message));
    // transaction saved via setTransactions -> storage via parent
    dialog.showToast(`Mulligan used: ${playerOut} → ${playerIn}`, 'success');
  }, [team, teams, updateTeams, setTransactions, activeTournament, activeTournamentIndex, settings, dialog]);

  const handleUndoMulligan = async (tx) => {
    const ok = await dialog.showConfirm('Undo Mulligan',
      `Undo mulligan?\n\nThis will restore ${tx.droppedPlayer} to your lineup and return ${tx.player} to the bench. Your mulligan will be restored.`,
      { confirmText: 'Undo Mulligan' });
    if (!ok) return;
    const newLineup     = team.lineup.map(p => p === tx.player ? tx.droppedPlayer : p);
    const updatedRoster = team.roster.map(p => {
      if (p.name === tx.player        && p.limited) return { ...p, starts: Math.max(0, p.starts - 1) };
      if (p.name === tx.droppedPlayer && p.limited) return { ...p, starts: p.starts + 1 };
      return p;
    });
    const mulliganKey  = tx.mulliganType === 'signature/major' ? 'signatureMajor' : 'regular';
    const newMulligans = { ...team.mulligans, [mulliganKey]: (team.mulligans?.[mulliganKey] || 0) + 1 };
    const newTeams = teams.map(t => t.id === team.id ? { ...t, lineup: newLineup, roster: updatedRoster, mulligans: newMulligans } : t);
    updateTeams(newTeams);
    setTransactions(prev => prev.filter(t => t !== tx));
    storage.set(STORAGE_KEYS.TEAMS, newTeams);
    sfglDataApi.set(STORAGE_KEYS.TEAMS, newTeams).catch(e => console.warn('Undo mulligan sync failed:', e.message));
    // transactions saved via setTransactions -> storage via parent
    dialog.showToast('Mulligan successfully undone', 'success');
  };

  const isSignatureOrMajor = activeTournament?.isSignature || activeTournament?.isMajor;
  const mulliganKey        = isSignatureOrMajor ? 'signatureMajor' : 'regular';
  const mulliganRemaining  = team?.mulligans?.[mulliganKey] ?? 0;
  const activeMulliganTx   = activeTournamentIndex >= 0
    ? transactions.find(tx => tx.type === 'mulligan' && tx.team === team?.name && tx.tournamentIndex === activeTournamentIndex)
    : null;
  const canUndoMulligan = activeMulliganTx && !isPastRoundStart(activeTournament, activeMulliganTx.afterRound + 1);

  const pendingWaivers = useMemo(() => {
    if (!team) return [];
    return transactions
      .map((t, idx) => ({ ...t, _txIdx: idx }))
      .filter(t => t.team === team.name && t.type === 'waiver' && t.status === 'pending')
      .sort((a, b) => (a.priority || 999) - (b.priority || 999));
  }, [team, transactions]);

  // Derive SFGL cuts per player per team from completed tournament results
  // sfglCutsMap: { playerName: { cuts, starts } }
  // Source: results.teams[teamId].players — each entry is a player who was in the
  // starting lineup for that tournament, with the earnings they contributed.
  // starts = appeared in lineup, cuts = appeared in lineup AND earned > $0
  const sfglCutsMap = useMemo(() => {
    const map = {};
    if (!team) return map;
    tournaments.forEach(t => {
      if (!t.completed || !t.results?.teams?.[team.id]) return;
      const players = t.results.teams[team.id].players || [];
      players.forEach(p => {
        const name = p.name || p;
        if (!map[name]) map[name] = { cuts: 0, starts: 0 };
        map[name].starts += 1;
        if ((p.earnings || 0) > 0) map[name].cuts += 1;
      });
    });
    return map;
  }, [team, tournaments]);

  if (!team) return null;

  const lineupOpen    = windowStatus.lineupOpen;
  const canEditLineup = isOwnTeam && (lineupOpen || isCommissioner);
  const faStatus      = getFreeAgentWindowStatus(activeTournament);
  const waiverStatus  = getWaiverWindowStatus();
  const lineupPlayers = currentRoster.filter(p => team.lineup.includes(p.name));
  const benchPlayers  = currentRoster.filter(p => !team.lineup.includes(p.name));

  const formatTeeTime = (date) => {
    if (!date) return '';
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const hours = date.getHours(); const minutes = date.getMinutes();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    return `${days[date.getDay()]} ${hours % 12 || 12}:${minutes.toString().padStart(2, '0')} ${ampm} ET`;
  };

  // ── Action button styles ──
  const actionBtn = (active, activeColor) => ({
    width: '100%', height: 56,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: '0 4px', borderRadius: 2,
    fontFamily: fonts.sans, fontSize: 11, fontWeight: 500,
    textAlign: 'center', cursor: active ? 'pointer' : 'not-allowed',
    transition: 'all 0.15s',
    background: 'rgba(255,255,255,0.03)',
    border: active
      ? `1px solid ${activeColor}`
      : `1px solid ${colors.borderSubtle}`,
    color: active ? activeColor : colors.textMuted,
  });

  const renderMulliganButton = () => {
    const etDay = new Date().getDay();
    const isMulliganDay = etDay >= 4 && etDay <= 6;
    let btnLabel, btnAction, isDisabled, activeColor;

    if (activeMulliganTx) {
      btnLabel = 'Undo Mull.'; activeColor = 'rgba(100,150,255,0.8)';
      if (canUndoMulligan) { btnAction = () => handleUndoMulligan(activeMulliganTx); isDisabled = false; }
      else { isDisabled = true; }
    } else {
      btnLabel = 'Mulligan'; activeColor = colors.textGoldDim; btnAction = () => setShowMulliganModal(true);
      isDisabled = mulliganRemaining === 0 || !isMulliganDay || !isOwnTeam || !activeTournament || team.lineup.length === 0;
    }

    return (
      <button onClick={isDisabled ? undefined : btnAction} disabled={isDisabled}
        style={actionBtn(!isDisabled, activeColor)}>
        {btnLabel}
      </button>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0, overflow: 'hidden' }}>
      {/* ── Team selector + lineup headshots ── */}
      <div style={{
        ...theme.card,
        padding: 12,
        background: 'linear-gradient(135deg, rgba(18,46,82,0.4) 0%, rgba(255,255,255,0.02) 100%)',
        overflow: 'visible',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, gap: 8, overflow: 'visible' }}>
          {/* Team selector */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
            <TeamDropdown
              teams={teams}
              value={selectedTeam || ''}
              onChange={id => { setSelectedTeam(id); setLineupMode(false); }}
            />
            {!loggedInUser && !isOwnTeam && (
              <span style={{ ...theme.badge, ...theme.badgeNavy }}>View Only</span>
            )}
            {isCommissioner && team && (
              <span style={{ ...theme.badge, background: 'rgba(80,195,120,0.1)', border: '1px solid rgba(80,195,120,0.3)', color: colors.success, fontSize: 10 }}>
                Acting as Commish
              </span>
            )}
          </div>

          {/* Global search */}
          <div style={{ position: 'relative', flexShrink: 0, width: 160 }}>
            <Search style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', width: 13, height: 13, color: colors.textSecondary }} />
            <input
              type="text" placeholder="Search player…"
              value={globalSearch} onChange={e => setGlobalSearch(e.target.value)}
              style={{ ...theme.input, paddingLeft: 28, fontSize: 12, padding: '7px 10px 7px 28px' }}
              onFocus={e => { e.target.style.borderColor = colors.borderFocus; }}
              onBlur={e => { e.target.style.borderColor = colors.borderInput; }}
            />
          </div>
        </div>

        {/* Lineup headshots */}
        <div style={{ borderTop: `1px solid ${colors.borderSubtle}`, paddingTop: 10, minHeight: 72, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {team.lineup.length > 0 ? (
            <div style={{ display: 'flex', justifyContent: 'center', gap: 16, width: '100%' }}>
              {getSortedRoster(currentRoster)
                .filter(p => team.lineup.includes(p.name))
                .map(player => {
                  const lastName  = player.name.split(' ').pop();
                  const nameFontSize = lastName.length > 9 ? 9 : lastName.length > 7 ? 10 : 11;
                  return (
                    <LineupHeadshot
                      key={player.name}
                      player={player}
                      lastName={lastName}
                      nameFontSize={nameFontSize}
                      headshots={headshots}
                      canEdit={canEditLineup}
                      onRemove={() => { if (!lineupMode) setLineupMode(true); togglePlayerInLineup(player); }}
                    />
                  );
                })}
            </div>
          ) : (
            <div style={{ ...theme.smallText, textAlign: 'center', width: '100%' }}>No lineup set</div>
          )}
        </div>
      </div>

      {/* ── Waiver queue ── */}
      <WaiverQueue
        team={team} pendingWaivers={pendingWaivers} transactions={transactions}
        setTransactions={setTransactions} updateTeams={updateTeams} teams={teams}
        isOwnTeam={isOwnTeam}
      />

      {/* ── Action buttons + roster table ── */}
      <div style={{ ...theme.card }}>

        {/* Action header */}
        <div style={{
          ...theme.cardHeader,
          flexDirection: 'column', alignItems: 'stretch', gap: 10,
        }}>
          {activeTournament && firstTeeTime && (
            <div style={{ overflow: 'hidden' }}>
              <span style={{ ...theme.smallText }}>· {formatTeeTime(firstTeeTime)}</span>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, minWidth: 0 }}>
            {/* Lineup button */}
            {(() => {
              const hasLineup = team.lineup.length > 0;
              const needsSubmit = canEditLineup && !hasLineup && !lineupMode;
              return (
                <button
                  onClick={() => { if (lineupMode && !hasLineup) return; setLineupMode(!lineupMode); }}
                  disabled={!canEditLineup || (lineupMode && !hasLineup)}
                  style={{
                    ...actionBtn(canEditLineup, colors.success),
                    border: canEditLineup ? `1px solid ${colors.success}` : `1px solid ${colors.borderSubtle}`,
                    background: needsSubmit ? 'rgba(80,195,120,0.15)' : 'rgba(255,255,255,0.03)',
                    boxShadow: needsSubmit ? '0 0 10px rgba(80,195,120,0.25)' : 'none',
                    fontWeight: needsSubmit ? 700 : 500,
                  }}
                >
                  {lineupMode ? '✓ Save' : hasLineup ? '✏ Edit Lineup' : '▶ Set Lineup'}
                </button>
              );
            })()}

            {/* Free agent button */}
            <button
              onClick={() => { setIsWaiverMode(false); setShowAddDropModal(true); }}
              disabled={!isOwnTeam}
              style={actionBtn(isOwnTeam, 'rgba(220,200,80,0.8)')}
            >
              Free Agent
            </button>

            {/* Waiver button */}
            <button
              onClick={() => { setIsWaiverMode(true); setShowAddDropModal(true); }}
              disabled={!isOwnTeam}
              style={actionBtn(isOwnTeam, 'rgba(220,200,80,0.8)')}
            >
              Waiver
            </button>
          </div>
        </div>

        {/* ── Player table — global search ── */}
        {globalSearch.trim().length > 0 ? (
          <div>
            <div style={{
              ...theme.tableHeaderCell,
              padding: '8px 16px',
              borderBottom: `1px solid ${colors.borderSubtle}`,
              color: colors.textSecondary,
              fontSize: 11,
            }}>
              Search Results ({searchResults.length})
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }} role="table">
              <colgroup>
                <col />
                <col style={{ width: isMobile ? 60 : 70 }} />
                <col style={{ width: isMobile ? 60 : 70 }} />
                <col style={{ width: isMobile ? 80 : 100 }} />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col" style={{ ...theme.tableHeaderCell, textAlign: 'left' }}>Player</th>
                  <th scope="col" style={{ ...theme.tableHeaderCell, textAlign: 'center' }}>Events</th>
                  <th scope="col" style={{ ...theme.tableHeaderCell, textAlign: 'center' }}>Cuts</th>
                  <th scope="col" style={{ ...theme.tableHeaderCell, textAlign: 'right' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {searchResults.slice(0, 50).map(player => (
                  <tr key={player.name}
                    style={{ borderBottom: `1px solid ${colors.borderSubtle}`, transition: 'background 0.15s' }}
                    onMouseEnter={e => { e.currentTarget.style.background = colors.rowHover; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <td style={{ padding: isMobile ? '8px 10px' : '8px 16px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <img
                          src={getPlayerHeadshot(player.name, player.limited, headshots)}
                          onError={makeHeadshotErrorHandler(player.name, player.limited, headshots)}
                          alt="" style={{ width: 28, height: 28, borderRadius: '50%', objectFit: 'cover', border: `1px solid ${colors.borderSubtle}`, flexShrink: 0 }}
                        />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontFamily: fonts.sans, fontSize: isMobile ? 12 : 12, color: colors.textPrimary, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{player.name}</div>
                          <div style={theme.smallText}>#{player.worldRank === 999 ? 'NR' : player.worldRank}</div>
                        </div>
                      </div>
                    </td>
                    <td style={{ padding: isMobile ? '8px 4px' : '8px 16px', textAlign: 'center', ...theme.bodyText }}>{globalPlayerStats[player.name]?.eventsPlayed || 0}</td>
                    <td style={{ padding: isMobile ? '8px 4px' : '8px 16px', textAlign: 'center', ...theme.bodyText }}>{globalPlayerStats[player.name]?.cutsMade || 0}</td>
                    <td style={{ padding: isMobile ? '8px 10px 8px 4px' : '8px 16px', textAlign: 'right' }}>
                      {player.owner === 'Free Agent'
                        ? <span style={{ color: colors.success, fontFamily: fonts.sans, fontSize: isMobile ? 11 : 12, fontWeight: 500 }}>FA</span>
                        : <span style={{ ...theme.bodyText, fontWeight: 500, fontSize: isMobile ? 11 : 12 }}>{getTeamAbbreviation(player.owner)}</span>}
                    </td>
                  </tr>
                ))}
                {searchResults.length === 0 && (
                  <tr><td colSpan="4" style={theme.emptyState}>No matching players found</td></tr>
                )}
              </tbody>
            </table>
          </div>

        ) : (
          /* ── Roster table ── */
          <>
          {/* On mobile: slider sits above table as its own row */}
          {isMobile && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '6px 10px 2px', borderBottom: `1px solid ${colors.borderSubtle}` }}>
              <div style={{
                position: 'relative', display: 'flex',
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(180,160,100,0.2)',
                borderRadius: 4, padding: 2, width: 88,
              }}>
                <div style={{
                  position: 'absolute', top: 2, bottom: 2,
                  left: statsView === 'pgat' ? 'calc(50% + 1px)' : 2,
                  width: 'calc(50% - 3px)', borderRadius: 2,
                  background: statsView === 'sfgl' ? 'rgba(245,197,24,0.12)' : 'rgba(100,180,255,0.12)',
                  border: `1px solid ${statsView === 'sfgl' ? 'rgba(245,197,24,0.45)' : 'rgba(100,180,255,0.45)'}`,
                  transition: 'left 0.22s cubic-bezier(0.4,0,0.2,1)', pointerEvents: 'none',
                }} />
                <button onClick={() => setStatsView('sfgl')} style={{ flex: 1, position: 'relative', zIndex: 1, padding: '3px 0', background: 'none', border: 'none', fontFamily: fonts.sans, fontSize: 10, fontWeight: 700, letterSpacing: '0.8px', textTransform: 'uppercase', color: statsView === 'sfgl' ? colors.textGold : colors.textMuted, cursor: 'pointer' }}>SFGL</button>
                <button onClick={() => setStatsView('pgat')} style={{ flex: 1, position: 'relative', zIndex: 1, padding: '3px 0', background: 'none', border: 'none', fontFamily: fonts.sans, fontSize: 10, fontWeight: 700, letterSpacing: '0.8px', textTransform: 'uppercase', color: statsView === 'pgat' ? 'rgba(100,180,255,0.95)' : colors.textMuted, cursor: 'pointer' }}>PGAT</button>
              </div>
            </div>
          )}
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }} role="table">
            <colgroup>
              <col />
              <col style={{ width: isMobile ? 48 : 80 }} />
              <col style={{ width: isMobile ? 62 : 90 }} />
              <col style={{ width: isMobile ? 68 : 120 }} />
            </colgroup>
            <thead>
              <tr>
                <th scope="col" style={{ ...theme.tableHeaderCell, textAlign: 'left' }}>Player</th>
                <th scope="col" style={{ ...theme.tableHeaderCell, textAlign: 'center', whiteSpace: 'nowrap' }}>
                  {statsView === 'sfgl' ? 'Starts' : 'Events'}
                </th>
                <th scope="col" style={{ ...theme.tableHeaderCell, textAlign: 'center', whiteSpace: 'nowrap' }}>
                  {isMobile ? 'Cuts' : 'Cuts Made'}
                </th>
                <th scope="col" style={{ ...theme.tableHeaderCell, textAlign: isMobile ? 'center' : 'right', paddingRight: isMobile ? 10 : 8 }}>
                  {!isMobile && (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
                      <div style={{
                        position: 'relative', display: 'flex',
                        background: 'rgba(255,255,255,0.04)',
                        border: '1px solid rgba(180,160,100,0.2)',
                        borderRadius: 4, padding: 2, width: 96, flexShrink: 0,
                      }}>
                        <div style={{
                          position: 'absolute', top: 2, bottom: 2,
                          left: statsView === 'pgat' ? 'calc(50% + 1px)' : 2,
                          width: 'calc(50% - 3px)', borderRadius: 2,
                          background: statsView === 'sfgl' ? 'rgba(245,197,24,0.12)' : 'rgba(100,180,255,0.12)',
                          border: `1px solid ${statsView === 'sfgl' ? 'rgba(245,197,24,0.45)' : 'rgba(100,180,255,0.45)'}`,
                          transition: 'left 0.22s cubic-bezier(0.4,0,0.2,1)', pointerEvents: 'none',
                        }} />
                        <button onClick={() => setStatsView('sfgl')} style={{ flex: 1, position: 'relative', zIndex: 1, padding: '3px 0', background: 'none', border: 'none', fontFamily: fonts.sans, fontSize: 10, fontWeight: 700, letterSpacing: '0.8px', textTransform: 'uppercase', color: statsView === 'sfgl' ? colors.textGold : colors.textMuted, cursor: 'pointer', transition: 'color 0.18s' }}>SFGL</button>
                        <button onClick={() => setStatsView('pgat')} style={{ flex: 1, position: 'relative', zIndex: 1, padding: '3px 0', background: 'none', border: 'none', fontFamily: fonts.sans, fontSize: 10, fontWeight: 700, letterSpacing: '0.8px', textTransform: 'uppercase', color: statsView === 'pgat' ? 'rgba(100,180,255,0.95)' : colors.textMuted, cursor: 'pointer', transition: 'color 0.18s' }}>PGAT</button>
                      </div>
                    </div>
                  )}
                  {isMobile && <span style={{ fontFamily: fonts.sans, fontSize: 10, color: colors.textMuted, letterSpacing: '0.5px', textTransform: 'uppercase', display: 'block', textAlign: 'center' }}>$</span>}
                </th>
              </tr>
            </thead>
            <tbody>
              {getSortedRoster(currentRoster).map(player => {
                const isInLineup     = team.lineup.includes(player.name);
                const canAddToLineup = team.lineup.length < LINEUP_SIZE && (!player.limited || player.starts < MAX_LIMITED_STARTS);
                const hasLineup      = team.lineup.length > 0;
                const isBenched      = hasLineup && !isInLineup && !lineupMode;
                const dimColor       = 'rgba(255,255,255,0.45)';

                return (
                  <tr key={player.name}
                    style={{ borderBottom: `1px solid ${colors.borderSubtle}`, background: 'transparent', transition: 'background 0.15s' }}
                    onMouseEnter={e => { if (!isBenched) e.currentTarget.style.background = colors.rowHover; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    {/* Player cell */}
                    <td style={{ padding: isMobile ? '7px 10px' : '8px 16px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 6 : 8, minWidth: 0 }}>
                        {/* Headshot / lineup toggle */}
                        <button
                          onClick={() => lineupMode && isOwnTeam && (isInLineup || canAddToLineup) && togglePlayerInLineup(player)}
                          disabled={!lineupMode || !isOwnTeam || (!isInLineup && !canAddToLineup)}
                          style={{ position: 'relative', background: 'none', border: 'none', cursor: lineupMode && isOwnTeam && (isInLineup || canAddToLineup) ? 'pointer' : 'default', padding: 0, width: 30, height: 30, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                        >
                          <img
                            src={getPlayerHeadshot(player.name, player.limited, headshots)}
                            onError={makeHeadshotErrorHandler(player.name, player.limited, headshots)}
                            alt=""
                            style={{
                              width: 30, height: 30, borderRadius: '50%', objectFit: 'cover',
                              opacity: isBenched ? 0.5 : lineupMode && !isInLineup && !canAddToLineup ? 0.25 : lineupMode && !isInLineup ? 0.55 : 1,
                              border: lineupMode
                                ? isInLineup
                                  ? `3px solid ${playerBorderColor(player)}`
                                  : `2px solid ${colors.borderSubtle}`
                                : isInLineup
                                  ? `2px solid ${playerBorderColor(player)}`
                                  : `1px solid ${colors.borderSubtle}`,
                              transition: 'all 0.15s',
                            }}
                          />
                          {isInLineup && (
                            <div style={{
                              position: 'absolute', top: -3, right: -3,
                              width: 14, height: 14, borderRadius: '50%',
                              background: lineupMode ? playerBorderColor(player) : 'rgba(80,195,120,0.85)',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              opacity: lineupMode ? 1 : 0.75,
                            }}>
                              <span style={{ color: '#111d2e', fontSize: 9, fontWeight: 900 }}>✓</span>
                            </div>
                          )}
                          {player.limited && (player.stars || 1) > 0 && (
                            <div style={{
                              position: 'absolute', bottom: -4, left: '50%', transform: 'translateX(-50%)',
                              background: 'rgba(15,25,45,0.88)', borderRadius: 6,
                              padding: '0px 3px', lineHeight: 1, zIndex: 5,
                              fontSize: 7, letterSpacing: 0.5,
                              pointerEvents: 'none',
                              opacity: isBenched ? 0.35 : 1,
                            }}>
                              {'⭐'.repeat(player.stars || 1)}
                            </div>
                          )}
                        </button>

                        {/* Name + metadata */}
                        <div style={{ minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                            <span style={{
                              fontFamily: fonts.sans, fontSize: isMobile ? 13 : 12, fontWeight: 500,
                              color: isBenched ? dimColor : player.limited ? colors.textGold : player.unlimited ? 'rgba(100,140,220,0.9)' : colors.textPrimary,
                            }}>
                              {displayName(player.name, isMobile)}
                            </span>
                            {player.limited && (
                              <span style={{
                                fontFamily: fonts.sans, fontSize: 10, fontWeight: 600,
                                color: isBenched ? dimColor : colors.textGoldDim,
                              }}>
                                {player.starts}/{MAX_LIMITED_STARTS}
                              </span>
                            )}
                            {player.unlimited && (
                              <span style={{ fontSize: 10, color: isBenched ? dimColor : 'rgba(100,140,220,0.9)' }}>♾️</span>
                            )}
                          </div>
                          <div style={{ fontSize: 10, fontFamily: fonts.sans, color: isBenched ? 'rgba(255,255,255,0.35)' : colors.textMuted }}>
                            {player.yearsOfService > 1 && <span>(Yr {player.yearsOfService})</span>}
                          </div>
                        </div>
                      </div>
                    </td>

                    {/* Events / Starts */}
                    {(() => {
                      const events = statsView === 'sfgl' ? (sfglCutsMap[player.name]?.starts ?? player.starts ?? 0) : (globalPlayerStats[player.name]?.eventsPlayed || 0);
                      return (
                        <td style={{ padding: isMobile ? '7px 6px' : '8px 16px', textAlign: 'center', fontFamily: fonts.sans, fontSize: isMobile ? 13 : 12, color: isBenched ? dimColor : colors.textSecondary }}>
                          {events}
                        </td>
                      );
                    })()}

                    {/* Cuts Made (X/Y fraction) */}
                    {(() => {
                      const sfglEntry = sfglCutsMap[player.name] || { cuts: 0, starts: 0 };
                      const cuts   = statsView === 'sfgl' ? sfglEntry.cuts : (globalPlayerStats[player.name]?.cutsMade || 0);
                      const events = statsView === 'sfgl' ? sfglEntry.starts : (globalPlayerStats[player.name]?.eventsPlayed || 0);
                      return (
                        <td style={{ padding: isMobile ? '7px 4px' : '8px 16px', textAlign: 'center', fontFamily: fonts.sans, fontSize: isMobile ? 12 : 12, color: isBenched ? dimColor : colors.textSecondary }}>
                          {cuts}/{events}
                        </td>
                      );
                    })()}

                    {/* $ — SFGL earnings or PGA Tour earnings depending on mode */}
                    {(() => {
                      const amount  = statsView === 'sfgl' ? (player.sfglEarnings || 0) : (globalPlayerStats[player.name]?.pgaTourEarnings || 0);
                      const posColor = statsView === 'sfgl' ? colors.earningsGreen : colors.earningsGreenLight;
                      return (
                        <td style={{ padding: isMobile ? '7px 8px 7px 4px' : '8px 16px', textAlign: 'right', ...theme.statNum, fontSize: isMobile ? 12 : 12, fontWeight: 600, color: isBenched ? dimColor : (amount > 0 ? posColor : colors.textMuted) }}>
                          ${amount.toLocaleString()}
                        </td>
                      );
                    })()}
                  </tr>
                );
              })}
            </tbody>
          </table>
          </>
        )}
      </div>

      {/* ── Modals ── */}
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
        nextTournamentIndex={addDropTournamentIndex}
        editingWaiverData={editingWaiverData}
      />
    </div>
  );
};
