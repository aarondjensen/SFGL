import React, { useState, useEffect } from 'react';
import { Calendar, Trophy, Edit2, Save, Lock, Unlock } from 'lucide-react';
import { useDialog } from './DialogContext';
import {
  getTournamentTimezone,
  getLineupLockTime,
  formatLockTime,
  areLineupsLocked,
  TIMEZONE_OPTIONS,
} from '../utils/tournamentTimezones';

// SWINGS defined locally (4 swings only)
const SWINGS = ['West Coast Swing', 'Spring Swing', 'Summer Swing', 'Fall Finish'];
import { theme, colors, fonts } from '../theme.js';
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
  if (swing) {
    if (swing === 'West Coast Swing') return 'rgba(220,80,80,0.8)';
    if (swing === 'Spring Swing')     return 'rgba(100,215,175,0.85)';
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

  // ── Lock time badge component ──
  const LockBadge = ({ tournament }) => {
    const lockTime = getLineupLockTime(tournament);
    const tz = getTournamentTimezone(tournament);
    const locked = areLineupsLocked(tournament);

    if (!lockTime) return null;

    const isActive = tournament.playing && !tournament.completed;
    if (!isActive) {
      // For non-active upcoming tournaments, show lock time quietly
      return (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 4,
          fontSize: 10, fontFamily: fonts.sans, color: colors.textMuted,
          marginTop: 2,
        }}>
          <Lock style={{ width: 9, height: 9 }} />
          <span>Locks {formatLockTime(lockTime, tz)}</span>
        </div>
      );
    }

    // Active tournament — show prominent lock status
    return (
      <div style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        fontSize: 10, fontFamily: fonts.sans, fontWeight: 600,
        padding: '2px 8px', borderRadius: 3,
        background: locked ? 'rgba(220,80,80,0.15)' : 'rgba(80,200,120,0.15)',
        border: `1px solid ${locked ? 'rgba(220,80,80,0.4)' : 'rgba(80,200,120,0.4)'}`,
        color: locked ? 'rgba(220,80,80,0.9)' : 'rgba(80,200,120,0.9)',
        marginTop: 3,
      }}>
        {locked
          ? <><Lock style={{ width: 9, height: 9 }} /> Lineups Locked</>
          : <><Unlock style={{ width: 9, height: 9 }} /> Locks {formatLockTime(lockTime, tz)}</>
        }
      </div>
    );
  };

  const renderTable = (list) => (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          {editMode ? (
            ['Active', 'Type', 'Tournament', 'Swing', 'Timezone'].map(h => (
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
            const detectedTz = getTournamentTimezone({ ...t, timezoneOverride: null });
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

                {/* Timezone override */}
                <td style={{ padding: '8px 12px' }}>
                  <select
                    value={t.timezoneOverride || ''}
                    onChange={e => updateLocal(realIndex, { timezoneOverride: e.target.value || null })}
                    style={{
                      ...theme.select,
                      fontSize: 11,
                      padding: '5px 8px',
                      background: '#0d1b2e',
                      color: colors.textPrimary,
                      appearance: 'none',
                      WebkitAppearance: 'none',
                      minWidth: 130,
                    }}
                  >
                    {TIMEZONE_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>
                        {opt.value === '' ? `Auto (${detectedTz.split('/').pop().replace(/_/g, ' ')})` : opt.label}
                      </option>
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
              <td style={{ padding: '10px 16px', width: 40 }}>
                {t.isMajor && (
                  <div style={{ width: 20, height: 20, borderRadius: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, lineHeight: 1, fontSize: 9, fontWeight: 800, letterSpacing: 0, background: 'rgba(160,110,240,0.18)', border: '1px solid rgba(160,110,240,0.65)', color: 'rgba(250,200,80,0.98)' }}>M</div>
                )}
                {t.isSignature && !t.isMajor && (
                  <div style={{ width: 20, height: 20, borderRadius: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, lineHeight: 1, fontSize: 9, fontWeight: 600, letterSpacing: 0, background: 'rgba(150,115,230,0.16)', border: '1px solid rgba(160,125,240,0.6)', color: 'rgba(195,170,255,0.92)' }}>S</div>
                )}
              </td>

              {/* Tournament name + lock status */}
              <td style={{ padding: '10px 16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: fonts.serif, fontSize: 13, color: alt ? colors.textMuted : (t.playing && !t.completed) ? colors.textGold : colors.textPrimary }}>
                    {t.name}
                  </span>
                  {t.completed && (
                    <span style={{ ...theme.badge, background: 'rgba(255,255,255,0.05)', border: `1px solid ${colors.borderSubtle}`, color: colors.textSecondary }}>
                      Final
                    </span>
                  )}
                </div>
                {!t.completed && <LockBadge tournament={t} />}
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
