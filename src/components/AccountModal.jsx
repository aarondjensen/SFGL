// src/components/AccountModal.jsx
// ============================================================================
// Account panel (opened from the More menu). Three things:
//   • Team name — manager-editable; saving cascades app-wide via updateTeam
//     (the realtime teams subscription repaints standings/rosters/dropdowns).
//   • Sign-in methods — link Google + Apple so either button resolves to the
//     same Firebase uid / team (see authApi linkAppleAccount/linkGoogleAccount).
//   • Sign out — guarded by a confirmation dialog.
// Notifications live in their own modal (UserSettingsModal); this one is
// identity/team/session only.
// ============================================================================

import React, { useState, useEffect, useMemo } from 'react';
import { X, LogOut } from 'lucide-react';
import { useDialog } from '../pages/DialogContext';
import { colors, fonts } from '../theme.js';
import { useModalBehavior } from '../utils/modalUtils';
import { linkAppleAccount, linkGoogleAccount, getLinkedProviders } from '../api/authApi';

export const AccountModal = ({
  isOpen,
  onClose,
  onLogout,
  loggedInUser,
  loggedInTeamId,
  teams,
  updateTeam,
}) => {
  const dialog = useDialog();
  useModalBehavior(isOpen, onClose);

  const userTeam = useMemo(
    () =>
      (loggedInTeamId && teams.find(t => t.id === loggedInTeamId)) ||
      teams.find(t => t.owner === loggedInUser) ||
      null,
    [teams, loggedInTeamId, loggedInUser]
  );

  // ── Team name editing ───────────────────────────────────────────────────
  const [nameDraft, setNameDraft] = useState('');
  const [savingName, setSavingName] = useState(false);
  useEffect(() => {
    if (isOpen) setNameDraft(userTeam?.name || '');
  }, [isOpen, userTeam]);

  const trimmedName = nameDraft.trim();
  const nameChanged = !!userTeam && !!trimmedName && trimmedName !== userTeam.name;

  const handleSaveName = async () => {
    if (!userTeam || !nameChanged || savingName) return;
    setSavingName(true);
    try {
      // Per-doc write: only this team's doc is touched, so a concurrent edit
      // to another team can't be reverted by our copy of it. The teams
      // subscription repaints the rest of the app.
      await updateTeam(userTeam.id, { name: trimmedName });
      dialog.showToast('\u2713 Team name updated', 'success');
    } catch (e) {
      dialog.showToast('Could not update team name: ' + (e?.message || 'error'), 'error');
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

  if (!isOpen) return null;
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;

  const labelStyle = {
    fontSize: 12, fontWeight: 700, color: colors.textMuted,
    letterSpacing: '0.4px', marginBottom: 8, textTransform: 'uppercase',
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(4,9,22,0.86)',
        backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: isMobile ? 'flex-end' : 'center',
        justifyContent: 'center',
        padding: isMobile ? 0 : 16,
        zIndex: 60,
        animation: 'sfglSheetFade 0.2s ease',
      }}
    >
      <style>{`@keyframes sfglSheetFade{from{opacity:0}to{opacity:1}}@keyframes sfglSheetUp{from{transform:translateY(26px);opacity:0}to{transform:translateY(0);opacity:1}}`}</style>
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'linear-gradient(180deg, #14233f 0%, #0f1b31 100%)',
          border: '1px solid rgba(255,255,255,0.07)',
          borderRadius: isMobile ? '22px 22px 0 0' : 18,
          width: '100%', maxWidth: isMobile ? '100%' : 440,
          maxHeight: isMobile ? '92vh' : '84vh',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 -8px 40px rgba(0,0,0,0.5)',
          paddingBottom: isMobile ? 'env(safe-area-inset-bottom)' : 0,
          animation: 'sfglSheetUp 0.3s cubic-bezier(0.32,0.72,0,1)',
        }}
      >
        {isMobile && (
          <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 8, flexShrink: 0 }}>
            <div style={{ width: 40, height: 5, borderRadius: 3, background: 'rgba(255,255,255,0.18)' }} />
          </div>
        )}

        <div style={{
          padding: isMobile ? '10px 20px 10px' : '16px 20px 12px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 12, flexShrink: 0,
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{
              fontFamily: fonts.sans, fontSize: 18, fontWeight: 600,
              color: colors.textPrimary, letterSpacing: '0.2px',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              {loggedInUser || 'Account'}
            </div>
            {userTeam && (
              <div style={{ fontFamily: fonts.sans, fontSize: 13, color: colors.textMuted, marginTop: 2 }}>
                {userTeam.name}
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              flexShrink: 0, width: 34, height: 34, borderRadius: '50%',
              background: 'rgba(255,255,255,0.06)', border: 'none', cursor: 'pointer',
              color: colors.textSecondary,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <X style={{ width: 18, height: 18 }} />
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '4px 20px 20px', WebkitOverflowScrolling: 'touch' }}>

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
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  color: colors.textPrimary,
                  fontFamily: fonts.sans, fontSize: 15, fontWeight: 600,
                  outline: 'none',
                }}
              />
              <button
                onClick={handleSaveName}
                disabled={!nameChanged || savingName}
                style={{
                  marginTop: 8, padding: '9px 16px', borderRadius: 10,
                  background: nameChanged ? 'rgba(245,197,24,0.16)' : 'rgba(255,255,255,0.05)',
                  border: `1px solid ${nameChanged ? 'rgba(245,197,24,0.40)' : 'rgba(255,255,255,0.10)'}`,
                  color: nameChanged ? '#f5d97a' : colors.textMuted,
                  fontFamily: fonts.sans, fontSize: 14, fontWeight: 600,
                  cursor: nameChanged && !savingName ? 'pointer' : 'default',
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
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: 12,
                    marginTop: idx === 0 ? 0 : 8,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0, fontSize: 14.5, fontWeight: 600, color: colors.textPrimary }}>{p.label}</div>
                  {isLinked ? (
                    <span style={{ fontSize: 13, fontWeight: 600, color: colors.earningsGreen }}>Linked</span>
                  ) : (
                    <button
                      onClick={() => handleLink(p.id)}
                      disabled={!!linkBusy}
                      style={{
                        padding: '7px 14px', borderRadius: 9,
                        background: 'rgba(255,255,255,0.10)',
                        border: '1px solid rgba(255,255,255,0.16)',
                        color: colors.textPrimary,
                        fontFamily: fonts.sans, fontSize: 13, fontWeight: 600,
                        cursor: linkBusy ? 'default' : 'pointer', opacity: linkBusy ? 0.6 : 1,
                      }}
                    >
                      {busy ? 'Linking\u2026' : 'Link'}
                    </button>
                  )}
                </div>
              );
            })}
            <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 8, lineHeight: 1.4 }}>
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
              border: '1px solid rgba(220,90,90,0.28)',
              borderRadius: 14,
              color: 'rgba(240,140,140,0.95)',
              fontFamily: fonts.sans, fontSize: 14.5, fontWeight: 600, letterSpacing: '0.2px',
              cursor: 'pointer', transition: 'background 0.18s',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(200,70,70,0.18)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(200,70,70,0.10)'; }}
          >
            <LogOut style={{ width: 17, height: 17 }} />
            Sign out
          </button>

        </div>
      </div>
    </div>
  );
};

export default AccountModal;
