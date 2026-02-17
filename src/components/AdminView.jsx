import React, { useState, useEffect } from 'react';
import { Settings, Edit2, Save } from 'lucide-react';
import { useDialog } from './DialogContext';
import { slashGolfFetch, processTournamentData, makePlayer } from '../utils';
import { PGA_TOUR_IDS, FALLBACK_SCHEDULE_DATA } from '../constants';
import { storage } from '../api';

export const AdminView = ({
  isCommissioner, setIsCommissioner, setActiveTab,
  settings, setSettings,
  teams, updateTeams,
  tournaments, setTournaments,
  transactions, setTransactions,
  allPlayers, globalPlayerStats, setGlobalPlayerStats,
  updateRankings, rankingsLastUpdated,
  headshots, setHeadshots,
  STORAGE_KEYS,
}) => {
  const [selectedTourneyForResults, setSelectedTourneyForResults] = useState('');
  const dialog = useDialog();
  const activeTournament = tournaments.find(t => t.playing);

  useEffect(() => {
    if (!selectedTourneyForResults && activeTournament) {
      setSelectedTourneyForResults(activeTournament.name);
    }
  }, [activeTournament, selectedTourneyForResults]);

  // ── Export / Import ────────────────────────────────────────────────────────
  const handleExport = () => {
    const data = { teams, tournaments, transactions, settings, globalPlayerStats, headshots };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `sfgl-backup-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    dialog.showToast('Data exported successfully', 'success');
  };

  const handleImport = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const data = JSON.parse(event.target.result);
        if (data.teams)            updateTeams(data.teams);
        if (data.tournaments)      setTournaments(data.tournaments);
        if (data.transactions)     setTransactions(data.transactions);
        if (data.settings)       { setSettings(data.settings);           await storage.set(STORAGE_KEYS.SETTINGS,           data.settings); }
        if (data.globalPlayerStats){ setGlobalPlayerStats(data.globalPlayerStats); await storage.set(STORAGE_KEYS.GLOBAL_PLAYER_STATS, data.globalPlayerStats); }
        if (data.headshots)      { setHeadshots(data.headshots);         await storage.set(STORAGE_KEYS.HEADSHOTS,           data.headshots); }
        dialog.showToast('Data imported successfully!', 'success');
      } catch {
        dialog.showToast('Failed to parse backup file.', 'error');
      }
    };
    reader.readAsText(file);
    e.target.value = null;
  };

  // ── Schedule Sync ─────────────────────────────────────────────────────────
  const handleSyncSchedule = async () => {
    const ok = await dialog.showConfirm(
      'Sync Schedule',
      'Fetch the official PGA schedule?\n\nThis will cleanly build your tournament list, connect any imported past results, and truncate the season at the TOUR Championship.',
      { confirmText: 'Sync Schedule' },
    );
    if (!ok) return;

    try {
      dialog.showToast('Fetching PGA Schedule...', 'info');
      let pgaData = await slashGolfFetch('schedule', { orgId: '1', year: '2026' });
      if (!pgaData?.schedule?.length) pgaData = await slashGolfFetch('schedule', { orgId: '1', year: '2025' });

      let enrichedCount = 0;

      const parseISO = (iso) => {
        if (!iso) return null;
        const str   = String(iso);
        const parts = str.split('T')[0].split('-');
        if (parts.length === 3) return new Date(parts[0], parseInt(parts[1]) - 1, parseInt(parts[2]));
        const d = new Date(str);
        return isNaN(d) ? null : d;
      };

      const normalizeForMatch = (str) => (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');

      let formattedSchedule = (pgaData?.schedule || []).map(event => {
        const name       = event.name || 'Unknown Tournament';
        const slashGolfId = event.tournId || event.id || '';

        let startDate, endDate, dateStr = 'TBD', location = 'TBD', courseName = 'TBD';

        const extractDate = (dObj) => {
          if (!dObj) return null;
          if (typeof dObj === 'string') return dObj;
          if (typeof dObj === 'object') return dObj.date || dObj.start || null;
          return null;
        };

        const sDate = parseISO(extractDate(event.startDate || event.date?.start || event.start));
        const eDate = parseISO(extractDate(event.endDate   || event.date?.end   || event.end));

        if (sDate && eDate) {
          startDate = sDate.toISOString();
          const eEnd = new Date(eDate); eEnd.setHours(23, 59, 59);
          endDate   = eEnd.toISOString();
          const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
          const sm = MONTHS[sDate.getMonth()], em = MONTHS[eDate.getMonth()];
          dateStr = sm === em ? `${sm} ${sDate.getDate()}-${eDate.getDate()}` : `${sm} ${sDate.getDate()}-${em} ${eDate.getDate()}`;
        } else if (event.date?.display) {
          dateStr = event.date.display;
        }

        const courses = event.courses || [];
        if (courses[0]) {
          courseName = courses[0].courseName || courses[0].name || 'TBD';
          const loc  = courses[0].location || courses[0].address;
          if (typeof loc === 'string') location = loc;
          else if (loc) {
            const city = loc.city || loc.town || '';
            const state = loc.state || loc.region || loc.country || '';
            if (city || state) location = [city, state].filter(Boolean).join(', ');
          }
        }

        // Enrich from fallback if API omits location/course
        const fb = FALLBACK_SCHEDULE_DATA.find(f => name.includes(f.key));
        if (fb) {
          if (!location || location === 'TBD') { location = fb.loc; enrichedCount++; }
          if (!courseName || courseName === 'TBD') courseName = fb.course;
          if (!dateStr || dateStr === 'TBD' || !startDate) {
            dateStr   = fb.d;
            startDate = new Date(fb.s).toISOString();
            const fbEnd = new Date(fb.e); fbEnd.setHours(23, 59, 59);
            endDate   = fbEnd.toISOString();
          }
        }

        // Fuzzy-match existing tournament to preserve results + flags
        const apiNorm = normalizeForMatch(name);
        const fbNorm  = fb ? normalizeForMatch(fb.key) : '';
        const existingT = tournaments.find(t => {
          const tNorm = normalizeForMatch(t.name);
          return tNorm === apiNorm || apiNorm.includes(tNorm) || tNorm.includes(apiNorm)
            || (fbNorm && (tNorm.includes(fbNorm) || apiNorm.includes(fbNorm)));
        });

        return {
          name, slashGolfId, dates: dateStr, location, startDate, endDate, course: courseName,
          isSignature: existingT?.isSignature ?? (event.purse > 15_000_000),
          isMajor:     existingT?.isMajor     ?? ['Masters Tournament','PGA Championship','U.S. Open','The Open Championship'].includes(name),
          isAlternate: existingT?.isAlternate ?? ((event.purse && event.purse < 5_000_000) || ['Zurich','Barracuda','ISCO','Corales','Puerto Rico','Myrtle Beach'].some(n => name.includes(n))),
          swing:    existingT?.swing    ?? undefined,
          playing:  existingT?.playing  ?? false,
          completed: existingT?.completed ?? false,
          results:  existingT?.results  ?? null,
        };
      });

      // Truncate at Tour Championship
      const tcIndex = formattedSchedule.findIndex(t => t.name.toLowerCase().includes('tour championship'));
      if (tcIndex !== -1) formattedSchedule = formattedSchedule.slice(0, tcIndex + 1);

      // Ensure exactly one active tournament
      if (formattedSchedule.filter(t => t.playing).length !== 1) {
        formattedSchedule.forEach(t => { t.playing = false; });
        const nextIdx = formattedSchedule.findIndex(t => !t.completed && !t.isAlternate);
        if (nextIdx !== -1) formattedSchedule[nextIdx].playing = true;
      }

      setTournaments(formattedSchedule);
      dialog.showToast(`Schedule synced! ${enrichedCount > 0 ? `(${enrichedCount} events enriched from local data)` : '(100% API data)'}`, 'success');
    } catch (error) {
      console.error('Schedule Sync Error:', error);
      dialog.showToast(`API Error: ${error.message}`, 'error');
    }
  };

  // ── Results Fetch ─────────────────────────────────────────────────────────
  const handleFetchApiResults = async () => {
    if (!selectedTourneyForResults) {
      dialog.showToast('Please select a tournament first', 'error'); return;
    }
    const tournIndex = tournaments.findIndex(t => t.name === selectedTourneyForResults);
    if (tournIndex === -1) return;
    const t = tournaments[tournIndex];

    if (!t.slashGolfId) {
      dialog.showToast('No API ID found. Click "Sync Schedule" first.', 'error'); return;
    }
    if (t.completed) {
      const ok = await dialog.showConfirm(
        'Already Processed',
        'This tournament was already processed. Re-fetching will ADD earnings again (doubling them).\n\nAre you sure?',
        { type: 'danger', confirmText: 'Force Re-Fetch' },
      );
      if (!ok) return;
    }

    try {
      dialog.showToast(`Fetching leaderboard for ${t.name}...`, 'info');
      
      // Fetch leaderboard (scores and positions)
      let data = await slashGolfFetch('leaderboard', { tournId: t.slashGolfId, year: '2026' });
      let apiPlayers = data.leaderboardRows || data.leaderboard || data.results || [];

      if (apiPlayers.length === 0) {
        dialog.showToast('No results found in API yet.', 'error'); return;
      }

      // Fetch earnings separately
      try {
        const earningsData = await slashGolfFetch('earnings', { tournId: t.slashGolfId, year: '2026' });
        const earningsPlayers = earningsData.leaderboard || earningsData.earnings || earningsData.results || [];
        
        if (earningsPlayers.length > 0) {
          // Merge earnings into leaderboard data by matching playerId
          apiPlayers = apiPlayers.map(lp => {
            const ep = earningsPlayers.find(e => e.playerId === lp.playerId);
            return { ...lp, earnings: ep?.earnings || 0 };
          });
          console.log('Merged earnings from /earnings endpoint');
        }
      } catch (e) {
        console.log('Earnings endpoint not available:', e.message);
      }

      // Build list of all rostered player names for fuzzy matching
      const rosteredNames = teams.flatMap(team => team.roster.map(p => p.name));

      const { newTeams, newStats, resultsData } = processTournamentData(
        t, apiPlayers, teams, globalPlayerStats, rosteredNames,
      );

      const newTournaments = tournaments.map((nt, idx) => {
        if (idx === tournIndex) return { ...nt, completed: true, playing: false, results: resultsData };
        return nt;
      });

      // Advance active tournament
      const nextIdx = newTournaments.findIndex((nt, idx) => idx > tournIndex && !nt.completed && !nt.isAlternate);
      if (nextIdx !== -1) {
        newTournaments.forEach(nt => { nt.playing = false; });
        newTournaments[nextIdx].playing = true;
      }

      updateTeams(newTeams);
      setGlobalPlayerStats(newStats);
      setTournaments(newTournaments);
      dialog.showToast(`Results processed for ${t.name}!`, 'success');
    } catch (error) {
      console.error('Results Sync Error:', error);
      dialog.showToast(`API Error: ${error.message}`, 'error');
    }
  };

  // ── Player Sync ───────────────────────────────────────────────────────────
  const handleSyncPlayers = async () => {
    const ok = await dialog.showConfirm(
      'Sync OWGR Players',
      'Fetch the current Top 250 OWGR players?\n\nThis will also fetch the LIV Golf roster to filter them out.',
      { confirmText: 'Fetch Players' },
    );
    if (!ok) return;

    try {
      dialog.showToast('Fetching LIV Golf Roster...', 'info');
      const livPlayers = new Set();
      for (const yr of ['2026', '2025']) {
        try {
          const livData = await slashGolfFetch('schedule', { orgId: '2', year: yr });
          if (livData?.schedule?.length > 0) {
            const firstLivId = livData.schedule[0].tournId;
            const livTourney = await slashGolfFetch('tournament', { orgId: '2', tournId: firstLivId, year: yr });
            livTourney.players?.forEach(p => {
              const pObj = p?.player || p || {};
              const name = `${pObj.firstName || ''} ${pObj.lastName || ''}`.trim();
              if (name) livPlayers.add(name);
            });
            break;
          }
        } catch { /* try next year */ }
      }

      dialog.showToast('Fetching World Rankings...', 'info');
      let details = [];
      for (const yr of ['2026', '2025', '2024']) {
        try {
          const owgrData = await slashGolfFetch('rankings', { statId: '186', year: yr });
          details = owgrData?.rankings?.[0]?.details || owgrData?.details || owgrData?.rankings || [];
          if (!details.length) {
            const statsData = await slashGolfFetch('stats', { statId: '186', year: yr });
            details = statsData?.stats?.[0]?.details || statsData?.details || [];
          }
          if (details.length) break;
        } catch { /* try next year */ }
      }

      const newPlayers = [];
      if (details.length > 0) {
        details.forEach(p => {
          const pObj    = p?.player || p || {};
          let name      = pObj?.fullName || pObj?.displayName || pObj?.name || '';
          if (!name) name = `${pObj.firstName || ''} ${pObj.lastName || ''}`.trim();
          const rankVal = parseInt(p?.rankValue || p?.rank || p?.curRank || pObj?.rank) || 999;
          if (name && !livPlayers.has(name) && newPlayers.length < 250) {
            newPlayers.push({ name, worldRank: rankVal });
          }
        });
      }

      if (newPlayers.length === 0) {
        Object.keys(PGA_TOUR_IDS).forEach((name, i) => {
          if (newPlayers.length < 250) newPlayers.push({ name, worldRank: i + 1 });
        });
        dialog.showToast(`API parsed 0 players. Fallback: ${newPlayers.length} players loaded.`, 'info');
      } else {
        dialog.showToast(`Success! Loaded ${newPlayers.length} players.`, 'success');
      }
      updateRankings(newPlayers);
    } catch (error) {
      console.error('Player Sync Error:', error);
      dialog.showToast(`API Error: ${error.message}`, 'error');
    }
  };

  // ── Mulligan reset ────────────────────────────────────────────────────────
  const resetMulligan = (teamId, type) => {
    const team = teams.find(t => t.id === teamId);
    if (!team) return;
    const key = type === 'sig' ? 'signatureMajor' : 'regular';
    updateTeams(teams.map(t => t.id === teamId ? { ...t, mulligans: { ...t.mulligans, [key]: 1 } } : t));
    dialog.showToast(`Reset ${type} mulligan for ${team.name}`, 'success');
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center bg-gray-800/50 p-4 rounded-xl border border-gray-700">
        <h2 className="text-xl font-bold flex items-center gap-2">
          <Settings className="w-5 h-5 text-gray-400" /> Commissioner Controls
        </h2>
        <button
          onClick={() => { setIsCommissioner(false); setActiveTab('standings'); }}
          className="bg-red-600 hover:bg-red-700 px-4 py-1.5 rounded-lg text-sm font-bold transition-colors"
        >
          Logout
        </button>
      </div>

      {/* Results entry */}
      <div className="bg-blue-900/20 border border-blue-700/50 p-4 rounded-xl">
        <h3 className="font-bold text-blue-400 flex items-center gap-2 mb-4">✏️ Enter Tournament Results</h3>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-bold text-gray-400 block mb-1">Select Tournament</label>
            <select
              value={selectedTourneyForResults}
              onChange={e => setSelectedTourneyForResults(e.target.value)}
              className="w-full bg-gray-800 border border-gray-600 rounded p-2 text-sm"
            >
              <option value="">Choose tournament...</option>
              {tournaments.map(t => <option key={t.name} value={t.name}>{t.name}</option>)}
            </select>
          </div>
          <button
            onClick={handleFetchApiResults}
            className="w-full py-2.5 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm font-bold border border-gray-600 transition-colors flex items-center justify-center gap-2"
          >
            <span className="text-orange-500">⚡</span> Fetch Results from API
          </button>
        </div>
      </div>

      {/* Schedule + Player sync */}
      <div className="bg-teal-900/10 border border-teal-700/50 p-4 rounded-xl">
        <h3 className="font-bold text-teal-400 flex items-center gap-2 mb-4">🌎 World Rankings &amp; Schedule Sync</h3>
        <div className="flex gap-2">
          <button onClick={handleSyncSchedule} className="flex-1 bg-purple-600 hover:bg-purple-700 py-2 rounded text-sm font-bold transition-colors">
            Sync Schedule
          </button>
          <button onClick={handleSyncPlayers} className="flex-1 bg-teal-600 hover:bg-teal-700 py-2 rounded-lg text-sm font-bold transition-colors">
            Sync OWGR Top 250
          </button>
        </div>
        {rankingsLastUpdated && (
          <p className="text-[10px] text-gray-500 mt-2 text-center">
            Rankings last updated: {new Date(rankingsLastUpdated).toLocaleDateString()}
          </p>
        )}
      </div>

      {/* Mulligan resets */}
      <div className="bg-gray-800/50 border border-gray-700 p-4 rounded-xl">
        <h3 className="font-bold text-gray-300 mb-3">🚨 Reset Mulligans</h3>
        <div className="space-y-2">
          {teams.map(team => (
            <div key={team.id} className="flex items-center justify-between bg-gray-700/30 rounded-lg px-3 py-2">
              <span className="text-sm font-medium">{team.name}</span>
              <div className="flex gap-2">
                <div className="text-[10px] text-gray-500 self-center">
                  Sig: {team.mulligans?.signatureMajor ?? 0} · Reg: {team.mulligans?.regular ?? 0}
                </div>
                <button onClick={() => resetMulligan(team.id, 'sig')} className="px-2 py-1 bg-purple-700 hover:bg-purple-600 rounded text-[10px] font-bold">Reset Sig</button>
                <button onClick={() => resetMulligan(team.id, 'reg')} className="px-2 py-1 bg-gray-600 hover:bg-gray-500 rounded text-[10px] font-bold">Reset Reg</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Export / Import */}
      <div className="bg-gray-800/50 border border-gray-700 p-4 rounded-xl">
        <h3 className="font-bold text-gray-300 mb-3">💾 Backup &amp; Restore</h3>
        <div className="flex gap-2">
          <button onClick={handleExport} className="flex-1 py-2 bg-gray-600 hover:bg-gray-500 rounded-lg text-sm font-bold transition-colors">
            Export JSON
          </button>
          <label className="flex-1 py-2 bg-gray-600 hover:bg-gray-500 rounded-lg text-sm font-bold transition-colors text-center cursor-pointer">
            Import JSON
            <input type="file" accept=".json" onChange={handleImport} className="hidden" />
          </label>
        </div>
      </div>
    </div>
  );
};
