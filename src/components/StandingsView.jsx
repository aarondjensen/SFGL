import React, { useMemo } from 'react';
import { Trophy } from 'lucide-react';
import { getSegmentByDate } from '../utils/index.js';

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
    <div className="space-y-4">
      <div className="bg-gray-800/50 backdrop-blur rounded-xl border border-green-700/30 overflow-hidden">
        <div className="p-4 bg-gradient-to-r from-green-600/20 to-transparent border-b border-green-700/30">
          <h2 className="text-xl font-bold flex items-center gap-2">
            <Trophy className="w-5 h-5 text-yellow-400" />
            Overall Standings
          </h2>
        </div>

        <table className="w-full" role="table">
          <thead className="bg-gray-700/50 text-xs sm:text-sm">
            <tr>
              <th className="px-2 sm:px-4 py-2 text-left w-10 sm:w-14" scope="col">Pos</th>
              <th className="px-2 sm:px-4 py-2 text-left"               scope="col">Team</th>
              <th className="px-2 sm:px-4 py-2 text-right"              scope="col">Season</th>
              <th className="px-2 sm:px-4 py-2 text-right"              scope="col">{getSegmentByDate()}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-700/50">
            {sortedTeams.map((team, index) => {
              const segmentPos = segmentStandings.findIndex(t => t.id === team.id) + 1;
              return (
                <tr key={team.id} className="hover:bg-gray-700/30 transition-colors">
                  <td className="px-2 sm:px-4 py-2">
                    <div
                      className={`w-7 h-7 sm:w-9 sm:h-9 rounded-full flex items-center justify-center font-bold text-xs sm:text-sm ${
                        index === 0 ? 'bg-yellow-500 text-gray-900'
                        : index === 1 ? 'bg-gray-400 text-gray-900'
                        : index === 2 ? 'bg-orange-600 text-white'
                        : 'bg-gray-700 text-gray-300'
                      }`}
                      aria-label={`Position ${team.position}`}
                    >
                      {team.position}
                    </div>
                  </td>
                  <td className="px-2 sm:px-4 py-2">
                    <div className="font-semibold text-sm sm:text-base">{team.name}</div>
                    <div className="text-xs text-gray-400">{team.owner}</div>
                  </td>
                  <td className="px-2 sm:px-4 py-2 text-right">
                    <div className="text-base sm:text-lg font-bold text-green-400" style={{ fontVariantNumeric: 'tabular-nums' }}>
                      ${(team.earnings || 0).toLocaleString()}
                    </div>
                  </td>
                  <td className="px-2 sm:px-4 py-2 text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      <span className="text-xs text-gray-500">#{segmentPos}</span>
                      <span className="text-xs sm:text-sm text-gray-400" style={{ fontVariantNumeric: 'tabular-nums' }}>
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
