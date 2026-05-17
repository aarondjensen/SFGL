// src/pages/admin/SeasonSettingsPanel.jsx
// ============================================================================
// League settings — three sections kept together as one "League Settings" group:
//   • Season Settings — bonus amounts, fees, roster rules
//   • Waiver Schedule — day/hour/minute of weekly waiver processing
//   • Draft           — opens the DraftModal
//
// Wave I extraction from AdminView.
// ============================================================================

import React from 'react';
import { useDialog } from '../DialogContext';
import { theme, colors, fonts } from '../../theme.js';
import { DraftModal } from '../DraftModal';
import { S, disabledBtn } from './adminStyles';
import { DAY_NAMES, fmtETTime } from '../../utils/sharedHelpers';

export const SeasonSettingsPanel = ({
  settings, setSettings,
  teams, allPlayers, updateTeams, headshots,
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
      dialog.showToast(`✓ Waivers process ${DAY_NAMES[waiverDay]} at ${fmtETTime(waiverHour, waiverMinute)} ET`, 'success');
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

  // ── Results schedule (Wave J Round 6 batch 4 follow-up) ──
  // Was hardcoded in cron.js as Monday 9am ET (settings.resultsDay/Hour
  // read with defaults but no UI). Now exposed for commish control. Cron's
  // handleProcessResults already reads these settings — no server changes
  // needed.
  const [resultsDay,    setResultsDay]    = React.useState(() => settings?.resultsDay    ?? 1);   // Mon
  const [resultsHour,   setResultsHour]   = React.useState(() => settings?.resultsHour   ?? 9);   // 9am
  const [resultsMinute, setResultsMinute] = React.useState(() => settings?.resultsMinute ?? 0);
  const [resultsSaving, setResultsSaving] = React.useState(false);

  const handleSaveResultsSchedule = async () => {
    setResultsSaving(true);
    try {
      await setSettings({ ...settings, resultsDay, resultsHour, resultsMinute });
      dialog.showToast(`✓ Results process ${DAY_NAMES[resultsDay]} at ${fmtETTime(resultsHour, resultsMinute)} ET`, 'success');
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

  // ── Lineup reminder schedule (Wave J Round 6 batch 4 follow-up) ──
  // Was hardcoded in cron.js as "any Wednesday ping" (no hour gate). Now
  // configurable. The cron's handleLineupReminder needs an hour gate too
  // (delivered in the matching cron.js update).
  const [reminderDay,    setReminderDay]    = React.useState(() => settings?.lineupReminderDay    ?? 3);  // Wed
  const [reminderHour,   setReminderHour]   = React.useState(() => settings?.lineupReminderHour   ?? 9);  // 9am ET
  const [reminderMinute, setReminderMinute] = React.useState(() => settings?.lineupReminderMinute ?? 0);
  const [reminderSaving, setReminderSaving] = React.useState(false);

  const handleSaveReminderSchedule = async () => {
    setReminderSaving(true);
    try {
      await setSettings({ ...settings, lineupReminderDay: reminderDay, lineupReminderHour: reminderHour, lineupReminderMinute: reminderMinute });
      dialog.showToast(`✓ Lineup reminders send ${DAY_NAMES[reminderDay]} at ${fmtETTime(reminderHour, reminderMinute)} ET`, 'success');
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

  // ── Draft modal ──
  const [showDraftModal, setShowDraftModal] = React.useState(false);

  return (
    <>
      {/* ── Season Settings ── */}
      <div style={S.section}>
        <button
          onClick={() => { setSettingsOpen(o => !o); setSettingsDraft(null); }}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
          aria-expanded={settingsOpen}
        >
          <div style={S.title}>⚙️ Season Settings</div>
          <span style={{ fontFamily: fonts.sans, fontSize: 11, color: colors.textMuted, paddingBottom: 12 }}>
            {settingsOpen ? '▲ close' : '▼ edit'}
          </span>
        </button>
        {settingsOpen && (() => {
          const isEditing = settingsDraft !== null && typeof settingsDraft === 'object';
          const draft = settingsDraft || getSettingsDraft();
          const set = (key, val) => setSettingsDraft({ ...(settingsDraft || getSettingsDraft()), [key]: val });

          const numInput = (key, label, min = 0, dollar = false) => (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <label style={{ fontFamily: fonts.sans, fontSize: 10, color: colors.textMuted, letterSpacing: '0.5px', textTransform: 'uppercase' }}>
                {label}
              </label>
              <div style={{ position: 'relative' }}>
                {dollar && <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', fontFamily: fonts.mono, fontSize: 13, color: colors.textMuted, pointerEvents: 'none' }}>$</span>}
                <input
                  type="number" min={min} value={draft[key]} onChange={e => set(key, Number(e.target.value))}
                  style={{
                    ...theme.input, marginBottom: 0, fontSize: 13,
                    textAlign: dollar ? 'right' : 'center',
                    paddingLeft: dollar ? 18 : undefined, width: '100%',
                    border: isEditing ? '1px solid rgba(220,170,60,0.5)' : undefined,
                  }}
                />
              </div>
            </div>
          );

          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 4 }}>
              <div style={{ ...theme.smallText, color: colors.textMuted }}>
                ⚠️ Changes apply immediately to all league calculations.
              </div>

              <div>
                <div style={{ fontFamily: fonts.sans, fontSize: 10, fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', color: colors.textGold, marginBottom: 8 }}>
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
                <div style={{ fontFamily: fonts.sans, fontSize: 10, fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', color: colors.textGold, marginBottom: 8 }}>
                  Transaction Fees ($)
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {numInput('feeFA', 'Free Agent', 0, true)}
                  {numInput('feeWaiver', 'Waiver Claim', 0, true)}
                </div>
              </div>

              <div>
                <div style={{ fontFamily: fonts.sans, fontSize: 10, fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', color: colors.textGold, marginBottom: 8 }}>
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
                    style={{ ...S.btn, flex: 1, ...disabledBtn(settingsSaving) }}
                  >
                    {settingsSaving ? '⏳ Saving…' : '✓ Save Season Settings'}
                  </button>
                  <button
                    onClick={() => setSettingsDraft(null)}
                    style={{ ...theme.btnSecondary, flex: 0, padding: '10px 16px', whiteSpace: 'nowrap' }}
                  >
                    Discard
                  </button>
                </div>
              )}
            </div>
          );
        })()}
      </div>

      {/* ── Waiver Schedule ── */}
      <div style={S.section}>
        <div style={S.title}>🗓️ Waiver Schedule</div>
        <div style={{ ...theme.smallText, color: colors.textSecondary, marginBottom: 12 }}>
          Set the day and time (ET) that waiver claims are processed each week. Default is Tuesday at 8:00 PM ET.
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <label style={S.lbl}>Day</label>
            <select value={waiverDay} onChange={e => setWaiverDay(Number(e.target.value))} style={S.select}>
              {DAY_NAMES.map((d, i) => <option key={i} value={i}>{d}</option>)}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label style={S.lbl}>Hour (ET)</label>
            <select value={waiverHour} onChange={e => setWaiverHour(Number(e.target.value))} style={S.select}>
              {Array.from({ length: 24 }, (_, i) => (
                <option key={i} value={i}>
                  {i === 0 ? '12 AM' : i < 12 ? `${i} AM` : i === 12 ? '12 PM' : `${i - 12} PM`}
                </option>
              ))}
            </select>
          </div>
          <div style={{ flex: '0 0 80px' }}>
            <label style={S.lbl}>Minute</label>
            <select value={waiverMinute} onChange={e => setWaiverMinute(Number(e.target.value))} style={S.select}>
              {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map(m => (
                <option key={m} value={m}>:{String(m).padStart(2, '0')}</option>
              ))}
            </select>
          </div>
        </div>
        <div style={{ ...theme.smallText, color: colors.textGoldDim, marginBottom: 10 }}>
          Current: waivers process {DAY_NAMES[waiverDay]} at {fmtETTime(waiverHour, waiverMinute)} ET
          {waiverHasUnsavedChanges && (
            <span style={{ color: colors.warning }}> · unsaved changes</span>
          )}
        </div>
        <button
          onClick={handleSaveWaiverSchedule}
          disabled={waiverSaving}
          style={{ ...S.btn, ...disabledBtn(waiverSaving) }}
        >
          {waiverSaving ? '⏳ Saving…' : '💾 Save Waiver Schedule'}
        </button>
      </div>

      {/* ── Results Schedule ── */}
      <div style={S.section}>
        <div style={S.title}>🏆 Results Schedule</div>
        <div style={{ ...theme.smallText, color: colors.textSecondary, marginBottom: 12 }}>
          Set the day and time (ET) that tournament results are auto-processed each week. Default is Monday at 9:00 AM ET. The commish manual "Process Results" button in the Tournament Results panel is a backup for when this auto-process needs to be overridden.
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <label style={S.lbl}>Day</label>
            <select value={resultsDay} onChange={e => setResultsDay(Number(e.target.value))} style={S.select}>
              {DAY_NAMES.map((d, i) => <option key={i} value={i}>{d}</option>)}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label style={S.lbl}>Hour (ET)</label>
            <select value={resultsHour} onChange={e => setResultsHour(Number(e.target.value))} style={S.select}>
              {Array.from({ length: 24 }, (_, i) => (
                <option key={i} value={i}>
                  {i === 0 ? '12 AM' : i < 12 ? `${i} AM` : i === 12 ? '12 PM' : `${i - 12} PM`}
                </option>
              ))}
            </select>
          </div>
          <div style={{ flex: '0 0 80px' }}>
            <label style={S.lbl}>Minute</label>
            <select value={resultsMinute} onChange={e => setResultsMinute(Number(e.target.value))} style={S.select}>
              {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map(m => (
                <option key={m} value={m}>:{String(m).padStart(2, '0')}</option>
              ))}
            </select>
          </div>
        </div>
        <div style={{ ...theme.smallText, color: colors.textGoldDim, marginBottom: 10 }}>
          Current: results process {DAY_NAMES[resultsDay]} at {fmtETTime(resultsHour, resultsMinute)} ET
          {resultsHasUnsavedChanges && (
            <span style={{ color: colors.warning }}> · unsaved changes</span>
          )}
        </div>
        <button
          onClick={handleSaveResultsSchedule}
          disabled={resultsSaving}
          style={{ ...S.btn, ...disabledBtn(resultsSaving) }}
        >
          {resultsSaving ? '⏳ Saving…' : '💾 Save Results Schedule'}
        </button>
      </div>

      {/* ── Lineup Reminder Schedule ── */}
      <div style={S.section}>
        <div style={S.title}>⛳ Lineup Reminder Schedule</div>
        <div style={{ ...theme.smallText, color: colors.textSecondary, marginBottom: 12 }}>
          Set the day and time (ET) for lineup-lock reminders. Sent to managers who haven't set a lineup yet for the upcoming tournament. Default is Wednesday at 9:00 AM ET.
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <label style={S.lbl}>Day</label>
            <select value={reminderDay} onChange={e => setReminderDay(Number(e.target.value))} style={S.select}>
              {DAY_NAMES.map((d, i) => <option key={i} value={i}>{d}</option>)}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label style={S.lbl}>Hour (ET)</label>
            <select value={reminderHour} onChange={e => setReminderHour(Number(e.target.value))} style={S.select}>
              {Array.from({ length: 24 }, (_, i) => (
                <option key={i} value={i}>
                  {i === 0 ? '12 AM' : i < 12 ? `${i} AM` : i === 12 ? '12 PM' : `${i - 12} PM`}
                </option>
              ))}
            </select>
          </div>
          <div style={{ flex: '0 0 80px' }}>
            <label style={S.lbl}>Minute</label>
            <select value={reminderMinute} onChange={e => setReminderMinute(Number(e.target.value))} style={S.select}>
              {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map(m => (
                <option key={m} value={m}>:{String(m).padStart(2, '0')}</option>
              ))}
            </select>
          </div>
        </div>
        <div style={{ ...theme.smallText, color: colors.textGoldDim, marginBottom: 10 }}>
          Current: reminders send {DAY_NAMES[reminderDay]} at {fmtETTime(reminderHour, reminderMinute)} ET
          {reminderHasUnsavedChanges && (
            <span style={{ color: colors.warning }}> · unsaved changes</span>
          )}
        </div>
        <button
          onClick={handleSaveReminderSchedule}
          disabled={reminderSaving}
          style={{ ...S.btn, ...disabledBtn(reminderSaving) }}
        >
          {reminderSaving ? '⏳ Saving…' : '💾 Save Reminder Schedule'}
        </button>
      </div>

      {/* Cron-schedule note ─────────────────────────────────────────────
          Important caveat: these times act as a GATE inside the cron action,
          not a trigger. cron-job.org has to be pinging the URL at-or-before
          your configured time for the action to fire then. If the ping
          schedule is sparser than this granularity, the action runs at the
          next ping after your configured time, not exactly at it. */}
      <div style={{
        ...S.section,
        background: 'rgba(100,160,255,0.04)',
        border: '1px solid rgba(100,160,255,0.2)',
      }}>
        <div style={{ ...theme.smallText, color: colors.textSecondary }}>
          <strong style={{ color: 'rgba(100,160,255,0.95)' }}>Note:</strong> Times above act as gates inside the scheduled cron job — cron-job.org must be pinging the SFGL URL at-or-before your configured time for the action to fire then. If you change the time and the corresponding cron-job.org schedule is sparser, expect the action to run at the next ping after your configured time rather than exactly at it.
        </div>
      </div>

      {/* ── Draft ── */}
      <div style={S.section}>
        <div style={S.title}>🎯 Draft</div>
        <button onClick={() => setShowDraftModal(true)} style={S.btn}>
          Open Draft Room
        </button>
      </div>

      {showDraftModal && (
        <DraftModal
          teams={teams}
          allPlayers={allPlayers}
          updateTeams={updateTeams}
          onClose={() => setShowDraftModal(false)}
          headshots={headshots}
        />
      )}
    </>
  );
};
