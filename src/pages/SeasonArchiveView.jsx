// src/pages/SeasonArchiveView.jsx
// ============================================================================
// A finished season, read-only, after the rollover has overwritten the live
// collections.
//
// WHY A COPY AND NOT A FILTER
// ---------------------------
// There is no "show me last season" switch available, because the rollover
// genuinely destroys the originals: transactions are deleted (they would
// otherwise replay onto the new rosters through buildEffectiveRoster), the
// schedule import deletes every tournament doc not in the new set along with
// its results, and rosters are replaced in place. So the archive written at
// rollover step 1 is the only copy, and this is the only thing that reads it.
//
// WHAT IT REUSES, AND WHAT IT DOES NOT
// ------------------------------------
// Standings render through the REAL StandingsView, handed the archived teams,
// tournaments and transactions — they are the same shapes it takes live, so a
// manager looking up 2026 sees the table they read all year rather than a
// second, slightly-different rendering of it. That is worth more than the
// import costs: it also means the swing selector, the behind/total toggle and
// the swing-winner trophy all work on archived data for free.
//
// Events, rosters and the transaction log are drawn here instead. TournamentsView
// and RostersView are built around a LIVE week — tee times, odds, the field,
// lineup editing, the start cap — and handing them a dead season would mean
// threading "pretend none of that exists" through two of the largest files in
// the app. A compact read-only list is the honest version of what is left once
// you take the live parts out.
// ============================================================================

import { useState, useEffect, useMemo } from 'react';
import { seasonArchiveApi } from '../api/firebase';
import { StandingsView } from './StandingsView';
import { TeamName } from '../components/TeamName';
import { theme, colors, fonts, fontSize, steel, white } from '../theme.js';
import { effectiveStars } from '../../api/_draft.js';
import { getSegmentForTournament } from '../utils';

const TABS = [
  ['standings',    'Standings'],
  ['events',       'Events'],
  ['rosters',      'Rosters'],
  ['transactions', 'Moves'],
];

const money = (n) => {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return '$' + (v / 1_000_000).toFixed(2) + 'M';
  if (v >= 1_000)     return '$' + Math.round(v / 1_000) + 'k';
  return '$' + v;
};

const tierColor = (p) => (p?.limited ? colors.textGold : p?.unlimited ? steel(0.9) : colors.textPrimary);

const Row = ({ children, onClick, open }) => (
  <div
    onClick={onClick}
    style={{
      padding: '9px 11px', marginBottom: 3, borderRadius: 4,
      background: open ? white(0.05) : white(0.025),
      border: `1px solid ${open ? white(0.14) : colors.borderSubtle}`,
      cursor: onClick ? 'pointer' : 'default',
    }}
  >
    {children}
  </div>
);

// ── Events ──────────────────────────────────────────────────────────────────
const EventsTab = ({ tournaments, teams }) => {
  const [open, setOpen] = useState(null);
  const teamName = (id) => teams.find(t => (t.id || t.name) === id)?.name || id;
  const played = tournaments.filter(t => t?.completed && t?.results?.teams);

  if (!played.length) return <div style={theme.emptyState}>No completed events in this archive.</div>;

  return (
    <div>
      {played.map((t, i) => {
        const byTeam = Object.entries(t.results.teams)
          .map(([teamId, r]) => ({ teamId, earnings: r.totalEarnings || 0, players: r.players || [] }))
          .sort((a, b) => b.earnings - a.earnings);
        const isOpen = open === i;
        return (
          <Row key={t.name + i} onClick={() => setOpen(isOpen ? null : i)} open={isOpen}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{
                flex: 1, minWidth: 0, fontFamily: fonts.sans, fontSize: fontSize.md,
                color: colors.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {t.name}
                {t.isMajor && <span style={{ color: colors.textGold, marginLeft: 5, fontSize: fontSize.xs }}>MAJOR</span>}
              </span>
              <span style={{ fontFamily: fonts.sans, fontSize: fontSize.xs, color: colors.textMuted, flexShrink: 0 }}>
                {getSegmentForTournament(t) || t.dates || ''}
              </span>
            </div>
            <div style={{ fontFamily: fonts.sans, fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1 }}>
              Won by {teamName(byTeam[0]?.teamId)} · {money(byTeam[0]?.earnings)}
            </div>

            {isOpen && (
              <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${colors.borderSubtle}` }}>
                {byTeam.map(row => (
                  <div key={row.teamId} style={{ marginBottom: 8 }}>
                    <div style={{
                      display: 'flex', justifyContent: 'space-between', gap: 8,
                      fontFamily: fonts.sans, fontSize: fontSize.sm, color: colors.textSecondary,
                    }}>
                      <span><TeamName name={teamName(row.teamId)} /></span>
                      <span style={{ color: row.earnings > 0 ? colors.earningsGreen : colors.textMuted }}>
                        {money(row.earnings)}
                      </span>
                    </div>
                    {row.players.map((p, k) => (
                      <div key={(p.name || p) + k} style={{
                        display: 'flex', justifyContent: 'space-between', gap: 8,
                        paddingLeft: 10, fontFamily: fonts.sans, fontSize: fontSize.xs,
                        color: tierColor(p),
                      }}>
                        <span>{p.name || p}</span>
                        <span style={{ color: colors.textMuted }}>
                          {(p.earnings || 0) + (p.bonus || 0) > 0 ? money((p.earnings || 0) + (p.bonus || 0)) : '—'}
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </Row>
        );
      })}
    </div>
  );
};

// ── Rosters ─────────────────────────────────────────────────────────────────
// The roster as it stood when the season closed — the team documents at archive
// time, NOT a transaction replay. Replaying is what the live app does to derive
// a current roster, and against a finished season the stored array already IS
// the answer.
const RostersTab = ({ teams }) => (
  <div>
    {teams.map(team => {
      const roster = [...(team.roster || [])].sort((a, b) =>
        (b.limited ? 2 : b.unlimited ? 1 : 0) - (a.limited ? 2 : a.unlimited ? 1 : 0)
        || String(a.name).localeCompare(String(b.name)));
      return (
        <div key={team.id || team.name} style={{ marginBottom: 14 }}>
          <div style={{
            fontFamily: fonts.sans, fontSize: fontSize.xs, fontWeight: 700,
            letterSpacing: '1.6px', textTransform: 'uppercase',
            color: colors.textMuted, marginBottom: 5,
          }}>
            <TeamName name={team.name} /> · {roster.length}
          </div>
          {roster.map(p => (
            <div key={p.name} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 10px', marginBottom: 2, borderRadius: 4,
              background: white(0.025), border: `1px solid ${colors.borderSubtle}`,
            }}>
              <span style={{
                flex: 1, minWidth: 0, fontFamily: fonts.sans, fontSize: fontSize.sm,
                color: tierColor(p), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {p.name}
                {p.limited && effectiveStars(p) > 0 && (
                  <span style={{ marginLeft: 5, fontSize: fontSize.badge, letterSpacing: 1 }}>
                    {'⭐'.repeat(effectiveStars(p))}
                  </span>
                )}
                {p.unlimited && <span style={{ marginLeft: 5, color: steel(0.9) }}>∞</span>}
              </span>
              <span style={{ fontFamily: fonts.sans, fontSize: fontSize.xs, color: colors.textMuted, flexShrink: 0 }}>
                {p.sfglEarnings > 0 ? money(p.sfglEarnings) : '—'}
              </span>
            </div>
          ))}
        </div>
      );
    })}
  </div>
);

// ── Moves ───────────────────────────────────────────────────────────────────
const MovesTab = ({ transactions, teams }) => {
  const teamName = (tx) =>
    teams.find(t => (t.id || t.name) === tx.teamId)?.name || tx.team || '—';
  const rows = useMemo(() => [...(transactions || [])].sort((a, b) => {
    const at = Number(a.timestamp) || new Date(a.timestamp || a.date || 0).getTime() || 0;
    const bt = Number(b.timestamp) || new Date(b.timestamp || b.date || 0).getTime() || 0;
    return bt - at;
  }), [transactions]);

  if (!rows.length) return <div style={theme.emptyState}>No transactions in this archive.</div>;

  return (
    <div>
      {rows.map((tx, i) => (
        <Row key={(tx.txId || tx.id || i) + ''}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{
              fontFamily: fonts.sans, fontSize: fontSize.xs, fontWeight: 700,
              letterSpacing: '0.8px', textTransform: 'uppercase',
              color: tx.type === 'waiver' ? colors.warning
                : tx.type === 'mulligan' ? colors.textGoldDim
                : colors.earningsGreen,
              width: 72, flexShrink: 0,
            }}>
              {tx.type}
            </span>
            <span style={{ flex: 1, minWidth: 0, fontFamily: fonts.sans, fontSize: fontSize.sm, color: colors.textPrimary }}>
              {tx.player}
              {tx.droppedPlayer && (
                <span style={{ color: colors.textMuted }}> ← {tx.droppedPlayer}</span>
              )}
            </span>
          </div>
          <div style={{ fontFamily: fonts.sans, fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1 }}>
            <TeamName name={teamName(tx)} />
            {tx.tournament ? ` · ${tx.tournament}` : ''}
            {tx.status && tx.status !== 'processed' ? ` · ${tx.status}` : ''}
          </div>
        </Row>
      ))}
    </div>
  );
};

// ── The view ────────────────────────────────────────────────────────────────
export const SeasonArchiveView = () => {
  const [seasons, setSeasons] = useState(null);   // null = still loading the index
  const [season, setSeason] = useState(null);
  const [archive, setArchive] = useState(null);
  // Errors are keyed to the season they belong to, so switching seasons clears
  // the message without an effect having to reach in and reset it.
  const [failed, setFailed] = useState(null);     // { season, message }
  const [tab, setTab] = useState('standings');

  // DERIVED, not stored. `setLoading(true)` in the effect body is a
  // synchronous setState inside an effect — it schedules a second render pass
  // before the first has painted, and the repo's lint rules reject it. Asking
  // "is the archive I have the one I asked for?" needs no state at all, and it
  // also means a stale season's data can never be shown under a new season's
  // heading while the new one is in flight.
  const error = failed?.season === season ? failed.message : null;
  const ready = archive?.season === season;
  const loading = season != null && !ready && !error;

  useEffect(() => {
    let cancelled = false;
    seasonArchiveApi.listSeasons()
      .then(list => {
        if (cancelled) return;
        setSeasons(list);
        setSeason(list[0] ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setSeasons([]);
        setFailed({ season: null, message: 'Could not read the archive index.' });
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!season) return undefined;
    let cancelled = false;
    seasonArchiveApi.get(season)
      .then(data => {
        if (cancelled) return;
        // A manifest with no season is a half-written archive — save() writes
        // the manifest last precisely so this should not happen, so say so
        // rather than rendering empty tabs.
        if (!data?.season) {
          setFailed({ season, message: `No archive stored for ${season}.` });
          return;
        }
        setArchive(data);
      })
      .catch(() => {
        if (!cancelled) setFailed({ season, message: `Could not load the ${season} archive.` });
      });
    return () => { cancelled = true; };
  }, [season]);

  if (seasons === null) {
    return <div style={theme.emptyState}>Loading the archive…</div>;
  }

  if (seasons.length === 0) {
    return (
      <div style={theme.emptyState}>
        No seasons have been archived yet. The commissioner writes one at step 1 of
        the season rollover, and it stays readable here afterwards.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 720, margin: '0 auto', width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ ...theme.sectionTitle, color: colors.textGold }}>Archive</span>
        {seasons.length > 1 ? (
          <select
            value={season ?? ''}
            onChange={e => setSeason(Number(e.target.value))}
            aria-label="Season"
            style={{ ...theme.select, width: 'auto', fontSize: fontSize.lg }}
          >
            {seasons.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        ) : (
          <span style={{ ...theme.sectionTitle, color: colors.textPrimary }}>{season}</span>
        )}
        {archive?.archivedAt && (
          <span style={{ fontFamily: fonts.sans, fontSize: fontSize.xs, color: colors.textMuted }}>
            archived {new Date(archive.archivedAt).toLocaleDateString()}
          </span>
        )}
      </div>

      <div style={{
        display: 'flex', gap: 2, padding: 3,
        background: white(0.04), border: `1px solid ${white(0.1)}`, borderRadius: 10,
      }}>
        {TABS.map(([id, label]) => {
          const active = tab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              style={{
                flex: 1, padding: '7px 0', borderRadius: 8,
                background: active ? white(0.08) : 'transparent',
                border: active ? `1px solid ${white(0.18)}` : '1px solid transparent',
                fontFamily: fonts.sans, fontSize: fontSize.caption, fontWeight: 700,
                letterSpacing: '0.6px', textTransform: 'uppercase',
                color: active ? colors.textPrimary : colors.textMuted,
                cursor: 'pointer',
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      {error && (
        <div style={{
          padding: '9px 12px', borderRadius: 4,
          background: colors.warningBg, border: `1px solid ${colors.warningBorder}`,
          fontFamily: fonts.sans, fontSize: fontSize.sm, color: colors.warning,
        }}>
          {error}
        </div>
      )}

      {loading && <div style={theme.emptyState}>Loading {season}…</div>}

      {ready && (
        <>
          {tab === 'standings' && (
            // The real StandingsView on archived data. Same shapes it takes
            // live, so this is the table the league read all year — swing
            // selector, behind/total toggle and swing trophy included.
            <StandingsView
              teams={archive.teams || []}
              tournaments={archive.tournaments || []}
              transactions={archive.transactions || []}
            />
          )}
          {tab === 'events'       && <EventsTab tournaments={archive.tournaments || []} teams={archive.teams || []} />}
          {tab === 'rosters'      && <RostersTab teams={archive.teams || []} />}
          {tab === 'transactions' && <MovesTab transactions={archive.transactions || []} teams={archive.teams || []} />}
        </>
      )}

      <div style={{
        fontFamily: fonts.sans, fontSize: fontSize.xs, color: colors.textMuted,
        textAlign: 'center', paddingBottom: 20,
      }}>
        Read-only. {archive?.counts
          ? `${archive.counts.tournaments} events · ${archive.counts.teams} teams · ${archive.counts.transactions} moves`
          : ''}
      </div>
    </div>
  );
};

export default SeasonArchiveView;
