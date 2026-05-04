import React, { useState, useMemo } from 'react';
import { ChevronDown, ChevronRight, Trophy } from 'lucide-react';
import { getSortedRoster, shortName, isTournamentLocked } from '../utils/index.js';
import { theme, colors, fonts, cardLiftHandlers, SWING_COLORS } from '../theme.js';
import { TournamentBadges } from './TournamentBadges';

const GOLD_BRIGHT = '#f5c518';
const GOLD_DIM    = 'rgba(245,197,24,0.35)';
const BLUE_BRIGHT = 'rgba(100,180,255,0.95)';
const BLUE_DIM    = 'rgba(100,180,255,0.35)';

const swingColors = (seg) => {
  const accent = SWING_COLORS[seg] || 'rgba(120,180,255,0.85)';
  return {
    accent,
    bg: accent.replace('0.85)', '0.07)'),
    border: accent.replace('0.85)', '0.3)'),
  };
};

const playerNameColor = (p, showEarnings) => {
  if (p.unlimited) return showEarnings ? (p.earnings > 0 ? BLUE_BRIGHT : BLUE_DIM) : BLUE_BRIGHT;
  if (p.limited)   return showEarnings ? (p.earnings > 0 ? GOLD_BRIGHT : GOLD_DIM)  : GOLD_BRIGHT;
  return showEarnings
    ? (p.earnings > 0 ? colors.textPrimary : colors.textMuted)
    : colors.textSecondary;
};

// ── Player slot grid ──────────────────────────────────────────────────────────
const PlayerSlotGrid = ({ players, showEarnings }) => {
  // Always 5 columns — pad with nulls for empty slots
  const slots = Array.from({ length: 5 }, (_, i) => players[i] || null);
  return (
    <div style={{ marginLeft: 24, display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 3 }}>
      {slots.map((p, idx) => (
        <div key={idx} style={{ fontSize: 10, minWidth: 0, overflow: 'hidden' }}>
          {p ? (
            <>
              {/* Line 1: name + mulligan */}
              <div style={{
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                color: playerNameColor(p, showEarnings),
              }}>
                {shortName(p.name)}
                {p.mulliganIn && (
                  <span title={`Mulligan · replaced ${p.replacedPlayer || '?'}`} style={{
                    marginLeft: 3, fontSize: 11, lineHeight: 1, verticalAlign: 'middle',
                    display: 'inline-block',
                    filter: 'drop-shadow(0 0 2px rgba(255,80,80,0.6))',
                  }}>🚨</span>
                )}
              </div>
              {/* Line 2: earnings (base + bonus combined) */}
              {showEarnings ? (
                <div style={{ whiteSpace: 'nowrap' }}>
                  <span style={{ ...theme.statNum, fontSize: 10, color: (p.earnings || 0) > 0 ? colors.earningsGreen : colors.textMuted }}>
                    ${((p.earnings || 0) + (p.bonus || 0)).toLocaleString()}
                  </span>
                </div>
              ) : (
                <div style={{ color: colors.textMuted }}>—</div>
              )}
              {/* Line 3: round leader badges (only if any) */}
              {showEarnings && p.roundsLed?.length > 0 && (
                <div style={{ display: 'flex', gap: 2, marginTop: 1 }}>
                  {p.roundsLed.map((rl, ri) => (
                    <span key={ri} style={{
                      padding: '1px 3px',
                      background: 'rgba(220,110,30,0.35)',
                      color: 'rgba(255,165,80,0.95)',
                      borderRadius: 2, fontSize: 8, lineHeight: 1.2,
                    }}>R{rl.round}</span>
                  ))}
                </div>
              )}
            </>
          ) : (
            <span style={{ color: 'rgba(255,255,255,0.1)' }}>—</span>
          )}
        </div>
      ))}
    </div>
  );
};

// ── Tournament type badges ────────────────────────────────────────────────────
// Now imported from ./TournamentBadges (Wave 1 cleanup — was inlined here AND
// in TournamentsView, plus 3 more inline copies inside this file's render).

// ── Empty state ───────────────────────────────────────────────────────────────
const EmptyState = () => (
  <div style={{ ...theme.card, ...theme.emptyState, padding: '52px 20px' }}>
    <div style={{ fontSize: 40, margin: '0 auto 16px', textAlign: 'center' }}>🏌️</div>
    <h3 style={{ ...theme.h2, marginBottom: 8 }}>No Completed Tournaments Yet</h3>
    <p style={theme.bodyText}>Results will appear here after processing</p>
  </div>
);

export const ResultsView = ({ teams, tournaments, transactions = [] }) => {
  // Build name → {limited, unlimited} from live roster so historical results
  // (which may predate the unlimited field being stored) still render correctly
  const rosterFlagMap = useMemo(() => {
    const map = {};
    teams.forEach(team => {
      (team.roster || []).forEach(p => {
        map[p.name] = { limited: p.limited || false, unlimited: p.unlimited || false };
      });
    });
    return map;
  }, [teams]);

  // Build mulligan lookup: { tournamentIndex → { playerIn → droppedPlayer, droppedPlayer → playerIn } }
  // We track both directions because tournament results may contain EITHER the original
  // player (if the swap wasn't applied to results) or the replacement player (if it was).
  const mulliganMap = useMemo(() => {
    const map = {};
    transactions.forEach(tx => {
      if (tx.type !== 'mulligan' || !tx.player) return;
      const idx = tx.tournamentIndex ?? -1;
      if (!map[idx]) map[idx] = { ins: {}, outs: {} };
      // tx.player = player IN, tx.droppedPlayer = player OUT
      map[idx].ins[tx.player] = tx.droppedPlayer || '?';
      if (tx.droppedPlayer) map[idx].outs[tx.droppedPlayer] = tx.player;
    });
    return map;
  }, [transactions]);

  // Enrich a result player with live roster flags + mulligan detection.
  // When the original player (mulliganed OUT) still appears in results data,
  // swap the display name to the replacement player (mulliganed IN).
  const enrich = (p, tournamentIndex) => {
    const tMap = mulliganMap[tournamentIndex];
    // Player was mulliganed IN (replacement player appears in results)
    const isMullIn = p.mulliganIn || !!tMap?.ins[p.name];
    // Player was mulliganed OUT (original player still appears in results — swap wasn't applied)
    const isMullOut = !!tMap?.outs[p.name];

    // If the original player is still in results, swap to show the replacement
    const displayName = isMullOut ? tMap.outs[p.name] : p.name;
    const replacedPlayer = isMullIn
      ? (p.replacedPlayer || tMap?.ins[p.name] || null)
      : isMullOut
        ? p.name  // the original player who was replaced
        : null;

    return {
      ...p,
      name: displayName,
      limited:   rosterFlagMap[displayName]?.limited   ?? p.limited   ?? false,
      unlimited: rosterFlagMap[displayName]?.unlimited ?? p.unlimited ?? false,
      mulliganIn: isMullIn || isMullOut,
      replacedPlayer,
    };
  };
  const [expandedTournament, setExpandedTournament] = useState(null);

  const completedTournaments = useMemo(() =>
    [...tournaments.filter(t => t.completed)].reverse(),
    [tournaments],
  );

  // ── Swing segment helper (mirrors AdminView logic) ────────────────────────
  const getTournamentSegment = (t) => {
    if (t.segment) return t.segment;
    if (t.dates) {
      const m = t.dates.match(/^([A-Za-z]+)/);
      if (m) {
        const months = {Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12};
        const mo = months[m[1]];
        if (mo) {
          if (mo >= 1 && mo <= 3) return 'West Coast Swing';
          if (mo >= 4 && mo <= 6) return 'Spring Swing';
          if (mo >= 7 && mo <= 9) return 'Summer Swing';
          return 'Fall Finish';
        }
      }
    }
    return null;
  };

  // Build swing summary cards from swing_winner transactions
  const swingSummaries = useMemo(() => {
    const awarded = transactions.filter(tx => tx.type === 'swing_winner');
    return awarded.map(tx => {
      const seg = tx.segment;
      // Sum earnings per team across all completed tournaments in this swing
      const swingTourneys = tournaments.filter(t => t.completed && getTournamentSegment(t) === seg && t.results?.teams);
      const byTeam = {};
      swingTourneys.forEach(t => {
        Object.entries(t.results.teams).forEach(([id, tr]) => {
          byTeam[id] = (byTeam[id] || 0) + (tr.totalEarnings || 0);
        });
      });
      // Find the last tournament in this swing (for insertion ordering)
      const lastTourney = swingTourneys[swingTourneys.length - 1];
      const ranked = Object.entries(byTeam)
        .map(([id, earnings]) => ({ team: teams.find(t => t.id === id), earnings }))
        .filter(e => e.team)
        .sort((a, b) => b.earnings - a.earnings);
      return { seg, tx, ranked, lastTourney, pot: tx.amount || 0, tourneyCount: swingTourneys.length };
    });
  }, [transactions, tournaments, teams]);

  const inProgressTournaments = useMemo(() =>
    tournaments.filter(t => t.playing && !t.completed && isTournamentLocked(t)),
    [tournaments],
  );

  const toggle = (name) => setExpandedTournament(prev => prev === name ? null : name);

  if (completedTournaments.length === 0 && inProgressTournaments.length === 0) {
    return <EmptyState />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* ── In-progress tournaments ── */}
      {inProgressTournaments.map((tournament) => {
        const isExpanded = expandedTournament === tournament.name;
        const teamsWithLineups = teams.filter(t => t.lineup?.length > 0).sort((a, b) => a.name.localeCompare(b.name));
        const tIdx = tournaments.indexOf(tournament);

        return (
          <div key={tournament.name} style={{
            ...theme.card,
            border: '1px solid rgba(80,180,120,0.3)',
            boxShadow: '0 4px 24px rgba(40,120,80,0.1)',
          }}>
            <button
              onClick={() => toggle(tournament.name)}
              aria-expanded={isExpanded}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '10px 14px',
                background: isExpanded ? 'rgba(40,120,80,0.1)' : 'linear-gradient(90deg, rgba(40,120,80,0.12) 0%, transparent 100%)',
                border: 'none', borderBottom: `1px solid rgba(80,180,120,0.15)`,
                cursor: 'pointer', transition: 'background 0.2s',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(40,120,80,0.1)'; }}
              onMouseLeave={e => { if (!isExpanded) e.currentTarget.style.background = 'linear-gradient(90deg, rgba(40,120,80,0.12) 0%, transparent 100%)'; }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
                <div style={{ flexShrink: 0, width: 20, display: 'flex', justifyContent: 'center' }}>
                  <TournamentBadges tournament={tournament} />
                </div>
                <h3 style={{ ...theme.h3, color: colors.success, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tournament.name}</h3>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ ...theme.badge, background: 'rgba(80,180,120,0.15)', border: '1px solid rgba(80,180,120,0.3)', color: colors.success }}>
                  In Progress
                </span>
                {isExpanded
                  ? <ChevronDown style={{ width: 15, height: 15, color: colors.success }} />
                  : <ChevronRight style={{ width: 15, height: 15, color: colors.success }} />
                }
              </div>
            </button>

            {isExpanded && (
              <div>
                {teamsWithLineups.length === 0 ? (
                  <div style={theme.emptyState}>No teams have submitted lineups yet</div>
                ) : teamsWithLineups.map((team, i) => {
                  const lineupPlayers = team.lineup.map(name => team.roster.find(p => p.name === name) || { name, limited: false, unlimited: false });
                  const sortedLineup = getSortedRoster(lineupPlayers);
                  return (
                    <div key={team.id} style={{
                      padding: '6px 14px',
                      borderBottom: `1px solid ${colors.borderSubtle}`,
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, width: 18, textAlign: 'center', fontFamily: fonts.serif, color: colors.textMuted }}>—</span>
                        <span style={{ ...theme.h3, fontSize: 12 }}>{team.name}</span>
                        <span style={{ fontFamily: fonts.sans, fontSize: 10, fontStyle: 'italic', color: colors.textGoldDim }}>pending</span>
                      </div>
                      <PlayerSlotGrid players={sortedLineup.map(p => enrich(p, tIdx))} showEarnings={false} />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {/* ── Completed tournaments + swing summaries (interleaved) ── */}
      {(() => {
        // completedTournaments is reverse-chrono (newest first).
        // Swing card goes at the TOP of its swing group — before the first
        // tournament of that swing we encounter while iterating.
        const renderedSwings = new Set();
        const items = [];
        completedTournaments.forEach((tournament) => {
          const seg = getTournamentSegment(tournament);
          // If this is the first time we see this swing, prepend the swing card
          if (seg && !renderedSwings.has(seg)) {
            const summary = swingSummaries.find(s => s.seg === seg);
            if (summary) {
              items.push({ type: 'swing', summary });
              renderedSwings.add(seg);
            }
          }
          items.push({ type: 'tournament', tournament });
        });
        // Fallback: any unplaced swing summaries go at the end
        swingSummaries.forEach(s => {
          if (!renderedSwings.has(s.seg)) {
            items.push({ type: 'swing', summary: s });
            renderedSwings.add(s.seg);
          }
        });

        return items.map(item => {
          if (item.type === 'swing') {
            const { summary } = item;
            const isExpanded = expandedTournament === ('swing:' + summary.seg);
            const sc = swingColors(summary.seg);
            return (
              <div key={'swing:' + summary.seg} style={{
                ...theme.cardLift,
                border: `1px solid ${sc.border}`,
              }} {...cardLiftHandlers({ disabled: isExpanded })}>
                {/* Header — same padding/height as tournament cards */}
                <button
                  onClick={() => toggle('swing:' + summary.seg)}
                  aria-expanded={isExpanded}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '10px 14px',
                    background: isExpanded ? sc.bg : `linear-gradient(90deg, ${sc.bg} 0%, transparent 100%)`,
                    border: 'none', borderBottom: isExpanded ? `1px solid ${sc.border}` : 'none',
                    cursor: 'pointer', transition: 'background 0.2s',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = sc.bg; }}
                  onMouseLeave={e => { if (!isExpanded) e.currentTarget.style.background = `linear-gradient(90deg, ${sc.bg} 0%, transparent 100%)`; }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
                    {/* Same badge-column width as tournament cards */}
                    <div style={{ flexShrink: 0, width: 20, display: 'flex', justifyContent: 'center' }}>
                      <Trophy style={{ width: 11, height: 11, color: sc.accent }} />
                    </div>
                    <div style={{ textAlign: 'left', minWidth: 0 }}>
                      <h3 style={{ ...theme.h3, color: sc.accent, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {summary.seg}
                      </h3>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {!isExpanded && summary.ranked[0] && (
                      <span style={{ ...theme.badge, background: sc.bg, border: `1px solid ${sc.border}`, color: sc.accent }}>
                        🏆 {summary.ranked[0].team.name}
                      </span>
                    )}
                    {isExpanded
                      ? <ChevronDown style={{ width: 15, height: 15, color: sc.accent }} />
                      : <ChevronRight style={{ width: 15, height: 15, color: sc.accent }} />
                    }
                  </div>
                </button>

                {/* Expanded rows — identical layout to tournament result rows */}
                {isExpanded && (
                  <div>
                    {summary.ranked.map((entry, rank) => (
                      <div key={entry.team.id}
                        style={{
                          padding: '6px 14px',
                          borderBottom: `1px solid ${colors.borderSubtle}`,
                          background: rank === 0 ? sc.bg : 'transparent',
                          transition: 'background 0.15s',
                        }}
                        onMouseEnter={e => { e.currentTarget.style.background = rank === 0 ? sc.bg : 'rgba(255,255,255,0.04)'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = rank === 0 ? sc.bg : 'transparent'; }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                          <span style={{
                            fontSize: 11, fontWeight: 700, width: 18, textAlign: 'center',
                            fontFamily: fonts.serif,
                            color: rank === 0 ? sc.accent : colors.textMuted,
                          }}>
                            {rank + 1}
                          </span>
                          <span style={{ ...theme.h3, fontSize: 12, color: rank === 0 ? colors.textPrimary : colors.textSecondary }}>{entry.team.name}</span>
                          <span style={{
                            ...theme.statNum,
                            fontSize: rank === 0 ? 13 : 11,
                            fontWeight: rank === 0 ? 700 : 400,
                            color: rank === 0 ? colors.earningsGreen : 'rgba(80,180,120,0.5)',
                            marginLeft: 2,
                          }}>
                            ${entry.earnings.toLocaleString()}
                          </span>
                          {rank === 0 && (
                            <span style={{ fontFamily: fonts.sans, fontSize: 10, fontWeight: 700, color: sc.accent, marginLeft: 2 }}>
                              +${summary.pot.toLocaleString()} pot
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          }

          // Regular tournament card
          const { tournament } = item;
          const tIdx = tournaments.indexOf(tournament);
          const isExpanded = expandedTournament === tournament.name;
          const results = tournament.results;
          const rankedTeams = teams
            .map(t => ({ ...t, result: results?.teams?.[t.id] }))
            .filter(t => t.result)
            .sort((a, b) => (b.result.totalEarnings || 0) - (a.result.totalEarnings || 0));

          return (
          <div key={tournament.name} style={theme.cardLift} {...cardLiftHandlers({ disabled: isExpanded })}>
            <button
              onClick={() => toggle(tournament.name)}
              aria-expanded={isExpanded}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '10px 14px', background: isExpanded
                  ? 'rgba(18,46,82,0.3)'
                  : 'linear-gradient(90deg, rgba(18,46,82,0.3) 0%, transparent 100%)',
                border: 'none', borderBottom: isExpanded ? `1px solid ${colors.borderSubtle}` : 'none',
                cursor: 'pointer', transition: 'background 0.2s',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(18,46,82,0.25)'; }}
              onMouseLeave={e => { if (!isExpanded) e.currentTarget.style.background = 'linear-gradient(90deg, rgba(18,46,82,0.3) 0%, transparent 100%)'; }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
                {/* Badge column — Sig/Major or empty */}
                <div style={{ flexShrink: 0, width: 20, display: 'flex', justifyContent: 'center' }}>
                  <TournamentBadges tournament={tournament} />
                </div>
                <div style={{ textAlign: 'left', minWidth: 0 }}>
                  <h3 style={{ ...theme.h3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tournament.name}</h3>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center' }}>
                {isExpanded
                  ? <ChevronDown style={{ width: 15, height: 15, color: colors.textSecondary }} />
                  : <ChevronRight style={{ width: 15, height: 15, color: colors.textSecondary }} />
                }
              </div>
            </button>

            {isExpanded && results && (
              <div>
                {rankedTeams.map((team, rank) => {
                  const tr = team.result;
                  const players = (tr.players || [])
                    .map(p => enrich(p, tIdx))
                    .sort((a, b) => (b.earnings || 0) - (a.earnings || 0));
                  return (
                    <div key={team.id}
                      style={{
                        padding: '6px 14px',
                        borderBottom: `1px solid ${colors.borderSubtle}`,
                        background: rank === 0 ? 'rgba(180,160,100,0.04)' : 'transparent',
                        transition: 'background 0.15s',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = rank === 0 ? 'rgba(180,160,100,0.07)' : 'rgba(255,255,255,0.04)'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = rank === 0 ? 'rgba(180,160,100,0.04)' : 'transparent'; }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                        <span style={{
                          fontSize: 11, fontWeight: 700, width: 18, textAlign: 'center',
                          fontFamily: fonts.serif,
                          color: rank === 0 ? colors.textGold : colors.textMuted,
                        }}>
                          {rank + 1}
                        </span>
                        <span style={{ ...theme.h3, fontSize: 12 }}>{team.name}</span>
                        <span style={{
                          ...theme.statNum, fontSize: 12, fontWeight: 600,
                          color: (tr.totalEarnings || 0) > 0 ? colors.earningsGreen : colors.textMuted,
                          marginLeft: 2,
                        }}>
                          ${(tr.totalEarnings || 0).toLocaleString()}
                        </span>
                      </div>
                      <PlayerSlotGrid players={players} showEarnings />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
        }); // end items.map
      })()}

    </div>
  );
};
