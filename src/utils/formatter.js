'use strict';

const { formatTimeDisplay, relativeDate } = require('./timeUtils');

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BAR_FILLED  = '█';
const BAR_EMPTY   = '░';
const BAR_LENGTH  = 10;

function progressBar(pct) {
  const filled = Math.round((pct / 100) * BAR_LENGTH);
  const empty  = BAR_LENGTH - filled;
  return BAR_FILLED.repeat(filled) + BAR_EMPTY.repeat(empty);
}

function pctEmoji(pct) {
  if (pct >= 75) return '🟢';
  if (pct >= 60) return '🟡';
  return '🔴';
}

function statusEmoji(status) {
  return status === 'present' ? '✅' : '❌';
}

// ─── Welcome / Registration ───────────────────────────────────────────────────

function welcomeMessage(className) {
  return (
    `👋 *Welcome to ${className} Attendance Bot!*\n\n` +
    `I help you track your classes and attendance.\n\n` +
    `To get started, please tell me your *full name*:`
  );
}

function registrationComplete(name) {
  return (
    `✅ *Registered successfully!*\n\n` +
    `Name: *${name}*\n\n` +
    `You can now upload your personal timetable by sending an image with the caption *timetable*.\n\n` +
    `Type *menu* anytime to see your options.`
  );
}

// ─── Main Menus ───────────────────────────────────────────────────────────────

function studentMenu() {
  return (
    `╔══════════════════╗\n` +
    `║  📋 Student Menu  ║\n` +
    `╚══════════════════╝\n\n` +
    `1️⃣  ✅ Mark attendance\n` +
    `2️⃣  📅 Today's schedule\n` +
    `3️⃣  📆 Weekly schedule\n` +
    `4️⃣  📊 Attendance history\n` +
    `5️⃣  🎓 My dashboard\n` +
    `6️⃣  🔄 Reschedule a class\n\n` +
    `_Reply with a number, or long-press any option and tap Reply._`
  );
}

function crMenu() {
  return (
    `╔════════════════╗\n` +
    `║  🛠️ CR Menu     ║\n` +
    `╚════════════════╝\n\n` +
    `*── Student Actions ──*\n` +
    `1️⃣  ✅ Mark attendance\n` +
    `2️⃣  📅 Today's schedule\n` +
    `3️⃣  📆 Weekly schedule\n` +
    `4️⃣  📊 Attendance history\n` +
    `5️⃣  🎓 My dashboard\n\n` +
    `*── CR Actions ──*\n` +
    `6️⃣  🔄 Reschedule a class\n` +
    `7️⃣  ❌ Cancel a class\n` +
    `8️⃣  ➕ Add extra class\n` +
    `9️⃣  📤 Upload new timetable\n` +
    `🔟  🔍 View audit log\n\n` +
    `_Reply with a number, or long-press any option and tap Reply._`
  );
}

// ─── Today's Schedule ─────────────────────────────────────────────────────────

/**
 * @param {string} dateLabel - e.g. "Mon, 28 Mar 2026"
 * @param {Array}  sessions  - resolved session objects with override info
 */
function formatTodaySchedule(dateLabel, sessions) {
  if (!sessions || sessions.length === 0) {
    return `📅 *${dateLabel}*\n\n_No classes scheduled today_ 🎉`;
  }

  const lines = sessions.map((s, idx) => {
    const num   = `${idx + 1}.`;
    const subj  = s.subject;
    const start = formatTimeDisplay(s.start_time);
    const end   = formatTimeDisplay(s.end_time);
    const room  = s.room ? ` | ${s.room}` : '';

    if (s.override_type === 'cancelled') {
      return `${num} ❌ ~${subj}~ ~${start} – ${end}~ _(Cancelled)_`;
    }
    if (s.override_type === 'rescheduled' && s.is_new_slot) {
      return `${num} 🔄 *${subj}*  *${start} – ${end}*${room} _(Rescheduled from ${formatTimeDisplay(s.original_start_time)})_`;
    }
    if (s.override_type === 'rescheduled' && !s.is_new_slot) {
      return `${num} ~${subj}~  ~${start} – ${end}~ _(Moved — see new time)_`;
    }
    if (s.override_type === 'extra') {
      return `${num} ➕ *${subj}*  *${start} – ${end}*${room} _(Extra class)_`;
    }
    return `${num} 📚 *${subj}*  ${start} – ${end}${room}`;
  });

  return `📅 *Today's Schedule — ${dateLabel}*\n\n` + lines.join('\n');
}

// ─── Weekly Schedule ──────────────────────────────────────────────────────────

/**
 * @param {Array} weekDays - [{label, sessions: [...]}]
 */
function formatWeeklySchedule(weekDays) {
  if (!weekDays || weekDays.length === 0) return '_No schedule data available._';

  let msg = `📆 *Weekly Schedule*\n${'─'.repeat(28)}\n`;

  for (const day of weekDays) {
    msg += `\n*${day.label}*\n`;
    if (!day.sessions || day.sessions.length === 0) {
      msg += `  _No classes_\n`;
      continue;
    }
    for (const s of day.sessions) {
      const start = formatTimeDisplay(s.start_time);
      const end   = formatTimeDisplay(s.end_time);
      if      (s.override_type === 'cancelled')   msg += `  ❌ ~${s.subject}~ ~${start}–${end}~\n`;
      else if (s.override_type === 'rescheduled' && s.is_new_slot)
                                                   msg += `  🔄 *${s.subject}* *${start}–${end}*\n`;
      else if (s.override_type === 'extra')        msg += `  ➕ *${s.subject}* *${start}–${end}*\n`;
      else                                         msg += `  📚 ${s.subject}  ${start}–${end}\n`;
    }
  }

  msg += `\n${'─'.repeat(28)}\n`;
  msg += `❌ Cancelled  🔄 Rescheduled  ➕ Extra class`;
  return msg;
}

// ─── Attendance History ────────────────────────────────────────────────────────

/**
 * Shows classes for a specific date with attendance status.
 * @param {string}   dateStr   - YYYY-MM-DD
 * @param {Array}    sessions  - [{subject, start_time, end_time, status}]
 * @param {boolean}  editable  - Whether past-edit buttons should be shown
 */
function formatHistoryDay(dateStr, sessions) {
  const label = relativeDate(dateStr);
  if (!sessions || sessions.length === 0) {
    return `📋 *${label} (${dateStr})*\n\n_No classes recorded for this day._`;
  }

  const lines = sessions.map((s, idx) => {
    const time   = `${formatTimeDisplay(s.start_time)} – ${formatTimeDisplay(s.end_time)}`;
    const status = statusEmoji(s.status);
    return `${idx + 1}. ${status} *${s.subject}*  ${time}`;
  });

  return (
    `📋 *${label} (${dateStr})*\n\n` +
    lines.join('\n') +
    `\n\nTo edit an entry, reply with its number (e.g. *edit 2*).`
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

/**
 * @param {string} name
 * @param {string} sectionName
 * @param {object} overall    - { total, attended, missed }
 * @param {Array}  bySubject  - [{ subject, total, attended, missed }]
 */
function formatDashboard(name, sectionName, overall, bySubject) {
  const overallPct = overall.total > 0
    ? Math.round((overall.attended / overall.total) * 100) : 0;

  let msg =
    `🎓 *Attendance Dashboard*\n` +
    `👤 ${name} | 📌 ${sectionName}\n` +
    `${'─'.repeat(28)}\n\n` +
    `*Overall*\n` +
    `${pctEmoji(overallPct)} ${progressBar(overallPct)} *${overallPct}%*\n` +
    `✅ ${overall.attended} present  ❌ ${overall.missed} absent  📊 ${overall.total} total\n\n` +
    `${'─'.repeat(28)}\n` +
    `*By Subject*\n`;

  if (!bySubject || bySubject.length === 0) {
    msg += `_No attendance data yet._\n`;
  } else {
    for (const s of bySubject) {
      const pct = s.total > 0 ? Math.round((s.attended / s.total) * 100) : 0;
      msg += `\n${pctEmoji(pct)} *${s.subject}*\n`;
      msg += `  ${progressBar(pct)} ${pct}% (${s.attended}/${s.total})\n`;
    }
  }

  msg += `\n${'─'.repeat(28)}\n`;
  msg += `🔴 <60%  🟡 60–74%  🟢 ≥75%`;
  return msg;
}

// ─── Attendance Prompt (Live Class) ──────────────────────────────────────────

function attendancePrompt(subject, startTime, endTime) {
  return (
    `📢 *Class Started!*\n\n` +
    `📚 *${subject}*\n` +
    `🕐 ${formatTimeDisplay(startTime)} – ${formatTimeDisplay(endTime)}\n\n` +
    `Mark your attendance:\n` +
    `✅  Reply *present*\n` +
    `❌  Reply *absent*`
  );
}

// ─── Personalised varied prompts (anti-ban) ───────────────────────────────────
// Produces different message text per user so bulk sends don't share identical
// content hashes. Template is chosen deterministically from hash(name+subject)
// so the same user always gets the same template for the same class.

const _PROMPT_TEMPLATES = [
  (fn, subj, t) =>
    `⏰ Hey ${fn}! *${subj}* starts at ${t}.\n\nAre you attending?\n✅ Reply *present*\n❌ Reply *absent*`,
  (fn, subj, t) =>
    `📚 ${fn}, your class is now starting!\n\n*${subj}*\n🕐 ${t}\n\nMark attendance:\n*1* → Present  |  *2* → Absent`,
  (fn, subj, t) =>
    `🔔 Class alert, ${fn}!\n\n*${subj}* (${t}) has begun.\n\nReply *present* or *absent* to record your attendance.`,
  (fn, subj, t) =>
    `👋 ${fn} — it's class time!\n\n📖 *${subj}*  •  ${t}\n\nLet me know if you're there:\n*present* or *absent*`,
  (fn, subj, t) =>
    `📣 Heads up, ${fn}!\n\n*${subj}* just started at ${t}.\n\nTap your response:\n✅ *present*   ❌ *absent*`,
  (fn, subj, t) =>
    `🎓 ${fn}, your *${subj}* class has started (${t}).\n\nPlease mark your attendance:\nReply *present* if you're in, *absent* if not.`,
];

/**
 * Returns a personalised attendance prompt.
 * Template is chosen by hash so the same user+subject pair is always consistent,
 * but different users get different message bodies during the same broadcast.
 *
 * @param {string} name      - Student's full name
 * @param {string} subject   - Subject name
 * @param {string} startTime - HH:MM
 * @param {string} endTime   - HH:MM (unused but kept for API compatibility)
 */
function attendancePromptVaried(name, subject, startTime, _endTime) {
  const firstName = name.split(' ')[0];
  const key = name + subject + startTime;
  let hash = 0;
  for (const c of key) hash = (hash * 31 + c.charCodeAt(0)) & 0x7fffffff;
  const template = _PROMPT_TEMPLATES[hash % _PROMPT_TEMPLATES.length];
  return template(firstName, subject, formatTimeDisplay(startTime));
}

function attendanceConfirm(subject, status) {
  const emoji = status === 'present' ? '✅' : '❌';
  return `${emoji} Attendance marked *${status}* for *${subject}*.`;
}

// ─── CR Rescheduler ───────────────────────────────────────────────────────────

function rescheduleConfirmMsg(subject, originalDate, originalStart, newDate, newStart, newEnd) {
  return (
    `🔄 *Reschedule Confirmation*\n\n` +
    `📚 Subject: *${subject}*\n` +
    `──────────────────\n` +
    `❌ Old: ${originalDate}  ${formatTimeDisplay(originalStart)}\n` +
    `✅ New: *${newDate}  ${formatTimeDisplay(newStart)} – ${formatTimeDisplay(newEnd)}*\n\n` +
    `Confirm? Reply *yes* or *no*`
  );
}

function broadcastReschedule(subject, originalDate, originalStart, newDate, newStart, newEnd, reason) {
  const reasonLine = reason ? `\n📝 Reason: ${reason}` : '';
  return (
    `📢 *Class Update!*\n\n` +
    `🔄 *${subject}* has been rescheduled:\n\n` +
    `~~🗓️ ${originalDate} at ${formatTimeDisplay(originalStart)}~~\n` +
    `✅ *${newDate} at ${formatTimeDisplay(newStart)} – ${formatTimeDisplay(newEnd)}*` +
    reasonLine
  );
}

function broadcastCancellation(subject, date, startTime, reason) {
  const reasonLine = reason ? `\n📝 Reason: ${reason}` : '';
  return (
    `📢 *Class Cancelled!*\n\n` +
    `❌ *${subject}*\n` +
    `🗓️ ${date} at ${formatTimeDisplay(startTime)}` +
    reasonLine
  );
}

function broadcastExtraClass(subject, date, startTime, endTime, room, reason) {
  const roomLine   = room   ? `\n🏫 Room: ${room}` : '';
  const reasonLine = reason ? `\n📝 Note: ${reason}` : '';
  return (
    `📢 *Extra Class Added!*\n\n` +
    `➕ *${subject}*\n` +
    `🗓️ *${date} at ${formatTimeDisplay(startTime)} – ${formatTimeDisplay(endTime)}*` +
    roomLine + reasonLine
  );
}

// ─── OCR Timetable Confirmation ───────────────────────────────────────────────

function formatOCRPreview(entries) {
  if (!entries || entries.length === 0) {
    return (
      `⚠️ *Timetable Parsing Failed*\n\n` +
      `Could not extract schedule from the image.\n` +
      `Please ensure the image is clear and high-resolution.\n\n` +
      `Try again or enter the schedule manually.`
    );
  }
  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const lines = entries.map(e =>
    `  ${dayNames[e.day_of_week]}  ${formatTimeDisplay(e.start_time)}–${formatTimeDisplay(e.end_time)}  *${e.subject}*`,
  );
  return (
    `🔍 *Parsed Timetable (${entries.length} slots)*\n\n` +
    lines.join('\n') +
    `\n\nIs this correct?\n` +
    `✅ Reply *confirm* to save\n` +
    `✏️ Reply *edit* to make changes\n` +
    `🔄 Reply *retry* to upload a clearer image`
  );
}

// ─── Audit Log ────────────────────────────────────────────────────────────────

function formatAuditLog(entries) {
  if (!entries || entries.length === 0) return '_No audit entries found._';
  const lines = entries.map((e, i) =>
    `${i + 1}. ${e.student_name || 'Student'} changed *${e.subject}* (${e.session_date})\n` +
    `   ${statusEmoji(e.old_status)} → ${statusEmoji(e.new_status)}  _${e.edited_at}_`,
  );
  return `🔍 *Audit Log*\n\n` + lines.join('\n\n');
}

// ─── Generic ─────────────────────────────────────────────────────────────────

const ERRORS = {
  // camelCase keys (used internally)
  notRegistered:     `⚠️ You're not registered yet. Please send *hi* to get started.`,
  noActiveClass:     `ℹ️ No active class right now.\n\nUse *today* to see today's schedule.`,
  alreadyMarked:     `ℹ️ You've already marked attendance for this class.`,
  windowClosed:      `⏰ Attendance window has closed for this class.`,
  notCR:             `🚫 This command is only available to Class Representatives.`,
  invalidInput:      `❓ I didn't understand that. Try again or type *menu*.`,
  noSchedule:        `📅 No timetable found. A CR needs to upload the schedule first.`,
  dbError:           `❌ Something went wrong. Please try again later.`,
  // snake_case aliases (returned by attendance.js error codes)
  not_registered:    `⚠️ You're not registered yet. Please send *hi* to get started.`,
  no_active_class:   `ℹ️ No active class right now.\n\nUse *today* to see today's schedule.`,
  already_marked:    `ℹ️ You've already marked attendance for this class.`,
  window_closed:     `⏰ Attendance window has closed for this class.`,
  db_error:          `❌ Something went wrong. Please try again later.`,
};

module.exports = {
  welcomeMessage, registrationComplete,
  studentMenu, crMenu,
  formatTodaySchedule, formatWeeklySchedule,
  formatHistoryDay, formatDashboard,
  attendancePrompt, attendancePromptVaried, attendanceConfirm,
  rescheduleConfirmMsg, broadcastReschedule, broadcastCancellation, broadcastExtraClass,
  formatOCRPreview, formatAuditLog,
  progressBar, pctEmoji, statusEmoji,
  ERRORS,
};
