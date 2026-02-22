import React, { useState, useEffect } from 'react';
import { Calendar, Trophy, Edit2, Save } from 'lucide-react';
import { useDialog } from './DialogContext';
// SWINGS defined locally (4 swings only)
const SWINGS = ['West Coast Swing', 'Spring Swing', 'Summer Swing', 'Fall Finish'];
import { theme, colors, fonts } from '../theme.js';
import { storage } from '../api';
import { STORAGE_KEYS } from '../constants';

const ALTERNATE_KEYWORDS = ['Puerto Rico', 'Zurich', 'Corales', 'Myrtle Beach', 'ISCO', 'Barracuda'];

const isAlternate = (t) => {
  if (t.isAlternate !== undefined) return t.isAlternate;
  return ALTERNATE_KEYWORDS.some(kw => t.name.includes(kw));
};

// Swing → accent color
const swingColor = (swing, dateStr) => {
  if (swing) {
    if (swing === 'West Coast Swing') return 'rgba(220,80,80,0.8)';
    if (swing === 'Spring Swing')     return 'rgba(80,180,120,0.8)';
    if (swing === 'Summer Swing')     return 'rgba(80,140,220,0.8)';
    if (swing === 'Fall Finish')      return 'rgba(220,140,60,0.8)';
    return colors.textSecondary;
  }
  if (!dateStr) return colors.textSecondary;
  const month = dateStr.split(' ')[0];
  if (['Jan', 'Feb'].includes(month))        return 'rgba(220,80,80,0.8)';
  if (['Mar', 'Apr', 'May'].includes(month)) return 'rgba(80,180,120,0.8)';
  if (['Jun', 'Jul', 'Aug'].includes(month)) return 'rgba(80,140,220,0.8)';
  return 'rgba(220,140,60,0.8)';
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
    storage.set(STORAGE_KEYS.TOURNAMENTS, localTournaments);
    dialog.showToast('Schedule updated!', 'success');
  };

  const updateLocal = (index, patch) => {
    setLocalTournaments(prev => prev.map((t, i) => i === index ? { ...t, ...patch } : t));
  };

  const completed = [...localTournaments.filter(t =>  t.completed)].reverse();
  const upcoming  = localTournaments.filter(t => !t.completed);

  const renderTable = (list) => (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          {editMode ? (
            ['Active', 'Type', 'Tournament', 'Swing'].map(h => (
              <th key={h} style={theme.tableHeaderCell}>{h}</th>
            ))
          ) : (
            [{ label: '', width: 40 }, { label: 'Tournament' }, { label: 'Dates' }, { label: 'Location & Course' }].map(({ label, width }) => (
              <th key={label} style={{ ...theme.tableHeaderCell, textAlign: 'left', width: width || 'auto' }}>{label}</th>
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
                <td style={{ padding: '8px 16px', textAlign: 'center' }}>
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
                <td style={{ padding: '8px 12px' }}>
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
                <td style={{ padding: '8px 12px' }}>
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
                  <div style={{ ...theme.smallText, marginTop: 2 }}>{t.dates}</div>
                </td>

                {/* Swing selector */}
                <td style={{ padding: '8px 12px' }}>
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
                      minWidth: 120,
                    }}
                  >
                    <option value="">— derived —</option>
                    {SWINGS.map(s => <option key={s} value={s}>{s}</option>)}
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
              <td style={{ padding: '10px 16px', width: 40 }}>
                {t.isMajor && (
                  <div style={{
                    ...theme.badge, ...theme.badgeGold,
                    width: 20, height: 20, borderRadius: 2,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    padding: 0, fontSize: 9,
                  }}>M</div>
                )}
                {t.isSignature && !t.isMajor && (
                  <div style={{
                    ...theme.badge, ...theme.badgeNavy,
                    width: 20, height: 20, borderRadius: 2,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    padding: 0, fontSize: 9,
                  }}>S</div>
                )}
              </td>

              {/* Tournament name */}
              <td style={{ padding: '10px 16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: fonts.serif, fontSize: 13, color: alt ? colors.textMuted : colors.textPrimary }}>
                    {t.name}
                  </span>
                  {t.completed && (
                    <span style={{ ...theme.badge, background: 'rgba(255,255,255,0.05)', border: `1px solid ${colors.borderSubtle}`, color: colors.textSecondary }}>
                      Final
                    </span>
                  )}
                  {t.playing && !t.completed && (
                    <span style={{ ...theme.badge, background: 'rgba(80,180,120,0.1)', border: '1px solid rgba(80,180,120,0.3)', color: colors.success }}>
                      Active
                    </span>
                  )}
                </div>
              </td>

              {/* Dates (colored by swing) */}
              <td style={{ padding: '10px 16px', whiteSpace: 'nowrap' }}>
                <span style={{ fontFamily: fonts.sans, fontSize: 12, color: alt ? colors.textMuted : swingColor(t.segment, t.dates) }}>
                  {t.dates}
                </span>
              </td>

              {/* Location + course */}
              <td style={{ padding: '10px 16px' }}>
                <div style={{ fontFamily: fonts.sans, fontSize: 12, color: alt ? colors.textMuted : colors.textSecondary }}>
                  {t.location}
                </div>
                {t.course && t.course !== 'TBD' && (
                  <div style={{ fontFamily: fonts.sans, fontSize: 10, color: colors.textMuted, marginTop: 1 }}>{t.course}</div>
                )}
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
          {activeTournament && (
            <p style={{ ...theme.bodyText, marginTop: 4 }}>
              Current: <span style={{ color: colors.success, fontFamily: fonts.serif }}>{activeTournament.name}</span>
              {firstTeeTime && <span style={{ color: colors.textMuted }}> · {formatTeeTime(firstTeeTime)}</span>}
            </p>
          )}
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
          <Calendar style={{ width: 15, height: 15, color: colors.textGold }} />
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
