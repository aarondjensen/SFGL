// src/pages/admin/ScheduleImportPanel.jsx
// ============================================================================
// Bulk import a season's PGA Tour schedule from pgatour.com.
//
// Workflow:
//   1. Commish enters target year (defaults to next year)
//   2. "Fetch from PGA Tour" — calls /api/pga-schedule?season=YYYY
//   3. Preview table renders with auto-detected S/M/Alt flags + per-row
//      "Include" checkbox (defaults: include unless already in current
//      schedule by tournament ID).
//   4. Commish can toggle Include / S / M / Alt / swing override / lock hour
//      per row, plus edit the auto-detected name / dates / location / course.
//   5. "Replace 2026 schedule with N tournaments" — wipes current
//      `tournaments` collection and writes new entries via tournamentsApi.setAll.
//      Heavy double-confirm because this is destructive.
//
// SAFETY: this panel will not import on top of a season where ANY tournament
// has `completed: true`. The commish must explicitly archive the current
// season first (TODO: a separate "Archive Season" workflow not built yet).
// For the first 2026 → 2027 rollover we're punting on archive infrastructure
// and assuming the commish has manually backed up the data.
//
// Wave J Round 6 follow-up: restyled to modal-feel — flat container, lighter
// banners, lifted buttons. The preview table itself is preserved (table is
// the right pattern for dense tabular review; flattening it would hurt
// usability). Just refreshed its chrome to match the new aesthetic.
// ============================================================================

import React, { useState, useMemo } from 'react';
import { useDialog } from '../DialogContext';
import { theme, colors, fonts, SWINGS } from '../../theme.js';
import { tournamentsApi } from '../../api/firebase';
import { M, disabledBtn } from './adminStyles';

export const ScheduleImportPanel = ({ tournaments = [], setTournaments }) => {
  const dialog = useDialog();

  // Year selector — defaults to "next year" relative to today. In May 2026 →
  // defaults to 2027. We let the commish override (e.g. for testing with the
  // current year, or for backfilling a historical season).
  const defaultYear = new Date().getFullYear() + 1;
  const [year, setYear] = useState(defaultYear);

  // Fetch / parse state
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState(null);
  const [fetchWarnings, setFetchWarnings] = useState([]);
  const [previewRows, setPreviewRows] = useState([]);  // editable copy of fetched data
  const [importing, setImporting] = useState(false);

  // Track which row indices the user is currently expanding to edit details
  const [expanded, setExpanded] = useState(new Set());
  const toggleExpand = (i) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  };

  // Existing tournament IDs in the current schedule — used to default the
  // "Include" checkbox: if an event already exists by ID, don't auto-include
  // it (avoids accidentally double-importing the same event during testing).
  const existingNames = useMemo(
    () => new Set((tournaments || []).map(t => String(t.name || '').trim().toLowerCase())),
    [tournaments]
  );

  // Whether the current schedule has ANY completed events — if so, we should
  // refuse to import without an archive step (which we don't have yet).
  // For 2026→2027 the commish will manually archive first.
  const hasCompletedEvents = (tournaments || []).some(t => t.completed);

  const handleFetch = async () => {
    if (!year || year < 2000 || year > 2100) {
      dialog.showToast('Please enter a valid year (e.g. 2027)', 'error');
      return;
    }
    setFetching(true);
    setFetchError(null);
    setFetchWarnings([]);
    setPreviewRows([]);
    try {
      const resp = await fetch(`/api/pga-schedule?season=${year}`);
      const data = await resp.json();
      if (!resp.ok || data.error) {
        setFetchError(data.error || `HTTP ${resp.status}`);
        setFetchWarnings(data.warnings || []);
        return;
      }
      const rows = (data.tournaments || []).map(t => ({
        ...t,
        include: !existingNames.has(String(t.name || '').trim().toLowerCase()),
        segment: null,
        lockHour: 7,
      }));
      setPreviewRows(rows);
      setFetchWarnings(data.warnings || []);
      if (rows.length === 0) {
        setFetchError(`No tournaments returned for ${year}. PGA Tour may not have published this season yet.`);
      }
    } catch (e) {
      setFetchError(`Network error: ${e.message}`);
    } finally {
      setFetching(false);
    }
  };

  const toggleField = (idx, field) => {
    setPreviewRows(prev => prev.map((r, i) => i === idx ? { ...r, [field]: !r[field] } : r));
  };

  const updateField = (idx, field, value) => {
    setPreviewRows(prev => prev.map((r, i) => i === idx ? { ...r, [field]: value } : r));
  };

  const includeCount = previewRows.filter(r => r.include).length;

  const handleImport = async () => {
    if (includeCount === 0) {
      dialog.showToast('No tournaments selected to import', 'error');
      return;
    }
    if (hasCompletedEvents) {
      const ok = await dialog.showConfirm(
        'Current schedule has completed events',
        `The current schedule contains tournaments with processed results. Replacing it will REMOVE those completed events from the app. You should archive the current season before importing.\n\nProceed anyway?`,
        { type: 'danger', confirmText: 'Proceed and overwrite', cancelText: 'Cancel' }
      );
      if (!ok) return;
    }
    const confirmed = await dialog.showConfirm(
      `Import ${year} schedule?`,
      `This will REPLACE the current schedule with ${includeCount} tournament(s) from PGA Tour. All current tournament data (including completed events, lineups, results) will be removed from Firestore.\n\nThis cannot be undone.`,
      { type: 'danger', confirmText: `Replace with ${year} schedule`, cancelText: 'Cancel' }
    );
    if (!confirmed) return;

    setImporting(true);
    try {
      const toWrite = previewRows
        .filter(r => r.include)
        .map(r => {
          const { include, _raw, ...keep } = r;
          return {
            ...keep,
            start_date: r.startDate || '',
            completed: false,
            playing: false,
            results: null,
          };
        });
      await tournamentsApi.setAll(toWrite);
      setTournaments(toWrite);
      dialog.showToast(`Imported ${toWrite.length} tournaments for ${year}`, 'success');
      setPreviewRows([]);
      setExpanded(new Set());
    } catch (e) {
      console.error('Schedule import failed:', e);
      dialog.showToast(`Import failed: ${e.message || 'unknown error'}`, 'error');
    } finally {
      setImporting(false);
    }
  };

  return (
    <div style={M.page}>
      <div style={M.descText}>
        Pulls the full PGA Tour schedule from pgatour.com so you don't have to type each tournament by hand. Review the preview, toggle flags, then import. <strong style={{ color: colors.textPrimary }}>This replaces the current schedule</strong> — back up completed-event data first.
      </div>

      {/* Year + Fetch */}
      <div style={M.group}>
        <div style={M.eyebrow}>Season</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
          <input
            type="number"
            min="2000"
            max="2100"
            value={year}
            onChange={e => setYear(parseInt(e.target.value, 10) || defaultYear)}
            style={{ ...M.input, width: 110, fontSize: 16, flexShrink: 0 }}
          />
          <button
            onClick={handleFetch}
            disabled={fetching}
            className="modal-feel-lift modal-feel-primary"
            style={{ ...M.btnPrimary, flex: 1, ...disabledBtn(fetching) }}
          >
            {fetching ? '⏳ Fetching…' : '📥 Fetch from PGA Tour'}
          </button>
        </div>
      </div>

      {/* Error banner */}
      {fetchError && (
        <div style={{
          padding: '10px 12px',
          background: 'rgba(220,80,80,0.06)',
          border: '1px solid rgba(220,80,80,0.3)',
          borderRadius: 6,
          fontFamily: fonts.sans,
          fontSize: 12,
          color: 'rgba(255,160,160,0.95)',
          lineHeight: 1.5,
        }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>Could not fetch schedule</div>
          <div>{fetchError}</div>
          {fetchWarnings.length > 0 && (
            <ul style={{ marginTop: 6, paddingLeft: 18, fontSize: 11, color: 'rgba(255,160,160,0.75)' }}>
              {fetchWarnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}
        </div>
      )}

      {/* Preview table */}
      {previewRows.length > 0 && (
        <div style={M.group}>
          <div style={M.eyebrow}>Preview</div>

          {/* Summary bar with select-all / clear-all controls */}
          <div style={{
            ...M.statusRow,
            background: 'rgba(80,195,120,0.06)',
            borderColor: 'rgba(80,195,120,0.3)',
            justifyContent: 'space-between',
            gap: 10,
          }}>
            <span style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.textSecondary }}>
              <strong style={{ color: colors.textPrimary }}>{previewRows.length}</strong> found ·
              <strong style={{ color: colors.textPrimary, marginLeft: 4 }}>{includeCount}</strong> selected for import
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                onClick={() => setPreviewRows(prev => prev.map(r => ({ ...r, include: true })))}
                style={{
                  ...M.btnSecondary,
                  width: 'auto',
                  padding: '4px 10px',
                  fontSize: 11,
                }}
                className="modal-feel-lift"
              >Select all</button>
              <button
                onClick={() => setPreviewRows(prev => prev.map(r => ({ ...r, include: false })))}
                style={{
                  ...M.btnSecondary,
                  width: 'auto',
                  padding: '4px 10px',
                  fontSize: 11,
                }}
                className="modal-feel-lift"
              >Clear all</button>
            </div>
          </div>

          {/* Scraper warnings (separate from fetch errors — these are
              non-fatal notes about data quality in the preview) */}
          {fetchWarnings.length > 0 && (
            <div style={{
              padding: '8px 12px',
              background: 'rgba(220,170,40,0.06)',
              border: '1px solid rgba(220,170,40,0.25)',
              borderRadius: 6,
              fontFamily: fonts.sans,
              fontSize: 11,
              color: 'rgba(220,200,140,0.9)',
              lineHeight: 1.5,
            }}>
              <strong>Notes from scraper:</strong>
              <ul style={{ margin: '4px 0 0 0', paddingLeft: 18 }}>
                {fetchWarnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          )}

          {/* The data table — preserved as a table because rows × columns is
              the right shape for this content. Just modernized chrome. */}
          <div style={{
            maxHeight: 540,
            overflowY: 'auto',
            border: `1px solid ${colors.borderSubtle}`,
            borderRadius: 6,
            background: 'rgba(255,255,255,0.02)',
          }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: fonts.sans, fontSize: 12 }}>
              <thead>
                <tr style={{ background: 'rgba(255,255,255,0.03)', position: 'sticky', top: 0, zIndex: 1 }}>
                  <th style={{ ...theme.tableHeaderCell, padding: '8px 4px', width: 32 }}>✓</th>
                  <th style={{ ...theme.tableHeaderCell, padding: '8px 6px', textAlign: 'left' }}>Tournament</th>
                  <th style={{ ...theme.tableHeaderCell, padding: '8px 6px', textAlign: 'left', width: 110 }}>Dates</th>
                  <th style={{ ...theme.tableHeaderCell, padding: '8px 4px', width: 32 }}>S</th>
                  <th style={{ ...theme.tableHeaderCell, padding: '8px 4px', width: 32 }}>M</th>
                  <th style={{ ...theme.tableHeaderCell, padding: '8px 4px', width: 36 }}>Alt</th>
                  <th style={{ ...theme.tableHeaderCell, padding: '8px 4px', width: 28 }}></th>
                </tr>
              </thead>
              <tbody>
                {previewRows.map((row, i) => {
                  const isExpanded = expanded.has(i);
                  const hasMissing = !row.startDate || !row.location || !row.course;
                  return (
                    <React.Fragment key={i}>
                      <tr style={{
                        borderTop: i === 0 ? 'none' : `1px solid ${colors.borderSubtle}`,
                        background: row.include ? 'transparent' : 'rgba(255,255,255,0.02)',
                        opacity: row.include ? 1 : 0.5,
                      }}>
                        <td style={{ padding: '6px 4px', textAlign: 'center' }}>
                          <input type="checkbox" checked={row.include} onChange={() => toggleField(i, 'include')}
                            style={{ accentColor: colors.earningsGreen, width: 14, height: 14, cursor: 'pointer' }} />
                        </td>
                        <td style={{ padding: '6px', color: colors.textPrimary }}>
                          {row.name}
                          {hasMissing && (
                            <span title="Some fields missing — expand to review"
                              style={{ marginLeft: 6, fontSize: 10, color: 'rgba(220,170,40,0.95)' }}>⚠</span>
                          )}
                        </td>
                        <td style={{ padding: '6px', color: colors.textSecondary, whiteSpace: 'nowrap' }}>
                          {row.dates || <span style={{ color: 'rgba(220,170,40,0.95)' }}>—</span>}
                        </td>
                        {[
                          { key: 'isSignature', label: 'S',   active: 'rgba(130,80,200,0.8)' },
                          { key: 'isMajor',     label: 'M',   active: colors.textGold },
                          { key: 'isAlternate', label: 'Alt', active: colors.danger },
                        ].map(({ key, label, active }) => (
                          <td key={key} style={{ padding: '6px 4px', textAlign: 'center' }}>
                            <button onClick={() => toggleField(i, key)}
                              style={{
                                width: 24, height: 24, borderRadius: 4,
                                fontFamily: fonts.sans, fontSize: 10, fontWeight: 700,
                                cursor: 'pointer',
                                background: row[key] ? 'rgba(255,255,255,0.05)' : 'transparent',
                                border: `1px solid ${row[key] ? active : colors.borderSubtle}`,
                                color: row[key] ? active : colors.textMuted,
                                transition: 'background 0.15s, border-color 0.15s',
                              }}>
                              {label}
                            </button>
                          </td>
                        ))}
                        <td style={{ padding: '6px 4px', textAlign: 'center' }}>
                          <button onClick={() => toggleExpand(i)}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.textMuted, fontSize: 12 }}>
                            {isExpanded ? '▲' : '▼'}
                          </button>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr style={{ background: 'rgba(255,255,255,0.02)' }}>
                          <td colSpan={7} style={{ padding: '12px 14px' }}>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                              <label style={{ fontSize: 11, color: colors.textMuted }}>
                                Name
                                <input value={row.name || ''} onChange={e => updateField(i, 'name', e.target.value)}
                                  style={{ ...M.input, marginTop: 2, fontSize: 14 }} />
                              </label>
                              <label style={{ fontSize: 11, color: colors.textMuted }}>
                                Dates (display)
                                <input value={row.dates || ''} onChange={e => updateField(i, 'dates', e.target.value)}
                                  style={{ ...M.input, marginTop: 2, fontSize: 14 }} />
                              </label>
                              <label style={{ fontSize: 11, color: colors.textMuted }}>
                                Location
                                <input value={row.location || ''} onChange={e => updateField(i, 'location', e.target.value)}
                                  style={{ ...M.input, marginTop: 2, fontSize: 14 }} />
                              </label>
                              <label style={{ fontSize: 11, color: colors.textMuted }}>
                                Course
                                <input value={row.course || ''} onChange={e => updateField(i, 'course', e.target.value)}
                                  style={{ ...M.input, marginTop: 2, fontSize: 14 }} />
                              </label>
                              <label style={{ fontSize: 11, color: colors.textMuted }}>
                                Start date (ISO)
                                <input value={row.startDate || ''} onChange={e => updateField(i, 'startDate', e.target.value)}
                                  placeholder="YYYY-MM-DD"
                                  style={{ ...M.input, marginTop: 2, fontSize: 14 }} />
                              </label>
                              <label style={{ fontSize: 11, color: colors.textMuted }}>
                                End date (ISO)
                                <input value={row.endDate || ''} onChange={e => updateField(i, 'endDate', e.target.value)}
                                  placeholder="YYYY-MM-DD"
                                  style={{ ...M.input, marginTop: 2, fontSize: 14 }} />
                              </label>
                              <label style={{ fontSize: 11, color: colors.textMuted }}>
                                Swing override
                                <select value={row.segment || ''} onChange={e => updateField(i, 'segment', e.target.value || null)}
                                  style={{ ...M.select, marginTop: 2, fontSize: 14, padding: '8px 10px' }}>
                                  <option value="">— derived from dates —</option>
                                  {SWINGS.map(s => <option key={s} value={s}>{s}</option>)}
                                </select>
                              </label>
                              <label style={{ fontSize: 11, color: colors.textMuted }}>
                                Lock hour (ET)
                                <select value={row.lockHour ?? 7} onChange={e => updateField(i, 'lockHour', parseInt(e.target.value, 10))}
                                  style={{ ...M.select, marginTop: 2, fontSize: 14, padding: '8px 10px' }}>
                                  {[7, 8, 9, 10, 11, 12].map(h => (
                                    <option key={h} value={h}>
                                      {h === 12 ? '12:00 PM' : `${h}:00 AM`}{h === 7 ? ' (default)' : ''}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            </div>
                            {row.purse && (
                              <div style={{ marginTop: 8, fontSize: 11, color: colors.textMuted }}>
                                Purse from PGA Tour: ${row.purse.toLocaleString()}
                                {row.purse >= 20_000_000 && !row.isMajor && (
                                  <span style={{ marginLeft: 6, color: 'rgba(130,80,200,0.95)' }}>
                                    (auto-flagged as Signature)
                                  </span>
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          <button
            onClick={handleImport}
            disabled={importing || includeCount === 0}
            className="modal-feel-lift modal-feel-danger"
            style={{ ...M.btnDanger, ...disabledBtn(importing || includeCount === 0) }}
          >
            {importing
              ? 'Importing…'
              : hasCompletedEvents
                ? `⚠ Replace current schedule with ${includeCount} tournament(s) (will lose completed events)`
                : `Replace current schedule with ${includeCount} tournament(s)`
            }
          </button>
        </div>
      )}
    </div>
  );
};
