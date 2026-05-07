import React, { useMemo, useState } from 'react';
import { theme, colors, fonts, fontSize, getMedalStyle, rowHoverHandlers, SWINGS, SWING_COLORS, getSwingColorAt } from '../theme.js';
import { getSegmentForTournament } from '../utils';

// Standings row styles (.sfgl-standings-row, .sfgl-standings-cell, .sfgl-owner)
// are now in app-global.css — no runtime injection needed.

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

// Compact for inline change indicators — no decimals when amount is small,
// 1 decimal for millions ("+1.2M" not "+1.234M"). Different rounding than
// the main earnings formatter because these appear next to the bigger number
// and need to be visually subordinate.
const formatChange = (n) => {
  if (n === 0) return '$0';
  const abs = Math.abs(n);
  const sign = n > 0 ? '+' : '−';
  if (abs >= 1_000_000) return sign + '$' + (abs / 1_000_000).toFixed(1) + 'M';
  if (abs >= 1_000)     return sign + '$' + Math.round(abs / 1_000) + 'k';
  return sign + '$' + Math.round(abs);
};

// ── RecentEventLine — caption row under team name ───────────────────────────
// Shows: <Event Name> · <Earnings> <ChangeBadge>
// • If the team didn't compete (no lineup that week), shows just the event
//   name in muted gray with no earnings.
// • If the team is the leader (the one with the highest earnings from this
//   single event), the change badge says "leader" instead of a +amount.
// • If the team scored 0, no change badge — just "$0" in muted gray.
const RecentEventLine = ({ eventName, earnings, gainVsLeader, isWeekLeader }) => {
  if (!eventName) return null;

  // Team didn't compete that week
  if (earnings === null) {
    return (
      <div style={{
        ...theme.smallText,
        marginTop: 2,
        fontSize: fontSize.sm,
        color: colors.textMuted,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}>
        {eventName} · <span style={{ color: colors.textMuted }}>—</span>
      </div>
    );
  }

  return (
    <div style={{
      ...theme.smallText,
      marginTop: 2,
      fontSize: fontSize.sm,
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
    }}>
      <span style={{
        color: colors.textSecondary,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        minWidth: 0,
        flexShrink: 1,
      }}>
        {eventName}
      </span>
      <span style={{ color: colors.textMuted, flexShrink: 0 }}>·</span>
      <span style={{
        color: earnings > 0 ? colors.earningsGreen : colors.textMuted,
        fontFamily: fonts.mono,
        fontVariantNumeric: 'tabular-nums lining-nums',
        flexShrink: 0,
      }}>
        {earnings > 0 ? formatEarnings(earnings) : '—'}
      </span>
      {/* Change badge — only show if there's a meaningful comparison. The
          week leader gets "leader" instead of a +0 (which would be confusing
          since some other team's gainVsLeader could also be 0). */}
      {isWeekLeader ? (
        <span style={{
          fontSize: fontSize.xs,
          color: colors.textGold,
          fontWeight: 600,
          letterSpacing: '0.5px',
          textTransform: 'uppercase',
          flexShrink: 0,
        }}>
          ◆ leader
        </span>
      ) : earnings > 0 && gainVsLeader !== null ? (
        <span style={{
          fontSize: fontSize.xs,
          color: colors.textMuted,
          fontFamily: fonts.mono,
          fontVariantNumeric: 'tabular-nums lining-nums',
          flexShrink: 0,
        }}>
          {formatChange(gainVsLeader)}
        </span>
      ) : null}
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
          padding: '5px 0',
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
// Renders header (subtitle + Total/Behind toggle) + standings table.
const StandingsCard = ({
  subtitle,
  rows,                  // [{ id, name, owner, position, earnings, recentEventName, recentEarnings, recentGainVsLeader, isWeekLeader }]
  metric,
  setMetric,
  accentColor,           // optional swing tint applied to the toggle + earnings color
  showSwingWinner,       // when truthy, top row gets the trophy treatment
  emptyState,            // optional: render this instead of the table when no rows
}) => {
  const leaderEarnings = rows[0]?.earnings || 0;

  return (
    <div style={theme.card}>
      {/* Header */}
      <div style={{ ...theme.cardHeader, alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
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
            <col style={{ width: 44 }} />   {/* Pos medal — slightly wider for breathing room */}
            <col />                          {/* Team block — gets all remaining space */}
            <col style={{ width: 110 }} />  {/* Earnings — narrower than before since toggle is gone */}
          </colgroup>
          <tbody>
            {rows.map((team, index) => {
              const earnings = team.earnings || 0;
              const behind   = leaderEarnings - earnings;
              const medal    = getMedalStyle(index);
              const isTop    = index === 0;
              const isWinner = showSwingWinner && isTop;
              const rowBg    = isWinner
                ? getSwingColorAt(accentColor, 0.08)
                : isTop
                  ? 'rgba(180,160,100,0.04)'
                  : 'transparent';

              return (
                <tr
                  key={team.id}
                  className="sfgl-standings-row"
                  style={{ background: rowBg, transition: 'background 0.15s' }}
                  {...rowHoverHandlers(isTop)}
                >
                  {/* Position medal */}
                  <td className="sfgl-standings-cell" style={{ ...theme.tableCell, paddingLeft: 16, paddingRight: 6 }}>
                    <div style={{
                      width: 26, height: 26, borderRadius: '50%',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: fontSize.sm, fontWeight: 700,
                      background: isWinner ? getSwingColorAt(accentColor, 0.15) : medal.bg,
                      color:      isWinner ? getSwingColorAt(accentColor, 1)    : medal.text,
                      border:     isWinner ? `1px solid ${getSwingColorAt(accentColor, 0.4)}` : 'none',
                      flexShrink: 0,
                    }}>
                      {isWinner ? '🏆' : team.position}
                    </div>
                  </td>

                  {/* Team block — name + recent event line */}
                  <td className="sfgl-standings-cell" style={{ ...theme.tableCell, overflow: 'hidden', paddingLeft: 4 }}>
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
                    {/* Recent event caption — replaces the old "owner" subtitle */}
                    <RecentEventLine
                      eventName={team.recentEventName}
                      earnings={team.recentEarnings}
                      gainVsLeader={team.recentGainVsLeader}
                      isWeekLeader={team.isWeekLeader}
                    />
                  </td>

                  {/* Earnings */}
                  <td className="sfgl-standings-cell" style={{ ...theme.tableCell, textAlign: 'right' }}>
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
  //   { eventName, earningsByTeam: Map<teamId, earnings>, weekLeaderId, weekLeaderEarnings }
  const summarizeTournament = (t) => {
    if (!t || !t.completed || !t.results?.teams) return null;
    const earningsByTeam = new Map();
    let weekLeaderId = null;
    let weekLeaderEarnings = -1;
    Object.entries(t.results.teams).forEach(([teamId, result]) => {
      const earned = result.totalEarnings || 0;
      earningsByTeam.set(teamId, earned);
      if (earned > weekLeaderEarnings) {
        weekLeaderEarnings = earned;
        weekLeaderId = teamId;
      }
    });
    return {
      eventName: t.name,
      earningsByTeam,
      weekLeaderId,
      weekLeaderEarnings,
    };
  };

  // Build a row's recent-event fields from a tournament summary.
  const recentFieldsFor = (teamId, summary) => {
    if (!summary) {
      return { recentEventName: null, recentEarnings: null, recentGainVsLeader: null, isWeekLeader: false };
    }
    const earned = summary.earningsByTeam.get(teamId);
    if (earned === undefined) {
      // Team didn't compete that week (no lineup, alternate event, etc.)
      return {
        recentEventName: summary.eventName,
        recentEarnings: null,
        recentGainVsLeader: null,
        isWeekLeader: false,
      };
    }
    return {
      recentEventName: summary.eventName,
      recentEarnings: earned,
      recentGainVsLeader: earned - summary.weekLeaderEarnings,
      isWeekLeader: teamId === summary.weekLeaderId,
    };
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

  // Most recent completed tournament across the whole season (Overall card uses this)
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
      .map((t, i) => ({
        ...t,
        position: i + 1,
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

  // Most recent completed tournament *within the selected swing*
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
      .map((t, i) => ({
        ...t,
        position: i + 1,
        ...recentFieldsFor(t.id, lastCompletedSwingSummary),
      }));
  }, [selectedSwing, teams, swingTotals, lastCompletedSwingSummary]);

  // Swing meta — event count, completion status
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
  const overallSubtitle = (
    <span style={{ fontFamily: fonts.serif, fontSize: fontSize.md, color: colors.textPrimary, letterSpacing: '0.5px' }}>
      Season
    </span>
  );

  const swingSubtitle = selectedSwing ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
      {swingsWithResults.length > 1 ? (
        <select
          value={selectedSwing || ''}
          onChange={e => setSelectedSwing(e.target.value)}
          style={{
            ...theme.select,
            width: 'auto',
            fontSize: fontSize.base,
            padding: '0px 8px',
            height: 22,
            color: swingAccent,
            borderColor: getSwingColorAt(selectedSwing, 0.3),
            background: '#0d1b2e',
            appearance: 'none',
            WebkitAppearance: 'none',
            fontWeight: 600,
          }}
        >
          {swingsWithResults.map(s => (
            <option key={s} value={s}>{s.replace(/\s+Swing$/, '')}</option>
          ))}
        </select>
      ) : (
        <span style={{
          fontWeight: 600, color: swingAccent,
          border: `1px solid ${getSwingColorAt(selectedSwing, 0.4)}`,
          borderRadius: 4,
          padding: '1px 8px',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {selectedSwing?.replace(/\s+Swing$/, '') || ''}
        </span>
      )}
      {swingEventCount > 0 && (
        <span style={{
          fontSize: fontSize.sm,
          color: swingIsComplete ? colors.textMuted : getSwingColorAt(selectedSwing, 0.7),
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>
          {swingIsComplete
            ? <><span style={{ color: 'rgba(245,197,24,0.9)', fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', marginRight: 4 }}>Final</span>{swingEventCount} events</>
            : <>{swingEventCount} of {swingTotalCount} event{swingTotalCount !== 1 ? 's' : ''}</>
          }
        </span>
      )}
    </div>
  ) : (
    <span style={{ fontFamily: fonts.serif, fontSize: fontSize.md, color: colors.textMuted, letterSpacing: '0.5px' }}>
      Swing
    </span>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Overall card */}
      <StandingsCard
        subtitle={overallSubtitle}
        rows={overallRows}
        metric={overallMetric}
        setMetric={setOverallMetric}
      />

      {/* Swing card */}
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
