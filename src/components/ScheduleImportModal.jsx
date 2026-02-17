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
    if (typeof dateObj === 'string') return new Date(dateObj);
    if (typeof dateObj === 'object') {
      const dateStr = dateObj.date || dateObj.start || dateObj.$date;
      return dateStr ? new Date(dateStr) : null;
    }
    return null;
  };

  const formatDates = (startObj, endObj) => {
    const start = parseDate(startObj);
    const end = parseDate(endObj);
    if (!start || !end) return 'TBD';
    
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const sm = MONTHS[start.getMonth()];
    const em = MONTHS[end.getMonth()];
    
    if (sm === em) {
      return `${sm} ${start.getDate()}-${end.getDate()}`;
    } else {
      return `${sm} ${start.getDate()}-${em} ${end.getDate()}`;
    }
  };

  const assignSwing = (startObj) => {
    const date = parseDate(startObj);
    if (!date) return 'West Coast Swing';
    
    const month = date.getMonth(); // 0 = Jan
    if (month <= 2) return 'West Coast Swing';
    if (month === 3) return 'Florida Swing';
    if (month === 4 || month === 5) return 'Spring Swing';
    if (month >= 6 && month <= 8) return 'Summer Swing';
    return 'Fall Finish';
  };

  const getSwingColor = (swing) => {
    const colors = {
      'West Coast Swing': 'bg-blue-600/20 text-blue-300',
      'Florida Swing': 'bg-orange-600/20 text-orange-300',
      'Spring Swing': 'bg-green-600/20 text-green-300',
      'Summer Swing': 'bg-yellow-600/20 text-yellow-300',
      'Fall Finish': 'bg-red-600/20 text-red-300',
    };
    return colors[swing] || 'bg-gray-600/20 text-gray-300';
  };

  const loadSchedule = async () => {
    setLoading(true);
    try {
      let data = await slashGolfFetch('schedule', { orgId: '1', year: '2026' });
      if (!data?.schedule?.length) {
        data = await slashGolfFetch('schedule', { orgId: '1', year: '2025' });
      }
      
      const tournaments = (data?.schedule || []).map(event => {
        const startDate = parseDate(event.startDate || event.date?.start || event.start);
        const endDate = parseDate(event.endDate || event.date?.end || event.end);
        
        const courses = event.courses || [];
        const location = event.location?.city 
          ? `${event.location.city}, ${event.location.state || event.location.country || ''}`
          : courses[0]?.city || 'TBD';
        
        const courseName = courses[0]?.courseName || courses[0]?.name || 'TBD';
        
        // Auto-detect majors and signatures
        const isMajor = ['Masters', 'PGA Championship', 'U.S. Open', 'The Open Championship'].some(m => 
          event.name?.includes(m)
        );
        const isSignature = event.purse > 15000000 && !isMajor;
        
        return {
          name: event.name || 'Unknown Tournament',
          slashGolfId: event.tournId || event.id || '',
          startDate: startDate?.toISOString() || null,
          endDate: endDate ? (() => { const d = new Date(endDate); d.setHours(23,59,59); return d.toISOString(); })() : null,
          location,
          courseName,
          dates: formatDates(event.startDate, event.endDate),
          isSignature,
          isMajor,
          swing: assignSwing(event.startDate),
          isAlternate: false,
          completed: false,
          playing: false,
        };
      });
      
      // Set first tournament as active
      if (tournaments.length > 0) {
        tournaments[0].playing = true;
      }
      
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
                </tr>
              </thead>
              <tbody>
                {editedSchedule.map((t, idx) => (
                  <tr key={idx} className="border-b border-gray-700/50 hover:bg-gray-700/30">
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
                        <option>Florida Swing</option>
                        <option>Spring Swing</option>
                        <option>Summer Swing</option>
                        <option>Fall Finish</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        
        <div className="p-4 border-t border-gray-700 flex justify-between items-center">
          <div className="text-sm text-gray-400">
            {editedSchedule.length} tournaments • {editedSchedule.filter(t => t.isMajor).length} majors • {editedSchedule.filter(t => t.isSignature).length} signature events
          </div>
          <div className="flex gap-2">
            <button
              onClick={onCancel}
              className="px-4 py-2 bg-gray-600 hover:bg-gray-500 rounded font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => onImport(editedSchedule)}
              disabled={editedSchedule.length === 0}
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
