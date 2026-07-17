// src/pages/admin/TeamLineupsEditor.jsx
// ============================================================================
// TODO(dead-code): currently imported by nothing — kept (not deleted with the
// other orphaned admin panels) because the admin-panel fix task (missing-lineup
// warning) may re-wire it into TournamentResultsPanel. If that task lands
// without adopting this component, delete this file.
// ============================================================================
// Inline editor for the selected tournament's team lineups. Used during both
// manual processing (first time the tournament is scored) and reprocessing
// (correcting an already-completed tournament). Edits flow directly into
// `manualEntry.teamLineups` which both handlers in TournamentResultsPanel
// consume.
//
// Roster pool per team = union of current roster + names already in the
// saved lineup. This preserves edit access to players who were rostered
// during the tournament but have since been dropped — without this, editing
// an old lineup would silently lose any player no longer on the active
// roster.
//
// Lives at module level (not inside a render) so internal state — and the
// dropdown elements — don't remount and lose focus between keystrokes when
// the parent re-renders.
//
// Wave I extraction (Batch 3g, fix-only pass): previously inline in
// AdminView.jsx. Drops the `S` and `dialog` props it took inline — imports
// them directly so callers don't have to prop-drill them.
// ============================================================================

import React, { useState } from 'react';
import { useDialog } from '../DialogContext';
import { colors, fonts } from '../../theme.js';
import { TeamName } from '../../components/TeamName';
import { S } from './adminStyles';
import { isBackupSpotEnabled } from '../../utils/sharedHelpers';

export const TeamLineupsEditor = ({
  teams, manualEntry, setManualEntry, lineupSize, rostersByTeamId, tournament, settings,
}) => {
  const dialog = useDialog();
  const [expanded, setExpanded] = useState(false);
  // Per-team UI state for the promotion picker — when set, shows the
  // "which starter is being replaced?" selector inline within that team's row.
  const [promotingTeamId, setPromotingTeamId] = useState(null);
  // Whether the optional 6th "backup" slot applies to this event. Driven by the
  // commish's per-event-type toggles in Season Settings. Falls back to
  // Majors-only when settings isn't passed in (backward-compatible).
  const allowBackup = isBackupSpotEnabled(tournament, settings);

  const updateTeamLineup = (teamId, slotIndex, playerName) => {
    setManualEntry(prev => {
      const current = prev.teamLineups?.[teamId] || [];
      // Pad to lineupSize so partial lineups don't collapse when editing slot N
      const next = [...current];
      while (next.length < lineupSize) next.push('');
      next[slotIndex] = playerName;
      // Filter out empties for storage, keeping the array compact for downstream code
      const compact = next.filter(n => n);
      return { ...prev, teamLineups: { ...(prev.teamLineups || {}), [teamId]: compact } };
    });
  };

  // Summary stats for the collapsed header — at a glance, the commish should
  // see how many teams are missing or partial lineups before expanding.
  const summary = teams.reduce((acc, t) => {
    const lu = manualEntry.teamLineups?.[t.id] || [];
    if (lu.length === 0) acc.missing++;
    else if (lu.length < lineupSize) acc.partial++;
    else acc.complete++;
    return acc;
  }, { missing: 0, partial: 0, complete: 0 });

  return (
    <div style={{ marginBottom: 14, border: `1px solid ${colors.borderSubtle}`, borderRadius: 4, overflow: 'hidden' }}>
      {/* Header — tap to toggle expanded */}
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        style={{
          width: '100%', padding: '10px 14px',
          background: 'rgba(255,255,255,0.03)',
          border: 'none', borderBottom: expanded ? `1px solid ${colors.borderSubtle}` : 'none',
          cursor: 'pointer', textAlign: 'left',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
          fontFamily: fonts.sans,
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '1.5px', textTransform: 'uppercase', color: colors.textPrimary }}>
          👥 Team Lineups
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 10, color: summary.missing > 0 ? colors.warning : colors.textMuted, letterSpacing: 0.5 }}>
            {summary.complete}/{teams.length} set
            {summary.missing > 0 && <span style={{ marginLeft: 6, color: colors.warning }}>· {summary.missing} missing</span>}
            {summary.partial > 0 && <span style={{ marginLeft: 6, color: colors.textGoldDim }}>· {summary.partial} partial</span>}
          </span>
          <span style={{ fontSize: 12, color: colors.textMuted, transition: 'transform 0.15s', display: 'inline-block', transform: expanded ? 'rotate(90deg)' : 'none' }}>▸</span>
        </span>
      </button>

      {/* Expanded panel — one row per team. Each row's render is wrapped in
          try/catch so a single bad team can't take down the whole editor —
          the broken team shows an inline error and the others render normally. */}
      {expanded && (
        <div style={{ padding: '8px 12px 12px', background: 'rgba(0,0,0,0.12)' }}>
          {teams.map(team => {
            try {
            const lineup = manualEntry.teamLineups?.[team.id] || [];
            // Effective roster — transactions-aware roster snapshot. Falls
            // back to team.roster if the caller didn't supply a precomputed
            // map (defensive).
            const effectiveRoster = (rostersByTeamId?.[team.id] || team.roster || [])
              .filter(p => p && typeof p.name === 'string' && p.name.length > 0);
            const rosterNames = effectiveRoster.map(p => p.name);
            // Roster pool: effective roster + any lineup names that aren't in
            // it, so editing a saved lineup doesn't drop legacy players (e.g.
            // someone rostered for the tournament but dropped after). Filter
            // out anything that isn't a non-empty string so the sort below
            // can't crash on undefined.
            const extras = (lineup || []).filter(n => typeof n === 'string' && n.length > 0 && !rosterNames.includes(n));
            const pool = [...rosterNames, ...extras]
              .filter(n => typeof n === 'string' && n.length > 0)
              // Defensive localeCompare — String() coerces any oddball value
              // that slipped past the filter so the sort can't blow up the
              // entire editor mid-render.
              .sort((a, b) => String(a).localeCompare(String(b)));

            // Track currently-picked names so the same player can't be picked twice
            const picked = new Set((lineup || []).filter(n => typeof n === 'string' && n.length > 0));

            const isComplete = lineup.length === lineupSize;
            const isEmpty = lineup.length === 0;

            return (
              <div key={team.id}
                style={{
                  padding: '8px 10px', marginBottom: 6,
                  background: isEmpty ? 'rgba(200,80,80,0.06)' : isComplete ? 'rgba(80,180,120,0.04)' : 'rgba(220,180,80,0.05)',
                  border: `1px solid ${isEmpty ? 'rgba(200,80,80,0.25)' : isComplete ? 'rgba(80,180,120,0.18)' : 'rgba(220,180,80,0.2)'}`,
                  borderRadius: 3,
                }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
                  <span style={{ fontFamily: fonts.sans, fontSize: 12, fontWeight: 600, color: colors.textPrimary }}>
                    <TeamName name={team.name} />
                  </span>
                  {/* Right cluster: status counter + clear button (when applicable),
                      kept together on a single row so the team card doesn't
                      grow a second row of chrome once a player is picked. */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{
                      fontFamily: fonts.sans, fontSize: 9, letterSpacing: 1, textTransform: 'uppercase',
                      color: isEmpty ? colors.warning : isComplete ? colors.earningsGreen : colors.textGoldDim,
                    }}>
                      {isEmpty ? 'No lineup' : `${lineup.length}/${lineupSize}`}
                    </span>
                    {!isEmpty && (
                      <button
                        type="button"
                        onClick={() => setManualEntry(prev => ({
                          ...prev,
                          teamLineups: { ...(prev.teamLineups || {}), [team.id]: [] },
                        }))}
                        style={{
                          padding: '3px 8px',
                          background: 'transparent', border: `1px solid ${colors.borderSubtle}`,
                          borderRadius: 2, color: colors.textMuted,
                          fontFamily: fonts.sans, fontSize: 9, letterSpacing: 0.5,
                          textTransform: 'uppercase', cursor: 'pointer',
                        }}
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>

                {/* Lineup slot dropdowns — one per lineupSize slot.
                    Slot value pulls from lineup[i]; '' if not set. */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 6 }}>
                  {Array.from({ length: lineupSize }).map((_, slot) => {
                    const currentValue = lineup[slot] || '';
                    return (
                      <select
                        key={slot}
                        value={currentValue}
                        onChange={e => updateTeamLineup(team.id, slot, e.target.value)}
                        style={{ ...S.select, marginBottom: 0, padding: '6px 8px', fontSize: 12 }}
                      >
                        <option value="">— Slot {slot + 1} —</option>
                        {pool.map(name => {
                          // limited flag may live on the effective roster
                          // entry or on team.roster (waiver-added players
                          // don't carry the flag through transactions, so
                          // fall back to team.roster as a secondary lookup)
                          const player = effectiveRoster.find(p => p.name === name)
                            || (team.roster || []).find(p => p.name === name);
                          const limited = player?.limited;
                          const offRoster = !rosterNames.includes(name);
                          // Disable if picked elsewhere in this team's lineup (but not this slot)
                          const pickedElsewhere = picked.has(name) && name !== currentValue;
                          return (
                            <option key={name} value={name} disabled={pickedElsewhere}>
                              {limited ? '★ ' : ''}{name}{offRoster ? ' (dropped)' : ''}{pickedElsewhere ? ' — used' : ''}
                            </option>
                          );
                        })}
                      </select>
                    );
                  })}
                </div>

                {/* ── Backup section (when enabled for this event type) ──────
                    Shows the manager's backup designation. The commish can
                    "Promote" — pick which starter is being replaced and the
                    backup tags into that slot. After promotion, the backup
                    appears as a regular starter in the 5-slot dropdowns above. */}
                {allowBackup && team.backup && (() => {
                  const isAlreadyPromoted = lineup.includes(team.backup);
                  return (
                    <div style={{
                      marginTop: 8, padding: '8px 10px',
                      background: isAlreadyPromoted ? 'rgba(80,180,120,0.06)' : 'rgba(245,197,24,0.06)',
                      border: `1px dashed ${isAlreadyPromoted ? 'rgba(80,180,120,0.3)' : 'rgba(245,197,24,0.4)'}`,
                      borderRadius: 3,
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontFamily: fonts.sans, fontSize: 11, color: colors.textSecondary }}>
                          <span style={{ fontWeight: 700, color: isAlreadyPromoted ? colors.earningsGreen : colors.textGold, letterSpacing: 0.5 }}>
                            {isAlreadyPromoted ? '✓ PROMOTED' : 'BACKUP'}:
                          </span>{' '}
                          <span style={{ fontWeight: 600, color: colors.textPrimary }}>{team.backup}</span>
                        </span>
                        {!isAlreadyPromoted && lineup.length > 0 && promotingTeamId !== team.id && (
                          <button
                            type="button"
                            onClick={() => setPromotingTeamId(team.id)}
                            style={{
                              padding: '4px 10px',
                              background: 'rgba(245,197,24,0.15)',
                              border: '1px solid rgba(245,197,24,0.4)',
                              borderRadius: 2, color: colors.textGold,
                              fontFamily: fonts.sans, fontSize: 10, fontWeight: 600,
                              letterSpacing: 0.5, textTransform: 'uppercase', cursor: 'pointer',
                            }}
                          >
                            ↑ Promote
                          </button>
                        )}
                        {promotingTeamId === team.id && (
                          <button
                            type="button"
                            onClick={() => setPromotingTeamId(null)}
                            style={{
                              padding: '4px 10px',
                              background: 'transparent', border: `1px solid ${colors.borderSubtle}`,
                              borderRadius: 2, color: colors.textMuted,
                              fontFamily: fonts.sans, fontSize: 10, letterSpacing: 0.5,
                              textTransform: 'uppercase', cursor: 'pointer',
                            }}
                          >
                            Cancel
                          </button>
                        )}
                      </div>
                      {/* Promotion picker — appears when commish clicks Promote.
                          Shows the 5 current starters as buttons; tap one to
                          replace them with the backup. */}
                      {promotingTeamId === team.id && !isAlreadyPromoted && (
                        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed rgba(245,197,24,0.25)' }}>
                          <div style={{ fontFamily: fonts.sans, fontSize: 10, color: colors.textMuted, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 6 }}>
                            Which starter is being replaced?
                          </div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            {lineup.map((starterName, slotIdx) => (
                              <button
                                key={`${starterName}-${slotIdx}`}
                                type="button"
                                onClick={() => {
                                  // Swap in: place team.backup in the slot
                                  // currently held by starterName.
                                  updateTeamLineup(team.id, slotIdx, team.backup);
                                  setPromotingTeamId(null);
                                  if (dialog?.showToast) {
                                    dialog.showToast(`Promoted ${team.backup} → replaced ${starterName}`, 'success');
                                  }
                                }}
                                style={{
                                  padding: '6px 10px',
                                  background: 'rgba(255,255,255,0.04)',
                                  border: '1px solid rgba(200,80,80,0.4)',
                                  borderRadius: 2, color: colors.textPrimary,
                                  fontFamily: fonts.sans, fontSize: 11,
                                  cursor: 'pointer',
                                }}
                              >
                                ✕ {starterName}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            );
            } catch (rowErr) {
              // One team's row crashed — log, render a placeholder, and let
              // the other rows continue. Without this catch a single bad
              // team object would blank the entire editor.
              console.error('[TeamLineupsEditor] row crashed for', team?.name, rowErr);
              return (
                <div key={team?.id || Math.random()} style={{
                  padding: '10px 14px', marginBottom: 6,
                  background: 'rgba(200,80,80,0.08)',
                  border: '1px solid rgba(200,80,80,0.35)',
                  borderRadius: 3,
                  fontFamily: fonts.sans, fontSize: 11, color: 'rgba(220,140,140,0.9)',
                }}>
                  ⚠ Couldn't render {team?.name || 'this team'} — see console for details
                </div>
              );
            }
          })}
        </div>
      )}
    </div>
  );
};
