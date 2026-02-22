import React, { useMemo, useState } from 'react';
import { Trophy } from 'lucide-react';
import { theme, colors, fonts, getMedalStyle, rowHoverHandlers, earningsColor } from '../theme.js';

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
  if (!n || n <= 0) return 'Leader';
  if (n >= 1_000_000) return '-$' + (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000)     return '-$' + Math.round(n / 1_000) + 'k';
  return '-$' + n;
};

const ALL_SWINGS = ['West Coast Swing', 'Spring Swing', 'Summer Swing', 'Fall Finish'];

const SWING_ACCENT = {
  'West Coast Swing': 'rgba(100,160,255,0.85)',
  'Spring Swing':     'rgba(80,200,120,0.85)',
  'Summer Swing':     'rgba(220,180,60,0.85)',
  'Fall Finish':      'rgba(220,120,60,0.85)',
};

const MONTH_ABBREVS = { Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12 };
const getSegmentForTournament = (t) => {
  if (t.segment) return t.segment;
  if (t.swing) return t.swing;
  if (!t.dates) return null;
  const match = t.dates.match(/^([A-Za-z]+)/);
  if (!match) return null;
  const month = MONTH_ABBREVS[match[1]];
  if (!month) return null;
  if (month >= 1 && month <= 3) return 'West Coast Swing';
  if (month >= 4 && month <= 6) return 'Spring Swing';
  if (month >= 7 && month <= 9) return 'Summer Swing';
  return 'Fall Finish';
};

export const StandingsView = ({ teams, tournaments = [] }) => {

  // ── Overall ──────────────────────────────────────────────────────────────
  const sortedTeams = useMemo(() =>
    [...teams]
      .sort((a, b) => (b.earnings || 0) - (a.earnings || 0))
      .map((t, i) => ({ ...t, position: i + 1 })),
    [teams],
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

  // ── Toggle ───────────────────────────────────────────────────────────────
  const [view, setView] = useState('overall');
  const showSwing    = view === 'swing';
  const accentColor  = selectedSwing ? SWING_ACCENT[selectedSwing] : colors.textSecondary;

  const displayRows   = showSwing ? swingStandings : sortedTeams;
  const displayLeader = showSwing ? swingLeader : leader;
  const earningsKey   = showSwing ? 'swingEarnings' : 'earnings';
  const posKey        = showSwing ? 'swingPos' : 'position';
  const earningsLabel = showSwing ? 'Swing $' : 'Season $';

  const tabStyle = (active, accent) => ({
    padding: '5px 14px',
    borderRadius: 2,
    fontFamily: fonts.sans,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '1.2px',
    textTransform: 'uppercase',
    cursor: 'pointer',
    transition: 'all 0.18s',
    border: `1px solid ${active ? (accent || colors.border) : colors.borderSubtle}`,
    background: active ? (accent ? accent.replace('0.85)', '0.12)') : 'rgba(180,160,100,0.08)') : 'transparent',
    color: active ? (accent || colors.textGold) : colors.textMuted,
  });

  return (
    <div style={theme.card}>

      {/* Header */}
      <div style={{ ...theme.cardHeader, justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Trophy style={{ width: 16, height: 16, color: colors.earningsGreen }} />
          <h2 style={theme.h2}>Standings</h2>
          {showSwing && swingEventCount > 0 && (
            <span style={{ fontFamily: fonts.sans, fontSize: 10, fontWeight: 600, letterSpacing: 0.8, textTransform: 'uppercase', color: colors.textMuted }}>
              {swingEventCount} event{swingEventCount !== 1 ? 's' : ''}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button onClick={() => setView('overall')} style={tabStyle(!showSwing, null)}>
            Overall
          </button>
          <button
            onClick={() => {
              setView('swing');
              if (!selectedSwing && swingsWithResults.length) setSelectedSwing(swingsWithResults[swingsWithResults.length - 1]);
            }}
            disabled={swingsWithResults.length === 0}
            style={{ ...tabStyle(showSwing, showSwing ? accentColor : null), opacity: swingsWithResults.length === 0 ? 0.35 : 1, cursor: swingsWithResults.length === 0 ? 'default' : 'pointer' }}
          >
            Swing
          </button>

          {showSwing && swingsWithResults.length > 1 && (
            <select
              value={selectedSwing || ''}
              onChange={e => setSelectedSwing(e.target.value)}
              style={{ ...theme.select, width: 'auto', fontSize: 11, padding: '5px 10px', marginLeft: 4, color: accentColor, borderColor: accentColor.replace('0.85', '0.3'), background: '#0d1b2e', appearance: 'none', WebkitAppearance: 'none' }}
            >
              {swingsWithResults.map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          )}
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
            <col style={{ width: '22%' }} />
            <col style={{ width: '22%' }} />
          </colgroup>
          <thead>
            <tr>
              {['Pos', 'Team', earningsLabel, '$ Behind'].map((h, i) => (
                <th key={h} style={{ ...theme.tableHeaderCell, textAlign: i >= 2 ? 'right' : 'left' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayRows.map((team, index) => {
              const earnings = team[earningsKey] || 0;
              const behind   = displayLeader - earnings;
              const medal    = getMedalStyle(index);
              const isTop    = index === 0;
              return (
                <tr key={team.id} className="sfgl-standings-row"
                  style={{ background: isTop ? 'rgba(180,160,100,0.04)' : 'transparent', transition: 'background 0.15s' }}
                  {...rowHoverHandlers(isTop)}
                >
                  <td className="sfgl-standings-cell" style={theme.tableCell}>
                    <div style={{ width: 32, height: 32, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, background: medal.bg, color: medal.text, flexShrink: 0 }}>
                      {team[posKey]}
                    </div>
                  </td>
                  <td className="sfgl-standings-cell" style={{ ...theme.tableCell, overflow: 'hidden' }}>
                    <div style={{ ...theme.h3, fontSize: 'clamp(13px,1.4vw,17px)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {team.name}
                    </div>
                    <div className="sfgl-owner" style={{ ...theme.smallText, marginTop: 1 }}>{team.owner}</div>
                  </td>
                  <td className="sfgl-standings-cell" style={{ ...theme.tableCell, textAlign: 'right' }}>
                    <div style={{ ...theme.statNumLg, color: earningsColor(earnings) }}>
                      {formatEarnings(earnings)}
                    </div>
                  </td>
                  <td className="sfgl-standings-cell" style={{ ...theme.tableCell, textAlign: 'right' }}>
                    <div style={{ ...theme.statNum, fontSize: 13, color: behind === 0 ? colors.earningsGreen : colors.textSecondary }}>
                      {formatBehind(behind)}
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
