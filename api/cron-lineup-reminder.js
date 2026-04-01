// api/cron-lineup-reminder.js — Vercel Cron Job
// Sends lineup reminder emails Thursday morning before lineups lock.
// Schedule: runs at 9am ET on Thursdays (configured in vercel.json)

import { db } from './firebase-admin.js';
import { sendEmail, buildLineupReminderEmail } from './send-email.js';

function getETNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const et = getETNow();
    if (et.getDay() !== 4) {
      return res.json({ status: 'not_thursday', message: 'Lineup reminders only sent on Thursdays' });
    }

    // Check if already sent today
    const metaSnap = await db.collection('sfgl_data').doc('last_lineup_reminder').get();
    const lastRun = metaSnap.exists ? metaSnap.data().value : null;
    const today = et.toLocaleDateString('en-US');
    if (lastRun === today) {
      return res.json({ status: 'already_sent', message: 'Reminder already sent today' });
    }

    // Load settings for lock time and emails
    const settingsSnap = await db.collection('league_settings').get();
    const settings = {};
    settingsSnap.docs.forEach(d => { settings[d.id] = d.data().value ?? d.data(); });

    // Find active tournament
    const sfglSnap = await db.collection('sfgl_data').doc('fantasy-golf-tournaments').get();
    const tournaments = sfglSnap.exists ? sfglSnap.data().value : [];
    const activeTourney = tournaments?.find(t => t.playing && !t.completed);

    if (!activeTourney) {
      return res.json({ status: 'no_tournament', message: 'No active tournament this week' });
    }

    // Determine lock time
    const lockHour = activeTourney.lockHourET || 7;
    const lockTime = lockHour > 12 ? `${lockHour - 12}pm` : lockHour === 12 ? '12pm' : `${lockHour}am`;

    // Load teams and email map
    const teamsSnap = await db.collection('teams').get();
    const teams = teamsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const emailMap = settings.managerEmails || {};

    const results = [];
    for (const team of teams) {
      const email = emailMap[team.id] || emailMap[team.name];
      if (!email) continue;

      // Skip teams that already have a lineup set
      if (team.lineup && team.lineup.length > 0) {
        results.push({ team: team.name, skipped: true, reason: 'lineup already set' });
        continue;
      }

      try {
        const html = buildLineupReminderEmail(activeTourney.name, lockTime, team.name);
        await sendEmail(email, `⛳ Lineups lock today — ${activeTourney.name}`, html);
        results.push({ team: team.name, success: true });
      } catch (err) {
        results.push({ team: team.name, error: err.message });
      }
    }

    // Mark as sent
    await db.collection('sfgl_data').doc('last_lineup_reminder').set({ key: 'last_lineup_reminder', value: today });

    return res.json({ status: 'sent', tournament: activeTourney.name, results });

  } catch (err) {
    console.error('[cron-lineup-reminder] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
