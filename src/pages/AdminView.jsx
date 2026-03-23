import React, { useState } from 'react';
import { useDialog } from './DialogContext';
import { getSegmentByDate, normalizePlayerName } from '../utils';
import { storage } from '../api';
import { DraftModal } from './DraftModal';
import { managerAuthApi, tournamentResultsApi, sfglDataApi, playersApi, playerRankingsApi } from '../api/firebase';
import { theme, colors, fonts } from '../theme.js';
import { BONUSES_REGULAR, BONUSES_MAJOR, LIV_GOLF_ROSTER } from '../constants';


// ── Tournament processing helpers ────────────────────────────────────────────

const matchPlayerName = (a, b) => {
  const na = normalizePlayerName(a);
  const nb = normalizePlayerName(b);
  if (na === nb) return true;
  const wa = na.split(' '); const wb = nb.split(' ');
  if (wa.length === wb.length) return wa.every(w => wb.includes(w));
  return false;
};

const getRosterForTournament = (team, tournamentIndex, allTransactions) => {
  let roster = [...team.roster];
  allTransactions
    .filter(tx => tx.team === team.name && tx.tournamentIndex !== undefined && tx.tournamentIndex <= tournamentIndex && tx.status !== 'pending')
    .sort((a, b) => a.tournamentIndex - b.tournamentIndex)
    .forEach(tx => {
      if (tx.droppedPlayer) roster = roster.filter(p => p.name !== tx.droppedPlayer);
      if (tx.player && !roster.some(p => p.name === tx.player)) roster.push({ name: tx.player });
    });
  return roster;
};

/**
 * Core tournament processing. Mirrors the original processTournamentResults logic.
 * Returns { newTeams, newStats, resultsData }.
 */
const processTournamentData = (tournament, tournamentData, teams, globalPlayerStats, _unusedNames, transactions = []) => {
  const bonuses = tournament.isMajor ? BONUSES_MAJOR : BONUSES_REGULAR;

  // Build earningsMap from the tournamentData
  const earningsMap = {};
  if (tournamentData.earningsMap instanceof Map) {
    tournamentData.earningsMap.forEach((earnings, name) => { earningsMap[name] = earnings; });
  } else if (tournamentData.earningsMap && typeof tournamentData.earningsMap === 'object') {
    Object.assign(earningsMap, tournamentData.earningsMap);
  } else if (Array.isArray(tournamentData.competitors)) {
    tournamentData.competitors.forEach(p => {
      const name = p.athlete?.displayName;
      const earn = p.earnings || 0;
      if (name && earn > 0) earningsMap[name] = earn;
    });
  }

  // Update global stats
  const newStats = { ...globalPlayerStats };
  Object.entries(earningsMap).forEach(([playerName, earnings]) => {
    if (!newStats[playerName]) newStats[playerName] = { eventsPlayed: 0, cutsMade: 0, pgaTourEarnings: 0 };
    newStats[playerName] = {
      ...newStats[playerName],
      eventsPlayed: newStats[playerName].eventsPlayed + 1,
      cutsMade:     newStats[playerName].cutsMade + (earnings > 0 ? 1 : 0),
      pgaTourEarnings: newStats[playerName].pgaTourEarnings + earnings,
    };
  });

  const tournamentIndex = -1; // used only for getRosterForTournament; -1 = ignore tx filtering
  const resultsData = { teams: {}, earningsMap: { ...earningsMap }, roundLeaders: tournamentData.roundLeaders || {}, fullLineups: {} };

  const newTeams = teams.map(team => {
    if (!team.lineup || team.lineup.length === 0) return team;

    resultsData.fullLineups[team.id] = [...team.lineup];

    const starterResults = team.lineup.map(playerName => {
      let earnings = earningsMap[playerName];
      if (earnings === undefined) {
        const mk = Object.keys(earningsMap).find(k => matchPlayerName(k, playerName));
        earnings = mk !== undefined ? earningsMap[mk] : 0;
      }
      return { playerName, earnings: earnings || 0 };
    });

    const topStarters = [...starterResults].sort((a, b) => b.earnings - a.earnings).slice(0, 5);
    let totalEarnings = topStarters.reduce((s, p) => s + p.earnings, 0);
    const bonusEarnings = { round1: 0, round2: 0, round3: 0 };
    const playersWithBonuses = {};

    if (tournamentData.roundLeaders) {
      ['round1', 'round2', 'round3'].forEach(round => {
        const leaders = Array.isArray(tournamentData.roundLeaders[round])
          ? tournamentData.roundLeaders[round]
          : (tournamentData.roundLeaders[round] ? [tournamentData.roundLeaders[round]] : []);
        leaders.forEach(leaderName => {
          if (!leaderName) return;
          const actual = team.lineup.find(pn => normalizePlayerName(pn) === normalizePlayerName(leaderName));
          if (actual) {
            bonusEarnings[round] = bonuses[round];
            totalEarnings += bonuses[round];
            if (!playersWithBonuses[actual]) playersWithBonuses[actual] = { total: 0, rounds: [] };
            playersWithBonuses[actual].total  += bonuses[round];
            playersWithBonuses[actual].rounds.push({ round: round.replace('round', ''), bonus: bonuses[round] });
          }
        });
      });
    }

    resultsData.teams[team.id] = {
      totalEarnings,
      bonuses: bonusEarnings,
      players: topStarters.map(s => ({
        name: s.playerName,
        earnings: s.earnings,
        limited: team.roster.find(p => p.name === s.playerName)?.limited || false,
        bonus: playersWithBonuses[s.playerName]?.total || 0,
        roundsLed: playersWithBonuses[s.playerName]?.rounds || [],
        wasRoundLeader: (playersWithBonuses[s.playerName]?.total || 0) > 0,
      })),
    };

    const updatedRoster = team.roster.map(player => {
      if (!team.lineup.includes(player.name)) return player;
      let pe = earningsMap[player.name];
      if (pe === undefined) { const mk = Object.keys(earningsMap).find(k => matchPlayerName(k, player.name)); if (mk) pe = earningsMap[mk]; }
      return { ...player, starts: (player.starts || 0) + 1, sfglEarnings: (player.sfglEarnings || 0) + (pe || 0) };
    });

    return {
      ...team,
      roster: updatedRoster,
      earnings: (team.earnings || 0) + totalEarnings,
      segmentEarnings: (team.segmentEarnings || 0) + totalEarnings,
      lineup: [],
    };
  });

  return { newTeams, newStats, resultsData };
};

export const AdminView = ({
  isCommissioner, setIsCommissioner, setActiveTab,
  settings, setSettings,
  teams, updateTeams,
  tournaments, setTournaments,
  transactions, setTransactions,
  allPlayers, setAllPlayers, globalPlayerStats, setGlobalPlayerStats,
  headshots, setHeadshots,
  updateRankings, rankingsLastUpdated,
  STORAGE_KEYS,
}) => {
  const [selectedTourney, setSelectedTourney] = useState('');
  const [manualEntry, setManualEntry] = useState({ round1Leaders: [''], round2Leaders: [''], round3Leaders: [''], playerEarnings: '', teamLineups: {} });
  const [mgCredTeam, setMgCredTeam] = useState('');



  const pending = transactions.map((tx, i) => ({ ...tx, _idx: i })).filter(tx => tx.status === 'pending' && tx.type === 'waiver');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 40 }}>

      {/* ── 1. Tournament Results ── */}
      <div style={S.section}>
        <div style={S.title}>🏆 Tournament Results</div>
        <label style={S.lbl}>Tournament</label>
        <select value={selectedTourney} onChange={e => {
          const name = e.target.value;
          setSelectedTourney(name);
          const t = tournaments.find(t => t.name === name);
          if (t?.completed && t.results?.earningsMap) {
            const lines = Object.entries(t.results.earningsMap)
              .sort((a, b) => b[1] - a[1])
              .map(([player, amt]) => player + ', ' + amt)
              .join('\n');
            const teamLineups = {};
            if (t.results.fullLineups) {
              Object.entries(t.results.fullLineups).forEach(([teamId, lineup]) => {
                teamLineups[teamId] = [...lineup];
              });
            }
            setManualEntry(prev => ({ ...prev, playerEarnings: lines,
              round1Leaders: t.results.roundLeaders?.round1?.length ? t.results.roundLeaders.round1 : [''],
              round2Leaders: t.results.roundLeaders?.round2?.length ? t.results.roundLeaders.round2 : [''],
              round3Leaders: t.results.roundLeaders?.round3?.length ? t.results.roundLeaders.round3 : [''],
              teamLineups,
            }));
          } else {
            setManualEntry({ round1Leaders: [''], round2Leaders: [''], round3Leaders: [''], playerEarnings: '', teamLineups: {} });
          }
        }} style={S.select}>
          <option value="">Choose tournament...</option>
          {tournaments.map(t => <option key={t.name} value={t.name}>{t.completed ? '✓ ' : t.playing ? '▶ ' : ''}{t.name}</option>)}
        </select>
        {/* Fetch button — discovers results automatically by tournament name */}
        <button
          onClick={handleFetchPGAResults}
          disabled={pgaFetching || !selectedTourney}
          style={{ ...S.btn, marginBottom: 12, ...(!selectedTourney || pgaFetching ? { opacity: 0.4, cursor: 'not-allowed' } : {}) }}
        >
          {pgaFetching ? '⏳ Fetching…' : selectedTourney ? `⛳ Get ${selectedTourney} Results` : '⛳ Get Tournament Results'}
        </button>

        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <RoundLeaderSelect label="R1 Leader" round={1} leaders={manualEntry.round1Leaders} onChange={r => setManualEntry({ ...manualEntry, round1Leaders: r })} />
          <RoundLeaderSelect label="R2 Leader" round={2} leaders={manualEntry.round2Leaders} onChange={r => setManualEntry({ ...manualEntry, round2Leaders: r })} />
          <RoundLeaderSelect label="R3 Leader" round={3} leaders={manualEntry.round3Leaders} onChange={r => setManualEntry({ ...manualEntry, round3Leaders: r })} />
        </div>

          {/* Lineup overrides (only for completed tournaments being reprocessed) */}
          {tournaments.find(t => t.name === selectedTourney)?.completed && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ ...S.lbl, marginBottom: 6 }}>
                Starting Lineups
                <span style={{ ...theme.smallText, textTransform: 'none', letterSpacing: 0, marginLeft: 6 }}>— correct if roster was edited</span>
              </div>
              {teams.map(team => {
                const currentLineup = manualEntry.teamLineups[team.id] || [];
                return (
                  <div key={team.id} style={{ marginBottom: 10, background: colors.inputBg, border: `1px solid ${colors.borderSubtle}`, borderRadius: 3, padding: '8px 12px' }}>
                    <div style={{ fontFamily: fonts.sans, fontSize: 11, fontWeight: 700, color: colors.textGold, marginBottom: 6, letterSpacing: '0.5px' }}>
                      {team.name}
                      <span style={{ color: colors.textMuted, fontWeight: 400, marginLeft: 8 }}>{currentLineup.length}/5 starters</span>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px' }}>
                      {team.roster.map(p => {
                        const inLineup = currentLineup.includes(p.name);
                        return (
                          <label key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', userSelect: 'none' }}>
                            <input type="checkbox" checked={inLineup}
                              onChange={e => {
                                const updated = e.target.checked ? [...currentLineup, p.name] : currentLineup.filter(n => n !== p.name);
                                setManualEntry(prev => ({ ...prev, teamLineups: { ...prev.teamLineups, [team.id]: updated } }));
                              }}
                              style={{ accentColor: colors.textGold, width: 13, height: 13 }}
                            />
                            <span style={{ fontFamily: fonts.sans, fontSize: 11, color: inLineup ? colors.textPrimary : colors.textMuted }}>
                              {p.name}{p.limited && <span style={{ color: colors.textGoldDim, marginLeft: 3 }}>★</span>}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <label style={{ ...S.lbl, color: colors.textMuted }}>Player Earnings <span style={{ ...theme.smallText, textTransform: 'none', letterSpacing: 0 }}>— auto-filled by fetch, or enter manually</span></label>
          <textarea value={manualEntry.playerEarnings} onChange={e => setManualEntry({ ...manualEntry, playerEarnings: e.target.value })}
            placeholder={'Scottie Scheffler, 3600000\nRory McIlroy, 2160000'} rows={3}
            style={{ ...theme.input, fontFamily: fonts.mono, fontSize: 11, resize: 'vertical', marginBottom: 8, opacity: 0.75 }} />
          <div style={{ display: 'flex', gap: 8 }}>
            {!tournaments.find(t => t.name === selectedTourney)?.completed && (
              <button onClick={handleManualEntry} disabled={!selectedTourney || !manualEntry.playerEarnings.trim()}
                style={{ ...S.btn, flex: 1, ...disabledBtn(!selectedTourney || !manualEntry.playerEarnings.trim()) }}>
                Process Manual Entry
              </button>
            )}
            {tournaments.find(t => t.name === selectedTourney)?.completed && (
              <button onClick={handleReprocess} disabled={!selectedTourney || !manualEntry.playerEarnings.trim()}
                style={{ ...S.btn, flex: 1, background: 'rgba(220,150,50,0.12)', border: '1px solid rgba(220,150,50,0.4)', color: 'rgba(220,180,80,0.9)', ...disabledBtn(!selectedTourney || !manualEntry.playerEarnings.trim()) }}>
                ✏️ Reprocess Tournament
              </button>
            )}
        </div>
      </div>

      {/* ── 2. Process Waivers ── */}
      <div style={S.section}>
        {/* Tuesday night reminder */}
        {(() => {
          const now = new Date();
          const etOffset = -4;
          const etHour = (now.getUTCHours() + 24 + etOffset) % 24;
          const etDay  = new Date(now.getTime() + etOffset * 3600 * 1000).getUTCDay();
          const isReadyToProcess = etDay === 2 && etHour >= 20 && pending.length > 0;
          if (!isReadyToProcess) return null;
          return (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', marginBottom: 10, borderRadius: 3,
              background: 'rgba(220,170,60,0.1)', border: '1px solid rgba(220,170,60,0.45)',
            }}>
              <span style={{ fontSize: 14 }}>⏰</span>
              <div style={{ flex: 1, fontFamily: fonts.sans, fontSize: 11, color: 'rgba(220,190,80,0.9)', fontWeight: 600 }}>
                Past 8pm ET Tuesday — process now!
              </div>
            </div>
          );
        })()}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={S.title}>⏰ Process Waivers</div>
          {pending.length > 0 && <span style={{ ...theme.badge, ...theme.badgeWarning }}>{pending.length} pending</span>}
        </div>
        {pending.length === 0 ? (
          <div style={{ ...theme.smallText, textAlign: 'center', padding: '8px 0', color: colors.success }}>✓ No pending waiver claims</div>
        ) : !waiverRevealed ? (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
              {pending.map(w => (
                <div key={w._idx} style={{ display: 'flex', alignItems: 'center', gap: 8, background: colors.inputBg, border: `1px solid ${colors.borderSubtle}`, borderRadius: 3, padding: '6px 12px' }}>
                  <div style={{ width: 18, height: 18, borderRadius: '50%', background: 'rgba(220,170,60,0.1)', border: '1px solid rgba(220,170,60,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700, color: colors.warning, flexShrink: 0 }}>{w.priority || '?'}</div>
                  <div style={{ fontFamily: fonts.sans, fontSize: 12, fontWeight: 600, color: colors.textPrimary }}>{w.team}</div>
                  <div style={{ flex: 1 }} />
                  <span style={{ fontFamily: fonts.sans, fontSize: 10, color: colors.textMuted }}>claim pending</span>
                </div>
              ))}
            </div>
            <button onClick={() => setWaiverRevealed(true)} style={{ ...S.btnSec, fontSize: 11 }}>Reveal Claims</button>
          </>
        ) : (
          <>
            <button onClick={() => handleProcessAll(pending)} style={{ ...S.btn, marginBottom: 8 }}>⚡ Process All ({pending.length})</button>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {pending.map(w => (
                <div key={w._idx} style={{ display: 'flex', alignItems: 'center', gap: 10, background: colors.inputBg, border: `1px solid ${colors.borderSubtle}`, borderRadius: 3, padding: '8px 12px' }}>
                  <div style={{ width: 20, height: 20, borderRadius: '50%', background: 'rgba(220,170,60,0.1)', border: '1px solid rgba(220,170,60,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, color: colors.warning, flexShrink: 0 }}>{w.priority || '?'}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: fonts.sans, fontSize: 12, fontWeight: 600, color: colors.textPrimary }}>{w.team}</div>
                    <div style={{ fontSize: 11 }}>
                      <span style={{ color: colors.earningsGreen }}>+{w.player}</span>
                      {w.droppedPlayer && <span style={{ color: colors.danger }}> / -{w.droppedPlayer}</span>}
                    </div>
                  </div>
                  <button onClick={() => handleProcessSingle(w)} style={{ ...theme.btnSecondary, padding: '5px 10px', fontSize: 11, flexShrink: 0 }}>Process</button>
                </div>
              ))}
            </div>
            <button onClick={() => setWaiverRevealed(false)} style={{ ...theme.btnSecondary, marginTop: 8, fontSize: 10, padding: '4px 12px', width: 'auto', display: 'inline-block' }}>Hide Claims</button>
          </>
        )}
      </div>

      {/* ── 3. Sync Rankings & LIV Roster ── */}
      <div style={S.section}>
        <div style={S.title}>🔄 Sync Rankings & LIV Roster</div>
        <div style={{ ...theme.smallText, color: colors.textSecondary, marginBottom: 10 }}>
          Fetches the latest OWGR world rankings and syncs the current LIV Golf roster — tagging ineligible players and clearing stale flags in one step.
        </div>
        {rankingsLastUpdated && (
          <div style={{ ...theme.smallText, color: colors.textGoldDim, marginBottom: 10 }}>
            Last synced: {new Date(rankingsLastUpdated).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
          </div>
        )}
        <button
          onClick={handleSyncData}
          disabled={owgrStatus === 'fetching'}
          style={{ ...S.btn, ...(owgrStatus === 'fetching' ? { opacity: 0.5, cursor: 'not-allowed' } : {}) }}
        >
          {owgrStatus === 'fetching' ? '⏳ Syncing…' : '🔄 Sync Rankings & LIV Roster'}
        </button>
        {owgrSummary && (
          <div style={{
            marginTop: 10, padding: '8px 12px', borderRadius: 3, fontSize: 12, fontFamily: fonts.sans,
            background: owgrStatus === 'error' ? colors.dangerBg : 'rgba(80,160,100,0.1)',
            border: `1px solid ${owgrStatus === 'error' ? colors.dangerBorder : 'rgba(80,160,100,0.3)'}`,
            color: owgrStatus === 'error' ? colors.danger : colors.success,
          }}>
            {owgrSummary}
          </div>
        )}
      </div>

      {/* ── 4. Award Swing Winner ── */}
      <div style={S.section}>
        <div style={S.title}>🏆 Award Swing Winner</div>
        <label style={S.lbl}>Swing</label>
        <select value={swingAwardSeg} onChange={e => setSwingAwardSeg(e.target.value)} style={S.select}>
          <option value="">Select swing...</option>
          {SWINGS.map(s => {
            const pot = transactions.filter(tx => tx.segment === s && (tx.fee || 0) > 0).reduce((sum, tx) => sum + tx.fee, 0);
            const alreadyAwarded = transactions.some(tx => tx.type === 'swing_winner' && tx.segment === s);
            return (
              <option key={s} value={s} disabled={alreadyAwarded}>
                {s}{pot > 0 ? ' · $' + pot.toLocaleString() + ' pot' : ''}{alreadyAwarded ? ' ✓ awarded' : ''}
              </option>
            );
          })}
        </select>
        {swingAwardSeg && (() => {
          const pot = transactions.filter(tx => tx.segment === swingAwardSeg && (tx.fee || 0) > 0).reduce((sum, tx) => sum + tx.fee, 0);
          const swingTourneys = tournaments.filter(t => t.completed && getTournamentSegment(t) === swingAwardSeg && t.results?.teams);
          const byTeam = {};
          swingTourneys.forEach(t => Object.entries(t.results.teams).forEach(([id, tr]) => { byTeam[id] = (byTeam[id] || 0) + (tr.totalEarnings || 0); }));
          const topEntry = Object.entries(byTeam).sort((a, b) => b[1] - a[1])[0];
          const leader = topEntry ? teams.find(t => t.id === topEntry[0]) : null;
          return (
            <div style={{ ...theme.smallText, marginBottom: 10, padding: '8px 10px', background: colors.inputBg, borderRadius: 3, border: `1px solid ${colors.borderSubtle}` }}>
              {leader
                ? <span>🏆 Leader: <span style={{ color: colors.textGold, fontWeight: 600 }}>{leader.name}</span> · ${(topEntry[1] || 0).toLocaleString()} · <span style={{ color: colors.earningsGreen }}>Pot: ${pot.toLocaleString()}</span></span>
                : <span style={{ color: colors.textMuted }}>No completed results for this swing yet</span>
              }
            </div>
          );
        })()}
        <button onClick={handleSwingWinner} disabled={!swingAwardSeg}
          style={{ ...S.btn, ...disabledBtn(!swingAwardSeg) }}>
          🏆 Award Swing Winner
        </button>
      </div>


      {/* ── 6. LIV Golf Ineligible Players ── */}
      <div style={S.section}>
        <div style={S.title}>🚫 LIV Golf — Ineligible Players</div>
        <div style={{ ...theme.smallText, marginBottom: 10, color: colors.textSecondary }}>
          Players flagged as LIV are hidden from the add/drop modal and waiver system.
        </div>
        <input type="text" placeholder="Search players to add/remove LIV flag…"
          value={livSearch} onChange={e => setLivSearch(e.target.value)}
          style={{ ...theme.input, marginBottom: 10, fontSize: 12 }}
        />
        {(() => {
          const livPlayers = allPlayers.filter(p => p.isLiv).sort((a, b) => a.name.localeCompare(b.name));
          // Search: show non-LIV players from allPlayers, plus LIV_GOLF_ROSTER names not yet in DB
          const searchResults = livSearch.trim().length >= 2
            ? (() => {
                const q = livSearch.toLowerCase();
                const livNames = new Set(allPlayers.filter(p => p.isLiv).map(p => p.name));
                // Players in allPlayers that aren't LIV
                const fromAll = allPlayers
                  .filter(p => p.name && p.name.toLowerCase().includes(q) && !p.isLiv)
                  .map(p => ({ name: p.name, worldRank: p.worldRank }));
                // LIV_GOLF_ROSTER names not yet in allPlayers at all
                const existingNames = new Set(allPlayers.map(p => p.name));
                const fromConst = LIV_GOLF_ROSTER
                  .filter(name => name.toLowerCase().includes(q) && !existingNames.has(name) && !livNames.has(name))
                  .map(name => ({ name, worldRank: null }));
                return [...fromAll, ...fromConst].slice(0, 10);
              })()
            : [];
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {/* Search results — players to add to LIV list */}
              {searchResults.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontFamily: fonts.sans, fontSize: 10, color: colors.textMuted, letterSpacing: '0.5px', textTransform: 'uppercase', marginBottom: 4 }}>
                    Add to LIV list
                  </div>
                  {searchResults.map(p => (
                    <div key={p.name} style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '6px 10px', marginBottom: 2, borderRadius: 3,
                      background: 'rgba(80,180,120,0.06)', border: `1px solid rgba(80,180,120,0.2)`,
                    }}>
                      <span style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.textPrimary }}>
                        {p.name}
                        {p.worldRank && <span style={{ color: colors.textMuted, fontSize: 10, marginLeft: 6 }}>#{p.worldRank}</span>}
                      </span>
                      <button
                        disabled={livSaving[p.name]}
                        onClick={async () => {
                          setLivSaving(prev => ({ ...prev, [p.name]: true }));
                          try {
                            await playersApi.upsertMany([{ name: p.name, isLiv: true }]);
                            setAllPlayers(prev => {
                              const exists = prev.some(x => x.name === p.name);
                              if (exists) return prev.map(x => x.name === p.name ? { ...x, isLiv: true } : x);
                              return [...prev, { name: p.name, worldRank: p.worldRank || null, isLiv: true }];
                            });
                            dialog.showToast('Flagged ' + p.name + ' as LIV', 'success');
                            setLivSearch('');
                          } catch(err) { dialog.showToast('Error: ' + err.message, 'error'); }
                          finally { setLivSaving(prev => ({ ...prev, [p.name]: false })); }
                        }}
                        style={{ fontFamily: fonts.sans, fontSize: 10, padding: '3px 8px', background: 'rgba(220,60,60,0.15)', border: '1px solid rgba(220,60,60,0.35)', color: colors.danger, borderRadius: 2, cursor: 'pointer' }}
                      >
                        {livSaving[p.name] ? '…' : '+ Flag LIV'}
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Current LIV roster */}
              <div style={{ fontFamily: fonts.sans, fontSize: 10, color: colors.textMuted, letterSpacing: '0.5px', textTransform: 'uppercase', marginBottom: 4 }}>
                {livPlayers.length} flagged player{livPlayers.length !== 1 ? 's' : ''}
              </div>
              {livPlayers.length === 0 ? (
                <div style={{ ...theme.smallText, textAlign: 'center', padding: '8px 0', color: colors.textMuted }}>No LIV players flagged</div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {livPlayers.map(p => (
                    <div key={p.name} style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                      padding: '4px 8px', borderRadius: 3,
                      background: 'rgba(220,60,60,0.08)', border: `1px solid rgba(220,60,60,0.2)`,
                      fontSize: 11, fontFamily: fonts.sans, color: colors.textSecondary,
                    }}>
                      {p.name}
                      <button
                        disabled={livSaving[p.name]}
                        onClick={async () => {
                          setLivSaving(prev => ({ ...prev, [p.name]: true }));
                          try {
                            await playersApi.update(p.name, { isLiv: false });
                            setAllPlayers(prev => prev.map(x => x.name === p.name ? { ...x, isLiv: false } : x));
                            dialog.showToast('Removed LIV flag from ' + p.name, 'success');
                          } catch(err) { dialog.showToast('Error: ' + err.message, 'error'); }
                          finally { setLivSaving(prev => ({ ...prev, [p.name]: false })); }
                        }}
                        style={{ background: 'none', border: 'none', color: 'rgba(220,100,80,0.7)', cursor: 'pointer', fontSize: 12, padding: 0, lineHeight: 1 }}
                        title={'Remove LIV flag from ' + p.name}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })()}
      </div>

      {/* ── 7. Manager Login Credentials ── */}
      <div style={S.section}>
        <div style={S.title}>🔑 Manager Login Credentials</div>
        <label style={S.lbl}>Team</label>
        <select value={mgCredTeam} onChange={e => { setMgCredTeam(e.target.value); setMgCredName(teams.find(x => x.id === e.target.value)?.owner || ''); }} style={S.select}>
          <option value="">Select team...</option>
          {teams.map(t => <option key={t.id} value={t.id}>{t.name} — {t.owner}</option>)}
        </select>
        <input value={mgCredName} onChange={e => setMgCredName(e.target.value)} placeholder="Login name" style={S.input} />
        <input type="password" value={mgCredPass} onChange={e => setMgCredPass(e.target.value)} placeholder="Password" style={S.input} />
        <button onClick={handleSetLogin} disabled={mgCredSaving || !mgCredTeam || !mgCredName || !mgCredPass}
          style={{ ...S.btn, ...disabledBtn(mgCredSaving || !mgCredTeam || !mgCredName || !mgCredPass) }}>
          {mgCredSaving ? 'Saving...' : 'Set Login'}
        </button>
      </div>

      {/* ── 7. Draft ── */}
      <div style={S.section}>
        <div style={S.title}>🎯 Draft</div>
        <button onClick={() => setShowDraftModal(true)} style={S.btn}>Open Draft Room</button>
      </div>

      {showDraftModal && <DraftModal teams={teams} allPlayers={allPlayers} updateTeams={updateTeams} onClose={() => setShowDraftModal(false)} headshots={headshots} />}
    </div>
  );
};

