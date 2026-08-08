// src/pages/admin/NameAuditPanel.jsx
// ============================================================================
// Name Audit — the automatic half of the player-name fix.
//
// api/_playerNames.js resolves every name mismatch we know how to describe:
// spelling, punctuation, accents, "Last, First" order, nicknames ('Nico' ≡
// 'Nicolas'), initials ('K.H. Lee' ≡ 'Kyoung-Hoon Lee'), and an explicit alias
// list for the handful no rule can derive. Those need no human attention.
//
// This panel exists for the mismatches nobody has described yet. It runs the
// league's names against the field, the player directory and the live
// leaderboard, and shows anything that failed to match ALONGSIDE the closest
// candidates — so a new mismatch surfaces here, to the commissioner, before a
// manager notices their player missing from "who's playing".
//
// Nothing here changes data. Confirming that two names are one golfer is a
// deliberate action through Merge Players, because the alternative — letting a
// fuzzy score merge players automatically — is how 'Alex Fitzpatrick' ends up
// wearing 'Matt Fitzpatrick's score.
//
// The same audit runs automatically inside the weekly field check
// (?action=field-check), which writes its findings to sfgl_data/nameAudit.
// This panel reads that doc on mount, so a mismatch found on Wednesday is
// waiting here whether or not anyone was watching the cron logs.
// ============================================================================

import React from 'react';
import { colors, fonts } from '../../theme.js';
import { cronFetch } from '../../api/cronApi';
import { sfglDataApi } from '../../api/firebase';
import { M, disabledBtn } from './adminStyles';
import { SUSPECTED_MISMATCH_SCORE } from '../../../api/_playerNames.js';

// Above this, a suggestion is confident enough to highlight — the same
// threshold api/cron.js uses to decide whether to suppress a manager-facing
// "not in the field" push. Imported rather than re-declared.
const STRONG_SUGGESTION = SUSPECTED_MISMATCH_SCORE;

const CHECK_LABELS = {
  field:   { icon: '⛳', what: "this week's field", why: 'Drives the ⛳ flag, the "Playing" filter, tee times, odds and live scores.' },
  players: { icon: '📇', what: 'the player directory', why: 'Drives world ranking and headshots. A missing doc also means the weekly OWGR sync creates a second one.' },
  live:    { icon: '📊', what: 'the live leaderboard', why: 'Drives in-tournament score and position for started lineups.' },
};

export const NameAuditPanel = ({ teams }) => {
  const [status, setStatus] = React.useState('idle'); // idle | running | done | error
  const [error, setError] = React.useState('');
  const [audit, setAudit] = React.useState(null);
  const [lastRunAt, setLastRunAt] = React.useState(null);
  const [source, setSource] = React.useState(null);

  // Load whatever the last automated run found, so the panel is useful on
  // arrival rather than only after the commish clicks something.
  React.useEffect(() => {
    let cancelled = false;
    sfglDataApi.get('nameAudit')
      .then((stored) => {
        if (cancelled || !stored) return;
        setAudit(stored);
        setLastRunAt(stored.checkedAt || null);
        setSource(stored.source || null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const runAudit = async () => {
    setStatus('running');
    setError('');
    try {
      const resp = await cronFetch('name-audit');
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `Audit failed (${resp.status})`);
      setAudit(data);
      setLastRunAt(new Date().toISOString());
      setSource('name-audit');
      setStatus('done');
    } catch (err) {
      setStatus('error');
      setError(err.message || 'Audit failed');
    }
  };

  const rosterCount = React.useMemo(
    () => new Set(teams.flatMap((t) => (t.roster || []).map((p) => p?.name).filter(Boolean))).size,
    [teams],
  );

  // The field check writes a flat suspectedMismatches list; the on-demand audit
  // writes richer per-check sections. Normalise to sections either way.
  const sections = React.useMemo(() => {
    if (!audit) return [];
    if (audit.sections?.length) return audit.sections;
    if (audit.suspectedMismatches?.length) {
      return [{
        check: 'field',
        label: `Starting lineups vs ${audit.tournamentName || "this week"}'s field`,
        referenceCount: audit.fieldCount,
        unmatched: audit.suspectedMismatches,
      }];
    }
    return [];
  }, [audit]);

  const totalFindings = sections.reduce((n, s) => n + (s.unmatched?.length || 0), 0);
  const ambiguous = audit?.ambiguous || [];

  return (
    <div style={M.page}>
      <div style={M.descText}>
        Cross-references every name the league holds against the names our data sources use, and reports
        the ones that don&apos;t line up. Known variations — nicknames, initials, accents, punctuation,
        <em> Nico</em> vs <em>Nicolas</em> — are matched automatically and never appear here. Nothing on
        this page changes data; use <strong>Merge Players</strong> to confirm a pair.
      </div>

      <div style={M.group}>
        <button
          onClick={runAudit}
          disabled={status === 'running'}
          className="modal-feel-lift"
          style={{ ...M.btnPrimary, ...disabledBtn(status === 'running') }}
        >
          {status === 'running' ? '⏳ Auditing…' : '🔍 Run Name Audit'}
        </button>
        <div style={{ ...M.descText, fontSize: 11, color: colors.textMuted }}>
          {lastRunAt
            ? `Last run ${new Date(lastRunAt).toLocaleString()}${source === 'field-check' ? ' (automatic, weekly field check)' : ''} · ${rosterCount} rostered players`
            : `Never run · ${rosterCount} rostered players`}
        </div>
        {error && (
          <div style={{ fontFamily: fonts.sans, fontSize: 11, color: colors.danger }}>{error}</div>
        )}
      </div>

      {audit && totalFindings === 0 && (
        <div style={{
          fontFamily: fonts.sans, fontSize: 13, color: colors.earningsGreen,
          background: 'rgba(80,195,120,0.08)', border: '1px solid rgba(80,195,120,0.25)',
          borderRadius: 6, padding: '12px 14px',
        }}>
          ✓ No name mismatches found. Every rostered player resolves to the sources we checked.
        </div>
      )}

      {sections.map((section) => {
        const meta = CHECK_LABELS[section.check] || {};
        const findings = section.unmatched || [];
        if (section.error) {
          return (
            <div key={section.check} style={M.group}>
              <div style={M.eyebrow}>{meta.icon} {section.label || section.check}</div>
              <div style={{ ...M.descText, color: colors.textMuted }}>
                Source unavailable — {section.error}
              </div>
            </div>
          );
        }
        if (!findings.length) return null;
        return (
          <div key={section.check} style={M.group}>
            <div style={M.eyebrow}>
              {meta.icon} {findings.length} unmatched vs {meta.what || section.check}
            </div>
            {meta.why && (
              <div style={{ ...M.descText, fontSize: 11, color: colors.textMuted }}>{meta.why}</div>
            )}
            {findings.map((finding) => (
              <Finding key={`${section.check}:${finding.name}`} finding={finding} />
            ))}
          </div>
        );
      })}

      {ambiguous.length > 0 && (
        <div style={M.group}>
          <div style={M.eyebrow}>⚠ {ambiguous.length} ambiguous abbreviation{ambiguous.length === 1 ? '' : 's'}</div>
          <div style={{ ...M.descText, fontSize: 11, color: colors.textMuted }}>
            Two players in the field abbreviate the same way, so an abbreviated leaderboard entry
            can&apos;t be assigned to either one. They still match on their full names — this is listed
            only so a missing score has an explanation.
          </div>
          {ambiguous.map(({ key, names }) => (
            <div key={key} style={{
              fontFamily: fonts.mono, fontSize: 12, color: colors.textSecondary,
              padding: '6px 0', borderBottom: `1px solid ${colors.borderSubtle}`,
            }}>
              <span style={{ color: colors.textMuted }}>{key}</span> → {names.join(' / ')}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// One unmatched name plus its ranked candidates.
const Finding = ({ finding }) => {
  const suggestions = finding.suggestions || [];
  const best = suggestions[0];
  const confident = best && best.score >= STRONG_SUGGESTION;

  return (
    <div style={{
      border: `1px solid ${confident ? 'rgba(220,150,50,0.35)' : colors.borderSubtle}`,
      background: confident ? 'rgba(220,150,50,0.06)' : 'rgba(255,255,255,0.02)',
      borderRadius: 6,
      padding: '10px 12px',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: fonts.sans, fontSize: 13, fontWeight: 600, color: colors.textPrimary }}>
          {finding.name}
        </span>
        {finding.inLineup && (
          <span style={{
            fontFamily: fonts.sans, fontSize: 10, fontWeight: 700, letterSpacing: '0.5px',
            color: colors.danger, border: `1px solid ${colors.danger}`, borderRadius: 3, padding: '1px 5px',
          }}>
            IN A LINEUP
          </span>
        )}
      </div>

      {suggestions.length > 0 ? (
        <div style={{ marginTop: 6 }}>
          {suggestions.map((s) => (
            <div key={s.name} style={{
              fontFamily: fonts.sans, fontSize: 12, color: colors.textSecondary,
              display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap', padding: '2px 0',
            }}>
              <span style={{ color: colors.textMuted }}>↳</span>
              <span style={{ color: colors.textPrimary }}>{s.name}</span>
              <span style={{ fontSize: 11, color: colors.textMuted }}>({s.reason})</span>
            </div>
          ))}
          <div style={{ fontFamily: fonts.sans, fontSize: 11, color: colors.textMuted, marginTop: 6 }}>
            If that&apos;s the same golfer, merge them in <strong>Merge Players</strong> — the alias is
            recorded and this stops recurring.
          </div>
        </div>
      ) : (
        <div style={{ fontFamily: fonts.sans, fontSize: 11, color: colors.textMuted, marginTop: 4 }}>
          No close candidate — most likely genuinely absent from this source.
        </div>
      )}
    </div>
  );
};
