import React, { useMemo } from 'react';
import { Trophy } from 'lucide-react';
import { getSegmentByDate } from '../utils/index.js';
import { theme, colors, fonts, getMedalStyle, rowHoverHandlers, earningsColor, segmentEarningsColor, cardLiftHandlers } from '../theme.js';

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

export const StandingsView = ({ teams }) => {
  const sortedTeams = useMemo(() =>
    [...teams]
      .sort((a, b) => b.earnings - a.earnings)
      .map((team, i) => ({ ...team, position: i + 1 })),
    [teams],
  );

  const segmentStandings = useMemo(() =>
    [...teams].sort((a, b) => (b.segmentEarnings || 0) - (a.segmentEarnings || 0)),
    [teams],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={theme.cardLift} {...cardLiftHandlers()}>

        {/* Header */}
        <div style={theme.cardHeader}>
          <Trophy style={{ width: 16, height: 16, color: colors.textGold }} />
          <h2 style={theme.h2}>Overall Standings</h2>
        </div>

        {/* Table */}
        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }} role="table">
          <colgroup>
            <col style={{ width: 56 }} />
            <col />
            <col style={{ width: '22%' }} />
            <col style={{ width: '22%' }} />
          </colgroup>
          <thead>
            <tr>
              {['Pos', 'Team', 'Season', getSegmentByDate()].map((h, i) => (
                <th key={h} scope="col" style={{
                  ...theme.tableHeaderCell,
                  textAlign: i >= 2 ? 'right' : 'left',
                }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedTeams.map((team, index) => {
              const segmentPos = segmentStandings.findIndex(t => t.id === team.id) + 1;
              const medal = getMedalStyle(index);
              const isTop = index === 0;
              return (
                <tr key={team.id}
                  className="sfgl-standings-row"
                  style={{ background: isTop ? 'rgba(180,160,100,0.04)' : 'transparent', transition: 'background 0.15s' }}
                  {...rowHoverHandlers(isTop)}
                >
                  <td className="sfgl-standings-cell" style={theme.tableCell}>
                    <div style={{
                      width: 32, height: 32, borderRadius: '50%',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 12, fontWeight: 700,
                      background: medal.bg, color: medal.text,
                      flexShrink: 0,
                    }}>
                      {team.position}
                    </div>
                  </td>

                  <td className="sfgl-standings-cell" style={{ ...theme.tableCell, overflow: 'hidden' }}>
                    <div style={{
                      ...theme.h3,
                      fontSize: 'clamp(14px, 1.4vw, 18px)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {team.name}
                    </div>
                    <div className="sfgl-owner" style={{ ...theme.smallText, marginTop: 1 }}>
                      {team.owner}
                    </div>
                  </td>

                  <td className="sfgl-standings-cell" style={{ ...theme.tableCell, textAlign: 'right' }}>
                    <div style={{ ...theme.statNumLg, color: earningsColor(team.earnings) }}>
                      ${(team.earnings || 0).toLocaleString()}
                    </div>
                  </td>

                  <td className="sfgl-standings-cell" style={{ ...theme.tableCell, textAlign: 'right' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
                      <span style={theme.smallText}>#{segmentPos}</span>
                      <span style={{ ...theme.statNum, fontSize: 13, color: segmentEarningsColor(team.segmentEarnings) }}>
                        ${(team.segmentEarnings || 0).toLocaleString()}
                      </span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

  const sortedTeams = useMemo(() =>
    [...teams]
      .sort((a, b) => b.earnings - a.earnings)
      .map((team, i) => ({ ...team, position: i + 1 })),
    [teams],
  );

  const segmentStandings = useMemo(() =>
    [...teams].sort((a, b) => (b.segmentEarnings || 0) - (a.segmentEarnings || 0)),
    [teams],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={theme.cardLift} {...cardLiftHandlers()}>

        {/* Header */}
        <div style={theme.cardHeader}>
          <Trophy style={{ width: 16, height: 16, color: colors.textGold }} />
          <h2 style={theme.h2}>Overall Standings</h2>
        </div>

        {/* Table */}
        <table style={{ width: '100%', borderCollapse: 'collapse' }} role="table">
          <thead>
            <tr>
              {['Pos', 'Team', 'Season', getSegmentByDate()].map((h, i) => (
                <th key={h} scope="col" style={{
                  ...theme.tableHeaderCell,
                  textAlign: i >= 2 ? 'right' : 'left',
                  width: i === 0 ? 56 : 'auto',
                }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedTeams.map((team, index) => {
              const segmentPos = segmentStandings.findIndex(t => t.id === team.id) + 1;
              const medal = getMedalStyle(index);
              const isTop = index === 0;
              return (
                <tr key={team.id}
                  style={{ ...theme.tableRow, background: isTop ? 'rgba(180,160,100,0.04)' : 'transparent' }}
                  {...rowHoverHandlers(isTop)}
                >
                  <td style={theme.tableCell}>
                    <div style={{
                      width: 32, height: 32, borderRadius: '50%',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 12, fontWeight: 700, fontFamily: fonts.serif,
                      background: medal.bg, color: medal.text,
                    }}
                      aria-label={`Position ${team.position}`}
                    >
                      {team.position}
                    </div>
                  </td>

                  <td style={theme.tableCell}>
                    <div style={{ ...theme.h3, fontSize: 'clamp(16px, 1.4vw, 20px)' }}>{team.name}</div>
                    <div style={{ ...theme.smallText, marginTop: 1 }}>{team.owner}</div>
                  </td>

                  <td style={{ ...theme.tableCell, textAlign: 'right' }}>
                    <div style={{
                      ...theme.statNumLg,
                      color: earningsColor(team.earnings),
                    }}>
                      ${(team.earnings || 0).toLocaleString()}
                    </div>
                  </td>

                  <td style={{ ...theme.tableCell, textAlign: 'right' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
                      <span style={theme.smallText}>#{segmentPos}</span>
                      <span style={{
                        ...theme.statNum, fontSize: 13,
                        color: segmentEarningsColor(team.segmentEarnings),
                      }}>
                        ${(team.segmentEarnings || 0).toLocaleString()}
                      </span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
