import React, { useState, useEffect, useMemo } from 'react';
import { Calendar, Trophy, Edit2, Save, ChevronDown, ChevronRight } from 'lucide-react';
import { useDialog } from './DialogContext';

import { theme, colors, fonts, fontSize, SWINGS, getSwingColor, getSwingColorAt } from '../theme.js';
import { getSegmentForTournament, shortName } from '../utils';
import { TeamName } from '../components/TeamName';
import { sfglDataApi } from '../api/firebase';
import { STORAGE_KEYS } from '../constants';
import { TournamentBadges } from './TournamentBadges';

// Alternate-event detection: relies on the explicit `isAlternate` flag the
// commish sets via the "Alt" toggle in the schedule editor.
//
// Previously this also fell back to a keyword-matching list — name-substring
// matching against ['Puerto Rico', 'Zurich', 'Corales', 'Myrtle Beach', 'ISCO',
// 'Barracuda']. That worked when those event names were stable but went stale
// every time the PGA renamed or rescheduled an event, AND it disagreed with
// the strict-flag-only logic used by StandingsView/swingAward/cron — which
// led to subtle inconsistencies (one view treats an event as alternate, the
// other doesn't). Now there's one source of truth: the flag.
const isAlternate = (t) => !!t.isAlternate;

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

// Tier dot color for the 2-column lineup layout: gold = Limited, blue =
// Unlimited, muted = regular. Mirrors playerNameColor but as a solid swatch.
const playerTierColor = (p) => {
  if (p.limited)   return GOLD_BRIGHT;
  if (p.unlimited) return BLUE_BRIGHT;
  return 'rgba(255,255,255,0.28)';
};

// Canonical lineup ordering: Limited first, then Unlimited, then regular;
// alphabetical (by short/last name) within each tier. Applied wherever a
// lineup is rendered so tiers always group consistently across all teams.
// Returns a NEW sorted array — does not mutate the input.
const TIER_RANK = (p) => (p.limited ? 0 : p.unlimited ? 1 : 2);
const sortLineupByTier = (players) =>
  [...players].sort((a, b) => {
    const tr = TIER_RANK(a) - TIER_RANK(b);
    if (tr !== 0) return tr;
    return shortName(a.name).localeCompare(shortName(b.name));
  });

// ── Player slot grid — 5-column layout under each team's row in expansions ──
// Three modes (controlled by props):
//   • showEarnings        — completed tournament: name + $ + round-leader badges
//   • showLive            — active tournament: name + position only
//   • neither             — upcoming: name + "—" placeholder
//
// In `showLive` mode, each player record should have `live` populated with
// the matched leaderboard entry (or be missing it if the player isn't in
// the field or no live data is available yet — handled gracefully below).
const PlayerSlotGrid = ({ players, showEarnings, showLive }) => {
  // Option B layout: a 2-column grid (instead of 5-across), so a full lineup
  // is ~3 rows tall instead of one cramped row. Each cell is a single line:
  //   [tier dot] [player name ...........] [score]
  // The tier dot encodes Limited (gold) / Unlimited (blue) / regular (muted).
  // Players are pre-sorted Limited → Unlimited → regular by the callers, so
  // no re-sort here.
  //
  // Score column behavior:
  //   • showEarnings (completed) → "$1,234,567"
  //   • showLive (active)        → live position (T3 / CUT / WD), or blank if
  //                                no live data yet (pre-tee-off)
  //   • neither (upcoming)       → nothing (name only — no clutter)
  const renderScore = (p) => {
    if (showEarnings) {
      const amt = (p.earnings || 0) + (p.bonus || 0);
      return (
        <span style={{
          ...theme.statNum, fontSize: fontSize.sm,
          color: amt > 0 ? colors.earningsGreen : colors.textMuted,
          flexShrink: 0, fontFamily: fonts.mono,
        }}>
          ${amt.toLocaleString()}
        </span>
      );
    }
    if (showLive) {
      const live = p.live;
      if (!live) return <span style={{ color: colors.textMuted, fontSize: fontSize.xs, flexShrink: 0 }}>—</span>;
      if (live.isCut) return <span style={{ color: colors.textMuted, fontSize: fontSize.xs, fontWeight: 700, flexShrink: 0 }}>CUT</span>;
      if (live.isWD)  return <span style={{ color: colors.textMuted, fontSize: fontSize.xs, fontWeight: 700, flexShrink: 0 }}>WD</span>;
      return (
        <span style={{ fontFamily: fonts.mono, fontSize: fontSize.sm, color: colors.textSecondary, fontWeight: 400, flexShrink: 0 }}>
          {live.position || '—'}
        </span>
      );
    }
    return null; // upcoming: no placeholder
  };

  return (
    <div style={{
      marginLeft: 22,
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      columnGap: 14,
      rowGap: 2,
    }}>
      {players.map((p, idx) => (
        <div key={idx} style={{
          display: 'flex', alignItems: 'center', gap: 7,
          padding: '2px 0', minWidth: 0,
        }}>
          {/* Tier dot */}
          <span style={{
            width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
            background: playerTierColor(p),
          }} />
          {/* Name (+ mulligan flag) */}
          <span style={{
            flex: 1, minWidth: 0,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            fontSize: fontSize.sm,
            color: playerNameColor(p, showEarnings),
          }}>
            {shortName(p.name)}
            {p.mulliganIn && (
              <span title={`Mulligan · replaced ${p.replacedPlayer || '?'}`} style={{
                marginLeft: 3, fontSize: fontSize.sm, lineHeight: 1, verticalAlign: 'middle',
                display: 'inline-block',
                filter: 'drop-shadow(0 0 2px rgba(255,80,80,0.6))',
              }}>🚨</span>
            )}
          </span>
          {/* Score / position / earnings */}
          {renderScore(p)}
          {/* Round-leader badges (completed only) — appended after score */}
          {showEarnings && p.roundsLed?.length > 0 && (
            <span style={{ display: 'inline-flex', gap: 2, flexShrink: 0 }}>
              {p.roundsLed.map((rl, ri) => (
                <span key={ri} style={{
                  padding: '1px 3px',
                  background: 'rgba(220,110,30,0.35)',
                  color: 'rgba(255,165,80,0.95)',
                  borderRadius: 2, fontSize: fontSize.xs, lineHeight: 1.2,
                }}>R{rl.round}</span>
              ))}
            </span>
          )}
        </div>
      ))}
    </div>
  );
};

// Reusable styles for the "UPCOMING EVENTS" / "COMPLETED EVENTS" section
// headers — matches the white-gradient template used on Standings, Transactions
// fees/history, etc.
const sectionHeaderStyle = theme.sectionHeaderBar;

const sectionTitleStyle = theme.sectionTitle;

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
  //
  // Wave J Round 3 improvements:
  //   • Pause polling when the tab is hidden (Page Visibility API), refetch
  //     immediately on re-show. Prevents wasted /api/live calls when the
  //     phone is in someone's pocket all weekend, and gives them fresh data
  //     the moment they re-open the app instead of waiting up to 5 min for
  //     the next tick.
  //   • Track the last successful fetch timestamp so the UI can render
  //     "Updated N min ago" — helps managers see at-a-glance whether the
  //     scoreboard is current.
  const [liveData, setLiveData] = useState(null);
  const [lastLiveFetchAt, setLastLiveFetchAt] = useState(null);
  const activeTournamentForLive = localTournaments.find(t => t.playing && !t.completed);
  useEffect(() => {
    setLiveData(null);
    setLastLiveFetchAt(null);
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
      // A single shared GENERIC word ("open", "championship"...) is not
      // enough to call it a match — otherwise "U.S. Open" matches "RBC
      // Canadian Open". Require a shared DISTINCTIVE word, or 2+ shared words.
      const GENERIC = new Set(['the','presented','open','championship','classic','invitational','challenge','tournament','cup','golf','am','proam']);
      const shared = bw.filter(w => aw.includes(w));
      const distinctiveShared = shared.filter(w => !GENERIC.has(w));
      return distinctiveShared.length >= 1 || shared.length >= 2;
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
          setLastLiveFetchAt(Date.now());
        })
        .catch(() => {});
    };

    // Visibility handler: pause interval when hidden, fetch+resume on show.
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        if (interval) { clearInterval(interval); interval = null; }
      } else {
        // Tab became visible — refetch immediately and resume polling
        fetchLive();
        if (!interval) interval = setInterval(fetchLive, 5 * 60 * 1000);
      }
    };

    // Initial fetch + start interval only if tab is currently visible
    fetchLive();
    if (document.visibilityState !== 'hidden') {
      interval = setInterval(fetchLive, 5 * 60 * 1000);
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
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

  // Format a timestamp as "X min ago" / "just now" — used in the active
  // tournament expansion footer to surface freshness of live scoreboard data.
  // Granularity: under-a-minute → "just now"; < 1h → "Nm ago"; ≥1h → "Nh ago".
  // We re-derive this on each render rather than ticking on an interval —
  // re-renders happen frequently enough (poll, visibility events) that a
  // separate ticker would be overkill for a casual freshness indicator.
  const formatRelative = (ts) => {
    if (!ts) return '';
    const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (diffSec < 30) return 'just now';
    if (diffSec < 60) return `${diffSec}s ago`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    return `${diffHr}h ago`;
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

  // Wave J Round 4 — Edit Schedule: enable any-row edits.
  // Previously edit mode only supported field changes on existing rows; rows
  // could not be added or deleted from the UI. Now the commish can fully
  // manage the schedule in this view without touching Firestore directly.
  const deleteRow = async (index) => {
    const t = localTournaments[index];
    if (!t) return;
    if (t.completed) {
      dialog.showToast(`Can't delete "${t.name}" — it has processed results. Reprocess to clear first if needed.`, 'error');
      return;
    }
    const ok = await dialog.showConfirm(
      'Delete tournament',
      `Remove "${t.name}" from the schedule? You can re-add it later, but lineup history tied to it would be lost.`,
      { type: 'danger', confirmText: 'Delete', cancelText: 'Cancel' }
    );
    if (!ok) return;
    setLocalTournaments(prev => prev.filter((_, i) => i !== index));
  };

  const addRow = () => {
    // Find the latest start date to seed the new row a week later — keeps the
    // newly-added row near the bottom of the schedule rather than top.
    const latest = [...localTournaments]
      .filter(t => t.start_date)
      .sort((a, b) => String(b.start_date).localeCompare(String(a.start_date)))[0];
    let seedDate = '';
    if (latest?.start_date) {
      const d = new Date(latest.start_date + 'T12:00:00Z');
      if (!isNaN(d.getTime())) {
        d.setUTCDate(d.getUTCDate() + 7);
        seedDate = d.toISOString().slice(0, 10);
      }
    }
    // Generate a placeholder name that's unique. The name field is used as
    // the Firestore doc ID (tournamentsApi.setAll), so duplicates would
    // collapse on save — we add a numeric suffix to avoid that.
    let baseName = 'New Tournament';
    let candidate = baseName;
    let n = 2;
    const existing = new Set(localTournaments.map(t => t.name));
    while (existing.has(candidate)) { candidate = `${baseName} ${n++}`; }
    setLocalTournaments(prev => [
      ...prev,
      {
        name: candidate,
        dates: '',
        location: '',
        course: '',
        start_date: seedDate,
        completed: false,
        playing: false,
        isSignature: false,
        isMajor: false,
        isAlternate: false,
        segment: null,
        lockHour: 7,
        results: null,
      },
    ]);
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
  // Active (in-progress) tournament badge. Designed to be clearly distinct
  // from a static date label — fantasy managers should be able to spot the
  // live event the moment they open the tab.
  //
  // Three states:
  //   • Pre-tournament (liveData null or state 'pre') → "Next", calm, no dot.
  //     The active tournament has been set but no player has teed off yet.
  //   • Live (liveData state === 'in') → "Live", pulsing red dot.
  //     /api/live flips state to 'in' as soon as any player has a thru value
  //     ('F', a number, CUT, or WD), so this updates within the live-fetch
  //     interval (5 min) of the first tee-off.
  //   • Final (liveData state === 'post') → "Final", static. The event has
  //     concluded on tour but SFGL results haven't been processed yet —
  //     /api/live keeps serving the final board labeled with the completed
  //     event's name, so managers keep seeing final positions until the
  //     results cron runs.
  //
  // Visual urgency comes from the pulsing red dot — by reserving it for the
  // "Live" state only, the affordance carries real meaning.
  const StatusBadge = ({ tournament }) => {
    const isActive = tournament.playing && !tournament.completed;
    if (!isActive) return null;

    // Tint the badge with the tournament's swing color so it visually
    // reads as belonging to that swing. Falls back gracefully to the
    // default green-tinted look when the segment can't be resolved
    // (getSwingColorAt returns a neutral white rgba for unknown swings).
    const segment = getSegmentForTournament(tournament);
    // Default to pre-tournament when liveData is null (initial load, fetch
    // failure, or genuinely no players started). The badge reads as "This
    // week" until /api/live confirms play has begun.
    const hasStarted = liveData?.state === 'in';
    const isFinal    = liveData?.state === 'post';

    return (
      <span style={{
        ...theme.badge,
        background: getSwingColorAt(segment, 0.18),
        border:    `1px solid ${getSwingColorAt(segment, 0.50)}`,
        color:      getSwingColorAt(segment, 0.95),
        padding: '3px 6px',
        fontSize: fontSize.xs,
        fontWeight: 700,
        letterSpacing: 0.3,
        textTransform: 'uppercase',
        gap: 4,
        whiteSpace: 'nowrap',
        display: 'inline-flex',
        alignItems: 'center',
      }}>
        {hasStarted && (
          // Pulsing red dot — universal "live now" indicator. The pulse uses
          // the shared sfgl-pulse keyframes already defined in app-global.css
          // (originally used by the loading-screen logo). Faster pulse cycle
          // for active broadcast-style urgency.
          <span style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: 'rgb(220, 60, 60)',
            boxShadow: '0 0 4px rgba(220,60,60,0.7)',
            animation: 'sfgl-pulse 1.4s ease-in-out infinite',
            flexShrink: 0,
          }} />
        )}
        {hasStarted ? 'Live' : isFinal ? 'Final' : 'Next'}
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

    // Per-team aggregate score (sum of live tournament-cumulative scores;
    // under par = better, lower = better rank).
    //
    // Confirmed against /api/live (api/live.js line 136-138): `live.score` is
    // derived from `scoringData.total` which is the player's CUMULATIVE
    // tournament-relative-to-par (e.g. "-5" through 3 rounds = combined -5).
    // The endpoint ALSO exposes `live.totalScore` as a pre-parsed number;
    // we use the numeric form here to avoid string parsing every render and
    // to be unambiguous about what we're summing.
    //
    // Returns null when nothing in the lineup has any live data yet (e.g.
    // pre-tournament Wednesday before tee times), so the UI can show "—"
    // rather than a misleading "E".
    const teamScoreSummary = (lineup) => {
      const liveStarters = lineup
        .map(name => liveByName?.find(name))
        .filter(lp => lp && !lp.isCut && !lp.isWD);
      if (liveStarters.length === 0) return null;
      // Prefer totalScore numeric; fall back to parsing live.score for safety
      // in case an older live.js endpoint doesn't expose totalScore yet.
      const toNum = (lp) => {
        if (typeof lp.totalScore === 'number') return lp.totalScore;
        const s = lp.score;
        if (!s || s === 'E') return 0;
        const n = parseInt(s, 10);
        return isNaN(n) ? 0 : n;
      };
      const total = liveStarters.reduce((sum, lp) => sum + toNum(lp), 0);
      const cuts = lineup.filter(name => {
        const lp = liveByName?.find(name);
        return lp?.isCut || lp?.isWD;
      }).length;
      return { total, cuts, livePlayers: liveStarters.length };
    };

    // Whether play has actually begun. Mirrors StatusBadge: `liveData.state`
    // flips to 'in' as soon as any player has teed off, and to 'post' once
    // the event has concluded on tour (final board, results not yet
    // processed). Both mean real positions exist. Used to gate the
    // rank-number display — before the tournament starts, "rank" is just
    // "whoever submitted a lineup with non-zero placeholder," which isn't
    // meaningful. Once play begins, rank reflects actual cumulative score.
    const hasStarted = liveData?.state === 'in' || liveData?.state === 'post';

    // Rank teams: best (lowest) sum first; teams with no live data or no
    // lineup sort last. Pre-tournament, all teams sort together at the
    // bottom (no summary), and we render them in their original league order
    // so the list is stable.
    const rankedTeams = teams
      .map(team => {
        const lineup = Array.isArray(team.lineup) ? team.lineup : [];
        const summary = teamScoreSummary(lineup);
        return { ...team, lineup, summary };
      })
      .sort((a, b) => {
        // Teams with no live summary sort last (push nulls down)
        if (a.summary === null && b.summary === null) return 0;
        if (a.summary === null) return 1;
        if (b.summary === null) return -1;
        return a.summary.total - b.summary.total;
      });

    return (
      <div>
        {rankedTeams.map((team, rank) => {
          const lineup = team.lineup;
          const players = sortLineupByTier(lineup.map(enrichForActive));
          const summary = team.summary;
          const hasLineup = lineup.length > 0;
          // Display team-aggregate score: "+5" / "-3" / "E", or "—" if nothing live.
          let totalLabel = '—';
          let totalColor = colors.textMuted;
          if (summary !== null) {
            const t = summary.total;
            totalLabel = t === 0 ? 'E' : t > 0 ? `+${t}` : `${t}`;
            // Golf-traditional: under par is red, over is muted, even is primary
            totalColor = t < 0 ? colors.danger : t > 0 ? colors.textMuted : colors.textPrimary;
          }
          // Highlight the leader only once play has actually begun.
          const isLeader = hasStarted && rank === 0 && summary;
          return (
            <div key={team.id}
              style={{
                padding: '6px 14px',
                borderBottom: `1px solid ${colors.borderSubtle}`,
                background: isLeader ? 'rgba(180,160,100,0.04)' : 'transparent',
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = isLeader ? 'rgba(180,160,100,0.07)' : 'rgba(255,255,255,0.04)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = isLeader ? 'rgba(180,160,100,0.04)' : 'transparent'; }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                {/* Rank number only renders once the tournament has started.
                    Before play begins, "rank" is meaningless (all teams tied
                    at zero or have no live data), so showing #1–#5 would be
                    misleading. */}
                {hasStarted && (
                  <span style={{
                    fontSize: fontSize.base, fontWeight: 700, width: 18, textAlign: 'center',
                    fontFamily: fonts.serif,
                    color: isLeader ? colors.textGold : colors.textMuted,
                  }}>
                    {rank + 1}
                  </span>
                )}
                <span style={{ ...theme.bodyText, color: colors.textPrimary }}><TeamName name={team.name} /></span>
                {hasStarted && (
                  <span style={{
                    ...theme.statNum, fontSize: fontSize.base, fontWeight: 600,
                    color: totalColor,
                    marginLeft: 2,
                    fontFamily: fonts.mono,
                  }}>
                    {totalLabel}
                  </span>
                )}
                {hasStarted && summary && summary.cuts > 0 && (
                  <span style={{ fontSize: fontSize.xs, color: colors.textMuted, marginLeft: 4 }}>
                    ({summary.cuts} CUT)
                  </span>
                )}
              </div>
              {hasLineup ? (
                <PlayerSlotGrid players={players} showLive />
              ) : (
                // No lineup yet — show a quiet status line instead of an
                // empty grid. This makes the "5 teams visible" goal useful:
                // the commish can see at a glance who hasn't set a lineup.
                <div style={{
                  fontFamily: fonts.sans, fontSize: fontSize.sm,
                  color: colors.textMuted, fontStyle: 'italic',
                  padding: '4px 0 2px',
                }}>
                  No lineup submitted yet
                </div>
              )}
            </div>
          );
        })}
        {/* Footer disclaimer + last-updated indicator. Shows how stale the
            data is so the user can trust the scoreboard. Re-renders every
            30s via the parent's poll cycle and visibility change. */}
        <div style={{
          padding: '6px 14px',
          fontSize: fontSize.xs,
          color: colors.textMuted,
          textAlign: 'center',
          fontStyle: 'italic',
          borderTop: `1px solid ${colors.borderSubtle}`,
        }}>
          {lastLiveFetchAt ? (
            <>Updated {formatRelative(lastLiveFetchAt)} · auto-refreshes every 5 min · earnings post when results are finalized</>
          ) : (
            <>Loading live scores… · earnings post when results are finalized</>
          )}
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
            ? sortLineupByTier(tr.players.map(p => enrich(p, tIdx)))
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
                <span style={{ ...theme.bodyText, color: colors.textPrimary }}><TeamName name={team.name} /></span>
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
            ['Active', 'Type', 'Tournament', 'Dates', 'Location / Course', 'Swing', 'Lock', ''].map((h, i) => (
              <th key={h || `c${i}`} style={{ ...theme.tableHeaderCell, fontSize: fontSize.sm }}>{h}</th>
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
                      // activeBg is a ready-to-use color — activeColor values are
                      // full rgba()/hex strings, so wrapping them in another
                      // rgba(..., 0.15) produced invalid CSS (no tint rendered).
                      { badge: 'S', key: 'isSignature', activeColor: 'rgba(130,80,200,0.8)', activeBorder: 'rgba(130,80,200,0.5)', activeBg: 'rgba(130,80,200,0.15)' },
                      { badge: 'M', key: 'isMajor',     activeColor: colors.textGold,         activeBorder: colors.border,          activeBg: 'rgba(245,197,24,0.15)' },
                      { badge: 'Alt', key: 'isAlternate', activeColor: colors.danger,           activeBorder: colors.dangerBorder,    activeBg: 'rgba(220,80,80,0.15)' },
                    ].map(({ badge, key, activeColor, activeBorder, activeBg }) => {
                      const active = t[key];
                      return (
                        <button key={badge} onClick={() => updateLocal(realIndex, { [key]: !active })}
                          style={{
                            width: badge === 'Alt' ? 28 : 22, height: 22,
                            borderRadius: 2, fontFamily: fonts.sans,
                            fontSize: fontSize.xs, fontWeight: 700, cursor: 'pointer',
                            transition: 'all 0.15s',
                            background: active ? activeBg : 'rgba(255,255,255,0.04)',
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

                {/* Delete row — Wave J Round 4. Refuses to delete tournaments
                    with processed results (they have data tied to them that
                    matters historically). Confirms before deleting otherwise. */}
                <td style={{ padding: '8px 6px', textAlign: 'center' }}>
                  <button
                    onClick={() => deleteRow(realIndex)}
                    disabled={t.completed}
                    title={t.completed ? 'Completed tournaments cannot be deleted from the UI' : `Delete ${t.name}`}
                    style={{
                      background: 'transparent',
                      border: `1px solid ${t.completed ? colors.borderSubtle : 'rgba(220,60,60,0.3)'}`,
                      borderRadius: 3,
                      color: t.completed ? colors.textMuted : 'rgba(220,60,60,0.9)',
                      cursor: t.completed ? 'not-allowed' : 'pointer',
                      width: 24, height: 24,
                      fontSize: 14, lineHeight: 1,
                      opacity: t.completed ? 0.4 : 1,
                    }}
                  >
                    ✕
                  </button>
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

              {/* Dates — or status badge for active tournament. Cell is
                  width-constrained so the "This week" badge doesn't push
                  into the Location column on narrow viewports. */}
              <td style={{ padding: '8px 6px', whiteSpace: 'nowrap', maxWidth: 88, width: 88 }}>
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
        {/* Add row — visible only in edit mode and only for the upcoming
            table (so a new event lands among future events, not in the
            completed history). Renders as a single full-width "+ Add
            Tournament" button row matching the table's edit chrome. */}
        {editMode && kind === 'upcoming' && (
          <tr>
            <td colSpan={8} style={{ padding: '10px 8px', textAlign: 'center', borderTop: `1px dashed ${colors.borderSubtle}` }}>
              <button
                onClick={addRow}
                style={{
                  ...theme.btnSecondary,
                  padding: '6px 14px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  cursor: 'pointer',
                }}
              >
                <span style={{ fontSize: 14, lineHeight: 1, fontWeight: 700 }}>+</span>
                Add Tournament
              </button>
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* ── Edit / Save / Cancel buttons (commissioner only) ──
          In view mode: single Edit Schedule button.
          In edit mode: Cancel (discards local changes) + Save Changes (commits).
          Cancel rolls localTournaments back to the latest tournaments prop,
          so any in-flight edits are dropped. Useful when you tap Edit by
          mistake or change your mind mid-edit. */}
      {isCommissioner && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          {editMode && (
            <button
              onClick={() => {
                setLocalTournaments(tournaments);  // discard local edits
                setEditMode(false);
              }}
              style={{
                ...theme.btnSecondary,
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '8px 14px', flexShrink: 0,
              }}
            >
              Cancel
            </button>
          )}
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
