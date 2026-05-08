import React, { useState, useEffect, useMemo } from 'react';
import { Calendar, Trophy, Edit2, Save, ChevronDown, ChevronRight } from 'lucide-react';
import { useDialog } from './DialogContext';

import { theme, colors, fonts, fontSize, cardLiftHandlers, SWINGS, SWING_COLORS, getSwingColor, getSwingColorAt } from '../theme.js';
import { getSegmentForTournament, shortName } from '../utils';
import { sfglDataApi } from '../api/firebase';
import { STORAGE_KEYS } from '../constants';
import { TournamentBadges } from './TournamentBadges';

const ALTERNATE_KEYWORDS = ['Puerto Rico', 'Zurich', 'Corales', 'Myrtle Beach', 'ISCO', 'Barracuda'];

const isAlternate = (t) => {
  if (t.isAlternate !== undefined) return t.isAlternate;
  return ALTERNATE_KEYWORDS.some(kw => t.name.includes(kw));
};

// ── Result rendering helpers (merged in from former ResultsView) ─────────────
const GOLD_BRIGHT = '#f5c518';
const GOLD_DIM    = 'rgba(245,197,24,0.35)';
const BLUE_BRIGHT = 'rgba(100,180,255,0.95)';
const BLUE_DIM    = 'rgba(100,180,255,0.35)';

// Triplet of {accent, bg, border} colors used by swing summary cards on the
// completed-events list. Specific alpha values (0.07, 0.3) are tuned for the
// card backgrounds in this view; other views compose their own variants.
const swingColorsForCard = (seg) => ({
  accent: getSwingColor(seg),
  bg:     getSwingColorAt(seg, 0.07),
  border: getSwingColorAt(seg, 0.3),
});

const playerNameColor = (p, showEarnings) => {
  if (p.unlimited) return showEarnings ? (p.earnings > 0 ? BLUE_BRIGHT : BLUE_DIM) : BLUE_BRIGHT;
  if (p.limited)   return showEarnings ? (p.earnings > 0 ? GOLD_BRIGHT : GOLD_DIM)  : GOLD_BRIGHT;
  return showEarnings
    ? (p.earnings > 0 ? colors.textPrimary : colors.textMuted)
    : colors.textSecondary;
};

// ── Player slot grid — 5-column layout under each team's row in expansions ──
const PlayerSlotGrid = ({ players, showEarnings }) => {
  // Always 5 columns — pad with nulls for empty slots
  const slots = Array.from({ length: 5 }, (_, i) => players[i] || null);
  return (
    <div style={{ marginLeft: 24, display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 3 }}>
      {slots.map((p, idx) => (
        <div key={idx} style={{ fontSize: fontSize.sm, minWidth: 0, overflow: 'hidden' }}>
          {p ? (
            <>
              {/* Line 1: name + mulligan */}
              <div style={{
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                color: playerNameColor(p, showEarnings),
              }}>
                {shortName(p.name)}
                {p.mulliganIn && (
                  <span title={`Mulligan · replaced ${p.replacedPlayer || '?'}`} style={{
                    marginLeft: 3, fontSize: fontSize.base, lineHeight: 1, verticalAlign: 'middle',
                    display: 'inline-block',
                    filter: 'drop-shadow(0 0 2px rgba(255,80,80,0.6))',
                  }}>🚨</span>
                )}
              </div>
              {/* Line 2: earnings (base + bonus combined) */}
              {showEarnings ? (
                <div style={{ whiteSpace: 'nowrap' }}>
                  <span style={{ ...theme.statNum, fontSize: fontSize.sm, color: (p.earnings || 0) > 0 ? colors.earningsGreen : colors.textMuted }}>
                    ${((p.earnings || 0) + (p.bonus || 0)).toLocaleString()}
                  </span>
                </div>
              ) : (
                <div style={{ color: colors.textMuted }}>—</div>
              )}
              {/* Line 3: round leader badges (only if any) */}
              {showEarnings && p.roundsLed?.length > 0 && (
                <div style={{ display: 'flex', gap: 2, marginTop: 1 }}>
                  {p.roundsLed.map((rl, ri) => (
                    <span key={ri} style={{
                      padding: '1px 3px',
                      background: 'rgba(220,110,30,0.35)',
                      color: 'rgba(255,165,80,0.95)',
                      borderRadius: 2, fontSize: fontSize.xs, lineHeight: 1.2,
                    }}>R{rl.round}</span>
                  ))}
                </div>
              )}
            </>
          ) : (
            <span style={{ color: 'rgba(255,255,255,0.1)' }}>—</span>
          )}
        </div>
      ))}
    </div>
  );
};

// Reusable styles for the "UPCOMING EVENTS" / "COMPLETED EVENTS" section
// headers — matches the white-gradient template used on Standings, Transactions
// fees/history, etc.
const sectionHeaderStyle = {
  padding: '8px 14px',
  background: 'linear-gradient(90deg, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0.04) 60%, transparent 100%)',
  borderBottom: theme.cardHeader.borderBottom,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const sectionTitleStyle = {
  fontFamily: fonts.sans,
  fontSize: fontSize.lg,
  fontWeight: 700,
  letterSpacing: '2px',
  textTransform: 'uppercase',
  color: colors.textPrimary,
};

// Wave 8: local swingColor() removed. We now use getSegmentForTournament(t)
// from utils + getSwingColor(seg) from theme — same source of truth as
// AdminView, StandingsView, TransactionsView.

export const TournamentsView = ({
  tournaments,
  isCommissioner,
  setTournaments,
  firstTeeTime,
  teams = [],
  transactions = [],
}) => {
  const [editMode,         setEditMode]         = useState(false);
  const [localTournaments, setLocalTournaments] = useState([]);
  const dialog = useDialog();

  useEffect(() => { setLocalTournaments(tournaments); }, [tournaments]);

  // ── Result-card expansion state ──────────────────────────────────────────
  // Most recent completed tournament auto-expands on first load so the latest
  // results are visible without needing a tap.
  const [expandedTournament, setExpandedTournament] = useState(null);
  const [hasAutoExpanded,    setHasAutoExpanded]    = useState(false);

  const completedSorted = useMemo(
    () => [...localTournaments.filter(t => t.completed)].reverse(),
    [localTournaments]
  );

  // Auto-expand the most recent completed event once data has loaded. We
  // gate on `hasAutoExpanded` so a user's explicit collapse isn't undone
  // by a re-render that triggers this effect again.
  useEffect(() => {
    if (!hasAutoExpanded && completedSorted.length > 0) {
      setExpandedTournament(completedSorted[0].name);
      setHasAutoExpanded(true);
    }
  }, [completedSorted.length, hasAutoExpanded]);

  const toggleExpansion = (name) => setExpandedTournament(prev => prev === name ? null : name);

  // ── Schedule editing logic (existing) ─────────────────────────────────────
  const formatTeeTime = (date) => {
    if (!date) return '';
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const hours = date.getHours(); const minutes = date.getMinutes();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    return `${days[date.getDay()]} ${hours % 12 || 12}:${minutes.toString().padStart(2, '0')} ${ampm} ET`;
  };

  const activeTournament = localTournaments.find(t => t.playing && !t.completed);

  const saveChanges = async () => {
    setTournaments(localTournaments);
    setEditMode(false);
    // setTournaments (= updateTournaments from useLeague) already persists to
    // Firestore + localStorage. The sfglDataApi write below is a belt-and-
    // suspenders backup to the key-value fallback path the cascade-loader checks.
    try {
      await sfglDataApi.set(STORAGE_KEYS.TOURNAMENTS, localTournaments);
    } catch (e) {
      console.error('sfglDataApi.set tournaments failed:', e);
    }
    dialog.showToast('Schedule updated!', 'success');
  };

  const updateLocal = (index, patch) => {
    setLocalTournaments(prev => prev.map((t, i) => i === index ? { ...t, ...patch } : t));
  };

  const completed = completedSorted;
  const upcoming  = localTournaments.filter(t => !t.completed);

  // ── Result-rendering helpers (merged from former ResultsView) ────────────
  // Build name → {limited, unlimited} from live roster so historical results
  // (which may predate the unlimited field being stored) still render correctly.
  const rosterFlagMap = useMemo(() => {
    const map = {};
    teams.forEach(team => {
      (team.roster || []).forEach(p => {
        map[p.name] = { limited: p.limited || false, unlimited: p.unlimited || false };
      });
    });
    return map;
  }, [teams]);

  // Build mulligan lookup: { tournamentIndex → { ins, outs } } for both
  // directions because tournament results may contain EITHER the original
  // player or the replacement player depending on whether the swap was applied.
  const mulliganMap = useMemo(() => {
    const map = {};
    transactions.forEach(tx => {
      if (tx.type !== 'mulligan' || !tx.player) return;
      const idx = tx.tournamentIndex ?? -1;
      if (!map[idx]) map[idx] = { ins: {}, outs: {} };
      map[idx].ins[tx.player] = tx.droppedPlayer || '?';
      if (tx.droppedPlayer) map[idx].outs[tx.droppedPlayer] = tx.player;
    });
    return map;
  }, [transactions]);

  // Enrich a result-player record with live roster flags + mulligan detection.
  const enrich = (p, tournamentIndex) => {
    const tMap = mulliganMap[tournamentIndex];
    const isMullIn = p.mulliganIn || !!tMap?.ins[p.name];
    const isMullOut = !!tMap?.outs[p.name];
    const displayName = isMullOut ? tMap.outs[p.name] : p.name;
    const replacedPlayer = isMullIn
      ? (p.replacedPlayer || tMap?.ins[p.name] || null)
      : isMullOut
        ? p.name
        : null;
    return {
      ...p,
      name: displayName,
      limited:   rosterFlagMap[displayName]?.limited   ?? p.limited   ?? false,
      unlimited: rosterFlagMap[displayName]?.unlimited ?? p.unlimited ?? false,
      mulliganIn: isMullIn || isMullOut,
      replacedPlayer,
    };
  };

  // Build swing summary cards from swing_winner transactions.
  const swingSummaries = useMemo(() => {
    const awarded = transactions.filter(tx => tx.type === 'swing_winner');
    return awarded.map(tx => {
      const seg = tx.segment;
      const swingTourneys = localTournaments.filter(t => t.completed && getSegmentForTournament(t) === seg && t.results?.teams);
      const byTeam = {};
      swingTourneys.forEach(t => {
        Object.entries(t.results.teams).forEach(([id, tr]) => {
          byTeam[id] = (byTeam[id] || 0) + (tr.totalEarnings || 0);
        });
      });
      const lastTourney = swingTourneys[swingTourneys.length - 1];
      const ranked = Object.entries(byTeam)
        .map(([id, earnings]) => ({ team: teams.find(t => t.id === id), earnings }))
        .filter(e => e.team)
        .sort((a, b) => b.earnings - a.earnings);
      return { seg, tx, ranked, lastTourney, pot: tx.amount || 0, tourneyCount: swingTourneys.length };
    });
  }, [transactions, localTournaments, teams]);

  // ── Status badge component ──
  const StatusBadge = ({ tournament }) => {
    const isActive = tournament.playing && !tournament.completed;
    if (!isActive) return null;

    return (
      <span style={{
        ...theme.badge,
        ...theme.badgeInProgress,
        // Override base badge sizing to match the original tighter inline version
        // (TournamentsView's row height is tight; the default 2px 8px padding
        // with 10px font and 1px letter-spacing is a hair too big).
        padding: '2px 6px',
        fontSize: fontSize.xs,
        letterSpacing: 0,
        textTransform: 'none',
        gap: 3,
        whiteSpace: 'nowrap',
      }}>
        In Progress
      </span>
    );
  };

  const renderTable = (list) => (
    <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
      {!editMode && (
        <colgroup>
          <col style={{ width: 26 }} />
          <col />
          <col style={{ width: 70 }} />
          <col style={{ width: '34%' }} />
        </colgroup>
      )}
      <thead>
        <tr>
          {editMode ? (
            ['Active', 'Type', 'Tournament', 'Dates', 'Location / Course', 'Swing', 'Lock'].map(h => (
              <th key={h} style={{ ...theme.tableHeaderCell, fontSize: fontSize.sm }}>{h}</th>
            ))
          ) : (
            [{ label: '' }, { label: 'Tournament' }, { label: 'Dates' }, { label: 'Location' }].map(({ label }) => (
              <th key={label || 'badge'} style={{ ...theme.tableHeaderCell, textAlign: 'left', padding: '8px 6px' }}>{label}</th>
            ))
          )}
        </tr>
      </thead>
      <tbody>
        {list.map(t => {
          const realIndex = localTournaments.findIndex(lt => lt.name === t.name);
          const alt = isAlternate(t);

          if (editMode) {
            return (
              <tr key={t.name}
                style={{ borderBottom: `1px solid ${colors.borderSubtle}` }}
                onMouseEnter={e => { e.currentTarget.style.background = colors.rowHover; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
              >
                {/* Active checkbox */}
                <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                  <input
                    type="checkbox"
                    checked={t.playing && !t.completed}
                    onChange={e => {
                      const updated = localTournaments.map(x => ({ ...x, playing: false }));
                      if (e.target.checked && !t.completed) updated[realIndex].playing = true;
                      setLocalTournaments(updated);
                    }}
                    style={{ accentColor: colors.textGold, width: 14, height: 14, cursor: 'pointer' }}
                  />
                </td>

                {/* Type toggle badges */}
                <td style={{ padding: '8px 8px' }}>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {[
                      { badge: 'S', key: 'isSignature', activeColor: 'rgba(130,80,200,0.8)', activeBorder: 'rgba(130,80,200,0.5)' },
                      { badge: 'M', key: 'isMajor',     activeColor: colors.textGold,         activeBorder: colors.border },
                      { badge: 'Alt', key: 'isAlternate', activeColor: colors.danger,           activeBorder: colors.dangerBorder },
                    ].map(({ badge, key, activeColor, activeBorder }) => {
                      const active = t[key];
                      return (
                        <button key={badge} onClick={() => updateLocal(realIndex, { [key]: !active })}
                          style={{
                            width: badge === 'Alt' ? 28 : 22, height: 22,
                            borderRadius: 2, fontFamily: fonts.sans,
                            fontSize: fontSize.xs, fontWeight: 700, cursor: 'pointer',
                            transition: 'all 0.15s',
                            background: active ? `rgba(${activeColor}, 0.15)` : 'rgba(255,255,255,0.04)',
                            border: `1px solid ${active ? activeBorder : colors.borderSubtle}`,
                            color: active ? activeColor : colors.textMuted,
                          }}
                        >
                          {badge}
                        </button>
                      );
                    })}
                  </div>
                </td>

                {/* Name input */}
                <td style={{ padding: '8px 8px' }}>
                  <input
                    value={t.name}
                    onChange={e => updateLocal(realIndex, { name: e.target.value })}
                    style={{
                      background: 'transparent',
                      border: 'none', borderBottom: `1px solid ${colors.borderInput}`,
                      width: '100%', fontFamily: fonts.sans, fontSize: fontSize.base,
                      color: colors.textPrimary, outline: 'none', padding: '2px 0',
                    }}
                  />
                </td>

                {/* Dates input */}
                <td style={{ padding: '8px 8px' }}>
                  <input
                    value={t.dates}
                    onChange={e => updateLocal(realIndex, { dates: e.target.value })}
                    style={{
                      background: 'transparent',
                      border: 'none', borderBottom: `1px solid ${colors.borderInput}`,
                      width: '100%', fontFamily: fonts.sans, fontSize: fontSize.base,
                      color: colors.textPrimary, outline: 'none', padding: '2px 0',
                    }}
                  />
                </td>

                {/* Location + course */}
                <td style={{ padding: '8px 8px' }}>
                  <input
                    value={t.location || ''}
                    onChange={e => updateLocal(realIndex, { location: e.target.value })}
                    style={{
                      background: 'transparent',
                      border: 'none', borderBottom: `1px solid ${colors.borderInput}`,
                      width: '100%', fontFamily: fonts.sans, fontSize: fontSize.base,
                      color: colors.textPrimary, outline: 'none', padding: '2px 0',
                    }}
                    placeholder="Location"
                  />
                  <input
                    value={t.course || ''}
                    onChange={e => updateLocal(realIndex, { course: e.target.value })}
                    style={{
                      background: 'transparent',
                      border: 'none', borderBottom: `1px solid ${colors.borderInput}`,
                      width: '100%', fontFamily: fonts.sans, fontSize: fontSize.sm,
                      color: colors.textSecondary, outline: 'none', padding: '2px 0',
                      marginTop: 2,
                    }}
                    placeholder="Course"
                  />
                </td>

                {/* Swing override */}
                <td style={{ padding: '8px 8px' }}>
                  <select
                    value={t.segment || ''}
                    onChange={e => updateLocal(realIndex, { segment: e.target.value || null })}
                    style={{
                      ...theme.select,
                      fontSize: fontSize.base,
                      padding: '5px 8px',
                      background: '#0d1b2e',
                      color: colors.textPrimary,
                      appearance: 'none',
                      WebkitAppearance: 'none',
                      minWidth: 110,
                    }}
                  >
                    <option value="">— derived —</option>
                    {SWINGS.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </td>

                {/* Lock hour override */}
                <td style={{ padding: '8px 8px' }}>
                  <select
                    value={t.lockHour ?? 7}
                    onChange={e => updateLocal(realIndex, { lockHour: parseInt(e.target.value) })}
                    style={{
                      ...theme.select,
                      fontSize: fontSize.base,
                      padding: '5px 8px',
                      background: '#0d1b2e',
                      color: colors.textPrimary,
                      appearance: 'none',
                      WebkitAppearance: 'none',
                      minWidth: 90,
                    }}
                  >
                    {[7, 8, 9, 10, 11, 12].map(h => (
                      <option key={h} value={h}>{h === 12 ? '12:00 PM' : `${h}:00 AM`}{h === 7 ? ' (default)' : ''}</option>
                    ))}
                  </select>
                </td>
              </tr>
            );
          }

          // ── Read-only row ──
          return (
            <tr key={t.name}
              style={{
                borderBottom: `1px solid ${colors.borderSubtle}`,
                opacity: alt ? 0.45 : 1,
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = colors.rowHover; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
            >
              {/* Badge column — uses shared TournamentBadges (sm = 18×18 to fit row height) */}
              <td style={{ padding: '8px 2px 8px 8px', verticalAlign: 'middle' }}>
                <TournamentBadges tournament={t} size="sm" />
              </td>

              {/* Tournament name */}
              <td style={{ padding: '8px 8px' }}>
                <span style={{
                  fontFamily: fonts.serif, fontSize: fontSize.md,
                  color: alt ? colors.textMuted : colors.textPrimary,
                  display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                  overflow: 'hidden', lineHeight: 1.35,
                }}>
                  {t.name}
                  {t.completed && (
                    <span style={{ fontSize: fontSize.base, color: colors.textMuted, marginLeft: 4 }}>✓</span>
                  )}
                </span>
              </td>

              {/* Dates — or "In Progress" badge for active tournament */}
              <td style={{ padding: '8px 6px', whiteSpace: 'nowrap' }}>
                {t.playing && !t.completed ? (
                  <StatusBadge tournament={t} />
                ) : (
                  <span style={{ fontFamily: fonts.sans, fontSize: fontSize.base, color: alt ? colors.textMuted : getSwingColor(getSegmentForTournament(t)) }}>
                    {t.dates}
                  </span>
                )}
              </td>

              {/* Location + course — stacked: city/state on top, course below */}
              <td style={{ padding: '8px 8px 8px 6px' }}>
                <div style={{
                  fontFamily: fonts.sans, fontSize: fontSize.sm,
                  color: alt ? colors.textMuted : colors.textSecondary,
                  overflow: 'hidden', lineHeight: 1.3,
                }}>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.location}
                  </div>
                  {t.course && t.course !== 'TBD' && (
                    <div style={{
                      color: colors.textMuted,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      marginTop: 1,
                    }}>
                      {t.course}
                    </div>
                  )}
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  // ── Render the completed list as expandable result cards ────────────────
  // Swing summary cards interleaved at the top of each swing group, matching
  // the layout that used to live in ResultsView.
  const renderCompletedResults = () => {
    const renderedSwings = new Set();
    const items = [];
    completed.forEach((tournament) => {
      const seg = getSegmentForTournament(tournament);
      if (seg && !renderedSwings.has(seg)) {
        const summary = swingSummaries.find(s => s.seg === seg);
        if (summary) {
          items.push({ type: 'swing', summary });
          renderedSwings.add(seg);
        }
      }
      items.push({ type: 'tournament', tournament });
    });
    // Fallback: any unplaced swing summaries go at the end
    swingSummaries.forEach(s => {
      if (!renderedSwings.has(s.seg)) {
        items.push({ type: 'swing', summary: s });
        renderedSwings.add(s.seg);
      }
    });

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 6 }}>
        {items.map(item => {
          if (item.type === 'swing') {
            const { summary } = item;
            const isExpanded = expandedTournament === ('swing:' + summary.seg);
            const sc = swingColorsForCard(summary.seg);
            return (
              <div key={'swing:' + summary.seg} style={{
                ...theme.cardLift,
                border: `1px solid ${sc.border}`,
              }} {...cardLiftHandlers({ disabled: isExpanded })}>
                <button
                  onClick={() => toggleExpansion('swing:' + summary.seg)}
                  aria-expanded={isExpanded}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '6px 14px',
                    background: isExpanded ? sc.bg : `linear-gradient(90deg, ${sc.bg} 0%, transparent 100%)`,
                    border: 'none', borderBottom: isExpanded ? `1px solid ${sc.border}` : 'none',
                    cursor: 'pointer', transition: 'background 0.2s',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = sc.bg; }}
                  onMouseLeave={e => { if (!isExpanded) e.currentTarget.style.background = `linear-gradient(90deg, ${sc.bg} 0%, transparent 100%)`; }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
                    <div style={{ flexShrink: 0, width: 20, display: 'flex', justifyContent: 'center' }}>
                      <Trophy style={{ width: 11, height: 11, color: sc.accent }} />
                    </div>
                    <div style={{ textAlign: 'left', minWidth: 0 }}>
                      <h3 style={{ ...theme.h3, color: sc.accent, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {summary.seg}
                      </h3>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {!isExpanded && summary.ranked[0] && (
                      <span style={{ ...theme.badge, background: sc.bg, border: `1px solid ${sc.border}`, color: sc.accent }}>
                        🏆 {summary.ranked[0].team.name}
                      </span>
                    )}
                    {isExpanded
                      ? <ChevronDown style={{ width: 15, height: 15, color: sc.accent }} />
                      : <ChevronRight style={{ width: 15, height: 15, color: sc.accent }} />
                    }
                  </div>
                </button>

                {/* Expanded — team standings for the swing */}
                {isExpanded && (
                  <div>
                    {summary.ranked.map((entry, rank) => (
                      <div key={entry.team.id}
                        style={{
                          padding: '6px 14px',
                          borderBottom: `1px solid ${colors.borderSubtle}`,
                          background: rank === 0 ? sc.bg : 'transparent',
                          transition: 'background 0.15s',
                        }}
                        onMouseEnter={e => { e.currentTarget.style.background = rank === 0 ? sc.bg : 'rgba(255,255,255,0.04)'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = rank === 0 ? sc.bg : 'transparent'; }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                          <span style={{
                            fontSize: fontSize.base, fontWeight: 700, width: 18, textAlign: 'center',
                            fontFamily: fonts.serif,
                            color: rank === 0 ? sc.accent : colors.textMuted,
                          }}>
                            {rank + 1}
                          </span>
                          <span style={{ ...theme.bodyText, color: rank === 0 ? colors.textPrimary : colors.textSecondary }}>{entry.team.name}</span>
                          <span style={{
                            ...theme.statNum,
                            fontSize: rank === 0 ? fontSize.md : fontSize.base,
                            fontWeight: rank === 0 ? 700 : 400,
                            color: rank === 0 ? colors.earningsGreen : 'rgba(80,180,120,0.5)',
                            marginLeft: 2,
                          }}>
                            ${entry.earnings.toLocaleString()}
                          </span>
                          {rank === 0 && (
                            <span style={{ fontFamily: fonts.sans, fontSize: fontSize.sm, fontWeight: 700, color: sc.accent, marginLeft: 2 }}>
                              +${summary.pot.toLocaleString()} pot
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          }

          // Regular tournament card
          const { tournament } = item;
          const tIdx = tournaments.indexOf(tournament);
          const isExpanded = expandedTournament === tournament.name;
          const results = tournament.results;
          const rankedTeams = teams
            .map(t => ({ ...t, result: results?.teams?.[t.id] }))
            .filter(t => t.result)
            .sort((a, b) => (b.result.totalEarnings || 0) - (a.result.totalEarnings || 0));

          return (
            <div key={tournament.name} style={theme.cardLift} {...cardLiftHandlers({ disabled: isExpanded })}>
              <button
                onClick={() => toggleExpansion(tournament.name)}
                aria-expanded={isExpanded}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '6px 14px', background: isExpanded
                    ? 'rgba(18,46,82,0.3)'
                    : 'linear-gradient(90deg, rgba(18,46,82,0.3) 0%, transparent 100%)',
                  border: 'none', borderBottom: isExpanded ? `1px solid ${colors.borderSubtle}` : 'none',
                  cursor: 'pointer', transition: 'background 0.2s',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(18,46,82,0.25)'; }}
                onMouseLeave={e => { if (!isExpanded) e.currentTarget.style.background = 'linear-gradient(90deg, rgba(18,46,82,0.3) 0%, transparent 100%)'; }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
                  <div style={{ flexShrink: 0, width: 20, display: 'flex', justifyContent: 'center' }}>
                    <TournamentBadges tournament={tournament} />
                  </div>
                  <div style={{ textAlign: 'left', minWidth: 0 }}>
                    <h3 style={{ ...theme.h3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tournament.name}</h3>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center' }}>
                  {isExpanded
                    ? <ChevronDown style={{ width: 15, height: 15, color: colors.textSecondary }} />
                    : <ChevronRight style={{ width: 15, height: 15, color: colors.textSecondary }} />
                  }
                </div>
              </button>

              {/* Expanded — team rows with player slot grid below each */}
              {isExpanded && results && (
                <div>
                  {rankedTeams.map((team, rank) => {
                    const tr = team.result;
                    const players = (tr.players || [])
                      .map(p => enrich(p, tIdx))
                      .sort((a, b) => (b.earnings || 0) - (a.earnings || 0));
                    return (
                      <div key={team.id}
                        style={{
                          padding: '6px 14px',
                          borderBottom: `1px solid ${colors.borderSubtle}`,
                          background: rank === 0 ? 'rgba(180,160,100,0.04)' : 'transparent',
                          transition: 'background 0.15s',
                        }}
                        onMouseEnter={e => { e.currentTarget.style.background = rank === 0 ? 'rgba(180,160,100,0.07)' : 'rgba(255,255,255,0.04)'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = rank === 0 ? 'rgba(180,160,100,0.04)' : 'transparent'; }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                          <span style={{
                            fontSize: fontSize.base, fontWeight: 700, width: 18, textAlign: 'center',
                            fontFamily: fonts.serif,
                            color: rank === 0 ? colors.textGold : colors.textMuted,
                          }}>
                            {rank + 1}
                          </span>
                          <span style={{ ...theme.bodyText, color: colors.textPrimary }}>{team.name}</span>
                          <span style={{
                            ...theme.statNum, fontSize: fontSize.base, fontWeight: 600,
                            color: (tr.totalEarnings || 0) > 0 ? colors.earningsGreen : colors.textMuted,
                            marginLeft: 2,
                          }}>
                            ${(tr.totalEarnings || 0).toLocaleString()}
                          </span>
                        </div>
                        <PlayerSlotGrid players={players} showEarnings />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* ── Edit button (commissioner only) ── */}
      {isCommissioner && (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            onClick={() => editMode ? saveChanges() : setEditMode(true)}
            style={{
              ...(editMode ? theme.btnPrimary : theme.btnSecondary),
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '8px 14px', flexShrink: 0,
            }}
          >
            {editMode
              ? <><Save style={{ width: 12, height: 12 }} /> Save Changes</>
              : <><Edit2 style={{ width: 12, height: 12 }} /> Edit Schedule</>
            }
          </button>
        </div>
      )}

      {/* ── Upcoming ── */}
      <div style={theme.card}>
        <div style={sectionHeaderStyle}>
          <Calendar style={{ width: 15, height: 15, color: colors.textPrimary }} />
          <span style={sectionTitleStyle}>Upcoming Events</span>
        </div>
        <div style={{ overflowX: 'auto' }}>{renderTable(upcoming)}</div>
      </div>

      {/* ── Completed ── */}
      {/* In edit mode: show the editable table. Otherwise: render expandable
          result cards with the most recent expanded by default. */}
      {completed.length > 0 && (
        <div style={theme.card}>
          <div style={sectionHeaderStyle}>
            <Trophy style={{ width: 15, height: 15, color: colors.textGold }} />
            <span style={sectionTitleStyle}>Completed Events</span>
          </div>
          {editMode
            ? <div style={{ overflowX: 'auto' }}>{renderTable(completed)}</div>
            : renderCompletedResults()
          }
        </div>
      )}
    </div>
  );
};
