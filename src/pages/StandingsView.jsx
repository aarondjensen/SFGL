import React, { useMemo, useState } from 'react';
import { theme, colors, fonts, fontSize, rowHoverHandlers, SWINGS, SWING_COLORS, getSwingColorAt } from '../theme.js';
import { getSegmentForTournament } from '../utils';

// Row height enforced via the .sfgl-row-hero class defined in app-global.css.
// (Hero tier = 56px desktop / 52px mobile, single-line content.)

const ALL_SWINGS = SWINGS;
const SWING_ACCENT = SWING_COLORS;

// ── Formatters ──────────────────────────────────────────────────────────────
const formatEarnings = (n) => {
  n = n || 0;
  if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(3) + 'M';
  if (n >= 1_000)     return '$' + Math.round(n / 1_000) + 'k';
  return '$' + n;
};

const formatBehind = (n) => {
  if (!n || n <= 0) return '—';
  if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000)     return '$' + Math.round(n / 1_000) + 'k';
  return '$' + n;
};

// Compact event-earnings formatter — fewer digits than the season total
// (e.g. "$1.2M" not "$1.234M") because the event column is narrower and
// these are visually subordinate to the season number.
const formatEventEarnings = (n) => {
  if (!n || n <= 0) return '—';
  if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000)     return '$' + Math.round(n / 1_000) + 'k';
  return '$' + n;
};

// ── Position badge ──────────────────────────────────────────────────────────
// Only 1st place gets a colored fill (gold from the app theme). 2nd-Nth get
// a neutral muted treatment because there's no prize for finishing 2nd in
// this league. When the swing is complete and there's a swing winner, 1st
// place gets the trophy emoji on top of its swing-tinted fill instead.
const PositionBadge = ({ position, isWinner, swingAccent }) => {
  const isFirst = position === 1;

  let bg, fg, border;
  if (isWinner) {
    bg     = swingAccent ? getSwingColorAt(swingAccent, 0.15) : 'rgba(245,197,24,0.15)';
    fg     = swingAccent ? getSwingColorAt(swingAccent, 1)    : colors.textGold;
    border = swingAccent ? `1px solid ${getSwingColorAt(swingAccent, 0.4)}` : `1px solid ${colors.textGold}`;
  } else if (isFirst) {
    // Light gray fill with dark text — the inverse of the 2nd-Nth treatment
    // (which uses a faint white fill with light text). Brighter and more
    // opaque than 2nd-Nth so #1 still reads as the standout position.
    bg     = 'rgba(220,220,225,0.95)';
    fg     = '#111d2e';   // dark navy text for contrast
    border = 'none';
  } else {
    // Neutral muted — no medal coloring for 2nd/3rd
    bg     = 'rgba(255,255,255,0.06)';
    fg     = colors.textSecondary;
    border = 'none';
  }

  return (
    <div style={{
      width: 26, height: 26, borderRadius: '50%',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: fontSize.sm, fontWeight: 700,
      background: bg, color: fg, border,
      flexShrink: 0,
    }}>
      {isWinner ? '🏆' : position}
    </div>
  );
};

// ── Total/Behind toggle (compact, lives in card header) ────────────────────
const MetricToggle = ({ value, onChange, accentColor }) => (
  <div style={{
    display: 'inline-flex',
    position: 'relative',
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(180,160,100,0.2)',
    borderRadius: 4,
    padding: 3,
    width: 150,
    boxSizing: 'border-box',
    flexShrink: 0,
  }}>
    <div style={{
      position: 'absolute',
      top: 3, bottom: 3,
      left: value === 'behind' ? 'calc(50% + 1px)' : 3,
      width: 'calc(50% - 4px)',
      borderRadius: 2,
      background: accentColor ? getSwingColorAt(accentColor, 0.18) : 'rgba(255,255,255,0.1)',
      border: `1px solid ${accentColor ? getSwingColorAt(accentColor, 0.45) : 'rgba(255,255,255,0.3)'}`,
      transition: 'left 0.22s cubic-bezier(0.4,0,0.2,1)',
      pointerEvents: 'none',
    }} />
    {[
      ['total',  'Total'],
      ['behind', 'Behind'],
    ].map(([key, label]) => (
      <button
        key={key}
        onClick={() => onChange(key)}
        style={{
          flex: 1, position: 'relative', zIndex: 1,
          padding: '4px 0',
          background: 'none', border: 'none',
          fontFamily: fonts.sans, fontSize: fontSize.sm, fontWeight: 700,
          letterSpacing: '1px', textTransform: 'uppercase',
          color: value === key ? colors.textPrimary : colors.textMuted,
          cursor: 'pointer',
          transition: 'color 0.18s',
          borderRadius: 2,
        }}
      >
        {label}
      </button>
    ))}
  </div>
);

// ── StandingsCard — shared layout for Overall and Swing cards ──────────────
// 4-column table: position · team+event_name · event_earnings · total_earnings.
// The dedicated event_earnings column is what makes the recent event amounts
// line up vertically across all rows for clean scanning.
const StandingsCard = ({
  subtitle,
  rows,
  metric,
  setMetric,
  accentColor,           // optional swing tint applied to the toggle + earnings color
  showSwingWinner,       // when truthy, top row gets the trophy treatment
  emptyState,            // optional: render this instead of the table when no rows
  emphasis,              // 'primary' for the Season card (gold accent), undefined otherwise
}) => {
  const leaderEarnings = rows[0]?.earnings || 0;

  // Compact header — overrides theme.cardHeader's default 16px padding to
  // 8px/14px so the card header takes about 16px less vertical space, freeing
  // room for the rows below on small screens.
  const compactHeader = {
    ...theme.sectionHeaderBar,
    background: emphasis === 'primary'
      ? theme.sectionHeaderBar.background
      : accentColor
        ? `linear-gradient(90deg, ${getSwingColorAt(accentColor, 0.12)} 0%, ${getSwingColorAt(accentColor, 0.04)} 60%, transparent 100%)`
        : theme.cardHeader.background,
    justifyContent: 'space-between',
  };

  // Primary cards get a slightly stronger gold border to read as "featured"
  // relative to the secondary swing card below.
  const cardStyle = emphasis === 'primary'
    ? { ...theme.card, border: '1px solid rgba(245,197,24,0.35)' }
    : theme.card;

  return (
    <div style={cardStyle}>
      {/* Header */}
      <div style={compactHeader}>
        <div style={{
          fontFamily: fonts.sans,
          fontSize: fontSize.base,
          letterSpacing: '0.3px',
          display: 'flex',
          alignItems: 'center',
          lineHeight: 1.3,
          minHeight: 28,
          minWidth: 0,
          flex: 1,
        }}>
          {subtitle}
        </div>
        <MetricToggle value={metric} onChange={setMetric} accentColor={accentColor} />
      </div>

      {emptyState ? (
        <div style={theme.emptyState}>{emptyState}</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: 44 }} />   {/* Pos badge */}
            <col />                          {/* Team name + event name caption */}
            <col style={{ width: 88 }} />   {/* Event earnings — own column for vertical alignment */}
            <col style={{ width: 120 }} />  {/* Total / Behind earnings — wide enough for $XX.XXXM */}
          </colgroup>
          <tbody>
            {rows.map((team, index) => {
              const earnings = team.earnings || 0;
              const behind   = leaderEarnings - earnings;
              const position = index + 1;
              const isTop    = position === 1;
              const isWinner = showSwingWinner && isTop;
              const rowBg    = isWinner
                ? getSwingColorAt(accentColor, 0.08)
                : isTop
                  ? 'rgba(245,197,24,0.04)'   // very subtle gold tint for #1
                  : 'transparent';

              return (
                <tr
                  key={team.id}
                  className="sfgl-row-hero"
                  style={{ background: rowBg, transition: 'background 0.15s' }}
                  {...rowHoverHandlers(isTop)}
                >
                  {/* Position badge */}
                  <td style={{ ...theme.tableCell, paddingLeft: 14, paddingRight: 6 }}>
                    <PositionBadge position={position} isWinner={isWinner} swingAccent={accentColor} />
                  </td>

                  {/* Team name */}
                  <td style={{ ...theme.tableCell, overflow: 'hidden', paddingLeft: 4, paddingRight: 4 }}>
                    <div style={{
                      ...theme.bodyText,
                      fontSize: fontSize.lg,
                      fontFamily: fonts.serif,
                      color: isWinner ? getSwingColorAt(accentColor, 1) : colors.textPrimary,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {team.name}
                    </div>
                  </td>

                  {/* Recent event earnings — own column so values stack vertically.
                      Prefixed with "+" to communicate "this is what they ADDED to
                      their season total from the most recent event". Mirrors the
                      Total column's font treatment (mono, weight 300, tracked) at
                      a smaller size and in green. */}
                  <td style={{ ...theme.tableCell, textAlign: 'right', paddingLeft: 4, paddingRight: 8 }}>
                    {team.recentEventName ? (
                      <div style={{
                        ...theme.statNumLg,
                        fontSize: fontSize.md,
                        letterSpacing: 1.5,
                        fontWeight: 300,
                        color: team.recentEarnings > 0 ? colors.earningsGreen : colors.textMuted,
                      }}>
                        {team.recentEarnings === null || team.recentEarnings === 0
                          ? '—'
                          : '+' + formatEventEarnings(team.recentEarnings)}
                      </div>
                    ) : null}
                  </td>

                  {/* Total / Behind */}
                  <td style={{ ...theme.tableCell, textAlign: 'right', paddingLeft: 4, paddingRight: 14 }}>
                    {metric === 'total' ? (
                      <div style={{
                        ...theme.statNumLg,
                        fontSize: fontSize.lg,
                        letterSpacing: 1.5,
                        fontWeight: 300,
                        color: accentColor
                          ? accentColor
                          : (earnings > 0 ? colors.textPrimary : colors.textMuted),
                      }}>
                        {formatEarnings(earnings)}
                      </div>
                    ) : (
                      <div style={{
                        ...theme.statNumLg,
                        fontSize: fontSize.lg,
                        letterSpacing: 1.2,
                        fontWeight: 300,
                        color: isWinner
                          ? getSwingColorAt(accentColor, 1)
                          : behind === 0
                            ? (accentColor || colors.earningsGreen)
                            : colors.textSecondary,
                      }}>
                        {isWinner
                          ? 'Winner'
                          : behind === 0
                            ? '🏆'
                            : formatBehind(behind)
                        }
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
};

// ── StandingsView — composes the two cards ─────────────────────────────────
export const StandingsView = ({ teams, tournaments = [], transactions = [] }) => {
  const [overallMetric, setOverallMetric] = useState('total');
  const [swingMetric,   setSwingMetric]   = useState('total');

  // ── Helpers shared by both cards ──────────────────────────────────────────

  // Given a single completed tournament's results, return:
  //   { eventName, earningsByTeam: Map<teamId, earnings> }
  // (The "leader of the week" tracking has been removed since we no longer
  // show a leader badge in the row.)
  const summarizeTournament = (t) => {
    if (!t || !t.completed || !t.results?.teams) return null;
    const earningsByTeam = new Map();
    Object.entries(t.results.teams).forEach(([teamId, result]) => {
      earningsByTeam.set(teamId, result.totalEarnings || 0);
    });
    return { eventName: t.name, earningsByTeam };
  };

  // Build a row's recent-event fields from a tournament summary.
  const recentFieldsFor = (teamId, summary) => {
    if (!summary) {
      return { recentEventName: null, recentEarnings: null };
    }
    const earned = summary.earningsByTeam.get(teamId);
    if (earned === undefined) {
      // Team didn't compete that week (no lineup, alternate event, etc.)
      return { recentEventName: summary.eventName, recentEarnings: null };
    }
    return { recentEventName: summary.eventName, recentEarnings: earned };
  };

  // ── Overall card ──────────────────────────────────────────────────────────
  const seasonTotals = useMemo(() => {
    const totals = {};
    teams.forEach(t => { totals[t.id] = 0; });
    tournaments.forEach(t => {
      if (!t.completed || !t.results?.teams) return;
      Object.entries(t.results.teams).forEach(([teamId, result]) => {
        if (totals[teamId] !== undefined) totals[teamId] += (result.totalEarnings || 0);
      });
    });
    return totals;
  }, [teams, tournaments]);

  const lastCompletedOverall = useMemo(
    () => [...tournaments].reverse().find(t => t.completed && t.results?.teams) || null,
    [tournaments]
  );
  const lastCompletedOverallSummary = useMemo(
    () => summarizeTournament(lastCompletedOverall),
    [lastCompletedOverall]
  );

  const overallRows = useMemo(() => {
    return [...teams]
      .map(t => ({ ...t, earnings: seasonTotals[t.id] || 0 }))
      .sort((a, b) => b.earnings - a.earnings)
      .map(t => ({
        ...t,
        ...recentFieldsFor(t.id, lastCompletedOverallSummary),
      }));
  }, [teams, seasonTotals, lastCompletedOverallSummary]);

  // ── Swing card ────────────────────────────────────────────────────────────
  const swingsWithResults = useMemo(() => {
    const seen = new Set();
    tournaments.forEach(t => {
      const seg = getSegmentForTournament(t);
      if (seg && t.completed && t.results?.teams) seen.add(seg);
    });
    return ALL_SWINGS.filter(s => seen.has(s));
  }, [tournaments]);

  const [selectedSwing, setSelectedSwing] = useState(() =>
    ALL_SWINGS.slice().reverse().find(s =>
      tournaments.some(t => getSegmentForTournament(t) === s && t.completed && t.results?.teams)
    ) || null
  );

  const lastCompletedSwing = useMemo(() => {
    if (!selectedSwing) return null;
    return [...tournaments].reverse().find(t =>
      getSegmentForTournament(t) === selectedSwing && t.completed && t.results?.teams
    ) || null;
  }, [selectedSwing, tournaments]);
  const lastCompletedSwingSummary = useMemo(
    () => summarizeTournament(lastCompletedSwing),
    [lastCompletedSwing]
  );

  const swingTotals = useMemo(() => {
    if (!selectedSwing) return {};
    const totals = {};
    teams.forEach(t => { totals[t.id] = 0; });
    tournaments.forEach(t => {
      if (getSegmentForTournament(t) !== selectedSwing || !t.completed || !t.results?.teams) return;
      Object.entries(t.results.teams).forEach(([teamId, result]) => {
        if (totals[teamId] !== undefined) totals[teamId] += (result.totalEarnings || 0);
      });
    });
    return totals;
  }, [selectedSwing, teams, tournaments]);

  const swingRows = useMemo(() => {
    if (!selectedSwing) return [];
    return [...teams]
      .map(t => ({ ...t, earnings: swingTotals[t.id] || 0 }))
      .sort((a, b) => b.earnings - a.earnings)
      .map(t => ({
        ...t,
        ...recentFieldsFor(t.id, lastCompletedSwingSummary),
      }));
  }, [selectedSwing, teams, swingTotals, lastCompletedSwingSummary]);

  const swingEventCount = useMemo(() =>
    !selectedSwing ? 0 : tournaments.filter(t =>
      getSegmentForTournament(t) === selectedSwing && t.completed && t.results?.teams
    ).length,
    [selectedSwing, tournaments]
  );
  const swingTotalCount = useMemo(() =>
    !selectedSwing ? 0 : tournaments.filter(t =>
      getSegmentForTournament(t) === selectedSwing && !t.isAlternate
    ).length,
    [selectedSwing, tournaments]
  );

  const swingWinnerTx = useMemo(() =>
    !selectedSwing ? null :
    transactions.find(tx => tx.type === 'swing_winner' && tx.segment === selectedSwing) || null,
    [selectedSwing, transactions]
  );
  const swingIsComplete = !!swingWinnerTx;
  const swingAccent = selectedSwing ? SWING_ACCENT[selectedSwing] : colors.textSecondary;

  // ── Subtitles ─────────────────────────────────────────────────────────────
  // Both subtitles use the same font family/size/weight so SEASON and the
  // swing name read as the same visual tier. SEASON is set in caps with
  // tracked letter-spacing (sans rather than serif because all-caps serif
  // can feel heavy in small sizes).
  const HEADER_FONT = theme.sectionTitle;

  const overallSubtitle = (
    <span style={{ ...HEADER_FONT, color: colors.textPrimary }}>
      Season
    </span>
  );

  // Swing subtitle: the swing name is styled like SEASON (same font / size /
  // tracking) plus a small chevron indicating it's a dropdown trigger. The
  // <select> sits invisibly on top so the OS-native picker still renders.
  const swingSubtitle = selectedSwing ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
      {swingsWithResults.length > 1 ? (
        <label style={{
          position: 'relative',
          display: 'inline-flex', alignItems: 'center', gap: 4,
          cursor: 'pointer',
        }}>
          <span style={{ ...HEADER_FONT, color: swingAccent }}>
            {selectedSwing.replace(/\s+Swing$/, '')}
          </span>
          {/* Chevron — tiny down-arrow indicating dropdown affordance */}
          <span aria-hidden="true" style={{
            fontSize: 9,
            color: swingAccent,
            opacity: 0.65,
            lineHeight: 1,
            marginTop: 1,
          }}>▼</span>
          {/* Invisible select layered over the styled span/chevron — keeps
              native picker UX without showing the OS chrome. */}
          <select
            value={selectedSwing}
            onChange={e => setSelectedSwing(e.target.value)}
            aria-label="Select swing"
            style={{
              position: 'absolute',
              inset: 0,
              opacity: 0,
              cursor: 'pointer',
              border: 'none',
              background: 'transparent',
              fontSize: 16, // ≥16px to prevent iOS zoom
            }}
          >
            {swingsWithResults.map(s => (
              <option key={s} value={s}>{s.replace(/\s+Swing$/, '')}</option>
            ))}
          </select>
        </label>
      ) : (
        // Only one swing has results yet — no dropdown needed, just label.
        <span style={{ ...HEADER_FONT, color: swingAccent }}>
          {selectedSwing.replace(/\s+Swing$/, '')}
        </span>
      )}
      {swingEventCount > 0 && (
        <span style={{
          display: 'inline-flex',
          flexDirection: 'column',
          alignItems: 'center',
          fontSize: fontSize.sm,
          color: swingIsComplete ? colors.textMuted : getSwingColorAt(selectedSwing, 0.7),
          lineHeight: 1.1,
        }}>
          {swingIsComplete ? (
            <>
              <span style={{ whiteSpace: 'nowrap' }}>{swingEventCount}</span>
              <span>event{swingEventCount !== 1 ? 's' : ''}</span>
            </>
          ) : (
            <>
              <span style={{ whiteSpace: 'nowrap' }}>{swingEventCount} of {swingTotalCount}</span>
              <span>event{swingTotalCount !== 1 ? 's' : ''}</span>
            </>
          )}
        </span>
      )}
    </div>
  ) : (
    <span style={{ ...HEADER_FONT, color: colors.textMuted }}>
      Swing
    </span>
  );

  return (
    // StandingsView shows at most ~5–10 teams. A 1100px wide card leaves
    // a large dead-air gap between team names and earnings on desktop, so
    // we cap the view itself at 720px and center it. On narrower viewports
    // (mobile) the cap is a no-op since the parent main is already < 720.
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
      maxWidth: 720,
      margin: '0 auto',
      width: '100%',
    }}>
      {/* Overall card — primary emphasis (gold accent) */}
      <StandingsCard
        subtitle={overallSubtitle}
        rows={overallRows}
        metric={overallMetric}
        setMetric={setOverallMetric}
        emphasis="primary"
      />

      {/* Swing card — secondary, neutral chrome */}
      <StandingsCard
        subtitle={swingSubtitle}
        rows={swingRows}
        metric={swingMetric}
        setMetric={setSwingMetric}
        accentColor={selectedSwing}
        showSwingWinner={swingIsComplete}
        emptyState={swingsWithResults.length === 0
          ? 'No swing results yet — check back after the first tournament completes'
          : null}
      />
    </div>
  );
};
