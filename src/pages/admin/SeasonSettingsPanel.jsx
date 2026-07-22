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
    // Optional 6th "backup" lineup spot, configurable per event type.
    // Majors default ON (where the feature launched); the rest default OFF.
    backupSpotMajor:     settings?.backupSpotMajor     ?? true,
    backupSpotSignature: settings?.backupSpotSignature ?? false,
    backupSpotRegular:   settings?.backupSpotRegular   ?? false,
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

      // Re-program the cron-job.org "waivers" job so its ping schedule tracks the
      // new gate. Without this the in-app gate moves but cron-job.org keeps
      // pinging on the old schedule — so a day/time change could silently never
      // fire. Best-effort: the settings (the gate) are already saved above, so a
      // sync failure degrades to gate-only behavior rather than blocking the save.
      let syncWarn = '';
      try {
        const resp = await fetch('/api/cron?action=sync-cron-schedule', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobType: 'waivers', day: waiverDay, hour: waiverHour, minute: waiverMinute }),
        });
        if (!resp.ok) {
          const d = await resp.json().catch(() => ({}));
          syncWarn = d.hint || d.error || `HTTP ${resp.status}`;
        }
      } catch (e) {
        syncWarn = e.message;
      }

      if (syncWarn) {
        dialog.showToast(`Saved the time, but cron-job.org didn't update: ${syncWarn}. Update the waivers job there manually.`, 'error');
      } else {
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

      // Re-program the cron-job.org "results" job so its ping schedule tracks
      // the new gate. The backend expands 'results' into a same-day RETRY
      // WINDOW (every 30 min from the set time to 10pm ET) so a weather-
      // delayed finish still auto-processes. Without this sync the in-app
      // gate moves but cron-job.org keeps pinging on the old schedule — this
      // is exactly what caused the John Deere Classic to sit unprocessed:
      // the job pinged once at 9:00 AM against a noon gate and never again.
      // Best-effort: settings (the gate) are already saved above, so a sync
      // failure degrades to gate-only behavior rather than blocking the save.
      let syncWarn = '';
      try {
        const resp = await fetch('/api/cron?action=sync-cron-schedule', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobType: 'results', day: resultsDay, hour: resultsHour, minute: resultsMinute }),
        });
        if (!resp.ok) {
          const d = await resp.json().catch(() => ({}));
          syncWarn = d.hint || d.error || `HTTP ${resp.status}`;
        }
      } catch (e) {
        syncWarn = e.message;
      }

      if (syncWarn) {
        dialog.showToast(`Saved the time, but cron-job.org didn't update: ${syncWarn}. Update the results job there manually.`, 'error');
      } else {
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

      // Re-program the cron-job.org "lineup-reminder" job to track the new
      // gate (weekly single fire). Same best-effort posture as waivers/results.
      let syncWarn = '';
      try {
        const resp = await fetch('/api/cron?action=sync-cron-schedule', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobType: 'lineup-reminder', day: reminderDay, hour: reminderHour, minute: reminderMinute }),
        });
        if (!resp.ok) {
          const d = await resp.json().catch(() => ({}));
          syncWarn = d.hint || d.error || `HTTP ${resp.status}`;
        }
      } catch (e) {
        syncWarn = e.message;
      }

      if (syncWarn) {
        dialog.showToast(`Saved the time, but cron-job.org didn't update: ${syncWarn}. Update the lineup-reminder job there manually.`, 'error');
      } else {
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

  // ── OWGR sync schedule ──
  // Gate defaults (api/cron.js handleOwgrRankings): Monday (1) at 5pm (17) ET.
  const [owgrDay,    setOwgrDay]    = React.useState(() => settings?.owgrSyncDay    ?? 1);
  const [owgrHour,   setOwgrHour]   = React.useState(() => settings?.owgrSyncHour   ?? 17);
  const [owgrMinute, setOwgrMinute] = React.useState(() => settings?.owgrSyncMinute ?? 0);
  const [owgrSaving, setOwgrSaving] = React.useState(false);

  const handleSaveOwgrSchedule = async () => {
    setOwgrSaving(true);
    try {
      // Keys must match exactly what the cron gate reads: owgrSyncDay/Hour/Minute.
      await setSettings({ ...settings, owgrSyncDay: owgrDay, owgrSyncHour: owgrHour, owgrSyncMinute: owgrMinute });

      // Re-program the cron-job.org "owgr-rankings" job so its ping schedule
      // tracks the new gate. Best-effort: settings (the gate) are already saved
      // above, so a sync failure degrades to gate-only behavior.
      let syncWarn = '';
      try {
        const resp = await fetch('/api/cron?action=sync-cron-schedule', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobType: 'owgr-rankings', day: owgrDay, hour: owgrHour, minute: owgrMinute }),
        });
        if (!resp.ok) {
          const d = await resp.json().catch(() => ({}));
          syncWarn = d.hint || d.error || `HTTP ${resp.status}`;
        }
      } catch (e) {
        syncWarn = e.message;
      }

      if (syncWarn) {
        dialog.showToast(`Saved the time, but cron-job.org didn't update: ${syncWarn}. Update the OWGR job there manually.`, 'error');
      } else {
        dialog.showToast(`✓ OWGR syncs ${DAY_NAMES[owgrDay]} at ${fmtETTime(owgrHour, owgrMinute)} ET`, 'success');
      }
    } catch (err) {
      dialog.showToast('Error: ' + err.message, 'error');
    } finally {
      setOwgrSaving(false);
    }
  };

  const owgrHasUnsavedChanges = settings?.owgrSyncDay !== undefined && (
    settings.owgrSyncDay !== owgrDay ||
    settings.owgrSyncHour !== owgrHour ||
    (settings.owgrSyncMinute ?? 0) !== owgrMinute
  );

  // Numeric input helper used in the collapsible Season Settings section.
  // Renders a $ prefix for dollar fields and right-aligns the value; plain
  // count fields get a centered numeric input.
  const isEditing = settingsDraft !== null && typeof settingsDraft === 'object';
  const draft = settingsDraft || getSettingsDraft();
  const setDraftKey = (key, val) => setSettingsDraft({ ...(settingsDraft || getSettingsDraft()), [key]: val });

  const numInput = (key, label, min = 0, dollar = false) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
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
            // box-sizing + minWidth:0 keep the native number input from
            // overflowing its grid track. Without these, the input's intrinsic
            // min-width pushed each field wider than its column and the next
            // field's "$" prefix landed on top of the previous value.
            boxSizing: 'border-box',
            minWidth: 0,
            width: '100%',
            appearance: 'textfield',
            MozAppearance: 'textfield',
            border: isEditing
              ? '1px solid rgba(220,170,60,0.5)'
              : `1px solid ${colors.borderSubtle}`,
          }}
        />
      </div>
    </div>
  );

  // Toggle row used by the Backup Lineup Spot section. A pill-style switch that
  // writes a boolean into the settings draft (so it saves alongside the rest of
  // Season Settings).
  const toggleRow = (key, label, hint) => {
    const on = !!draft[key];
    return (
      <button
        type="button"
        onClick={() => setDraftKey(key, !on)}
        className="modal-feel-lift"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          width: '100%',
          textAlign: 'left',
          padding: '10px 12px',
          background: 'rgba(255,255,255,0.02)',
          border: `1px solid ${on ? 'rgba(80,195,120,0.45)' : colors.borderSubtle}`,
          borderRadius: 6,
          cursor: 'pointer',
          transition: 'background 0.15s, border-color 0.15s',
        }}
        aria-pressed={on}
      >
        <span style={{
          position: 'relative',
          width: 38,
          height: 22,
          borderRadius: 999,
          flexShrink: 0,
          background: on ? 'rgba(80,195,120,0.55)' : 'rgba(255,255,255,0.12)',
          transition: 'background 0.15s',
        }}>
          <span style={{
            position: 'absolute',
            top: 2,
            left: on ? 18 : 2,
            width: 18,
            height: 18,
            borderRadius: '50%',
            background: '#fff',
            transition: 'left 0.15s',
          }} />
        </span>
        <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
          <span style={{ fontFamily: fonts.sans, fontSize: 13, fontWeight: 600, color: colors.textPrimary }}>
            {label}
          </span>
          {hint && (
            <span style={{ fontFamily: fonts.sans, fontSize: 11, color: colors.textMuted }}>
              {hint}
            </span>
          )}
        </span>
      </button>
    );
  };

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
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8, marginBottom: 8 }}>
                {numInput('bonusR1Regular', 'R1 — Regular', 0, true)}
                {numInput('bonusR2Regular', 'R2 — Regular', 0, true)}
                {numInput('bonusR3Regular', 'R3 — Regular', 0, true)}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
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
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
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
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
                {numInput('rosterLimit', 'Roster Size', 1)}
                {numInput('lineupSize', 'Lineup Size', 1)}
                {numInput('maxLimitedStarts', 'Max ★ Starts', 1)}
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
                Backup Lineup Spot
              </div>
              <div style={{ ...M.descText, color: colors.textMuted, marginBottom: 8 }}>
                Allow managers to designate a 6th player as a backup who can be promoted into the lineup if a starter withdraws. Choose which event types get the extra spot.
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {toggleRow('backupSpotMajor', 'Majors', 'e.g. the Masters, U.S. Open, the Open, PGA Championship')}
                {toggleRow('backupSpotSignature', 'Signature Events', 'Elevated / designated events')}
                {toggleRow('backupSpotRegular', 'Regular Events', 'All other tournaments')}
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

      <ScheduleEditor
        eyebrow="🌐 OWGR Sync Schedule"
        description="When world rankings are refreshed from OWGR each week. Default: Monday at 5:00 PM ET (rankings publish Monday afternoon). The Data Sync panel's manual button is a backup."
        day={owgrDay}     setDay={setOwgrDay}
        hour={owgrHour}   setHour={setOwgrHour}
        minute={owgrMinute} setMinute={setOwgrMinute}
        saving={owgrSaving}
        hasChanges={owgrHasUnsavedChanges}
        onSave={handleSaveOwgrSchedule}
        saveLabel="💾 Save OWGR Schedule"
        currentLabel="OWGR syncs"
      />

      {/* Cron-schedule explainer note. Reframed as a subtle info row instead
          of a tinted card with bold strong tag. */}
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
        <strong style={{ color: 'rgba(100,160,255,0.95)' }}>How timing works:</strong> the times above act as gates inside the scheduled cron job — cron-job.org must be pinging the SFGL URL at-or-before your configured time for the action to fire then. If the ping schedule is sparser, the action runs at the next ping after your configured time rather than exactly at it.
      </div>
    </div>
  );
};
