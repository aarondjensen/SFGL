import { useState, useEffect } from 'react';
import { X, Search } from 'lucide-react';
import { draftStateApi } from '../api';

export const DraftModal = ({ teams, allPlayers, updateTeams, onClose, headshots = {} }) => {
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
  const [draggedIndex, setDraggedIndex] = useState(null);
  const [confirmDraft, setConfirmDraft] = useState(null); // { playerName, type }

  // Load saved draft state from Supabase on mount
  useEffect(() => {
    const loadDraftState = async () => {
      try {
        const savedState = await draftStateApi.get();
        if (savedState && savedState.draft_order?.length === teams.length) {
          setPhase(savedState.phase || 'order');
          setDraftOrder(savedState.draft_order || draftOrder);
          setKeeperTeamIndex(savedState.keeper_team_index || 0);
          setKeepers(savedState.keepers || {});
          setCurrentTeamIndex(savedState.current_team_index || 0);
          setCurrentRound(savedState.current_round || 1);
          setDraftedPlayers(savedState.drafted_players || []);
        }
      } catch (e) {
        console.error('Failed to restore draft state:', e);
      }
    };
    loadDraftState();
  }, []); // Only run once on mount

  // Save draft state to Supabase whenever it changes
  useEffect(() => {
    if (phase !== 'order' || Object.keys(keepers).length > 0) {
      const saveDraftState = async () => {
        try {
          await draftStateApi.save({
            phase,
            draftOrder,
            keeperTeamIndex,
            keepers,
            currentTeamIndex,
            currentRound,
            draftedPlayers,
          });
        } catch (e) {
          console.error('Failed to save draft state:', e);
        }
      };
      saveDraftState();
    }
  }, [phase, draftOrder, keeperTeamIndex, keepers, currentTeamIndex, currentRound, draftedPlayers]);

  // Initialize keepers object
  useEffect(() => {
    // Only initialize if keepers is empty (no saved state)
    if (Object.keys(keepers).length === 0) {
      const initialKeepers = {};
      teams.forEach(team => {
        initialKeepers[team.id] = { limited: null, unlimited: null };
      });
      setKeepers(initialKeepers);
    }
  }, [teams]);

  // Clear saved draft state from Supabase
  const clearDraftState = async () => {
    try {
      await draftStateApi.clear();
    } catch (e) {
      console.error('Failed to clear draft state:', e);
    }
  };

  // Close and optionally clear draft
  const handleClose = () => {
    if (phase === 'draft' && draftedPlayers.length > 0) {
      const save = window.confirm('Save draft progress? Click OK to save and resume later, or Cancel to discard and start over next time.');
      if (!save) {
        clearDraftState();
      }
    }
    onClose();
  };

  // Start fresh draft (clear saved state)
  const startFreshDraft = () => {
    if (window.confirm('Start a brand new draft? This will discard any saved progress.')) {
      clearDraftState();
      window.location.reload();
    }
  };

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

  const handleDragStart = (index) => {
    setDraggedIndex(index);
  };

  const handleDragOver = (e, index) => {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === index) return;
    
    const newOrder = [...draftOrder];
    const draggedItem = newOrder[draggedIndex];
    newOrder.splice(draggedIndex, 1);
    newOrder.splice(index, 0, draggedItem);
    
    setDraftOrder(newOrder);
    setDraggedIndex(index);
  };

  const handleDragEnd = () => {
    setDraggedIndex(null);
  };

  const handleStartKeepers = () => {
    setPhase('keepers');
  };

  const getPlayerHeadshot = (playerName) => {
    // First try the headshots object (legacy)
    let headshotId = headshots[playerName];
    
    // If not found, check if player has pgaTourId in allPlayers
    if (!headshotId) {
      const player = allPlayers.find(p => p.name === playerName);
      headshotId = player?.pgaTourId;
    }
    
    if (headshotId) {
      // Try ESPN headshot URL
      return `https://a.espncdn.com/combiner/i?img=/i/headshots/golf/players/full/${headshotId}.png&w=96&h=96`;
    }
    
    // Fallback to UI Avatars
    return `https://ui-avatars.com/api/?name=${encodeURIComponent(playerName)}&background=1f2937&color=9ca3af&size=128`;
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
    setConfirmDraft({ playerName, type: currentRound <= 2 ? 'limited' : 'unlimited' });
  };

  const confirmDraftPlayer = () => {
    const playerName = confirmDraft.playerName;
    const isLimitedRound = currentRound <= 2;
    
    // Add player to current team using draftOrder
    const updatedTeams = teams.map(team => {
      if (team.id === currentTeam.id) {
        const newPlayer = {
          name: playerName,
          stars: isLimitedRound ? 1 : 0,
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
    setConfirmDraft(null);
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
                  draggable
                  onDragStart={() => handleDragStart(idx)}
                  onDragOver={(e) => handleDragOver(e, idx)}
                  onDragEnd={handleDragEnd}
                  className={`flex items-center justify-between bg-gray-700/50 rounded-lg px-4 py-3 cursor-move transition-all ${
                    draggedIndex === idx 
                      ? 'opacity-50 scale-95' 
                      : 'hover:bg-gray-700 hover:shadow-lg'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 bg-green-600 rounded-full flex items-center justify-center font-bold">
                      {idx + 1}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-gray-400">⋮⋮</span>
                      <span className="font-medium">{team.name}</span>
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        moveDraftOrder(idx, -1);
                      }}
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
                      onClick={(e) => {
                        e.stopPropagation();
                        moveDraftOrder(idx, 1);
                      }}
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
              <p className="text-xs text-blue-400 mt-1">💾 Draft auto-saves - you can close and resume anytime</p>
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
                <div className="flex items-center gap-3 mb-3">
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <div className="w-7 h-7 bg-yellow-600 rounded text-sm font-bold flex items-center justify-center">L</div>
                    <span className="font-bold whitespace-nowrap">Yellow Keeper</span>
                  </div>
                  {!currentKeeper.limited && (
                    <div className="relative flex-1">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                      <input
                        type="text"
                        placeholder="Search for Limited player..."
                        value={limitedSearch}
                        onChange={e => setLimitedSearch(e.target.value)}
                        className="w-full bg-gray-900 border border-gray-600 rounded-lg pl-10 pr-4 py-2 text-sm"
                      />
                    </div>
                  )}
                  {currentKeeper.limited && (
                    <button
                      onClick={() => handleKeeperSelect(null, 'limited')}
                      className="text-xs text-red-400 hover:text-red-300 font-medium ml-auto"
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
                  <div className="space-y-2">
                    <div className="h-32 overflow-y-auto bg-gray-900 rounded border border-gray-700">
                      {limitedSearch.trim() ? (
                        limitedSearchResults.length > 0 ? (
                          limitedSearchResults.map(player => (
                            <button
                              key={player.name}
                              onClick={() => {
                                handleKeeperSelect(player.name, 'limited', 2);
                                setLimitedSearch('');
                              }}
                              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-700 border-b border-gray-700/50 last:border-0 text-left transition-colors"
                            >
                              <img
                                src={getPlayerHeadshot(player.name)}
                                onError={e => { e.target.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(player.name)}&background=1f2937&color=9ca3af&size=64`; }}
                                alt=""
                                className="w-10 h-10 rounded-full object-cover border border-yellow-600 flex-shrink-0"
                              />
                              <div className="flex-1 min-w-0">
                                <div className="font-medium text-sm truncate">{player.name}</div>
                                <div className="text-xs text-gray-400">Rank: {player.worldRank}</div>
                              </div>
                              <div className="text-yellow-400 font-bold text-xs flex-shrink-0">Select</div>
                            </button>
                          ))
                        ) : (
                          <div className="text-center py-3 text-gray-500 text-xs">No players found</div>
                        )
                      ) : (
                        <div className="flex items-center justify-center h-full text-gray-500 text-xs">
                          Type to search for players...
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Unlimited Keeper */}
              <div className="bg-blue-900/20 border border-blue-700/50 rounded-lg p-4">
                <div className="flex items-center gap-3 mb-3">
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <div className="w-7 h-7 bg-blue-600 rounded text-lg font-bold flex items-center justify-center">∞</div>
                    <span className="font-bold whitespace-nowrap">Blue Keeper</span>
                  </div>
                  {!currentKeeper.unlimited && (
                    <div className="relative flex-1">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                      <input
                        type="text"
                        placeholder="Search for Unlimited player..."
                        value={unlimitedSearch}
                        onChange={e => setUnlimitedSearch(e.target.value)}
                        className="w-full bg-gray-900 border border-gray-600 rounded-lg pl-10 pr-4 py-2 text-sm"
                      />
                    </div>
                  )}
                  {currentKeeper.unlimited && (
                    <button
                      onClick={() => handleKeeperSelect(null, 'unlimited')}
                      className="text-xs text-red-400 hover:text-red-300 font-medium ml-auto"
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
                  <div className="space-y-2">
                    <div className="h-32 overflow-y-auto bg-gray-900 rounded border border-gray-700">
                      {unlimitedSearch.trim() ? (
                        unlimitedSearchResults.length > 0 ? (
                          unlimitedSearchResults.map(player => (
                            <button
                              key={player.name}
                              onClick={() => {
                                handleKeeperSelect(player.name, 'unlimited');
                                setUnlimitedSearch('');
                              }}
                              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-700 border-b border-gray-700/50 last:border-0 text-left transition-colors"
                            >
                              <img
                                src={getPlayerHeadshot(player.name)}
                                onError={e => { e.target.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(player.name)}&background=1f2937&color=9ca3af&size=64`; }}
                                alt=""
                                className="w-10 h-10 rounded-full object-cover border border-blue-600 flex-shrink-0"
                              />
                              <div className="flex-1 min-w-0">
                                <div className="font-medium text-sm truncate">{player.name}</div>
                                <div className="text-xs text-gray-400">Rank: {player.worldRank}</div>
                              </div>
                              <div className="text-blue-400 font-bold text-xs flex-shrink-0">Select</div>
                            </button>
                          ))
                        ) : (
                          <div className="text-center py-3 text-gray-500 text-xs">No players found</div>
                        )
                      ) : (
                        <div className="flex items-center justify-center h-full text-gray-500 text-xs">
                          Type to search for players...
                        </div>
                      )}
                    </div>
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
      <div className="bg-gray-800 rounded-xl max-w-4xl w-full h-[85vh] max-h-[700px] overflow-hidden flex flex-col">
        <div className="p-4 border-b border-gray-700 flex justify-between items-center">
          <div>
            <h2 className="text-xl font-bold">Fantasy Golf Draft</h2>
            {!isDraftComplete && (
              <>
                <p className="text-sm text-gray-400 mt-1">
                  Round {currentRound} of {maxRounds} • {isLimitedRound ? '🟡 Limited' : '🔵 Unlimited'} • <span className="text-green-400 font-medium">{currentTeam.name}</span> is picking
                </p>
                <p className="text-xs text-blue-400 mt-1">💾 Draft auto-saves - you can close and resume anytime</p>
              </>
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
              onClick={() => {
                clearDraftState();
                onClose();
              }}
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

            <div className="flex-1 overflow-auto p-4 min-h-[400px]">
              <div className="grid gap-2">
                {availablePlayers.map(player => (
                  <button
                    key={player.name}
                    onClick={() => handleDraftPlayer(player.name)}
                    className={`flex items-center gap-3 rounded-lg px-4 py-3 text-left transition-colors ${
                      isLimitedRound
                        ? 'bg-yellow-900/20 hover:bg-yellow-900/30 border border-yellow-700/50'
                        : 'bg-blue-900/20 hover:bg-blue-900/30 border border-blue-700/50'
                    }`}
                  >
                    <img
                      src={getPlayerHeadshot(player.name)}
                      onError={e => { e.target.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(player.name)}&background=1f2937&color=9ca3af&size=64`; }}
                      alt=""
                      className={`w-12 h-12 rounded-full object-cover border-2 flex-shrink-0 ${
                        isLimitedRound ? 'border-yellow-600' : 'border-blue-600'
                      }`}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{player.name}</div>
                      <div className="text-xs text-gray-400">Rank: {player.worldRank}</div>
                    </div>
                    <div className={`font-bold text-sm flex-shrink-0 ${isLimitedRound ? 'text-yellow-400' : 'text-blue-400'}`}>
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

      {/* Confirmation Modal */}
      {confirmDraft && (
        <div className="absolute inset-0 bg-black/60 flex items-center justify-center p-4 z-10">
          <div className="bg-gray-800 rounded-xl p-6 max-w-md w-full border-2 border-green-600 shadow-2xl">
            <h3 className="text-xl font-bold mb-4 text-center">Confirm Draft Pick</h3>
            <div className="flex flex-col items-center gap-4 mb-6">
              <img
                src={getPlayerHeadshot(confirmDraft.playerName)}
                onError={e => { e.target.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(confirmDraft.playerName)}&background=1f2937&color=9ca3af&size=128`; }}
                alt=""
                className={`w-24 h-24 rounded-full object-cover border-4 ${
                  confirmDraft.type === 'limited' ? 'border-yellow-500' : 'border-blue-500'
                }`}
              />
              <div className="text-center">
                <div className="text-lg font-bold">{confirmDraft.playerName}</div>
                <div className={`text-sm font-medium ${confirmDraft.type === 'limited' ? 'text-yellow-400' : 'text-blue-400'}`}>
                  {confirmDraft.type === 'limited' ? 'Limited Player' : 'Unlimited Player'}
                </div>
              </div>
            </div>
            <div className="text-sm text-gray-400 text-center mb-6">
              Draft <span className="text-white font-bold">{confirmDraft.playerName}</span> for <span className="text-green-400 font-bold">{currentTeam.name}</span>?
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmDraft(null)}
                className="flex-1 px-4 py-2 bg-gray-600 hover:bg-gray-500 rounded-lg font-bold transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmDraftPlayer}
                className="flex-1 px-4 py-2 bg-green-600 hover:bg-green-500 rounded-lg font-bold transition-colors"
              >
                Confirm Draft
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
