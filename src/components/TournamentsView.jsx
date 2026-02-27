import React, { useState, useEffect } from 'react';
import { Calendar, Trophy, Edit2, Save } from 'lucide-react';
import { useDialog } from './DialogContext';

// SWINGS defined locally (4 swings only)
const SWINGS = ['West Coast Swing', 'Spring Swing', 'Summer Swing', 'Fall Finish'];
import { theme, colors, fonts } from '../theme.js';
import { SWING_COLORS } from '../theme.js';
import { storage } from '../api';
import { sfglDataApi } from '../api/supabase';
import { STORAGE_KEYS } from '../constants';

const ALTERNATE_KEYWORDS = ['Puerto Rico', 'Zurich', 'Corales', 'Myrtle Beach', 'ISCO', 'Barracuda'];

const isAlternate = (t) => {
  if (t.isAlternate !== undefined) return t.isAlternate;
  return ALTERNATE_KEYWORDS.some(kw => t.name.includes(kw));
};

// Swing → accent color
const swingColor = (swing, dateStr) => {
  if (swing && SWING_COLORS[swing]) return SWING_COLORS[swing];
  if (!dateStr) return colors.textSecondary;
  const month = dateStr.split(' ')[0];
  if (['Jan', 'Feb', 'Mar'].includes(month))  return SWING_COLORS['West Coast Swing'];
  if (['Apr', 'May', 'Jun'].includes(month))  return SWING_COLORS['Spring Swing'];
  if (['Jul', 'Aug', 'Sep'].includes(month))  return SWING_COLORS['Summer Swing'];
  return SWING_COLORS['Fall Finish'];
};

export const TournamentsView = ({ tournaments, isCommissioner, setTournaments, firstTeeTime }) => {
  const [editMode,         setEditMode]         = useState(false);
  const [localTournaments, setLocalTournaments] = useState([]);
  const dialog = useDialog();

  useEffect(() => { setLocalTournaments(tournaments); }, [tournaments]);

  const formatTeeTime = (date) => {
    if (!date) return '';
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const hours = date.getHours(); const minutes = date.getMinutes();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    return `${days[date.getDay()]} ${hours % 12 || 12}:${minutes.toString().padStart(2, '0')} ${ampm} ET`;
  };

  const activeTournament = localTournaments.find(t => t.playing && !t.completed);

  const saveChanges = async () => {
    setTournaments(localTournaments);
    setEditMode(false);
    try {
      await storage.set(STORAGE_KEYS.TOURNAMENTS, localTournaments);
    } catch (e) {
      console.error('storage.set tournaments failed:', e);
    }
    try {
      await sfglDataApi.set(STORAGE_KEYS.TOURNAMENTS, localTournaments);
    } catch (e) {
      console.error('sfglDataApi.set tournaments failed:', e);
    }
    dialog.showToast('Schedule updated!', 'success');
  };

  const updateLocal = (index, patch) => {
    setLocalTournaments(prev => prev.map((t, i) => i === index ? { ...t, ...patch } : t));
  };

  const completed = [...localTournaments.filter(t =>  t.completed)].reverse();
  const upcoming  = localTournaments.filter(t => !t.completed);

  // ── Status badge component ──
  const StatusBadge = ({ tournament }) => {
    const isActive = tournament.playing && !tournament.completed;
    if (!isActive) return null;

    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 3,
        fontSize: 9, fontFamily: fonts.sans, fontWeight: 600,
        padding: '2px 6px', borderRadius: 3,
        background: 'rgba(80,200,120,0.15)',
        border: '1px solid rgba(80,200,120,0.4)',
        color: 'rgba(80,200,120,0.9)',
        whiteSpace: 'nowrap',
      }}>
        In Progress
      </span>
    );
  };

  const renderTable = (list) => (
    <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
      {!editMode && (
        <colgroup>
          <col style={{ width: 26 }} />
          <col />
          <col style={{ width: 70 }} />
          <col style={{ width: '34%' }} />
        </colgroup>
      )}
      <thead>
        <tr>
          {editMode ? (
            ['Active', 'Type', 'Tournament', 'Dates', 'Location / Course', 'Swing', 'Lock'].map(h => (
              <th key={h} style={{ ...theme.tableHeaderCell, fontSize: 10 }}>{h}</th>
            ))
          ) : (
            [{ label: '' }, { label: 'Tournament' }, { label: 'Dates' }, { label: 'Location' }].map(({ label }) => (
              <th key={label || 'badge'} style={{ ...theme.tableHeaderCell, textAlign: 'left', padding: '8px 6px' }}>{label}</th>
            ))
          )}
        </tr>
      </thead>
      <tbody>
        {list.map(t => {
          const realIndex = localTournaments.findIndex(lt => lt.name === t.name);
          const alt = isAlternate(t);

          if (editMode) {
            return (
              <tr key={t.name}
                style={{ borderBottom: `1px solid ${colors.borderSubtle}` }}
                onMouseEnter={e => { e.currentTarget.style.background = colors.rowHover; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
              >
                {/* Active checkbox */}
                <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                  <input
                    type="checkbox"
                    checked={t.playing && !t.completed}
                    onChange={e => {
                      const updated = localTournaments.map(x => ({ ...x, playing: false }));
                      if (e.target.checked && !t.completed) updated[realIndex].playing = true;
                      setLocalTournaments(updated);
                    }}
                    style={{ accentColor: colors.textGold, width: 14, height: 14, cursor: 'pointer' }}
                  />
                </td>

                {/* Type toggle badges */}
                <td style={{ padding: '8px 8px' }}>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {[
                      { badge: 'S', key: 'isSignature', activeColor: 'rgba(130,80,200,0.8)', activeBorder: 'rgba(130,80,200,0.5)' },
                      { badge: 'M', key: 'isMajor',     activeColor: colors.textGold,         activeBorder: colors.border },
                      { badge: 'Alt', key: 'isAlternate', activeColor: colors.danger,           activeBorder: colors.dangerBorder },
                    ].map(({ badge, key, activeColor, activeBorder }) => {
                      const active = t[key];
                      return (
                        <button key={badge} onClick={() => updateLocal(realIndex, { [key]: !active })}
                          style={{
                            width: badge === 'Alt' ? 28 : 22, height: 22,
                            borderRadius: 2, fontFamily: fonts.sans,
                            fontSize: 9, fontWeight: 700, cursor: 'pointer',
                            transition: 'all 0.15s',
                            background: active ? `rgba(${activeColor}, 0.15)` : 'rgba(255,255,255,0.04)',
                            border: `1px solid ${active ? activeBorder : colors.borderSubtle}`,
                            color: active ? activeColor : colors.textMuted,
                          }}
                        >
                          {badge}
                        </button>
                      );
                    })}
                  </div>
                </td>

                {/* Name input */}
                <td style={{ padding: '8px 8px' }}>
                  <input
                    value={t.name}
                    onChange={e => updateLocal(realIndex, { name: e.target.value })}
                    style={{
                      background: 'transparent',
                      border: 'none', borderBottom: `1px solid ${colors.borderInput}`,
                      width: '100%', fontFamily: fonts.sans, fontSize: 12,
                      color: colors.textPrimary, outline: 'none', padding: '2px 0',
                    }}
                    onFocus={e => { e.target.style.borderBottomColor = colors.borderFocus; }}
                    onBlur={e => { e.target.style.borderBottomColor = colors.borderInput; }}
                  />
                </td>

                {/* Dates input */}
                <td style={{ padding: '8px 8px' }}>
                  <input
                    value={t.dates || ''}
                    onChange={e => updateLocal(realIndex, { dates: e.target.value })}
                    placeholder="e.g. Mar 4-7"
                    style={{
                      background: 'transparent',
                      border: 'none', borderBottom: `1px solid ${colors.borderInput}`,
                      width: '100%', fontFamily: fonts.sans, fontSize: 11,
                      color: colors.textPrimary, outline: 'none', padding: '2px 0',
                      minWidth: 80,
                    }}
                    onFocus={e => { e.target.style.borderBottomColor = colors.borderFocus; }}
                    onBlur={e => { e.target.style.borderBottomColor = colors.borderInput; }}
                  />
                </td>

                {/* Location input */}
                <td style={{ padding: '8px 8px' }}>
                  <input
                    value={t.location || ''}
                    onChange={e => updateLocal(realIndex, { location: e.target.value })}
                    placeholder="City, State"
                    style={{
                      background: 'transparent',
                      border: 'none', borderBottom: `1px solid ${colors.borderInput}`,
                      width: '100%', fontFamily: fonts.sans, fontSize: 11,
                      color: colors.textPrimary, outline: 'none', padding: '2px 0',
                      minWidth: 100,
                    }}
                    onFocus={e => { e.target.style.borderBottomColor = colors.borderFocus; }}
                    onBlur={e => { e.target.style.borderBottomColor = colors.borderInput; }}
                  />
                  <input
                    value={t.course || ''}
                    onChange={e => updateLocal(realIndex, { course: e.target.value })}
                    placeholder="Course name"
                    style={{
                      background: 'transparent',
                      border: 'none', borderBottom: `1px solid ${colors.borderInput}`,
                      width: '100%', fontFamily: fonts.sans, fontSize: 10,
                      color: colors.textSecondary, outline: 'none', padding: '2px 0',
                      marginTop: 3,
                    }}
                    onFocus={e => { e.target.style.borderBottomColor = colors.borderFocus; }}
                    onBlur={e => { e.target.style.borderBottomColor = colors.borderInput; }}
                  />
                </td>

                {/* Swing selector */}
                <td style={{ padding: '8px 8px' }}>
                  <select
                    value={t.segment || ''}
                    onChange={e => updateLocal(realIndex, { segment: e.target.value || null })}
                    style={{
                      ...theme.select,
                      fontSize: 11,
                      padding: '5px 8px',
                      background: '#0d1b2e',
                      color: colors.textPrimary,
                      appearance: 'none',
                      WebkitAppearance: 'none',
                      minWidth: 110,
                    }}
                  >
                    <option value="">— derived —</option>
                    {SWINGS.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </td>

                {/* Lock hour override */}
                <td style={{ padding: '8px 8px' }}>
                  <select
                    value={t.lockHour ?? 7}
                    onChange={e => updateLocal(realIndex, { lockHour: parseInt(e.target.value) })}
                    style={{
                      ...theme.select,
                      fontSize: 11,
                      padding: '5px 8px',
                      background: '#0d1b2e',
                      color: colors.textPrimary,
                      appearance: 'none',
                      WebkitAppearance: 'none',
                      minWidth: 90,
                    }}
                  >
                    {[7, 8, 9, 10, 11, 12].map(h => (
                      <option key={h} value={h}>{h === 12 ? '12:00 PM' : `${h}:00 AM`}{h === 7 ? ' (default)' : ''}</option>
                    ))}
                  </select>
                </td>
              </tr>
            );
          }

          // ── Read-only row ──
          return (
            <tr key={t.name}
              style={{
                borderBottom: `1px solid ${colors.borderSubtle}`,
                opacity: alt ? 0.45 : 1,
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = colors.rowHover; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
            >
              {/* Badge column */}
              <td style={{ padding: '8px 2px 8px 8px', verticalAlign: 'middle' }}>
                {t.isMajor && (
                  <div style={{ width: 18, height: 18, borderRadius: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 8, fontWeight: 800, background: 'rgba(160,110,240,0.18)', border: '1px solid rgba(160,110,240,0.65)', color: 'rgba(250,200,80,0.98)' }}>M</div>
                )}
                {t.isSignature && !t.isMajor && (
                  <div style={{ width: 18, height: 18, borderRadius: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 8, fontWeight: 600, background: 'rgba(150,115,230,0.16)', border: '1px solid rgba(160,125,240,0.6)', color: 'rgba(195,170,255,0.92)' }}>S</div>
                )}
              </td>

              {/* Tournament name */}
              <td style={{ padding: '8px 8px' }}>
                <span style={{
                  fontFamily: fonts.serif, fontSize: 13,
                  color: alt ? colors.textMuted : colors.textPrimary,
                  display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                  overflow: 'hidden', lineHeight: 1.35,
                }}>
                  {t.name}
                  {t.completed && (
                    <span style={{ fontSize: 12, color: colors.textMuted, marginLeft: 4 }}>✓</span>
                  )}
                </span>
              </td>

              {/* Dates — or "In Progress" badge for active tournament */}
              <td style={{ padding: '8px 6px', whiteSpace: 'nowrap' }}>
                {t.playing && !t.completed ? (
                  <StatusBadge tournament={t} />
                ) : (
                  <span style={{ fontFamily: fonts.sans, fontSize: 11, color: alt ? colors.textMuted : swingColor(t.segment, t.dates) }}>
                    {t.dates}
                  </span>
                )}
              </td>

              {/* Location + course */}
              <td style={{ padding: '8px 8px 8px 6px' }}>
                <div style={{
                  fontFamily: fonts.sans, fontSize: 10, color: alt ? colors.textMuted : colors.textSecondary,
                  display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                  overflow: 'hidden', lineHeight: 1.4,
                }}>
                  {t.location}
                  {t.course && t.course !== 'TBD' && (
                    <span style={{ color: colors.textMuted }}> · {t.course}</span>
                  )}
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* ── Page header ── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <h2 style={theme.h1}>2026 Season Schedule</h2>
        </div>
        {isCommissioner && (
          <button
            onClick={() => editMode ? saveChanges() : setEditMode(true)}
            style={{
              ...(editMode ? theme.btnPrimary : theme.btnSecondary),
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '8px 14px', flexShrink: 0,
            }}
          >
            {editMode
              ? <><Save style={{ width: 12, height: 12 }} /> Save Changes</>
              : <><Edit2 style={{ width: 12, height: 12 }} /> Edit Schedule</>
            }
          </button>
        )}
      </div>

      {/* ── Upcoming ── */}
      <div style={theme.card}>
        <div style={theme.cardHeader}>
          <Calendar style={{ width: 15, height: 15, color: colors.textPrimary }} />
          <h2 style={theme.h2}>Upcoming Events</h2>
        </div>
        <div style={{ overflowX: 'auto' }}>{renderTable(upcoming)}</div>
      </div>

      {/* ── Completed ── */}
      {completed.length > 0 && (
        <div style={theme.card}>
          <div style={theme.cardHeader}>
            <Trophy style={{ width: 15, height: 15, color: colors.textGold }} />
            <h2 style={theme.h2}>Completed Tournaments</h2>
          </div>
          <div style={{ overflowX: 'auto' }}>{renderTable(completed)}</div>
        </div>
      )}
    </div>
  );
};
