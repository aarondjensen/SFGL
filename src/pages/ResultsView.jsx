import React, { useState, useMemo } from 'react';
import { ChevronDown, ChevronRight, Trophy } from 'lucide-react';
import { getSortedRoster, shortName, isTournamentLocked, getSegmentForTournament } from '../utils/index.js';
import { theme, colors, fonts, fontSize, cardLiftHandlers, SWING_COLORS, getSwingColor, getSwingColorAt } from '../theme.js';
import { TournamentBadges } from './TournamentBadges';

const GOLD_BRIGHT = '#f5c518';
const GOLD_DIM    = 'rgba(245,197,24,0.35)';
const BLUE_BRIGHT = 'rgba(100,180,255,0.95)';
const BLUE_DIM    = 'rgba(100,180,255,0.35)';

// Wave 8: thin wrapper around theme's getSwingColorAt that returns the
// {accent, bg, border} triplet used by swing cards on the Results page.
const swingColors = (seg) => ({
  accent: getSwingColor(seg),
  bg:     getSwingColorAt(seg, 0.07),
  border: getSwingColorAt(seg, 0.3),
});

const playerNameColor = (p, showEarnings) => {
  if (p.unlimited) return showEarnings ? (p.earnings > 0 ? BLUE_BRIGHT : BLUE_DIM) : BLUE_BRIGHT;
  if (p.limited)   return showEarnings ? (p.earnings > 0 ? GOLD_BRIGHT : GOLD_DIM)  : GOLD_BRIGHT;
  return showEarnings
    ? (p.earnings > 0 ? colors.textPrimary : colors.textMuted)
    : colors.textSecondary;
};

// Row-density consistency: all clickable card *headers* use the list-tier
// vertical padding (8px) so they match Tournaments / Transactions / Rosters
// list rows. The expanded content panels below each header are NOT row-tier
// (they contain multi-line player grids) — those keep their tighter 6px
// padding because their height is content-driven, not row-driven.
const HEADER_BUTTON_PADDING = '8px 14px';

// ── Player slot grid ──────────────────────────────────────────────────────────
const PlayerSlotGrid = ({ players, showEarnings }) => {
  const slots = Array.from({ length: 5 }, (_, i) => players[i] || null);
  return (
    <div style={{ marginLeft: 24, display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 3 }}>
      {slots.map((p, idx) => (
        <div key={idx} style={{ fontSize: fontSize.sm, minWidth: 0, overflow: 'hidden' }}>
          {p ? (
            <>
              <div style={{
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                color: playerNameColor(p, showEarnings),
              }}>
                {shortName(p.name)}
                {p.mulliganIn && (
                  <span title={`Mulligan · replaced ${p.replacedPlayer || '?'}`} style={{
                    marginLeft: 3, fontSize: fontSize.base, lineHeight: 1, verticalAlign: 'middle',
                    display: 'inline-block',
                    filter: 'drop-shadow(0 0 2px rgba(255,80,80,0.6))',
                  }}>🚨</span>
                )}
              </div>
              {showEarnings ? (
                <div style={{ whiteSpace: 'nowrap' }}>
                  <span style={{ ...theme.statNum, fontSize: fontSize.sm, color: (p.earnings || 0) > 0 ? colors.earningsGreen : colors.textMuted }}>
                    ${((p.earnings || 0) + (p.bonus || 0)).toLocaleString()}
                  </span>
                </div>
              ) : (
                <div style={{ color: colors.textMuted }}>—</div>
              )}
              {showEarnings && p.roundsLed?.length > 0 && (
                <div style={{ display: 'flex', gap: 2, marginTop: 1 }}>
                  {p.roundsLed.map((rl, ri) => (
                    <span key={ri} style={{
                      padding: '1px 3px',
                      background: 'rgba(220,110,30,0.35)',
                      color: 'rgba(255,165,80,0.95)',
                      borderRadius: 2, fontSize: fontSize.xs, lineHeight: 1.2,
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

// ── Empty state ───────────────────────────────────────────────────────────────
const EmptyState = () => (
  <div style={{ ...theme.card, ...theme.emptyState, padding: '52px 20px' }}>
    <div style={{ fontSize: fontSize.xxl, margin: '0 auto 16px', textAlign: 'center' }}>🏌️</div>
    <h3 style={{ ...theme.h2, marginBottom: 8 }}>No Completed Tournaments Yet</h3>
    <p style={theme.bodyText}>Results will appear here after processing</p>
  </div>
);

export const ResultsView = ({ teams, tournaments, transactions = [] }) => {
  const rosterFlagMap = useMemo(() => {
    const map = {};
    teams.forEach(team => {
      (team.roster || []).forEach(p => {
        map[p.name] = { limited: p.limited || false, unlimited: p.unlimited || false };
      });
    });
    return map;
  }, [teams]);

  const mulliganMap = useMemo(() => {
    const map = {};
    transactions.forEach(tx => {
      if (tx.type !== 'mulligan' || !tx.player) return;
      const idx = tx.tournamentIndex ?? -1;
      if (!map[idx]) map[idx] = { ins: {}, outs: {} };
      map[idx].ins[tx.player] = tx.droppedPlayer || '?';
      if (tx.droppedPlayer) map[idx].outs[tx.droppedPlayer] = tx.player;
    });
    return map;
  }, [transactions]);

  const enrich = (p, tournamentIndex) => {
    const tMap = mulliganMap[tournamentIndex];
    const isMullIn = p.mulliganIn || !!tMap?.ins[p.name];
    const isMullOut = !!tMap?.outs[p.name];

    const displayName = isMullOut ? tMap.outs[p.name] : p.name;
    const replacedPlayer = isMullIn
      ? (p.replacedPlayer || tMap?.ins[p.name] || null)
      : isMullOut
        ? p.name
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

  const swingSummaries = useMemo(() => {
    const awarded = transactions.filter(tx => tx.type === 'swing_winner');
    return awarded.map(tx => {
      const seg = tx.segment;
      const swingTourneys = tournaments.filter(t => t.completed && getSegmentForTournament(t) === seg && t.results?.teams);
      const byTeam = {};
      swingTourneys.forEach(t => {
        Object.entries(t.results.teams).forEach(([id, tr]) => {
          byTeam[id] = (byTeam[id] || 0) + (tr.totalEarnings || 0);
        });
      });
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>

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
                // List-tier row height for header consistency across views
                padding: HEADER_BUTTON_PADDING,
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
                <span style={{ ...theme.badge, ...theme.badgeInProgress }}>
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
                      // Content panel — height driven by player grid below, not row-tier
                      padding: '6px 14px',
                      borderBottom: `1px solid ${colors.borderSubtle}`,
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                        <span style={{ fontSize: fontSize.base, fontWeight: 700, width: 18, textAlign: 'center', fontFamily: fonts.serif, color: colors.textMuted }}>—</span>
                        <span style={{ ...theme.bodyText, color: colors.textPrimary }}>{team.name}</span>
                        <span style={{ fontFamily: fonts.sans, fontSize: fontSize.sm, fontStyle: 'italic', color: colors.textGoldDim }}>pending</span>
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
        const renderedSwings = new Set();
        const items = [];
        completedTournaments.forEach((tournament) => {
          const seg = getSegmentForTournament(tournament);
          if (seg && !renderedSwings.has(seg)) {
            const summary = swingSummaries.find(s => s.seg === seg);
            if (summary) {
              items.push({ type: 'swing', summary });
              renderedSwings.add(seg);
            }
          }
          items.push({ type: 'tournament', tournament });
        });
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
                <button
                  onClick={() => toggle('swing:' + summary.seg)}
                  aria-expanded={isExpanded}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: HEADER_BUTTON_PADDING,
                    background: isExpanded ? sc.bg : `linear-gradient(90deg, ${sc.bg} 0%, transparent 100%)`,
                    border: 'none', borderBottom: isExpanded ? `1px solid ${sc.border}` : 'none',
                    cursor: 'pointer', transition: 'background 0.2s',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = sc.bg; }}
                  onMouseLeave={e => { if (!isExpanded) e.currentTarget.style.background = `linear-gradient(90deg, ${sc.bg} 0%, transparent 100%)`; }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
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

                {isExpanded && (
                  <div>
                    {summary.ranked.map((entry, rank) => (
                      <div key={entry.team.id}
                        style={{
                          // Content panel — single-line content, list-tier height
                          padding: HEADER_BUTTON_PADDING,
                          borderBottom: `1px solid ${colors.borderSubtle}`,
                          background: rank === 0 ? sc.bg : 'transparent',
                          transition: 'background 0.15s',
                        }}
                        onMouseEnter={e => { e.currentTarget.style.background = rank === 0 ? sc.bg : 'rgba(255,255,255,0.04)'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = rank === 0 ? sc.bg : 'transparent'; }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{
                            fontSize: fontSize.base, fontWeight: 700, width: 18, textAlign: 'center',
                            fontFamily: fonts.serif,
                            color: rank === 0 ? sc.accent : colors.textMuted,
                          }}>
                            {rank + 1}
                          </span>
                          <span style={{ ...theme.bodyText, color: rank === 0 ? colors.textPrimary : colors.textSecondary }}>{entry.team.name}</span>
                          <span style={{
                            ...theme.statNum,
                            fontSize: rank === 0 ? fontSize.md : fontSize.base,
                            fontWeight: rank === 0 ? 700 : 400,
                            color: rank === 0 ? colors.earningsGreen : 'rgba(80,180,120,0.5)',
                            marginLeft: 2,
                          }}>
                            ${entry.earnings.toLocaleString()}
                          </span>
                          {rank === 0 && (
                            <span style={{ fontFamily: fonts.sans, fontSize: fontSize.sm, fontWeight: 700, color: sc.accent, marginLeft: 2 }}>
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
                padding: HEADER_BUTTON_PADDING,
                background: isExpanded
                  ? 'rgba(18,46,82,0.3)'
                  : 'linear-gradient(90deg, rgba(18,46,82,0.3) 0%, transparent 100%)',
                border: 'none', borderBottom: isExpanded ? `1px solid ${colors.borderSubtle}` : 'none',
                cursor: 'pointer', transition: 'background 0.2s',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(18,46,82,0.25)'; }}
              onMouseLeave={e => { if (!isExpanded) e.currentTarget.style.background = 'linear-gradient(90deg, rgba(18,46,82,0.3) 0%, transparent 100%)'; }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
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
                        // Content panel — height driven by player grid, not row-tier
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
                          fontSize: fontSize.base, fontWeight: 700, width: 18, textAlign: 'center',
                          fontFamily: fonts.serif,
                          color: rank === 0 ? colors.textGold : colors.textMuted,
                        }}>
                          {rank + 1}
                        </span>
                        <span style={{ ...theme.bodyText, color: colors.textPrimary }}>{team.name}</span>
                        <span style={{
                          ...theme.statNum, fontSize: fontSize.base, fontWeight: 600,
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
        });
      })()}

    </div>
  );
};
