// src/pages/AddTransactionModal.jsx
// ─────────────────────────────────────────────────────────────────────────────
// Commissioner-only modal for adding a manual transaction. Replaces the
// previous inline collapsible panel in TransactionsView — this is a fill-out-
// a-form-and-leave interaction, so an overlay modal is the right shape.
//
// Visual vocabulary matches the other modal-feel surfaces (UserSettingsModal,
// AddDropPlayerModal):
//   • Mobile bottom-sheet, desktop centered overlay
//   • Soft 1px border with a gold accent stripe on top (commissioner signal)
//   • Eyebrow + title header with X close
//   • M.* tokens for fields (eyebrow labels, soft selects/inputs, lift pill
//     for the primary button)
//
// All add-tx state lives here, not in TransactionsView. The parent's only
// involvement is rendering the modal and providing the open/close toggle.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { useDialog } from './DialogContext';
import { useModalBehavior } from '../utils/modalUtils';
import { sendCommishPush } from '../api/pushNotifications';
import { getCurrentTournamentIndex } from '../utils/index.js';
import { compactTeamName } from '../utils/index.js';
import { getTransactionFee } from '../utils/sharedHelpers';
import { colors, fonts } from '../theme.js';
import { M, disabledBtn } from './admin/adminStyles';
import { LIV_GOLF_ROSTER } from '../constants';

// LIV-ineligible filter — mirrors AddDropPlayerModal. Players are LIV when
// either:
//   • p.isLiv is true (set by data sync / LivIneligiblePanel admin tool)
//   • their name appears in the static LIV_GOLF_ROSTER fallback list
// Both paths matter because the per-player flag isn't always populated for
// new free agents that haven't been synced yet.
const LIV_PLAYERS = new Set(LIV_GOLF_ROSTER);

// Effective roster for a team: the stored base roster with every processed/
// completed add & drop replayed on top. A player netted out by a processed drop
// but still lingering in the stored `roster` array is treated as gone; a player
// added by a processed txn not yet written back is treated as present. Mirrors
// useRoster / buildRoster used everywhere else, so the commish picker never
// disagrees with the Rosters screen or the free-agent modal — which is exactly
// what let a ghost-rostered free agent (Denny McCarthy) get filtered out of the
// "Player Added" pool with "No players found."
const effectiveRoster = (team, transactions) => {
  let r = [...((team && team.roster) || [])];
  (transactions || [])
    .filter(tx =>
      team && tx.team === team.name &&
      tx.type !== 'mulligan' &&
      tx.type !== 'swing_winner' &&
      (tx.status === 'processed' || tx.status === 'completed'))
    .sort((a, b) => (a.tournamentIndex ?? 0) - (b.tournamentIndex ?? 0))
    .forEach(tx => {
      if (tx.droppedPlayer) r = r.filter(p => (p.name || p) !== tx.droppedPlayer);
      if (tx.player && !r.some(p => (p.name || p) === tx.player)) r.push({ name: tx.player });
    });
  return r;
};
const effectiveRosterNames = (team, transactions) =>
  new Set(effectiveRoster(team, transactions).map(p => p.name || p));

// Search-result sorter. Given a query and a filtered list of player records,
// returns them sorted by:
//   1. Prefix match priority — any word in the name starts with the query
//      (so "c" prioritizes "Cantlay" and "Cameron Smith" over "DeChambeau",
//      where the visual C is mid-word and not a prefix)
//   2. World rank ascending — better players float to the top within each
//      group
//   3. Alphabetical name as final tiebreaker
//
// Splits on whitespace AND hyphens so "Anirban Lahiri" → ["anirban","lahiri"]
// and "Byeong-Hun An" → ["byeong","hun","an"]. We deliberately do NOT split
// on camelCase ("DeChambeau" stays as one word) — players are typically
// recognized by their natural surname, not a CamelCase fragment.
const rankSearchResults = (results, query) => {
  const q = query.toLowerCase().trim();
  return results
    .map(p => {
      const name  = (p.name || p).toLowerCase();
      const words = name.split(/[\s-]+/).filter(Boolean);
      const score = words.some(w => w.startsWith(q)) ? 0 : 1;
      return { p, score, rank: p.worldRank ?? 9999, name };
    })
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      if (a.rank  !== b.rank)  return a.rank  - b.rank;
      return a.name.localeCompare(b.name);
    })
    .map(x => x.p);
};

export const AddTransactionModal = ({
  isOpen,
  onClose,
  teams,
  tournaments,
  setTournaments,
  allPlayers = [],
  transactions,
  setTransactions,
  updateTeams,
  settings = {},
  loggedInUser,
}) => {
  const dialog = useDialog();

  // ── Form state ────────────────────────────────────────────────────────────
  // All state is local to the modal and reset on close. The previous version
  // hoisted these into TransactionsView, which leaked state across opens.
  const [team,        setTeam]        = useState('');
  const [type,        setType]        = useState('waiver');
  const [tourney,     setTourney]     = useState('');
  const [playerIn,    setPlayerIn]    = useState(null);   // { name } | null
  const [playerOut,   setPlayerOut]   = useState(null);   // { name } | null
  const [searchIn,    setSearchIn]    = useState('');
  const [searchOut,   setSearchOut]   = useState('');
  const [saving,      setSaving]      = useState(false);

  // Mobile sniff is recomputed on each render — the modal opens infrequently
  // enough that this is cheap. Mirrors AddDropPlayerModal pattern.
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;

  // Escape + body scroll lock. The hook is a no-op when isOpen is false.
  useModalBehavior(isOpen, onClose);

  // Default the tournament dropdown when the modal opens or the type changes.
  // For mulligan, prefer the currently-playing tournament; for everything else,
  // use the canonical Sun-Sat week math. The commish can still override.
  useEffect(() => {
    if (!isOpen) return;
    if (type === 'mulligan') {
      const idx = tournaments.findIndex(t => t.playing);
      if (idx >= 0) setTourney(String(idx));
    } else {
      const found = getCurrentTournamentIndex(tournaments);
      if (found >= 0) setTourney(String(found));
    }
  }, [isOpen, type, tournaments]);

  // Reset all form state when the modal closes so re-opening starts fresh.
  // Avoids the "I opened the panel, picked Detroit, closed, reopened, and
  // Detroit was still selected" gotcha that bit the inline version.
  useEffect(() => {
    if (isOpen) return;
    setTeam(''); setType('waiver'); setTourney('');
    setPlayerIn(null); setPlayerOut(null);
    setSearchIn(''); setSearchOut('');
    setSaving(false);
  }, [isOpen]);

  if (!isOpen) return null;

  // ── Submit handler ────────────────────────────────────────────────────────
  // All the validation, mulligan-specific roster-swap logic, and push
  // dispatch lives here. Migrated from TransactionsView.handleAddTx with no
  // behavior changes (just state-variable renames since they're now local).
  const handleSubmit = async () => {
    if (!team || !type || !tourney) return;
    const teamObj = teams.find(t => t.name === team);
    if (!teamObj) return;

    const playerInName  = playerIn?.name  || null;
    const playerOutName = playerOut?.name || null;

    // ── Mulligan validation ─────────────────────────────────────────────────
    // League rule: each team gets exactly 1 Regular and 1 Sig/Major mulligan
    // per season. Guard against duplicate creation (which would silently
    // corrupt stored results if the tournament was already processed).
    if (type === 'mulligan') {
      const targetTournament = tournaments[parseInt(tourney)];
      const targetIsSigOrMajor = !!(targetTournament?.isSignature || targetTournament?.isMajor);
      const targetTypeLabel = targetIsSigOrMajor ? 'Signature/Major' : 'Regular';

      // Count this team's existing non-failed mulligans of the same event type.
      // Failed mulligans don't consume the allowance.
      const existing = transactions.filter(tx => {
        if (tx.type !== 'mulligan') return false;
        if (tx.team !== team) return false;
        if (tx.status === 'failed') return false;
        const txT = tx.tournamentIndex != null ? tournaments[tx.tournamentIndex] : null;
        const txIsSigOrMajor = !!(txT && (txT.isSignature || txT.isMajor));
        return txIsSigOrMajor === targetIsSigOrMajor;
      });

      if (existing.length > 0) {
        const usedAt = existing
          .map(tx => tournaments[tx.tournamentIndex]?.name)
          .filter(Boolean)
          .join(', ') || 'an earlier event';
        dialog.showToast(
          `${team} already used their ${targetTypeLabel} mulligan this season (${usedAt}). Each team gets 1 per type.`,
          'error'
        );
        return;
      }

      // Both IN and OUT required for a mulligan — without them the record is
      // meaningless data clutter.
      if (!playerInName || !playerOutName) {
        dialog.showToast(
          'Mulligan requires both an OUT player (the one being replaced) and an IN player (the replacement).',
          'error'
        );
        return;
      }
    }

    const ok = await dialog.showConfirm(
      'Add Manual Transaction',
      'Add ' + type + ' for ' + team + ' at ' + tournaments[parseInt(tourney)]?.name +
      (playerInName  ? ' · IN: '  + playerInName  : '') +
      (playerOutName ? ' · OUT: ' + playerOutName : '') + '?',
      { confirmText: 'Add' }
    );
    if (!ok) return;

    setSaving(true);

    const tournamentIndex = parseInt(tourney);
    const isBlocked = type === 'waiver blocked';

    // Fee via the shared resolver (sharedHelpers.getTransactionFee) — normalizes
    // 'fa'/'free agent' in ONE place. This modal stores type 'fa', which the old
    // 'free agent'-only check never matched, saving $0. Blocked claims owe $0.
    const txFee = isBlocked ? 0 : getTransactionFee(type, settings);

    const newTx = {
      txId: `manual-${team}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      team,
      // Canonicalize the persisted free-agent type. This modal's dropdown value
      // is 'fa', but the main add/drop flow (AddDropPlayerModal) writes
      // 'free agent'. Store ONE form so readers never have to check both. The
      // 'fa' dropdown value and this modal's internal type checks are unchanged;
      // only the saved transaction type is normalized.
      type: isBlocked ? 'waiver' : (type === 'fa' ? 'free agent' : type),
      player: playerInName  || playerOutName || '—',
      droppedPlayer: type === 'mulligan' ? playerOutName || undefined
                   : type === 'drop'     ? undefined
                   : playerOutName || undefined,
      fee: txFee,
      segment: tournaments[tournamentIndex]?.segment || '',
      date: new Date().toLocaleDateString(),
      timestamp: Date.now(),
      tournamentIndex,
      // Stable tournament identity (the doc-id name) alongside the positional
      // index, so this transaction stays correctly attributed even if the
      // schedule is later reordered. Reads can prefer this over tournamentIndex.
      tournament: tournaments[tournamentIndex]?.name || undefined,
      status: isBlocked ? 'failed' : 'completed',
      ...(isBlocked ? { failReason: 'Manually voided by commissioner' } : {}),
      manualEntry: true,
    };

    // Insert preserves chronological grouping by tournamentIndex (the same
    // ordering rule the original inline version used).
    const copy = [...transactions];
    const insertAt = copy.reduce((last, tx, i) =>
      (tx.tournamentIndex !== undefined && tx.tournamentIndex <= tournamentIndex) ? i + 1 : last
    , 0);
    copy.splice(insertAt, 0, newTx);

    // ── Mulligan side-effects ───────────────────────────────────────────────
    // For mulligans we also swap the lineup, decrement the mulligan counter,
    // and (if the tournament was already processed) update stored results to
    // reflect the swap.
    let updatedTeams = teams;
    let updatedTournaments = tournaments;
    if (type === 'mulligan' && (playerInName || playerOutName)) {
      const mulliganTeam = teams.find(t => t.name === team);
      const tournament = tournaments[tournamentIndex];
      const isSigOrMajor = tournament?.isSignature || tournament?.isMajor;
      const mullKey = isSigOrMajor ? 'signatureMajor' : 'regular';
      const alreadyProcessed = !!tournament?.completed;

      // Detect re-add of a previously-applied mulligan transaction record:
      // if the IN player is already in stored results, skip re-application.
      const storedPlayers = tournament?.results?.teams?.[mulliganTeam?.id]?.players || [];
      const alreadyApplied = playerInName && storedPlayers.some(p => (p.name || p) === playerInName);

      if (alreadyApplied) {
        console.log(`[Mulligan] Already applied: ${playerInName} is already in ${team}'s results for ${tournament?.name}. Recording transaction only.`);
        dialog.showToast('Mulligan already applied — recording transaction only', 'info');
      } else {
        updatedTeams = teams.map(t => {
          if (t.name !== team) return t;
          return {
            ...t,
            // Swap in the active lineup
            lineup: playerOutName && playerInName
              ? t.lineup.map(p => p === playerOutName ? playerInName : p)
              : t.lineup,
            // Only adjust limited starts if results were ALREADY processed
            // (if not yet processed, processResults will handle starts via team.lineup)
            roster: alreadyProcessed
              ? t.roster.map(p => {
                  if (p.name === playerOutName && p.limited)
                    return { ...p, starts: Math.max(0, (p.starts || 0) - 1) };
                  if (p.name === playerInName && p.limited)
                    return { ...p, starts: (p.starts || 0) + 1 };
                  return p;
                })
              : t.roster,
            // Decrement mulligan counter
            mulligans: {
              ...t.mulligans,
              [mullKey]: Math.max(0, (t.mulligans?.[mullKey] ?? 1) - 1),
            },
          };
        });

        // Swap player in stored tournament results (only if already processed)
        if (alreadyProcessed && mulliganTeam && playerOutName && playerInName) {
          updatedTournaments = tournaments.map((t, i) => {
            if (i !== tournamentIndex || !t.results?.teams?.[mulliganTeam.id]) return t;
            const teamResult = t.results.teams[mulliganTeam.id];

            // Try to find IN player's actual earnings from the tournament earnings map.
            const earningsMap = t.results?.earningsMap || {};
            let inPlayerEarnings = earningsMap[playerInName] ?? 0;
            // Fuzzy match if exact name not found
            if (inPlayerEarnings === 0) {
              const fuzzyKey = Object.keys(earningsMap).find(k =>
                k.toLowerCase().replace(/[^a-z]/g, '') === playerInName.toLowerCase().replace(/[^a-z]/g, '')
              );
              if (fuzzyKey) inPlayerEarnings = earningsMap[fuzzyKey];
            }

            const updatedPlayers = (teamResult.players || []).map(p => {
              const name = p.name || p;
              if (name !== playerOutName) return p;
              return typeof p === 'string'
                ? { name: playerInName, earnings: inPlayerEarnings, mulliganIn: true, replacedPlayer: playerOutName }
                : { ...p, name: playerInName, earnings: inPlayerEarnings, bonus: 0, roundsLed: [], wasRoundLeader: false, mulliganIn: true, replacedPlayer: playerOutName };
            });

            // Recalculate team totalEarnings from updated players
            const newTotal = updatedPlayers.reduce((sum, p) => sum + (p.earnings || 0) + (p.bonus || 0), 0);

            return {
              ...t,
              results: {
                ...t.results,
                teams: {
                  ...t.results.teams,
                  [mulliganTeam.id]: { ...teamResult, players: updatedPlayers, totalEarnings: newTotal },
                },
              },
            };
          });
          setTournaments(updatedTournaments);

          // Also adjust team earnings + roster sfglEarnings to reflect the swap.
          const oldResult = tournaments[tournamentIndex]?.results?.teams?.[mulliganTeam.id];
          const newResult = updatedTournaments[tournamentIndex]?.results?.teams?.[mulliganTeam.id];
          if (oldResult && newResult) {
            const earningsDiff = (newResult.totalEarnings || 0) - (oldResult.totalEarnings || 0);
            const outPlayerOldEarnings = (oldResult.players || []).find(p => (p.name || p) === playerOutName)?.earnings || 0;
            const inPlayerNewEarnings = (newResult.players || []).find(p => (p.name || p) === playerInName)?.earnings || 0;
            updatedTeams = updatedTeams.map(t => {
              if (t.name !== team) return t;
              return {
                ...t,
                earnings: (t.earnings || 0) + earningsDiff,
                segmentEarnings: (t.segmentEarnings || 0) + earningsDiff,
                roster: t.roster.map(p => {
                  if (p.name === playerOutName) return { ...p, sfglEarnings: Math.max(0, (p.sfglEarnings || 0) - outPlayerOldEarnings) };
                  if (p.name === playerInName) return { ...p, sfglEarnings: (p.sfglEarnings || 0) + inPlayerNewEarnings };
                  return p;
                }),
              };
            });
          }
        }

        updateTeams(updatedTeams);
      }
    }

    setTransactions(copy);
    // setTransactions is updateTransactions from useLeague — it handles
    // both local state, localStorage, and Firebase sync internally.

    // ── Push notification (Wave J Round 6 batch 3) ─────────────────────────
    // Notify the affected manager. Skip when blocked (no real roster change)
    // or when the commish is acting on their own team (they already know).
    // Fire-and-forget — failures don't roll back the transaction.
    const affectedTeam = teams.find(t => t.name === team);
    const commishTeam = teams.find(t => t.owner === loggedInUser);
    const shouldPush = !isBlocked
      && affectedTeam?.id
      && commishTeam?.id
      && affectedTeam.id !== commishTeam.id;

    if (shouldPush) {
      const typeLabel = (type === 'fa' || type === 'free agent') ? 'free agent claim'
                     : type === 'drop'        ? 'player drop'
                     : type === 'mulligan'    ? 'mulligan'
                     : type === 'waiver'      ? 'waiver claim'
                     : type === 'swing_winner' ? 'swing winner award'
                     : 'transaction';
      const playerSummary = playerInName && playerOutName
        ? `${playerInName} in, ${playerOutName} out`
        : playerInName
          ? `Added ${playerInName}`
          : playerOutName
            ? `Dropped ${playerOutName}`
            : '';
      try {
        sendCommishPush({
          event: 'commishModified',
          commishTeamId: commishTeam.id,
          recipients: [affectedTeam.id],
          title: '👑 Commissioner edited your team',
          body: playerSummary
            ? `${typeLabel}: ${playerSummary}`
            : `A ${typeLabel} was added to your team`,
          deepLink: '#rosters',
        }).catch(err => console.warn('[push] commishModified send failed:', err.message));
      } catch (err) {
        console.warn('[push] commishModified failed:', err.message);
      }
    }

    setSaving(false);
    dialog.showToast('Transaction added', 'success');
    onClose();
  };

  // ── Form readiness ────────────────────────────────────────────────────────
  // Save is enabled when the bare minimum is in place. Per-type validation
  // (mulligan needs both IN+OUT) is enforced inside handleSubmit so the
  // commish gets a clear error toast, not just a silently-disabled button.
  const canSubmit = !!team && !!tourney && !saving;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(5,10,25,0.85)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: isMobile ? 'flex-end' : 'center',
        justifyContent: 'center',
        padding: isMobile ? 0 : 16,
        zIndex: 60,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: '#0f1d35',
          border: `1px solid ${colors.borderSubtle}`,
          // Gold accent stripe signals commissioner-only. Lighter weight than
          // AddDropPlayerModal's green/orange stripes since this isn't a
          // manager destructive action — it's an admin workflow.
          borderTop: '2px solid rgba(245,197,24,0.6)',
          borderRadius: isMobile ? '12px 12px 0 0' : 10,
          width: '100%', maxWidth: isMobile ? '100%' : 480,
          height: isMobile ? '90vh' : 'auto',
          maxHeight: isMobile ? '90vh' : '82vh',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
        }}
        onClick={e => e.stopPropagation()}
      >

        {/* ── Header ── */}
        <div style={{
          padding: '14px 18px',
          borderBottom: `1px solid ${colors.borderSubtle}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0,
          gap: 10,
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{
              fontFamily: fonts.sans,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '1.8px',
              textTransform: 'uppercase',
              color: 'rgba(245,197,24,0.95)',
            }}>
              👑 Commissioner
            </div>
            <div style={{
              fontFamily: fonts.sans,
              fontSize: 16,
              fontWeight: 600,
              color: colors.textPrimary,
              marginTop: 2,
            }}>
              Add Manual Transaction
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: colors.textSecondary,
              padding: 4,
            }}
            aria-label="Close"
          >
            <X style={{ width: 18, height: 18 }} />
          </button>
        </div>

        {/* ── Body (scrollable) ── */}
        <div
          className="sfgl-modal-scroll"
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '14px 18px',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            minHeight: 0,
          }}
        >
          {/* Team */}
          <div style={M.group}>
            <div style={M.eyebrow}>Team</div>
            <select
              value={team}
              onChange={e => setTeam(e.target.value)}
              style={M.select}
            >
              <option value="">Select team...</option>
              {teams.map(t => <option key={t.id} value={t.name}>{compactTeamName(t.name)}</option>)}
            </select>
          </div>

          {/* Tournament */}
          <div style={M.group}>
            <div style={M.eyebrow}>Tournament</div>
            <select
              value={tourney}
              onChange={e => setTourney(e.target.value)}
              style={M.select}
            >
              <option value="">Select tournament...</option>
              {(() => {
                const dateWeekIdx = getCurrentTournamentIndex(tournaments);
                return tournaments.map((t, i) => {
                  let hint = '';
                  if (t.playing) hint = ' (active)';
                  if (i === dateWeekIdx) hint = ' ← this week';
                  return (
                    <option key={t.name} value={i}>
                      {t.completed ? '✓ ' : t.playing ? '▶ ' : ''}{t.name}{hint}
                    </option>
                  );
                });
              })()}
            </select>
          </div>

          {/* Type — segmented pill control */}
          <div style={M.group}>
            <div style={M.eyebrow}>Type</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {[
                { value: 'waiver',         label: 'Waiver' },
                { value: 'waiver blocked', label: 'Waiver blocked' },
                { value: 'fa',             label: 'Free agent' },
                { value: 'mulligan',       label: 'Mulligan' },
              ].map(({ value, label }) => {
                const isActive = type === value;
                return (
                  <button
                    key={value}
                    onClick={() => {
                      if (value === type) return;
                      setType(value);
                      setPlayerIn(null); setSearchIn('');
                      setPlayerOut(null); setSearchOut('');
                    }}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      padding: '8px 4px',
                      borderRadius: 6,
                      fontSize: 13,
                      fontFamily: fonts.sans,
                      fontWeight: 600,
                      cursor: 'pointer',
                      background: isActive ? 'rgba(245,197,24,0.08)' : 'rgba(255,255,255,0.02)',
                      border: `1px solid ${isActive ? 'rgba(245,197,24,0.35)' : colors.borderSubtle}`,
                      color: isActive ? colors.textGold : colors.textSecondary,
                      transition: 'background 0.15s, border-color 0.15s',
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Player IN — dropdown for mulligan, search for others */}
          {(type !== 'drop') && (() => {
            const teamObj  = teams.find(t => t.name === team);
            const validPlayer = p => p.name && typeof p.name === 'string' && !/^\d+$/.test(p.name.trim());

            // Mulligan: bench dropdown.
            if (type === 'mulligan') {
              const roster = (teamObj?.roster || []).filter(validPlayer);
              const tournIdx = tourney ? parseInt(tourney) : -1;
              const tournament = tournIdx >= 0 ? tournaments[tournIdx] : null;
              const storedPlayers = tournament?.results?.teams?.[teamObj?.id]?.players || [];
              const originalLineup = storedPlayers.map(p => {
                if (p.mulliganIn && p.replacedPlayer) return p.replacedPlayer;
                return p.name || p;
              }).filter(Boolean);
              const currentLineup = teamObj?.lineup || [];
              const lineup = new Set(originalLineup.length > 0 ? originalLineup : currentLineup);
              const benchPlayers = roster.filter(p => !lineup.has(p.name));
              const pool = benchPlayers.length > 0 ? benchPlayers : roster;
              return (
                <div style={M.group}>
                  <div style={M.eyebrow}>Player IN (from bench)</div>
                  <select
                    value={playerIn?.name || ''}
                    onChange={e => {
                      const name = e.target.value;
                      setPlayerIn(name ? { name } : null);
                    }}
                    style={M.select}
                  >
                    <option value="">— select player —</option>
                    {pool.sort((a, b) => a.name.localeCompare(b.name)).map(p => (
                      <option key={p.name} value={p.name}>{p.name}{p.limited ? ' ⭐' : ''}</option>
                    ))}
                  </select>
                </div>
              );
            }

            // Non-mulligan: search free agents (or all players for blocked).
            // Always exclude LIV-ineligible players — they can't be claimed
            // or rostered, so they shouldn't appear in the picker. Same
            // policy applies to waiver-blocked entries (you can't log a
            // blocked claim for a player who couldn't have been claimed).
            const isLivIneligible = (p) => p.isLiv || LIV_PLAYERS.has(p.name);
            // Exclude players who are EFFECTIVELY rostered anywhere (base roster
            // with processed adds/drops replayed) — not the raw stored array,
            // which can still list a player who was already dropped.
            const allRostered = new Set();
            teams.forEach(t => effectiveRosterNames(t, transactions).forEach(n => allRostered.add(n)));
            const pool = type === 'waiver blocked'
              ? allPlayers.filter(p => validPlayer(p) && !isLivIneligible(p))
              : allPlayers.filter(p => {
                  if (!validPlayer(p)) return false;
                  if (isLivIneligible(p)) return false;
                  return !allRostered.has(p.name);
                });
            // Substring filter, then rank by relevance + world rank.
            const matches = pool.filter(p =>
              (p.name || p).toLowerCase().includes(searchIn.toLowerCase())
            );
            const filtered = rankSearchResults(matches, searchIn);
            const label = type === 'waiver blocked' ? 'Player Claimed (blocked)' : 'Player Added';
            return (
              <div style={M.group}>
                <div style={M.eyebrow}>{label}</div>
                {playerIn ? (
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '10px 12px',
                    borderRadius: 6,
                    background: 'rgba(80,195,120,0.08)',
                    border: '1px solid rgba(80,195,120,0.3)',
                  }}>
                    <span style={{
                      fontFamily: fonts.sans,
                      fontSize: 13,
                      fontWeight: 500,
                      color: colors.earningsGreen,
                    }}>
                      {playerIn.name}
                    </span>
                    <button
                      onClick={() => { setPlayerIn(null); setSearchIn(''); }}
                      style={{
                        background: 'rgba(220,80,80,0.08)',
                        border: '1px solid rgba(220,80,80,0.3)',
                        borderRadius: 6,
                        width: 24,
                        height: 24,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        color: 'rgba(230,90,90,0.8)',
                        fontSize: 12,
                        lineHeight: 1,
                      }}
                      aria-label="Clear selection"
                    >
                      ✕
                    </button>
                  </div>
                ) : (
                  <>
                    <input
                      type="text"
                      placeholder="Search free agents…"
                      value={searchIn}
                      onChange={e => setSearchIn(e.target.value)}
                      style={M.input}
                    />
                    {searchIn.length > 0 && (
                      <div style={{
                        maxHeight: 200,
                        overflowY: 'auto',
                        border: `1px solid ${colors.borderSubtle}`,
                        borderRadius: 6,
                        background: 'rgba(255,255,255,0.02)',
                        marginTop: 4,
                      }}>
                        {filtered.slice(0, 20).map(p => {
                          const name = p.name || p;
                          return (
                            <div
                              key={name}
                              onClick={() => { setPlayerIn({ name }); setSearchIn(''); }}
                              style={{
                                padding: '10px 12px',
                                cursor: 'pointer',
                                borderBottom: `1px solid ${colors.borderSubtle}`,
                                display: 'flex',
                                alignItems: 'center',
                                gap: 8,
                                transition: 'background 0.12s',
                              }}
                              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; }}
                              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                            >
                              {p.worldRank && (
                                <span style={{
                                  fontFamily: fonts.sans,
                                  fontSize: 10,
                                  color: colors.textMuted,
                                  minWidth: 28,
                                }}>
                                  {p.worldRank === 999 ? 'NR' : '#' + p.worldRank}
                                </span>
                              )}
                              <span style={{
                                fontFamily: fonts.sans,
                                fontSize: 13,
                                fontWeight: 500,
                                color: colors.textPrimary,
                              }}>
                                {name}
                              </span>
                            </div>
                          );
                        })}
                        {filtered.length === 0 && (
                          <div style={{
                            padding: '12px',
                            fontFamily: fonts.sans,
                            fontSize: 11,
                            color: colors.textMuted,
                            textAlign: 'center',
                          }}>
                            No players found
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })()}

          {/* Player OUT / Dropped — dropdown for mulligan, search for fa/waiver */}
          {(type === 'mulligan' || type === 'fa' || type === 'waiver') && (() => {
            const teamObj = teams.find(t => t.name === team);

            if (type === 'mulligan') {
              const tournIdx = tourney ? parseInt(tourney) : -1;
              const tournament = tournIdx >= 0 ? tournaments[tournIdx] : null;
              const storedPlayers = tournament?.results?.teams?.[teamObj?.id]?.players || [];
              const originalLineup = storedPlayers.map(p => {
                if (p.mulliganIn && p.replacedPlayer) return p.replacedPlayer;
                return p.name || p;
              }).filter(Boolean);
              const currentLineup = teamObj?.lineup || [];
              const lineup = originalLineup.length > 0 ? originalLineup : currentLineup;
              const rosterMap = {};
              (teamObj?.roster || []).forEach(p => { rosterMap[p.name] = p; });
              return (
                <div style={M.group}>
                  <div style={M.eyebrow}>Player OUT (from lineup)</div>
                  <select
                    value={playerOut?.name || ''}
                    onChange={e => {
                      const name = e.target.value;
                      setPlayerOut(name ? { name } : null);
                    }}
                    style={M.select}
                  >
                    <option value="">— select player —</option>
                    {lineup.sort((a, b) => a.localeCompare(b)).map(name => (
                      <option key={name} value={name}>{name}{rosterMap[name]?.limited ? ' ⭐' : ''}</option>
                    ))}
                  </select>
                </div>
              );
            }

            // FA / Waiver: search this team's roster. Substring filter,
            // then alphabetical — the roster is small (≤13) so we don't
            // need the prefix+rank weighting used for the free-agent pool;
            // a stable name order is enough. Use the EFFECTIVE roster (processed
            // adds/drops replayed) so a ghost left in the stored array isn't
            // offered as droppable and a processed pickup isn't missing.
            const pool = effectiveRoster(teamObj, transactions);
            const filtered = pool
              .filter(p => (p.name || p).toLowerCase().includes(searchOut.toLowerCase()))
              .sort((a, b) => (a.name || a).localeCompare(b.name || b));
            return (
              <div style={M.group}>
                <div style={M.eyebrow}>Player Dropped</div>
                {playerOut ? (
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '10px 12px',
                    borderRadius: 6,
                    background: 'rgba(220,80,80,0.06)',
                    border: '1px solid rgba(220,80,80,0.3)',
                  }}>
                    <span style={{
                      fontFamily: fonts.sans,
                      fontSize: 13,
                      fontWeight: 500,
                      color: colors.danger,
                    }}>
                      {playerOut.name}
                    </span>
                    <button
                      onClick={() => { setPlayerOut(null); setSearchOut(''); }}
                      style={{
                        background: 'rgba(220,80,80,0.08)',
                        border: '1px solid rgba(220,80,80,0.3)',
                        borderRadius: 6,
                        width: 24,
                        height: 24,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        color: 'rgba(230,90,90,0.8)',
                        fontSize: 12,
                        lineHeight: 1,
                      }}
                      aria-label="Clear selection"
                    >
                      ✕
                    </button>
                  </div>
                ) : (
                  <>
                    <input
                      type="text"
                      placeholder="Search roster…"
                      value={searchOut}
                      onChange={e => setSearchOut(e.target.value)}
                      style={M.input}
                    />
                    {searchOut.length > 0 && (
                      <div style={{
                        maxHeight: 200,
                        overflowY: 'auto',
                        border: `1px solid ${colors.borderSubtle}`,
                        borderRadius: 6,
                        background: 'rgba(255,255,255,0.02)',
                        marginTop: 4,
                      }}>
                        {filtered.slice(0, 20).map(p => {
                          const name = p.name || p;
                          return (
                            <div
                              key={name}
                              onClick={() => { setPlayerOut({ name }); setSearchOut(''); }}
                              style={{
                                padding: '10px 12px',
                                cursor: 'pointer',
                                borderBottom: `1px solid ${colors.borderSubtle}`,
                                display: 'flex',
                                alignItems: 'center',
                                gap: 8,
                                transition: 'background 0.12s',
                              }}
                              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; }}
                              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                            >
                              <span style={{
                                fontFamily: fonts.sans,
                                fontSize: 13,
                                fontWeight: 500,
                                color: colors.textPrimary,
                              }}>
                                {name}
                              </span>
                            </div>
                          );
                        })}
                        {filtered.length === 0 && (
                          <div style={{
                            padding: '12px',
                            fontFamily: fonts.sans,
                            fontSize: 11,
                            color: colors.textMuted,
                            textAlign: 'center',
                          }}>
                            No players found
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })()}
        </div>

        {/* ── Footer (sticky) ── */}
        <div style={{
          padding: '12px 18px',
          borderTop: `1px solid ${colors.borderSubtle}`,
          background: 'rgba(255,255,255,0.02)',
          flexShrink: 0,
        }}>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="modal-feel-lift modal-feel-primary"
            style={{ ...M.btnPrimary, ...disabledBtn(!canSubmit) }}
          >
            {saving ? 'Saving…' : 'Add Transaction'}
          </button>
        </div>

      </div>
    </div>
  );
};
