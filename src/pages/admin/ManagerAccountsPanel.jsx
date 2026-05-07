// src/pages/admin/ManagerAccountsPanel.jsx
// ============================================================================
// Manager login credentials + email addresses. Two related sections kept
// together because they're conceptually one "manager accounts" subject.
// Wave I extraction from AdminView.
// ============================================================================

import React from 'react';
import { useDialog } from '../DialogContext';
import { theme, colors, fonts } from '../../theme.js';
import { managerAuthApi } from '../../api/firebase';
import { S, disabledBtn } from './adminStyles';

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

  return (
    <>
      {/* ── Credentials ── */}
      <div style={S.section}>
        <div style={S.title}>🔑 Manager Login Credentials</div>
        <label style={S.lbl}>Team</label>
        <select
          value={mgCredTeam}
          onChange={e => {
            setMgCredTeam(e.target.value);
            setMgCredName(teams.find(x => x.id === e.target.value)?.owner || '');
          }}
          style={S.select}
        >
          <option value="">Select team...</option>
          {teams.map(t => <option key={t.id} value={t.id}>{t.name} — {t.owner}</option>)}
        </select>
        <input value={mgCredName} onChange={e => setMgCredName(e.target.value)} placeholder="Login name" style={S.input} />
        <input type="password" value={mgCredPass} onChange={e => setMgCredPass(e.target.value)} placeholder="Password" style={S.input} />
        <button
          onClick={handleSetLogin}
          disabled={mgCredSaving || !mgCredTeam || !mgCredName || !mgCredPass}
          style={{ ...S.btn, ...disabledBtn(mgCredSaving || !mgCredTeam || !mgCredName || !mgCredPass) }}
        >
          {mgCredSaving ? 'Saving...' : 'Set Login'}
        </button>
      </div>

      {/* ── Emails ── */}
      <div style={S.section}>
        <div style={S.title}>📧 Manager Emails</div>
        <div style={{ ...theme.smallText, color: colors.textSecondary, marginBottom: 12 }}>
          Set email addresses for each manager. Used for waiver results, tournament results, and lineup reminders.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
          {teams.map(t => {
            const currentEmail = (settings.managerEmails || {})[t.id] || '';
            return (
              <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontFamily: fonts.sans, fontSize: 12, fontWeight: 600, color: colors.textPrimary, width: 120, flexShrink: 0 }}>
                  {t.name}
                </span>
                <input
                  type="email"
                  placeholder="email@example.com"
                  value={emailDraft?.[t.id] ?? currentEmail}
                  onChange={e => setEmailDraft(prev => ({ ...(prev || {}), [t.id]: e.target.value }))}
                  style={{ ...theme.input, flex: 1, fontSize: 12, padding: '7px 10px' }}
                />
              </div>
            );
          })}
        </div>
        <button
          onClick={handleSaveEmails}
          disabled={!emailDraft}
          style={{ ...S.btn, ...disabledBtn(!emailDraft) }}
        >
          💾 Save Emails
        </button>
      </div>
    </>
  );
};
