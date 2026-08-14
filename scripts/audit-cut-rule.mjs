// Which stored results does the cut rule change, and which are already right?
//
// Usage:  node scripts/audit-cut-rule.mjs
//
// READ-ONLY. Needs Firebase Admin credentials — see scripts/_adminCreds.mjs.
//
// WHY THIS EXISTS
// ---------------
// The cut rule is applied at PROCESS time and baked into results.teams, so
// adding it to the code changes nothing that has already been scored. Every
// affected event has to be reprocessed by hand, and until it is, the season
// runs half under the rule and half not — with nothing on any screen saying
// which half an event is in.
//
// So this lists exactly which tournaments need reprocessing, and confirms the
// rest already agree. Run it after any reprocess to check the season is
// internally consistent again.

import { adminDb } from './_adminCreds.mjs';
import { cutRuleForfeit } from '../api/_rules.js';

const db = adminDb();
const $ = (n) => `$${Math.round(n || 0).toLocaleString()}`;

async function main() {
  const [tSnap, teamSnap, setSnap] = await Promise.all([
    db.collection('tournaments').get(),
    db.collection('teams').get(),
    db.collection('league_settings').get(),
  ]);
  const teamName = Object.fromEntries(teamSnap.docs.map(d => [d.id, d.data().name || d.id]));
  const settings = {};
  setSnap.docs.forEach(d => { settings[d.data().key] = d.data().value; });

  const tournaments = tSnap.docs
    .map(d => ({ _id: d.id, ...d.data() }))
    .filter(t => t.completed && t.results?.teams)
    .sort((a, b) => String(a.start_date || '').localeCompare(String(b.start_date || '')));

  const needsReprocess = new Set();
  let agree = 0;

  console.log(`\ncutRuleEnabled: ${settings.cutRuleEnabled === false ? 'OFF' : 'ON (default)'}\n`);

  for (const t of tournaments) {
    for (const [teamId, tr] of Object.entries(t.results.teams)) {
      const starters = (tr.players || []).map(p => ({ playerName: p.name, earnings: p.earnings || 0 }));
      const verdict = cutRuleForfeit({ starters, earningsMap: t.results.earningsMap, settings });

      const storedTotal = tr.totalEarnings || 0;
      const rawTotal = starters.reduce((s, p) => s + p.earnings, 0)
        + Object.values(tr.bonuses || {}).reduce((s, v) => s + (v || 0), 0);

      // Stored results predate the flag, so infer whether the rule was applied
      // from the number rather than from the marker.
      const looksForfeited = storedTotal === 0 && rawTotal > 0;

      if (verdict && !looksForfeited) {
        needsReprocess.add(t.name);
        console.log(`  FORFEIT   ${t.name} — ${teamName[teamId]}`);
        console.log(`            only ${verdict.player} made the cut of ${verdict.starters} started` +
          `${verdict.startedFull ? '' : ' (short lineup)'}${verdict.won ? ', and he won' : ''}`);
        console.log(`            stored ${$(storedTotal)} → would become $0`);
      } else if (!verdict && looksForfeited) {
        needsReprocess.add(t.name);
        console.log(`  RESTORE   ${t.name} — ${teamName[teamId]}`);
        console.log(`            ${starters.filter(p => p.earnings > 0).length} starters made the cut, ` +
          `so the rule does not apply`);
        console.log(`            stored $0 → would become ${$(rawTotal)}`);
      } else {
        agree++;
      }
    }
  }

  console.log(`\n${agree} team-event(s) already match the rule.`);
  if (needsReprocess.size) {
    console.log(`\n${needsReprocess.size} tournament(s) need reprocessing in Admin → Tournament Results:`);
    [...needsReprocess].forEach(n => console.log(`  • ${n}`));
    console.log('\nUntil then the season is scored half under the rule and half not.');
  } else {
    console.log('\nEvery stored result already agrees with the rule. Nothing to reprocess.');
  }
}

main().catch(err => {
  console.error('audit-cut-rule failed:', err.message);
  process.exit(1);
});
