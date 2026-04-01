// api/notify-results.js — sends tournament results emails to all managers
// Called from AdminView after processing tournament results.
// POST body: { tournamentName, teamResults: [{ team, totalEarnings }] }

import { db } from './firebase-admin.js';
import { sendEmail, buildTournamentResultsEmail } from './send-email.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { tournamentName, teamResults } = req.body;
    if (!tournamentName || !teamResults?.length) {
      return res.status(400).json({ error: 'Missing tournamentName or teamResults' });
    }

    // Load settings for email map
    const settingsSnap = await db.collection('league_settings').get();
    const settings = {};
    settingsSnap.docs.forEach(d => { settings[d.id] = d.data().value ?? d.data(); });

    const teamsSnap = await db.collection('teams').get();
    const teams = teamsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const emailMap = settings.managerEmails || {};

    const results = [];
    for (const team of teams) {
      const email = emailMap[team.id] || emailMap[team.name];
      if (!email) continue;

      try {
        const html = buildTournamentResultsEmail(tournamentName, teamResults, team.name);
        await sendEmail(email, `🏆 ${tournamentName} — SFGL Results`, html);
        results.push({ team: team.name, success: true });
      } catch (err) {
        results.push({ team: team.name, error: err.message });
      }
    }

    return res.json({ status: 'sent', emailsSent: results.filter(r => r.success).length, results });

  } catch (err) {
    console.error('[notify-results] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
