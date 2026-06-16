import React, { useMemo, useState, useEffect, useRef } from 'react';
import { useDialog } from './DialogContext';
import { theme, colors, fonts, SWINGS, fontSize } from '../theme.js';
import { computeSwingAward } from '../utils/swingAward';
import {
  isPushSupported,
  getNotificationPermission,
  requestPermissionAndSubscribe,
  unsubscribe as unsubscribePush,
  getCurrentToken,
  sendTestPush,
} from '../api/pushNotifications';

// Panel imports — each becomes a drillable section in the new architecture.
import { S, M, disabledBtn } from './admin/adminStyles';
import { DataSyncPanel } from './admin/DataSyncPanel';
import { LivIneligiblePanel } from './admin/LivIneligiblePanel';
import { ManagerAccountsPanel } from './admin/ManagerAccountsPanel';
import { ManagerActivityPanel } from './admin/ManagerActivityPanel';
import { MergePlayersPanel } from './admin/MergePlayersPanel';
import { ScheduleImportPanel } from './admin/ScheduleImportPanel';
import { SeasonSettingsPanel } from './admin/SeasonSettingsPanel';
import { SwingWinnerPanel } from './admin/SwingWinnerPanel';
import { TournamentResultsPanel } from './admin/TournamentResultsPanel';
import { WaiverProcessingPanel } from './admin/WaiverProcessingPanel';

// ── Wave J Round 5: Commissioner Dashboard ───────────────────────────────────
// Refactored from a wall of stacked accordion panels into a dashboard-as-
// landing experience inspired by the MnQ Golf League admin pattern. Key
// changes:
//
//  1. Landing view shows an actionable status banner ("3 pending waivers",
//     "Spring Swing awaiting award", etc.) + grouped section tiles.
//  2. Each panel is reachable by tapping its tile — full-bleed drill-down
//     with a Back button to return to the dashboard.
//  3. Mobile-first: tiles are full-width on narrow viewports, two-up on
//     wider screens (see app-global.css → .admin-tile-grid).
//  4. Panels themselves are unchanged — only the wrapper navigation is new.
//
// This architecture scales better than the previous "expand-everything
// accordion" pattern: the commish lands on the page seeing what needs their
// attention NOW, rather than a flat wall of admin tooling.
// ─────────────────────────────────────────────────────────────────────────────

// Effective-roster helper — unchanged from prior version. Used to feed
// TournamentResultsPanel a roster snapshot that matches what RostersView
// shows (current team.roster + processed transactions not yet synced).
const getEffectiveRoster = (team, allTransactions) => {
  if (!team) return [];
  const teamKey = String(team.name || '').trim().toLowerCase();
  let roster = (team.roster || []).filter(p => p && typeof p.name === 'string' && p.name.length > 0);
  roster = roster.map(p => ({ ...p }));

  (allTransactions || [])
    .filter(tx => {
      if (String(tx.team || '').trim().toLowerCase() !== teamKey) return false;
      if (tx.type === 'mulligan') return false;
      if (tx.type === 'swing_winner') return false;
      if (tx.status === 'pending') return false;
      if (tx.status === 'failed')  return false;
      return true;
    })
    .sort((a, b) => (a.tournamentIndex ?? 0) - (b.tournamentIndex ?? 0))
    .forEach(tx => {
      if (tx.droppedPlayer && typeof tx.droppedPlayer === 'string') {
        roster = roster.filter(p => p.name !== tx.droppedPlayer);
      }
      if (typeof tx.player === 'string' && tx.player.length > 0 && !roster.some(p => p.name === tx.player)) {
        roster.push({ name: tx.player, limited: !!tx.limited });
      }
    });

  return roster;
};

// ── Chevron arrow used in status-banner rows + section tiles ──
const ChevronRight = ({ size = 14, color }) => (
  <span style={{
    color: color || colors.textMuted,
    fontSize: size,
    lineHeight: 1,
    flexShrink: 0,
    fontFamily: fonts.sans,
  }}>›</span>
);

// ── Back-bar at the top of each drilled-in panel view ──
// Sticky so the commish can always tap "Dashboard" without scrolling back to
// the top of a long admin panel. It pins directly beneath the app's sticky
// header — whose height is dynamic (logo row + swing/tournament row, and a
// little taller in commish mode) — so we measure that header at runtime rather
// than hardcoding an offset. The app has exactly one <header>; its parent div
// is the sticky shell we tuck under.
const BackBar = ({ label, onBack }) => {
  const [topOffset, setTopOffset] = useState(0);
  const selfRef = useRef(null);

  useEffect(() => {
    const shell = document.querySelector('header')?.parentElement;
    if (!shell) return;
    const measure = () => setTopOffset(shell.getBoundingClientRect().height);
    measure();
    let ro;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure);
      ro.observe(shell);
    }
    window.addEventListener('resize', measure);
    return () => {
      if (ro) ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  return (
    <div
      ref={selfRef}
      style={{
        position: 'sticky',
        top: topOffset,
        // Below the app shell (z-index 50) so it never covers the main header,
        // but above panel content so scrolled rows tuck underneath it.
        zIndex: 40,
        // Opaque page-background fill so content scrolling beneath stays hidden.
        background: '#111d2e',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '10px 0 12px 0',
        marginBottom: 12,
        borderBottom: `1px solid ${colors.borderSubtle}`,
      }}
    >
      <button
        onClick={onBack}
        style={{
          background: 'rgba(255,255,255,0.05)',
          border: `1px solid ${colors.borderSubtle}`,
          borderRadius: 4,
          color: colors.textPrimary,
          cursor: 'pointer',
          padding: '6px 12px 6px 8px',
          fontFamily: fonts.sans,
          fontSize: fontSize.sm,
          fontWeight: 600,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          flexShrink: 0,
        }}
        aria-label="Back to dashboard"
      >
        <span style={{ fontSize: fontSize.lg, lineHeight: 1, marginTop: -1 }}>‹</span>
        Dashboard
      </button>
      <span style={{
        fontFamily: fonts.sans,
        fontSize: fontSize.xs,
        fontWeight: 700,
        letterSpacing: '1.8px',
        textTransform: 'uppercase',
        color: colors.textSecondary,
        marginLeft: 8,
      }}>
        {label}
      </span>
    </div>
  );
};

export const AdminView = ({
  isCommissioner, setIsCommissioner, setActiveTab,
  settings, setSettings,
  teams, updateTeams,
  tournaments, setTournaments,
  transactions, setTransactions,
  allPlayers, setAllPlayers, globalPlayerStats, setGlobalPlayerStats,
  headshots, setHeadshots,
  updateRankings, rankingsLastUpdated,
  loggedInUser,
}) => {
  const dialog = useDialog();

  // The currently-drilled-in section. null = dashboard landing view.
  const [section, setSection] = useState(null);

  // Per-team effective-roster snapshot (mirrors RostersView's roster logic).
  const rostersByTeamIdForSelectedTourney = useMemo(() => {
    const map = {};
    const safeTeams = Array.isArray(teams) ? teams : [];
    const safeTx    = Array.isArray(transactions) ? transactions : [];
    safeTeams.forEach(t => {
      if (!t || !t.id) return;
      try {
        map[t.id] = getEffectiveRoster(t, safeTx);
      } catch (err) {
        console.warn('[AdminView] roster snapshot failed for', t.name, err);
        map[t.id] = t.roster || [];
      }
    });
    return map;
  }, [teams, transactions]);

  // ── Push notifications state ───────────────────────────────────────────
  // Tracks the commish's own device subscription status so the test panel
  // can show the right UI (subscribe / unsubscribe / test). All loaded
  // async on mount via the effect below.
  const [pushSupported,    setPushSupported]    = useState(false);
  const [pushPermission,   setPushPermission]   = useState('default');
  const [pushSubscribed,   setPushSubscribed]   = useState(false);
  const [pushBusy,         setPushBusy]         = useState(false);
  const [pushLastResult,   setPushLastResult]   = useState(null);  // last test push API response, for status display

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supported = await isPushSupported();
      if (cancelled) return;
      setPushSupported(supported);
      setPushPermission(getNotificationPermission());
      setPushSubscribed(!!getCurrentToken());
    })();
    return () => { cancelled = true; };
  }, []);

  // Find the commish's own team (matched by team.owner === loggedInUser).
  // Used as the auth identity for the test-push API call and as the teamId
  // the device subscription is tied to.
  const commishTeam = useMemo(() => {
    if (!loggedInUser) return null;
    return teams.find(t => t.owner === loggedInUser) || null;
  }, [teams, loggedInUser]);

  const handleSubscribePush = async () => {
    if (!commishTeam?.id) {
      dialog.showToast('Could not identify your team for subscription. Are you logged in?', 'error');
      return;
    }
    setPushBusy(true);
    try {
      const result = await requestPermissionAndSubscribe(commishTeam.id);
      if (result.ok) {
        setPushSubscribed(true);
        setPushPermission('granted');
        dialog.showToast('✓ Push notifications enabled on this device', 'success');
      } else {
        const messages = {
          unsupported:  'Push notifications aren\u2019t supported in this browser. On iPhone, add SFGL to your home screen first (Safari → Share → Add to Home Screen).',
          denied:       'Permission denied. Enable notifications for SFGL in your browser settings to receive pushes.',
          no_vapid:     'Server not configured for push (missing VAPID key). Contact the developer.',
          sw_failed:    'Service worker registration failed. Try refreshing the page.',
          token_failed: 'Could not register with the push service. Try again.',
          save_failed:  'Permission granted but failed to save subscription to Firestore. Try again.',
        };
        dialog.showToast(messages[result.reason] || `Push setup failed: ${result.reason}`, 'error');
      }
    } catch (err) {
      console.error('[push] subscribe error:', err);
      dialog.showToast('Push subscription failed: ' + err.message, 'error');
    } finally {
      setPushBusy(false);
    }
  };

  const handleUnsubscribePush = async () => {
    setPushBusy(true);
    try {
      await unsubscribePush();
      setPushSubscribed(false);
      dialog.showToast('Unsubscribed from push notifications on this device', 'success');
    } catch (err) {
      console.error('[push] unsubscribe error:', err);
      dialog.showToast('Unsubscribe failed: ' + err.message, 'error');
    } finally {
      setPushBusy(false);
    }
  };

  const handleTestPushSelf = async () => {
    if (!commishTeam?.id) {
      dialog.showToast('Could not identify your team. Are you logged in?', 'error');
      return;
    }
    setPushBusy(true);
    setPushLastResult(null);
    try {
      const result = await sendTestPush({
        commishTeamId: commishTeam.id,
        recipients:    [commishTeam.id],
        title:         'SFGL test push',
        body:          `Test from ${new Date().toLocaleTimeString()}. If you see this, pushes are working.`,
        deepLink:      '#admin',
      });
      setPushLastResult(result);
      if (result.sent > 0) {
        dialog.showToast(`✓ Test push sent — ${result.sent} delivered, ${result.failed} failed`, 'success');
      } else if (result.totalTokens === 0) {
        dialog.showToast('No subscribed devices found for your team. Subscribe this device first.', 'error');
      } else {
        dialog.showToast(`Test push failed — 0 of ${result.totalTokens} delivered`, 'error');
      }
    } catch (err) {
      console.error('[push] test push error:', err);
      dialog.showToast('Test push failed: ' + err.message, 'error');
    } finally {
      setPushBusy(false);
    }
  };

  const handleTestPushAll = async () => {
    if (!commishTeam?.id) {
      dialog.showToast('Could not identify your team. Are you logged in?', 'error');
      return;
    }
    const ok = await dialog.showConfirm(
      'Send test push to all managers?',
      'This will send a notification to every device that has subscribed to SFGL pushes across all teams. Use sparingly — managers will get a real notification.',
      { type: 'warning', confirmText: 'Send to all', cancelText: 'Cancel' }
    );
    if (!ok) return;
    setPushBusy(true);
    setPushLastResult(null);
    try {
      const result = await sendTestPush({
        commishTeamId: commishTeam.id,
        recipients:    'all',
        title:         'SFGL test broadcast',
        body:          `Test push from the commissioner at ${new Date().toLocaleTimeString()}. You can ignore this.`,
        deepLink:      '#standings',
      });
      setPushLastResult(result);
      dialog.showToast(`Test push sent: ${result.sent} delivered, ${result.failed} failed (across ${result.totalTokens} devices)`,
        result.sent > 0 ? 'success' : 'error');
    } catch (err) {
      console.error('[push] test broadcast error:', err);
      dialog.showToast('Test broadcast failed: ' + err.message, 'error');
    } finally {
      setPushBusy(false);
    }
  };

  // ── Alert detection ────────────────────────────────────────────────────
  // Each alert maps to a section the commish can jump to. Tier ranking:
  //   action  → needs the commish to DO something now
  //   warn    → data hygiene issues
  //   info    → informational only

  // 1. Pending waivers
  const pendingWaivers = useMemo(
    () => (transactions || []).filter(tx => tx.status === 'pending' && tx.type === 'waiver'),
    [transactions]
  );

  // 2. Tournament ready to mark complete — playing && past end-of-tournament.
  //    Heuristic: today is past startDate + 5 days (Thu start → Tue after Sun).
  const tournamentsReadyToComplete = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return (tournaments || []).filter(t => {
      if (!t.playing || t.completed) return false;
      const start = t.start_date || t.startDate;
      if (!start) return false;
      const sd = new Date(start + 'T12:00:00Z');
      if (isNaN(sd.getTime())) return false;
      sd.setUTCDate(sd.getUTCDate() + 5);
      return today.getTime() >= sd.getTime();
    });
  }, [tournaments]);

  // 3. Of those, the ones with no results yet — distinct alert level.
  const tournamentsNeedingProcess = useMemo(
    () => tournamentsReadyToComplete.filter(t => !t.results?.teams),
    [tournamentsReadyToComplete]
  );

  // 4. Swings ready to award — shared logic with the auto-award + manual panel
  const swingsReadyToAward = useMemo(() => {
    const list = [];
    SWINGS.forEach(segment => {
      const result = computeSwingAward({
        segment,
        allTournaments: tournaments,
        transactions,
        teams,
      });
      if (result) list.push({ segment, winnerName: result.winnerTeam?.name, pot: result.pot });
    });
    return list;
  }, [tournaments, transactions, teams]);

  // 5. Lineup not set — teams missing lineup for the next imminent event.
  //    Imminent = startDate within 7 days. Only surfaces non-alternate events.
  const teamsWithoutLineup = useMemo(() => {
    const nextEvent = (tournaments || []).find(t => !t.completed && !t.isAlternate);
    if (!nextEvent) return { count: 0, eventName: null };
    const start = nextEvent.start_date || nextEvent.startDate;
    if (!start) return { count: 0, eventName: null };
    const sd = new Date(start + 'T12:00:00Z');
    const now = new Date();
    const daysToStart = (sd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    if (daysToStart < -1 || daysToStart > 7) return { count: 0, eventName: null };
    const missing = (teams || []).filter(t => !Array.isArray(t.lineup) || t.lineup.length === 0).length;
    return { count: missing, eventName: nextEvent.name };
  }, [teams, tournaments]);

  // 6. Schedule rows with missing data (post-bulk-import cleanup)
  const incompleteScheduleRows = useMemo(() => {
    return (tournaments || []).filter(t => {
      const hasName = t.name && t.name.trim().length > 0 && t.name !== '(unknown)' && !t.name.startsWith('New Tournament');
      const hasDates = (t.dates && t.dates.trim().length > 0) || (t.start_date && String(t.start_date).length > 0);
      return !hasName || !hasDates;
    }).length;
  }, [tournaments]);

  // 7. Data sync stale — OWGR / PGAT data older than 7 days
  const dataSyncAlerts = useMemo(() => {
    const items = [];
    const STALE_DAYS = 7;
    const now = Date.now();
    const owgrTs = rankingsLastUpdated;
    const pgatTs = settings?.pgatStatsLastSynced;
    if (owgrTs) {
      const ageDays = (now - new Date(owgrTs).getTime()) / (1000 * 60 * 60 * 24);
      if (ageDays > STALE_DAYS) items.push({ source: 'OWGR rankings', days: Math.floor(ageDays) });
    } else {
      items.push({ source: 'OWGR rankings', days: null, never: true });
    }
    if (pgatTs) {
      const ageDays = (now - new Date(pgatTs).getTime()) / (1000 * 60 * 60 * 24);
      if (ageDays > STALE_DAYS) items.push({ source: 'PGAT stats', days: Math.floor(ageDays) });
    }
    return items;
  }, [rankingsLastUpdated, settings?.pgatStatsLastSynced]);

  // 8. LIV-flagged players still on rosters
  const livOnRosters = useMemo(() => {
    const livNames = new Set(
      (allPlayers || []).filter(p => p.isLiv).map(p => p.name.toLowerCase())
    );
    if (livNames.size === 0) return [];
    const offenders = [];
    (teams || []).forEach(team => {
      (team.roster || []).forEach(p => {
        if (p?.name && livNames.has(p.name.toLowerCase())) {
          offenders.push({ team: team.name, player: p.name });
        }
      });
    });
    return offenders;
  }, [teams, allPlayers]);

  // Build the flat alerts list, priority-ordered top→bottom.
  const alerts = [];
  if (pendingWaivers.length > 0) {
    alerts.push({
      level: 'action',
      text: `${pendingWaivers.length} pending waiver${pendingWaivers.length === 1 ? '' : 's'} to process`,
      jump: 'waivers',
    });
  }
  swingsReadyToAward.forEach(s => {
    alerts.push({
      level: 'action',
      text: `${s.segment} ready to award${s.winnerName ? ` — ${s.winnerName} leads` : ''}`,
      jump: 'swing_winner',
    });
  });
  if (tournamentsNeedingProcess.length > 0) {
    tournamentsNeedingProcess.forEach(t => {
      alerts.push({
        level: 'action',
        text: `Process results for "${t.name}"`,
        jump: 'results',
      });
    });
  } else if (tournamentsReadyToComplete.length > 0) {
    tournamentsReadyToComplete.forEach(t => {
      alerts.push({
        level: 'action',
        text: `"${t.name}" ready to mark complete`,
        jump: 'results',
      });
    });
  }
  if (livOnRosters.length > 0) {
    alerts.push({
      level: 'warn',
      text: `${livOnRosters.length} LIV-flagged player${livOnRosters.length === 1 ? '' : 's'} on rosters`,
      jump: 'liv_flag',
    });
  }
  if (incompleteScheduleRows > 0) {
    alerts.push({
      level: 'warn',
      text: `${incompleteScheduleRows} schedule entr${incompleteScheduleRows === 1 ? 'y' : 'ies'} missing data`,
      jump: null,  // schedule edit lives in TournamentsView, not AdminView
    });
  }
  if (teamsWithoutLineup.count > 0 && teamsWithoutLineup.eventName) {
    alerts.push({
      level: 'info',
      text: `${teamsWithoutLineup.count} team${teamsWithoutLineup.count === 1 ? '' : 's'} ${teamsWithoutLineup.count === 1 ? 'has' : 'have'} no lineup for "${teamsWithoutLineup.eventName}"`,
      jump: null,
    });
  }
  dataSyncAlerts.forEach(s => {
    alerts.push({
      level: 'info',
      text: s.never
        ? `${s.source} never synced`
        : `${s.source} last synced ${s.days} day${s.days === 1 ? '' : 's'} ago`,
      jump: 'data_sync',
    });
  });

  // ── Section catalog ────────────────────────────────────────────────────
  const groups = [
    {
      title: 'Tournament Operations',
      tiles: [
        {
          id: 'results', icon: '🏆', label: 'Tournament Results',
          desc: tournamentsNeedingProcess.length > 0
            ? `${tournamentsNeedingProcess.length} ready to process`
            : 'Process & manage events',
          badge: tournamentsNeedingProcess.length > 0
            ? { count: tournamentsNeedingProcess.length, level: 'action' }
            : null,
        },
        {
          id: 'waivers', icon: '📨', label: 'Waiver Claims',
          desc: pendingWaivers.length > 0
            ? `${pendingWaivers.length} pending`
            : 'Process pending waivers',
          badge: pendingWaivers.length > 0
            ? { count: pendingWaivers.length, level: 'action' }
            : null,
        },
        {
          id: 'swing_winner', icon: '🥇', label: 'Swing Winners',
          desc: swingsReadyToAward.length > 0
            ? `${swingsReadyToAward.length} ready to award`
            : 'Award swing pot winners',
          badge: swingsReadyToAward.length > 0
            ? { count: swingsReadyToAward.length, level: 'action' }
            : null,
        },
      ],
    },
    {
      title: 'Player Data',
      tiles: [
        {
          id: 'data_sync', icon: '🔄', label: 'Data Sync',
          desc: dataSyncAlerts.length > 0
            ? `${dataSyncAlerts.length} source${dataSyncAlerts.length === 1 ? '' : 's'} stale`
            : 'OWGR, PGAT stats, headshots',
          badge: dataSyncAlerts.length > 0
            ? { count: dataSyncAlerts.length, level: 'info' }
            : null,
        },
        {
          id: 'liv_flag', icon: '🚫', label: 'LIV Ineligible',
          desc: livOnRosters.length > 0
            ? `${livOnRosters.length} on rosters`
            : 'Flag LIV-eligible players',
          badge: livOnRosters.length > 0
            ? { count: livOnRosters.length, level: 'warn' }
            : null,
        },
        {
          id: 'merge', icon: '🔀', label: 'Merge Players',
          desc: 'Resolve duplicate name records',
        },
      ],
    },
    {
      title: 'People',
      tiles: [
        {
          id: 'managers', icon: '👥', label: 'Manager Accounts',
          desc: `${teams.length} team${teams.length === 1 ? '' : 's'}`,
        },
        {
          id: 'manager_activity', icon: '📊', label: 'Manager Activity',
          desc: 'Recent logins & notification status',
        },
        {
          id: 'commish', icon: '🔔', label: 'Push Notifications',
          desc: 'Test pushes to managers',
        },
      ],
    },
    {
      title: 'League Setup',
      tiles: [
        {
          id: 'settings', icon: '⚙️', label: 'Season Settings',
          desc: 'Schedule, waivers, draft, email',
        },
        {
          id: 'import', icon: '📥', label: 'Import Schedule',
          desc: 'Bulk import next season from PGA Tour',
        },
      ],
    },
  ];

  // ── Section renderer ───────────────────────────────────────────────────
  const renderSection = () => {
    const back = () => setSection(null);
    switch (section) {
      case 'results':
        return (
          <>
            <BackBar label="Tournament Results" onBack={back} />
            <TournamentResultsPanel
              tournaments={tournaments}
              setTournaments={setTournaments}
              teams={teams}
              updateTeams={updateTeams}
              transactions={transactions}
              setTransactions={setTransactions}
              globalPlayerStats={globalPlayerStats}
              setGlobalPlayerStats={setGlobalPlayerStats}
              settings={settings}
              rostersByTeamId={rostersByTeamIdForSelectedTourney}
              loggedInUser={loggedInUser}
            />
          </>
        );
      case 'waivers':
        return (
          <>
            <BackBar label="Waiver Claims" onBack={back} />
            <WaiverProcessingPanel
              transactions={transactions}
              setTransactions={setTransactions}
              teams={teams}
              updateTeams={updateTeams}
              tournaments={tournaments}
              settings={settings}
            />
          </>
        );
      case 'swing_winner':
        return (
          <>
            <BackBar label="Swing Winners" onBack={back} />
            <SwingWinnerPanel
              tournaments={tournaments}
              teams={teams}
              transactions={transactions}
              setTransactions={setTransactions}
              updateTeams={updateTeams}
            />
          </>
        );
      case 'data_sync':
        return (
          <>
            <BackBar label="Data Sync" onBack={back} />
            <DataSyncPanel
              allPlayers={allPlayers}
              setAllPlayers={setAllPlayers}
              teams={teams}
              rankingsLastUpdated={rankingsLastUpdated}
              settings={settings}
              setSettings={setSettings}
              setHeadshots={setHeadshots}
              transactions={transactions}
              setTransactions={setTransactions}
            />
          </>
        );
      case 'liv_flag':
        return (
          <>
            <BackBar label="LIV Ineligible Players" onBack={back} />
            <LivIneligiblePanel allPlayers={allPlayers} setAllPlayers={setAllPlayers} settings={settings} setSettings={setSettings} />
          </>
        );
      case 'merge':
        return (
          <>
            <BackBar label="Merge Players" onBack={back} />
            <MergePlayersPanel
              allPlayers={allPlayers}
              teams={teams}
              transactions={transactions}
              updateTeams={updateTeams}
              setTransactions={setTransactions}
            />
          </>
        );
      case 'managers':
        return (
          <>
            <BackBar label="Manager Accounts" onBack={back} />
            <ManagerAccountsPanel teams={teams} settings={settings} setSettings={setSettings} updateTeams={updateTeams} />
          </>
        );
      case 'manager_activity':
        return (
          <>
            <BackBar label="Manager Activity" onBack={back} />
            <ManagerActivityPanel teams={teams} />
          </>
        );
      case 'commish':
        return (
          <>
            <BackBar label="Push Notifications" onBack={back} />
            <div style={M.page}>
              <div style={M.descText}>
                Subscribe this device, send a test push to yourself, or broadcast a test to all subscribed managers. Per-manager subscription preferences are managed in each manager's own user settings modal.
              </div>

              {/* ── Push Notifications group ── */}
              <div style={M.group}>
                <div style={M.eyebrow}>🔔 Push Notifications (test)</div>
                <div style={M.descText}>
                  Subscribe this device, send a test push to yourself, or broadcast a test to all subscribed managers.
                  <div style={{ marginTop: 6, fontSize: fontSize.sm, opacity: 0.75 }}>
                    <strong style={{ color: colors.textPrimary }}>iPhone:</strong> Add SFGL to your home screen first (Safari → Share → Add to Home Screen), then open the app from the icon before subscribing.
                  </div>
                </div>

                {/* Status row */}
                <div style={M.statusRow}>
                  <div style={M.statusDot(
                    !pushSupported
                      ? colors.textMuted
                      : pushSubscribed
                        ? colors.earningsGreen
                        : pushPermission === 'denied'
                          ? colors.danger
                          : colors.textMuted
                  )} />
                  <div style={{ flex: 1, fontFamily: fonts.sans, fontSize: fontSize.sm, color: colors.textPrimary }}>
                    {!pushSupported
                      ? 'Push notifications not supported in this browser'
                      : pushSubscribed
                        ? `Subscribed${commishTeam ? ` as ${commishTeam.name}` : ''}`
                        : pushPermission === 'denied'
                          ? 'Permission denied — enable in browser settings'
                          : 'This device is not subscribed'}
                  </div>
                </div>

                {/* Action buttons */}
                {!pushSubscribed && pushSupported && pushPermission !== 'denied' && (
                  <button
                    onClick={handleSubscribePush}
                    disabled={pushBusy || !commishTeam}
                    className="modal-feel-lift modal-feel-primary"
                    style={{ ...M.btnPrimary, ...disabledBtn(pushBusy || !commishTeam) }}
                  >
                    {pushBusy ? 'Subscribing…' : 'Subscribe this device'}
                  </button>
                )}
                {pushSubscribed && (
                  <>
                    <button
                      onClick={handleTestPushSelf}
                      disabled={pushBusy}
                      className="modal-feel-lift modal-feel-primary"
                      style={{ ...M.btnPrimary, ...disabledBtn(pushBusy) }}
                    >
                      {pushBusy ? 'Sending…' : 'Send test push to my device'}
                    </button>
                    <button
                      onClick={handleUnsubscribePush}
                      disabled={pushBusy}
                      className="modal-feel-lift"
                      style={{ ...M.btnSecondary, ...disabledBtn(pushBusy) }}
                    >
                      Unsubscribe this device
                    </button>
                  </>
                )}
                <button
                  onClick={handleTestPushAll}
                  disabled={pushBusy || !commishTeam}
                  className="modal-feel-lift modal-feel-warning"
                  style={{ ...M.btnWarning, ...disabledBtn(pushBusy || !commishTeam) }}
                >
                  {pushBusy ? 'Sending…' : '⚠ Send test push to ALL subscribed managers'}
                </button>

                {/* Last test result */}
                {pushLastResult && (
                  <div style={{
                    padding: '10px 12px',
                    background: pushLastResult.sent > 0
                      ? 'rgba(80,195,120,0.06)'
                      : 'rgba(220,80,80,0.06)',
                    border: `1px solid ${pushLastResult.sent > 0
                      ? 'rgba(80,195,120,0.3)'
                      : 'rgba(220,80,80,0.3)'}`,
                    borderRadius: 6,
                    fontFamily: fonts.sans,
                    fontSize: fontSize.sm,
                    color: colors.textSecondary,
                    lineHeight: 1.5,
                  }}>
                    Last test: {pushLastResult.sent} delivered · {pushLastResult.failed} failed · {pushLastResult.totalTokens} total devices targeted
                    {pushLastResult.cleanedUp > 0 && ` · ${pushLastResult.cleanedUp} dead tokens cleaned up`}
                  </div>
                )}
              </div>
            </div>
          </>
        );
      case 'settings':
        return (
          <>
            <BackBar label="Season Settings" onBack={back} />
            <SeasonSettingsPanel
              settings={settings}
              setSettings={setSettings}
            />
          </>
        );
      case 'import':
        return (
          <>
            <BackBar label="Import Schedule" onBack={back} />
            <ScheduleImportPanel
              tournaments={tournaments}
              setTournaments={setTournaments}
            />
          </>
        );
      default:
        return null;
    }
  };

  // Drilled-in: full-bleed section view
  if (section) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', paddingBottom: 40 }}>
        {renderSection()}
      </div>
    );
  }

  // ── Dashboard landing view ─────────────────────────────────────────────
  const levelColor = (level) =>
    level === 'action' ? colors.earningsGreen :
    level === 'warn'   ? colors.warning :
                         'rgba(100,160,255,0.85)';

  const levelBgTint = (level) =>
    level === 'action' ? 'rgba(80,195,120,0.06)' :
    level === 'warn'   ? colors.warningBg :
                         'rgba(100,160,255,0.06)';

  const levelBorder = (level) =>
    level === 'action' ? 'rgba(80,195,120,0.3)' :
    level === 'warn'   ? colors.warningBorder :
                         'rgba(100,160,255,0.3)';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingBottom: 40 }}>

      {/* ── Status banner ── */}
      {alerts.length > 0 ? (
        <div>
          <div style={{
            fontFamily: fonts.sans,
            fontSize: fontSize.xs,
            fontWeight: 700,
            letterSpacing: '1.8px',
            textTransform: 'uppercase',
            color: colors.textMuted,
            marginBottom: 8,
          }}>
            Needs Attention
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {alerts.map((alert, i) => {
              const isClickable = !!alert.jump;
              return (
                <button
                  key={i}
                  onClick={isClickable ? () => setSection(alert.jump) : undefined}
                  disabled={!isClickable}
                  style={{
                    width: '100%',
                    background: levelBgTint(alert.level),
                    border: `1px solid ${levelBorder(alert.level)}`,
                    borderRadius: 6,
                    padding: '10px 14px',
                    cursor: isClickable ? 'pointer' : 'default',
                    textAlign: 'left',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    transition: 'background 0.15s, border-color 0.15s',
                  }}
                >
                  <div style={{
                    width: 8, height: 8, borderRadius: '50%',
                    background: levelColor(alert.level),
                    flexShrink: 0,
                  }} />
                  <div style={{
                    flex: 1,
                    fontFamily: fonts.sans,
                    fontSize: fontSize.base,
                    fontWeight: 600,
                    color: colors.textPrimary,
                  }}>
                    {alert.text}
                  </div>
                  {isClickable && <ChevronRight color={colors.textMuted} />}
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div style={{
          padding: '14px 16px',
          background: 'rgba(80,195,120,0.05)',
          border: '1px solid rgba(80,195,120,0.2)',
          borderRadius: 6,
          fontFamily: fonts.sans,
          fontSize: fontSize.base,
          color: colors.textSecondary,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}>
          <span style={{ fontSize: fontSize.lg }}>✓</span>
          <span>All clear — nothing needs your attention right now.</span>
        </div>
      )}

      {/* ── Section tiles, grouped ── */}
      {groups.map(group => (
        <div key={group.title}>
          <div style={{
            fontFamily: fonts.sans,
            fontSize: fontSize.xs,
            fontWeight: 700,
            letterSpacing: '1.8px',
            textTransform: 'uppercase',
            color: colors.textMuted,
            marginBottom: 8,
          }}>
            {group.title}
          </div>
          <div className="admin-tile-grid">
            {group.tiles.map(tile => (
              <button
                key={tile.id}
                onClick={() => setSection(tile.id)}
                style={{
                  background: colors.cardBg,
                  border: `1px solid ${colors.borderSubtle}`,
                  borderRadius: 8,
                  padding: '14px 14px',
                  cursor: 'pointer',
                  textAlign: 'left',
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  transition: 'background 0.15s, border-color 0.15s',
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.background = colors.cardBgHover;
                  e.currentTarget.style.borderColor = 'rgba(255,255,255,0.18)';
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.background = colors.cardBg;
                  e.currentTarget.style.borderColor = colors.borderSubtle;
                }}
              >
                <span style={{ fontSize: fontSize.tileIcon, lineHeight: 1, flexShrink: 0 }}>{tile.icon}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontFamily: fonts.sans,
                    fontSize: fontSize.md,
                    fontWeight: 600,
                    color: colors.textPrimary,
                  }}>
                    {tile.label}
                  </div>
                  <div style={{
                    fontFamily: fonts.sans,
                    fontSize: fontSize.sm,
                    color: colors.textMuted,
                    marginTop: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {tile.desc}
                  </div>
                </div>
                {tile.badge && (
                  <div style={{
                    minWidth: 22, height: 22, borderRadius: 11, padding: '0 7px',
                    background: levelBgTint(tile.badge.level),
                    border: `1px solid ${levelBorder(tile.badge.level)}`,
                    color: levelColor(tile.badge.level),
                    fontFamily: fonts.sans,
                    fontSize: fontSize.sm, fontWeight: 800,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    flexShrink: 0,
                  }}>
                    {tile.badge.count}
                  </div>
                )}
                <ChevronRight color={colors.textMuted} size={16} />
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
};
