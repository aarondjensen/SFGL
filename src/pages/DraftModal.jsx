// src/pages/DraftModal.jsx
// ============================================================================
// The draft room.
//
// Three things share one sheet because they are the same question asked three
// ways — whose pick is it, who is left, and who owns what:
//
//   Board    every slot in snake order, with the pick that was made in it and,
//            where the slot has changed hands, who it came from
//   Players  the pool — every PGA Tour golfer who is neither kept nor already
//            drafted — and the button that spends the pick on one
//   Trades   pick ownership, which is why the board cannot simply be "round
//            number × standings position"
//
// ── Trades, and why they shape the whole screen ─────────────────────────────
//
// Picks are tradeable, so "whose turn is it" is not derivable from the
// standings alone. A trade is stored as {round, originalTeamId, toTeamId} —
// "the slot that is originally Detroit's in round 3 now belongs to World #1" —
// and NOT as an overall pick number, so that correcting the standings order or
// changing the round count re-derives the board without every recorded trade
// sliding onto the wrong slot. applyPickTrades in api/_draft.js is the one
// place that resolution happens; this screen renders its output and never
// recomputes ownership itself.
//
// The consequence a manager sees: a pick can be on the clock for a team that
// is nowhere near that position in the standings, and every such slot says
// where it came from.
//
// ── Who may pick ────────────────────────────────────────────────────────────
//
// The owning manager, or the commissioner on anyone's behalf. firestore.rules
// enforces the first half of that (a manager may only CREATE a pick whose
// teamId they own, and may never update one) and cannot enforce the turn
// order, which needs the derived board. The clock is enforced here, and the
// commissioner can undo — which is the same division of labour the waiver
// queue already runs on.
// ============================================================================

import { useState, useMemo, useEffect, useRef } from 'react';
import { BottomSheet } from '../components/BottomSheet';
import { useDialog } from './DialogContext';
import { theme, colors, fonts, fontSize, gold, steel, white, green, blue } from '../theme.js';
import { activatable } from '../utils/a11y';
import { TeamName } from '../components/TeamName';
import { playersApi } from '../api/firebase';
import { NameSet } from '../../api/_playerNames.js';
import { pickLabel, picksForTeam, pickByOverall, draftedPlayerAttrs, registryLookup } from '../../api/_draft.js';

const TABS = [
  ['board',   'Board'],
  ['players', 'Players'],
  ['trades',  'Trades'],
];

// A limited-round pick is worth a star, so the board and the confirm button
// both say so. Colours match the roster tiers: gold limited, steel unlimited.
const tierColor = (limited) => (limited ? colors.textGold : steel(0.9));

const TabBar = ({ value, onChange }) => (
  <div style={{
    display: 'flex', gap: 2, padding: 3, marginBottom: 12,
    background: white(0.04), border: `1px solid ${white(0.1)}`, borderRadius: 10,
  }}>
    {TABS.map(([id, label]) => {
      const active = value === id;
      return (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          style={{
            flex: 1, padding: '7px 0', borderRadius: 8,
            background: active ? white(0.08) : 'transparent',
            border: active ? `1px solid ${white(0.18)}` : '1px solid transparent',
            fontFamily: fonts.sans, fontSize: fontSize.caption, fontWeight: 700,
            letterSpacing: '0.6px', textTransform: 'uppercase',
            color: active ? colors.textPrimary : colors.textMuted,
            cursor: 'pointer', transition: 'all 0.15s',
          }}
        >
          {label}
        </button>
      );
    })}
  </div>
);

// ── Board ───────────────────────────────────────────────────────────────────
const BoardTab = ({ order, picks, teams, onTheClock, isCommissioner, onUndo }) => {
  const made = pickByOverall(picks);
  const teamName = (id) => teams.find(t => (t.id || t.name) === id)?.name || id;
  const clockRef = useRef(null);

  // Scroll the slot on the clock into view when the tab opens. A thirteen-round
  // board is several screens long and the interesting row is rarely at the top.
  useEffect(() => {
    clockRef.current?.scrollIntoView({ block: 'center' });
  }, [onTheClock?.overall]);

  const rounds = [...new Set(order.map(p => p.round))];

  return (
    <div>
      {rounds.map(round => {
        const slots = order.filter(p => p.round === round);
        const limitedRound = slots[0]?.limited;
        return (
          <div key={round} style={{ marginBottom: 14 }}>
            <div style={{
              display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 5,
            }}>
              <span style={{
                fontFamily: fonts.sans, fontSize: fontSize.xs, fontWeight: 700,
                letterSpacing: '1.6px', textTransform: 'uppercase',
                color: limitedRound ? colors.textGold : colors.textMuted,
              }}>
                Round {round}
              </span>
              {limitedRound && (
                <span style={{ fontFamily: fonts.sans, fontSize: fontSize.xs, color: colors.textGoldDim }}>
                  limited ⭐
                </span>
              )}
            </div>
            {slots.map(slot => {
              const pick = made.get(Number(slot.overall));
              const onClock = onTheClock?.overall === slot.overall;
              const traded = slot.teamId !== slot.originalTeamId;
              return (
                <div
                  key={slot.overall}
                  ref={onClock ? clockRef : undefined}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '7px 9px', marginBottom: 3, borderRadius: 4,
                    background: onClock ? green(0.1) : white(0.025),
                    border: `1px solid ${onClock ? green(0.45) : colors.borderSubtle}`,
                  }}
                >
                  <span style={{
                    fontFamily: fonts.sans, fontSize: fontSize.xs, fontWeight: 700,
                    color: colors.textMuted, width: 46, flexShrink: 0,
                  }}>
                    {pickLabel(slot)}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontFamily: fonts.sans, fontSize: fontSize.sm,
                      color: colors.textSecondary,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      <TeamName name={teamName(slot.teamId)} />
                      {traded && (
                        <span style={{ color: blue(0.8), marginLeft: 5 }}>
                          via {teamName(slot.originalTeamId)}
                        </span>
                      )}
                    </div>
                    {pick?.player && (
                      <div style={{
                        fontFamily: fonts.sans, fontSize: fontSize.md, fontWeight: 600,
                        color: tierColor(slot.limited),
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {pick.player}
                      </div>
                    )}
                  </div>
                  {onClock && !pick && (
                    <span style={{
                      fontFamily: fonts.sans, fontSize: fontSize.xs, fontWeight: 700,
                      letterSpacing: '0.8px', textTransform: 'uppercase', color: colors.earningsGreen,
                    }}>
                      on the clock
                    </span>
                  )}
                  {pick && isCommissioner && (
                    <button
                      type="button"
                      onClick={() => onUndo(slot.overall)}
                      style={{ ...theme.btnIconSmall, flexShrink: 0 }}
                      aria-label={`Undo ${pickLabel(slot)} — ${pick.player}`}
                      title="Undo this pick"
                    >
                      ↺
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
};

// ── Players ─────────────────────────────────────────────────────────────────
const PlayersTab = ({
  pool, searchTerm, setSearchTerm, searching,
  selected, setSelected, canPick, onTheClock, onConfirm, submitting, registry,
  limitedRounds,
}) => {
  // Prior attributes resolved by player IDENTITY. The pool comes from OWGR and
  // the registry is keyed by the roster spelling, so a bare registry[name]
  // would read a returning player as new to the league — which is exactly the
  // case that decides whether he gets the retroactive promotion star.
  const priorOf = useMemo(() => registryLookup(registry), [registry]);

  // What the pick makes of him, from the same function the rollover will run —
  // so the "becomes limited ⭐⭐" on this button is not a second opinion.
  const preview = useMemo(() => {
    if (!selected || !onTheClock) return null;
    return draftedPlayerAttrs(selected, {
      round: onTheClock.round,
      limitedRounds,
      prior: priorOf(selected),
    });
  }, [selected, onTheClock, limitedRounds, priorOf]);

  return (
    <div>
      <input
        type="search"
        value={searchTerm}
        onChange={e => setSearchTerm(e.target.value)}
        placeholder="Search the pool…"
        aria-label="Search available players"
        style={{ ...theme.input, width: '100%', marginBottom: 10, boxSizing: 'border-box' }}
      />

      {selected && (
        <div style={{
          padding: '10px 12px', marginBottom: 10, borderRadius: 4,
          background: green(0.08), border: `1px solid ${green(0.4)}`,
        }}>
          <div style={{
            fontFamily: fonts.sans, fontSize: fontSize.md, fontWeight: 700,
            color: tierColor(preview?.limited),
          }}>
            {selected}
            {preview?.limited && preview.stars > 0 && (
              <span style={{ marginLeft: 6, fontSize: fontSize.badge, letterSpacing: 1 }}>
                {'⭐'.repeat(preview.stars)}
              </span>
            )}
          </div>
          <div style={{ fontFamily: fonts.sans, fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 }}>
            {preview?.limited
              ? `${pickLabel(onTheClock)} is a limited round — he joins as limited on ${preview.stars} star${preview.stars === 1 ? '' : 's'}`
              : `${pickLabel(onTheClock)} — unlimited, no start cap`}
          </div>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!canPick || submitting}
            style={{
              ...theme.btnPrimary, width: '100%', marginTop: 8,
              opacity: (!canPick || submitting) ? 0.45 : 1,
              cursor: (!canPick || submitting) ? 'default' : 'pointer',
            }}
          >
            {submitting ? 'Drafting…' : canPick ? `Draft ${selected}` : 'Not your pick'}
          </button>
        </div>
      )}

      {searching && (
        <div style={theme.emptyState}>Searching…</div>
      )}
      {!searching && pool.length === 0 && (
        <div style={theme.emptyState}>
          {searchTerm ? 'Nobody available by that name.' : 'The pool is empty.'}
        </div>
      )}
      {pool.map(p => (
        <div
          key={p.name}
          {...activatable(() => setSelected(selected === p.name ? null : p.name), {
            selected: selected === p.name,
            label: p.name,
          })}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '8px 10px', marginBottom: 3, borderRadius: 4, cursor: 'pointer',
            background: selected === p.name ? green(0.12) : white(0.025),
            border: `1px solid ${selected === p.name ? green(0.45) : colors.borderSubtle}`,
          }}
        >
          <span style={{
            flex: 1, minWidth: 0,
            fontFamily: fonts.sans, fontSize: fontSize.md, color: colors.textPrimary,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {p.name}
          </span>
          <span style={{
            fontFamily: fonts.sans, fontSize: fontSize.xs, color: colors.textMuted, flexShrink: 0,
          }}>
            {p.worldRank ? `#${p.worldRank}` : '—'}
          </span>
        </div>
      ))}
    </div>
  );
};

// ── Trades ──────────────────────────────────────────────────────────────────
const TradesTab = ({ state, order, teams, isCommissioner, onTrade, onUntrade, busy }) => {
  const [round, setRound] = useState(1);
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const teamName = (id) => teams.find(t => (t.id || t.name) === id)?.name || id;
  const rounds = [...new Set(order.map(p => p.round))];
  const trades = state?.trades || [];

  // The slot being traded, resolved through the SAME board the draft runs on —
  // so the confirmation names the pick's current owner rather than assuming the
  // original one still holds it, which is wrong the moment a pick is flipped
  // twice.
  const slot = order.find(p => p.round === Number(round) && p.originalTeamId === fromId);

  return (
    <div>
      {trades.length === 0 ? (
        <div style={theme.emptyState}>No picks have changed hands.</div>
      ) : (
        <div style={{ marginBottom: 14 }}>
          {trades.map((t, i) => (
            <div
              key={`${t.round}-${t.originalTeamId}-${i}`}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '8px 10px', marginBottom: 3, borderRadius: 4,
                background: white(0.025), border: `1px solid ${colors.borderSubtle}`,
              }}
            >
              <span style={{
                fontFamily: fonts.sans, fontSize: fontSize.xs, fontWeight: 700,
                color: colors.textMuted, width: 46, flexShrink: 0,
              }}>
                R{t.round}
              </span>
              <span style={{
                flex: 1, minWidth: 0, fontFamily: fonts.sans, fontSize: fontSize.sm,
                color: colors.textSecondary,
              }}>
                {teamName(t.originalTeamId)} → <span style={{ color: blue(0.9) }}>{teamName(t.toTeamId)}</span>
              </span>
              {isCommissioner && (
                <button
                  type="button"
                  onClick={() => onUntrade(i)}
                  disabled={busy}
                  style={{ ...theme.btnIconSmall, flexShrink: 0 }}
                  aria-label={`Reverse the round ${t.round} trade`}
                  title="Reverse this trade"
                >
                  ↺
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {!isCommissioner ? (
        <div style={{ fontFamily: fonts.sans, fontSize: fontSize.sm, color: colors.textMuted }}>
          Agree a trade with the other manager, then ask the commissioner to record it here.
        </div>
      ) : (
        <div style={{
          padding: 12, borderRadius: 4,
          background: white(0.03), border: `1px solid ${colors.borderSubtle}`,
        }}>
          <div style={{ ...theme.label, marginBottom: 8 }}>Record a pick trade</div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <select value={round} onChange={e => setRound(Number(e.target.value))} style={{ ...theme.select, flex: '0 0 90px' }} aria-label="Round">
              {rounds.map(r => <option key={r} value={r}>Round {r}</option>)}
            </select>
            <select value={fromId} onChange={e => setFromId(e.target.value)} style={{ ...theme.select, flex: 1 }} aria-label="Whose pick">
              <option value="">Whose pick…</option>
              {teams.map(t => <option key={t.id || t.name} value={t.id || t.name}>{t.name}</option>)}
            </select>
          </div>
          <select value={toId} onChange={e => setToId(e.target.value)} style={{ ...theme.select, width: '100%', marginBottom: 8 }} aria-label="Goes to">
            <option value="">Goes to…</option>
            {teams.map(t => <option key={t.id || t.name} value={t.id || t.name}>{t.name}</option>)}
          </select>
          {slot && toId && (
            <div style={{
              fontFamily: fonts.sans, fontSize: fontSize.xs, color: colors.textGoldDim, marginBottom: 8,
            }}>
              {pickLabel(slot)} · currently {teamName(slot.teamId)} → {teamName(toId)}
            </div>
          )}
          <button
            type="button"
            onClick={() => { onTrade({ round: Number(round), originalTeamId: fromId, toTeamId: toId }); setFromId(''); setToId(''); }}
            disabled={busy || !fromId || !toId || fromId === toId || !slot}
            style={{
              ...theme.btnPrimary, width: '100%',
              opacity: (busy || !fromId || !toId || fromId === toId || !slot) ? 0.45 : 1,
            }}
          >
            Record trade
          </button>
        </div>
      )}
    </div>
  );
};

// ── The sheet ───────────────────────────────────────────────────────────────
export const DraftModal = ({
  isOpen, onClose, season, state, picks = [], order = [], onTheClock,
  teams = [], allPlayers = [], registry = {}, keptNames = [],
  isCommissioner = false, myTeamId = null,
  onMakePick, onUndoPick, onTrade, onUntrade,
}) => {
  const dialog = useDialog();
  const [tab, setTab] = useState('board');
  const [selected, setSelected] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const searchTimer = useRef(null);

  // Everyone who is off the board: kept players and players already drafted.
  // A NameSet, not a Set of strings — the pool comes from OWGR while keeper
  // tags and picks are stored under the roster spelling, and the two disagree
  // on names like 'Nico Echavarria' often enough that a plain Set would leave
  // a kept player sitting in the pool for somebody else to draft.
  const unavailable = useMemo(
    () => new NameSet([...(keptNames || []), ...picks.map(p => p?.player).filter(Boolean)]),
    [keptNames, picks],
  );

  const pool = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    const base = term && searchResults.length ? searchResults : (allPlayers || []);
    return base
      .filter(p => p?.name && typeof p.name === 'string')
      // Same rosterability filter the add/drop pool applies: LIV players are
      // ineligible, and the collection carries a few junk rows (bare numbers,
      // single words) that are not golfers.
      .filter(p => !p.isLiv && p.name.includes(' ') && !/^\d+$/.test(p.name.trim()))
      .filter(p => !unavailable.has(p.name))
      .filter(p => !term || p.name.toLowerCase().includes(term))
      .sort((a, b) => (a.worldRank ?? 9999) - (b.worldRank ?? 9999))
      .slice(0, term ? 40 : 100);
  }, [allPlayers, searchResults, searchTerm, unavailable]);

  // Fall back to a Firestore search only when the in-memory list — the ~600
  // OWGR-ranked players already loaded — has nothing. The pool is every PGA
  // Tour golfer, which is a wider set than OWGR ranks, and a late-round pick
  // on a Monday qualifier is exactly the case this covers.
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const term = searchTerm.trim();
    if (term.length < 3) { setSearchResults([]); return undefined; }
    searchTimer.current = setTimeout(async () => {
      const local = (allPlayers || []).filter(p =>
        p?.name && p.name.toLowerCase().includes(term.toLowerCase()) && !unavailable.has(p.name));
      if (local.length >= 5) { setSearchResults([]); return; }
      setSearching(true);
      try { setSearchResults(await playersApi.searchByName(term, 20)); }
      catch { setSearchResults([]); }
      finally { setSearching(false); }
    }, 300);
    return () => clearTimeout(searchTimer.current);
  }, [searchTerm, allPlayers, unavailable]);

  // A closed sheet holding a half-made pick is a pick waiting to be made on the
  // wrong slot when it reopens.
  useEffect(() => { if (!isOpen) { setSelected(null); setSearchTerm(''); } }, [isOpen]);

  if (!isOpen) return null;

  const teamName = (id) => teams.find(t => (t.id || t.name) === id)?.name || id;
  const canPick = !!onTheClock && (isCommissioner || onTheClock.teamId === myTeamId);
  const myNext = myTeamId
    ? picksForTeam(order, myTeamId).find(p => !pickByOverall(picks).has(Number(p.overall)))
    : null;

  const confirmPick = async () => {
    if (!selected || !onTheClock) return;
    setBusy(true);
    try {
      await onMakePick(onTheClock, selected);
      setSelected(null);
      setSearchTerm('');
      setTab('board');
    } catch (err) {
      dialog.showToast('Error: ' + err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const wrap = async (fn) => {
    setBusy(true);
    try { await fn(); }
    catch (err) { dialog.showToast('Error: ' + err.message, 'error'); }
    finally { setBusy(false); }
  };

  return (
    <BottomSheet
      isOpen={isOpen}
      onClose={onClose}
      variant="panel"
      accent={colors.earningsGreen}
      label={`${season} draft`}
    >
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        <div style={{ padding: '14px 16px 0' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ ...theme.sectionTitle, color: colors.earningsGreen }}>
              {season} Draft
            </span>
            <button type="button" onClick={onClose} style={theme.btnIconSmall} aria-label="Close the draft">✕</button>
          </div>

          {onTheClock ? (
            <div style={{
              marginTop: 8, marginBottom: 10, padding: '9px 12px', borderRadius: 4,
              background: green(0.08), border: `1px solid ${green(0.35)}`,
            }}>
              <div style={{ fontFamily: fonts.sans, fontSize: fontSize.xs, color: colors.textMuted, letterSpacing: '1px', textTransform: 'uppercase' }}>
                On the clock · {pickLabel(onTheClock)} {onTheClock.limited ? '· limited ⭐' : ''}
              </div>
              <div style={{ fontFamily: fonts.sans, fontSize: fontSize.lg, fontWeight: 600, color: colors.textPrimary }}>
                <TeamName name={teamName(onTheClock.teamId)} />
                {onTheClock.teamId !== onTheClock.originalTeamId && (
                  <span style={{ color: blue(0.8), fontSize: fontSize.sm, marginLeft: 6 }}>
                    via {teamName(onTheClock.originalTeamId)}
                  </span>
                )}
              </div>
              {myNext && myNext.overall !== onTheClock.overall && (
                <div style={{ fontFamily: fonts.sans, fontSize: fontSize.xs, color: colors.textGoldDim, marginTop: 2 }}>
                  Your next pick: {pickLabel(myNext)}
                </div>
              )}
            </div>
          ) : (
            <div style={{
              marginTop: 8, marginBottom: 10, padding: '9px 12px', borderRadius: 4,
              background: gold(0.08), border: `1px solid ${colors.border}`,
              fontFamily: fonts.sans, fontSize: fontSize.sm, color: colors.textGoldDim,
            }}>
              {order.length === 0
                ? 'No board yet — the commissioner generates the order from the final standings.'
                : 'Every pick is in. The commissioner can finalise the rollover.'}
            </div>
          )}

          <TabBar value={tab} onChange={setTab} />
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 16px 20px' }}>
          {tab === 'board' && (
            <BoardTab
              order={order}
              picks={picks}
              teams={teams}
              onTheClock={onTheClock}
              isCommissioner={isCommissioner}
              onUndo={(overall) => wrap(() => onUndoPick(overall))}
            />
          )}
          {tab === 'players' && (
            <PlayersTab
              pool={pool}
              searchTerm={searchTerm}
              setSearchTerm={setSearchTerm}
              searching={searching}
              selected={selected}
              setSelected={setSelected}
              canPick={canPick}
              onTheClock={onTheClock}
              onConfirm={confirmPick}
              submitting={busy}
              registry={registry}
              limitedRounds={state?.limitedRounds ?? 2}
            />
          )}
          {tab === 'trades' && (
            <TradesTab
              state={state}
              order={order}
              teams={teams}
              isCommissioner={isCommissioner}
              busy={busy}
              onTrade={(t) => wrap(() => onTrade(t))}
              onUntrade={(i) => wrap(() => onUntrade(i))}
            />
          )}
        </div>
      </div>
    </BottomSheet>
  );
};

export default DraftModal;
