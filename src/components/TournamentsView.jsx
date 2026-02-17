import React, { useState, useEffect } from 'react';
import { Calendar, Trophy, Edit2, Save } from 'lucide-react';
import { useDialog } from './DialogContext';
import { SWINGS } from '../constants/index.js';

const ALTERNATE_KEYWORDS = ['Puerto Rico', 'Zurich', 'Corales', 'Myrtle Beach', 'ISCO', 'Barracuda'];

const isAlternate = (t) => {
  if (t.isAlternate !== undefined) return t.isAlternate;
  return ALTERNATE_KEYWORDS.some(kw => t.name.includes(kw));
};

const getSwingColor = (swing, dateStr) => {
  if (swing) {
    if (swing === 'West Coast Swing') return 'text-red-400';
    if (swing === 'Florida Swing')    return 'text-yellow-400';
    if (swing === 'Spring Swing')     return 'text-green-400';
    if (swing === 'Summer Swing')     return 'text-blue-400';
    return 'text-orange-400';
  }
  if (!dateStr) return 'text-gray-400';
  const month = dateStr.split(' ')[0];
  if (['Jan', 'Feb'].includes(month))              return 'text-red-400';
  if (['Mar', 'Apr', 'May'].includes(month))       return 'text-green-400';
  if (['Jun', 'Jul', 'Aug'].includes(month))       return 'text-blue-400';
  return 'text-orange-400';
};

export const TournamentsView = ({ tournaments, isCommissioner, setTournaments }) => {
  const [editMode,         setEditMode]         = useState(false);
  const [localTournaments, setLocalTournaments] = useState([]);
  const dialog = useDialog();

  useEffect(() => { setLocalTournaments(tournaments); }, [tournaments]);

  const saveChanges = () => {
    setTournaments(localTournaments);
    setEditMode(false);
    dialog.showToast('Schedule updated!', 'success');
  };

  const updateLocal = (index, patch) => {
    setLocalTournaments(prev => prev.map((t, i) => i === index ? { ...t, ...patch } : t));
  };

  const completed = [...localTournaments.filter(t =>  t.completed)].reverse();
  const upcoming  = localTournaments.filter(t => !t.completed);

  const renderTable = (list) => (
    <table className="w-full text-sm text-left">
      <thead className="bg-gray-800/50 text-xs font-bold text-gray-400 border-b border-gray-700">
        <tr>
          {editMode ? (
            <>
              <th className="px-2 py-2">Active</th>
              <th className="px-2 py-2">Type</th>
              <th className="px-2 py-2">Tournament</th>
              <th className="px-2 py-2">Swing</th>
            </>
          ) : (
            <>
              <th className="px-3 py-3 w-10 text-center" />
              <th className="px-3 py-3">Tournament</th>
              <th className="px-3 py-3">Dates</th>
              <th className="px-3 py-3 hidden sm:table-cell">Location &amp; Course</th>
            </>
          )}
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-700/50">
        {list.map(t => {
          const realIndex = localTournaments.findIndex(lt => lt.name === t.name);
          const alt = isAlternate(t);

          if (editMode) {
            return (
              <tr key={t.name} className="hover:bg-gray-700/30">
                {/* Active checkbox */}
                <td className="px-2 py-2 text-center">
                  <input
                    type="checkbox"
                    checked={t.playing}
                    onChange={e => {
                      const updated = localTournaments.map(x => ({ ...x, playing: false }));
                      if (e.target.checked) updated[realIndex].playing = true;
                      setLocalTournaments(updated);
                    }}
                    className="accent-green-500 w-4 h-4"
                  />
                </td>
                {/* Type badges */}
                <td className="px-2 py-2">
                  <div className="flex gap-1">
                    {['S', 'M', 'Alt'].map(badge => {
                      const key = badge === 'S' ? 'isSignature' : badge === 'M' ? 'isMajor' : 'isAlternate';
                      const active = t[key];
                      return (
                        <button
                          key={badge}
                          onClick={() => updateLocal(realIndex, { [key]: !active })}
                          className={`w-6 h-6 rounded font-bold text-[10px] ${
                            active
                              ? badge === 'S' ? 'bg-purple-600 text-white'
                              : badge === 'M' ? 'bg-yellow-500 text-white'
                              : 'bg-red-900/50 text-red-400 border border-red-500'
                              : 'bg-gray-700 text-gray-500'
                          }`}
                        >
                          {badge}
                        </button>
                      );
                    })}
                  </div>
                </td>
                {/* Name */}
                <td className="px-2 py-2">
                  <input
                    value={t.name}
                    onChange={e => updateLocal(realIndex, { name: e.target.value })}
                    className="bg-transparent border-b border-gray-600 w-full text-xs focus:outline-none focus:border-green-500"
                  />
                  <div className="text-[10px] text-gray-500">{t.dates}</div>
                </td>
                {/* Swing */}
                <td className="px-2 py-2">
                  <select
                    value={t.swing || ''}
                    onChange={e => updateLocal(realIndex, { swing: e.target.value })}
                    className="bg-gray-800 text-xs border border-gray-600 rounded p-1 w-full"
                  >
                    <option value="">Auto</option>
                    {SWINGS.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </td>
              </tr>
            );
          }

          // Read-only row
          return (
            <tr key={t.name} className={`hover:bg-gray-700/30 transition-colors ${alt ? 'opacity-50' : ''}`}>
              <td className="px-3 py-3">
                {t.isMajor     && <span className="w-5 h-5 bg-yellow-500  text-white text-[10px] font-bold flex items-center justify-center rounded">M</span>}
                {t.isSignature && !t.isMajor && <span className="w-5 h-5 bg-purple-600 text-white text-[10px] font-bold flex items-center justify-center rounded">S</span>}
              </td>
              <td className="px-3 py-3 font-bold">
                <span className={alt ? 'text-gray-500' : 'text-gray-200'}>
                  {t.name}
                  {t.completed && <span className="ml-2 text-[10px] font-normal px-1.5 py-0.5 bg-gray-700 text-gray-300 rounded">Final</span>}
                  {t.playing === true && <span className="ml-2 text-[10px] font-normal px-1.5 py-0.5 bg-green-900/50 border border-green-500/50 text-green-400 rounded">Active</span>}
                </span>
              </td>
              <td className={`px-3 py-3 font-medium whitespace-nowrap ${alt ? 'text-gray-500' : getSwingColor(t.swing, t.dates)}`}>
                {t.dates}
              </td>
              <td className={`px-3 py-3 hidden sm:table-cell ${alt ? 'text-gray-600' : 'text-gray-400'}`}>
                <div className="font-semibold">{t.location}</div>
                {t.course && t.course !== 'TBD' && <div className="text-[10px] opacity-70">{t.course}</div>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-bold">2026 Season Schedule</h2>
        {isCommissioner && (
          <button
            onClick={() => editMode ? saveChanges() : setEditMode(true)}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
              editMode
                ? 'bg-green-600 hover:bg-green-500 text-white'
                : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
            }`}
          >
            {editMode ? <><Save className="w-3 h-3" /> Save Changes</> : <><Edit2 className="w-3 h-3" /> Edit Schedule</>}
          </button>
        )}
      </div>

      <div className="bg-gray-800/50 backdrop-blur rounded-xl border border-gray-700/50 overflow-hidden shadow-lg">
        <div className="p-4 bg-gray-700/30 border-b border-gray-700/50 flex items-center gap-2">
          <Calendar className="w-5 h-5 text-gray-400" />
          <h2 className="text-xl font-bold">Upcoming Events</h2>
        </div>
        <div className="overflow-x-auto">{renderTable(upcoming)}</div>
      </div>

      {completed.length > 0 && (
        <div className="bg-gray-800/50 backdrop-blur rounded-xl border border-gray-700/50 overflow-hidden shadow-lg">
          <div className="p-4 bg-gray-700/30 border-b border-gray-700/50 flex items-center gap-2">
            <Trophy className="w-5 h-5 text-yellow-400" />
            <h2 className="text-xl font-bold">Completed Tournaments</h2>
          </div>
          <div className="overflow-x-auto">{renderTable(completed)}</div>
        </div>
      )}
    </div>
  );
};
