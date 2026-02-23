import React, { useState, useMemo } from 'react';
import { ChevronDown, ChevronRight, Trophy } from 'lucide-react';
import { getSortedRoster, shortName, isTournamentLocked } from '../utils/index.js';
import { theme, colors, fonts, cardLiftHandlers } from '../theme.js';

const GOLD_BRIGHT = '#f5c518';
const GOLD_DIM    = 'rgba(245,197,24,0.35)';
const BLUE_BRIGHT = 'rgba(100,180,255,0.95)';
const BLUE_DIM    = 'rgba(100,180,255,0.35)';

const playerNameColor = (p, showEarnings) => {
  if (p.unlimited) return showEarnings ? (p.earnings > 0 ? BLUE_BRIGHT : BLUE_DIM) : BLUE_BRIGHT;
  if (p.limited)   return showEarnings ? (p.earnings > 0 ? GOLD_BRIGHT : GOLD_DIM)  : GOLD_BRIGHT;
  return showEarnings
    ? (p.earnings > 0 ? colors.textPrimary : colors.textMuted)
    : colors.textSecondary;
};

// ── Player slot grid ──────────────────────────────────────────────────────────
const PlayerSlotGrid = ({ players, showEarnings }) => {
  // Use actual lineup length (up to 5 max), never pad beyond what was submitted
  const count = Math.min(Math.max(players.length, 1), 5);
  const slots = Array.from({ length: count }, (_, i) => players[i] || null);
  return (
    <div style={{ marginLeft: 28, display: 'grid', gridTemplateColumns: `repeat(${count}, 1fr)`, gap: 4 }}>
      {slots.map((p, idx) => (
        <div key={idx} style={{ fontSize: 11, minWidth: 0, overflow: 'hidden' }}>
          {p ? (
            <>
              <div style={{
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                color: playerNameColor(p, showEarnings),
              }}>
                {shortName(p.name)}
                {showEarnings && p.roundsLed?.map((rl, ri) => (
                  <span key={ri} style={{
                    marginLeft: 2, padding: '0 4px',
                    background: 'rgba(220,110,30,0.35)',
                    color: 'rgba(255,165,80,0.95)',
                    borderRadius: 2, fontSize: 9,
                  }}>R{rl.round}</span>
                ))}
              </div>
              {showEarnings ? (
                <div>
                  <span style={{ ...theme.statNum, fontSize: 11, color: (p.earnings || 0) > 0 ? colors.earningsGreen : colors.textMuted }}>
                    ${(p.earnings || 0).toLocaleString()}
                  </span>
                  {p.bonus > 0 && (
                    <span style={{ color: 'rgba(255,150,60,0.9)', marginLeft: 2 }}>
                      +{p.bonus.toLocaleString()}
                    </span>
                  )}
                </div>
              ) : (
                <div style={{ color: colors.textMuted }}>—</div>
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
const TournamentBadges = ({ tournament }) => (
  <>
    {tournament.isMajor && (
      <span style={{ ...theme.badge, ...theme.badgeGold }}>M</span>
    )}
    {tournament.isSignature && !tournament.isMajor && (
      <span style={{ ...theme.badge, ...theme.badgeNavy }}>S</span>
    )}
  </>
);

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

  // Enrich a result player with live roster flags as fallback
  const enrich = (p) => ({
    ...p,
    limited:   p.limited   ?? rosterFlagMap[p.name]?.limited   ?? false,
    unlimited: p.unlimited ?? rosterFlagMap[p.name]?.unlimited ?? false,
  });
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
                padding: '14px 20px',
                background: isExpanded ? 'rgba(40,120,80,0.1)' : 'linear-gradient(90deg, rgba(40,120,80,0.12) 0%, transparent 100%)',
                border: 'none', borderBottom: `1px solid rgba(80,180,120,0.15)`,
                cursor: 'pointer', transition: 'background 0.2s',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(40,120,80,0.1)'; }}
              onMouseLeave={e => { if (!isExpanded) e.currentTarget.style.background = 'linear-gradient(90deg, rgba(40,120,80,0.12) 0%, transparent 100%)'; }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
                <div style={{ flexShrink: 0, width: 20, display: 'flex', justifyContent: 'center' }}>
                  {tournament.isMajor
                    ? <span style={{ ...theme.badge, ...theme.badgeGold, fontSize: 9 }}>M</span>
                    : tournament.isSignature
                      ? <span style={{ ...theme.badge, ...theme.badgeNavy, fontSize: 9 }}>S</span>
                      : <span style={{ width: 6, height: 6, borderRadius: '50%', background: colors.success, display: 'inline-block', marginTop: 2 }} />
                  }
                </div>
                <h3 style={{ ...theme.h3, color: colors.success, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tournament.name}</h3>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {!isExpanded && (
                  <span style={{ ...theme.badge, background: 'rgba(80,180,120,0.15)', border: '1px solid rgba(80,180,120,0.3)', color: colors.success }}>
                    In Progress
                  </span>
                )}
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
                      padding: '10px 20px',
                      borderBottom: `1px solid ${colors.borderSubtle}`,
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                        <span style={{ ...theme.smallText, width: 20, textAlign: 'center' }}>—</span>
                        <span style={{ ...theme.h3, fontSize: 13 }}>{team.name}</span>
                        <span style={{ ...theme.smallText, fontStyle: 'italic', color: colors.textGoldDim }}>pending</span>
                      </div>
                      <PlayerSlotGrid players={sortedLineup.map(enrich)} showEarnings={false} />
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
        // Build ordered list: for each completed tournament, then inject swing summary
        // immediately after the LAST tournament of that swing (if awarded)
        const renderedSwings = new Set();
        const items = [];

        completedTournaments.forEach((tournament) => {
          items.push({ type: 'tournament', tournament });
          // After this tournament, check if a swing summary should follow
          const seg = getTournamentSegment(tournament);
          if (seg && !renderedSwings.has(seg)) {
            const summary = swingSummaries.find(s => s.seg === seg && s.lastTourney?.name === tournament.name);
            if (summary) {
              items.push({ type: 'swing', summary });
              renderedSwings.add(seg);
            }
          }
        });

        // Also append any swing summaries whose lastTourney wasn't found (edge case)
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
            const swingColors = {
              'West Coast Swing': { accent: 'rgba(220,80,80,0.8)',  bg: 'rgba(220,80,80,0.08)',  border: 'rgba(220,80,80,0.3)'  },
              'Spring Swing':     { accent: 'rgba(80,180,120,0.8)', bg: 'rgba(80,180,120,0.08)', border: 'rgba(80,180,120,0.3)' },
              'Summer Swing':     { accent: 'rgba(80,140,220,0.8)', bg: 'rgba(80,140,220,0.08)', border: 'rgba(80,140,220,0.3)' },
              'Fall Finish':      { accent: 'rgba(220,140,60,0.8)', bg: 'rgba(220,140,60,0.08)', border: 'rgba(220,140,60,0.3)' },
            };
            const sc = swingColors[summary.seg] || swingColors['Fall Finish'];
            return (
              <div key={'swing:' + summary.seg} style={{
                ...theme.cardLift,
                border: `1px solid ${sc.border}`,
                boxShadow: `0 4px 24px ${sc.bg}`,
              }} {...cardLiftHandlers()}>
                <button
                  onClick={() => toggle('swing:' + summary.seg)}
                  aria-expanded={isExpanded}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '14px 20px',
                    background: isExpanded ? sc.bg : `linear-gradient(90deg, ${sc.bg} 0%, transparent 100%)`,
                    border: 'none', borderBottom: isExpanded ? `1px solid ${sc.border}` : 'none',
                    cursor: 'pointer', transition: 'background 0.2s',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = sc.bg; }}
                  onMouseLeave={e => { if (!isExpanded) e.currentTarget.style.background = `linear-gradient(90deg, ${sc.bg} 0%, transparent 100%)`; }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
                    <Trophy style={{ width: 14, height: 14, color: sc.accent, flexShrink: 0 }} />
                    <div style={{ textAlign: 'left', minWidth: 0 }}>
                      <h3 style={{ ...theme.h3, color: sc.accent, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {summary.seg}
                      </h3>
                      <div style={{ fontFamily: fonts.sans, fontSize: 10, color: colors.textMuted, marginTop: 1 }}>
                        {summary.tourneyCount} tournaments · pot ${summary.pot.toLocaleString()}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {!isExpanded && summary.ranked[0] && (
                      <span style={{ ...theme.badge, background: sc.bg, border: `1px solid ${sc.border}`, color: sc.accent, fontSize: 10 }}>
                        🏆 {summary.ranked[0].team.name}
                      </span>
                    )}
                    {isExpanded
                      ? <ChevronDown style={{ width: 15, height: 15, color: sc.accent }} />
                      : <ChevronRight style={{ width: 15, height: 15, color: sc.accent }} />
                    }
                  </div>
                </button>

                {isExpanded && (
                  <div>
                    {summary.ranked.map((entry, rank) => (
                      <div key={entry.team.id} style={{
                        padding: '12px 20px',
                        borderBottom: `1px solid ${colors.borderSubtle}`,
                        background: rank === 0 ? `${sc.bg}` : 'transparent',
                        display: 'flex', alignItems: 'center', gap: 12,
                        transition: 'background 0.15s',
                      }}
                        onMouseEnter={e => { e.currentTarget.style.background = rank === 0 ? sc.bg : 'rgba(255,255,255,0.03)'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = rank === 0 ? sc.bg : 'transparent'; }}
                      >
                        <span style={{ fontFamily: fonts.serif, fontSize: 13, fontWeight: 700, width: 20, textAlign: 'center', color: rank === 0 ? sc.accent : colors.textMuted, flexShrink: 0 }}>
                          {rank + 1}
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ ...theme.h3, fontSize: 13 }}>{entry.team.name}</span>
                            {rank === 0 && (
                              <span style={{ fontFamily: fonts.sans, fontSize: 10, fontWeight: 700, color: sc.accent, letterSpacing: '0.5px' }}>
                                🏆 +${summary.pot.toLocaleString()}
                              </span>
                            )}
                          </div>
                          <div style={{ fontFamily: fonts.sans, fontSize: 10, color: colors.textMuted, marginTop: 2 }}>
                            {entry.team.owner}
                          </div>
                        </div>
                        <span style={{ ...theme.statNum, fontSize: 14, fontWeight: 700, color: entry.earnings > 0 ? colors.earningsGreen : colors.textMuted, flexShrink: 0 }}>
                          ${entry.earnings.toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          }

          // Regular tournament card
          const { tournament } = item;
          const isExpanded = expandedTournament === tournament.name;
          const results = tournament.results;
          const rankedTeams = teams
            .map(t => ({ ...t, result: results?.teams?.[t.id] }))
            .filter(t => t.result)
            .sort((a, b) => (b.result.totalEarnings || 0) - (a.result.totalEarnings || 0));

          return (
          <div key={tournament.name} style={theme.cardLift} {...cardLiftHandlers()}>
            <button
              onClick={() => toggle(tournament.name)}
              aria-expanded={isExpanded}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '14px 20px', background: isExpanded
                  ? 'rgba(18,46,82,0.3)'
                  : 'linear-gradient(90deg, rgba(18,46,82,0.3) 0%, transparent 100%)',
                border: 'none', borderBottom: isExpanded ? `1px solid ${colors.borderSubtle}` : 'none',
                cursor: 'pointer', transition: 'background 0.2s',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(18,46,82,0.25)'; }}
              onMouseLeave={e => { if (!isExpanded) e.currentTarget.style.background = 'linear-gradient(90deg, rgba(18,46,82,0.3) 0%, transparent 100%)'; }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
                {/* Badge column — Sig/Major or plain dot */}
                <div style={{ flexShrink: 0, width: 20, display: 'flex', justifyContent: 'center' }}>
                  {tournament.isMajor
                    ? <span style={{ ...theme.badge, ...theme.badgeGold, fontSize: 9 }}>M</span>
                    : tournament.isSignature
                      ? <span style={{ ...theme.badge, ...theme.badgeNavy, fontSize: 9 }}>S</span>
                      : <span style={{ width: 6, height: 6, borderRadius: '50%', background: colors.textMuted, display: 'inline-block', marginTop: 2 }} />
                  }
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
                  const players = getSortedRoster(tr.players || []);
                  return (
                    <div key={team.id}
                      style={{
                        padding: '10px 20px',
                        borderBottom: `1px solid ${colors.borderSubtle}`,
                        background: rank === 0 ? 'rgba(180,160,100,0.04)' : 'transparent',
                        transition: 'background 0.15s',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = rank === 0 ? 'rgba(180,160,100,0.07)' : 'rgba(255,255,255,0.04)'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = rank === 0 ? 'rgba(180,160,100,0.04)' : 'transparent'; }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                        <span style={{
                          fontSize: 11, fontWeight: 700, width: 20, textAlign: 'center',
                          fontFamily: fonts.serif,
                          color: rank === 0 ? colors.textGold : colors.textMuted,
                        }}>
                          {rank + 1}
                        </span>
                        <span style={{ ...theme.h3, fontSize: 13 }}>{team.name}</span>
                        <span style={{
                          ...theme.statNum, fontSize: 13, fontWeight: 600,
                          color: (tr.totalEarnings || 0) > 0 ? colors.earningsGreen : colors.textMuted,
                          marginLeft: 4,
                        }}>
                          ${(tr.totalEarnings || 0).toLocaleString()}
                        </span>
                      </div>
                      <PlayerSlotGrid players={players.map(enrich)} showEarnings />
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
