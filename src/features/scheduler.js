'use strict';

const cron     = require('node-cron');
const db       = require('../db/database');
const timetable = require('./timetable');
const attendance = require('./attendance');
const { toDateString, dayOfWeekOf, timeToMinutes } = require('../utils/timeUtils');
const { attendancePromptVaried } = require('../utils/formatter');

let _sendMessageFn = null;

/**
 * Called from index.js to inject the Baileys send function.
 * @param {Function} fn - async (jid, message) => void
 */
function setSendFn(fn) {
  _sendMessageFn = fn;
}

/**
 * Sends a WhatsApp message.
 */
async function send(jid, text) {
  if (_sendMessageFn) await _sendMessageFn(jid, text);
}

/**
 * Determines which classes start in the next minute and:
 *  1. Initializes absent rows for all class students.
 *  2. Sends a prompt to each student's WhatsApp.
 *
 * This job runs every minute.
 */
async function checkAndFireClassPrompts() {
  const nowDate = new Date();
  const dateStr = toDateString(nowDate);
  const nowMin  = nowDate.getHours() * 60 + nowDate.getMinutes();

  const users = db.getAllActiveUsers();
  for (const user of users) {
    // Skip users with no timetable (#30 — avoids pointless queries for empty accounts)
    if (db.getScheduleEntryCount(user.id) === 0) continue;

    let sessions;
    try {
      sessions = timetable.getClassableSessionsForDate(user.id, dateStr);
    } catch (err) {
      console.error(`[Scheduler] Failed to get sessions for user ${user.id}:`, err.message);
      continue;
    }

    for (const session of sessions) {
      const startMin = timeToMinutes(session.start_time);
      if (Math.abs(nowMin - startMin) > 1) continue;

      try {
        // Init absent row — if user was deleted between getAllActiveUsers() and here,
        // this will throw a FK error which we catch and skip (#30)
        attendance.initSessionAttendance(user.id, {
          ...session,
          session_date: dateStr,
        });

        // Send prompt — wrap individually so one bad JID doesn't stop others (#31)
        // Personalised varied message — different text per user to avoid
        // WhatsApp content-hash spam detection on bulk sends.
        const msg = attendancePromptVaried(user.name, session.subject, session.start_time, session.end_time);
        await send(user.phone, msg);
      } catch (err) {
        console.error(`[Scheduler] Error for user ${user.id} (${user.phone}):`, err.message);
        // Continue to next session / next user — never crash the whole loop
      }
    }
  }
}

/**
 * Starts the cron job that fires every minute.
 * Only starts if there is at least one section with a linked group.
 */
function startScheduler() {
  // '* * * * *' = every minute
  const job = cron.schedule('* * * * *', () => {
    checkAndFireClassPrompts().catch(err =>
      console.error('[Scheduler] Error:', err.message),
    );
  }, { timezone: process.env.TZ || 'Asia/Kolkata' });

  console.log('[Scheduler] Started. Watching for class windows...');
  return job;
}

module.exports = { startScheduler, setSendFn, checkAndFireClassPrompts };
