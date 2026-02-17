import React, { useState, useMemo } from 'react';
import { Calendar, Clock, ChevronDown, ChevronRight } from 'lucide-react';
import { getSortedRoster, shortName, isTournamentLocked } from '../utils';

const PlayerSlotGrid = ({ players, showEarnings }) => {
  const slots = [0, 1, 2, 3, 4].map(i => players[i] || null);
  return (
    <div className="ml-7 grid grid-cols-5 gap-1">
      {slots.map((p, idx) => (
        <div key={idx} className="text-xs min-w-0 truncate">
          {p ? (
            <>
              <span className={
                showEarnings
                  ? p.limited ? (p.earnings > 0 ? 'text-yellow-400' : 'text-yellow-300/40') : (p.earnings > 0 ? 'text-gray-300' : 'text-gray-500')
                  : p.limited ? 'text-yellow-400/60' : 'text-gray-400'
              }>
                {shortName(p.name)}
              </span>
              {showEarnings && p.roundsLed?.map((rl, ri) => (
                <span key={ri} className="ml-0.5 px-1 bg-blue-600/60 text-blue-200 rounded">R{rl.round}</span>
              ))}
              <br />
              {showEarnings ? (
                <>
                  <span className={p.earnings > 0 ? 'text-green-400' : 'text-gray-500'}>
                    ${(p.earnings || 0).toLocaleString()}
                  </span>
                  {p.bonus > 0 && (
                    <span className="text-blue-300 ml-0.5">+{p.bonus.toLocaleString()}</span>
                  )}
                </>
              ) : (
                <span className="text-gray-600">—</span>
              )}
            </>
          ) : (
            <span className="text-gray-700">—</span>
          )}
        </div>
      ))}
    </div>
  );
};

const TournamentBadges = ({ tournament }) => (
  <>
    {tournament.isMajor    && <span className="px-1.5 py-0.5 bg-yellow-600  text-white text-xs rounded font-bold">M</span>}
    {tournament.isSignature && !tournament.isMajor && <span className="px-1.5 py-0.5 bg-purple-600 text-white text-xs rounded">S</span>}
  </>
);

export const ResultsView = ({ teams, tournaments }) => {
  const [expandedTournament, setExpandedTournament] = useState(null);

  const completedTournaments = useMemo(() =>
    [...tournaments.filter(t => t.completed)].reverse(),
    [tournaments],
  );

  const inProgressTournaments = useMemo(() =>
    tournaments.filter(t => t.playing && !t.completed && isTournamentLocked(t)),
    [tournaments],
  );

  const toggle = (name) => setExpandedTournament(prev => prev === name ? null : name);

  if (completedTournaments.length === 0 && inProgressTournaments.length === 0) {
    return (
      <div className="bg-gray-800/50 backdrop-blur rounded-xl border border-green-700/30 p-8 text-center">
        <Calendar className="w-16 h-16 text-gray-600 mx-auto mb-4" />
        <h3 className="text-xl font-bold text-gray-400 mb-2">No Completed Tournaments Yet</h3>
        <p className="text-gray-500">Tournament results will appear here after processing</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* In-progress tournaments */}
      {inProgressTournaments.map((tournament) => {
        const isExpanded     = expandedTournament === tournament.name;
        const teamsWithLineups = teams.filter(t => t.lineup?.length > 0).sort((a, b) => a.name.localeCompare(b.name));

        return (
          <div key={tournament.name} className="bg-gray-800/50 backdrop-blur rounded-xl border border-green-500/40 overflow-hidden shadow-lg shadow-green-900/20">
            <button
              onClick={() => toggle(tournament.name)}
              className="w-full px-4 py-3 bg-gradient-to-r from-green-600/20 to-transparent border-b border-green-600/30 flex items-center justify-between hover:bg-green-600/10 transition-colors"
              aria-expanded={isExpanded}
            >
              <div className="flex items-center gap-3">
                <div className="relative">
                  <Clock className="w-4 h-4 text-green-400 flex-shrink-0" />
                  <span className="absolute -top-1 -right-1 w-2 h-2 bg-green-400 rounded-full animate-pulse" />
                </div>
                <div className="text-left">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-bold text-green-300">{tournament.name}</h3>
                    <span className="px-1.5 py-0.5 bg-green-600/30 text-green-300 text-xs rounded font-semibold border border-green-500/40">In Progress</span>
                    <TournamentBadges tournament={tournament} />
                  </div>
                  <p className="text-xs text-gray-400">{tournament.dates} · {tournament.location}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                {!isExpanded && teamsWithLineups.length > 0 && (
                  <div className="text-right hidden sm:block">
                    <div className="text-xs text-gray-500">{teamsWithLineups.length} lineup{teamsWithLineups.length !== 1 ? 's' : ''} set</div>
                  </div>
                )}
                {isExpanded ? <ChevronDown className="w-4 h-4 text-green-400" /> : <ChevronRight className="w-4 h-4 text-green-400" />}
              </div>
            </button>

            {isExpanded && (
              <div className="divide-y divide-gray-700/40">
                {teamsWithLineups.length === 0 ? (
                  <div className="px-4 py-4 text-center text-gray-500 text-sm">No teams have submitted lineups yet</div>
                ) : teamsWithLineups.map((team) => {
                  const lineupPlayers = team.lineup.map(name => team.roster.find(p => p.name === name) || { name, limited: false });
                  const sortedLineup  = getSortedRoster(lineupPlayers);
                  return (
                    <div key={team.id} className="px-4 py-2">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-bold w-5 text-center text-gray-500">—</span>
                        <span className="font-semibold text-sm">{team.name}</span>
                        <span className="text-green-400/50 text-xs italic">pending</span>
                      </div>
                      <PlayerSlotGrid players={sortedLineup} showEarnings={false} />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {/* Completed tournaments */}
      {completedTournaments.map((tournament) => {
        const isExpanded  = expandedTournament === tournament.name;
        const results     = tournament.results;
        const rankedTeams = teams
          .map(t => ({ ...t, result: results?.teams?.[t.id] }))
          .filter(t => t.result)
          .sort((a, b) => (b.result.totalEarnings || 0) - (a.result.totalEarnings || 0));

        return (
          <div key={tournament.name} className="bg-gray-800/50 backdrop-blur rounded-xl border border-purple-700/30 overflow-hidden">
            <button
              onClick={() => toggle(tournament.name)}
              className="w-full px-4 py-3 bg-gradient-to-r from-purple-600/20 to-transparent border-b border-purple-700/30 flex items-center justify-between hover:bg-purple-600/10 transition-colors"
              aria-expanded={isExpanded}
            >
              <div className="flex items-center gap-3">
                <Calendar className="w-4 h-4 text-purple-400 flex-shrink-0" />
                <div className="text-left">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-bold">{tournament.name}</h3>
                    <TournamentBadges tournament={tournament} />
                  </div>
                  <p className="text-xs text-gray-400">{tournament.dates} · {tournament.location}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                {!isExpanded && rankedTeams.length > 0 && (
                  <div className="text-right hidden sm:block">
                    <div className="text-xs text-gray-500">Winner</div>
                    <div className="text-sm font-semibold text-green-400">{rankedTeams[0]?.name}</div>
                  </div>
                )}
                {isExpanded ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
              </div>
            </button>

            {isExpanded && results && (
              <div className="divide-y divide-gray-700/40">
                {rankedTeams.map((team, rank) => {
                  const tr      = team.result;
                  const players = getSortedRoster(tr.players || []);
                  return (
                    <div key={team.id} className={`px-4 py-2 ${rank === 0 ? 'bg-green-600/5' : ''}`}>
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`text-xs font-bold w-5 text-center ${rank === 0 ? 'text-yellow-400' : 'text-gray-500'}`}>{rank + 1}</span>
                        <span className="font-semibold text-sm">{team.name}</span>
                        <span className="text-green-400 font-bold text-sm">${(tr.totalEarnings || 0).toLocaleString()}</span>
                      </div>
                      <PlayerSlotGrid players={players} showEarnings />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
