import { useMemo, useState, useEffect, useRef } from 'react';
import { colors, fonts, SWINGS, fontSize, blue, green, white } from '../theme.js';
import { resolveTournamentStart, isTournamentWeekOver, getETNow } from '../utils';
import { computeSwingAward } from '../utils/swingAward';
import { buildEffectiveRoster } from '../utils/sharedHelpers';
import { sfglDataApi } from '../api/firebase';
import { NameSet } from '../../api/_playerNames.js';

// Panel imports — each becomes a drillable section in the new architecture.
import { DataSyncPanel } from './admin/DataSyncPanel';
import { LivIneligiblePanel } from './admin/LivIneligiblePanel';
import { ManagerAccountsPanel } from './admin/ManagerAccountsPanel';
import { MergePlayersPanel } from './admin/MergePlayersPanel';
import { NameAuditPanel } from './admin/NameAuditPanel';
import { ScheduleImportPanel } from './admin/ScheduleImportPanel';
import { SeasonSettingsPanel } from './admin/SeasonSettingsPanel';
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
          background: white(0.05),
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
        map[t.id] = buildEffectiveRoster(t, safeTx, { asArray: true, tournaments });
      } catch (err) {
        console.warn('[AdminView] roster snapshot failed for', t.name, err);
        map[t.id] = t.roster || [];
      }
    });
    return map;
  }, [teams, transactions]);

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

  // 2. Tournament ready to mark complete — playing && the tournament week is over.
  //
  // This used to read the RAW `start_date` field and add 5 days. Two problems:
  //
  //   • `start_date` is an ORDERING field, not a real date. _ensureStartDates in
  //     api/firebase.js back-fills missing ones with a synthetic weekly series
  //     anchored at '2025-01-06', so for many events it has no relationship to
  //     when the tournament is actually played. Adding 5 days to a synthetic
  //     date produces a meaningless threshold — which is how the 3M Open showed
  //     as "ready to process" on the SATURDAY of its own tournament week, two
  //     rounds before it finished.
  //
  //   • Even with a real date, +5 days only lands after Sunday if the stored
  //     date happens to be the Thursday. A Sunday- or Monday-anchored date puts
  //     the threshold mid-event.
  //
  // Now it uses the same anchoring as every other lock/window calculation in the
  // app: resolveTournamentStart (real date → parsed `dates` string → the raw
  // ordering field only as a last resort), walk forward to that week's
  // Thursday, and treat the event as finished once the following MONDAY begins
  // in ET.
  //
  // The walk itself now lives in api/_league.js as isTournamentWeekOver, so the
  // results cron applies the same test before it scores an event — it had no
  // date logic at all and scored the BMW Championship three days before it
  // started. An undated event answers null ("cannot tell"), which is not
  // ready-to-complete here.
  const tournamentsReadyToComplete = useMemo(() => {
    const et = getETNow();
    return (tournaments || []).filter(t =>
      t.playing && !t.completed && isTournamentWeekOver(t, et) === true
    );
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
        settings,
      });
      if (result) list.push({ segment, winnerName: result.winnerTeam?.name, pot: result.pot });
    });
    return list;
  }, [tournaments, transactions, teams, settings]);

  // 5. Lineup not set — teams missing lineup for the next imminent event.
  //    Imminent = start within 7 days. Only surfaces non-alternate events.
  const teamsWithoutLineup = useMemo(() => {
    const nextEvent = (tournaments || []).find(t => !t.completed && !t.isAlternate);
    if (!nextEvent) return { count: 0, eventName: null };
    // Same resolution as tournamentsReadyToComplete above — this used to reach
    // for the raw ordering field FIRST, so for any event whose start_date was
    // back-filled synthetically the "within 7 days" test was measured against a
    // date the tournament is not played on. And it measured from the machine's
    // local clock while every other window in the app measures from ET.
    const sd = resolveTournamentStart(nextEvent);
    if (!sd) return { count: 0, eventName: null };
    const daysToStart = (sd.getTime() - getETNow().getTime()) / (1000 * 60 * 60 * 24);
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
    // Intentional read of the clock inside the memo: staleness is measured in
    // DAYS, so recomputing only when rankingsLastUpdated / settings change is
    // plenty fresh, and a ticking timer would be pure overhead on a dashboard
    // that's re-mounted every visit.
    // eslint-disable-next-line react-hooks/purity
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
    // Matched by player identity rather than lowercased string equality. A
    // roster entry spelled differently from the flagged player doc — the
    // 'Byeong Hun An' / 'Byeong-Hun An' shape — used to slip past this check
    // entirely, leaving an ineligible player sitting on a roster with no
    // warning anywhere.
    const livNames = new NameSet((allPlayers || []).filter(p => p.isLiv).map(p => p.name));
    if (livNames.size === 0) return [];
    const offenders = [];
    (teams || []).forEach(team => {
      (team.roster || []).forEach(p => {
        if (p?.name && livNames.has(p.name)) {
          offenders.push({ team: team.name, player: p.name });
        }
      });
    });
    return offenders;
  }, [teams, allPlayers]);

  // 9. Player names our data sources didn't recognise.
  //
  // Written by the weekly field check (api/cron.js -> writeNameAudit) and by
  // the on-demand audit in NameAuditPanel. Surfaced here so an unrecognised
  // name reaches the commissioner on the dashboard, rather than waiting for
  // someone to open the panel — the whole point is that managers shouldn't be
  // the ones who discover it.
  const [nameAuditFindings, setNameAuditFindings] = useState(0);
  useEffect(() => {
    let cancelled = false;
    sfglDataApi.get('nameAudit')
      .then((stored) => {
        if (cancelled || !stored) return;
        const fromSections = (stored.sections || [])
          .reduce((n, sec) => n + (sec.unmatched?.length || 0), 0);
        setNameAuditFindings(fromSections || (stored.suspectedMismatches?.length || 0));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Build the flat alerts list, priority-ordered top→bottom.
  const alerts = [];
  if (pendingWaivers.length > 0) {
    alerts.push({
      level: 'action',
      text: `${pendingWaivers.length} pending waiver${pendingWaivers.length === 1 ? '' : 's'} to process`,
      jump: 'waivers',
    });
  }
  // Swing winners auto-award the moment the final event of a swing is
  // processed (client process/reprocess paths + the server cron path). This
  // alert is now purely a safety signal: it only ever populates if that
  // auto-award DIDN'T fire for some reason. Recovery is to reprocess the
  // swing's final event, which re-runs the same award logic idempotently —
  // so the alert routes to the results panel rather than a manual award UI.
  swingsReadyToAward.forEach(s => {
    alerts.push({
      level: 'action',
      text: `${s.segment} auto-award didn't fire${s.winnerName ? ` — ${s.winnerName} leads` : ''}. Reprocess the final event to award the pot.`,
      jump: 'results',
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
  if (nameAuditFindings > 0) {
    alerts.push({
      level: 'warn',
      text: `${nameAuditFindings} player name${nameAuditFindings === 1 ? '' : 's'} not recognised by our data sources`,
      jump: 'name_audit',
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
        {
          id: 'name_audit', icon: '🔍', label: 'Name Audit',
          desc: nameAuditFindings > 0
            ? `${nameAuditFindings} name${nameAuditFindings === 1 ? '' : 's'} need review`
            : 'Check names against data sources',
          badge: nameAuditFindings > 0
            ? { count: nameAuditFindings, level: 'warn' }
            : null,
        },
      ],
    },
    {
      title: 'People',
      tiles: [
        {
          id: 'managers', icon: '👥', label: 'Managers',
          desc: 'Claims, logins, emails & access',
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
      case 'name_audit':
        return (
          <>
            <BackBar label="Name Audit" onBack={back} />
            <NameAuditPanel teams={teams} />
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
            <BackBar label="Managers" onBack={back} />
            <ManagerAccountsPanel teams={teams} />
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
                         blue(0.85);

  const levelBgTint = (level) =>
    level === 'action' ? green(0.06) :
    level === 'warn'   ? colors.warningBg :
                         blue(0.06);

  const levelBorder = (level) =>
    level === 'action' ? green(0.3) :
    level === 'warn'   ? colors.warningBorder :
                         blue(0.3);

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
          background: green(0.05),
          border: `1px solid ${green(0.2)}`,
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
                  e.currentTarget.style.borderColor = white(0.18);
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
