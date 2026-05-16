// src/pages/admin/WaiverProcessingPanel.jsx
// ============================================================================
// Waiver claim processing — single-claim or batch ("Process All").
// Includes the conflict-summary UI showing competing claims with tiebreaker.
// Wave I extraction from AdminView.
// ============================================================================

import React from 'react';
import { useDialog } from '../DialogContext';
import { theme, colors, fonts } from '../../theme.js';
import { sfglDataApi } from '../../api/firebase';
import { S } from './adminStyles';
import { getETClock, fmtETTime, DAY_NAMES } from '../../utils/sharedHelpers';

const buildRoster = (team, transactions) => {
  let r = team.roster.map(p => p.name);
  transactions
    .filter(tx => tx.team === team.name && tx.status === 'processed' && tx.type !== 'mulligan')
    .forEach(tx => {
      if (tx.droppedPlayer) r = r.filter(n => n !== tx.droppedPlayer);
      if (!r.includes(tx.player)) r.push(tx.player);
    });
  return new Set(r);
};

const applyWaiver = (t, w) => {
  if (t.name !== w.team) return t;
  let r = [...t.roster];
  if (w.droppedPlayer) r = r.filter(p => p.name !== w.droppedPlayer);
  if (!r.some(p => p.name === w.player)) {
    r.push({ name: w.player, limited: false, unlimited: false, stars: 0, starts: 0, eventsPlayed: 0, cutsMade: 0, pgaTourEarnings: 0, sfglEarnings: 0 });
  }
  return { ...t, roster: r };
};

export const WaiverProcessingPanel = ({
  transactions, setTransactions,
  teams, updateTeams,
  tournaments,
  settings,
  STORAGE_KEYS,
}) => {
  const dialog = useDialog();
  const [waiverRevealed, setWaiverRevealed] = React.useState(false);

  const pending = transactions
    .map((tx, i) => ({ ...tx, _idx: i }))
    .filter(tx => tx.status === 'pending' && tx.type === 'waiver');

  const wd = settings?.waiverDay    ?? 2;
  const wh = settings?.waiverHour   ?? 20;
  const wm = settings?.waiverMinute ?? 0;
  const { day: etDay, totalMinutes } = getETClock();
  const isReadyToProcess = etDay === wd && totalMinutes >= (wh * 60 + wm) && pending.length > 0;
  const ready = etDay === wd && totalMinutes >= (wh * 60 + wm);

  const handleProcessSingle = async (w) => {
    const allRostered = new Set();
    teams.forEach(t => t.roster.forEach(p => allRostered.add(p.name)));
    if (allRostered.has(w.player)) {
      const tx2 = transactions.map((tx, i) => i === w._idx
        ? { ...tx, status: 'failed', failReason: 'Player already rostered', processedDate: new Date().toLocaleDateString() }
        : tx);
      setTransactions(tx2); sfglDataApi.set(STORAGE_KEYS.TRANSACTIONS, tx2).catch(() => {});
      dialog.showToast(w.player + ' already rostered', 'error'); return;
    }
    if (w.droppedPlayer && !teams.find(t => t.name === w.team)?.roster.some(p => p.name === w.droppedPlayer)) {
      const tx2 = transactions.map((tx, i) => i === w._idx
        ? { ...tx, status: 'failed', failReason: w.droppedPlayer + ' already dropped', processedDate: new Date().toLocaleDateString() }
        : tx);
      setTransactions(tx2); sfglDataApi.set(STORAGE_KEYS.TRANSACTIONS, tx2).catch(() => {});
      dialog.showToast(w.droppedPlayer + ' already dropped', 'error'); return;
    }

    const competing = transactions
      .map((tx, i) => ({ ...tx, _idx: i }))
      .filter(tx => tx.status === 'pending' && tx.type === 'waiver' && tx.player === w.player && tx.team !== w.team);
    const earningsMap = {}; teams.forEach(t => { earningsMap[t.name] = t.earnings || 0; });
    const allClaims = [w, ...competing].sort((a, b) => (earningsMap[a.team] || 0) - (earningsMap[b.team] || 0));
    const winner = allClaims[0];
    const losers = allClaims.slice(1);

    let tx2 = [...transactions];
    tx2[winner._idx] = { ...tx2[winner._idx], status: 'processed', processedDate: new Date().toLocaleDateString() };
    losers.forEach(l => {
      const winEarn = '$' + (earningsMap[winner.team] || 0).toLocaleString();
      const loseEarn = '$' + (earningsMap[l.team] || 0).toLocaleString();
      tx2[l._idx] = { ...tx2[l._idx], status: 'failed', failReason: `Lost tiebreaker to ${winner.team} (${winEarn} vs ${loseEarn})`, processedDate: new Date().toLocaleDateString() };
    });

    const t2 = teams.map(t => applyWaiver(t, winner));
    setTransactions(tx2); updateTeams(t2);
    sfglDataApi.set(STORAGE_KEYS.TRANSACTIONS, tx2).catch(() => {});
    if (losers.length) {
      dialog.showToast(winner.team + ' wins claim · ' + losers.map(l => l.team).join(', ') + ' blocked', 'success');
    } else {
      dialog.showToast(winner.team + ' adds ' + winner.player + (winner.droppedPlayer ? ' / drops ' + winner.droppedPlayer : ''), 'success');
    }
  };

  const handleProcessAll = async () => {
    if (!pending.length) return;
    const ok = await dialog.showConfirm(
      'Process All Waivers',
      'Process ' + pending.length + ' pending claim' + (pending.length !== 1 ? 's' : '') + '?\n\nTie-breaker: reverse standings (lowest earnings = highest priority). Winners move to back of the line for subsequent claims.',
      { confirmText: 'Process All' }
    );
    if (!ok) return;

    // Derive each team's current season earnings from tournament.results so
    // waiver priority isn't affected by drift in the stored team.earnings
    // field. Mirrors StandingsView's seasonTotals derivation.
    const derivedEarnings = {};
    teams.forEach(t => { derivedEarnings[t.id] = 0; });
    (tournaments || []).forEach(t => {
      if (!t.completed || !t.results?.teams) return;
      Object.entries(t.results.teams).forEach(([teamId, result]) => {
        if (derivedEarnings[teamId] !== undefined) derivedEarnings[teamId] += (result.totalEarnings || 0);
      });
    });
    const em = {}; teams.forEach(t => { em[t.name] = derivedEarnings[t.id] || 0; });
    const pm = {};
    [...teams].sort((a, b) => (derivedEarnings[a.id] || 0) - (derivedEarnings[b.id] || 0)).forEach((t, i) => { pm[t.name] = i; });
    let nextLastPlace = teams.length;

    const byTeam = {};
    pending.forEach(w => { if (!byTeam[w.team]) byTeam[w.team] = []; byTeam[w.team].push(w); });
    Object.values(byTeam).forEach(c => c.sort((a, b) => (a.priority || 999) - (b.priority || 999)));

    const allR = new Set();
    teams.forEach(t => buildRoster(t, transactions).forEach(n => allR.add(n)));

    const dropped = new Set(), done = new Set(), failed = new Set(), applied = [];
    const tx2 = [...transactions];
    let processedCount = 0, failedCount = 0, more = true;

    while (more) {
      more = false;
      const round = [];
      Object.entries(byTeam).forEach(([tn, claims]) => {
        const top = claims.find(c => !done.has(c._idx) && !failed.has(c._idx));
        if (top) round.push({ tn, claim: top, o: pm[tn] ?? 999 });
      });
      if (!round.length) break;

      const byPlayer = {};
      round.forEach(rc => {
        if (!byPlayer[rc.claim.player]) byPlayer[rc.claim.player] = [];
        byPlayer[rc.claim.player].push(rc);
      });

      Object.entries(byPlayer).forEach(([player, cs]) => {
        cs.sort((a, b) => a.o - b.o);
        const w = cs[0];

        if (allR.has(player)) {
          cs.forEach(c => {
            failed.add(c.claim._idx);
            tx2[c.claim._idx] = { ...tx2[c.claim._idx], status: 'failed', failReason: 'Player already rostered', processedDate: new Date().toLocaleDateString() };
            failedCount++;
          });
          more = true; return;
        }
        if (w.claim.droppedPlayer && (dropped.has(w.claim.droppedPlayer) || !allR.has(w.claim.droppedPlayer))) {
          failed.add(w.claim._idx);
          tx2[w.claim._idx] = { ...tx2[w.claim._idx], status: 'failed', failReason: w.claim.droppedPlayer + ' already dropped', processedDate: new Date().toLocaleDateString() };
          failedCount++; more = true; return;
        }
        if (w.claim.droppedPlayer) { allR.delete(w.claim.droppedPlayer); dropped.add(w.claim.droppedPlayer); }
        allR.add(player);
        done.add(w.claim._idx);
        tx2[w.claim._idx] = { ...tx2[w.claim._idx], status: 'processed', processedDate: new Date().toLocaleDateString() };
        applied.push(w.claim);
        processedCount++;
        pm[w.tn] = nextLastPlace++;

        const winEarn = '$' + (em[w.tn] || 0).toLocaleString();
        cs.slice(1).forEach(l => {
          const loseEarn = '$' + (em[l.tn] || 0).toLocaleString();
          failed.add(l.claim._idx);
          tx2[l.claim._idx] = { ...tx2[l.claim._idx], status: 'failed', failReason: `Lost tiebreaker to ${w.tn} (${winEarn} vs ${loseEarn})`, processedDate: new Date().toLocaleDateString() };
          failedCount++;
        });
        more = true;
      });
    }

    let t2 = [...teams];
    applied.forEach(w => { t2 = t2.map(t => applyWaiver(t, w)); });
    setTransactions(tx2); updateTeams(t2);
    sfglDataApi.set(STORAGE_KEYS.TRANSACTIONS, tx2).catch(() => {});
    sfglDataApi.set(STORAGE_KEYS.TEAMS, t2).catch(() => {});

    dialog.showToast(
      'Processed ' + processedCount + (failedCount ? ' · ' + failedCount + ' failed' : ''),
      processedCount > 0 ? 'success' : 'error'
    );
  };

  return (
    <div style={S.section}>
      {/* "Past schedule" reminder banner */}
      {isReadyToProcess && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', marginBottom: 10, borderRadius: 3,
          background: 'rgba(220,170,60,0.1)', border: '1px solid rgba(220,170,60,0.45)',
        }}>
          <span style={{ fontSize: 14 }}>⏰</span>
          <div style={{ flex: 1, fontFamily: fonts.sans, fontSize: 11, color: 'rgba(220,190,80,0.9)', fontWeight: 600 }}>
            Past {fmtETTime(wh, wm)} ET {DAY_NAMES[wd]} — process now!
          </div>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={S.title}>⏰ Process Waivers</div>
        {pending.length > 0 && <span style={{ ...theme.badge, ...theme.badgeWarning }}>{pending.length} pending</span>}
      </div>

      {pending.length === 0 ? (
        <div style={{ ...theme.smallText, textAlign: 'center', padding: '8px 0', color: colors.success }}>
          ✓ No pending waiver claims
        </div>
      ) : !waiverRevealed ? (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
            {pending.map(w => (
              <div key={w._idx} style={{ display: 'flex', alignItems: 'center', gap: 8, background: colors.inputBg, border: `1px solid ${colors.borderSubtle}`, borderRadius: 3, padding: '6px 12px' }}>
                <div style={{ width: 18, height: 18, borderRadius: '50%', background: 'rgba(220,170,60,0.1)', border: '1px solid rgba(220,170,60,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700, color: colors.warning, flexShrink: 0 }}>
                  {w.priority || '?'}
                </div>
                <div style={{ fontFamily: fonts.sans, fontSize: 12, fontWeight: 600, color: colors.textPrimary }}>{w.team}</div>
                <div style={{ flex: 1 }} />
                <span style={{ fontFamily: fonts.sans, fontSize: 10, color: colors.textMuted }}>claim pending</span>
              </div>
            ))}
          </div>
          <button
            onClick={() => setWaiverRevealed(true)}
            style={ready
              ? { ...S.btn, fontSize: 13, fontWeight: 700, padding: '12px 20px', background: 'rgba(220,170,60,0.2)', border: '2px solid rgba(220,170,60,0.7)', color: 'rgba(255,220,80,1)', boxShadow: '0 0 12px rgba(220,170,60,0.25)' }
              : { ...S.btnSec, fontSize: 11 }
            }
          >
            {ready ? `⚡ Process Claims (${pending.length})` : `Process Claims (${pending.length})`}
          </button>
        </>
      ) : (
        <>
          <ConflictSummary pending={pending} teams={teams} />
          <button onClick={handleProcessAll} style={{ ...S.btn, marginBottom: 8 }}>⚡ Process All ({pending.length})</button>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {pending.map(w => (
              <div key={w._idx} style={{ display: 'flex', alignItems: 'center', gap: 10, background: colors.inputBg, border: `1px solid ${colors.borderSubtle}`, borderRadius: 3, padding: '8px 12px' }}>
                <div style={{ width: 20, height: 20, borderRadius: '50%', background: 'rgba(220,170,60,0.1)', border: '1px solid rgba(220,170,60,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, color: colors.warning, flexShrink: 0 }}>
                  {w.priority || '?'}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: fonts.sans, fontSize: 12, fontWeight: 600, color: colors.textPrimary }}>{w.team}</div>
                  <div style={{ fontSize: 11 }}>
                    <span style={{ color: colors.earningsGreen }}>+{w.player}</span>
                    {w.droppedPlayer && <span style={{ color: colors.danger }}> / -{w.droppedPlayer}</span>}
                  </div>
                </div>
                <button
                  onClick={() => handleProcessSingle(w)}
                  style={{ ...theme.btnSecondary, padding: '5px 10px', fontSize: 11, flexShrink: 0 }}
                >
                  Process
                </button>
              </div>
            ))}
          </div>
          <button
            onClick={() => setWaiverRevealed(false)}
            style={{ ...theme.btnSecondary, marginTop: 8, fontSize: 10, padding: '4px 12px', width: 'auto', display: 'inline-block' }}
          >
            Hide Claims
          </button>
        </>
      )}
    </div>
  );
};

// ── Conflict summary component ────────────────────────────────────────────────
const ConflictSummary = ({ pending, teams }) => {
  const byPlayer = {};
  pending.forEach(w => {
    if (!byPlayer[w.player]) byPlayer[w.player] = [];
    byPlayer[w.player].push(w);
  });
  const conflicts = Object.entries(byPlayer).filter(([, claims]) => claims.length > 1);
  if (conflicts.length === 0) return null;

  const earningsMap = {};
  teams.forEach(t => { earningsMap[t.name] = t.earnings || 0; });
  const fmt = n => '$' + (n || 0).toLocaleString();

  return (
    <div style={{
      background: 'rgba(220,100,60,0.08)', border: '1px solid rgba(220,100,60,0.35)',
      borderRadius: 3, padding: '10px 14px', marginBottom: 10,
    }}>
      <div style={{ fontFamily: fonts.sans, fontSize: 11, fontWeight: 700, letterSpacing: '1.5px', textTransform: 'uppercase', color: 'rgba(220,140,80,0.9)', marginBottom: 8 }}>
        ⚠️ Competing Claims ({conflicts.length})
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {conflicts.map(([player, claims]) => {
          const sorted = [...claims].sort((a, b) => (earningsMap[a.team] || 0) - (earningsMap[b.team] || 0));
          return (
            <div key={player} style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 2, padding: '8px 10px' }}>
              <div style={{ fontFamily: fonts.sans, fontSize: 12, fontWeight: 600, color: colors.textPrimary, marginBottom: 4 }}>
                {player} — {claims.length} teams competing
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {sorted.map((c, i) => (
                  <div key={c.team} style={{ fontFamily: fonts.sans, fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 9, fontWeight: 700, width: 14, textAlign: 'center', color: i === 0 ? colors.earningsGreen : colors.textMuted }}>
                      {i + 1}.
                    </span>
                    <span style={{ color: i === 0 ? colors.textPrimary : colors.textMuted, fontWeight: i === 0 ? 600 : 400 }}>
                      {c.team}
                    </span>
                    <span style={{ color: colors.textMuted, fontSize: 10 }}>{fmt(earningsMap[c.team])}</span>
                    {i === 0 && <span style={{ color: colors.earningsGreen, fontSize: 10, fontWeight: 600 }}>← wins</span>}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ ...theme.smallText, color: colors.textMuted, marginTop: 6 }}>
        Tiebreaker: lowest total SFGL earnings wins. Winner moves to back of line.
      </div>
    </div>
  );
};
