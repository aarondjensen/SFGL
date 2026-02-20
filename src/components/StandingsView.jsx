import React, { useMemo } from 'react';
import { Trophy } from 'lucide-react';
import { getSegmentByDate } from '../utils/index.js';
import { theme, colors, fonts, getMedalStyle, rowHoverHandlers, earningsColor, segmentEarningsColor, cardLiftHandlers } from '../theme.js';

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
