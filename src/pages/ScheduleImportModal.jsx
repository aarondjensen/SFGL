import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { slashGolfFetch } from '../utils';
import { FALLBACK_SCHEDULE_DATA } from '../constants';
import { theme, colors, fonts, SWINGS, SWING_COLORS } from '../theme.js';

export const ScheduleImportModal = ({ onImport, onCancel }) => {
  const [loading, setLoading] = useState(false);
  const [editedSchedule, setEditedSchedule] = useState([]);

  useEffect(() => {
    loadSchedule();
  }, []);

  // ── Escape key + body scroll lock ─────────────────────────────────────────
  useEffect(() => {
    document.body.classList.add('sfgl-modal-open');
    const handler = (e) => { if (e.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', handler);
    return () => {
      document.body.classList.remove('sfgl-modal-open');
      document.removeEventListener('keydown', handler);
    };
  }, [onCancel]);

  const parseDate = (dateObj) => {
    if (!dateObj) return null;
    
    // Handle string dates
    if (typeof dateObj === 'string') {
      const d = new Date(dateObj);
      return isNaN(d.getTime()) ? null : d;
    }
    
    // Handle MongoDB extended JSON format: { $date: { $numberLong: "timestamp" } }
    if (typeof dateObj === 'object') {
      if (dateObj.$date) {
        if (dateObj.$date.$numberLong) {
          return new Date(parseInt(dateObj.$date.$numberLong));
        }
        if (typeof dateObj.$date === 'string' || typeof dateObj.$date === 'number') {
          return new Date(dateObj.$date);
        }
      }
      
      // Handle nested date properties
      const dateStr = dateObj.date || dateObj.start || dateObj.end;
      if (dateStr) {
        const d = new Date(dateStr);
        return isNaN(d.getTime()) ? null : d;
      }
    }
    
    return null;
  };

  const formatDates = (startObj, endObj) => {
    const start = parseDate(startObj);
    const end = parseDate(endObj);
    
    if (!start || !end || isNaN(start.getTime()) || isNaN(end.getTime())) {
      return 'TBD';
    }
    
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const sm = MONTHS[start.getMonth()];
    const em = MONTHS[end.getMonth()];
    
    if (sm === em) {
      return `${sm} ${start.getDate()}-${end.getDate()}`;
    } else {
      return `${sm} ${start.getDate()}-${em} ${end.getDate()}`;
    }
  };

  const getSwingBadgeStyle = (swing) => {
    const accent = SWING_COLORS[swing] || 'rgba(255,255,255,0.4)';
    return {
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: 2,
      fontSize: 11,
      fontWeight: 600,
      fontFamily: fonts.sans,
      background: accent.replace('0.85)', '0.12)'),
      color: accent,
    };
  };

  const loadSchedule = async () => {
    setLoading(true);
    try {
      let data = await slashGolfFetch('schedule', { orgId: '1', year: '2026' });
      
      if (!data?.schedule?.length) {
        data = await slashGolfFetch('schedule', { orgId: '1', year: '2025' });
      }
      
      if (!data?.schedule?.length) {
        setLoading(false);
        return;
      }
      
      let tournaments = (data?.schedule || []).map((event, idx) => {
        // API structure: event.date.start and event.date.end
        const startDate = parseDate(event.date?.start || event.startDate);
        const endDate = parseDate(event.date?.end || event.endDate);
        
        // Extract location/course from API first, then fallback to our constants
        let location = 'TBD';
        let courseName = 'TBD';
        const courses = event.courses || [];
        
        if (courses[0]) {
          const course = courses[0];
          courseName = course.courseName || course.name || 'TBD';
          
          if (course.location) {
            const loc = course.location;
            const city = loc.city || '';
            const state = loc.state || '';
            const country = loc.country || '';
            location = [city, state || country].filter(Boolean).join(', ');
          }
        }
        
        // If API didn't provide location/course, use fallback data
        if ((location === 'TBD' || courseName === 'TBD') && event.name) {
          const fallback = FALLBACK_SCHEDULE_DATA.find(fb => 
            event.name.toLowerCase().includes(fb.key.toLowerCase()) ||
            fb.key.toLowerCase().includes(event.name.toLowerCase().split(' ')[0])
          );
          
          if (fallback) {
            if (location === 'TBD') location = fallback.loc;
            if (courseName === 'TBD') courseName = fallback.course;
          }
        }
        
        // Auto-detect majors and signatures
        const isMajor = ['Masters', 'PGA Championship', 'U.S. Open', 'The Open Championship'].some(m => 
          event.name?.includes(m)
        );
        const isSignature = (event.purse || 0) > 15000000 && !isMajor;
        
        return {
          name: event.name || 'Unknown Tournament',
          slashGolfId: event.tournId || event.id || '',
          startDate: startDate?.toISOString() || null,
          endDate: endDate ? (() => { const d = new Date(endDate); d.setHours(23,59,59); return d.toISOString(); })() : null,
          location,
          courseName,
          dates: formatDates(event.date?.start || event.startDate, event.date?.end || event.endDate),
          isSignature,
          isMajor,
          swing: '', // Will be assigned after truncation
          isAlternate: false,
          excluded: false,
          completed: false,
          playing: false,
        };
      });
      
      // Truncate at TOUR Championship (end of fantasy season)
      const tourChampIndex = tournaments.findIndex(t => 
        t.name.toLowerCase().includes('tour championship')
      );
      if (tourChampIndex !== -1) {
        tournaments = tournaments.slice(0, tourChampIndex + 1);
      }
      
      // Auto-assign swings evenly across the season
      const tournamentsPerSwing = Math.ceil(tournaments.length / SWINGS.length);
      
      tournaments.forEach((t, idx) => {
        const swingIndex = Math.min(Math.floor(idx / tournamentsPerSwing), SWINGS.length - 1);
        t.swing = SWINGS[swingIndex];
      });
      
      // Set first non-excluded tournament as active
      const firstActive = tournaments.findIndex(t => !t.excluded);
      if (firstActive !== -1) {
        tournaments[firstActive].playing = true;
      }
      
      setEditedSchedule(tournaments);
    } catch (e) {
      // Schedule load failed — user will see empty state
    }
    setLoading(false);
  };

  const toggleSignature = (idx) => {
    const updated = [...editedSchedule];
    updated[idx].isSignature = !updated[idx].isSignature;
    if (updated[idx].isSignature) updated[idx].isMajor = false;
    setEditedSchedule(updated);
  };

  const toggleMajor = (idx) => {
    const updated = [...editedSchedule];
    updated[idx].isMajor = !updated[idx].isMajor;
    if (updated[idx].isMajor) updated[idx].isSignature = false;
    setEditedSchedule(updated);
  };

  const toggleExclude = (idx) => {
    const updated = [...editedSchedule];
    updated[idx].excluded = !updated[idx].excluded;
    setEditedSchedule(updated);
  };

  const setSwing = (idx, swing) => {
    const updated = [...editedSchedule];
    updated[idx].swing = swing;
    setEditedSchedule(updated);
  };

  const included = editedSchedule.filter(t => !t.excluded);

  // ── Inline styles using theme system ──────────────────────────────────────
  const badgeBtn = (active, accentBg, accentHover) => ({
    width: 28, height: 28, borderRadius: 2,
    fontSize: 11, fontWeight: 700,
    fontFamily: fonts.sans,
    border: 'none', cursor: 'pointer',
    transition: 'background 0.15s',
    background: active ? accentBg : 'rgba(255,255,255,0.06)',
    color: active ? '#fff' : colors.textMuted,
  });

  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'rgba(5,10,25,0.85)', backdropFilter: 'blur(6px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 16, zIndex: 60,
    }}>
      <div style={{
        background: '#0f1d35',
        border: `1px solid ${colors.border}`,
        borderRadius: 3,
        maxWidth: 1100, width: '100%',
        maxHeight: '90vh',
        overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
        boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
      }}>
        {/* Header */}
        <div style={{
          padding: '16px 20px',
          borderBottom: `1px solid ${colors.borderSubtle}`,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <div>
            <h2 style={{ ...theme.h2, marginBottom: 4 }}>Import 2026 Schedule</h2>
            <p style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.textSecondary }}>
              Configure tournament badges and swings before importing
            </p>
          </div>
          <button onClick={onCancel} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: colors.textSecondary, padding: 4, display: 'flex',
            transition: 'color 0.15s',
          }}
            onMouseEnter={e => { e.currentTarget.style.color = colors.textPrimary; }}
            onMouseLeave={e => { e.currentTarget.style.color = colors.textSecondary; }}
          >
            <X style={{ width: 22, height: 22 }} />
          </button>
        </div>
        
        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
          {loading ? (
            <div style={{ ...theme.emptyState, padding: '48px 20px' }}>Loading PGA Tour schedule...</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, fontFamily: fonts.sans }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${colors.borderSubtle}` }}>
                  {['Include', 'Sig/Maj', 'Tournament', 'Dates', 'Location & Course', 'Swing'].map(h => (
                    <th key={h} style={{ ...theme.tableHeaderCell, textAlign: 'left', padding: '8px 10px', position: 'sticky', top: 0, background: '#0f1d35', zIndex: 1 }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {editedSchedule.map((t, idx) => (
                  <tr key={idx} style={{
                    borderBottom: `1px solid ${colors.borderSubtle}`,
                    opacity: t.excluded ? 0.35 : 1,
                    transition: 'background 0.15s, opacity 0.15s',
                  }}
                    onMouseEnter={e => { e.currentTarget.style.background = colors.rowHover; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    {/* Include checkbox */}
                    <td style={{ padding: '8px 10px' }}>
                      <input
                        type="checkbox"
                        checked={!t.excluded}
                        onChange={() => toggleExclude(idx)}
                        style={{ width: 18, height: 18, cursor: 'pointer', accentColor: 'rgba(80,180,120,0.9)' }}
                      />
                    </td>

                    {/* Sig/Maj badges */}
                    <td style={{ padding: '8px 10px' }}>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button
                          onClick={() => toggleSignature(idx)}
                          style={badgeBtn(t.isSignature, 'rgba(160,110,240,0.7)', 'rgba(160,110,240,0.5)')}
                          title="Signature Event"
                        >S</button>
                        <button
                          onClick={() => toggleMajor(idx)}
                          style={badgeBtn(t.isMajor, 'rgba(220,170,60,0.7)', 'rgba(220,170,60,0.5)')}
                          title="Major Championship"
                        >M</button>
                      </div>
                    </td>

                    {/* Tournament name */}
                    <td style={{ padding: '8px 10px', fontWeight: 500, color: colors.textPrimary }}>{t.name}</td>

                    {/* Dates with swing color badge */}
                    <td style={{ padding: '8px 10px' }}>
                      <span style={getSwingBadgeStyle(t.swing)}>{t.dates}</span>
                    </td>

                    {/* Location & Course */}
                    <td style={{ padding: '8px 10px', fontSize: 12 }}>
                      <div style={{ color: colors.textSecondary }}>{t.location}</div>
                      <div style={{ color: colors.textMuted }}>{t.courseName}</div>
                    </td>

                    {/* Swing selector */}
                    <td style={{ padding: '8px 10px' }}>
                      <select
                        value={t.swing}
                        onChange={(e) => setSwing(idx, e.target.value)}
                        style={{
                          ...theme.select,
                          width: 'auto',
                          padding: '4px 8px',
                          fontSize: 12,
                        }}
                      >
                        {SWINGS.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        
        {/* Footer */}
        <div style={{
          padding: '12px 20px',
          borderTop: `1px solid ${colors.borderSubtle}`,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <span style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.textSecondary }}>
            {included.length} tournaments · {included.filter(t => t.isMajor).length} majors · {included.filter(t => t.isSignature).length} signature events
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onCancel} style={{ ...theme.btnSecondary, padding: '9px 18px' }}>
              Cancel
            </button>
            <button
              onClick={() => onImport(included)}
              disabled={included.length === 0}
              style={{
                ...theme.btnPrimary,
                padding: '9px 18px',
                opacity: included.length === 0 ? 0.4 : 1,
                cursor: included.length === 0 ? 'not-allowed' : 'pointer',
              }}
            >
              Import Schedule
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
