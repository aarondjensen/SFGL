// src/pages/admin/DataSyncPanel.jsx
// ============================================================================
// Five sync operations grouped together (in the order they render):
//   1. OWGR Rankings      — refreshes world rankings + ESPN headshot IDs
//   2. PGAT Stats         — season earnings / events / cuts from CBS + pgatour
//                           profile pages. Updated multiple times — see
//                           api/pgat-stats.js comments for the full debugging
//                           history. Uses 'warning' status when some rostered
//                           players couldn't be matched.
//   3. Rebuild Headshots  — clears cached ESPN IDs and re-fetches. Used when
//                           a stale wrong ID is sitting in Firestore (e.g.
//                           Alex Fitzpatrick showing Matt Fitzpatrick's face).
//   4. LIV Roster Sync    — flags/unflags LIV defectors based on LIV_GOLF_ROSTER
//   5. Static Aliases     — one-shot migration of nameAliases.js into Firestore
//
// All share SyncStatusBanner / LastSyncedLine helpers for consistent styling.
//
// Wave I extraction from AdminView. v2 (Batch 3e) adds the PGAT + Headshots
// sections that were added to AdminView after the v1 extraction.
// ============================================================================

import React from 'react';
import { useDialog } from '../DialogContext';
import { theme, colors } from '../../theme.js';
import { playersApi, playerRankingsApi } from '../../api/firebase';
import { seedAliasesToFirestore } from '../../constants/nameAliases';
import { LIV_GOLF_ROSTER } from '../../constants';
import { S, SyncStatusBanner, LastSyncedLine, disabledBtn } from './adminStyles';

export const DataSyncPanel = ({
  allPlayers, setAllPlayers, teams,
  rankingsLastUpdated,
  settings, setSettings,
  setHeadshots,
}) => {
  const dialog = useDialog();

  // ── OWGR sync state ──
  const [owgrStatus, setOwgrStatus] = React.useState(null);
  const [owgrSummary, setOwgrSummary] = React.useState('');
  const [owgrLastSynced, setOwgrLastSynced] = React.useState(null);

  // ── PGAT stats sync state ──
  const [pgatStatus, setPgatStatus] = React.useState(null);
  const [pgatSummary, setPgatSummary] = React.useState('');
  const [pgatLastSynced, setPgatLastSynced] = React.useState(() => settings?.pgatStatsLastSynced || null);

  // ── Headshot rebuild state ──
  const [hsRebuildStatus, setHsRebuildStatus] = React.useState(null);
  const [hsRebuildSummary, setHsRebuildSummary] = React.useState('');

  // ── LIV sync state ──
  const [livSyncStatus, setLivSyncStatus] = React.useState(null);
  const [livSyncSummary, setLivSyncSummary] = React.useState('');
  const [livLastSynced, setLivLastSynced] = React.useState(() => settings?.livRosterLastSynced || null);

  // ── Alias sync state ──
  const [aliasSyncStatus, setAliasSyncStatus] = React.useState(null);
  const [aliasSyncSummary, setAliasSyncSummary] = React.useState('');

  // ── OWGR handler ──────────────────────────────────────────────────────────
  const handleSyncOwgr = async () => {
    setOwgrStatus('fetching');
    setOwgrSummary('');
    try {
      const resp = await fetch('/api/owgr');
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'OWGR fetch failed');

      const cleanName = n => n.replace(/\s*\([^)]*\)\s*$/, '').trim();
      const fetched = (data.players || [])
        .map(({ name, worldRank }) => ({ name: cleanName(name), worldRank }))
        .filter(p => p.name && p.name.includes(' '));
      if (!fetched.length) throw new Error('No ranking data returned');

      let updatedPlayers = [...allPlayers];
      let updated = 0, added = 0;
      fetched.forEach(({ name, worldRank }) => {
        const idx = updatedPlayers.findIndex(p => p.name.toLowerCase() === name.toLowerCase());
        if (idx >= 0) { updatedPlayers[idx] = { ...updatedPlayers[idx], worldRank }; updated++; }
        else { updatedPlayers.push({ name, worldRank }); added++; }
      });
      await playersApi.upsertMany(fetched.map(({ name, worldRank }) => ({ name, worldRank })));

      // Also fetch ESPN IDs for all rostered players (for headshots)
      try {
        const allRostered = [...new Set(teams.flatMap(t => (t.roster || []).map(p => p.name)))];
        if (allRostered.length) {
          const hsResp = await fetch(`/api/headshots?names=${allRostered.map(n => encodeURIComponent(n)).join(',')}`);
          if (hsResp.ok) {
            const hsData = await hsResp.json();
            const toSave = Object.entries(hsData.results || {}).map(([name, espnId]) => ({ name, espnId }));
            if (toSave.length) await playersApi.upsertMany(toSave);
          }
        }
      } catch (_) { /* non-critical */ }

      setAllPlayers(updatedPlayers);
      await playerRankingsApi.setLastUpdated(new Date().toISOString()).catch(() => {});
      await playerRankingsApi.invalidateCache().catch(() => {});
      setOwgrLastSynced(new Date().toISOString());
      setOwgrStatus('done');
      setOwgrSummary(`✓ ${fetched.length} rankings synced · ${updated} updated · ${added} new`);
    } catch (err) {
      setOwgrStatus('error');
      setOwgrSummary(err.message || 'OWGR sync failed');
    }
  };

  // ── PGAT Stats handler ────────────────────────────────────────────────────
  // Fetches official money/events/cuts from pgatour.com. The "PGA $" column
  // in RostersView displays this data — replacing the stale-prone
  // globalPlayerStats incremental counter that drifts from SFGL processing.
  //
  // Match strategy: try exact name first (case-insensitive). If not found,
  // try a normalized form (lowercase, accent-stripped). New players are
  // added so the table can still surface their data if they get rostered
  // later. The PGA Tour name format is generally stable so collisions
  // between different real-world players are rare; we still log any
  // unmatched names for the commish to review.
  const handleSyncPgatStats = async () => {
    setPgatStatus('fetching');
    setPgatSummary('');
    try {
      // Build the rostered-player list FIRST so we can send it to the API.
      // The API does two things:
      //   1. CBS Sports money list — broad earnings sweep for ~200 players
      //   2. For each name in the roster param, fetches that player's
      //      pgatour.com /results page and parses accurate season stats
      //      (Events, Cuts, Earnings, Wins). Profile data wins over CBS.
      const rosterNamesArr = Array.from(new Set(
        teams.flatMap(t => (t.roster || []).map(p => p?.name).filter(Boolean))
      ));
      const rosterParam = rosterNamesArr.map(n => encodeURIComponent(n)).join(',');

      // Cache-buster + roster param. Roster-enriched responses are NOT cached
      // (each call is roster-specific) so we always get fresh profile data.
      const url = '/api/pgat-stats?t=' + Date.now() +
                  (rosterParam ? '&roster=' + rosterParam : '');
      const resp = await fetch(url);
      const data = await resp.json();
      if (!resp.ok) {
        const detail = data.attempts ? ' — ' + JSON.stringify(data.attempts) : '';
        throw new Error((data.error || 'PGAT fetch failed') + detail);
      }
      const fetched = Array.isArray(data.players) ? data.players : [];
      if (!fetched.length) throw new Error('No player stats returned');

      // Diagnostic logs — surface which rostered players were enriched via
      // PGA Tour profile pages vs. which fell back to CBS-only data.
      console.log('[PGAT Sync] Endpoint returned', fetched.length, 'players.');
      console.log('[PGAT Sync]   ' + (data.rosteredEnriched || 0) + ' of ' + rosterNamesArr.length + ' rostered players enriched from pgatour.com profiles');
      if (data.rosteredMissing && data.rosteredMissing.length > 0) {
        console.log('[PGAT Sync] Rostered players NOT enriched (will use CBS or legacy fallback):', data.rosteredMissing);
      }
      console.log('[PGAT Sync] Top 20 by earnings:', fetched.slice(0, 20).map(p => `${p.name}: $${(p.earnings || 0).toLocaleString()} (${p.cutsMade ?? '—'}/${p.eventsPlayed ?? '—'}) [${p.source || 'cbs'}]`));

      // Normalize names for comparison (lowercase, strip accents, trim).
      // Mirrors the normalizePlayerName approach used elsewhere in the app
      // for the Nordic letter handling (ø → o, æ → ae).
      const normalize = (s) => String(s || '')
        .toLowerCase()
        .replace(/ø/g, 'o').replace(/æ/g, 'ae')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

      const lookup = new Map();
      (allPlayers || []).forEach(p => { if (p.name) lookup.set(normalize(p.name), p); });

      // What players are on a current SFGL roster? We care most about these —
      // any roster player without matched PGAT data shows up in the Stats
      // panel with $0 or stale legacy data. Surfacing this list in the toast
      // lets the commish see exactly which players are missing.
      const rosteredNames = new Set(
        teams.flatMap(t => (t.roster || []).map(p => normalize(p.name)).filter(Boolean))
      );

      const matchedRostered = new Set();
      const updates = [];
      const unmatchedRostered = [];

      // First pass: match every fetched player against our directory.
      // Build each upsert payload conditionally: only include eventsPlayed
      // and cutsMade when CBS actually returned a real value. CBS doesn't
      // have a Cuts column at all (always null), and renders "—" in the
      // Events column for non-FedExCup-eligible players (also null). Writing
      // 0 for those would clobber whatever the legacy globalPlayerStats
      // fallback in RostersView could otherwise surface.
      const buildUpdate = (name, earnings, eventsPlayed, cutsMade) => {
        const payload = {
          name,
          seasonEarnings: earnings || 0,
          statsLastSynced: new Date().toISOString(),
        };
        if (eventsPlayed !== null && eventsPlayed !== undefined) {
          payload.eventsPlayed = eventsPlayed;
        }
        if (cutsMade !== null && cutsMade !== undefined) {
          payload.cutsMade = cutsMade;
        }
        return payload;
      };

      fetched.forEach(({ name, earnings, eventsPlayed, cutsMade }) => {
        const norm = normalize(name);
        const existing = lookup.get(norm);
        if (existing) {
          updates.push(buildUpdate(existing.name, earnings, eventsPlayed, cutsMade));
          if (rosteredNames.has(norm)) matchedRostered.add(norm);
        } else if ((earnings || 0) > 0) {
          // Player not in directory — add them so they're available if
          // rostered later.
          updates.push(buildUpdate(name, earnings, eventsPlayed, cutsMade));
        }
      });

      // Second pass: which rostered players DIDN'T match anyone in the fetch?
      // These are the ones whose Stats panel will show stale data.
      rosteredNames.forEach(rn => {
        if (matchedRostered.has(rn)) return;
        // Find the canonical name from any team's roster for the report
        const display = teams
          .flatMap(t => (t.roster || []).map(p => p.name))
          .find(n => normalize(n) === rn);
        if (display) unmatchedRostered.push(display);
      });

      // Diagnostic: log which roster players failed to match so we can see
      // the spelling difference and fix the parser or add a name alias.
      if (unmatchedRostered.length) {
        console.warn('[PGAT Sync] Roster players NOT matched by PGAT fetch:', unmatchedRostered);
        console.warn('[PGAT Sync] (Check the "Top 20 by earnings" log above — are they spelled differently? Outside top earners?)');
      }

      if (!updates.length) throw new Error('No matching players to update');

      await playersApi.upsertMany(updates);

      // Update in-memory allPlayers so the Stats view reflects immediately
      // without requiring a page reload.
      const updatedByName = new Map(updates.map(u => [u.name, u]));
      const nextPlayers = (allPlayers || []).map(p => {
        const u = updatedByName.get(p.name);
        return u ? { ...p, ...u } : p;
      });
      // Append any "added" players that didn't exist before
      const existingNames = new Set(nextPlayers.map(p => p.name));
      updates.forEach(u => { if (!existingNames.has(u.name)) nextPlayers.push(u); });
      setAllPlayers(nextPlayers);

      // Persist sync timestamp. setSettings is updateSettings from useLeague,
      // so this writes to Firestore AND keeps in-memory state in sync (the
      // inline AdminView version used to bypass via sfglDataApi.set which
      // left React state stale until the next reload).
      const pgatTs = new Date().toISOString();
      setSettings({ ...settings, pgatStatsLastSynced: pgatTs }).catch(() => {});
      setPgatLastSynced(pgatTs);
      setPgatStatus(unmatchedRostered.length > 0 ? 'warning' : 'done');
      // Summary lists unmatched roster players right in the toast so the
      // commish doesn't have to open the console to find them.
      const rosterMatchedCount = matchedRostered.size;
      const rosterTotal = rosteredNames.size;
      const parts = [
        `✓ ${fetched.length} fetched`,
        `${rosterMatchedCount}/${rosterTotal} rostered players matched`,
      ];
      if (unmatchedRostered.length) {
        parts.push(`Missing: ${unmatchedRostered.slice(0, 5).join(', ')}${unmatchedRostered.length > 5 ? ` +${unmatchedRostered.length - 5} more` : ''} (see console)`);
      }
      setPgatSummary(parts.join(' · '));
    } catch (err) {
      setPgatStatus('error');
      setPgatSummary(err.message || 'PGAT sync failed');
    }
  };

  // ── Headshot rebuild handler ──────────────────────────────────────────────
  // When a stale wrong ESPN ID is cached for a player (e.g. Matt
  // Fitzpatrick's ID stored under Alex Fitzpatrick's name), the normal
  // auto-fetch can't fix it: the strict findInMap in the endpoint returns
  // null for ambiguous lookups, and "null" doesn't overwrite an existing
  // value via the upsert path. This handler explicitly clears espn_id for
  // every rostered player and then triggers a fresh fetch — so the strict
  // matcher's results (correct ID, or initials fallback) become canonical.
  const handleRebuildHeadshots = async () => {
    const ok = await dialog.showConfirm(
      'Rebuild Headshot Map',
      'This clears the cached ESPN ID for every rostered player and re-fetches fresh IDs. Players who can\'t be uniquely identified will fall back to initials avatars (better than showing the wrong face).\n\nContinue?',
      { confirmText: 'Rebuild' }
    );
    if (!ok) return;

    setHsRebuildStatus('working');
    setHsRebuildSummary('');
    try {
      const rostered = [...new Set(teams.flatMap(t => (t.roster || []).map(p => p.name)))].filter(Boolean);
      if (!rostered.length) throw new Error('No rostered players found');

      // 1. Clear Firestore (explicit null write — bypasses the upsert path
      //    that skips null espnIds).
      await playersApi.clearEspnIds(rostered);

      // 2. Clear in-memory map so the UI immediately stops showing stale
      //    faces. Falls back to initials until the refetch completes.
      setHeadshots(() => ({}));

      // 3. Immediate refetch via the endpoint. This bypasses the auto-fetch
      //    useEffect's TTL ref (which would block a rapid second fetch).
      const encoded = rostered.map(n => encodeURIComponent(n)).join(',');
      const resp = await fetch(`/api/headshots?names=${encoded}`);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || `Headshot endpoint returned ${resp.status}`);

      const results = data?.results || {};
      const notFound = data?.notFound || [];
      const foundCount = Object.keys(results).length;

      // 4. Apply new IDs to client state and persist to Firestore.
      if (foundCount > 0) {
        setHeadshots(prev => ({ ...(prev || {}), ...results }));
        await playersApi.upsertMany(
          Object.entries(results).map(([name, espnId]) => ({ name, espnId }))
        );
      }

      // Log unresolved names so the commish can see exactly who fell back.
      // These are usually lower-tier players who didn't play in any of the
      // ESPN_EVENT_IDS the endpoint indexes — solvable by adding more event
      // IDs to api/headshots.js or by manual override.
      if (notFound.length) {
        console.warn('[RebuildHeadshots] Players not uniquely identifiable in ESPN index:', notFound);
        console.warn('[RebuildHeadshots] These players now use the initials-avatar fallback. To fix specific players, add an ESPN event ID where they played to api/headshots.js ESPN_EVENT_IDS.');
      }

      setHsRebuildStatus(notFound.length > 0 ? 'warning' : 'done');
      const parts = [`✓ ${foundCount}/${rostered.length} headshots rebuilt`];
      if (notFound.length) {
        parts.push(`${notFound.length} fell back to initials: ${notFound.slice(0, 4).join(', ')}${notFound.length > 4 ? ` +${notFound.length - 4} more` : ''} (see console)`);
      }
      setHsRebuildSummary(parts.join(' · '));
    } catch (err) {
      setHsRebuildStatus('error');
      setHsRebuildSummary(err.message || 'Rebuild failed');
    }
  };

  // ── LIV roster handler ────────────────────────────────────────────────────
  const handleSyncLiv = async () => {
    setLivSyncStatus('fetching');
    setLivSyncSummary('');
    try {
      const livRosterLower = new Set(LIV_GOLF_ROSTER.map(n => n.toLowerCase()));
      const toFlag = LIV_GOLF_ROSTER.filter(name =>
        !allPlayers.find(p => p.name.toLowerCase() === name.toLowerCase())?.isLiv
      );
      const toUnflag = allPlayers.filter(p =>
        p.isLiv && !livRosterLower.has(p.name.toLowerCase())
      );
      if (toFlag.length === 0 && toUnflag.length === 0) {
        setLivSyncStatus('done');
        setLivSyncSummary('✓ LIV roster already matches DB — no changes needed');
        return;
      }
      const livWrites = [
        ...toFlag.map(name => ({ name, isLiv: true })),
        ...toUnflag.map(p => ({ name: p.name, isLiv: false })),
      ];
      await playersApi.upsertMany(livWrites);
      setAllPlayers(prev => {
        const updated = [...prev];
        toFlag.forEach(name => {
          const idx = updated.findIndex(p => p.name.toLowerCase() === name.toLowerCase());
          if (idx >= 0) updated[idx] = { ...updated[idx], isLiv: true };
          else updated.push({ name, isLiv: true, worldRank: null });
        });
        toUnflag.forEach(u => {
          const idx = updated.findIndex(p => p.name === u.name);
          if (idx >= 0) updated[idx] = { ...updated[idx], isLiv: false };
        });
        return updated;
      });
      const parts = [
        toFlag.length   > 0 ? `${toFlag.length} tagged` : '',
        toUnflag.length > 0 ? `${toUnflag.length} unflagged` : '',
      ].filter(Boolean).join(' · ');
      const livTs = new Date().toISOString();
      setLivLastSynced(livTs);
      setSettings({ ...settings, livRosterLastSynced: livTs }).catch(() => {});
      setLivSyncStatus('done');
      setLivSyncSummary(`✓ LIV roster synced · ${parts}`);
    } catch (err) {
      setLivSyncStatus('error');
      setLivSyncSummary(err.message || 'LIV sync failed');
    }
  };

  // ── Static alias seed handler ─────────────────────────────────────────────
  const handleSeedAliases = async () => {
    setAliasSyncStatus('fetching');
    setAliasSyncSummary('');
    try {
      const r = await seedAliasesToFirestore(playersApi);
      const parts = [
        r.added          > 0 ? `${r.added} added` : '',
        r.alreadyPresent > 0 ? `${r.alreadyPresent} already present` : '',
        r.skipped        > 0 ? `${r.skipped} skipped` : '',
      ].filter(Boolean).join(' · ') || 'no entries to process';
      const detail = r.errors.length ? '\n• ' + r.errors.join('\n• ') : '';
      setAliasSyncStatus(r.errors.length && r.added === 0 && r.alreadyPresent === 0 ? 'error' : 'done');
      setAliasSyncSummary(`✓ Static aliases synced · ${parts}${detail}`);
    } catch (err) {
      setAliasSyncStatus('error');
      setAliasSyncSummary(err.message || 'Alias sync failed');
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      {/* ── 1. OWGR Rankings ── */}
      <div style={S.section}>
        <div style={S.title}>🌍 Update OWGR Rankings</div>
        <LastSyncedLine timestamp={owgrLastSynced || rankingsLastUpdated} />
        <button
          onClick={handleSyncOwgr}
          disabled={owgrStatus === 'fetching'}
          style={{ ...S.btn, ...disabledBtn(owgrStatus === 'fetching') }}
        >
          {owgrStatus === 'fetching' ? '⏳ Fetching…' : '🔄 Sync OWGR Rankings'}
        </button>
        <SyncStatusBanner status={owgrStatus} summary={owgrSummary} />
      </div>

      {/* ── 2. PGAT Stats ── */}
      <div style={S.section}>
        <div style={S.title}>💰 Update PGAT Stats</div>
        <LastSyncedLine timestamp={pgatLastSynced} />
        <button
          onClick={handleSyncPgatStats}
          disabled={pgatStatus === 'fetching'}
          style={{ ...S.btn, ...disabledBtn(pgatStatus === 'fetching') }}
        >
          {pgatStatus === 'fetching' ? '⏳ Fetching…' : '🔄 Sync PGAT Stats'}
        </button>
        <SyncStatusBanner status={pgatStatus} summary={pgatSummary} />
      </div>

      {/* ── 3. Rebuild Headshots ── */}
      <div style={S.section}>
        <div style={S.title}>🖼️ Rebuild Headshot Map</div>
        <div style={{ ...theme.smallText, color: colors.textGoldDim, marginBottom: 10 }}>
          Clears cached ESPN IDs and re-fetches fresh ones. Use when a player shows the wrong face.
        </div>
        <button
          onClick={handleRebuildHeadshots}
          disabled={hsRebuildStatus === 'working'}
          style={{ ...S.btn, ...disabledBtn(hsRebuildStatus === 'working') }}
        >
          {hsRebuildStatus === 'working' ? '⏳ Rebuilding…' : '🔄 Rebuild Headshots'}
        </button>
        <SyncStatusBanner status={hsRebuildStatus} summary={hsRebuildSummary} />
      </div>

      {/* ── 4. LIV Roster Sync ── */}
      <div style={S.section}>
        <div style={S.title}>🚫 LIV Golf — Sync Roster</div>
        <LastSyncedLine timestamp={livLastSynced || settings?.livRosterLastSynced} />
        <button
          onClick={handleSyncLiv}
          disabled={livSyncStatus === 'fetching'}
          style={{ ...S.btn, ...disabledBtn(livSyncStatus === 'fetching') }}
        >
          {livSyncStatus === 'fetching' ? '⏳ Syncing…' : '🔄 Sync LIV Roster'}
        </button>
        <SyncStatusBanner status={livSyncStatus} summary={livSyncSummary} />
      </div>

      {/* ── 5. Static Alias Sync ── */}
      <div style={S.section}>
        <div style={S.title}>🔗 Static Aliases — Sync to Firestore</div>
        <div style={{ ...theme.smallText, marginBottom: 10, color: colors.textSecondary }}>
          Copies the historical aliases hard-coded in <code>nameAliases.js</code> into Firestore as dynamic aliases on each canonical player doc. Run once after deploying. Idempotent — safe to re-run. New aliases going forward should use the Merge Players feature instead.
        </div>
        <button
          onClick={handleSeedAliases}
          disabled={aliasSyncStatus === 'fetching'}
          style={{ ...S.btn, ...disabledBtn(aliasSyncStatus === 'fetching') }}
        >
          {aliasSyncStatus === 'fetching' ? '⏳ Syncing…' : '🔄 Sync Static Aliases'}
        </button>
        <SyncStatusBanner status={aliasSyncStatus} summary={aliasSyncSummary} />
      </div>
    </>
  );
};
