// src/pages/KeeperTagModal.jsx
// ============================================================================
// Keeper tagging — one limited player, one unlimited player, before the draft.
//
// The rules this screen makes visible (all of them live in api/_draft.js; none
// are re-implemented here):
//
//   • a limited player may be kept for three seasons, and the star badges
//     beside his name ARE those seasons, so three stars means the slot is
//     closed to him;
//   • an unlimited player may be kept in the unlimited slot as he is, or
//     PROMOTED into the limited slot — in which case he collects a retroactive
//     star for the season he spent unlimited on top of the one he earns for
//     the season ahead, and arrives on two.
//
// The second is the rule managers get wrong, so it is spelled out on the row
// rather than left to be discovered on rollover day: a promoted player's row
// says what he will cost him in keeper seasons before the tag is saved.
//
// Tags are stored on the team document (`team.keepers`) rather than in the
// draft state, for two reasons: a manager can write their own team document
// and cannot write draft_state (see firestore.rules), and the tags then ride
// the team subscription that is already live instead of needing a third one.
// ============================================================================

import { useState, useEffect, useMemo } from 'react';
import { BottomSheet } from '../components/BottomSheet';
import { useDialog } from './DialogContext';
import { theme, colors, fonts, fontSize, steel, white, green } from '../theme.js';
import { activatable } from '../utils/a11y';
import { KEEPER_SLOTS, keeperStatus, effectiveStars } from '../../api/_draft.js';

const SLOT_LABEL = { limited: 'Limited keeper', unlimited: 'Unlimited keeper' };
const SLOT_HINT = {
  limited:   'Yellow. Capped starts, and a star for every season kept.',
  unlimited: 'Blue. No start cap, no stars.',
};
const slotColor = (slot) => (slot === 'limited' ? colors.textGold : steel(0.9));

// ── One player row ──────────────────────────────────────────────────────────
// Not a <button>: the row carries its own nested controls in other screens and
// the app's shared answer to "clickable non-button" is activatable(), so this
// matches the roster rows it sits next to rather than inventing a second
// pattern.
const PlayerRow = ({ player, slot, selected, onSelect }) => {
  const status = keeperStatus(player);
  const slotStatus = status[slot];
  const eligible = slotStatus.eligible;
  const stars = effectiveStars(player);

  return (
    <div
      {...activatable(eligible && onSelect ? () => onSelect(selected ? null : player.name) : undefined, {
        disabled: !eligible,
        selected,
        label: `${player.name}${eligible ? '' : ' — not eligible'}`,
      })}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '9px 10px',
        borderRadius: 4,
        marginBottom: 4,
        cursor: eligible ? 'pointer' : 'default',
        opacity: eligible ? 1 : 0.45,
        background: selected ? green(0.12) : white(0.03),
        border: `1px solid ${selected ? green(0.45) : colors.borderSubtle}`,
        transition: 'background 0.15s, border-color 0.15s',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontFamily: fonts.sans, fontSize: fontSize.md, fontWeight: 600,
          color: player.limited ? colors.textGold : steel(0.9),
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {player.name}
          {player.limited && stars > 0 && (
            <span style={{ marginLeft: 6, fontSize: fontSize.badge, letterSpacing: 1 }}>
              {'⭐'.repeat(stars)}
            </span>
          )}
        </div>
        <div style={{ fontFamily: fonts.sans, fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1 }}>
          {!eligible
            ? slotStatus.reason
            : slot === 'limited'
              // The promotion cost, stated before the tag is saved rather than
              // discovered a season later when he runs out of keeper years.
              ? slotStatus.promotion
                ? `Promoted to limited → ${slotStatus.starsIfKept} stars (one retroactive for his unlimited season)`
                : `→ ${slotStatus.starsIfKept} of ${status.maxStars} stars`
              : `Year ${(Number(player.yearsOfService) || 0) + 1} · no start cap`}
        </div>
      </div>
      <div style={{
        width: 20, height: 20, borderRadius: '50%', flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: selected ? green(0.9) : 'transparent',
        border: `1px solid ${selected ? green(0.9) : white(0.18)}`,
        color: '#fff', fontSize: fontSize.xs, fontWeight: 900, lineHeight: 1,
      }}>
        {selected ? '✓' : ''}
      </div>
    </div>
  );
};

export const KeeperTagModal = ({
  isOpen, onClose, team, roster = [], season, onSave, readOnly = false,
}) => {
  const dialog = useDialog();
  const [picks, setPicks] = useState({ limited: null, unlimited: null });
  const [saving, setSaving] = useState(false);

  // Re-seed from the team every time the sheet opens. Holding the previous
  // team's selections across an open would let a commissioner tagging two
  // teams in a row save the first team's keepers onto the second.
  useEffect(() => {
    if (!isOpen) return;
    setPicks({
      limited:   team?.keepers?.limited   || null,
      unlimited: team?.keepers?.unlimited || null,
    });
  }, [isOpen, team?.id, team?.keepers?.limited, team?.keepers?.unlimited]);

  // A tag in one slot removes the player from the other slot's list. The rule
  // is enforced in rolloverRoster too — this is the half that stops a manager
  // reaching the error at all.
  const candidates = useMemo(() => {
    const out = { limited: [], unlimited: [] };
    KEEPER_SLOTS.forEach(slot => {
      const other = slot === 'limited' ? picks.unlimited : picks.limited;
      out[slot] = (roster || [])
        .filter(p => p?.name && p.name !== other)
        .filter(p => keeperStatus(p)[slot].eligible || p.name === picks[slot])
        .sort((a, b) => a.name.localeCompare(b.name));
    });
    return out;
  }, [roster, picks]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave({
        limited:   picks.limited   || null,
        unlimited: picks.unlimited || null,
      });
      dialog.showToast('✓ Keepers tagged', 'success');
      onClose();
    } catch (err) {
      dialog.showToast('Error: ' + err.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen || !team) return null;

  const tagged = KEEPER_SLOTS.filter(s => picks[s]).length;

  return (
    <BottomSheet
      isOpen={isOpen}
      onClose={onClose}
      variant="panel"
      accent={colors.textGold}
      label={`Keeper tags for ${team.name}`}
    >
      <div style={{ padding: '16px 16px 20px', overflowY: 'auto' }}>
        <div style={{ ...theme.sectionTitle, color: colors.textGold, marginBottom: 2 }}>
          {season} Keepers
        </div>
        <div style={{ fontFamily: fonts.sans, fontSize: fontSize.sm, color: colors.textMuted, marginBottom: 14 }}>
          {team.name} · one limited, one unlimited. Everyone you do not tag goes back
          into the pool for the draft.
        </div>

        {KEEPER_SLOTS.map(slot => (
          <div key={slot} style={{ marginBottom: 18 }}>
            <div style={{
              display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
              marginBottom: 6,
            }}>
              <span style={{
                fontFamily: fonts.sans, fontSize: fontSize.xs, fontWeight: 700,
                letterSpacing: '1.6px', textTransform: 'uppercase',
                color: slotColor(slot),
              }}>
                {SLOT_LABEL[slot]}
              </span>
              <span style={{ fontFamily: fonts.sans, fontSize: fontSize.xs, color: colors.textMuted }}>
                {picks[slot] || 'none tagged'}
              </span>
            </div>
            <div style={{
              fontFamily: fonts.sans, fontSize: fontSize.xs,
              color: colors.textMuted, marginBottom: 6,
            }}>
              {SLOT_HINT[slot]}
            </div>
            {candidates[slot].length === 0 ? (
              <div style={theme.emptyState}>
                Nobody on this roster is eligible for the {slot} slot.
              </div>
            ) : candidates[slot].map(p => (
              <PlayerRow
                key={p.name}
                player={p}
                slot={slot}
                selected={picks[slot] === p.name}
                onSelect={readOnly ? undefined : (name) => setPicks(prev => ({ ...prev, [slot]: name }))}
              />
            ))}
          </div>
        ))}

        {tagged < KEEPER_SLOTS.length && (
          // A warning, not a block. A manager may genuinely have nobody worth
          // keeping in a slot, and the roster they carry into the season is
          // simply one shorter — the draft runs a fixed number of rounds for
          // everybody and cannot hand back the difference.
          <div style={{
            padding: '9px 12px', borderRadius: 4, marginBottom: 14,
            background: colors.warningBg, border: `1px solid ${colors.warningBorder}`,
            fontFamily: fonts.sans, fontSize: fontSize.sm, color: colors.warning,
          }}>
            {tagged === 0 ? 'No keepers tagged' : 'One slot left empty'} — an untagged slot is
            not redrafted for you. You will start the season a player short.
          </div>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={onClose}
            style={{ ...theme.btnSecondary, flex: 1 }}
          >
            {readOnly ? 'Close' : 'Cancel'}
          </button>
          {!readOnly && (
            <button
              onClick={handleSave}
              disabled={saving}
              style={{
                ...theme.btnPrimary, flex: 2,
                opacity: saving ? 0.5 : 1,
                cursor: saving ? 'default' : 'pointer',
              }}
            >
              {saving ? 'Saving…' : 'Save keepers'}
            </button>
          )}
        </div>
      </div>
    </BottomSheet>
  );
};

export default KeeperTagModal;
