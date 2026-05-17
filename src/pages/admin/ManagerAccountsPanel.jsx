// src/pages/admin/ManagerAccountsPanel.jsx
// ============================================================================
// Manager login credentials + email addresses. Two related sections kept
// together because they're conceptually one "manager accounts" subject.
//
// Wave J Round 6 follow-up: restyled to modal-feel — flat layout, eyebrow
// headings, lighter inputs and buttons. Functional behavior unchanged.
// ============================================================================

import React from 'react';
import { useDialog } from '../DialogContext';
import { colors, fonts } from '../../theme.js';
import { managerAuthApi } from '../../api/firebase';
import { M, disabledBtn } from './adminStyles';

export const ManagerAccountsPanel = ({ teams, settings, setSettings }) => {
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
    </div>
  );
};
