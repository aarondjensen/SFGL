import { useState } from 'react';
import { X } from 'lucide-react';

export const DraftModal = ({ teams, allPlayers, updateTeams, onClose }) => {
  const [currentTeamIndex, setCurrentTeamIndex] = useState(0);
  const [currentRound, setCurrentRound] = useState(1);
  const [draftedPlayers, setDraftedPlayers] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');

  const currentTeam = teams[currentTeamIndex];
  const isSnakeDraft = currentRound % 2 === 0;
  
  const availablePlayers = allPlayers
    .filter(p => !draftedPlayers.includes(p.name))
    .filter(p => p.name.toLowerCase().includes(searchQuery.toLowerCase()))
    .slice(0, 50);

  const handleDraftPlayer = (playerName) => {
    // Add player to current team
    const updatedTeams = teams.map(team => {
      if (team.id === currentTeam.id) {
        const newPlayer = {
          name: playerName,
          starts: 0,
          limited: false,
          unlimited: false,
          eventsPlayed: 0,
          cutsMade: 0,
          sfglEarnings: 0,
          pgaTourEarnings: 0,
          headshot: '',
        };
        return { ...team, roster: [...team.roster, newPlayer] };
      }
      return team;
    });

    setDraftedPlayers([...draftedPlayers, playerName]);
    updateTeams(updatedTeams);

    // Move to next team
    if (isSnakeDraft) {
      // Snake draft: reverse order on even rounds
      if (currentTeamIndex === 0) {
        setCurrentRound(currentRound + 1);
        setCurrentTeamIndex(0);
      } else {
        setCurrentTeamIndex(currentTeamIndex - 1);
      }
    } else {
      // Normal order on odd rounds
      if (currentTeamIndex === teams.length - 1) {
        setCurrentRound(currentRound + 1);
        setCurrentTeamIndex(teams.length - 1);
      } else {
        setCurrentTeamIndex(currentTeamIndex + 1);
      }
    }

    setSearchQuery('');
  };

  const maxRounds = 12; // Typical roster size
  const isDraftComplete = currentRound > maxRounds;

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50">
      <div className="bg-gray-800 rounded-xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        <div className="p-4 border-b border-gray-700 flex justify-between items-center">
          <div>
            <h2 className="text-xl font-bold">Fantasy Golf Draft</h2>
            {!isDraftComplete && (
              <p className="text-sm text-gray-400 mt-1">
                Round {currentRound} • <span className="text-green-400 font-medium">{currentTeam.name}</span> is picking
              </p>
            )}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            <X className="w-6 h-6" />
          </button>
        </div>

        {isDraftComplete ? (
          <div className="flex-1 p-8 text-center">
            <div className="text-6xl mb-4">🎉</div>
            <h3 className="text-2xl font-bold mb-2">Draft Complete!</h3>
            <p className="text-gray-400 mb-6">All teams have drafted their rosters.</p>
            <button
              onClick={onClose}
              className="px-6 py-3 bg-green-600 hover:bg-green-700 rounded-lg font-bold"
            >
              Close Draft
            </button>
          </div>
        ) : (
          <>
            <div className="p-4 border-b border-gray-700">
              <input
                type="text"
                placeholder="Search players..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="w-full bg-gray-900 border border-gray-600 rounded-lg px-4 py-2 text-sm"
                autoFocus
              />
            </div>

            <div className="flex-1 overflow-auto p-4">
              <div className="grid gap-2">
                {availablePlayers.map(player => (
                  <button
                    key={player.name}
                    onClick={() => handleDraftPlayer(player.name)}
                    className="flex items-center justify-between bg-gray-700/50 hover:bg-gray-700 rounded-lg px-4 py-3 text-left transition-colors"
                  >
                    <div>
                      <div className="font-medium">{player.name}</div>
                      <div className="text-xs text-gray-400">Rank: {player.worldRank}</div>
                    </div>
                    <div className="text-green-400 font-bold">Draft</div>
                  </button>
                ))}
              </div>
            </div>

            <div className="p-4 border-t border-gray-700 bg-gray-900/50">
              <div className="text-xs text-gray-400 mb-2">Draft Order (Round {currentRound}):</div>
              <div className="flex gap-2 overflow-x-auto">
                {(isSnakeDraft ? [...teams].reverse() : teams).map((team, idx) => (
                  <div
                    key={team.id}
                    className={`flex-shrink-0 px-3 py-1.5 rounded text-xs font-medium ${
                      team.id === currentTeam.id
                        ? 'bg-green-600 text-white'
                        : 'bg-gray-700 text-gray-400'
                    }`}
                  >
                    {team.name}
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
