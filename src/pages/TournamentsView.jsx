import React, { useState, useEffect, useMemo } from 'react';
import { Calendar, Trophy, Edit2, Save, ChevronDown, ChevronRight } from 'lucide-react';
import { useDialog } from './DialogContext';

import { theme, colors, fonts, fontSize, SWINGS, getSwingColor, getSwingColorAt, black, brass, gold, purple, red, white, blueBright } from '../theme.js';
import { getSegmentForTournament, segmentSource, seedSegments, shortName, getTournamentLockHourET, getTournamentTimezone } from '../utils';
import { fmtETTime } from '../../api/_league.js';
import { NameMap } from '../../api/_playerNames.js';
import { TeamName } from '../components/TeamName';
import { sfglDataApi } from '../api/firebase';
import { STORAGE_KEYS } from '../constants';
import { TournamentBadges } from './TournamentBadges';
import { useIsMobile } from '../hooks/useIsMobile.js';

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
const GOLD_DIM    = gold(0.35);
const BLUE_BRIGHT = blueBright(0.95);
const BLUE_DIM    = blueBright(0.35);

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
  return white(0.28);
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
  teams = [],
  transactions = [],
}) => {
  const [editMode,         setEditMode]         = useState(false);
  // The schedule editor is a card list below 900px and a table above it — see
  // renderEditCards. 900 rather than the app's usual 640 because this table
  // carries eight editable fields and genuinely needs ~1140px; between 640 and
  // 900 it would technically render, but only behind a horizontal scrollbar.
  // Reactive, so rotating a tablet lands on the other layout.
  const useCardEditor = useIsMobile(900);
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

  // Leaderboard row lookup, keyed by player identity (api/_playerNames.js).
  //
  // This replaces a local normalizer plus a three-stage fuzzy cascade — exact,
  // then LAST NAME ONLY (any surname ≥4 characters), then SUBSTRING. Unlike
  // the equivalent in RostersView, this one had no in-field gate, so any
  // rostered player could inherit a same-surname leaderboard row: with both
  // Coody brothers entered, whichever the board listed first was handed to
  // both. NameMap resolves the abbreviated 'V. Hovland' rendering those
  // fallbacks were actually for, and returns null when a name is genuinely
  // ambiguous rather than picking the first hit.
  const liveByName = useMemo(() => {
    if (!liveData?.players?.length) return null;
    const map = new NameMap(liveData.players.map(lp => [lp.name, lp]));
    return { find: (rosterName) => map.get(rosterName) ?? null };
  }, [liveData]);

  // ── Schedule editing logic (existing) ─────────────────────────────────────
  // Format a timestamp as "X min ago" / "just now" — used in the active
  // tournament expansion footer to surface freshness of live scoreboard data.
  // Granularity: under-a-minute → "just now"; < 1h → "Nm ago"; ≥1h → "Nh ago".
  // We re-derive this on each render rather than ticking on an interval —
  // re-renders happen frequently enough (poll, visibility events) that a
  // separate ticker would be overkill for a casual freshness indicator.
  const formatRelative = (ts) => {
    if (!ts) return '';
    // Deliberate clock read during render — this is a "last updated N min ago"
    // freshness label. It's recomputed on the poll tick and on visibility
    // change, which is exactly the cadence we want; a dedicated ticker would
    // re-render the whole tab once a second for a casual indicator.
    // eslint-disable-next-line react-hooks/purity
    const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (diffSec < 30) return 'just now';
    if (diffSec < 60) return `${diffSec}s ago`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    return `${diffHr}h ago`;
  };

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

  // Re-seed every swing from the current schedule order. Local-only until Save,
  // so the commissioner can seed, nudge the boundaries, and review before any
  // of it reaches Firestore.
  const seedSwings = () => {
    setLocalTournaments(prev => seedSegments(prev));
    dialog.showToast('Swings seeded — adjust the boundaries, then Save Changes.', 'success');
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
        // Both left unset on purpose. segment shows "⚠ not set" until the
        // commish picks one, rather than silently inheriting a month guess;
        // lockHour is an override, so unset means Auto (derived from the
        // course timezone) rather than pinned to the 7am Eastern default.
        segment: null,
        lockHour: null,
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
                background: isLeader ? brass(0.04) : 'transparent',
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = isLeader ? brass(0.07) : white(0.04); }}
              onMouseLeave={e => { e.currentTarget.style.background = isLeader ? brass(0.04) : 'transparent'; }}
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
                background: rank === 0 ? brass(0.04) : 'transparent',
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = rank === 0 ? brass(0.07) : white(0.04); }}
              onMouseLeave={e => { e.currentTarget.style.background = rank === 0 ? brass(0.04) : 'transparent'; }}
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

  // ── Edit-mode field controls ──────────────────────────────────────────────
  // Each field is defined ONCE and composed twice: into <td>s by the desktop
  // table, and into labelled blocks by the phone card list. The two used to be
  // one eight-column table at every width, which is what the commish was
  // looking at on a phone: `tableLayout: fixed` splits 100% of a 390px viewport
  // eight ways, so every column got ~44px and every header and input painted
  // straight over its neighbour. "Tournament" sat on top of "Dates", the
  // location input overlapped the swing dropdown, and the Lock column ran off
  // the screen entirely.
  //
  // These are plain functions returning JSX, NOT components. A component
  // declared inside a render is a brand-new type on every render, so React
  // unmounts and remounts its <input> — and the field loses focus after each
  // keystroke.
  //
  // `compact` is the desktop treatment: bare underlines sized to fit eight
  // columns. The card layout uses the shared theme.input / theme.select, whose
  // 16px is the size that stops iOS zooming the viewport on focus and never
  // zooming back out (see the note on theme.input) — the compact 13px inputs
  // did exactly that on every tap.

  const compactInput = {
    boxSizing: 'border-box',
    background: 'transparent',
    border: 'none', borderBottom: `1px solid ${colors.borderInput}`,
    width: '100%', fontFamily: fonts.sans, fontSize: fontSize.base,
    color: colors.textPrimary, padding: '2px 0',
  };

  const fieldLabel = {
    fontFamily: fonts.sans, fontSize: fontSize.xs, fontWeight: 600,
    letterSpacing: '1.5px', textTransform: 'uppercase',
    color: colors.textLabel, marginBottom: 4, display: 'block',
  };

  const textField = (t, i, key, placeholder, compact, extra = {}) => (
    <input
      value={t[key] || ''}
      onChange={e => updateLocal(i, { [key]: e.target.value })}
      placeholder={placeholder}
      aria-label={placeholder}
      style={compact ? { ...compactInput, ...extra } : { ...theme.input, ...extra }}
    />
  );

  // The active-event radio. One event at a time, so checking one clears the
  // rest — the same mutual exclusion the checkbox always enforced by hand.
  const activeToggle = (t, i) => (
    <input
      type="checkbox"
      checked={t.playing && !t.completed}
      aria-label={`Mark ${t.name} as the active event`}
      onChange={e => {
        const updated = localTournaments.map(x => ({ ...x, playing: false }));
        if (e.target.checked && !t.completed) updated[i].playing = true;
        setLocalTournaments(updated);
      }}
      style={{ accentColor: colors.textGold, width: 16, height: 16, cursor: 'pointer', flexShrink: 0 }}
    />
  );

  const typeBadges = (t, i) => (
    <div style={{ display: 'flex', gap: 4 }}>
      {/* activeBg is spelled out per badge rather than derived from activeColor.
          It used to be `rgba(${activeColor}, 0.15)` where activeColor was
          already a full colour — `rgba(rgba(130,80,200,0.8), 0.15)`, which is
          not a colour, so the browser dropped the declaration and a selected
          badge got no fill at all. */}
      {[
        { badge: 'S', key: 'isSignature', label: 'Signature event',
          activeColor: purple(0.8), activeBorder: purple(0.5), activeBg: purple(0.15) },
        { badge: 'M', key: 'isMajor', label: 'Major',
          activeColor: colors.textGold, activeBorder: colors.border, activeBg: gold(0.15) },
        { badge: 'Alt', key: 'isAlternate', label: 'Alternate event',
          activeColor: colors.danger, activeBorder: colors.dangerBorder, activeBg: colors.dangerBg },
      ].map(({ badge, key, label, activeColor, activeBorder, activeBg }) => {
        const active = t[key];
        return (
          <button key={badge} onClick={() => updateLocal(i, { [key]: !active })}
            title={label}
            aria-pressed={!!active}
            style={{
              width: badge === 'Alt' ? 30 : 24, height: 24,
              borderRadius: 2, fontFamily: fonts.sans,
              fontSize: fontSize.xs, fontWeight: 700, cursor: 'pointer',
              transition: 'all 0.15s', flexShrink: 0,
              background: active ? activeBg : white(0.04),
              border: `1px solid ${active ? activeBorder : colors.borderSubtle}`,
              color: active ? activeColor : colors.textMuted,
            }}
          >
            {badge}
          </button>
        );
      })}
    </div>
  );

  // An unset swing is NOT a safe default, so it is drawn as a warning rather
  // than as a neutral placeholder. The fallback behind it maps calendar
  // quarters and cannot return 'Fall Finish' for a Jan-Aug season, so a row
  // left unset can only drift out of Fall Finish and into Summer — silently,
  // and early-paying that swing's pot when it does.
  const swingSelect = (t, i, compact) => {
    const explicit = segmentSource(t) === 'explicit';
    return (
      <select
        value={t.segment || ''}
        onChange={e => updateLocal(i, { segment: e.target.value || null })}
        aria-label={`Swing for ${t.name}`}
        title={explicit
          ? undefined
          : `Not set — currently falling back to "${getSegmentForTournament(t) || 'nothing'}" from the month. Pick a swing.`}
        style={{
          ...theme.select,
          // Tighter than theme.select's 14px sides: this box shares a line with
          // the dates field, and "West Coast Swing" — the longest of the four —
          // needs every pixel of it or the label truncates mid-word.
          ...(compact ? { fontSize: fontSize.base, padding: '5px 8px', minWidth: 110 } : { padding: '9px 10px' }),
          background: colors.selectBg,
          color: explicit ? colors.textPrimary : red(0.95),
          border: explicit ? theme.select.border : `1px solid ${red(0.6)}`,
          appearance: 'none',
          WebkitAppearance: 'none',
        }}
      >
        <option value="">⚠ not set</option>
        {SWINGS.map(s => <option key={s} value={s}>{s}</option>)}
      </select>
    );
  };

  // Unset must NOT display as 7:00 AM. The default is derived from the course
  // timezone, so an unset Pebble Beach really locks at 9 — showing "7:00 AM
  // (default)" stated the wrong deadline for every non-ET event. Blank means
  // Auto, and names the hour Auto resolves to.
  const lockSelect = (t, i, compact) => (
    <select
      value={Number.isInteger(t.lockHour) ? t.lockHour : ''}
      onChange={e => updateLocal(i, {
        lockHour: e.target.value === '' ? null : parseInt(e.target.value, 10),
      })}
      aria-label={`Lineup lock hour for ${t.name}`}
      style={{
        ...theme.select,
        ...(compact ? { fontSize: fontSize.base, padding: '5px 8px', minWidth: 90 } : {}),
        background: colors.selectBg,
        color: colors.textPrimary,
        appearance: 'none',
        WebkitAppearance: 'none',
      }}
    >
      <option value="">Auto — {fmtETTime(getTournamentLockHourET({ ...t, lockHour: null }))} ({getTournamentTimezone(t)})</option>
      {[7, 8, 9, 10, 11, 12].map(h => (
        <option key={h} value={h}>{fmtETTime(h)}</option>
      ))}
    </select>
  );

  // Refuses to delete a tournament with processed results — there is data tied
  // to it that matters historically.
  const deleteButton = (t, i, wide = false) => (
    <button
      onClick={() => deleteRow(i)}
      disabled={t.completed}
      title={t.completed ? 'Completed tournaments cannot be deleted from the UI' : `Delete ${t.name}`}
      aria-label={`Delete ${t.name}`}
      style={{
        background: 'transparent',
        border: `1px solid ${t.completed ? colors.borderSubtle : colors.dangerBorder}`,
        borderRadius: 3,
        color: t.completed ? colors.textMuted : colors.danger,
        cursor: t.completed ? 'not-allowed' : 'pointer',
        width: wide ? 32 : 24, height: wide ? 32 : 24,
        fontSize: fontSize.md, lineHeight: 1, flexShrink: 0,
        opacity: t.completed ? 0.4 : 1,
      }}
    >
      ✕
    </button>
  );

  const addTournamentButton = (full = false) => (
    <button
      onClick={addRow}
      style={{
        ...theme.btnSecondary,
        padding: '8px 14px',
        display: full ? 'flex' : 'inline-flex',
        width: full ? '100%' : undefined,
        justifyContent: 'center',
        alignItems: 'center',
        gap: 6,
        cursor: 'pointer',
      }}
    >
      <span style={{ fontSize: fontSize.md, lineHeight: 1, fontWeight: 700 }}>+</span>
      Add Tournament
    </button>
  );

  // ── Edit mode, phone ──────────────────────────────────────────────────────
  // One card per event, fields stacked and labelled. Nothing is truncated and
  // nothing scrolls sideways: the constraint a table cannot satisfy at 390px is
  // that eight fields have to share one line, so the card stops trying.
  const renderEditCards = (list, kind) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 10 }}>
      {list.map(t => {
        const i = localTournaments.findIndex(lt => lt.name === t.name);
        const isActive = t.playing && !t.completed;
        return (
          <div key={t.name} style={{
            border: `1px solid ${isActive ? colors.border : colors.borderSubtle}`,
            borderRadius: 6,
            background: isActive ? white(0.04) : colors.cardBg,
            padding: 12,
            display: 'flex', flexDirection: 'column', gap: 10,
            opacity: isAlternate(t) ? 0.6 : 1,
          }}>
            {/* Header: active toggle + type badges + delete */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <label style={{
                display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
                fontFamily: fonts.sans, fontSize: fontSize.caption, fontWeight: 600,
                letterSpacing: '1px', textTransform: 'uppercase',
                color: isActive ? colors.textGold : colors.textLabel,
              }}>
                {activeToggle(t, i)}
                Active
              </label>
              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
                {typeBadges(t, i)}
                {deleteButton(t, i, true)}
              </div>
            </div>

            <div>
              <span style={fieldLabel}>Tournament</span>
              {textField(t, i, 'name', 'Tournament name', false, { fontFamily: fonts.serif })}
            </div>

            {/* Dates and swing share a line — both are short, and pairing them
                keeps the card from becoming a column of eight full-width
                boxes the commish has to scroll through. */}
            {/* Dates and swing pair up only when both fit. 168px is what the
                swing dropdown needs to show "West Coast Swing", the longest of
                the four, without truncating it — below that auto-fit drops to
                one column and each takes the full card.
                
                minmax(…, 1fr) rather than a fixed fraction because a grid
                item's default min-width is min-content, and a <select>'s
                min-content is its longest option: a plain `1fr 1fr` let the
                swing box widen past the card and clip its own label. */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(168px, 1fr))', gap: 10 }}>
              <div style={{ minWidth: 0 }}>
                <span style={fieldLabel}>Dates</span>
                {textField(t, i, 'dates', 'Aug 20-23', false)}
              </div>
              <div style={{ minWidth: 0 }}>
                <span style={fieldLabel}>Swing</span>
                {swingSelect(t, i, false)}
              </div>
            </div>

            {/* One label over both, matching the desktop column. Two labels for
                two lines of the same address is a row of vertical space the
                card cannot spare. */}
            <div>
              <span style={fieldLabel}>Location / course</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {textField(t, i, 'location', 'City, ST', false)}
                {/* Subordinate by SIZE, not by colour: a muted course name in
                    its own box reads as a placeholder or a disabled field. */}
                {textField(t, i, 'course', 'Course name', false, { fontSize: fontSize.md })}
              </div>
            </div>

            <div>
              <span style={fieldLabel}>Lineup lock</span>
              {lockSelect(t, i, false)}
            </div>
          </div>
        );
      })}
      {list.length === 0 && (
        <div style={{
          fontFamily: fonts.sans, fontSize: fontSize.base, color: colors.textMuted,
          textAlign: 'center', padding: '12px 0', fontStyle: 'italic',
        }}>
          No events here yet.
        </div>
      )}
      {kind === 'upcoming' && addTournamentButton(true)}
    </div>
  );

  // ── Edit mode, desktop ────────────────────────────────────────────────────
  // The eight-column table, with the column widths it never had. `minWidth`
  // is what makes the wrapper's overflowX real: without it the table shrank to
  // 100% of whatever it was given and the cells overlapped instead of the
  // container scrolling.
  const renderEditTable = (list, kind) => (
    <table style={{ width: '100%', minWidth: 1140, borderCollapse: 'collapse', tableLayout: 'fixed' }}>
      {/* Widths measured against what each column actually holds: the ACTIVE
          header at its letter-spacing, "West Coast Swing", and "Auto — 8:00 AM
          (CT)" are the three that decide it. Tournament is the auto column, so
          it absorbs whatever the viewport has beyond the 1140 minimum. */}
      <colgroup>
        <col style={{ width: 76 }} />
        <col style={{ width: 104 }} />
        <col />
        <col style={{ width: 112 }} />
        <col style={{ width: '20%' }} />
        <col style={{ width: 162 }} />
        <col style={{ width: 182 }} />
        <col style={{ width: 46 }} />
      </colgroup>
      <thead>
        <tr>
          {['Active', 'Type', 'Tournament', 'Dates', 'Location / Course', 'Swing', 'Lock', ''].map((h, i) => (
            <th key={h || `c${i}`} style={{
              ...theme.tableHeaderCell,
              fontSize: fontSize.sm, padding: '8px 8px', textAlign: 'left',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {list.map(t => {
          const i = localTournaments.findIndex(lt => lt.name === t.name);
          return (
            <tr key={t.name}
              style={{ borderBottom: `1px solid ${colors.borderSubtle}` }}
              onMouseEnter={e => { e.currentTarget.style.background = colors.rowHover; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
            >
              <td style={{ padding: '8px 10px', textAlign: 'center' }}>{activeToggle(t, i)}</td>
              <td style={{ padding: '8px 8px' }}>{typeBadges(t, i)}</td>
              <td style={{ padding: '8px 8px' }}>{textField(t, i, 'name', 'Tournament name', true)}</td>
              <td style={{ padding: '8px 8px' }}>{textField(t, i, 'dates', 'Dates', true)}</td>
              <td style={{ padding: '8px 8px' }}>
                {textField(t, i, 'location', 'Location', true)}
                {textField(t, i, 'course', 'Course', true, {
                  fontSize: fontSize.sm, color: colors.textSecondary, marginTop: 2,
                })}
              </td>
              <td style={{ padding: '8px 8px' }}>{swingSelect(t, i, true)}</td>
              <td style={{ padding: '8px 8px' }}>{lockSelect(t, i, true)}</td>
              <td style={{ padding: '8px 6px', textAlign: 'center' }}>{deleteButton(t, i)}</td>
            </tr>
          );
        })}
        {kind === 'upcoming' && (
          <tr>
            <td colSpan={8} style={{ padding: '10px 8px', textAlign: 'center', borderTop: `1px dashed ${colors.borderSubtle}` }}>
              {addTournamentButton()}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );

  // ── Read-only schedule table ──────────────────────────────────────────────
  const renderTable = (list, kind = 'upcoming') => (
    <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
      <colgroup>
        <col style={{ width: 26 }} />
        <col />
        <col style={{ width: 70 }} />
        <col style={{ width: '34%' }} />
      </colgroup>
      <thead>
        <tr>
          {[{ label: '' }, { label: 'Tournament' }, { label: 'Dates' }, { label: 'Location' }].map(({ label }) => (
            <th key={label || 'badge'} style={{ ...theme.tableHeaderCell, textAlign: 'left', padding: '8px 6px' }}>{label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {list.map(t => {
          const alt = isAlternate(t);
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
                background: isExpanded ? white(0.04) : 'transparent',
              }}
              onClick={isExpandable ? () => toggleExpansion(t.name) : undefined}
              // Deliberately NOT activatable() from utils/a11y: that helper sets
              // role="button", which on a <tr> replaces the row role and breaks
              // the table's grid semantics for a screen reader. A row stays a
              // row; the tab stop and aria-expanded carry the disclosure.
              tabIndex={isExpandable ? 0 : undefined}
              aria-expanded={isExpandable ? isExpanded : undefined}
              onKeyDown={isExpandable ? (e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                if (e.target !== e.currentTarget) return;   // let nested controls have their key
                e.preventDefault();
                toggleExpansion(t.name);
              } : undefined}
              onMouseEnter={e => { e.currentTarget.style.background = isExpanded ? white(0.06) : colors.rowHover; }}
              onMouseLeave={e => { e.currentTarget.style.background = isExpanded ? white(0.04) : 'transparent'; }}
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
                <td colSpan={4} style={{ padding: 0, background: black(0.15), borderBottom: `1px solid ${colors.borderSubtle}` }}>
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

  // Which of the three the section renders. Edit mode below 640px is the card
  // list; everything else is a table, and only the tables need the horizontal
  // scroll wrapper.
  const renderSchedule = (list, kind) => {
    if (editMode) {
      return useCardEditor
        ? renderEditCards(list, kind)
        : <div style={{ overflowX: 'auto' }}>{renderEditTable(list, kind)}</div>;
    }
    return <div style={{ overflowX: 'auto' }}>{renderTable(list, kind)}</div>;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* ── Edit / Save / Cancel buttons (commissioner only) ──
          In view mode: single Edit Schedule button.
          In edit mode: Cancel (discards local changes) + Save Changes (commits).
          Cancel rolls localTournaments back to the latest tournaments prop,
          so any in-flight edits are dropped. Useful when you tap Edit by
          mistake or change your mind mid-edit. */}
      {isCommissioner && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
          {editMode && (
            <button
              onClick={seedSwings}
              title="Split the league events into four contiguous swings of roughly equal size. Overwrites every swing — adjust the boundaries afterwards, then Save."
              style={{
                ...theme.btnSecondary,
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '8px 14px',
              }}
            >
              Seed Swings
            </button>
          )}
          {editMode && (
            <button
              onClick={() => {
                setLocalTournaments(tournaments);  // discard local edits
                setEditMode(false);
              }}
              style={{
                ...theme.btnSecondary,
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '8px 14px',
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
              padding: '8px 14px',
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
        {renderSchedule(upcoming, 'upcoming')}
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
          {renderSchedule(completed, 'completed')}
        </div>
      )}
    </div>
  );
};
