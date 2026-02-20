import { useState, useEffect } from 'react';
import { X, Search, RotateCcw, Flag } from 'lucide-react';
import { draftStateApi } from '../api';
import { useDialog } from './DialogContext';
import { theme, colors, fonts } from '../theme.js';

// ── Shared modal shell ────────────────────────────────────────────────────────
const Shell = ({ children, wide }) => (
  <div style={{
    position: 'fixed', inset: 0,
    background: 'rgba(5,10,25,0.88)', backdropFilter: 'blur(6px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 16, zIndex: 50,
  }}>
    <div style={{
      background: '#0d1e38',
      border: `1px solid ${colors.border}`,
      borderRadius: 4,
      maxWidth: wide ? 780 : 560,
      width: '100%',
      maxHeight: '88vh',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
      boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
    }}>
      {children}
    </div>
  </div>
);

const ModalHeader = ({ title, sub, badge, onClose }) => (
  <div style={{
    padding: '18px 22px',
    borderBottom: `1px solid ${colors.borderSubtle}`,
    background: 'linear-gradient(90deg, rgba(26,51,102,0.5) 0%, transparent 100%)',
    flexShrink: 0,
  }}>
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
      <div>
        <h2 style={theme.h1}>{title}</h2>
        {sub && <p style={{ ...theme.bodyText, marginTop: 4 }}>{sub}</p>}
        {badge && (
          <p style={{ fontFamily: fonts.sans, fontSize: 11, color: 'rgba(100,160,255,0.7)', marginTop: 4 }}>
            💾 Draft auto-saves — close and resume anytime
          </p>
        )}
      </div>
      <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.textSecondary, marginLeft: 12, flexShrink: 0 }}>
        <X style={{ width: 18, height: 18 }} />
      </button>
    </div>
  </div>
);

const ModalFooter = ({ children }) => (
  <div style={{
    padding: '14px 22px',
    borderTop: `1px solid ${colors.borderSubtle}`,
    background: 'rgba(5,10,20,0.4)',
    flexShrink: 0,
  }}>
    {children}
  </div>
);

const Btn = ({ onClick, children, variant = 'primary', disabled, style }) => {
  const base = variant === 'danger'    ? theme.btnDanger
             : variant === 'secondary' ? theme.btnSecondary
             : theme.btnPrimary;
  return (
    <button onClick={onClick} disabled={disabled} style={{
      ...base, padding: '10px 20px', opacity: disabled ? 0.4 : 1, ...style,
    }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.opacity = '0.8'; }}
      onMouseLeave={e => { e.currentTarget.style.opacity = disabled ? '0.4' : '1'; }}
    >
      {children}
    </button>
  );
};

// ── Player row (used in keeper search + draft list) ───────────────────────────
const PlayerRow = ({ player, onSelect, accentColor, label, getHeadshot }) => (
  <button
    onClick={() => onSelect(player)}
    style={{
      width: '100%', display: 'flex', alignItems: 'center', gap: 12,
      padding: '10px 14px', background: 'none', border: 'none', cursor: 'pointer',
      borderBottom: `1px solid ${colors.borderSubtle}`, textAlign: 'left',
      transition: 'background 0.15s',
    }}
    onMouseEnter={e => { e.currentTarget.style.background = colors.rowHover; }}
    onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}
  >
    <img
      src={getHeadshot(player.name)}
      onError={e => { e.target.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(player.name)}&background=0d1e38&color=6b7280&size=64`; }}
      alt=""
      style={{ width: 40, height: 40, borderRadius: '50%', objectFit: 'cover', border: `2px solid ${accentColor}`, flexShrink: 0 }}
    />
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontFamily: fonts.serif, fontSize: 13, color: colors.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{player.name}</div>
      <div style={theme.smallText}>Rank: {player.worldRank === 999 ? 'NR' : `#${player.worldRank}`}</div>
    </div>
    <span style={{ ...theme.label, color: accentColor, flexShrink: 0 }}>{label}</span>
  </button>
);

// ── Search input ──────────────────────────────────────────────────────────────
const SearchInput = ({ value, onChange, placeholder, autoFocus }) => (
  <div style={{ position: 'relative' }}>
    <Search style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', width: 14, height: 14, color: colors.textSecondary }} />
    <input
      type="text" value={value} onChange={onChange}
      placeholder={placeholder} autoFocus={autoFocus}
      style={{ ...theme.input, paddingLeft: 36 }}
      onFocus={e => { e.target.style.borderColor = colors.borderFocus; e.target.style.background = colors.inputBgFocus; }}
      onBlur={e => { e.target.style.borderColor = colors.borderInput; e.target.style.background = colors.inputBg; }}
    />
  </div>
);

// ── KeeperBox — defined outside DraftModal to prevent focus loss on re-render ──
const KeeperBox = ({ type, label, accentColor, searchVal, setSearch, searchResults, selectLabel, selected, onClear, onSelect, onStars, getHeadshot }) => (
  <div style={{ background: `${accentColor}0d`, border: `1px solid ${accentColor}40`, borderRadius: 3, padding: 16 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
      <div style={{
        width: 28, height: 28, borderRadius: 2,
        background: `${accentColor}25`, border: `1px solid ${accentColor}50`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: fonts.serif, fontSize: 13, color: accentColor, fontWeight: 700,
      }}>
        {type === 'limited' ? 'L' : '∞'}
      </div>
      <span style={{ fontFamily: fonts.serif, fontSize: 14, color: accentColor }}>{label}</span>
      {selected && (
        <button onClick={onClear}
          style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: colors.danger, fontFamily: fonts.sans, fontSize: 11, fontWeight: 600 }}>
          Clear
        </button>
      )}
    </div>

    {selected ? (
      <div>
        <div style={{
          background: 'rgba(255,255,255,0.05)', border: `1px solid ${colors.borderSubtle}`,
          borderRadius: 2, padding: '10px 14px',
          fontFamily: fonts.serif, fontSize: 13, color: colors.textPrimary,
        }}>
          {selected.name}
        </div>
        {type === 'limited' && onStars && (
          <div style={{ marginTop: 10 }}>
            <div style={{ ...theme.label, marginBottom: 6 }}>Years of Service</div>
            <div style={{ display: 'flex', gap: 6 }}>
              {[1, 2, 3].map(num => (
                <button key={num}
                  onClick={() => onStars(selected.name, num)}
                  style={{
                    width: 36, height: 36, borderRadius: 2, fontSize: 18, cursor: 'pointer',
                    background: num <= selected.stars ? `${accentColor}30` : 'rgba(255,255,255,0.04)',
                    border: `1px solid ${num <= selected.stars ? accentColor : colors.borderSubtle}`,
                    color: num <= selected.stars ? accentColor : colors.textMuted,
                    transition: 'all 0.15s',
                  }}
                >★</button>
              ))}
            </div>
          </div>
        )}
      </div>
    ) : (
      <>
        <SearchInput value={searchVal} onChange={e => setSearch(e.target.value)} placeholder={`Search ${label} player…`} />
        <div style={{ marginTop: 8, height: 128, overflowY: 'auto', border: `1px solid ${colors.borderSubtle}`, borderRadius: 2, background: 'rgba(0,0,0,0.2)' }}>
          {searchVal.trim() ? (
            searchResults.length > 0
              ? searchResults.map(player => (
                  <PlayerRow key={player.name} player={player}
                    onSelect={onSelect}
                    accentColor={accentColor} label={selectLabel} getHeadshot={getHeadshot} />
                ))
              : <div style={theme.emptyState}>No players found</div>
          ) : (
            <div style={{ ...theme.emptyState, paddingTop: 28 }}>Type to search…</div>
          )}
        </div>
      </>
    )}
  </div>
);

// ── Main DraftModal ───────────────────────────────────────────────────────────
export const DraftModal = ({ teams, allPlayers, updateTeams, onClose, headshots = {}, initialPhase }) => {
  const [phase, setPhase]                     = useState('resume_prompt'); // 'resume_prompt','order','keepers','draft'
  const [hasSavedState, setHasSavedState]     = useState(false);
  const [draftOrder, setDraftOrder]           = useState(teams.map((t, i) => ({ ...t, order: i })));
  const [keeperTeamIndex, setKeeperTeamIndex] = useState(0);
  const [keepers, setKeepers]                 = useState({});
  const [currentTeamIndex, setCurrentTeamIndex] = useState(0);
  const [currentRound, setCurrentRound]       = useState(1);
  const [draftedPlayers, setDraftedPlayers]   = useState([]);
  const [pickHistory, setPickHistory]         = useState([]); // [{teamId, playerName, round, teamIndex, isLimited}]
  const [searchQuery, setSearchQuery]         = useState('');
  const [limitedSearch, setLimitedSearch]     = useState('');
  const [unlimitedSearch, setUnlimitedSearch] = useState('');
  const [draggedIndex, setDraggedIndex]       = useState(null);
  const [confirmDraft, setConfirmDraft]       = useState(null);
  const dialog = useDialog();

  // ── On mount: use initialPhase from parent if provided ──
  useEffect(() => {
    if (initialPhase === 'order') {
      // Parent already cleared draft, go straight to order
      setPhase('order');
      initKeepers();
      return;
    }
    // Default: check for saved state
    const checkSaved = async () => {
      try {
        const savedState = await draftStateApi.get();
        if (savedState && savedState.draft_order?.length === teams.length && savedState.phase !== 'order') {
          setHasSavedState(true);
          setPhase('resume_prompt');
        } else {
          setPhase('order');
          initKeepers();
        }
      } catch {
        setPhase('order');
        initKeepers();
      }
    };
    checkSaved();
  }, []);

  const initKeepers = () => {
    const init = {};
    teams.forEach(t => { init[t.id] = { limited: null, unlimited: null }; });
    setKeepers(init);
  };

  // ── Resume saved draft ──
  const handleResume = async () => {
    try {
      const savedState = await draftStateApi.get();
      if (savedState) {
        setPhase(savedState.phase || 'order');
        setDraftOrder(savedState.draft_order || draftOrder);
        setKeeperTeamIndex(savedState.keeper_team_index || 0);
        setKeepers(savedState.keepers || {});
        setCurrentTeamIndex(savedState.current_team_index || 0);
        setCurrentRound(savedState.current_round || 1);
        setDraftedPlayers(savedState.drafted_players || []);
        setPickHistory(savedState.pick_history || []);
      }
    } catch (e) {
      console.error('Failed to restore draft state:', e);
    }
  };

  // ── Start fresh ──
  const handleStartNew = async () => {
    await clearDraftState();
    initKeepers();
    setDraftOrder(teams.map((t, i) => ({ ...t, order: i })));
    setKeeperTeamIndex(0); setCurrentTeamIndex(0); setCurrentRound(1);
    setDraftedPlayers([]); setPickHistory([]);
    setPhase('order');
  };

  // ── Auto-save on state change ──
  useEffect(() => {
    if (phase === 'order' || phase === 'resume_prompt') return;
    const save = async () => {
      try {
        await draftStateApi.save({
          phase, draftOrder, keeperTeamIndex, keepers,
          currentTeamIndex, currentRound, draftedPlayers, pick_history: pickHistory,
        });
      } catch (e) { console.error('Failed to save draft state:', e); }
    };
    save();
  }, [phase, draftOrder, keeperTeamIndex, keepers, currentTeamIndex, currentRound, draftedPlayers, pickHistory]);

  const clearDraftState = async () => {
    try { await draftStateApi.clear(); } catch { /* ignore */ }
  };

  const handleClose = async () => {
    if (phase === 'draft' && draftedPlayers.length > 0) {
      const save = await dialog.showConfirm(
        'Close Draft',
        'Save progress so you can resume later?',
        { confirmText: 'Save & Close', cancelText: 'Discard & Close' },
      );
      if (!save) await clearDraftState();
    }
    onClose();
  };

  // ── End Draft ──
  const handleEndDraft = async () => {
    const confirmed = await dialog.showConfirm(
      '🏁 End Draft',
      `End the draft now? All picks so far will be saved to team rosters. Teams that haven't finished drafting will keep whatever they have.\n\n${draftedPlayers.length} picks made across ${pickHistory.length > 0 ? new Set(pickHistory.map(p => p.teamId)).size : 0} teams.`,
      { confirmText: 'End Draft & Save Rosters', cancelText: 'Keep Drafting' },
    );
    if (!confirmed) return;
    await clearDraftState();
    onClose();
  };

  // ── Headshots ──
  const getPlayerHeadshot = (playerName) => {
    let id = headshots[playerName];
    if (!id) { const p = allPlayers.find(p => p.name === playerName); id = p?.pgaTourId; }
    if (id) return `https://pga-tour-res.cloudinary.com/image/upload/c_thumb,g_face,z_0.7,q_auto,f_auto,dpr_2.0,w_96,h_96/headshots_${id}`;
    return `https://ui-avatars.com/api/?name=${encodeURIComponent(playerName)}&background=0d1e38&color=6b7280&size=128`;
  };

  const currentTeam = phase === 'order' || phase === 'resume_prompt'
    ? null
    : draftOrder[phase === 'keepers' ? keeperTeamIndex : currentTeamIndex];
  const currentKeeper = keepers[currentTeam?.id] || { limited: null, unlimited: null };

  const allKeeperNames = () => Object.values(keepers).flatMap(k => [k.limited?.name, k.unlimited?.name].filter(Boolean));

  const availablePlayers = allPlayers
    .filter(p => !allKeeperNames().includes(p.name))
    .filter(p => !draftedPlayers.includes(p.name))
    .filter(p => p.name.toLowerCase().includes(searchQuery.toLowerCase()))
    .slice(0, 50);

  const limitedSearchResults  = allPlayers.filter(p => !allKeeperNames().includes(p.name) && p.name.toLowerCase().includes(limitedSearch.toLowerCase())).slice(0, 10);
  const unlimitedSearchResults = allPlayers.filter(p => !allKeeperNames().includes(p.name) && p.name.toLowerCase().includes(unlimitedSearch.toLowerCase())).slice(0, 10);

  // ── Draft order drag ──
  const moveDraftOrder = (fromIndex, dir) => {
    const toIndex = fromIndex + dir;
    if (toIndex < 0 || toIndex >= draftOrder.length) return;
    const newOrder = [...draftOrder];
    [newOrder[fromIndex], newOrder[toIndex]] = [newOrder[toIndex], newOrder[fromIndex]];
    setDraftOrder(newOrder);
  };
  const handleDragStart = (i) => setDraggedIndex(i);
  const handleDragOver = (e, i) => {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === i) return;
    const newOrder = [...draftOrder];
    const item = newOrder[draggedIndex];
    newOrder.splice(draggedIndex, 1);
    newOrder.splice(i, 0, item);
    setDraftOrder(newOrder);
    setDraggedIndex(i);
  };
  const handleDragEnd = () => setDraggedIndex(null);

  // ── Keepers ──
  const handleKeeperSelect = (playerName, type, stars = 1) => {
    const updated = { ...keepers };
    if (!updated[currentTeam.id]) updated[currentTeam.id] = { limited: null, unlimited: null };
    if (type === 'limited')  updated[currentTeam.id].limited  = playerName ? { name: playerName, stars } : null;
    else                     updated[currentTeam.id].unlimited = playerName ? { name: playerName } : null;
    setKeepers(updated);
    setLimitedSearch(''); setUnlimitedSearch('');
  };

  const handleNextTeamKeepers = () => {
    if (keeperTeamIndex < draftOrder.length - 1) {
      setKeeperTeamIndex(keeperTeamIndex + 1);
    } else {
      // Commit keepers to rosters
      const updatedTeams = teams.map(team => {
        const tk = keepers[team.id]; const newRoster = [];
        if (tk?.limited)   newRoster.push({ name: tk.limited.name,   stars: tk.limited.stars, starts: 0, limited: true,  unlimited: false, eventsPlayed: 0, cutsMade: 0, sfglEarnings: 0, pgaTourEarnings: 0, headshot: '' });
        if (tk?.unlimited) newRoster.push({ name: tk.unlimited.name, stars: 0,                starts: 0, limited: false, unlimited: true,  eventsPlayed: 0, cutsMade: 0, sfglEarnings: 0, pgaTourEarnings: 0, headshot: '' });
        return { ...team, roster: newRoster };
      });
      const keeperNames = allKeeperNames();
      updateTeams(updatedTeams);
      setDraftedPlayers(keeperNames);
      setPhase('draft'); setCurrentRound(1);
    }
  };

  // ── Draft pick ──
  const handleDraftPlayer = (playerName) => {
    setConfirmDraft({ playerName, type: currentRound <= 2 ? 'limited' : 'unlimited' });
  };

  const confirmDraftPlayer = () => {
    const { playerName } = confirmDraft;
    const isLimitedRound = currentRound <= 2;

    const updatedTeams = teams.map(team => {
      if (team.id !== currentTeam.id) return team;
      return { ...team, roster: [...team.roster, { name: playerName, stars: isLimitedRound ? 1 : 0, starts: 0, limited: isLimitedRound, unlimited: false, eventsPlayed: 0, cutsMade: 0, sfglEarnings: 0, pgaTourEarnings: 0, headshot: '' }] };
    });

    // Record pick for undo
    const pick = { teamId: currentTeam.id, playerName, round: currentRound, teamIndex: currentTeamIndex, isLimited: isLimitedRound };
    setPickHistory(prev => [...prev, pick]);
    setDraftedPlayers(prev => [...prev, playerName]);
    updateTeams(updatedTeams);

    // Advance snake draft
    const isSnake = currentRound % 2 === 0;
    if (isSnake) {
      if (currentTeamIndex === 0)       { setCurrentRound(r => r + 1); setCurrentTeamIndex(0); }
      else                               setCurrentTeamIndex(i => i - 1);
    } else {
      if (currentTeamIndex === draftOrder.length - 1) { setCurrentRound(r => r + 1); setCurrentTeamIndex(draftOrder.length - 1); }
      else                                              setCurrentTeamIndex(i => i + 1);
    }
    setSearchQuery(''); setConfirmDraft(null);
  };

  // ── Undo last pick ──
  const handleUndo = () => {
    if (pickHistory.length === 0) return;
    const last = pickHistory[pickHistory.length - 1];

    // Remove player from that team's roster
    const updatedTeams = teams.map(team => {
      if (team.id !== last.teamId) return team;
      return { ...team, roster: team.roster.filter(p => p.name !== last.playerName) };
    });
    updateTeams(updatedTeams);
    setDraftedPlayers(prev => prev.filter(n => n !== last.playerName));
    setPickHistory(prev => prev.slice(0, -1));
    setCurrentRound(last.round);
    setCurrentTeamIndex(last.teamIndex);
  };

  const maxRounds    = 12;
  const isDraftComplete = currentRound > maxRounds;
  const isLimitedRound  = currentRound <= 2;
  const isSnakeDraft    = currentRound % 2 === 0;
  const canUndo         = pickHistory.length > 0;

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // PHASE: Resume prompt
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  if (phase === 'resume_prompt') {
    return (
      <Shell>
        <ModalHeader title="Fantasy Golf Draft" onClose={onClose} />
        <div style={{ padding: '32px 28px', flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24 }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>💾</div>
            <h3 style={theme.h2}>Saved Draft Found</h3>
            <p style={{ ...theme.bodyText, marginTop: 8 }}>A draft was saved from a previous session. Would you like to resume it or start fresh?</p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%', maxWidth: 320 }}>
            <Btn onClick={handleResume}>▶ Resume Previous Draft</Btn>
            <Btn onClick={handleStartNew} variant="danger">🗑 Start New Draft</Btn>
            <Btn onClick={onClose} variant="secondary">Cancel</Btn>
          </div>
        </div>
      </Shell>
    );
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // PHASE: Draft order
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  if (phase === 'order') {
    return (
      <Shell>
        <ModalHeader title="Set Draft Order" sub="Snake draft · Drag teams to reorder" onClose={onClose} />
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 22px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {draftOrder.map((team, idx) => (
            <div key={team.id}
              draggable
              onDragStart={() => handleDragStart(idx)}
              onDragOver={(e) => handleDragOver(e, idx)}
              onDragEnd={handleDragEnd}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '12px 16px',
                background: draggedIndex === idx ? 'rgba(180,160,100,0.08)' : 'rgba(255,255,255,0.03)',
                border: `1px solid ${draggedIndex === idx ? colors.border : colors.borderSubtle}`,
                borderRadius: 2, cursor: 'grab',
                opacity: draggedIndex === idx ? 0.6 : 1,
                transition: 'all 0.15s',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{
                  width: 32, height: 32, borderRadius: '50%',
                  background: 'rgba(180,160,100,0.15)', border: `1px solid ${colors.border}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontFamily: fonts.serif, fontSize: 14, color: colors.textGold,
                }}>
                  {idx + 1}
                </div>
                <span style={{ color: colors.textSecondary, fontSize: 16, letterSpacing: 2 }}>⋮⋮</span>
                <span style={{ fontFamily: fonts.serif, fontSize: 14, color: colors.textPrimary }}>{team.name}</span>
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                {[[-1, '▲'], [1, '▼']].map(([dir, label]) => {
                  const disabled = dir === -1 ? idx === 0 : idx === draftOrder.length - 1;
                  return (
                    <button key={dir} onClick={e => { e.stopPropagation(); moveDraftOrder(idx, dir); }} disabled={disabled}
                      style={{ background: 'none', border: 'none', cursor: disabled ? 'not-allowed' : 'pointer', color: disabled ? colors.textMuted : colors.textGold, width: 28, height: 28, borderRadius: 2, fontSize: 12 }}>
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <ModalFooter>
          <div style={{ ...theme.smallText, marginBottom: 12 }}>
            <strong style={{ color: colors.textGoldDim }}>Snake Draft:</strong> Order reverses each round. Round 1: 1→{draftOrder.length}, Round 2: {draftOrder.length}→1, etc.
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <Btn onClick={onClose} variant="secondary">Cancel</Btn>
            <Btn onClick={() => setPhase('keepers')}>Continue to Keepers →</Btn>
          </div>
        </ModalFooter>
      </Shell>
    );
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // PHASE: Keeper selection
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  if (phase === 'keepers') {
    const canProceed = currentKeeper.limited && currentKeeper.unlimited;
    return (
      <Shell>
        <ModalHeader
          title="Keeper Selection"
          sub={`Team ${keeperTeamIndex + 1} of ${draftOrder.length} · ${currentTeam.name}`}
          badge
          onClose={onClose}
        />
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 22px', display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0 }}>
          <KeeperBox
            type="limited" label="Limited Keeper"
            accentColor={colors.textGold}
            searchVal={limitedSearch} setSearch={setLimitedSearch}
            searchResults={limitedSearchResults} selectLabel="Select (L)"
            selected={currentKeeper.limited}
            onClear={() => handleKeeperSelect(null, 'limited')}
            onSelect={p => handleKeeperSelect(p.name, 'limited', 2)}
            onStars={(name, stars) => handleKeeperSelect(name, 'limited', stars)}
            getHeadshot={getPlayerHeadshot}
          />
          <KeeperBox
            type="unlimited" label="Unlimited Keeper"
            accentColor="rgba(100,160,255,0.85)"
            searchVal={unlimitedSearch} setSearch={setUnlimitedSearch}
            searchResults={unlimitedSearchResults} selectLabel="Select (U)"
            selected={currentKeeper.unlimited}
            onClear={() => handleKeeperSelect(null, 'unlimited')}
            onSelect={p => handleKeeperSelect(p.name, 'unlimited', 0)}
            onStars={null}
            getHeadshot={getPlayerHeadshot}
          />
        </div>
        <ModalFooter>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <Btn onClick={onClose} variant="secondary">Cancel</Btn>
            <Btn onClick={handleNextTeamKeepers} disabled={!canProceed}>
              {keeperTeamIndex < draftOrder.length - 1 ? 'Next Team →' : 'Start Draft →'}
            </Btn>
          </div>
        </ModalFooter>
      </Shell>
    );
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // PHASE: Draft
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const draftAccent = isLimitedRound ? colors.textGold : 'rgba(255,255,255,0.75)';

  return (
    <Shell wide>
      <ModalHeader
        title="Fantasy Golf Draft"
        sub={isDraftComplete ? undefined : `Round ${currentRound} of ${maxRounds} · ${isLimitedRound ? '🟡 Limited' : '⬜ Standard'} · ${currentTeam?.name} is picking`}
        badge={!isDraftComplete}
        onClose={handleClose}
      />

      {isDraftComplete ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 48, textAlign: 'center' }}>
          <div style={{ fontSize: 56, marginBottom: 16 }}>🏆</div>
          <h3 style={{ ...theme.h1, marginBottom: 8 }}>Draft Complete!</h3>
          <p style={{ ...theme.bodyText, marginBottom: 32 }}>All teams have drafted their rosters.</p>
          <Btn onClick={() => { clearDraftState(); onClose(); }}>Close Draft</Btn>
        </div>
      ) : (
        <>
          {/* Search */}
          <div style={{ padding: '12px 22px', borderBottom: `1px solid ${colors.borderSubtle}`, flexShrink: 0 }}>
            <SearchInput value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search players…" autoFocus />
          </div>

          {/* Player list */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '10px 14px', minHeight: 0 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {availablePlayers.map(player => (
                <button key={player.name} onClick={() => handleDraftPlayer(player.name)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 14,
                    padding: '10px 14px', borderRadius: 2, cursor: 'pointer',
                    background: isLimitedRound ? 'rgba(180,160,100,0.05)' : 'rgba(255,255,255,0.03)',
                    border: `1px solid ${isLimitedRound ? 'rgba(180,160,100,0.2)' : 'rgba(255,255,255,0.12)'}`,
                    textAlign: 'left', transition: 'all 0.15s',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = isLimitedRound ? 'rgba(180,160,100,0.12)' : 'rgba(255,255,255,0.08)'; e.currentTarget.style.borderColor = draftAccent; }}
                  onMouseLeave={e => { e.currentTarget.style.background = isLimitedRound ? 'rgba(180,160,100,0.05)' : 'rgba(255,255,255,0.03)'; e.currentTarget.style.borderColor = isLimitedRound ? 'rgba(180,160,100,0.2)' : 'rgba(255,255,255,0.12)'; }}
                >
                  <img
                    src={getPlayerHeadshot(player.name)}
                    onError={e => { e.target.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(player.name)}&background=0d1e38&color=6b7280&size=64`; }}
                    alt=""
                    style={{ width: 44, height: 44, borderRadius: '50%', objectFit: 'cover', border: `2px solid ${draftAccent}`, flexShrink: 0 }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: fonts.serif, fontSize: 14, color: colors.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{player.name}</div>
                    <div style={theme.smallText}>Rank: {player.worldRank === 999 ? 'NR' : `#${player.worldRank}`}</div>
                  </div>
                  <span style={{ ...theme.label, color: draftAccent, flexShrink: 0 }}>
                    Draft {isLimitedRound ? '(L)' : '(U)'}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Footer: draft order + undo */}
          <ModalFooter>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, gap: 8 }}>
              <span style={{ ...theme.label, flexShrink: 0 }}>
                Round {currentRound} — {isLimitedRound ? 'Limited' : 'Standard'}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {canUndo && (
                  <button onClick={handleUndo}
                    style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'none', border: `1px solid ${colors.borderSubtle}`, borderRadius: 2, padding: '4px 10px', cursor: 'pointer', color: colors.textSecondary, fontFamily: fonts.sans, fontSize: 11, transition: 'all 0.15s', whiteSpace: 'nowrap' }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = colors.danger; e.currentTarget.style.color = colors.danger; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = colors.borderSubtle; e.currentTarget.style.color = colors.textSecondary; }}
                  >
                    <RotateCcw style={{ width: 11, height: 11 }} />
                    Undo ({pickHistory[pickHistory.length - 1]?.playerName})
                  </button>
                )}
                <button onClick={handleEndDraft}
                  style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'rgba(180,60,60,0.08)', border: `1px solid ${colors.dangerBorder}`, borderRadius: 2, padding: '4px 10px', cursor: 'pointer', color: colors.danger, fontFamily: fonts.sans, fontSize: 11, fontWeight: 600, transition: 'all 0.15s', whiteSpace: 'nowrap' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'rgba(180,60,60,0.18)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'rgba(180,60,60,0.08)'; }}
                >
                  <Flag style={{ width: 11, height: 11 }} />
                  End Draft
                </button>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 2 }}>
              {(isSnakeDraft ? [...draftOrder].reverse() : draftOrder).map(team => (
                <div key={team.id} style={{
                  flexShrink: 0, padding: '5px 12px', borderRadius: 2,
                  fontFamily: fonts.sans, fontSize: 11, fontWeight: 600,
                  background: team.id === currentTeam?.id ? draftAccent : 'rgba(255,255,255,0.05)',
                  border: `1px solid ${team.id === currentTeam?.id ? draftAccent : colors.borderSubtle}`,
                  color: team.id === currentTeam?.id ? '#0a1628' : colors.textSecondary,
                  transition: 'all 0.2s',
                }}>
                  {team.name}
                </div>
              ))}
            </div>
          </ModalFooter>
        </>
      )}

      {/* ── Confirm pick overlay ── */}
      {confirmDraft && (
        <div style={{
          position: 'absolute', inset: 0, background: 'rgba(5,10,25,0.8)', backdropFilter: 'blur(4px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, zIndex: 10,
        }}>
          <div style={{
            background: '#0d1e38', border: `1px solid ${draftAccent}`,
            borderRadius: 4, padding: 28, maxWidth: 380, width: '100%', textAlign: 'center',
            boxShadow: '0 16px 60px rgba(0,0,0,0.5)',
          }}>
            <h3 style={{ ...theme.h2, marginBottom: 20 }}>Confirm Draft Pick</h3>
            <img
              src={getPlayerHeadshot(confirmDraft.playerName)}
              onError={e => { e.target.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(confirmDraft.playerName)}&background=0d1e38&color=6b7280&size=128`; }}
              alt=""
              style={{ width: 88, height: 88, borderRadius: '50%', objectFit: 'cover', border: `3px solid ${draftAccent}`, margin: '0 auto 14px' }}
            />
            <div style={{ fontFamily: fonts.serif, fontSize: 17, color: colors.textPrimary, marginBottom: 4 }}>{confirmDraft.playerName}</div>
            <div style={{ fontFamily: fonts.sans, fontSize: 12, color: draftAccent, marginBottom: 16, letterSpacing: '1px', textTransform: 'uppercase' }}>
              {confirmDraft.type === 'limited' ? 'Limited Player' : 'Unlimited Player'}
            </div>
            <p style={{ ...theme.bodyText, marginBottom: 22 }}>
              Draft for <span style={{ fontFamily: fonts.serif, color: colors.textGold }}>{currentTeam?.name}</span>?
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <Btn onClick={() => setConfirmDraft(null)} variant="secondary">Cancel</Btn>
              <Btn onClick={confirmDraftPlayer}>Confirm Pick</Btn>
            </div>
          </div>
        </div>
      )}
    </Shell>
  );
};
