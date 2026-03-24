import React, { useMemo, useState } from 'react';
import { Trophy } from 'lucide-react';
import { theme, colors, fonts, getMedalStyle, rowHoverHandlers, earningsColor, SWING_COLORS } from '../theme.js';
import { getSegmentByDate } from '../utils';

// Inject once — consistent row height on mobile
if (typeof document !== 'undefined' && !document.getElementById('sfgl-standings-styles')) {
  const s = document.createElement('style');
  s.id = 'sfgl-standings-styles';
  s.textContent = `
    .sfgl-standings-row { height: 56px; }
    .sfgl-standings-cell { vertical-align: middle !important; }
    .sfgl-owner { display: inline; }
    @media (max-width: 639px) {
      .sfgl-standings-row { height: 52px; }
      .sfgl-owner { display: none; }
    }
  `;
  document.head.appendChild(s);
}

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

const ALL_SWINGS = ['West Coast Swing', 'Spring Swing', 'Summer Swing', 'Fall Finish'];

const SWING_ACCENT = SWING_COLORS;

// Prefer the stored segment/swing, then derive from the tournament start date.
// Keeps StandingsView in sync with getSegmentByDate used everywhere else.
const getSegmentForTournament = (t) => {
  if (t.segment) return t.segment;
  if (t.swing) return t.swing;
  if (!t.dates) return null;
  const MONTHS = { Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12 };
  const match = t.dates.match(/^([A-Za-z]+)\s+(\d+)/);
  if (!match) return null;
  const month = MONTHS[match[1]];
  if (!month) return null;
  return getSegmentByDate(new Date(new Date().getFullYear(), month - 1, parseInt(match[2])));
};

export const StandingsView = ({ teams, tournaments = [], transactions = [] }) => {

  // ── Overall — compute live from tournament results (source of truth) ────
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

  const sortedTeams = useMemo(() =>
    [...teams]
      .map(t => ({ ...t, earnings: seasonTotals[t.id] || 0 }))
      .sort((a, b) => b.earnings - a.earnings)
      .map((t, i) => ({ ...t, position: i + 1 })),
    [teams, seasonTotals],
  );
  const leader = sortedTeams[0]?.earnings || 0;

  // ── Swing ────────────────────────────────────────────────────────────────
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

  const swingStandings = useMemo(() => {
    if (!selectedSwing) return [];
    const totals = {};
    teams.forEach(t => { totals[t.id] = 0; });
    tournaments.forEach(t => {
      if (getSegmentForTournament(t) !== selectedSwing || !t.completed || !t.results?.teams) return;
      Object.entries(t.results.teams).forEach(([teamId, result]) => {
        if (totals[teamId] !== undefined) totals[teamId] += (result.totalEarnings || 0);
      });
    });
    return teams
      .map(t => ({ ...t, swingEarnings: totals[t.id] || 0 }))
      .sort((a, b) => b.swingEarnings - a.swingEarnings)
      .map((t, i) => ({ ...t, swingPos: i + 1 }));
  }, [selectedSwing, teams, tournaments]);

  const swingLeader = swingStandings[0]?.swingEarnings || 0;
  const swingEventCount = useMemo(() =>
    !selectedSwing ? 0 : tournaments.filter(t =>
      getSegmentForTournament(t) === selectedSwing && t.completed && t.results?.teams
    ).length,
    [selectedSwing, tournaments]
  );

  // ── Most recent completed tournament (for Overall subtitle) ────────────
  const mostRecentTournament = useMemo(() =>
    [...tournaments].reverse().find(t => t.completed && t.results?.teams),
    [tournaments]
  );

  // Total events in selected swing (completed or not, non-alternate) ────────
  const swingTotalCount = useMemo(() =>
    !selectedSwing ? 0 : tournaments.filter(t =>
      getSegmentForTournament(t) === selectedSwing && !t.isAlternate
    ).length,
    [selectedSwing, tournaments]
  );

  // ── Swing completion ─────────────────────────────────────────────────────
  const swingWinnerTx = useMemo(() =>
    !selectedSwing ? null :
    transactions.find(tx => tx.type === 'swing_winner' && tx.segment === selectedSwing) || null,
    [selectedSwing, transactions]
  );
  const swingIsComplete = !!swingWinnerTx;

  // ── Toggle ───────────────────────────────────────────────────────────────
  const [view, setView] = useState('overall');
  const showSwing    = view === 'swing';
  const accentColor  = selectedSwing ? SWING_ACCENT[selectedSwing] : colors.textSecondary;

  const displayRows   = showSwing ? swingStandings : sortedTeams;
  const displayLeader = showSwing ? swingLeader : leader;
  const earningsKey   = showSwing ? 'swingEarnings' : 'earnings';
  const posKey        = showSwing ? 'swingPos' : 'position';
  const earningsLabel = showSwing ? 'Swing' : 'Season';

  // slider toggle — no tabStyle needed

  return (
    <div style={theme.card}>

      {/* Header */}
      <div style={{ ...theme.cardHeader, flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
          {/* Left: title + subtitle */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Trophy style={{ width: 20, height: 20, color: colors.textPrimary, flexShrink: 0 }} />
              <h2 style={theme.h2}>Standings</h2>
            </div>
            {/* Subtitle — always reserve space to prevent layout shift */}
            <div style={{ fontFamily: fonts.sans, fontSize: 11, letterSpacing: '0.3px', minHeight: 18, display: 'flex', alignItems: 'center', lineHeight: 1.3 }}>
              {showSwing && selectedSwing && (
                swingsWithResults.length > 1 ? (
                  <select
                    value={selectedSwing || ''}
                    onChange={e => setSelectedSwing(e.target.value)}
                    style={{ ...theme.select, width: 'auto', fontSize: 11, padding: '0px 8px', height: 18, color: accentColor, borderColor: accentColor.replace('0.85', '0.3'), background: '#0d1b2e', appearance: 'none', WebkitAppearance: 'none' }}
                  >
                    {swingsWithResults.map(s => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                ) : (
                  <span style={{
                    fontWeight: 600, color: accentColor,
                    border: `1px solid ${accentColor.replace('0.85', '0.4')}`,
                    borderRadius: 4,
                    padding: '1px 8px',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    {selectedSwing}
                  </span>
                )
              )}
              {!showSwing && mostRecentTournament && (
                <span style={{ color: 'rgba(255,255,255,0.55)' }}>
                  through {mostRecentTournament.name}
                </span>
              )}
            </div>
          </div>
          {/* Right: toggle + event count */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
            <div
              style={{
                position: 'relative',
                display: 'flex',
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(180,160,100,0.2)',
                borderRadius: 4,
                padding: 3,
                gap: 0,
                minWidth: 140,
                maxWidth: 200,
              }}
            >
              <div style={{
                position: 'absolute',
                top: 3, bottom: 3,
                left: showSwing ? 'calc(50% + 1px)' : 3,
                width: 'calc(50% - 4px)',
                borderRadius: 2,
                background: showSwing
                  ? accentColor.replace('0.85)', '0.18)')
                  : 'rgba(255,255,255,0.1)',
                border: `1px solid ${showSwing ? accentColor.replace('0.85)', '0.45)') : 'rgba(255,255,255,0.3)'}`,
                transition: 'left 0.22s cubic-bezier(0.4,0,0.2,1)',
                pointerEvents: 'none',
              }} />
              <button
                onClick={() => setView('overall')}
                style={{
                  flex: 1, position: 'relative', zIndex: 1,
                  padding: '5px 0',
                  background: 'none', border: 'none',
                  fontFamily: fonts.sans, fontSize: 11, fontWeight: 700,
                  letterSpacing: '1px', textTransform: 'uppercase',
                  color: !showSwing ? colors.textPrimary : colors.textMuted,
                  cursor: 'pointer',
                  transition: 'color 0.18s',
                  borderRadius: 2,
                }}
              >
                Overall
              </button>
              <button
                onClick={() => {
                  if (swingsWithResults.length === 0) return;
                  setView('swing');
                  if (!selectedSwing && swingsWithResults.length) setSelectedSwing(swingsWithResults[swingsWithResults.length - 1]);
                }}
                style={{
                  flex: 1, position: 'relative', zIndex: 1,
                  padding: '5px 0',
                  background: 'none', border: 'none',
                  fontFamily: fonts.sans, fontSize: 11, fontWeight: 700,
                  letterSpacing: '1px', textTransform: 'uppercase',
                  color: showSwing ? accentColor : swingsWithResults.length === 0 ? 'rgba(255,255,255,0.15)' : colors.textMuted,
                  cursor: swingsWithResults.length === 0 ? 'default' : 'pointer',
                  transition: 'color 0.18s',
                  borderRadius: 2,
                  opacity: swingsWithResults.length === 0 ? 0.4 : 1,
                }}
              >
                Swing
              </button>
            </div>
            {/* Event count — always reserve space */}
            <div style={{ fontFamily: fonts.sans, fontSize: 11, letterSpacing: '0.3px', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, minWidth: 140, maxWidth: 200, width: '100%', minHeight: 16 }}>
              {showSwing && swingEventCount > 0 && (
                swingIsComplete ? (
                  <>
                    <span style={{ color: 'rgba(245,197,24,0.9)', fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', fontSize: 10 }}>Final</span>
                    <span style={{ color: colors.textMuted }}>{swingEventCount} events</span>
                  </>
                ) : (
                  <span style={{ color: accentColor.replace('0.85', '0.7') }}>
                    {swingEventCount} of {swingTotalCount} event{swingTotalCount !== 1 ? 's' : ''}
                  </span>
                )
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Empty state for swing */}
      {showSwing && swingsWithResults.length === 0 && (
        <div style={theme.emptyState}>No swing results yet — check back after the first tournament completes</div>
      )}

      {/* Table */}
      {(!showSwing || swingsWithResults.length > 0) && (
        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: 48 }} />
            <col />
            <col style={{ width: '26%' }} />
            <col style={{ width: '20%' }} />
          </colgroup>
          <thead>
            <tr>
              {['Pos', 'Team', earningsLabel, 'Behind'].map((h, i) => (
                <th key={h} style={{ ...theme.tableHeaderCell, textAlign: i === 2 ? 'left' : i === 3 ? 'right' : 'left' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayRows.map((team, index) => {
              const earnings = team[earningsKey] || 0;
              const behind   = displayLeader - earnings;
              const medal    = getMedalStyle(index);
              const isTop    = index === 0;
              const isSwingWinner = showSwing && swingIsComplete && isTop;
              const rowBg = isSwingWinner ? accentColor.replace('0.85)', '0.08)') : isTop ? 'rgba(180,160,100,0.04)' : 'transparent';
              return (
                <tr key={team.id} className="sfgl-standings-row"
                  style={{ background: rowBg, transition: 'background 0.15s' }}
                  {...rowHoverHandlers(isTop)}
                >
                  <td className="sfgl-standings-cell" style={theme.tableCell}>
                    <div style={{ width: 32, height: 32, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, background: isSwingWinner ? accentColor.replace('0.85)', '0.15)') : medal.bg, color: isSwingWinner ? accentColor.replace('0.85)', '1)') : medal.text, border: isSwingWinner ? `1px solid ${accentColor.replace('0.85)', '0.4)')}` : 'none', flexShrink: 0 }}>
                      {isSwingWinner ? '🏆' : team[posKey]}
                    </div>
                  </td>
                  <td className="sfgl-standings-cell" style={{ ...theme.tableCell, overflow: 'hidden' }}>
                    <div style={{ ...theme.h3, fontSize: 'clamp(13px,1.4vw,17px)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: isSwingWinner ? accentColor.replace('0.85)', '1)') : undefined }}>
                      {team.name}
                    </div>
                    <div className="sfgl-owner" style={{ ...theme.smallText, marginTop: 1 }}>{team.owner}</div>
                  </td>
                  <td className="sfgl-standings-cell" style={{ ...theme.tableCell, textAlign: 'left' }}>
                    <div style={{ ...theme.statNumLg, letterSpacing: 3, fontWeight: 300, color: showSwing ? accentColor : (earnings > 0 ? colors.textPrimary : colors.textMuted) }}>
                      {formatEarnings(earnings)}
                    </div>
                  </td>
                  <td className="sfgl-standings-cell" style={{ ...theme.tableCell, textAlign: 'right' }}>
                    <div style={{ ...theme.statNum, fontSize: 'clamp(11px, 1.2vw, 14px)', letterSpacing: 1.5, fontWeight: 300, color: isSwingWinner ? accentColor.replace('0.85)', '1)') : behind === 0 ? colors.earningsGreen : colors.textSecondary }}>
                      {isSwingWinner ? 'Winner' : formatBehind(behind)}
                    </div>
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
