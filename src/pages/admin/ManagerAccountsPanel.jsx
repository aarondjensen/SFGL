// src/pages/admin/ManagerAccountsPanel.jsx
// ============================================================================
// All things "manager accounts" in one panel:
//   1. Login credentials — set a manager's login name + password
//   2. Manager emails — for waiver/results/lineup notifications
//   3. Commissioner status — tag managers as commissioners (admin access)
//
// The commissioner-tagging section was previously its own admin tile; merged
// in here since it's just another per-manager attribute.
// ============================================================================

import React from 'react';
import { useDialog } from '../DialogContext';
import { colors, fonts } from '../../theme.js';
import { managerAuthApi } from '../../api/firebase';
import { M, disabledBtn } from './adminStyles';

export const ManagerAccountsPanel = ({ teams, settings, setSettings, updateTeams }) => {
  const dialog = useDialog();

  // ── Credentials state ──
  const [mgCredTeam, setMgCredTeam] = React.useState('');
  const [mgCredName, setMgCredName] = React.useState('');
  const [mgCredPass, setMgCredPass] = React.useState('');
  const [mgCredSaving, setMgCredSaving] = React.useState(false);

  // ── Emails state ──
  const [emailDraft, setEmailDraft] = React.useState(null);

  const handleSetLogin = async () => {
    if (!mgCredTeam || !mgCredName || !mgCredPass) return;
    setMgCredSaving(true);
    try {
      await managerAuthApi.setCredentials(mgCredTeam, mgCredName, mgCredPass);
      dialog.showToast('Login set for ' + mgCredName, 'success');
      setMgCredTeam(''); setMgCredName(''); setMgCredPass('');
    } catch (e) {
      dialog.showToast('Failed: ' + e.message, 'error');
    } finally {
      setMgCredSaving(false);
    }
  };

  const handleSaveEmails = async () => {
    if (!emailDraft) return;
    const merged = { ...(settings.managerEmails || {}), ...emailDraft };
    try {
      await setSettings({ ...settings, managerEmails: merged });
      dialog.showToast('✓ Manager emails saved', 'success');
      setEmailDraft(null);
    } catch (err) {
      dialog.showToast('Error: ' + err.message, 'error');
    }
  };

  const credentialsReady = mgCredTeam && mgCredName && mgCredPass;

  return (
    <div style={M.page}>
      {/* ── Credentials ── */}
      <div style={M.group}>
        <div style={M.eyebrow}>🔑 Login Credentials</div>
        <div style={M.descText}>
          Set the login name and password for a manager. They use these to sign in.
        </div>

        <select
          value={mgCredTeam}
          onChange={e => {
            setMgCredTeam(e.target.value);
            setMgCredName(teams.find(x => x.id === e.target.value)?.owner || '');
          }}
          style={M.select}
        >
          <option value="">Select team...</option>
          {teams.map(t => <option key={t.id} value={t.id}>{t.name} — {t.owner}</option>)}
        </select>

        <input
          value={mgCredName}
          onChange={e => setMgCredName(e.target.value)}
          placeholder="Login name"
          style={M.input}
        />
        <input
          type="password"
          value={mgCredPass}
          onChange={e => setMgCredPass(e.target.value)}
          placeholder="Password"
          style={M.input}
        />

        <button
          onClick={handleSetLogin}
          disabled={mgCredSaving || !credentialsReady}
          className="modal-feel-lift modal-feel-primary"
          style={{ ...M.btnPrimary, ...disabledBtn(mgCredSaving || !credentialsReady) }}
        >
          {mgCredSaving ? 'Saving…' : 'Set Login'}
        </button>
      </div>

      {/* ── Emails ── */}
      <div style={M.group}>
        <div style={M.eyebrow}>📧 Manager Emails</div>
        <div style={M.descText}>
          Used for waiver results, tournament results, and lineup reminders.
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {teams.map(t => {
            const currentEmail = (settings.managerEmails || {})[t.id] || '';
            return (
              <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{
                  fontFamily: fonts.sans,
                  fontSize: 12,
                  fontWeight: 600,
                  color: colors.textPrimary,
                  width: 120,
                  flexShrink: 0,
                }}>
                  {t.name}
                </span>
                <input
                  type="email"
                  placeholder="email@example.com"
                  value={emailDraft?.[t.id] ?? currentEmail}
                  onChange={e => setEmailDraft(prev => ({ ...(prev || {}), [t.id]: e.target.value }))}
                  style={{ ...M.input, flex: 1, fontSize: 12, padding: '8px 10px' }}
                />
              </div>
            );
          })}
        </div>

        <button
          onClick={handleSaveEmails}
          disabled={!emailDraft}
          className="modal-feel-lift modal-feel-primary"
          style={{ ...M.btnPrimary, ...disabledBtn(!emailDraft), marginTop: 4 }}
        >
          💾 Save Emails
        </button>
      </div>

      {/* ── Commissioner Status ── */}
      <div style={M.group}>
        <div style={M.eyebrow}>👑 Commissioner Status</div>
        <div style={M.descText}>
          Tag managers as commissioners. Tagged managers see the Commish tab automatically when logged in — no password required.
        </div>

        {/* Toggle pills per team. Same shape as UserSettingsModal's per-event
            toggle pattern — whole row is one button, pill on the right side,
            gold-tinted when on, gray when off. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {teams.map(t => {
            const tagged = !!t.isCommissioner;
            return (
              <button
                key={t.id}
                type="button"
                role="switch"
                aria-checked={tagged}
                aria-label={`${t.name}: ${tagged ? 'is' : 'is not'} a commissioner`}
                onClick={() => {
                  const next = !tagged;
                  const newTeams = teams.map(tt =>
                    tt.id === t.id ? { ...tt, isCommissioner: next } : tt
                  );
                  updateTeams(newTeams);
                  dialog.showToast(
                    next
                      ? `${t.name} is now a commissioner`
                      : `${t.name} is no longer a commissioner`,
                    'success'
                  );
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '10px 12px',
                  background: tagged
                    ? 'rgba(245,197,24,0.06)'
                    : 'rgba(255,255,255,0.02)',
                  border: `1px solid ${tagged
                    ? 'rgba(245,197,24,0.3)'
                    : colors.borderSubtle}`,
                  borderRadius: 6,
                  cursor: 'pointer',
                  transition: 'background 0.15s, border-color 0.15s',
                  textAlign: 'left',
                  width: '100%',
                  fontFamily: fonts.sans,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontFamily: fonts.sans,
                    fontSize: 13,
                    fontWeight: 600,
                    color: colors.textPrimary,
                  }}>
                    {t.name}
                  </div>
                  <div style={{
                    fontFamily: fonts.sans,
                    fontSize: 11,
                    color: colors.textMuted,
                    marginTop: 1,
                  }}>
                    {t.owner}
                  </div>
                </div>
                {/* Toggle pill */}
                <div
                  aria-hidden="true"
                  style={{
                    position: 'relative',
                    width: 36,
                    height: 20,
                    borderRadius: 10,
                    background: tagged
                      ? 'rgba(245,197,24,0.65)'
                      : 'rgba(255,255,255,0.12)',
                    border: `1px solid ${tagged
                      ? 'rgba(245,197,24,0.85)'
                      : 'rgba(255,255,255,0.18)'}`,
                    transition: 'background 0.18s, border-color 0.18s',
                    flexShrink: 0,
                  }}
                >
                  <div style={{
                    position: 'absolute',
                    top: 2,
                    left: 2,
                    width: 14,
                    height: 14,
                    borderRadius: '50%',
                    background: '#fff',
                    boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
                    transform: tagged ? 'translateX(16px)' : 'translateX(0)',
                    transition: 'transform 0.18s ease',
                  }} />
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};
