'use strict';

const cron       = require('node-cron');
const db         = require('../db/database');
const timetable  = require('./timetable');
const attendance = require('./attendance');
const backup     = require('./backup');
const { toDateString, timeToMinutes } = require('../utils/timeUtils');
const { attendancePromptVaried }      = require('../utils/formatter');

let _sendMessageFn = null;

function setSendFn(fn) { _sendMessageFn = fn; }
async function send(jid, text) { if (_sendMessageFn) await _sendMessageFn(jid, text); }

/**
 * Checks which classes start in the next minute and fires attendance prompts.
 * Runs every minute via cron.
 */
async function checkAndFireClassPrompts() {
  const nowDate = new Date();
  const dateStr = toDateString(nowDate);
  const nowMin  = nowDate.getHours() * 60 + nowDate.getMinutes();

  const users = db.getAllActiveUsers();
  for (const user of users) {
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
        attendance.initSessionAttendance(user.id, { ...session, session_date: dateStr });
        const msg = attendancePromptVaried(user.name, session.subject, session.start_time, session.end_time);
        await send(user.phone, msg);
      } catch (err) {
        console.error(`[Scheduler] Error for user ${user.id} (${user.phone}):`, err.message);
      }
    }
  }
}

/**
 * Starts all cron jobs:
 *  - Every minute : fire class attendance prompts
 *  - Daily 02:00  : compressed SQLite backup → GitHub
 */
function startScheduler() {
  cron.schedule('* * * * *', () => {
    checkAndFireClassPrompts().catch(err =>
      console.error('[Scheduler] Error:', err.message));
  }, { timezone: process.env.TZ || 'Asia/Kolkata' });

  // Daily backup at 2 AM IST — quiet window, minimal load
  cron.schedule('0 2 * * *', () => {
    backup.runBackup().catch(err =>
      console.error('[Backup] Cron error:', err.message));
  }, { timezone: process.env.TZ || 'Asia/Kolkata' });

  console.log('[Scheduler] Started. Watching for class windows...');
  console.log('[Backup]    Daily backup scheduled at 02:00 IST.');
}

module.exports = { startScheduler, setSendFn, checkAndFireClassPrompts };
