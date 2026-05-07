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
