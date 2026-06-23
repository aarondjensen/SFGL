// src/pages/admin/ManagerAccountsPanel.jsx
// ============================================================================
// Managers — the single commish hub for everything account-related, post
// Firebase-auth migration. Consolidates what used to be three separate things:
//
//   • Team claims        — who has signed in and claimed each team (replaces the
//                          old name/password "Login Credentials" section, which
//                          is obsolete now that identity is a Firebase uid).
//   • Manager Activity    — last login + push-notification status per team
//                          (folded in from the standalone ManagerActivityPanel,
//                          so it's no longer a separate tile).
//   • Results email       — per-team override written to team_claims.notifyEmail,
//                          which api/cron.js prefers over the legacy
//                          settings.managerEmails map.
//
// Removed as dead post-migration: the password credential setter and the
// team.isCommissioner toggle (commissioner is a Firebase custom claim now, not a
// client-writable flag — granted via the stamp-commissioner action).
//
// Data sources: subscribeClaims() (realtime team_claims), managerActivityApi
// (login heartbeat), getTokensForTeam() (push tokens). Writes via reassignTeam()
// and setNotifyEmail(), both of which the commissioner is allowed to perform
// under the locked Firestore rules.
// ============================================================================

import React from 'react';
import { useDialog } from '../DialogContext';
import { colors, fonts } from '../../theme.js';
import { M, disabledBtn } from './adminStyles';
import { subscribeClaims, reassignTeam, setNotifyEmail } from '../../api/authApi';
import { managerActivityApi } from '../../api/managerActivity';
import { getTokensForTeam } from '../../api/pushNotifications';

// "Just now" / "12m ago" / "3h ago" / "2d ago" / "1mo ago" / "Never"
const timeAgo = (ms) => {
  if (!ms) return 'Never';
  const diff = Date.now() - ms;
  if (diff < 60000) return 'Just now';
  const min = Math.floor(diff / 60000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  return `${mo}mo ago`;
};

const fullDate = (ms) => (ms
  ? new Date(ms).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
    })
  : 'No login recorded yet');

// uid is long + opaque; show enough to identify/copy without dominating the row.
const shortUid = (uid) => (uid && uid.length > 14 ? `${uid.slice(0, 8)}…${uid.slice(-4)}` : uid || '');

export const ManagerAccountsPanel = ({ teams = [] }) => {
  const dialog = useDialog();

  const [claims, setClaims]   = React.useState(null);   // teamId → claim doc
  const [activity, setActivity] = React.useState({});   // teamId → { lastLogin }
  const [notif, setNotif]     = React.useState({});     // teamId → bool
  const [loading, setLoading] = React.useState(true);

  const [emailDraft, setEmailDraft] = React.useState({}); // teamId → string
  const [savingEmails, setSavingEmails] = React.useState(false);

  const [assignTeam, setAssignTeam] = React.useState('');
  const [assignUid, setAssignUid]   = React.useState('');
  const [assigning, setAssigning]   = React.useState(false);

  // Realtime claims.
  React.useEffect(() => subscribeClaims(setClaims), []);

  // One-shot activity + push status (mirrors the old ManagerActivityPanel load).
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const ids = teams.map((t) => t.id).filter(Boolean);
      const [act, tokenFlags] = await Promise.all([
        managerActivityApi.getActivity(ids),
        Promise.all(ids.map((id) =>
          getTokensForTeam(id)
            .then((toks) => [id, (toks || []).length > 0])
            .catch(() => [id, false])
        )),
      ]);
      if (cancelled) return;
      setActivity(act);
      setNotif(Object.fromEntries(tokenFlags));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [teams]);

  const copyUid = async (uid) => {
    try {
      await navigator.clipboard.writeText(uid);
      dialog.showToast('UID copied', 'success');
    } catch {
      dialog.showToast(uid, 'info');
    }
  };

  const handleRelease = async (t) => {
    const ok = await dialog.showConfirm(
      `Release ${t.name}?`,
      'This unclaims the team. The manager will need to sign in and claim it again. No roster or transaction data is affected.',
      { confirmText: 'Release', type: 'danger' },
    );
    if (!ok) return;
    try {
      await reassignTeam(t.id, null);
      dialog.showToast(`${t.name} released`, 'success');
    } catch (e) {
      dialog.showToast('Failed: ' + e.message, 'error');
    }
  };

  const handleAssign = async () => {
    const uid = assignUid.trim();
    if (!assignTeam || !uid) return;
    const team = teams.find((t) => t.id === assignTeam);
    setAssigning(true);
    try {
      await reassignTeam(assignTeam, uid);
      dialog.showToast(`${team?.name || 'Team'} assigned`, 'success');
      setAssignTeam(''); setAssignUid('');
    } catch (e) {
      dialog.showToast('Failed: ' + e.message, 'error');
    } finally {
      setAssigning(false);
    }
  };

  const handleSaveEmails = async () => {
    const entries = Object.entries(emailDraft);
    if (!entries.length) return;
    setSavingEmails(true);
    try {
      for (const [teamId, val] of entries) {
        await setNotifyEmail(teamId, val);
      }
      dialog.showToast('✓ Results emails saved', 'success');
      setEmailDraft({});
    } catch (e) {
      dialog.showToast('Error: ' + e.message, 'error');
    } finally {
      setSavingEmails(false);
    }
  };

  // Most recently active first; unclaimed / never-logged-in fall to the bottom.
  const rows = [...teams].sort(
    (a, b) => (activity[b.id]?.lastLogin || 0) - (activity[a.id]?.lastLogin || 0)
  );

  const claimsLoading = claims === null;
  const claimedCount = claims ? rows.filter((t) => claims[t.id]?.uid).length : 0;
  const hasEmailEdits = Object.keys(emailDraft).length > 0;

  return (
    <div style={M.page}>
      {/* ── Claims + activity ── */}
      <div style={M.group}>
        <div style={M.eyebrow}>👥 Team Claims & Activity</div>
        <div style={M.descText}>
          Who has signed in and claimed each team, their most recent login, and
          whether push is enabled on a device.{' '}
          {!claimsLoading && (
            <span style={{ color: colors.textSecondary }}>
              {claimedCount}/{rows.length} teams claimed.
            </span>
          )}
        </div>

        {(claimsLoading || loading) ? (
          <div style={{ fontFamily: fonts.sans, fontSize: 13, color: colors.textMuted, padding: '10px 0' }}>
            Loading…
          </div>
        ) : rows.map((t) => {
          const c        = claims[t.id] || null;
          const claimed  = !!c?.uid;
          const last     = activity[t.id]?.lastLogin || null;
          const on       = !!notif[t.id];
          const ownerLabel = c?.displayName || c?.email || (claimed ? shortUid(c.uid) : null);

          return (
            <div
              key={t.id}
              style={{
                padding: '12px 0',
                borderBottom: `1px solid ${colors.borderSubtle}`,
              }}
            >
              {/* Name + claim status */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <div style={{ fontFamily: fonts.sans, fontSize: 14, fontWeight: 600, color: colors.textPrimary }}>
                  {t.name}
                </div>
                <span
                  style={{
                    flexShrink: 0,
                    fontFamily: fonts.sans, fontSize: 10, fontWeight: 700, letterSpacing: '0.4px',
                    textTransform: 'uppercase',
                    padding: '3px 9px', borderRadius: 999, whiteSpace: 'nowrap',
                    color: claimed ? colors.earningsGreen : colors.textMuted,
                    background: claimed ? 'rgba(80,195,120,0.08)' : 'rgba(255,255,255,0.04)',
                    border: `1px solid ${claimed ? 'rgba(80,195,120,0.3)' : colors.borderSubtle}`,
                  }}
                >
                  {claimed ? 'Claimed' : 'Unclaimed'}
                </span>
              </div>

              {/* Owner */}
              <div style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.textSecondary, marginTop: 4 }}>
                {claimed
                  ? <>Claimed by <span style={{ color: colors.textPrimary, fontWeight: 600 }}>{ownerLabel}</span></>
                  : <span style={{ color: colors.textMuted }}>No one has claimed this team yet.</span>}
              </div>

              {/* Meta: last login + push */}
              <div
                title={fullDate(last)}
                style={{ fontFamily: fonts.sans, fontSize: 11, color: colors.textMuted, marginTop: 3 }}
              >
                Last login: {timeAgo(last)}
                {'  ·  '}
                {on ? '🔔 Notifications on' : '🔕 Notifications off'}
              </div>

              {/* uid + actions (claimed only) */}
              {claimed && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                  <code style={{
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    fontSize: 11, color: colors.textMuted,
                    background: 'rgba(255,255,255,0.04)',
                    border: `1px solid ${colors.borderSubtle}`,
                    borderRadius: 5, padding: '2px 7px',
                  }}>
                    {shortUid(c.uid)}
                  </code>
                  <button
                    onClick={() => copyUid(c.uid)}
                    style={{
                      fontFamily: fonts.sans, fontSize: 11, fontWeight: 600,
                      color: colors.textSecondary, background: 'transparent',
                      border: `1px solid ${colors.borderSubtle}`, borderRadius: 5,
                      padding: '3px 9px', cursor: 'pointer',
                    }}
                  >
                    Copy UID
                  </button>
                  <button
                    onClick={() => handleRelease(t)}
                    style={{
                      fontFamily: fonts.sans, fontSize: 11, fontWeight: 600,
                      color: 'rgba(230,120,120,0.95)', background: 'transparent',
                      border: '1px solid rgba(220,80,80,0.35)', borderRadius: 5,
                      padding: '3px 9px', cursor: 'pointer',
                    }}
                  >
                    Release
                  </button>
                </div>
              )}
            </div>
          );
        })}

        <div style={{ ...M.descText, marginTop: 10, marginBottom: 0 }}>
          To make a manager a commissioner, copy their UID above and run the
          <span style={{ color: colors.textSecondary }}> stamp-commissioner</span> action with it.
        </div>
      </div>

      {/* ── Results emails ── */}
      <div style={M.group}>
        <div style={M.eyebrow}>📧 Results Emails</div>
        <div style={M.descText}>
          Override where each team's waiver/results/lineup emails go. Leaving a
          field blank falls back to the manager's saved email.
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {teams.map((t) => {
            const current = (claims && claims[t.id]?.notifyEmail) || '';
            return (
              <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{
                  fontFamily: fonts.sans, fontSize: 12, fontWeight: 600,
                  color: colors.textPrimary, width: 120, flexShrink: 0,
                }}>
                  {t.name}
                </span>
                <input
                  type="email"
                  placeholder="email@example.com"
                  value={emailDraft[t.id] ?? current}
                  onChange={(e) => setEmailDraft((prev) => ({ ...prev, [t.id]: e.target.value }))}
                  style={{ ...M.input, flex: 1 }}
                />
              </div>
            );
          })}
        </div>

        <button
          onClick={handleSaveEmails}
          disabled={savingEmails || !hasEmailEdits}
          className="modal-feel-lift modal-feel-primary"
          style={{ ...M.btnPrimary, ...disabledBtn(savingEmails || !hasEmailEdits), marginTop: 4 }}
        >
          {savingEmails ? 'Saving…' : '💾 Save Emails'}
        </button>
      </div>

      {/* ── Manual reassign (edge cases) ── */}
      <div style={M.group}>
        <div style={M.eyebrow}>🔁 Reassign Team</div>
        <div style={M.descText}>
          Force a team's owner to a specific Firebase UID — for fixing a
          wrong-team claim. To simply unclaim, use Release above.
        </div>

        <select value={assignTeam} onChange={(e) => setAssignTeam(e.target.value)} style={M.select}>
          <option value="">Select team…</option>
          {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <input
          value={assignUid}
          onChange={(e) => setAssignUid(e.target.value)}
          placeholder="Firebase UID"
          style={M.input}
        />
        <button
          onClick={handleAssign}
          disabled={assigning || !assignTeam || !assignUid.trim()}
          className="modal-feel-lift modal-feel-primary"
          style={{ ...M.btnPrimary, ...disabledBtn(assigning || !assignTeam || !assignUid.trim()) }}
        >
          {assigning ? 'Assigning…' : 'Assign UID'}
        </button>
      </div>
    </div>
  );
};
