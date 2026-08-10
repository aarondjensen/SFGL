// src/components/AccountModal.jsx
// ============================================================================
// Account panel (opened from the More menu). Three things:
//   • Team name — manager-editable; saving goes through teamsApi.rename,
//     which also re-keys the team's transactions (they reference the team by
//     NAME). The realtime teams subscription repaints the rest of the app.
//   • Sign-in methods — link Google + Apple so either button resolves to the
//     same Firebase uid / team (see authApi linkAppleAccount/linkGoogleAccount).
//   • Sign out — guarded by a confirmation dialog.
// Notifications live in their own modal (UserSettingsModal); this one is
// identity/team/session only.
// ============================================================================

import { useState, useEffect } from 'react';
import { LogOut } from 'lucide-react';
import { useDialog } from '../pages/DialogContext';
import { colors, fonts, gold, white, red, fontSize } from '../theme.js';
import { BottomSheet, SheetBody } from './BottomSheet';
import { useUserTeam } from '../hooks/useUserTeam';
import { linkAppleAccount, linkGoogleAccount, getLinkedProviders } from '../api/authApi';
import { teamsApi } from '../api/firebase';
import { getTeamAbbreviation } from '../utils';

export const AccountModal = ({
  isOpen,
  onClose,
  onLogout,
  loggedInUser,
  loggedInTeamId,
  teams,
}) => {
  const dialog = useDialog();
  // Scroll lock + Escape now come from BottomSheet.
  const userTeam = useUserTeam(teams, loggedInTeamId);

  // ── Team name editing ───────────────────────────────────────────────────
  const [nameDraft, setNameDraft] = useState('');
  const [savingName, setSavingName] = useState(false);
  useEffect(() => {
    if (isOpen) {
      setNameDraft(userTeam?.name || '');
      // Seeded from the stored value only. Showing the FALLBACK here would make
      // an unset abbreviation look set, and saving it would freeze today's
      // auto-initials onto the document.
      setAbbrDraft(userTeam?.abbr || '');
    }
  }, [isOpen, userTeam]);

  // Abbreviation, saved alongside the name. It lives on the team document
  // rather than in a lookup table keyed by name — a table like that loses the
  // curated abbreviation the moment a team renames, and silently falls back to
  // initials of the new name.
  const [abbrDraft, setAbbrDraft] = useState('');

  const trimmedName = nameDraft.trim();
  const trimmedAbbr = abbrDraft.trim();
  const nameChanged = !!userTeam && !!trimmedName && trimmedName !== userTeam.name;
  // Blank clears it, which is a real change if one was set — so compare against
  // the stored value rather than testing for emptiness.
  const abbrChanged = !!userTeam && trimmedAbbr !== (userTeam.abbr || '');
  const canSave = nameChanged || abbrChanged;

  const handleSaveName = async () => {
    if (!userTeam || !canSave || savingName) return;
    setSavingName(true);
    try {
      // Goes through teamsApi.rename, NOT a plain team-doc write.
      //
      // Transactions identify their team by name (tx.team), so writing the new
      // name onto the team alone \u2014 which is what this used to do \u2014 cut the team
      // loose from its entire history: roster replay stopped applying its
      // add/drops, its fees dropped out of the swing pot, and its pending
      // waiver claims disappeared from both the Rosters page and the commish's
      // waiver panel. Silently, and only for the team that renamed.
      //
      // rename() re-keys those rows in the same operation and rejects a name
      // already taken by another team. The realtime teams subscription repaints
      // the app once it lands.
      let transactionsUpdated = 0;
      if (nameChanged) {
        ({ transactionsUpdated } = await teamsApi.rename(userTeam.id, trimmedName));
      }
      // The abbreviation is an ordinary field patch — it is display-only and
      // nothing keys off it, so it does not need rename()'s transaction
      // re-keying. Sent second so a failed rename doesn't leave the two out of
      // step. undefined clears the field (teamsApi.update maps it to
      // deleteField), which is what an emptied input should mean.
      if (abbrChanged) {
        await teamsApi.update(userTeam.id, { abbr: trimmedAbbr || undefined });
      }
      dialog.showToast(
        transactionsUpdated > 0
          ? `\u2713 Team renamed \u00b7 ${transactionsUpdated} transaction${transactionsUpdated === 1 ? '' : 's'} updated`
          : nameChanged ? '\u2713 Team name updated' : '\u2713 Abbreviation updated',
        'success'
      );
    } catch (e) {
      dialog.showToast('Could not save changes: ' + (e?.message || 'error'), 'error');
    } finally {
      setSavingName(false);
    }
  };

  // ── Sign-in methods (link Google + Apple) ───────────────────────────────
  const [linked, setLinked] = useState(() => getLinkedProviders());
  const [linkBusy, setLinkBusy] = useState(null);
  useEffect(() => { if (isOpen) setLinked(getLinkedProviders()); }, [isOpen]);

  const handleLink = async (provider) => {
    if (linkBusy) return;
    setLinkBusy(provider);
    try {
      if (provider === 'apple') await linkAppleAccount();
      else await linkGoogleAccount();
      setLinked(getLinkedProviders());
      dialog.showToast(`\u2713 ${provider === 'apple' ? 'Apple' : 'Google'} account linked`, 'success');
    } catch (e) {
      dialog.showToast(e?.message || 'Could not link account', 'error');
    } finally {
      setLinkBusy(null);
    }
  };

  // ── Sign out (confirmed) ────────────────────────────────────────────────
  const handleSignOut = async () => {
    const ok = await dialog.showConfirm(
      'Sign out?',
      'You will need to sign in again with Google or Apple to get back in.',
      { type: 'danger', confirmText: 'Sign out', cancelText: 'Cancel' }
    );
    if (ok) { onClose(); onLogout(); }
  };

  const labelStyle = {
    fontSize: fontSize.sm, fontWeight: 700, color: colors.textMuted,
    letterSpacing: '0.4px', marginBottom: 8, textTransform: 'uppercase',
  };

  return (
    <BottomSheet
      isOpen={isOpen}
      onClose={onClose}
      variant="sheet"
      title={loggedInUser || 'Account'}
      subtitle={userTeam?.name}
    >
      <SheetBody>

          {/* Team name — manager-editable, cascades app-wide on save. */}
          {userTeam && (
            <div style={{ marginBottom: 18 }}>
              <div style={labelStyle}>Team name</div>
              <input
                type="text"
                value={nameDraft}
                onChange={e => setNameDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleSaveName(); }}
                maxLength={40}
                placeholder="Team name"
                style={{
                  width: '100%', boxSizing: 'border-box',
                  padding: '12px 14px', borderRadius: 12,
                  background: white(0.05),
                  border: `1px solid ${white(0.12)}`,
                  color: colors.textPrimary,
                  fontFamily: fonts.sans, fontSize: 15, fontWeight: 600,
                }}
              />
              <div style={{ ...labelStyle, marginTop: 14 }}>Short name</div>
              <input
                type="text"
                value={abbrDraft}
                onChange={e => setAbbrDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleSaveName(); }}
                maxLength={5}
                placeholder={getTeamAbbreviation(userTeam)}
                style={{
                  width: 120, boxSizing: 'border-box',
                  padding: '12px 14px', borderRadius: 12,
                  background: white(0.05),
                  border: `1px solid ${white(0.12)}`,
                  color: colors.textPrimary,
                  fontFamily: fonts.sans, fontSize: 15, fontWeight: 600,
                }}
              />
              <div style={{
                fontFamily: fonts.sans, fontSize: fontSize.sm, color: colors.textMuted,
                marginTop: 6, lineHeight: 1.4,
              }}>
                Used where the full name will not fit. Leave blank to derive it
                from your team name.
              </div>
              <button
                onClick={handleSaveName}
                disabled={!canSave || savingName}
                style={{
                  marginTop: 10, padding: '9px 16px', borderRadius: 10,
                  background: canSave ? gold(0.16) : white(0.05),
                  border: `1px solid ${canSave ? gold(0.40) : white(0.10)}`,
                  color: canSave ? '#f5d97a' : colors.textMuted,
                  fontFamily: fonts.sans, fontSize: fontSize.md, fontWeight: 600,
                  cursor: canSave && !savingName ? 'pointer' : 'default',
                }}
              >
                {savingName ? 'Saving\u2026' : 'Save'}
              </button>
            </div>
          )}

          {/* Sign-in methods — link Google + Apple to one login (one team). */}
          <div style={{ marginBottom: 18 }}>
            <div style={labelStyle}>Sign-in methods</div>
            {[{ id: 'google', label: 'Google' }, { id: 'apple', label: 'Apple' }].map((p, idx) => {
              const isLinked = linked[p.id];
              const busy = linkBusy === p.id;
              return (
                <div
                  key={p.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '12px 14px',
                    background: white(0.04),
                    border: `1px solid ${white(0.08)}`,
                    borderRadius: 12,
                    marginTop: idx === 0 ? 0 : 8,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0, fontSize: fontSize.md, fontWeight: 600, color: colors.textPrimary }}>{p.label}</div>
                  {isLinked ? (
                    <span style={{ fontSize: fontSize.base, fontWeight: 600, color: colors.earningsGreen }}>Linked</span>
                  ) : (
                    <button
                      onClick={() => handleLink(p.id)}
                      disabled={!!linkBusy}
                      style={{
                        padding: '7px 14px', borderRadius: 9,
                        background: white(0.10),
                        border: `1px solid ${white(0.16)}`,
                        color: colors.textPrimary,
                        fontFamily: fonts.sans, fontSize: fontSize.base, fontWeight: 600,
                        cursor: linkBusy ? 'default' : 'pointer', opacity: linkBusy ? 0.6 : 1,
                      }}
                    >
                      {busy ? 'Linking\u2026' : 'Link'}
                    </button>
                  )}
                </div>
              );
            })}
            <div style={{ fontSize: fontSize.sm, color: colors.textMuted, marginTop: 8, lineHeight: 1.4 }}>
              Link both so either button signs you into the same team.
            </div>
          </div>

          {/* Sign out (confirmed) */}
          <button
            onClick={handleSignOut}
            aria-label="Sign out"
            style={{
              width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              padding: '14px', minHeight: 50,
              background: 'rgba(200,70,70,0.10)',
              border: `1px solid ${red(0.28)}`,
              borderRadius: 14,
              color: 'rgba(240,140,140,0.95)',
              fontFamily: fonts.sans, fontSize: fontSize.md, fontWeight: 600, letterSpacing: '0.2px',
              cursor: 'pointer', transition: 'background 0.18s',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(200,70,70,0.18)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(200,70,70,0.10)'; }}
          >
            <LogOut style={{ width: 17, height: 17 }} />
            Sign out
          </button>

      </SheetBody>
    </BottomSheet>
  );
};

export default AccountModal;
