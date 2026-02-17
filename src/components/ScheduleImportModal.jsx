import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { slashGolfFetch } from '../utils';

export const ScheduleImportModal = ({ onImport, onCancel }) => {
  const [loading, setLoading] = useState(false);
  const [editedSchedule, setEditedSchedule] = useState([]);

  useEffect(() => {
    loadSchedule();
  }, []);

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

  const getSwingColor = (swing) => {
    const colors = {
      'West Coast Swing': 'bg-blue-600/20 text-blue-300',
      'Spring Swing': 'bg-green-600/20 text-green-300',
      'Summer Swing': 'bg-yellow-600/20 text-yellow-300',
      'Fall Finish': 'bg-red-600/20 text-red-300',
    };
    return colors[swing] || 'bg-gray-600/20 text-gray-300';
  };

  const loadSchedule = async () => {
    setLoading(true);
    try {
      console.log('Fetching schedule from SlashGolf API...');
      let data = await slashGolfFetch('schedule', { orgId: '1', year: '2026' });
      console.log('2026 schedule response:', data);
      
      if (!data?.schedule?.length) {
        console.log('No 2026 data, trying 2025...');
        data = await slashGolfFetch('schedule', { orgId: '1', year: '2025' });
        console.log('2025 schedule response:', data);
      }
      
      if (!data?.schedule?.length) {
        console.error('No schedule data found in API response');
        setLoading(false);
        return;
      }
      
      console.log(`Processing ${data.schedule.length} tournaments...`);
      console.log('First tournament raw data:', data.schedule[0]);
      
      let tournaments = (data?.schedule || []).map((event, idx) => {
        // API structure: event.date.start and event.date.end
        const startDate = parseDate(event.date?.start || event.startDate);
        const endDate = parseDate(event.date?.end || event.endDate);
        
        if (idx === 0) {
          console.log('First event:', event.name);
          console.log('Date object:', event.date);
          console.log('Parsed dates:', { startDate, endDate });
        }
        
        // Extract location from courses[0].location
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
            // Format: "City, State" or "City, Country" if no state
            location = [city, state || country].filter(Boolean).join(', ');
          }
        }
        
        if (idx === 0) {
          console.log('Location:', location);
          console.log('Course:', courseName);
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
        console.log(`Truncating at TOUR Championship (position ${tourChampIndex + 1})`);
        tournaments = tournaments.slice(0, tourChampIndex + 1);
      }
      
      // Auto-assign swings evenly across the season
      const swingNames = ['West Coast Swing', 'Spring Swing', 'Summer Swing', 'Fall Finish'];
      const tournamentsPerSwing = Math.ceil(tournaments.length / swingNames.length);
      
      tournaments.forEach((t, idx) => {
        const swingIndex = Math.min(Math.floor(idx / tournamentsPerSwing), swingNames.length - 1);
        t.swing = swingNames[swingIndex];
      });
      
      console.log(`Assigned ${tournamentsPerSwing} tournaments per swing`);
      
      // Set first non-excluded tournament as active
      const firstActive = tournaments.findIndex(t => !t.excluded);
      if (firstActive !== -1) {
        tournaments[firstActive].playing = true;
      }
      
      console.log('Processed tournaments:', tournaments);
      setEditedSchedule(tournaments);
    } catch (e) {
      console.error('Failed to load schedule:', e);
    }
    setLoading(false);
  };

  const toggleSignature = (idx) => {
    const updated = [...editedSchedule];
    updated[idx].isSignature = !updated[idx].isSignature;
    if (updated[idx].isSignature) updated[idx].isMajor = false; // Can't be both
    setEditedSchedule(updated);
  };

  const toggleMajor = (idx) => {
    const updated = [...editedSchedule];
    updated[idx].isMajor = !updated[idx].isMajor;
    if (updated[idx].isMajor) updated[idx].isSignature = false; // Can't be both
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

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50">
      <div className="bg-gray-800 rounded-xl max-w-6xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        <div className="p-4 border-b border-gray-700 flex justify-between items-center">
          <div>
            <h2 className="text-xl font-bold">Import 2026 Schedule</h2>
            <p className="text-sm text-gray-400 mt-1">Configure tournament badges and swings before importing</p>
          </div>
          <button onClick={onCancel} className="text-gray-400 hover:text-white">
            <X className="w-6 h-6" />
          </button>
        </div>
        
        <div className="flex-1 overflow-auto p-4">
          {loading ? (
            <div className="text-center py-12 text-gray-400">Loading PGA Tour schedule...</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-gray-800 z-10">
                <tr className="border-b border-gray-700">
                  <th className="text-left p-2 font-semibold">Badge</th>
                  <th className="text-left p-2 font-semibold">Tournament</th>
                  <th className="text-left p-2 font-semibold">Dates</th>
                  <th className="text-left p-2 font-semibold">Location & Course</th>
                  <th className="text-left p-2 font-semibold">Swing</th>
                  <th className="text-left p-2 font-semibold">Include</th>
                </tr>
              </thead>
              <tbody>
                {editedSchedule.map((t, idx) => (
                  <tr key={idx} className={`border-b border-gray-700/50 hover:bg-gray-700/30 ${t.excluded ? 'opacity-40' : ''}`}>
                    <td className="p-2">
                      <div className="flex gap-1">
                        <button
                          onClick={() => toggleSignature(idx)}
                          className={`w-7 h-7 rounded text-xs font-bold transition-colors ${
                            t.isSignature ? 'bg-purple-600 hover:bg-purple-500' : 'bg-gray-600 hover:bg-gray-500'
                          }`}
                          title="Signature Event"
                        >
                          S
                        </button>
                        <button
                          onClick={() => toggleMajor(idx)}
                          className={`w-7 h-7 rounded text-xs font-bold transition-colors ${
                            t.isMajor ? 'bg-yellow-600 hover:bg-yellow-500' : 'bg-gray-600 hover:bg-gray-500'
                          }`}
                          title="Major Championship"
                        >
                          M
                        </button>
                      </div>
                    </td>
                    <td className="p-2 font-medium">{t.name}</td>
                    <td className="p-2">
                      <div className={`inline-block px-2 py-1 rounded text-xs font-medium ${getSwingColor(t.swing)}`}>
                        {t.dates}
                      </div>
                    </td>
                    <td className="p-2 text-xs text-gray-400">
                      <div>{t.location}</div>
                      <div className="text-gray-500">{t.courseName}</div>
                    </td>
                    <td className="p-2">
                      <select
                        value={t.swing}
                        onChange={(e) => setSwing(idx, e.target.value)}
                        className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-green-500"
                      >
                        <option>West Coast Swing</option>
                        <option>Spring Swing</option>
                        <option>Summer Swing</option>
                        <option>Fall Finish</option>
                      </select>
                    </td>
                    <td className="p-2">
                      <input
                        type="checkbox"
                        checked={!t.excluded}
                        onChange={() => toggleExclude(idx)}
                        className="w-5 h-5 rounded border-gray-600 bg-gray-700 text-green-600 focus:ring-green-500 focus:ring-2 cursor-pointer"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        
        <div className="p-4 border-t border-gray-700 flex justify-between items-center">
          <div className="text-sm text-gray-400">
            {editedSchedule.filter(t => !t.excluded).length} tournaments • {editedSchedule.filter(t => t.isMajor && !t.excluded).length} majors • {editedSchedule.filter(t => t.isSignature && !t.excluded).length} signature events
          </div>
          <div className="flex gap-2">
            <button
              onClick={onCancel}
              className="px-4 py-2 bg-gray-600 hover:bg-gray-500 rounded font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => onImport(editedSchedule.filter(t => !t.excluded))}
              disabled={editedSchedule.filter(t => !t.excluded).length === 0}
              className="px-4 py-2 bg-green-600 hover:bg-green-500 rounded font-bold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Import Schedule
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
