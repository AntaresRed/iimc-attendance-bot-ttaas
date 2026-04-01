'use strict';

const db = require('../db/database');
const { today, toDateString, dayOfWeekOf, timeToMinutes, getCurrentWeekDates, formatTimeDisplay } = require('../utils/timeUtils');

/**
 * Returns the effective (override-resolved) list of sessions for a given
 * section + date. Each session has all original fields plus override metadata.
 *
 * Override resolution rules:
 *  1. If a class on this date is CANCELLED → show as cancelled.
 *  2. If a class on this date is RESCHEDULED AWAY → show old slot as "moved away".
 *  3. If a new slot arrives (rescheduled / extra) on this date → add it.
 */
function resolveScheduleForDate(userId, dateStr) {
  const dateObj   = new Date(dateStr);
  const dow       = dayOfWeekOf(dateObj);
  const overrides = db.getOverridesForDate(userId, dateStr);
  const base      = db.getScheduleForDay(userId, dow);

  // Build override lookup keyed by original_entry_id + original_date
  const cancelledIds    = new Set();
  const rescheduledIds  = new Set();
  const newSlots        = []; // rescheduled targets + extra classes landing on this date

  for (const ov of overrides) {
    if (ov.override_type === 'cancelled' && ov.original_date === dateStr) {
      cancelledIds.add(ov.original_entry_id);
    }
    if (ov.override_type === 'rescheduled') {
      if (ov.original_date === dateStr) rescheduledIds.add(ov.original_entry_id);
      if (ov.new_date === dateStr) {
        newSlots.push({
          subject:          ov.subject || '(unknown)',
          start_time:       ov.new_start_time,
          end_time:         ov.new_end_time,
          room:             ov.new_room,
          override_type:    'rescheduled',
          is_new_slot:      true,
          override_id:      ov.id,
          original_entry_id: ov.original_entry_id,
          original_start_time: ov.original_start_time,
          original_date:    ov.original_date,
        });
      }
    }
    if (ov.override_type === 'extra' && ov.new_date === dateStr) {
      newSlots.push({
        subject:       ov.subject,
        start_time:    ov.new_start_time,
        end_time:      ov.new_end_time,
        room:          ov.new_room,
        override_type: 'extra',
        is_new_slot:   true,
        override_id:   ov.id,
      });
    }
  }

  // Build resolved list from base entries
  const sessions = base.map(entry => {
    if (cancelledIds.has(entry.id)) {
      return { ...entry, override_type: 'cancelled', is_new_slot: false };
    }
    if (rescheduledIds.has(entry.id)) {
      return { ...entry, override_type: 'rescheduled', is_new_slot: false };
    }
    return { ...entry, override_type: null, is_new_slot: false };
  });

  // Add new slots (sorted by start_time)
  sessions.push(...newSlots);
  sessions.sort((a, b) => a.start_time.localeCompare(b.start_time));

  return sessions;
}

/**
 * Returns the currently-active session for a section at `nowDate`.
 * "Active" means: within the configured attendance window.
 */
function getActiveSession(userId, nowDate, windowMinutes = 15) {
  const dateStr     = toDateString(nowDate);
  const sessions    = resolveScheduleForDate(userId, dateStr);
  const currentMin  = nowDate.getHours() * 60 + nowDate.getMinutes();
  const window      = parseInt(windowMinutes, 10);

  for (const s of sessions) {
    if (s.override_type === 'cancelled') continue;            // skip cancelled
    if (s.override_type === 'rescheduled' && !s.is_new_slot) continue; // skip moved-away
    const start = timeToMinutes(s.start_time);
    const end   = timeToMinutes(s.end_time);
    if (currentMin >= start - window && currentMin <= end + window) {
      return { ...s, session_date: dateStr };
    }
  }
  return null;
}

/**
 * Returns the full week schedule for a section.
 * Used by the "weekly view" command.
 */
function getWeeklySchedule(userId) {
  const weekDates = getCurrentWeekDates();
  return weekDates.map(day => ({
    label:    day.label,
    date:     day.date,
    sessions: resolveScheduleForDate(userId, day.date),
  }));
}

/**
 * Saves OCR-parsed timetable entries into the DB for a section.
 * Clears existing schedule first (full replace).
 */
function saveParsedTimetable(userId, entries) {
  db.clearScheduleForUser(userId);
  for (const e of entries) {
    db.insertScheduleEntry({
      user_id:     userId,
      subject:     e.subject,
      day_of_week: e.day_of_week,
      start_time:  e.start_time,
      end_time:    e.end_time,
      room:        e.room || null,
    });
  }
}

/**
 * Returns all non-cancelled sessions for a section on a given date.
 * Used to auto-create attendance rows when a class starts.
 */
function getClassableSessionsForDate(userId, dateStr) {
  return resolveScheduleForDate(userId, dateStr).filter(s =>
    s.override_type !== 'cancelled' &&
    !(s.override_type === 'rescheduled' && !s.is_new_slot),
  );
}

/**
 * Formats the schedule entry list for displaying to a CR for selection.
 * e.g. "1. Mon 9:00 AM – Physics"
 */
function formatEntryList(entries) {
  const sortedEntries = [...entries].sort((a, b) => {
    if (a.day_of_week !== b.day_of_week) return a.day_of_week - b.day_of_week;
    return a.start_time.localeCompare(b.start_time);
  });
  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  return sortedEntries.map((e, i) =>
    `${i + 1}. ${dayNames[e.day_of_week]}  ${formatTimeDisplay(e.start_time)}–${formatTimeDisplay(e.end_time)}  ${e.subject}`,
  ).join('\n');
}

module.exports = {
  resolveScheduleForDate,
  getActiveSession,
  getWeeklySchedule,
  saveParsedTimetable,
  getClassableSessionsForDate,
  formatEntryList,
};
