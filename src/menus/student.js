'use strict';

const db = require('../db/database');
const attendance = require('../features/attendance');
const timetable = require('../features/timetable');
const { today, getCurrentWeekDates } = require('../utils/timeUtils');
const formatter = require('../utils/formatter');
const ocr = require('../utils/ocr');
const fs = require('fs');
const path = require('path');

async function downloadMedia(msgInfo) {
  const { downloadContentFromMessage } = await import('@whiskeysockets/baileys');
  const stream = await downloadContentFromMessage(msgInfo.imageMessage, 'image');
  let buffer = Buffer.from([]);
  for await(const chunk of stream) {
      buffer = Buffer.concat([buffer, chunk]);
  }
  return buffer;
}

async function processMessage(user, msgInfo, sendFn) {
  const { jid, text, imageMessage } = msgInfo;
  const lowerText = text.toLowerCase().trim();
  const phone = user.phone;
  let conv = db.getConvState(phone);

  if (imageMessage) {
      // Guard: if another OCR is already being confirmed, reject a second upload (#12)
      if (conv.state === 'student_confirm_ocr') {
         await sendFn(jid, `⏳ You already have a timetable upload pending confirmation.\nReply *confirm* to save it, or *cancel* to discard it first.`);
         return;
      }
      if (!lowerText.includes('timetable')) {
         await sendFn(jid, `ℹ️ To upload your personal timetable, attach the image and add the caption *timetable*.`);
         return;
      }
      
      await sendFn(jid, `⏳ Analyzing your timetable image using AI. This may take a minute...`);
      
      try {
         const ext = imageMessage.mimetype.split('/')[1] || 'jpeg';
         const dir = process.env.UPLOADS_DIR || './uploads';
         if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

         const filepath = path.join(dir, `tt_${Date.now()}_u${user.id}.${ext}`);
         const buffer = await downloadMedia(msgInfo);
         fs.writeFileSync(filepath, buffer);
         
         const result = await ocr.parseTimetableImage(filepath);
         const { entries, reason, message } = result;
         
         // Handle structured failure reasons (#6)
         if (!entries || entries.length === 0) {
            const hint = reason === 'IMAGE_TOO_SMALL'
              ? `❌ The image is too small. Please send a higher-resolution screenshot.`
              : reason === 'NO_DAYS_DETECTED'
              ? `❌ Could not find day labels (Mon/Tue…) in the image. Make sure the full calendar header is visible.`
              : reason === 'NO_TIMES_DETECTED'
              ? `❌ Could not find time labels in the image. Make sure the time axis is visible and not cropped.`
              : reason === 'OCR_TIMEOUT'
              ? `❌ OCR timed out. The image may be too complex. Try a cleaner screenshot.`
              : `⚠️ *Timetable Parsing Failed*\n\n${message ? `Error: ${message}\n\n` : ''}Could not extract schedule from the image.\nPlease ensure the image is clear and high-resolution.\n\nTry again or enter the schedule manually.`;
            await sendFn(jid, hint);
            return;
         }

         db.setConvState(phone, 'student_confirm_ocr', { entries });
         await sendFn(jid, formatter.formatOCRPreview(entries));
      } catch (err) {
         console.error('OCR error:', err);
         await sendFn(jid, `❌ Failed to parse image. Ensure it\'s clear and retry.`);
      }
      return;
  }

  // Intercept OCR confirmation
  if (conv.state === 'student_confirm_ocr') {
      if (lowerText === 'confirm' || lowerText === 'yes') {
          const { entries } = conv.context;
          // Guard: don't save an empty entries list (#13)
          if (!entries || entries.length === 0) {
             db.clearConvState(phone);
             await sendFn(jid, `❌ No timetable data to save. Please upload your image again.`);
             return;
          }
          timetable.saveParsedTimetable(user.id, entries);
          db.clearConvState(phone);
          const weekData = timetable.getWeeklySchedule(user.id);
          const msg = `✅ Your personal timetable has been successfully saved! You'll now receive class reminders based on this schedule.\n\n` +
                      formatter.formatWeeklySchedule(weekData);
          await sendFn(jid, msg);
      } else {
          db.clearConvState(phone);
          await sendFn(jid, `❌ Timetable upload cancelled.`);
      }
      return;
  }

  // ==== Interactive FSM states — MUST be checked before generic shortcuts ====
  // If the user is mid-flow (e.g. history_select_date), their "1" reply means
  // "pick option 1 from the list", NOT "mark attendance". Checking state first
  // prevents the generic shortcuts below from intercepting mid-flow replies.

  if (conv.state === 'history_select_date') {
      const dates = attendance.getRecentDates(user.id, 5);
      const idx = parseInt(lowerText, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= dates.length) {
         await sendFn(jid, formatter.ERRORS.invalidInput);
         return;
      }
      const selectedDate = dates[idx];
      const sessions = db.getAttendanceByDate(user.id, selectedDate);
      db.setConvState(phone, 'history_view_date', { date: selectedDate, sessions });
      await sendFn(jid, formatter.formatHistoryDay(selectedDate, sessions, true));
      return;
  }

  if (conv.state === 'history_view_date') {
      if (!lowerText.startsWith('edit ')) {
          await sendFn(jid, formatter.ERRORS.invalidInput);
          return;
      }
      const idx = parseInt(lowerText.replace('edit ', ''), 10) - 1;
      const sessions = conv.context.sessions;
      if (isNaN(idx) || idx < 0 || idx >= sessions.length) {
         await sendFn(jid, `❌ Invalid class number.`);
         return;
      }
      const record = sessions[idx];
      const newStatus = record.status === 'present' ? 'absent' : 'present';
      db.setConvState(phone, 'history_confirm_edit', {
          recordId: record.id,
          subject: record.subject,
          date: record.session_date,
          start: record.session_start,
          newStatus
      });
      await sendFn(jid, `Are you sure you want to change *${record.subject}* on ${record.session_date} to *${newStatus.toUpperCase()}*?\n\nReply *yes* to confirm, or *no* to cancel.`);
      return;
  }

  if (conv.state === 'history_confirm_edit') {
      if (lowerText === 'yes' || lowerText === 'y') {
          const { date, start, newStatus } = conv.context;
          const result = attendance.editPastAttendance(user, date, start, newStatus);
          if (result.ok) {
             await sendFn(jid, `✅ Attendance updated to ${newStatus}.\nThis change has been logged for audit.`);
          } else {
             await sendFn(jid, `❌ Error: ${result.error}`);
          }
      } else {
          await sendFn(jid, `❌ Action cancelled.`);
      }
      db.clearConvState(phone);
      return;
  }

  // --- Reschedule FSM (also before shortcuts) ---
  if (conv.state === 'student_resched_date') {
      if (lowerText === 'cancel') { db.clearConvState(phone); return sendFn(jid, 'Cancelled.'); }
      const origDate = lowerText;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(origDate)) {
          await sendFn(jid, `❌ Invalid date format. Please reply with YYYY-MM-DD.`);
          return;
      }
      const parsed = new Date(origDate);
      if (isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== origDate) {
          await sendFn(jid, `❌ That date doesn't exist (e.g. month 13 or day 32). Please use a valid date.`);
          return;
      }
      const sessions = timetable.getClassableSessionsForDate(user.id, origDate);
      if (sessions.length === 0) {
          await sendFn(jid, `_No classes found on ${origDate}._\nReply with another date or type 'cancel'.`);
          return;
      }
      let msg = `Classes on ${origDate}:\n\n`;
      sessions.forEach((s, idx) => { msg += `${idx + 1}. ${s.start_time} - ${s.subject}\n`; });
      msg += `\nReply with the *number* of the class you want to shift.`;
      db.setConvState(phone, 'student_resched_select', { origDate, sessions });
      await sendFn(jid, msg);
      return;
  }

  // ==== General commands (only reached when NOT mid-flow) ====
  const t = lowerText;
  if (t === '1' || t === 'mark' || t === 'present' || t === 'absent') {
     // Detect missing timetable before attempting to mark attendance (#25)
     const entryCount = require('../db/database').getScheduleEntryCount(user.id);
     if (entryCount === 0) {
         await sendFn(jid, `📅 You haven't uploaded your timetable yet.\n\nSend an image of your timetable with the caption *timetable* to get started.`);
         return;
     }
     const status = (t === 'absent') ? 'absent' : 'present';
     const result = attendance.markLiveAttendance(user, status);
     if (!result.ok) {
         await sendFn(jid, `❌ ${formatter.ERRORS[result.error] || result.error}`);
         return;
     }
     await sendFn(jid, formatter.attendanceConfirm(result.session.subject, status));
     return;
  }

  if (t === '2' || t === 'today') {
     const dateStr = today();
     const sessions = timetable.resolveScheduleForDate(user.id, dateStr);
     await sendFn(jid, formatter.formatTodaySchedule(dateStr, sessions));
     return;
  }

  if (t === '3' || t === 'week' || t === 'weekly') {
     const weekData = timetable.getWeeklySchedule(user.id);
     await sendFn(jid, formatter.formatWeeklySchedule(weekData));
     return;
  }

  if (t === '4' || t === 'history') {
     const dates = attendance.getRecentDates(user.id, 5);
     if (dates.length === 0) {
        await sendFn(jid, `_No attendance history found. You haven't had any classes yet._`);
        return;
     }
     db.setConvState(phone, 'history_select_date');
     let msg = `Select a recent date to view its history:\n\n`;
     dates.forEach((d, i) => msg += `${i + 1}. ${d}\n`);
     msg += `\nReply with a number:`;
     await sendFn(jid, msg);
     return;
  }

  if (t === '5' || t === 'dashboard' || t === 'stats') {
     const { overall, bySubject } = attendance.getDashboardStats(user.id);
     const section = db.getSectionById(user.section_id);
     await sendFn(jid, formatter.formatDashboard(user.name, section.name, overall, bySubject));
     return;
  }

  if (t === '6' || t === 'reschedule') {
     db.setConvState(phone, 'student_resched_date');
     await sendFn(jid, `📅 Which date contains the class you want to shift? (Format: YYYY-MM-DD)\n\n_Example: 2024-10-15_`);
     return;
  }


  if (conv.state === 'student_resched_select') {
      if (lowerText === 'cancel') { db.clearConvState(phone); return sendFn(jid, 'Cancelled.'); }
      const idx = parseInt(lowerText, 10) - 1;
      const { origDate, sessions } = conv.context;
      if (isNaN(idx) || idx < 0 || idx >= sessions.length) {
          await sendFn(jid, `❌ Invalid number. Try again.`);
          return;
      }
      const selected = sessions[idx];
      db.setConvState(phone, 'student_resched_newdate', { origDate, selected });
      await sendFn(jid, `You selected *${selected.subject}* at ${selected.start_time}.\n\nWhat is the *NEW date*? (Format: YYYY-MM-DD)`);
      return;
  }

  if (conv.state === 'student_resched_newdate') {
      if (lowerText === 'cancel') { db.clearConvState(phone); return sendFn(jid, 'Cancelled.'); }
      const newDate = lowerText;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate)) {
          await sendFn(jid, `❌ Invalid date format. Please reply with YYYY-MM-DD.`);
          return;
      }
      conv.context.newDate = newDate;
      db.setConvState(phone, 'student_resched_newtime', conv.context);
      await sendFn(jid, `Got it. The new date is ${newDate}.\n\nWhat is the *NEW start time*? (Format: HH:MM in 24hr clock, e.g., 14:30)`);
      return;
  }

  if (conv.state === 'student_resched_newtime') {
      if (lowerText === 'cancel') { db.clearConvState(phone); return sendFn(jid, 'Cancelled.'); }
      const newTime = lowerText;
      if (!/^\d{1,2}:\d{2}$/.test(newTime)) {
          await sendFn(jid, `❌ Invalid time format. Please reply with HH:MM.`);
          return;
      }
      const { origDate, selected, newDate } = conv.context;
      
      const add90Mins = (startStr) => {
          let [h, m] = startStr.split(':').map(Number);
          m += 90;
          h += Math.floor(m / 60);
          m = m % 60;
          return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      };
      
      const [h, m] = newTime.split(':');
      const paddedNewTime = `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
      const newEndTime = add90Mins(paddedNewTime);
      const isGlobal = process.env.GLOBAL_RESCHEDULE === 'true';

      if (isGlobal) {
          let shiftCount = 0;
          const allUsers = db.getAllActiveUsers();
          for (const u of allUsers) {
              const theirSessions = timetable.getClassableSessionsForDate(u.id, origDate);
              const match = theirSessions.find(s => s.subject === selected.subject && s.start_time === selected.start_time);
              if (match) {
                 db.addOverride({
                    user_id: u.id,
                    original_entry_id: match.id || match.original_entry_id,
                    override_type: 'rescheduled',
                    original_date: origDate,
                    original_start_time: selected.start_time,
                    new_date: newDate,
                    new_start_time: paddedNewTime,
                    new_end_time: newEndTime,
                    new_room: null,
                    subject: selected.subject,
                    reason: 'Global Reschedule',
                    created_by: user.id
                 });
                 shiftCount++;
              }
          }
          await sendFn(jid, `✅ *Global Reschedule Successful!*\nMoved ${selected.subject} to ${newDate} at ${paddedNewTime} for ${shiftCount} students.`);
      } else {
          db.addOverride({
              user_id: user.id,
              original_entry_id: selected.id || selected.original_entry_id,
              override_type: 'rescheduled',
              original_date: origDate,
              original_start_time: selected.start_time,
              new_date: newDate,
              new_start_time: paddedNewTime,
              new_end_time: newEndTime,
              new_room: null,
              subject: selected.subject,
              reason: 'Personal Reschedule',
              created_by: user.id
          });
          await sendFn(jid, `✅ *Personal Reschedule Successful!*\nMoved your ${selected.subject} class to ${newDate} at ${paddedNewTime}.`);
      }
      db.clearConvState(phone);
      return;
  }

  // Default block
  await sendFn(jid, formatter.ERRORS.invalidInput);
}

module.exports = {
  processMessage,
};
