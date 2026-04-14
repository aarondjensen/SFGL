import React, { useState, useMemo } from 'react';
import { colors, fonts, theme, SWINGS } from '../theme.js';
import { getSegmentByDate } from '../utils';

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmt$ = (n) => {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)    return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toLocaleString()}`;
};

const fmtFull$ = (n) => `$${(n || 0).toLocaleString()}`;

const getSegmentForTournament = (t) => {
  if (t.segment) return t.segment;
  return getSegmentByDate(new Date());
};

const ALL_SEGMENTS = SWINGS;

const SEGMENT_COLORS = {
  'West Coast Swing': 'rgba(100,180,255,0.85)',
  'Spring Swing':     'rgba(80,200,120,0.85)',
  'Summer Swing':     'rgba(245,197,24,0.85)',
  'Fall Finish':      'rgba(220,120,60,0.85)',
};

// ── Sub-components ────────────────────────────────────────────────────────────

const StatCard = ({ label, value, sub, accent, wide }) => (
  <div style={{
    background: 'rgba(255,255,255,0.03)',
    border: `1px solid ${accent ? accent.replace('0.85', '0.25') : 'rgba(255,255,255,0.08)'}`,
    borderRadius: 4,
    padding: '14px 16px',
    display: 'flex', flexDirection: 'column', gap: 4,
    gridColumn: wide ? 'span 2' : undefined,
  }}>
    <div style={{ fontFamily: fonts.sans, fontSize: 10, letterSpacing: '1px', textTransform: 'uppercase', color: colors.textMuted }}>
      {label}
    </div>
    <div style={{ fontFamily: fonts.serif, fontSize: 22, fontWeight: 700, color: accent || colors.textPrimary, lineHeight: 1 }}>
      {value}
    </div>
    {sub && <div style={{ fontFamily: fonts.sans, fontSize: 11, color: colors.textMuted }}>{sub}</div>}
  </div>
);

const SectionHeader = ({ title, icon }) => (
  <div style={{
    display: 'flex', alignItems: 'center', gap: 8,
    borderBottom: '1px solid rgba(255,255,255,0.08)',
    paddingBottom: 8, marginBottom: 12,
  }}>
    {icon && <span style={{ fontSize: 16 }}>{icon}</span>}
    <h3 style={{ fontFamily: fonts.sans, fontSize: 11, fontWeight: 700, letterSpacing: '1.5px', textTransform: 'uppercase', color: colors.textMuted, margin: 0 }}>
      {title}
    </h3>
  </div>
);

const RankBadge = ({ rank }) => {
  const medals = { 1: { bg: 'rgba(245,197,24,0.15)', border: 'rgba(245,197,24,0.5)', color: colors.textGold, icon: '🥇' },
                   2: { bg: 'rgba(180,180,180,0.1)',  border: 'rgba(180,180,180,0.4)', color: '#bbb',          icon: '🥈' },
                   3: { bg: 'rgba(180,120,60,0.1)',   border: 'rgba(180,120,60,0.4)',  color: '#c8844a',       icon: '🥉' } };
  const m = medals[rank];
  if (!m) return <span style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.textMuted, width: 24, textAlign: 'center' }}>{rank}</span>;
  return (
    <div style={{ width: 24, height: 24, borderRadius: '50%', background: m.bg, border: `1px solid ${m.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, flexShrink: 0 }}>
      {m.icon}
    </div>
  );
};

const Bar = ({ pct, color }) => (
  <div style={{ flex: 1, height: 6, background: 'rgba(255,255,255,0.06)', borderRadius: 3, overflow: 'hidden' }}>
    <div style={{ width: `${Math.min(100, pct)}%`, height: '100%', background: color || colors.earningsGreen, borderRadius: 3, transition: 'width 0.5s ease' }} />
  </div>
);

// ── Main Component ────────────────────────────────────────────────────────────

export const StatsView = ({ teams = [], tournaments = [], transactions = [], globalPlayerStats = {} }) => {
  const [activeTab, setActiveTab] = useState('league');
  const [selectedTeamId, setSelectedTeamId] = useState(null);

  const completedTournaments = useMemo(() =>
    tournaments.filter(t => t.completed && t.results?.teams), [tournaments]);

  const selectedTeam = useMemo(() =>
    teams.find(t => t.id === (selectedTeamId || teams[0]?.id)), [teams, selectedTeamId]);

  // ── League-wide stats ─────────────────────────────────────────────────────

  const leagueStats = useMemo(() => {
    if (!completedTournaments.length || !teams.length) return null;

    // Total league pot
    const totalPot = teams.reduce((s, t) => s + (t.earnings || 0), 0);

    // Best single tournament by a team
    let bestTournament = null, bestTournamentEarnings = 0;
    completedTournaments.forEach(t => {
      Object.entries(t.results.teams).forEach(([teamId, result]) => {
        if ((result.totalEarnings || 0) > bestTournamentEarnings) {
          bestTournamentEarnings = result.totalEarnings;
          bestTournament = { tournament: t.name, team: teams.find(x => x.id === teamId)?.name, earnings: result.totalEarnings };
        }
      });
    });

    // Most bonus rounds collected
    const bonusCounts = {};
    completedTournaments.forEach(t => {
      Object.entries(t.results.teams).forEach(([teamId, result]) => {
        const team = teams.find(x => x.id === teamId);
        if (!team) return;
        const b = result.bonuses || {};
        const rounds = (b.round1 ? 1 : 0) + (b.round2 ? 1 : 0) + (b.round3 ? 1 : 0);
        bonusCounts[team.name] = (bonusCounts[team.name] || 0) + rounds;
      });
    });
    const topBonusTeam = Object.entries(bonusCounts).sort((a, b) => b[1] - a[1])[0];

    // Biggest single-player earnings in one tournament
    let biggestPlayer = null, biggestPlayerEarnings = 0;
    completedTournaments.forEach(t => {
      Object.values(t.results.teams).forEach(result => {
        (result.players || []).forEach(p => {
          const total = (p.earnings || 0) + (p.bonus || 0);
          if (total > biggestPlayerEarnings) {
            biggestPlayerEarnings = total;
            biggestPlayer = { name: p.name, earnings: total, tournament: t.name };
          }
        });
      });
    });

    // Biggest goose egg — team with most $0 tournament results
    const gooseEggs = {};
    completedTournaments.forEach(t => {
      Object.entries(t.results.teams).forEach(([teamId, result]) => {
        const team = teams.find(x => x.id === teamId);
        if (!team) return;
        if ((result.totalEarnings || 0) === 0) {
          gooseEggs[team.name] = (gooseEggs[team.name] || 0) + 1;
        }
      });
    });
    const mostGooseEggs = Object.entries(gooseEggs).sort((a, b) => b[1] - a[1])[0];

    // Winning percentage (top-2 finishes)
    const podiums = {};
    completedTournaments.forEach(t => {
      const sorted = Object.entries(t.results.teams)
        .map(([id, r]) => ({ id, earnings: r.totalEarnings || 0 }))
        .sort((a, b) => b.earnings - a.earnings);
      sorted.slice(0, 1).forEach(({ id }) => {
        const team = teams.find(x => x.id === id);
        if (team) podiums[team.name] = (podiums[team.name] || 0) + 1;
      });
    });

    // Week-over-week momentum (last 3 tourneys)
    const recentForm = {};
    teams.forEach(t => { recentForm[t.name] = []; });
    [...completedTournaments].slice(-4).forEach(t => {
      const sorted = Object.entries(t.results.teams)
        .map(([id, r]) => ({ id, earnings: r.totalEarnings || 0 }))
        .sort((a, b) => b.earnings - a.earnings);
      sorted.forEach(({ id }, i) => {
        const team = teams.find(x => x.id === id);
        if (team) recentForm[team.name].push(i + 1);
      });
    });

    return { totalPot, bestTournament, topBonusTeam, biggestPlayer, mostGooseEggs, podiums, recentForm, bonusCounts };
  }, [completedTournaments, teams]);

  // ── Team comparison stats ─────────────────────────────────────────────────

  const teamComparison = useMemo(() => {
    if (!completedTournaments.length || !teams.length) return [];

    return teams.map(team => {
      let totalEarnings = 0, totalBonuses = 0, wins = 0, podiums = 0;
      let bestWeek = 0, worstWeek = Infinity, avgWeek = 0, weekCount = 0;
      let totalTransactionFees = team.transactionFees || 0;
      let gooseEggs = 0;

      completedTournaments.forEach(t => {
        const result = t.results.teams?.[team.id];
        if (!result) return;
        const earnings = result.totalEarnings || 0;
        const bonuses = (result.bonuses?.round1 || 0) + (result.bonuses?.round2 || 0) + (result.bonuses?.round3 || 0);
        totalEarnings += earnings;
        totalBonuses += bonuses;
        weekCount++;
        if (earnings > bestWeek) bestWeek = earnings;
        if (earnings < worstWeek) worstWeek = earnings;
        if (earnings === 0) gooseEggs++;

        // Check rank this week
        const sorted = Object.entries(t.results.teams)
          .map(([id, r]) => ({ id, earnings: r.totalEarnings || 0 }))
          .sort((a, b) => b.earnings - a.earnings);
        const rank = sorted.findIndex(x => x.id === team.id) + 1;
        if (rank === 1) wins++;
        if (rank <= 2) podiums++;
      });

      avgWeek = weekCount ? Math.round(totalEarnings / weekCount) : 0;

      // Cut rate from roster players
      const rosterPlayers = team.roster || [];
      const limitedPlayers = rosterPlayers.filter(p => p.limited);
      const unlimitedPlayers = rosterPlayers.filter(p => p.unlimited);

      // Total transactions
      const teamTx = transactions.filter(t => t.team === team.name);
      const waiverClaims = teamTx.filter(t => t.type === 'waiver').length;
      const faPickups = teamTx.filter(t => t.type === 'free_agent').length;
      const mulligans = teamTx.filter(t => t.type === 'mulligan').length;

      return {
        team,
        totalEarnings,
        totalBonuses,
        wins,
        podiums,
        bestWeek,
        worstWeek: worstWeek === Infinity ? 0 : worstWeek,
        avgWeek,
        gooseEggs,
        weekCount,
        waiverClaims,
        faPickups,
        mulligans,
        totalTransactionFees,
        limitedCount: limitedPlayers.length,
        unlimitedCount: unlimitedPlayers.length,
        netEarnings: totalEarnings - totalTransactionFees,
      };
    }).sort((a, b) => b.totalEarnings - a.totalEarnings);
  }, [completedTournaments, teams, transactions]);

  // ── Player stats across all teams ─────────────────────────────────────────

  const playerStats = useMemo(() => {
    const map = {}; // playerName → stats

    completedTournaments.forEach(t => {
      Object.entries(t.results.teams).forEach(([teamId, result]) => {
        const team = teams.find(x => x.id === teamId);
        (result.players || []).forEach(p => {
          if (!p.name) return;
          if (!map[p.name]) map[p.name] = {
            name: p.name, team: team?.name, totalEarnings: 0, totalBonus: 0,
            starts: 0, cuts: 0, appearances: 0, bestWeek: 0,
            limited: p.limited, unlimited: p.unlimited,
          };
          const entry = map[p.name];
          const earned = (p.earnings || 0) + (p.bonus || 0);
          entry.totalEarnings += earned;
          entry.totalBonus += (p.bonus || 0);
          entry.appearances++;
          if ((p.earnings || 0) > 0) entry.cuts++;
          if (earned > entry.bestWeek) entry.bestWeek = earned;
        });
      });
    });

    // Attach current team
    teams.forEach(team => {
      (team.roster || []).forEach(p => {
        if (map[p.name]) {
          map[p.name].team = team.name;
          map[p.name].limited = p.limited;
          map[p.name].unlimited = p.unlimited;
          map[p.name].starts = p.starts || 0;
        }
      });
    });

    return Object.values(map).sort((a, b) => b.totalEarnings - a.totalEarnings);
  }, [completedTournaments, teams]);

  // ── Round leader leaderboard ──────────────────────────────────────────────

  const roundLeaderboard = useMemo(() => {
    const map = {}; // teamName → { r1, r2, r3, total }

    completedTournaments.forEach(t => {
      Object.entries(t.results.teams).forEach(([teamId, result]) => {
        const team = teams.find(x => x.id === teamId);
        if (!team) return;
        if (!map[team.name]) map[team.name] = { r1: 0, r2: 0, r3: 0, total: 0, totalBonus: 0 };
        const b = result.bonuses || {};
        if (b.round1) { map[team.name].r1++; map[team.name].total++; map[team.name].totalBonus += b.round1; }
        if (b.round2) { map[team.name].r2++; map[team.name].total++; map[team.name].totalBonus += b.round2; }
        if (b.round3) { map[team.name].r3++; map[team.name].total++; map[team.name].totalBonus += b.round3; }
      });
    });

    return Object.entries(map)
      .map(([name, stats]) => ({ name, ...stats }))
      .sort((a, b) => b.total - a.total);
  }, [completedTournaments, teams]);

  // ── Segment breakdown ─────────────────────────────────────────────────────

  const segmentBreakdown = useMemo(() => {
    const segments = {};
    completedTournaments.forEach(t => {
      const seg = getSegmentForTournament(t);
      if (!segments[seg]) segments[seg] = { name: seg, teamEarnings: {}, count: 0 };
      segments[seg].count++;
      Object.entries(t.results.teams).forEach(([teamId, result]) => {
        const team = teams.find(x => x.id === teamId);
        if (!team) return;
        segments[seg].teamEarnings[team.name] = (segments[seg].teamEarnings[team.name] || 0) + (result.totalEarnings || 0);
      });
    });
    return Object.values(segments);
  }, [completedTournaments, teams]);

  // ── Selected team deep dive ───────────────────────────────────────────────

  const teamDive = useMemo(() => {
    if (!selectedTeam) return null;

    // Per-player earnings across all tournaments
    const playerEarnings = {};
    const weeklyResults = [];

    completedTournaments.forEach(t => {
      const result = t.results.teams?.[selectedTeam.id];
      if (!result) return;
      weeklyResults.push({ name: t.name, earnings: result.totalEarnings || 0, bonuses: result.bonuses || {} });
      (result.players || []).forEach(p => {
        if (!playerEarnings[p.name]) playerEarnings[p.name] = { earnings: 0, bonus: 0, cuts: 0, starts: 0, bestWeek: 0 };
        playerEarnings[p.name].earnings += (p.earnings || 0);
        playerEarnings[p.name].bonus += (p.bonus || 0);
        playerEarnings[p.name].starts++;
        if ((p.earnings || 0) > 0) playerEarnings[p.name].cuts++;
        const total = (p.earnings || 0) + (p.bonus || 0);
        if (total > playerEarnings[p.name].bestWeek) playerEarnings[p.name].bestWeek = total;
      });
    });

    // Transactions for this team
    const teamTx = transactions.filter(t => t.team === selectedTeam.name && t.status !== 'pending');
    const totalFees = selectedTeam.transactionFees || 0;

    const sortedPlayers = Object.entries(playerEarnings)
      .map(([name, stats]) => ({ name, ...stats, total: stats.earnings + stats.bonus }))
      .sort((a, b) => b.total - a.total);

    // Consistency score = % of weeks they scored
    const consistencyScore = weeklyResults.length
      ? Math.round((weeklyResults.filter(w => w.earnings > 0).length / weeklyResults.length) * 100)
      : 0;

    return { weeklyResults, sortedPlayers, teamTx, totalFees, consistencyScore };
  }, [selectedTeam, completedTournaments, transactions]);

  // ── Max earnings for bar scaling ─────────────────────────────────────────
  const maxTeamEarnings = useMemo(() =>
    Math.max(...teamComparison.map(t => t.totalEarnings), 1), [teamComparison]);

  const maxPlayerEarnings = useMemo(() =>
    Math.max(...playerStats.map(p => p.totalEarnings), 1), [playerStats]);

  // ── Tabs ──────────────────────────────────────────────────────────────────

  const tabs = [
    { id: 'league',  label: 'League',  icon: '🏆' },
    { id: 'teams',   label: 'Teams',   icon: '⚔️' },
    { id: 'players', label: 'Players', icon: '🏌️' },
    { id: 'team',    label: 'My Team', icon: '📊' },
  ];

  if (!completedTournaments.length) {
    return (
      <div style={{ ...theme.card, padding: 32, textAlign: 'center', color: colors.textMuted, fontFamily: fonts.sans, fontSize: 13 }}>
        Stats will appear once the first tournament is processed.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* Tab bar */}
      <div style={{ ...theme.card, padding: '4px 8px', display: 'flex', gap: 2 }}>
        {tabs.map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
            style={{
              flex: 1, padding: '8px 4px', border: 'none', borderRadius: 3, cursor: 'pointer',
              background: activeTab === tab.id ? 'rgba(245,197,24,0.12)' : 'transparent',
              borderBottom: activeTab === tab.id ? '2px solid rgba(245,197,24,0.7)' : '2px solid transparent',
              fontFamily: fonts.sans, fontSize: 11, fontWeight: 700,
              letterSpacing: '0.5px', textTransform: 'uppercase',
              color: activeTab === tab.id ? colors.textGold : colors.textMuted,
              transition: 'all 0.15s',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
            }}>
            <span>{tab.icon}</span>
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      {/* ── LEAGUE TAB ── */}
      {activeTab === 'league' && leagueStats && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* Hero stats */}
          <div style={{ ...theme.card, padding: 16 }}>
            <SectionHeader title="Season at a Glance" icon="📈" />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
              <StatCard label="Total League Earnings" value={fmt$(leagueStats.totalPot)} accent={colors.textGold} />
              <StatCard label="Tournaments Played" value={completedTournaments.length} sub={`${tournaments.filter(t => !t.completed).length} remaining`} />
              {leagueStats.bestTournament && (
                <StatCard label="Best Team Week" value={fmt$(leagueStats.bestTournament.earnings)}
                  sub={`${leagueStats.bestTournament.team} · ${leagueStats.bestTournament.tournament}`}
                  accent={colors.earningsGreen} />
              )}
              {leagueStats.biggestPlayer && (
                <StatCard label="Biggest Player Week" value={fmt$(leagueStats.biggestPlayer.earnings)}
                  sub={`${leagueStats.biggestPlayer.name} · ${leagueStats.biggestPlayer.tournament}`}
                  accent="rgba(100,180,255,0.85)" />
              )}
            </div>
          </div>

          {/* Tournament wins */}
          <div style={{ ...theme.card, padding: 16 }}>
            <SectionHeader title="Weekly Wins" icon="🥇" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {teamComparison.map((tc, i) => {
                const wins = tc.wins;
                const pct = (wins / completedTournaments.length) * 100;
                return (
                  <div key={tc.team.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontFamily: fonts.serif, fontSize: 13, fontWeight: 600, color: colors.textPrimary, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {tc.team.name}
                    </span>
                    <Bar pct={pct} color={colors.textGold} />
                    <span style={{ fontFamily: fonts.sans, fontSize: 12, color: wins > 0 ? colors.textGold : colors.textMuted, width: 40, textAlign: 'right', flexShrink: 0 }}>
                      {wins}W
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Round leader bonuses */}
          <div style={{ ...theme.card, padding: 16 }}>
            <SectionHeader title="Round Leader Bonuses" icon="🎯" />
            {roundLeaderboard.length === 0 ? (
              <div style={{ color: colors.textMuted, fontFamily: fonts.sans, fontSize: 12 }}>No round leader bonuses yet</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 40px 40px 40px 80px', gap: 8, padding: '0 0 6px', borderBottom: '1px solid rgba(255,255,255,0.06)', marginBottom: 6 }}>
                  {['Team','R1','R2','R3','Bonus $'].map(h => (
                    <span key={h} style={{ fontFamily: fonts.sans, fontSize: 9, letterSpacing: '1px', textTransform: 'uppercase', color: colors.textMuted, textAlign: h === 'Team' ? 'left' : 'center' }}>{h}</span>
                  ))}
                </div>
                {roundLeaderboard.map((row, i) => (
                  <div key={row.name} style={{ display: 'grid', gridTemplateColumns: '1fr 40px 40px 40px 80px', gap: 8, padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.04)', alignItems: 'center' }}>
                    <span style={{ fontFamily: fonts.serif, fontSize: 12, color: colors.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.name}</span>
                    {[row.r1, row.r2, row.r3].map((n, j) => (
                      <span key={j} style={{ fontFamily: fonts.sans, fontSize: 12, color: n > 0 ? colors.earningsGreen : colors.textMuted, textAlign: 'center', fontWeight: n > 0 ? 700 : 400 }}>{n}</span>
                    ))}
                    <span style={{ fontFamily: fonts.sans, fontSize: 12, color: row.totalBonus > 0 ? colors.earningsGreen : colors.textMuted, textAlign: 'center' }}>{fmt$(row.totalBonus)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Segment breakdown */}
          {segmentBreakdown.length > 0 && (
            <div style={{ ...theme.card, padding: 16 }}>
              <SectionHeader title="Swing Breakdown" icon="🏌️" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {segmentBreakdown.map(seg => {
                  const sorted = Object.entries(seg.teamEarnings).sort((a, b) => b[1] - a[1]);
                  const winner = sorted[0];
                  const accent = SEGMENT_COLORS[seg.name] || colors.textGold;
                  return (
                    <div key={seg.name}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                        <span style={{ fontFamily: fonts.sans, fontSize: 11, fontWeight: 700, color: accent, letterSpacing: '0.5px' }}>{seg.name}</span>
                        <span style={{ fontFamily: fonts.sans, fontSize: 10, color: colors.textMuted }}>{seg.count} event{seg.count !== 1 ? 's' : ''}</span>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {sorted.map(([name, earnings], i) => {
                          const max = sorted[0][1] || 1;
                          return (
                            <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span style={{ fontFamily: fonts.serif, fontSize: 11, color: i === 0 ? colors.textPrimary : colors.textMuted, width: 120, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                              <Bar pct={(earnings / max) * 100} color={accent} />
                              <span style={{ fontFamily: fonts.sans, fontSize: 11, color: i === 0 ? accent : colors.textMuted, width: 56, textAlign: 'right', flexShrink: 0 }}>{fmt$(earnings)}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Fun facts */}
          <div style={{ ...theme.card, padding: 16 }}>
            <SectionHeader title="Fun Facts" icon="🎲" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {leagueStats.mostGooseEggs?.[1] > 0 && (
                <div style={{ padding: '10px 12px', background: 'rgba(220,60,60,0.06)', border: '1px solid rgba(220,60,60,0.15)', borderRadius: 3 }}>
                  <span style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.textPrimary }}>
                    🥚 <strong style={{ color: 'rgba(220,100,80,0.9)' }}>{leagueStats.mostGooseEggs[0]}</strong> has gone scoreless {leagueStats.mostGooseEggs[1]}x this season
                  </span>
                </div>
              )}
              {leagueStats.topBonusTeam?.[1] > 0 && (
                <div style={{ padding: '10px 12px', background: 'rgba(80,180,120,0.06)', border: '1px solid rgba(80,180,120,0.15)', borderRadius: 3 }}>
                  <span style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.textPrimary }}>
                    🎯 <strong style={{ color: colors.earningsGreen }}>{leagueStats.topBonusTeam[0]}</strong> leads in round leader bonuses with {leagueStats.topBonusTeam[1]} bonus round{leagueStats.topBonusTeam[1] !== 1 ? 's' : ''}
                  </span>
                </div>
              )}
              {(() => {
                // Most active in transactions
                const txCounts = {};
                transactions.forEach(tx => { txCounts[tx.team] = (txCounts[tx.team] || 0) + 1; });
                const most = Object.entries(txCounts).sort((a, b) => b[1] - a[1])[0];
                if (most) return (
                  <div style={{ padding: '10px 12px', background: 'rgba(245,197,24,0.06)', border: '1px solid rgba(245,197,24,0.15)', borderRadius: 3 }}>
                    <span style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.textPrimary }}>
                      📋 <strong style={{ color: colors.textGold }}>{most[0]}</strong> is the most active GM with {most[1]} transactions
                    </span>
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* ── TEAMS TAB ── */}
      {activeTab === 'teams' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* Head-to-head earnings comparison */}
          <div style={{ ...theme.card, padding: 16 }}>
            <SectionHeader title="Season Earnings" icon="💰" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {teamComparison.map((tc, i) => (
                <div key={tc.team.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <RankBadge rank={i + 1} />
                  <span style={{ fontFamily: fonts.serif, fontSize: 13, fontWeight: 600, color: colors.textPrimary, width: 140, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {tc.team.name}
                  </span>
                  <Bar pct={(tc.totalEarnings / maxTeamEarnings) * 100} color={i === 0 ? colors.textGold : colors.earningsGreen} />
                  <span style={{ fontFamily: fonts.sans, fontSize: 12, color: i === 0 ? colors.textGold : colors.earningsGreen, width: 58, textAlign: 'right', flexShrink: 0, fontWeight: 600 }}>
                    {fmt$(tc.totalEarnings)}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Detailed comparison table */}
          <div style={{ ...theme.card, padding: 16, overflowX: 'auto' }}>
            <SectionHeader title="Team Stats Comparison" icon="📊" />
            <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
              <thead>
                <tr>
                  {['Team', 'Avg/Wk', 'Best Wk', 'Worst Wk', 'Wins', 'Bonus $', 'Tx Fees', 'Net'].map((h, i) => (
                    <th key={h} style={{ ...theme.tableHeaderCell, textAlign: i === 0 ? 'left' : 'right', whiteSpace: 'nowrap', fontSize: 9 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {teamComparison.map((tc, i) => (
                  <tr key={tc.team.id} style={{ borderBottom: `1px solid ${colors.borderSubtle}` }}>
                    <td style={{ padding: '8px 8px', fontFamily: fonts.serif, fontSize: 12, fontWeight: 600, color: colors.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {tc.team.name}
                    </td>
                    {[
                      { v: fmt$(tc.avgWeek), c: colors.textSecondary },
                      { v: fmt$(tc.bestWeek), c: colors.earningsGreen },
                      { v: fmt$(tc.worstWeek), c: tc.worstWeek === 0 ? 'rgba(220,80,60,0.8)' : colors.textMuted },
                      { v: `${tc.wins}W`, c: tc.wins > 0 ? colors.textGold : colors.textMuted },
                      { v: fmt$(tc.totalBonuses), c: tc.totalBonuses > 0 ? colors.earningsGreen : colors.textMuted },
                      { v: fmtFull$(tc.totalTransactionFees), c: tc.totalTransactionFees > 0 ? 'rgba(220,80,60,0.8)' : colors.textMuted },
                      { v: fmt$(tc.netEarnings), c: tc.netEarnings > 0 ? colors.earningsGreen : 'rgba(220,80,60,0.8)' },
                    ].map((cell, j) => (
                      <td key={j} style={{ padding: '8px 8px', fontFamily: fonts.sans, fontSize: 11, color: cell.c, textAlign: 'right' }}>
                        {cell.v}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Recent form */}
          <div style={{ ...theme.card, padding: 16 }}>
            <SectionHeader title="Recent Form (Last 4 Events)" icon="📉" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {leagueStats && Object.entries(leagueStats.recentForm).map(([teamName, positions]) => {
                if (!positions.length) return null;
                const avg = positions.reduce((s, p) => s + p, 0) / positions.length;
                const trend = positions.length >= 2 ? positions[positions.length - 1] - positions[0] : 0;
                return (
                  <div key={teamName} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontFamily: fonts.serif, fontSize: 12, color: colors.textPrimary, width: 130, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{teamName}</span>
                    <div style={{ display: 'flex', gap: 4, flex: 1 }}>
                      {positions.map((pos, i) => {
                        const posColor = pos === 1 ? colors.textGold : pos === 2 ? '#bbb' : pos === teams.length ? 'rgba(220,80,60,0.8)' : colors.textMuted;
                        return (
                          <div key={i} style={{ width: 24, height: 24, borderRadius: 3, background: pos === 1 ? 'rgba(245,197,24,0.15)' : 'rgba(255,255,255,0.04)', border: `1px solid ${pos === 1 ? 'rgba(245,197,24,0.4)' : 'rgba(255,255,255,0.08)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: fonts.sans, fontSize: 11, fontWeight: 700, color: posColor }}>
                            {pos}
                          </div>
                        );
                      })}
                    </div>
                    <span style={{ fontFamily: fonts.sans, fontSize: 11, color: trend < 0 ? colors.earningsGreen : trend > 0 ? 'rgba(220,80,60,0.8)' : colors.textMuted, width: 30, textAlign: 'right', flexShrink: 0 }}>
                      {trend < 0 ? '↑' : trend > 0 ? '↓' : '→'}
                    </span>
                  </div>
                );
              })}
            </div>
            <div style={{ fontFamily: fonts.sans, fontSize: 10, color: colors.textMuted, marginTop: 8 }}>↑ = improving, ↓ = declining (based on finishing position)</div>
          </div>

          {/* Transaction activity */}
          <div style={{ ...theme.card, padding: 16 }}>
            <SectionHeader title="GM Activity" icon="📋" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 50px 50px 60px 70px', gap: 8, padding: '0 0 6px', borderBottom: '1px solid rgba(255,255,255,0.06)', marginBottom: 6 }}>
                {['Team','Waivers','FA','Mulligans','Fees'].map((h, i) => (
                  <span key={h} style={{ fontFamily: fonts.sans, fontSize: 9, letterSpacing: '1px', textTransform: 'uppercase', color: colors.textMuted, textAlign: i === 0 ? 'left' : 'center' }}>{h}</span>
                ))}
              </div>
              {teamComparison.map(tc => (
                <div key={tc.team.id} style={{ display: 'grid', gridTemplateColumns: '1fr 50px 50px 60px 70px', gap: 8, padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.04)', alignItems: 'center' }}>
                  <span style={{ fontFamily: fonts.serif, fontSize: 12, color: colors.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tc.team.name}</span>
                  <span style={{ fontFamily: fonts.sans, fontSize: 12, color: tc.waiverClaims > 0 ? colors.textGold : colors.textMuted, textAlign: 'center' }}>{tc.waiverClaims}</span>
                  <span style={{ fontFamily: fonts.sans, fontSize: 12, color: tc.faPickups > 0 ? colors.earningsGreen : colors.textMuted, textAlign: 'center' }}>{tc.faPickups}</span>
                  <span style={{ fontFamily: fonts.sans, fontSize: 12, color: tc.mulligans > 0 ? 'rgba(100,180,255,0.85)' : colors.textMuted, textAlign: 'center' }}>{tc.mulligans}</span>
                  <span style={{ fontFamily: fonts.sans, fontSize: 12, color: tc.totalTransactionFees > 0 ? 'rgba(220,80,60,0.8)' : colors.textMuted, textAlign: 'center' }}>{fmtFull$(tc.totalTransactionFees)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── PLAYERS TAB ── */}
      {activeTab === 'players' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* Top earners */}
          <div style={{ ...theme.card, padding: 16 }}>
            <SectionHeader title="Top Earners (SFGL)" icon="💵" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {playerStats.slice(0, 15).map((p, i) => (
                <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <RankBadge rank={i + 1} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontFamily: fonts.serif, fontSize: 12, fontWeight: 600, color: p.limited ? colors.textGold : p.unlimited ? 'rgba(100,140,220,0.9)' : colors.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {p.name}
                      </span>
                      {p.limited && <span style={{ fontSize: 9, color: 'rgba(245,197,24,0.6)' }}>★</span>}
                      {p.unlimited && <span style={{ fontSize: 9 }}>♾️</span>}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
                      <Bar pct={(p.totalEarnings / maxPlayerEarnings) * 100} color={p.limited ? 'rgba(245,197,24,0.7)' : colors.earningsGreen} />
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div style={{ fontFamily: fonts.sans, fontSize: 12, fontWeight: 600, color: colors.earningsGreen }}>{fmt$(p.totalEarnings)}</div>
                    <div style={{ fontFamily: fonts.sans, fontSize: 10, color: colors.textMuted }}>{p.cuts}/{p.appearances} cuts</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Best single week */}
          <div style={{ ...theme.card, padding: 16 }}>
            <SectionHeader title="Best Single Week" icon="⚡" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {[...playerStats].sort((a, b) => b.bestWeek - a.bestWeek).slice(0, 10).map((p, i) => (
                <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <RankBadge rank={i + 1} />
                  <span style={{ fontFamily: fonts.serif, fontSize: 12, color: colors.textPrimary, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                  <span style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.earningsGreen, fontWeight: 600, flexShrink: 0 }}>{fmt$(p.bestWeek)}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Best cut rate (min 3 starts) */}
          <div style={{ ...theme.card, padding: 16 }}>
            <SectionHeader title="Best Cut Rate (min 3 starts)" icon="✂️" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {[...playerStats]
                .filter(p => p.appearances >= 3)
                .sort((a, b) => (b.cuts / b.appearances) - (a.cuts / a.appearances))
                .slice(0, 10)
                .map((p, i) => {
                  const rate = Math.round((p.cuts / p.appearances) * 100);
                  return (
                    <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <RankBadge rank={i + 1} />
                      <span style={{ fontFamily: fonts.serif, fontSize: 12, color: colors.textPrimary, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                      <Bar pct={rate} color={colors.earningsGreen} />
                      <span style={{ fontFamily: fonts.sans, fontSize: 12, color: rate >= 75 ? colors.earningsGreen : colors.textMuted, width: 44, textAlign: 'right', flexShrink: 0 }}>{rate}%</span>
                    </div>
                  );
                })}
            </div>
          </div>

          {/* Bonus earners */}
          {playerStats.filter(p => p.totalBonus > 0).length > 0 && (
            <div style={{ ...theme.card, padding: 16 }}>
              <SectionHeader title="Round Leader Earners" icon="🎯" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {[...playerStats].filter(p => p.totalBonus > 0).sort((a, b) => b.totalBonus - a.totalBonus).slice(0, 8).map((p, i) => (
                  <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <RankBadge rank={i + 1} />
                    <span style={{ fontFamily: fonts.serif, fontSize: 12, color: colors.textPrimary, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                    <span style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.earningsGreen, fontWeight: 600, flexShrink: 0 }}>{fmt$(p.totalBonus)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── MY TEAM TAB ── */}
      {activeTab === 'team' && teamDive && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* Team selector */}
          <div style={{ ...theme.card, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontFamily: fonts.sans, fontSize: 11, color: colors.textMuted, letterSpacing: '0.5px', textTransform: 'uppercase' }}>Team</span>
            <select
              value={selectedTeamId || teams[0]?.id || ''}
              onChange={e => setSelectedTeamId(e.target.value)}
              style={{ ...theme.select, flex: 1, fontSize: 13, height: 32 }}
            >
              {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>

          {/* Summary cards */}
          <div style={{ ...theme.card, padding: 16 }}>
            <SectionHeader title="Season Summary" icon="📊" />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
              <StatCard label="Total Earnings" value={fmt$(selectedTeam?.earnings || 0)} accent={colors.earningsGreen} />
              <StatCard label="Consistency" value={`${teamDive.consistencyScore}%`}
                sub="weeks with any earnings"
                accent={teamDive.consistencyScore >= 75 ? colors.earningsGreen : teamDive.consistencyScore >= 50 ? colors.textGold : 'rgba(220,80,60,0.8)'} />
              <StatCard label="Transaction Fees" value={fmtFull$(teamDive.totalFees)} accent="rgba(220,80,60,0.7)" />
              <StatCard label="Net Earnings" value={fmt$((selectedTeam?.earnings || 0) - teamDive.totalFees)}
                accent={(selectedTeam?.earnings || 0) - teamDive.totalFees > 0 ? colors.earningsGreen : 'rgba(220,80,60,0.8)'} />
            </div>
          </div>

          {/* Week-by-week results */}
          <div style={{ ...theme.card, padding: 16 }}>
            <SectionHeader title="Week-by-Week Results" icon="📅" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {teamDive.weeklyResults.map((week, i) => {
                const maxWeek = Math.max(...teamDive.weeklyResults.map(w => w.earnings), 1);
                const bonusTotal = (week.bonuses.round1 || 0) + (week.bonuses.round2 || 0) + (week.bonuses.round3 || 0);
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontFamily: fonts.sans, fontSize: 11, color: colors.textMuted, width: 120, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {week.name.replace(' Championship', '').replace(' Invitational', '').replace(' Classic', '')}
                    </span>
                    <Bar pct={(week.earnings / maxWeek) * 100} color={week.earnings === 0 ? 'rgba(220,80,60,0.4)' : colors.earningsGreen} />
                    <div style={{ textAlign: 'right', flexShrink: 0, minWidth: 56 }}>
                      <span style={{ fontFamily: fonts.sans, fontSize: 11, color: week.earnings === 0 ? 'rgba(220,80,60,0.8)' : colors.earningsGreen }}>
                        {week.earnings === 0 ? '$0' : fmt$(week.earnings)}
                      </span>
                      {bonusTotal > 0 && <span style={{ fontFamily: fonts.sans, fontSize: 9, color: colors.earningsGreen, marginLeft: 2 }}>+{fmt$(bonusTotal)}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Player contributions */}
          <div style={{ ...theme.card, padding: 16 }}>
            <SectionHeader title="Player Contributions" icon="⛳" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {teamDive.sortedPlayers.map((p, i) => {
                const rosterEntry = selectedTeam?.roster.find(r => r.name === p.name);
                const cutRate = p.starts ? Math.round((p.cuts / p.starts) * 100) : 0;
                return (
                  <div key={p.name} style={{ padding: '8px 0', borderBottom: `1px solid ${colors.borderSubtle}` }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <span style={{ fontFamily: fonts.serif, fontSize: 13, fontWeight: 600, color: rosterEntry?.limited ? colors.textGold : rosterEntry?.unlimited ? 'rgba(100,140,220,0.9)' : colors.textPrimary, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {p.name}
                      </span>
                      <span style={{ fontFamily: fonts.sans, fontSize: 12, color: p.total > 0 ? colors.earningsGreen : colors.textMuted, fontWeight: 600, flexShrink: 0 }}>
                        {fmt$(p.total)}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: 12 }}>
                      <span style={{ fontFamily: fonts.sans, fontSize: 10, color: colors.textMuted }}>{p.starts} start{p.starts !== 1 ? 's' : ''}</span>
                      <span style={{ fontFamily: fonts.sans, fontSize: 10, color: cutRate >= 50 ? colors.earningsGreen : colors.textMuted }}>{cutRate}% cut rate</span>
                      {p.bonus > 0 && <span style={{ fontFamily: fonts.sans, fontSize: 10, color: colors.earningsGreen }}>+{fmt$(p.bonus)} bonus</span>}
                      <span style={{ fontFamily: fonts.sans, fontSize: 10, color: colors.textMuted }}>Best: {fmt$(p.bestWeek)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Transaction history */}
          {teamDive.teamTx.length > 0 && (
            <div style={{ ...theme.card, padding: 16 }}>
              <SectionHeader title="Transaction History" icon="📋" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {teamDive.teamTx.slice(-15).reverse().map((tx, i) => {
                  const typeColor = tx.type === 'waiver' ? colors.textGold : tx.type === 'mulligan' ? 'rgba(100,180,255,0.85)' : colors.earningsGreen;
                  const typeLabel = tx.type === 'free_agent' ? 'FA' : tx.type === 'waiver' ? 'Waiver' : tx.type === 'mulligan' ? 'Mulligan' : tx.type;
                  return (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: `1px solid ${colors.borderSubtle}` }}>
                      <span style={{ fontFamily: fonts.sans, fontSize: 9, fontWeight: 700, color: typeColor, background: typeColor.replace('0.85', '0.08').replace('0.9', '0.08'), border: `1px solid ${typeColor.replace('0.85', '0.25').replace('0.9', '0.25')}`, borderRadius: 2, padding: '2px 5px', letterSpacing: '0.5px', textTransform: 'uppercase', flexShrink: 0 }}>
                        {typeLabel}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ fontFamily: fonts.sans, fontSize: 11, color: colors.earningsGreen }}>+ {tx.player}</span>
                        {tx.droppedPlayer && <span style={{ fontFamily: fonts.sans, fontSize: 11, color: colors.textMuted }}> → <span style={{ color: 'rgba(220,80,60,0.8)' }}>- {tx.droppedPlayer}</span></span>}
                      </div>
                      {tx.fee > 0 && <span style={{ fontFamily: fonts.sans, fontSize: 11, color: 'rgba(220,80,60,0.8)', flexShrink: 0 }}>-${tx.fee}</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
