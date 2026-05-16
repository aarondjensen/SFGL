import React, { useState, useEffect, useMemo } from 'react';
import { Calendar, Trophy, Edit2, Save, ChevronDown, ChevronRight } from 'lucide-react';
import { useDialog } from './DialogContext';

import { theme, colors, fonts, fontSize, SWINGS, getSwingColor, getSwingColorAt } from '../theme.js';
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

// (swingColorsForCard helper and swing summary card rendering were removed
// when completed events moved to the same table format as upcoming events.
// Per-swing standings are still available on the Standings tab.)

const playerNameColor = (p, showEarnings) => {
  if (p.unlimited) return showEarnings ? (p.earnings > 0 ? BLUE_BRIGHT : BLUE_DIM) : BLUE_BRIGHT;
  if (p.limited)   return showEarnings ? (p.earnings > 0 ? GOLD_BRIGHT : GOLD_DIM)  : GOLD_BRIGHT;
  return showEarnings
    ? (p.earnings > 0 ? colors.textPrimary : colors.textMuted)
    : colors.textSecondary;
};

// ── Player slot grid — 5-column layout under each team's row in expansions ──
// Three modes (controlled by props):
//   • showEarnings        — completed tournament: name + $ + round-leader badges
//   • showLive            — active tournament: name + position + score · thru
//   • neither             — upcoming: name + "—" placeholder
//
// In `showLive` mode, each player record should have `live` populated with
// the matched leaderboard entry (or be missing it if the player isn't in
// the field or no live data is available yet — handled gracefully below).
const PlayerSlotGrid = ({ players, showEarnings, showLive }) => {
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
              {/* Line 2: earnings ($) / live position / placeholder */}
              {showEarnings ? (
                <div style={{ whiteSpace: 'nowrap' }}>
                  <span style={{ ...theme.statNum, fontSize: fontSize.sm, color: (p.earnings || 0) > 0 ? colors.earningsGreen : colors.textMuted }}>
                    ${((p.earnings || 0) + (p.bonus || 0)).toLocaleString()}
                  </span>
                </div>
              ) : showLive ? (
                // Live mode: show position + score, or CUT/WD, or "—" if not yet
                // matched. Keeps the same vertical rhythm as the $ row above.
                (() => {
                  const live = p.live;
                  if (!live) {
                    return <div style={{ color: colors.textMuted, fontSize: fontSize.xs }}>—</div>;
                  }
                  if (live.isCut) {
                    return <div style={{ color: colors.textMuted, fontSize: fontSize.xs, fontWeight: 700 }}>CUT</div>;
                  }
                  if (live.isWD) {
                    return <div style={{ color: colors.textMuted, fontSize: fontSize.xs, fontWeight: 700 }}>WD</div>;
                  }
                  const pos = live.position || '—';
                  const score = live.score || '';
                  // Golf-traditional: under par is RED (the "good" highlight,
                  // matches broadcast convention), over par is muted (de-
                  // emphasized, not punitive), even par is primary text.
                  // Same convention as RostersView's live score column.
                  const scoreColor = score.startsWith('-')
                    ? colors.danger
                    : score.startsWith('+')
                      ? colors.textMuted
                      : colors.textPrimary;
                  return (
                    <div style={{ whiteSpace: 'nowrap', display: 'flex', alignItems: 'baseline', gap: 4 }}>
                      <span style={{ fontFamily: fonts.mono, fontSize: fontSize.sm, color: colors.textPrimary, fontWeight: 600 }}>
                        {pos}
                      </span>
                      {score && (
                        <span style={{ fontFamily: fonts.mono, fontSize: fontSize.xs, color: scoreColor }}>
                          {score}
                        </span>
                      )}
                    </div>
                  );
                })()
              ) : (
                <div style={{ color: colors.textMuted }}>—</div>
              )}
              {/* Line 3a: round leader badges (completed only) */}
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
              {/* Line 3b: thru indicator (active only). Shows "F" for finished
                  or "thru N" mid-round. Omitted entirely when the player
                  hasn't started (no useful indicator to show — the position
                  column already says "—" in that case). */}
              {showLive && p.live && !p.live.isCut && !p.live.isWD && (() => {
                const thru = p.live.thru;
                const thruNum = thru ? parseInt(thru, 10) : NaN;
                const isFinished = thru === 'F' || thru === 'F*';
                const isMidRound = !isNaN(thruNum) && thruNum > 0 && thruNum < 18;
                let label = null;
                if (isFinished) label = 'F';
                else if (isMidRound) label = `thru ${thru}`;
                if (!label) return null;
                return (
                  <div style={{ fontSize: 9, color: colors.textMuted, marginTop: 1 }}>
                    {label}
                  </div>
                );
              })()}
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

  // Auto-expand the most relevant event on first load. Priority:
  //   1. Active (in-progress) tournament — managers want to see live positions
  //   2. Most recent completed — falls back to the prior behavior
  // We gate on `hasAutoExpanded` so a user's explicit collapse isn't undone
  // by a re-render that triggers this effect again.
  useEffect(() => {
    if (hasAutoExpanded) return;
    const active = localTournaments.find(t => t.playing && !t.completed);
    if (active) {
      setExpandedTournament(active.name);
      setHasAutoExpanded(true);
    } else if (completedSorted.length > 0) {
      setExpandedTournament(completedSorted[0].name);
      setHasAutoExpanded(true);
    }
  }, [completedSorted.length, hasAutoExpanded, localTournaments]);

  const toggleExpansion = (name) => setExpandedTournament(prev => prev === name ? null : name);

  // ── Live leaderboard fetch for the active tournament ──────────────────────
  // Mirrors the same pattern as RostersView: poll /api/live every 5 min,
  // discard any data whose tournamentName doesn't fuzzy-match the active
  // tournament (so we never show scores from the wrong event when the commish
  // is behind on processing).
  const [liveData, setLiveData] = useState(null);
  const activeTournamentForLive = localTournaments.find(t => t.playing && !t.completed);
  useEffect(() => {
    setLiveData(null);
    if (!activeTournamentForLive) return;
    let cancelled = false;
    let interval = null;

    const fuzzyMatch = (liveName, appName) => {
      if (!liveName || !appName) return false;
      const norm = s => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
      const a = norm(liveName);
      const b = norm(appName);
      if (a === b) return true;
      if (a.includes(b) || b.includes(a)) return true;
      const sig = s => s.split(/\s+/).filter(w => w.length > 2);
      const aw = sig(a);
      const bw = sig(b);
      const overlap = bw.filter(w => aw.includes(w)).length;
      return overlap >= Math.min(2, bw.length);
    };

    const fetchLive = () => {
      fetch('/api/live')
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (cancelled) return;
          if (!data?.players?.length) { setLiveData(null); return; }
          const liveTournament = data.tournamentName || data.eventName || '';
          if (liveTournament && !fuzzyMatch(liveTournament, activeTournamentForLive.name)) {
            setLiveData(null);
            return;
          }
          setLiveData(data);
        })
        .catch(() => {});
    };

    fetchLive();
    interval = setInterval(fetchLive, 5 * 60 * 1000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [activeTournamentForLive?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  // Normalize player name for fuzzy-matching against live data. Mirrors the
  // pattern in RostersView (lowercase, strip diacritics, hyphens→spaces).
  const normalize = (s) => (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/ß/g, 'ss')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Build a name-keyed live-player map once per liveData update so the
  // active-tournament expansion doesn't re-scan the players array per row.
  // Tries exact match first, then last-name match (≥4 chars to avoid false
  // positives), then substring match.
  const liveByName = useMemo(() => {
    if (!liveData?.players?.length) return null;
    const exact = new Map();
    const lastName = new Map();
    liveData.players.forEach(lp => {
      const n = normalize(lp.name);
      exact.set(n, lp);
      const ln = n.split(' ').slice(-1)[0];
      if (ln && ln.length >= 4 && !lastName.has(ln)) lastName.set(ln, lp);
    });
    const find = (rosterName) => {
      const n = normalize(rosterName);
      const e = exact.get(n);
      if (e) return e;
      const ln = n.split(' ').slice(-1)[0];
      if (ln && ln.length >= 4) {
        const byLast = lastName.get(ln);
        if (byLast) return byLast;
      }
      // Last resort: substring scan (rare path, only when no last-name match)
      return liveData.players.find(lp => {
        const ln2 = normalize(lp.name);
        return ln2.includes(n) || n.includes(ln2);
      }) || null;
    };
    return { find };
  }, [liveData]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // (swingSummaries memo removed when swing summary cards were dropped from
  // this view — see Standings tab for swing-level team standings.)

  // ── Status badge component ──
  const StatusBadge = ({ tournament }) => {
    const isActive = tournament.playing && !tournament.completed;
    if (!isActive) return null;

    // Tint the badge with the tournament's swing color so it visually
    // reads as belonging to that swing. Falls back gracefully to the
    // default green-tinted look when the segment can't be resolved
    // (getSwingColorAt returns a neutral white rgba for unknown swings).
    const segment = getSegmentForTournament(tournament);

    return (
      <span style={{
        ...theme.badge,
        background: getSwingColorAt(segment, 0.15),
        border:    `1px solid ${getSwingColorAt(segment, 0.40)}`,
        color:      getSwingColorAt(segment, 0.90),
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

  // Helper: build the team-standings JSX for the ACTIVE tournament expansion.
  // Mirrors renderTournamentExpansion's structure but ranks teams by the
  // sum of live scores of their starters (under par is better), and shows
  // each player's position / score / thru instead of earnings.
  //
  // Teams without a submitted lineup still render but show a "No lineup
  // submitted" message in place of the player grid. The team-level total
  // shows "—" when nothing in the lineup has live data yet (pre-tournament).
  const renderActiveTournamentExpansion = (tournament) => {
    const tIdx = tournaments.indexOf(tournament);

    // Build enriched player records for each team's lineup. Each player gets:
    //   • roster flags (limited / unlimited)
    //   • mulligan detection (using mulliganMap, same as completed view)
    //   • live data (position, score, thru, isCut, isWD, teeTime) if matched
    const enrichForActive = (playerName) => {
      const tMap = mulliganMap[tIdx];
      const isMullIn = !!tMap?.ins[playerName];
      const isMullOut = !!tMap?.outs[playerName];
      // For active tournaments we want to display whoever IS currently in
      // the lineup, not the original. Lineup is the source of truth.
      const flags = rosterFlagMap[playerName] || { limited: false, unlimited: false };
      const live = liveByName ? liveByName.find(playerName) : null;
      return {
        name: playerName,
        limited: flags.limited,
        unlimited: flags.unlimited,
        mulliganIn: isMullIn,
        replacedPlayer: isMullIn ? tMap.ins[playerName] : null,
        live,
      };
    };

    // Per-team aggregate score (sum of live scores; under par = better).
    // Returns null when nothing in the lineup has any live data yet, so the
    // UI can show "—" rather than a misleading "+0".
    const teamScoreSummary = (lineup) => {
      const liveStarters = lineup
        .map(name => liveByName?.find(name))
        .filter(lp => lp && !lp.isCut && !lp.isWD);
      if (liveStarters.length === 0) return null;
      // Sum strokes-relative-to-par across starters. Parse "+3" / "-2" / "E".
      const toNum = (s) => {
        if (!s) return 0;
        if (s === 'E') return 0;
        const n = parseInt(s, 10);
        return isNaN(n) ? 0 : n;
      };
      const total = liveStarters.reduce((sum, lp) => sum + toNum(lp.score), 0);
      const cuts = lineup.filter(name => {
        const lp = liveByName?.find(name);
        return lp?.isCut || lp?.isWD;
      }).length;
      return { total, cuts, livePlayers: liveStarters.length };
    };

    // Rank teams: best (lowest) sum first; teams with no live data sort last.
    const rankedTeams = teams
      .map(team => {
        const lineup = Array.isArray(team.lineup) ? team.lineup : [];
        const summary = teamScoreSummary(lineup);
        return { ...team, lineup, summary };
      })
      .filter(team => team.lineup.length > 0)  // only teams that submitted
      .sort((a, b) => {
        // Teams with no live summary sort last (push nulls down)
        if (a.summary === null && b.summary === null) return 0;
        if (a.summary === null) return 1;
        if (b.summary === null) return -1;
        return a.summary.total - b.summary.total;
      });

    if (rankedTeams.length === 0) {
      return (
        <div style={{ ...theme.emptyState, padding: '14px 14px' }}>
          No teams have submitted lineups for this tournament yet.
        </div>
      );
    }

    return (
      <div>
        {rankedTeams.map((team, rank) => {
          const lineup = team.lineup;
          const players = lineup.map(enrichForActive);
          const summary = team.summary;
          // Display team-aggregate score: "+5" / "-3" / "E", or "—" if nothing live.
          let totalLabel = '—';
          let totalColor = colors.textMuted;
          if (summary !== null) {
            const t = summary.total;
            totalLabel = t === 0 ? 'E' : t > 0 ? `+${t}` : `${t}`;
            // Golf-traditional: under par is red, over is muted, even is primary
            totalColor = t < 0 ? colors.danger : t > 0 ? colors.textMuted : colors.textPrimary;
          }
          return (
            <div key={team.id}
              style={{
                padding: '6px 14px',
                borderBottom: `1px solid ${colors.borderSubtle}`,
                background: rank === 0 && summary ? 'rgba(180,160,100,0.04)' : 'transparent',
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = rank === 0 && summary ? 'rgba(180,160,100,0.07)' : 'rgba(255,255,255,0.04)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = rank === 0 && summary ? 'rgba(180,160,100,0.04)' : 'transparent'; }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                <span style={{
                  fontSize: fontSize.base, fontWeight: 700, width: 18, textAlign: 'center',
                  fontFamily: fonts.serif,
                  color: rank === 0 && summary ? colors.textGold : colors.textMuted,
                }}>
                  {rank + 1}
                </span>
                <span style={{ ...theme.bodyText, color: colors.textPrimary }}>{team.name}</span>
                <span style={{
                  ...theme.statNum, fontSize: fontSize.base, fontWeight: 600,
                  color: totalColor,
                  marginLeft: 2,
                  fontFamily: fonts.mono,
                }}>
                  {totalLabel}
                </span>
                {summary && summary.cuts > 0 && (
                  <span style={{ fontSize: fontSize.xs, color: colors.textMuted, marginLeft: 4 }}>
                    ({summary.cuts} CUT)
                  </span>
                )}
              </div>
              <PlayerSlotGrid players={players} showLive />
            </div>
          );
        })}
        {/* Footer disclaimer — keep users honest about projection vs. actual */}
        <div style={{
          padding: '6px 14px',
          fontSize: fontSize.xs,
          color: colors.textMuted,
          textAlign: 'center',
          fontStyle: 'italic',
          borderTop: `1px solid ${colors.borderSubtle}`,
        }}>
          Live — updates every 5 minutes. Earnings post when results are finalized.
        </div>
      </div>
    );
  };

  // Helper: build the team-standings JSX for a completed tournament expansion.
  // Used inside an expansion <tr> rendered below each completed row.
  const renderTournamentExpansion = (tournament) => {
    const tIdx = tournaments.indexOf(tournament);
    const results = tournament.results;
    if (!results) {
      return (
        <div style={{ ...theme.emptyState, padding: '14px 14px' }}>
          No result details available
        </div>
      );
    }
    const rankedTeams = teams
      .map(tt => ({ ...tt, result: results.teams?.[tt.id] }))
      .filter(tt => tt.result)
      .sort((a, b) => (b.result.totalEarnings || 0) - (a.result.totalEarnings || 0));

    // Surface empty/sparse results explicitly instead of rendering a zero-row
    // container. After a botched reprocess, results.teams can come back empty
    // — without this message the user just sees a blank gap and can't tell
    // whether the data is missing or whether the panel failed to load.
    if (rankedTeams.length === 0) {
      return (
        <div style={{ ...theme.emptyState, padding: '14px 14px' }}>
          No team results recorded for this tournament. Reprocess it from the Commish tab to populate.
        </div>
      );
    }

    return (
      <div>
        {rankedTeams.map((team, rank) => {
          const tr = team.result;
          // Player list may be empty (e.g. if processTournamentData skipped a
          // team for having no lineup). Still render the team row so totals
          // are visible — just skip the per-player grid in that case.
          const players = Array.isArray(tr.players) && tr.players.length > 0
            ? tr.players
                .map(p => enrich(p, tIdx))
                .sort((a, b) => (b.earnings || 0) - (a.earnings || 0))
            : [];
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
              {players.length > 0 ? (
                <PlayerSlotGrid players={players} showEarnings />
              ) : (
                <div style={{ fontSize: fontSize.sm, color: colors.textMuted, padding: '4px 0 6px 24px', fontStyle: 'italic' }}>
                  No lineup recorded for this team
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  const renderTable = (list, kind = 'upcoming') => (
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
          // Active (currently-playing) tournaments are also expandable — they
          // show submitted lineups + live positions instead of completed-event
          // earnings. Completed tournaments keep the existing earnings view.
          const isActive = t.playing && !t.completed;
          const isExpandable = !editMode && (kind === 'completed' || isActive);
          const isExpanded = isExpandable && expandedTournament === t.name;
          return (
            <React.Fragment key={t.name}>
            <tr
              style={{
                // Fixed row height accommodates tournament names that spill
                // to a 2nd line, so every row reads as the same size whether
                // its name is short or long. Single-line rows vertically
                // center via td default vertical-align: middle.
                height: 56,
                borderBottom: `1px solid ${colors.borderSubtle}`,
                opacity: alt ? 0.45 : 1,
                transition: 'background 0.15s',
                cursor: isExpandable ? 'pointer' : 'default',
                background: isExpanded ? 'rgba(255,255,255,0.04)' : 'transparent',
              }}
              onClick={isExpandable ? () => toggleExpansion(t.name) : undefined}
              onMouseEnter={e => { e.currentTarget.style.background = isExpanded ? 'rgba(255,255,255,0.06)' : colors.rowHover; }}
              onMouseLeave={e => { e.currentTarget.style.background = isExpanded ? 'rgba(255,255,255,0.04)' : 'transparent'; }}
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
                  {t.completed && !isExpandable && (
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

              {/* Location + course — stacked: city/state on top, course below.
                  For completed events, a chevron sits at the right edge to
                  indicate the row is expandable. */}
              <td style={{ padding: '8px 8px 8px 6px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{
                    flex: 1, minWidth: 0,
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
                  {isExpandable && (
                    isExpanded
                      ? <ChevronDown style={{ width: 14, height: 14, color: colors.textSecondary, flexShrink: 0 }} />
                      : <ChevronRight style={{ width: 14, height: 14, color: colors.textMuted, flexShrink: 0 }} />
                  )}
                </div>
              </td>
            </tr>
            {/* Expansion row — team standings + player breakdowns inline.
                Routes to the active renderer when the tournament is currently
                being played (shows live positions), otherwise the completed
                renderer (shows earnings). */}
            {isExpanded && (
              <tr>
                <td colSpan={4} style={{ padding: 0, background: 'rgba(0,0,0,0.15)', borderBottom: `1px solid ${colors.borderSubtle}` }}>
                  {isActive ? renderActiveTournamentExpansion(t) : renderTournamentExpansion(t)}
                </td>
              </tr>
            )}
            </React.Fragment>
          );
        })}
      </tbody>
    </table>
  );

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
        <div style={{ overflowX: 'auto' }}>{renderTable(upcoming, 'upcoming')}</div>
      </div>

      {/* ── Completed ──
          Uses the same row template as Upcoming. Completed rows are clickable —
          tapping anywhere on the row toggles a chevron and reveals the team
          standings + player breakdown directly below. The most recent completed
          event auto-expands on first load. */}
      {completed.length > 0 && (
        <div style={theme.card}>
          <div style={sectionHeaderStyle}>
            <Trophy style={{ width: 15, height: 15, color: colors.textGold }} />
            <span style={sectionTitleStyle}>Completed Events</span>
          </div>
          <div style={{ overflowX: 'auto' }}>{renderTable(completed, 'completed')}</div>
        </div>
      )}
    </div>
  );
};
