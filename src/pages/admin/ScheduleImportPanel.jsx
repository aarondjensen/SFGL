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
// ============================================================================

import React, { useState, useMemo } from 'react';
import { useDialog } from '../DialogContext';
import { theme, colors, fonts, SWINGS } from '../../theme.js';
import { tournamentsApi } from '../../api/firebase';
import { S, disabledBtn } from './adminStyles';

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
      // Build editable preview rows from the scrape. The `include` default:
      // include only if not already present (by lowercased name match).
      const rows = (data.tournaments || []).map(t => ({
        // Spread first so explicit fields below win
        ...t,
        include: !existingNames.has(String(t.name || '').trim().toLowerCase()),
        // Swing override: blank means "let getSegmentForTournament derive
        // from dates" (same default as the manual edit mode in TournamentsView)
        segment: null,
        // Lock hour: 7 AM ET is the standard default
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

  // Toggle a boolean field on a row (include, isSignature, isMajor, isAlternate).
  const toggleField = (idx, field) => {
    setPreviewRows(prev => prev.map((r, i) => i === idx ? { ...r, [field]: !r[field] } : r));
  };

  // Update any field on a row (used by inline editing inputs).
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
      // Build the tournaments to write. Match the existing tournament shape
      // used in /mnt/project + the edit-mode handlers: name (used as Firestore
      // doc ID), dates (display string), location, course, segment (nullable),
      // lockHour, isSignature/isMajor/isAlternate, and start_date for ordering.
      const toWrite = previewRows
        .filter(r => r.include)
        .map(r => {
          // Drop internal preview fields (include, _raw) before persisting.
          const { include, _raw, ...keep } = r;
          return {
            ...keep,
            // start_date is what tournamentsApi.getAll orders by (firebase.js).
            // Use ISO startDate when available; falls back to alphabetical.
            start_date: r.startDate || '',
            completed: false,
            playing: false,
            results: null,
          };
        });
      await tournamentsApi.setAll(toWrite);
      setTournaments(toWrite);
      dialog.showToast(`Imported ${toWrite.length} tournaments for ${year}`, 'success');
      // Reset the panel so the commish sees the freshly-imported schedule
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
    <div style={S.section}>
      <div style={S.title}>📥 Import Season Schedule</div>
      <div style={{ ...theme.smallText, color: colors.textSecondary, marginBottom: 12 }}>
        Pulls the full PGA Tour schedule from pgatour.com so you don't have to
        type each tournament by hand. Review the preview, toggle flags, then
        import. <strong>This replaces the current schedule</strong> — back up
        completed-event data first.
      </div>

      {/* Year + Fetch button */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <label style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.textSecondary }}>
          Season:
        </label>
        <input
          type="number"
          min="2000" max="2100"
          value={year}
          onChange={e => setYear(parseInt(e.target.value, 10) || defaultYear)}
          style={{ ...S.input, width: 90, marginBottom: 0, fontSize: 16 /* prevent iOS zoom */ }}
        />
        <button
          onClick={handleFetch}
          disabled={fetching}
          style={fetching ? disabledBtn : { ...theme.btnSecondary, padding: '8px 14px', cursor: 'pointer' }}
        >
          {fetching ? 'Fetching…' : 'Fetch from PGA Tour'}
        </button>
      </div>

      {/* Error / warning surface */}
      {fetchError && (
        <div style={{
          padding: '8px 10px', marginBottom: 12,
          background: 'rgba(220,60,60,0.08)',
          border: '1px solid rgba(220,60,60,0.3)',
          borderRadius: 3,
          fontFamily: fonts.sans, fontSize: 12, color: 'rgba(255,160,160,0.95)',
        }}>
          <div style={{ fontWeight: 700, marginBottom: 2 }}>Could not fetch schedule</div>
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
        <>
          <div style={{
            padding: '6px 10px', marginBottom: 8,
            background: 'rgba(80,180,120,0.08)',
            border: '1px solid rgba(80,180,120,0.3)',
            borderRadius: 3,
            fontFamily: fonts.sans, fontSize: 12, color: colors.textSecondary,
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span>
              <strong style={{ color: colors.textPrimary }}>{previewRows.length}</strong> tournaments found.
              <strong style={{ color: colors.textPrimary, marginLeft: 6 }}>{includeCount}</strong> selected for import.
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                onClick={() => setPreviewRows(prev => prev.map(r => ({ ...r, include: true })))}
                style={{ ...theme.btnSecondary, padding: '4px 10px', fontSize: 11, cursor: 'pointer' }}
              >Select all</button>
              <button
                onClick={() => setPreviewRows(prev => prev.map(r => ({ ...r, include: false })))}
                style={{ ...theme.btnSecondary, padding: '4px 10px', fontSize: 11, cursor: 'pointer' }}
              >Clear all</button>
            </div>
          </div>

          {fetchWarnings.length > 0 && (
            <div style={{
              padding: '6px 10px', marginBottom: 8,
              background: 'rgba(220,170,40,0.06)',
              border: '1px solid rgba(220,170,40,0.25)',
              borderRadius: 3,
              fontFamily: fonts.sans, fontSize: 11, color: 'rgba(220,200,140,0.9)',
            }}>
              <strong>Notes from scraper:</strong>
              <ul style={{ margin: '4px 0 0 0', paddingLeft: 18 }}>
                {fetchWarnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          )}

          <div style={{ maxHeight: 540, overflowY: 'auto', border: `1px solid ${colors.borderSubtle}`, borderRadius: 3 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: fonts.sans, fontSize: 12 }}>
              <thead>
                <tr style={{ background: 'rgba(255,255,255,0.04)', position: 'sticky', top: 0, zIndex: 1 }}>
                  <th style={{ ...theme.tableHeaderCell, padding: '6px 4px', width: 32 }}>✓</th>
                  <th style={{ ...theme.tableHeaderCell, padding: '6px 6px', textAlign: 'left' }}>Tournament</th>
                  <th style={{ ...theme.tableHeaderCell, padding: '6px 6px', textAlign: 'left', width: 110 }}>Dates</th>
                  <th style={{ ...theme.tableHeaderCell, padding: '6px 4px', width: 32 }}>S</th>
                  <th style={{ ...theme.tableHeaderCell, padding: '6px 4px', width: 32 }}>M</th>
                  <th style={{ ...theme.tableHeaderCell, padding: '6px 4px', width: 36 }}>Alt</th>
                  <th style={{ ...theme.tableHeaderCell, padding: '6px 4px', width: 28 }}></th>
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
                        <td style={{ padding: '4px 4px', textAlign: 'center' }}>
                          <input type="checkbox" checked={row.include} onChange={() => toggleField(i, 'include')}
                            style={{ accentColor: colors.textGold, width: 14, height: 14, cursor: 'pointer' }} />
                        </td>
                        <td style={{ padding: '4px 6px', color: colors.textPrimary }}>
                          {row.name}
                          {hasMissing && (
                            <span title="Some fields missing — expand to review"
                              style={{ marginLeft: 6, fontSize: 10, color: 'rgba(220,170,40,0.95)' }}>⚠</span>
                          )}
                        </td>
                        <td style={{ padding: '4px 6px', color: colors.textSecondary, whiteSpace: 'nowrap' }}>
                          {row.dates || <span style={{ color: 'rgba(220,170,40,0.95)' }}>—</span>}
                        </td>
                        {/* Flag toggles match the same styling as TournamentsView edit-mode badges */}
                        {[
                          { key: 'isSignature', label: 'S',   active: 'rgba(130,80,200,0.8)' },
                          { key: 'isMajor',     label: 'M',   active: colors.textGold },
                          { key: 'isAlternate', label: 'Alt', active: colors.danger },
                        ].map(({ key, label, active }) => (
                          <td key={key} style={{ padding: '4px 4px', textAlign: 'center' }}>
                            <button onClick={() => toggleField(i, key)}
                              style={{
                                width: 22, height: 22, borderRadius: 2,
                                fontFamily: fonts.sans, fontSize: 10, fontWeight: 700,
                                cursor: 'pointer',
                                background: row[key] ? 'rgba(255,255,255,0.05)' : 'transparent',
                                border: `1px solid ${row[key] ? active : colors.borderSubtle}`,
                                color: row[key] ? active : colors.textMuted,
                              }}>
                              {label}
                            </button>
                          </td>
                        ))}
                        <td style={{ padding: '4px 4px', textAlign: 'center' }}>
                          <button onClick={() => toggleExpand(i)}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.textMuted, fontSize: 12 }}>
                            {isExpanded ? '▲' : '▼'}
                          </button>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr style={{ background: 'rgba(255,255,255,0.02)' }}>
                          <td colSpan={7} style={{ padding: '10px 12px' }}>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                              <label style={{ fontSize: 11, color: colors.textMuted }}>
                                Name
                                <input value={row.name || ''} onChange={e => updateField(i, 'name', e.target.value)}
                                  style={{ ...S.input, marginTop: 2, marginBottom: 0, fontSize: 16 }} />
                              </label>
                              <label style={{ fontSize: 11, color: colors.textMuted }}>
                                Dates (display)
                                <input value={row.dates || ''} onChange={e => updateField(i, 'dates', e.target.value)}
                                  style={{ ...S.input, marginTop: 2, marginBottom: 0, fontSize: 16 }} />
                              </label>
                              <label style={{ fontSize: 11, color: colors.textMuted }}>
                                Location
                                <input value={row.location || ''} onChange={e => updateField(i, 'location', e.target.value)}
                                  style={{ ...S.input, marginTop: 2, marginBottom: 0, fontSize: 16 }} />
                              </label>
                              <label style={{ fontSize: 11, color: colors.textMuted }}>
                                Course
                                <input value={row.course || ''} onChange={e => updateField(i, 'course', e.target.value)}
                                  style={{ ...S.input, marginTop: 2, marginBottom: 0, fontSize: 16 }} />
                              </label>
                              <label style={{ fontSize: 11, color: colors.textMuted }}>
                                Start date (ISO)
                                <input value={row.startDate || ''} onChange={e => updateField(i, 'startDate', e.target.value)}
                                  placeholder="YYYY-MM-DD"
                                  style={{ ...S.input, marginTop: 2, marginBottom: 0, fontSize: 16 }} />
                              </label>
                              <label style={{ fontSize: 11, color: colors.textMuted }}>
                                End date (ISO)
                                <input value={row.endDate || ''} onChange={e => updateField(i, 'endDate', e.target.value)}
                                  placeholder="YYYY-MM-DD"
                                  style={{ ...S.input, marginTop: 2, marginBottom: 0, fontSize: 16 }} />
                              </label>
                              <label style={{ fontSize: 11, color: colors.textMuted }}>
                                Swing override
                                <select value={row.segment || ''} onChange={e => updateField(i, 'segment', e.target.value || null)}
                                  style={{ ...theme.select, marginTop: 2, padding: '5px 8px', fontSize: 14, width: '100%' }}>
                                  <option value="">— derived from dates —</option>
                                  {SWINGS.map(s => <option key={s} value={s}>{s}</option>)}
                                </select>
                              </label>
                              <label style={{ fontSize: 11, color: colors.textMuted }}>
                                Lock hour (ET)
                                <select value={row.lockHour ?? 7} onChange={e => updateField(i, 'lockHour', parseInt(e.target.value, 10))}
                                  style={{ ...theme.select, marginTop: 2, padding: '5px 8px', fontSize: 14, width: '100%' }}>
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
            style={importing || includeCount === 0
              ? disabledBtn
              : { ...theme.btnDanger, width: '100%', marginTop: 12, padding: '10px 16px', cursor: 'pointer' }
            }
          >
            {importing
              ? 'Importing…'
              : hasCompletedEvents
                ? `⚠ Replace current schedule with ${includeCount} tournament(s) (will lose completed events)`
                : `Replace current schedule with ${includeCount} tournament(s)`
            }
          </button>
        </>
      )}
    </div>
  );
};
