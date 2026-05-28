// src/pages/admin/SeasonSettingsPanel.jsx
// ============================================================================
// League settings — four groups in one panel:
//   • Season Settings — bonus amounts, fees, roster rules (collapsible)
//   • Waiver Schedule — day/hour/minute of weekly waiver processing
//   • Results Schedule — day/hour/minute of weekly results auto-processing
//   • Lineup Reminder Schedule — day/hour/minute of lineup-lock reminder
//
// Wave J Round 6 follow-up: restyled to modal-feel — flat container, eyebrow
// headings, lifted buttons, collapsible Season Settings via lift-row header.
// Three schedule sub-panels share a ScheduleEditor helper to eliminate
// repetition. Functional behavior unchanged.
// ============================================================================

import React from 'react';
import { useDialog } from '../DialogContext';
import { colors, fonts } from '../../theme.js';
import { M, disabledBtn } from './adminStyles';
import { DAY_NAMES, fmtETTime } from '../../utils/sharedHelpers';

// ── Cron-job.org schedule sync ──────────────────────────────────────────────
// After each schedule save (waiver / results / lineup-reminder / lead-watch),
// call this helper to push the new schedule to cron-job.org via our server
// endpoint. AdminView is the single source of truth for when each cron
// fires — saving here updates BOTH the Firestore settings (read by the cron
// handler's gate as a soft guard) AND the actual cron-job.org schedule
// (which controls when our endpoint gets pinged).
//
// Accepts either a weekly slot (day/hour/minute) or an interval
// (minuteInterval). Unused fields are simply not forwarded — the server
// validates based on jobType.
//
// Failure handling: non-fatal. The Firestore save already succeeded, so the
// commish sees the schedule reflected in the UI. The toast surfaces what
// went wrong so the commish can act — e.g., add missing env vars to Vercel,
// re-check the API key in cron-job.org, or simply retry later.
async function syncCronJobSchedule(payload, dialog) {
  try {
    const resp = await fetch('/api/cron?action=sync-cron-schedule', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      // Common case the commish should know about: server isn't configured
      // with API key + job IDs yet. Show the hint from the server response.
      const hint = data?.hint ? ` — ${data.hint}` : '';
      dialog.showToast(
        `Schedule saved, but cron-job.org sync failed: ${data?.error || `HTTP ${resp.status}`}${hint}`,
        'error',
      );
      console.warn('[syncCronJobSchedule] failed:', data);
      return false;
    }
    return true;
  } catch (err) {
    dialog.showToast(`Schedule saved, but cron-job.org sync failed: ${err.message}`, 'error');
    console.warn('[syncCronJobSchedule] network error:', err);
    return false;
  }
}

// ── ScheduleEditor — shared helper used by all three schedule sub-sections ──
// Each schedule (waivers, results, lineup reminder) has identical UI: day +
// hour + minute selectors, a "Current: X day at H:MM ET" footer, and a save
// button. This component renders that pattern in 30 lines instead of 90×3.
const ScheduleEditor = ({
  eyebrow,
  description,
  day, hour, minute,
  setDay, setHour, setMinute,
  saving, hasChanges, onSave,
  saveLabel,
  currentLabel,  // e.g. "waivers process" or "reminders send"
}) => (
  <div style={M.group}>
    <div style={M.eyebrow}>{eyebrow}</div>
    <div style={M.descText}>{description}</div>
    <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ fontFamily: fonts.sans, fontSize: 10, color: colors.textMuted, letterSpacing: '0.5px', textTransform: 'uppercase' }}>Day</div>
        <select value={day} onChange={e => setDay(Number(e.target.value))} style={M.select}>
          {DAY_NAMES.map((d, i) => <option key={i} value={i}>{d}</option>)}
        </select>
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ fontFamily: fonts.sans, fontSize: 10, color: colors.textMuted, letterSpacing: '0.5px', textTransform: 'uppercase' }}>Hour (ET)</div>
        <select value={hour} onChange={e => setHour(Number(e.target.value))} style={M.select}>
          {Array.from({ length: 24 }, (_, i) => (
            <option key={i} value={i}>
              {i === 0 ? '12 AM' : i < 12 ? `${i} AM` : i === 12 ? '12 PM' : `${i - 12} PM`}
            </option>
          ))}
        </select>
      </div>
      <div style={{ flex: '0 0 90px', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ fontFamily: fonts.sans, fontSize: 10, color: colors.textMuted, letterSpacing: '0.5px', textTransform: 'uppercase' }}>Minute</div>
        <select value={minute} onChange={e => setMinute(Number(e.target.value))} style={M.select}>
          {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map(m => (
            <option key={m} value={m}>:{String(m).padStart(2, '0')}</option>
          ))}
        </select>
      </div>
    </div>
    <div style={{
      fontFamily: fonts.sans,
      fontSize: 11,
      color: colors.textGoldDim,
      marginTop: 2,
    }}>
      Current: {currentLabel} {DAY_NAMES[day]} at {fmtETTime(hour, minute)} ET
      {hasChanges && (
        <span style={{ color: colors.warning }}> · unsaved changes</span>
      )}
    </div>
    <button
      onClick={onSave}
      disabled={saving}
      className="modal-feel-lift modal-feel-primary"
      style={{ ...M.btnPrimary, ...disabledBtn(saving) }}
    >
      {saving ? '⏳ Saving…' : saveLabel}
    </button>
  </div>
);

export const SeasonSettingsPanel = ({
  settings, setSettings,
}) => {
  const dialog = useDialog();

  // ── Season settings (bonuses, fees, roster rules) ──
  const [settingsSaving, setSettingsSaving] = React.useState(false);
  const [settingsOpen,   setSettingsOpen]   = React.useState(false);
  const [settingsDraft,  setSettingsDraft]  = React.useState(null);

  const getSettingsDraft = () => ({
    bonusR1Regular:   settings?.bonusR1Regular   ?? 20000,
    bonusR2Regular:   settings?.bonusR2Regular   ?? 40000,
    bonusR3Regular:   settings?.bonusR3Regular   ?? 60000,
    bonusR1Major:     settings?.bonusR1Major     ?? 40000,
    bonusR2Major:     settings?.bonusR2Major     ?? 80000,
    bonusR3Major:     settings?.bonusR3Major     ?? 120000,
    feeFA:            settings?.feeFA            ?? 1,
    feeWaiver:        settings?.feeWaiver        ?? 2,
    rosterLimit:      settings?.rosterLimit      ?? 13,
    lineupSize:       settings?.lineupSize       ?? 5,
    maxLimitedStarts: settings?.maxLimitedStarts ?? 12,
  });

  const handleSaveSettings = async () => {
    if (!settingsDraft) return;
    setSettingsSaving(true);
    try {
      await setSettings({ ...settings, ...settingsDraft });
      setSettingsDraft(null);
      dialog.showToast('✓ Season settings saved', 'success');
    } catch (err) {
      dialog.showToast('Error: ' + err.message, 'error');
    } finally {
      setSettingsSaving(false);
    }
  };

  // ── Waiver schedule ──
  const [waiverDay,    setWaiverDay]    = React.useState(() => settings?.waiverDay    ?? 2);
  const [waiverHour,   setWaiverHour]   = React.useState(() => settings?.waiverHour   ?? 20);
  const [waiverMinute, setWaiverMinute] = React.useState(() => settings?.waiverMinute ?? 0);
  const [waiverSaving, setWaiverSaving] = React.useState(false);

  const handleSaveWaiverSchedule = async () => {
    setWaiverSaving(true);
    try {
      await setSettings({ ...settings, waiverDay, waiverHour, waiverMinute });
      // Push the schedule to cron-job.org. Helper handles its own toast on
      // failure; we only show success here when both saves landed cleanly.
      const synced = await syncCronJobSchedule(
        { jobType: 'waivers', day: waiverDay, hour: waiverHour, minute: waiverMinute },
        dialog,
      );
      if (synced) {
        dialog.showToast(`✓ Waivers process ${DAY_NAMES[waiverDay]} at ${fmtETTime(waiverHour, waiverMinute)} ET`, 'success');
      }
    } catch (err) {
      dialog.showToast('Error: ' + err.message, 'error');
    } finally {
      setWaiverSaving(false);
    }
  };

  const waiverHasUnsavedChanges = settings?.waiverDay !== undefined && (
    settings.waiverDay !== waiverDay ||
    settings.waiverHour !== waiverHour ||
    (settings.waiverMinute ?? 0) !== waiverMinute
  );

  // ── Results schedule ──
  const [resultsDay,    setResultsDay]    = React.useState(() => settings?.resultsDay    ?? 1);
  const [resultsHour,   setResultsHour]   = React.useState(() => settings?.resultsHour   ?? 9);
  const [resultsMinute, setResultsMinute] = React.useState(() => settings?.resultsMinute ?? 0);
  const [resultsSaving, setResultsSaving] = React.useState(false);

  const handleSaveResultsSchedule = async () => {
    setResultsSaving(true);
    try {
      await setSettings({ ...settings, resultsDay, resultsHour, resultsMinute });
      const synced = await syncCronJobSchedule(
        { jobType: 'results', day: resultsDay, hour: resultsHour, minute: resultsMinute },
        dialog,
      );
      if (synced) {
        dialog.showToast(`✓ Results process ${DAY_NAMES[resultsDay]} at ${fmtETTime(resultsHour, resultsMinute)} ET`, 'success');
      }
    } catch (err) {
      dialog.showToast('Error: ' + err.message, 'error');
    } finally {
      setResultsSaving(false);
    }
  };

  const resultsHasUnsavedChanges = settings?.resultsDay !== undefined && (
    settings.resultsDay !== resultsDay ||
    settings.resultsHour !== resultsHour ||
    (settings.resultsMinute ?? 0) !== resultsMinute
  );

  // ── Lineup reminder schedule ──
  const [reminderDay,    setReminderDay]    = React.useState(() => settings?.lineupReminderDay    ?? 3);
  const [reminderHour,   setReminderHour]   = React.useState(() => settings?.lineupReminderHour   ?? 9);
  const [reminderMinute, setReminderMinute] = React.useState(() => settings?.lineupReminderMinute ?? 0);
  const [reminderSaving, setReminderSaving] = React.useState(false);

  const handleSaveReminderSchedule = async () => {
    setReminderSaving(true);
    try {
      await setSettings({ ...settings, lineupReminderDay: reminderDay, lineupReminderHour: reminderHour, lineupReminderMinute: reminderMinute });
      const synced = await syncCronJobSchedule(
        { jobType: 'lineup-reminder', day: reminderDay, hour: reminderHour, minute: reminderMinute },
        dialog,
      );
      if (synced) {
        dialog.showToast(`✓ Lineup reminders send ${DAY_NAMES[reminderDay]} at ${fmtETTime(reminderHour, reminderMinute)} ET`, 'success');
      }
    } catch (err) {
      dialog.showToast('Error: ' + err.message, 'error');
    } finally {
      setReminderSaving(false);
    }
  };

  const reminderHasUnsavedChanges = settings?.lineupReminderDay !== undefined && (
    settings.lineupReminderDay !== reminderDay ||
    settings.lineupReminderHour !== reminderHour ||
    (settings.lineupReminderMinute ?? 0) !== reminderMinute
  );

  // ── Lead-watch interval ──
  // How often the lead-watch cron polls live leaderboard for lead changes.
  // Interval-based (minutes), not weekly slot. The handler itself self-gates
  // on round/tournament state, so off-hour pings are essentially free.
  const [leadInterval,       setLeadInterval]       = React.useState(() => settings?.leadWatchInterval ?? 10);
  const [leadWatchEnabled,   setLeadWatchEnabled]   = React.useState(() => settings?.leadWatchEnabled !== false);
  const [leadSaving,         setLeadSaving]         = React.useState(false);

  const handleSaveLeadWatch = async () => {
    setLeadSaving(true);
    try {
      await setSettings({ ...settings, leadWatchInterval: leadInterval, leadWatchEnabled });
      const synced = await syncCronJobSchedule(
        { jobType: 'lead-watch', minuteInterval: leadInterval },
        dialog,
      );
      if (synced) {
        dialog.showToast(`✓ Lead-change pushes will poll every ${leadInterval} min`, 'success');
      }
    } catch (err) {
      dialog.showToast('Error: ' + err.message, 'error');
    } finally {
      setLeadSaving(false);
    }
  };

  const leadHasUnsavedChanges = (
    (settings?.leadWatchInterval ?? 10) !== leadInterval ||
    (settings?.leadWatchEnabled !== false) !== leadWatchEnabled
  );

  // Numeric input helper used in the collapsible Season Settings section.
  // Renders a $ prefix for dollar fields and right-aligns the value; plain
  // count fields get a centered numeric input.
  const isEditing = settingsDraft !== null && typeof settingsDraft === 'object';
  const draft = settingsDraft || getSettingsDraft();
  const setDraftKey = (key, val) => setSettingsDraft({ ...(settingsDraft || getSettingsDraft()), [key]: val });

  const numInput = (key, label, min = 0, dollar = false) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{
        fontFamily: fonts.sans,
        fontSize: 10,
        color: colors.textMuted,
        letterSpacing: '0.5px',
        textTransform: 'uppercase',
      }}>
        {label}
      </label>
      <div style={{ position: 'relative' }}>
        {dollar && (
          <span style={{
            position: 'absolute',
            left: 10,
            top: '50%',
            transform: 'translateY(-50%)',
            fontFamily: fonts.mono,
            fontSize: 13,
            color: colors.textMuted,
            pointerEvents: 'none',
          }}>$</span>
        )}
        <input
          type="number"
          min={min}
          value={draft[key]}
          onChange={e => setDraftKey(key, Number(e.target.value))}
          style={{
            ...M.input,
            fontSize: 13,
            textAlign: dollar ? 'right' : 'center',
            paddingLeft: dollar ? 22 : 12,
            border: isEditing
              ? '1px solid rgba(220,170,60,0.5)'
              : `1px solid ${colors.borderSubtle}`,
          }}
        />
      </div>
    </div>
  );

  return (
    <div style={M.page}>
      <div style={M.descText}>
        Configure league rules and the schedule of automated league actions. All changes take effect immediately.
      </div>

      {/* ── Season Settings — collapsible group ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <button
          onClick={() => { setSettingsOpen(o => !o); setSettingsDraft(null); }}
          aria-expanded={settingsOpen}
          className="modal-feel-lift"
          style={{
            ...M.liftRow,
            justifyContent: 'space-between',
            cursor: 'pointer',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, textAlign: 'left' }}>
            <div style={{
              fontFamily: fonts.sans, fontSize: 13, fontWeight: 600,
              color: colors.textPrimary,
            }}>
              ⚙️ Season Settings
            </div>
            <div style={{
              fontFamily: fonts.sans, fontSize: 11,
              color: colors.textMuted,
            }}>
              Bonuses, fees, and roster rules
            </div>
          </div>
          <span style={{
            fontFamily: fonts.sans, fontSize: 11,
            color: colors.textMuted,
            transform: settingsOpen ? 'rotate(0deg)' : 'rotate(-90deg)',
            transition: 'transform 0.15s',
            display: 'inline-block',
            lineHeight: 1,
          }}>▼</span>
        </button>

        {settingsOpen && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '6px 4px 4px' }}>
            <div style={{ ...M.descText, color: colors.textMuted }}>
              ⚠ Changes apply immediately to all league calculations.
            </div>

            <div>
              <div style={{
                fontFamily: fonts.sans,
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '1px',
                textTransform: 'uppercase',
                color: colors.textGold,
                marginBottom: 8,
              }}>
                Round Leader Bonuses
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 8 }}>
                {numInput('bonusR1Regular', 'R1 — Regular', 0, true)}
                {numInput('bonusR2Regular', 'R2 — Regular', 0, true)}
                {numInput('bonusR3Regular', 'R3 — Regular', 0, true)}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                {numInput('bonusR1Major', 'R1 — Major', 0, true)}
                {numInput('bonusR2Major', 'R2 — Major', 0, true)}
                {numInput('bonusR3Major', 'R3 — Major', 0, true)}
              </div>
            </div>

            <div>
              <div style={{
                fontFamily: fonts.sans,
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '1px',
                textTransform: 'uppercase',
                color: colors.textGold,
                marginBottom: 8,
              }}>
                Transaction Fees
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {numInput('feeFA', 'Free Agent', 0, true)}
                {numInput('feeWaiver', 'Waiver Claim', 0, true)}
              </div>
            </div>

            <div>
              <div style={{
                fontFamily: fonts.sans,
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '1px',
                textTransform: 'uppercase',
                color: colors.textGold,
                marginBottom: 8,
              }}>
                Roster Rules
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                {numInput('rosterLimit', 'Roster Size', 1)}
                {numInput('lineupSize', 'Lineup Size', 1)}
                {numInput('maxLimitedStarts', 'Max ★ Starts', 1)}
              </div>
            </div>

            {isEditing && (
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={async () => {
                    const ok = await dialog.showConfirm(
                      'Save Season Settings',
                      'These changes affect all league calculations immediately. Are you sure?',
                      { confirmText: 'Yes, Save', type: 'warning' }
                    );
                    if (ok) handleSaveSettings();
                  }}
                  disabled={settingsSaving}
                  className="modal-feel-lift modal-feel-primary"
                  style={{ ...M.btnPrimary, flex: 1, ...disabledBtn(settingsSaving) }}
                >
                  {settingsSaving ? '⏳ Saving…' : '✓ Save Season Settings'}
                </button>
                <button
                  onClick={() => setSettingsDraft(null)}
                  className="modal-feel-lift"
                  style={{
                    ...M.btnSecondary,
                    width: 'auto',
                    flex: '0 0 auto',
                    whiteSpace: 'nowrap',
                  }}
                >
                  Discard
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Three schedule groups, all using ScheduleEditor ── */}
      <ScheduleEditor
        eyebrow="🗓️ Waiver Schedule"
        description="When waiver claims are processed each week. Default: Tuesday at 8:00 PM ET."
        day={waiverDay}     setDay={setWaiverDay}
        hour={waiverHour}   setHour={setWaiverHour}
        minute={waiverMinute} setMinute={setWaiverMinute}
        saving={waiverSaving}
        hasChanges={waiverHasUnsavedChanges}
        onSave={handleSaveWaiverSchedule}
        saveLabel="💾 Save Waiver Schedule"
        currentLabel="waivers process"
      />

      <ScheduleEditor
        eyebrow="🏆 Results Schedule"
        description='When tournament results are auto-processed each week. Default: Monday at 9:00 AM ET. The manual "Process Results" panel is a backup if you need to override.'
        day={resultsDay}     setDay={setResultsDay}
        hour={resultsHour}   setHour={setResultsHour}
        minute={resultsMinute} setMinute={setResultsMinute}
        saving={resultsSaving}
        hasChanges={resultsHasUnsavedChanges}
        onSave={handleSaveResultsSchedule}
        saveLabel="💾 Save Results Schedule"
        currentLabel="results process"
      />

      <ScheduleEditor
        eyebrow="⛳ Lineup Reminder Schedule"
        description="When lineup-lock reminders are sent to managers who haven't set a lineup yet. Default: Wednesday at 9:00 AM ET."
        day={reminderDay}     setDay={setReminderDay}
        hour={reminderHour}   setHour={setReminderHour}
        minute={reminderMinute} setMinute={setReminderMinute}
        saving={reminderSaving}
        hasChanges={reminderHasUnsavedChanges}
        onSave={handleSaveReminderSchedule}
        saveLabel="💾 Save Reminder Schedule"
        currentLabel="reminders send"
      />

      {/* ── Lead-Watch Polling ─────────────────────────────────────────────
          Interval-based schedule (not weekly). The lead-watch cron polls
          live leaderboard every N minutes and sends a push to any team
          whose lineup contains a player newly at T1. The handler self-
          gates on round/tournament state, so polling 24/7 is cheap when
          there's no live event. */}
      <div style={M.group}>
        <div style={M.eyebrow}>🏌 Lead-Change Pushes</div>
        <div style={M.descText}>
          How often the lead-watch poller checks the live leaderboard during a
          tournament. When a player takes (or ties for) the lead in round 2 or
          later, any manager whose lineup contains that player gets an instant
          push. Polling outside live tournaments is essentially free — the
          handler exits early when nothing's active.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 2 }}>
          <div style={{
            fontFamily: fonts.sans, fontSize: 10, color: colors.textMuted,
            letterSpacing: '0.5px', textTransform: 'uppercase',
          }}>Poll interval</div>
          <select
            value={leadInterval}
            onChange={e => setLeadInterval(Number(e.target.value))}
            style={M.select}
          >
            <option value={5}>Every 5 minutes</option>
            <option value={10}>Every 10 minutes (default)</option>
            <option value={15}>Every 15 minutes</option>
            <option value={20}>Every 20 minutes</option>
            <option value={30}>Every 30 minutes</option>
          </select>
        </div>
        <div style={{
          fontFamily: fonts.sans, fontSize: 11, color: colors.textGoldDim, marginTop: 2,
        }}>
          Current: polling every {settings?.leadWatchInterval ?? 10} min
          {leadHasUnsavedChanges && (
            <span style={{ color: colors.warning }}> · unsaved changes</span>
          )}
        </div>
        <button
          onClick={handleSaveLeadWatch}
          disabled={leadSaving}
          className="modal-feel-lift modal-feel-primary"
          style={{ ...M.btnPrimary, ...disabledBtn(leadSaving) }}
        >
          {leadSaving ? '⏳ Saving…' : '💾 Save Lead-Watch Schedule'}
        </button>
      </div>

      {/* Cron-schedule explainer note. Updated to reflect the cron-job.org
          architecture: cron-job.org fires at the EXACT configured time
          (within seconds), not on Vercel's hour-window cadence. */}
      <div style={{
        padding: '10px 12px',
        background: 'rgba(100,160,255,0.04)',
        border: '1px solid rgba(100,160,255,0.2)',
        borderRadius: 6,
        fontFamily: fonts.sans,
        fontSize: 11,
        color: colors.textSecondary,
        lineHeight: 1.55,
      }}>
        <strong style={{ color: 'rgba(100,160,255,0.95)' }}>How timing works:</strong> saving a schedule above updates the corresponding cron-job.org job in real time. Jobs fire at the configured time in America/New_York within seconds — daylight saving is handled automatically.
      </div>
    </div>
  );
};
