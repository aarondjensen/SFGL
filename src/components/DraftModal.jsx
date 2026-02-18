import { useState, useEffect } from 'react';
import { X, Search } from 'lucide-react';

export const DraftModal = ({ teams, allPlayers, updateTeams, onClose }) => {
  const [phase, setPhase] = useState('order'); // 'order', 'keepers', or 'draft'
  const [draftOrder, setDraftOrder] = useState(teams.map((t, i) => ({ ...t, order: i })));
  const [keeperTeamIndex, setKeeperTeamIndex] = useState(0);
  const [keepers, setKeepers] = useState({}); // { teamId: { limited: {name, stars}, unlimited: {name} } }
  const [currentTeamIndex, setCurrentTeamIndex] = useState(0);
  const [currentRound, setCurrentRound] = useState(1);
  const [draftedPlayers, setDraftedPlayers] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [limitedSearch, setLimitedSearch] = useState('');
  const [unlimitedSearch, setUnlimitedSearch] = useState('');

  // Initialize keepers object
  useEffect(() => {
    const initialKeepers = {};
    teams.forEach(team => {
      initialKeepers[team.id] = { limited: null, unlimited: null };
    });
    setKeepers(initialKeepers);
  }, [teams]);

  const currentTeam = phase === 'order' 
    ? null 
    : draftOrder[phase === 'keepers' ? keeperTeamIndex : currentTeamIndex];
  const currentKeeper = keepers[currentTeam?.id] || { limited: null, unlimited: null };
  
  const availablePlayers = allPlayers
    .filter(p => {
      // Filter out already selected keepers
      const allKeeperNames = Object.values(keepers).flatMap(k => 
        [k.limited?.name, k.unlimited?.name].filter(Boolean)
      );
      return !allKeeperNames.includes(p.name);
    })
    .filter(p => !draftedPlayers.includes(p.name))
    .filter(p => p.name.toLowerCase().includes(searchQuery.toLowerCase()))
    .slice(0, 50);

  // Separate search results for keeper selection
  const limitedSearchResults = allPlayers
    .filter(p => {
      const allKeeperNames = Object.values(keepers).flatMap(k => 
        [k.limited?.name, k.unlimited?.name].filter(Boolean)
      );
      return !allKeeperNames.includes(p.name);
    })
    .filter(p => p.name.toLowerCase().includes(limitedSearch.toLowerCase()))
    .slice(0, 10);

  const unlimitedSearchResults = allPlayers
    .filter(p => {
      const allKeeperNames = Object.values(keepers).flatMap(k => 
        [k.limited?.name, k.unlimited?.name].filter(Boolean)
      );
      return !allKeeperNames.includes(p.name);
    })
    .filter(p => p.name.toLowerCase().includes(unlimitedSearch.toLowerCase()))
    .slice(0, 10);

  const moveDraftOrder = (fromIndex, direction) => {
    const toIndex = fromIndex + direction;
    if (toIndex < 0 || toIndex >= draftOrder.length) return;
    
    const newOrder = [...draftOrder];
    [newOrder[fromIndex], newOrder[toIndex]] = [newOrder[toIndex], newOrder[fromIndex]];
    setDraftOrder(newOrder);
  };

  const handleStartKeepers = () => {
    setPhase('keepers');
  };

  const handleKeeperSelect = (playerName, type, stars = 1) => {
    const updatedKeepers = { ...keepers };
    if (type === 'limited') {
      updatedKeepers[currentTeam.id].limited = { name: playerName, stars };
    } else {
      updatedKeepers[currentTeam.id].unlimited = { name: playerName };
    }
    setKeepers(updatedKeepers);
    setSearchQuery('');
  };

  const handleNextTeamKeepers = () => {
    if (keeperTeamIndex < draftOrder.length - 1) {
      setKeeperTeamIndex(keeperTeamIndex + 1);
    } else {
      // All keepers selected, move to draft phase
      // Add keepers to rosters using draftOrder
      const updatedTeams = teams.map(team => {
        const teamKeepers = keepers[team.id];
        const newRoster = [];
        
        if (teamKeepers.limited) {
          newRoster.push({
            name: teamKeepers.limited.name,
            stars: teamKeepers.limited.stars,
            starts: 0,
            limited: true,
            unlimited: false,
            eventsPlayed: 0,
            cutsMade: 0,
            sfglEarnings: 0,
            pgaTourEarnings: 0,
            headshot: '',
          });
        }
        
        if (teamKeepers.unlimited) {
          newRoster.push({
            name: teamKeepers.unlimited.name,
            starts: 0,
            limited: false,
            unlimited: true,
            eventsPlayed: 0,
            cutsMade: 0,
            sfglEarnings: 0,
            pgaTourEarnings: 0,
            headshot: '',
          });
        }
        
        return { ...team, roster: newRoster };
      });
      
      // Track keeper names as "drafted"
      const keeperNames = Object.values(keepers).flatMap(k => 
        [k.limited?.name, k.unlimited?.name].filter(Boolean)
      );
      
      updateTeams(updatedTeams);
      setDraftedPlayers(keeperNames);
      setPhase('draft');
      setCurrentRound(1); // Start with round 1 (Limited player)
    }
  };

  const handleDraftPlayer = (playerName) => {
    const isLimitedRound = currentRound <= 2;
    
    // Add player to current team using draftOrder
    const updatedTeams = teams.map(team => {
      if (team.id === currentTeam.id) {
        const newPlayer = {
          name: playerName,
          stars: isLimitedRound ? 1 : 0, // Limited players get 1 star (Year 1)
          starts: 0,
          limited: isLimitedRound,
          unlimited: !isLimitedRound,
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

    // Snake draft logic
    const isSnakeDraft = currentRound % 2 === 0;
    
    if (isSnakeDraft) {
      if (currentTeamIndex === 0) {
        setCurrentRound(currentRound + 1);
        setCurrentTeamIndex(0);
      } else {
        setCurrentTeamIndex(currentTeamIndex - 1);
      }
    } else {
      if (currentTeamIndex === draftOrder.length - 1) {
        setCurrentRound(currentRound + 1);
        setCurrentTeamIndex(draftOrder.length - 1);
      } else {
        setCurrentTeamIndex(currentTeamIndex + 1);
      }
    }

    setSearchQuery('');
  };

  const maxRounds = 12; // 2 limited + 10 unlimited
  const isDraftComplete = currentRound > maxRounds;

  // Draft Order Phase
  if (phase === 'order') {
    return (
      <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50">
        <div className="bg-gray-800 rounded-xl max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col">
          <div className="p-4 border-b border-gray-700 flex justify-between items-center">
            <div>
              <h2 className="text-xl font-bold">Set Draft Order</h2>
              <p className="text-sm text-gray-400 mt-1">Snake draft • Drag teams to reorder</p>
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-white">
              <X className="w-6 h-6" />
            </button>
          </div>

          <div className="flex-1 overflow-auto p-4">
            <div className="space-y-2">
              {draftOrder.map((team, idx) => (
                <div
                  key={team.id}
                  className="flex items-center justify-between bg-gray-700/50 rounded-lg px-4 py-3"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 bg-green-600 rounded-full flex items-center justify-center font-bold">
                      {idx + 1}
                    </div>
                    <span className="font-medium">{team.name}</span>
                  </div>
                  <div className="flex gap-1">
                    <button
                      onClick={() => moveDraftOrder(idx, -1)}
                      disabled={idx === 0}
                      className={`w-8 h-8 rounded flex items-center justify-center ${
                        idx === 0
                          ? 'text-gray-600 cursor-not-allowed'
                          : 'text-green-400 hover:bg-gray-600'
                      }`}
                    >
                      ▲
                    </button>
                    <button
                      onClick={() => moveDraftOrder(idx, 1)}
                      disabled={idx === draftOrder.length - 1}
                      className={`w-8 h-8 rounded flex items-center justify-center ${
                        idx === draftOrder.length - 1
                          ? 'text-gray-600 cursor-not-allowed'
                          : 'text-green-400 hover:bg-gray-600'
                      }`}
                    >
                      ▼
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="p-4 border-t border-gray-700 bg-gray-900/50">
            <div className="text-xs text-gray-400 mb-3">
              <strong>Snake Draft Format:</strong> Order reverses each round. Example: Round 1: 1→5, Round 2: 5→1, Round 3: 1→5
            </div>
            <div className="flex justify-between">
              <button
                onClick={onClose}
                className="px-4 py-2 bg-gray-600 hover:bg-gray-500 rounded font-medium"
              >
                Cancel Draft
              </button>
              <button
                onClick={handleStartKeepers}
                className="px-4 py-2 bg-green-600 hover:bg-green-500 rounded font-bold"
              >
                Continue to Keepers
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Keeper Selection Phase
  if (phase === 'keepers') {
    const canProceed = currentKeeper.limited && currentKeeper.unlimited;
    
    return (
      <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50">
        <div className="bg-gray-800 rounded-xl max-w-3xl w-full h-[600px] flex flex-col">
          <div className="p-4 border-b border-gray-700 flex justify-between items-center flex-shrink-0">
            <div>
              <h2 className="text-xl font-bold">Keeper Selection</h2>
              <p className="text-sm text-gray-400 mt-1">
                Team {keeperTeamIndex + 1} of {draftOrder.length} • <span className="text-green-400 font-medium">{currentTeam.name}</span>
              </p>
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-white">
              <X className="w-6 h-6" />
            </button>
          </div>

          <div className="flex-1 overflow-auto p-4 min-h-0">
            <h3 className="font-bold text-sm mb-4">Select 2 Keepers:</h3>
            
            <div className="space-y-4">
              {/* Limited Keeper */}
              <div className="bg-yellow-900/20 border border-yellow-700/50 rounded-lg p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 bg-yellow-600 rounded text-sm font-bold flex items-center justify-center">L</div>
                    <span className="font-bold">Limited Player</span>
                  </div>
                  {currentKeeper.limited && (
                    <button
                      onClick={() => handleKeeperSelect(null, 'limited')}
                      className="text-xs text-red-400 hover:text-red-300 font-medium"
                    >
                      Clear
                    </button>
                  )}
                </div>
                
                {currentKeeper.limited ? (
                  <div className="space-y-2">
                    <div className="bg-gray-700/50 rounded px-3 py-2">
                      <span className="font-medium">{currentKeeper.limited.name}</span>
                    </div>
                    <div>
                      <div className="text-xs text-gray-400 mb-1">Years of Service:</div>
                      <div className="flex gap-2">
                        {[1, 2, 3].map(num => (
                          <button
                            key={num}
                            onClick={() => handleKeeperSelect(currentKeeper.limited.name, 'limited', num)}
                            className={`w-10 h-10 rounded text-lg font-bold transition-colors ${
                              num <= currentKeeper.limited.stars
                                ? 'bg-yellow-500 hover:bg-yellow-400'
                                : 'bg-gray-600 hover:bg-gray-500'
                            }`}
                          >
                            ★
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div>
                    <div className="relative mb-2">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                      <input
                        type="text"
                        placeholder="Search for Limited player..."
                        value={limitedSearch}
                        onChange={e => setLimitedSearch(e.target.value)}
                        className="w-full bg-gray-900 border border-gray-600 rounded-lg pl-10 pr-4 py-2 text-sm"
                      />
                    </div>
                    {limitedSearch.trim() && !currentKeeper.limited && (
                      <div className="h-32 overflow-y-auto bg-gray-900 rounded border border-gray-700">
                        {limitedSearchResults.length > 0 ? (
                          limitedSearchResults.map(player => (
                            <button
                              key={player.name}
                              onClick={() => {
                                handleKeeperSelect(player.name, 'limited', 2);
                                setLimitedSearch('');
                              }}
                              className="w-full flex items-center justify-between px-3 py-2 hover:bg-gray-700 border-b border-gray-700/50 last:border-0 text-left transition-colors"
                            >
                              <div>
                                <div className="font-medium text-sm">{player.name}</div>
                                <div className="text-xs text-gray-400">Rank: {player.worldRank}</div>
                              </div>
                              <div className="text-yellow-400 font-bold text-xs">Select</div>
                            </button>
                          ))
                        ) : (
                          <div className="text-center py-3 text-gray-500 text-xs">No players found</div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Unlimited Keeper */}
              <div className="bg-blue-900/20 border border-blue-700/50 rounded-lg p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 bg-blue-600 rounded text-sm font-bold flex items-center justify-center">U</div>
                    <span className="font-bold">Unlimited Player</span>
                  </div>
                  {currentKeeper.unlimited && (
                    <button
                      onClick={() => handleKeeperSelect(null, 'unlimited')}
                      className="text-xs text-red-400 hover:text-red-300 font-medium"
                    >
                      Clear
                    </button>
                  )}
                </div>
                
                {currentKeeper.unlimited ? (
                  <div className="bg-gray-700/50 rounded px-3 py-2">
                    <span className="font-medium">{currentKeeper.unlimited.name}</span>
                  </div>
                ) : (
                  <div>
                    <div className="relative mb-2">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                      <input
                        type="text"
                        placeholder="Search for Unlimited player..."
                        value={unlimitedSearch}
                        onChange={e => setUnlimitedSearch(e.target.value)}
                        className="w-full bg-gray-900 border border-gray-600 rounded-lg pl-10 pr-4 py-2 text-sm"
                      />
                    </div>
                    {unlimitedSearch.trim() && !currentKeeper.unlimited && (
                      <div className="h-32 overflow-y-auto bg-gray-900 rounded border border-gray-700">
                        {unlimitedSearchResults.length > 0 ? (
                          unlimitedSearchResults.map(player => (
                            <button
                              key={player.name}
                              onClick={() => {
                                handleKeeperSelect(player.name, 'unlimited');
                                setUnlimitedSearch('');
                              }}
                              className="w-full flex items-center justify-between px-3 py-2 hover:bg-gray-700 border-b border-gray-700/50 last:border-0 text-left transition-colors"
                            >
                              <div>
                                <div className="font-medium text-sm">{player.name}</div>
                                <div className="text-xs text-gray-400">Rank: {player.worldRank}</div>
                              </div>
                              <div className="text-blue-400 font-bold text-xs">Select</div>
                            </button>
                          ))
                        ) : (
                          <div className="text-center py-3 text-gray-500 text-xs">No players found</div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="p-4 border-t border-gray-700 flex justify-between flex-shrink-0">
            <button
              onClick={onClose}
              className="px-4 py-2 bg-gray-600 hover:bg-gray-500 rounded font-medium"
            >
              Cancel Draft
            </button>
            <button
              onClick={handleNextTeamKeepers}
              disabled={!canProceed}
              className={`px-4 py-2 rounded font-bold ${
                canProceed
                  ? 'bg-green-600 hover:bg-green-500'
                  : 'bg-gray-600 cursor-not-allowed opacity-50'
              }`}
            >
              {keeperTeamIndex < draftOrder.length - 1 ? 'Next Team' : 'Start Draft'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Draft Phase
  const isSnakeDraft = currentRound % 2 === 0;
  const isLimitedRound = currentRound <= 2;

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50">
      <div className="bg-gray-800 rounded-xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        <div className="p-4 border-b border-gray-700 flex justify-between items-center">
          <div>
            <h2 className="text-xl font-bold">Fantasy Golf Draft</h2>
            {!isDraftComplete && (
              <p className="text-sm text-gray-400 mt-1">
                Round {currentRound} of {maxRounds} • {isLimitedRound ? '🟡 Limited' : '🔵 Unlimited'} • <span className="text-green-400 font-medium">{currentTeam.name}</span> is picking
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
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type="text"
                  placeholder="Search players..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className="w-full bg-gray-900 border border-gray-600 rounded-lg pl-10 pr-4 py-2 text-sm"
                  autoFocus
                />
              </div>
            </div>

            <div className="flex-1 overflow-auto p-4">
              <div className="grid gap-2">
                {availablePlayers.map(player => (
                  <button
                    key={player.name}
                    onClick={() => handleDraftPlayer(player.name)}
                    className={`flex items-center justify-between rounded-lg px-4 py-3 text-left transition-colors ${
                      isLimitedRound
                        ? 'bg-yellow-900/20 hover:bg-yellow-900/30 border border-yellow-700/50'
                        : 'bg-blue-900/20 hover:bg-blue-900/30 border border-blue-700/50'
                    }`}
                  >
                    <div>
                      <div className="font-medium">{player.name}</div>
                      <div className="text-xs text-gray-400">Rank: {player.worldRank}</div>
                    </div>
                    <div className={`font-bold text-sm ${isLimitedRound ? 'text-yellow-400' : 'text-blue-400'}`}>
                      Draft {isLimitedRound ? '(L)' : '(U)'}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div className="p-4 border-t border-gray-700 bg-gray-900/50">
              <div className="text-xs text-gray-400 mb-2">
                Draft Order (Round {currentRound} - {isLimitedRound ? 'Limited' : 'Unlimited'}):
              </div>
              <div className="flex gap-2 overflow-x-auto">
                {(isSnakeDraft ? [...draftOrder].reverse() : draftOrder).map((team) => (
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
