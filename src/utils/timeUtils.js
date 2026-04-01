'use strict';

require('dotenv').config();

const TZ = process.env.TZ || 'Asia/Kolkata';

/** Returns current Date object in configured timezone */
function now() { return new Date(); }

/** Returns today's date string YYYY-MM-DD */
function today() { return toDateString(new Date()); }

/**
 * Converts a Date → "YYYY-MM-DD" string in local TZ.
 */
function toDateString(date) {
  return date.toLocaleDateString('en-CA', { timeZone: TZ }); // en-CA = YYYY-MM-DD
}

/**
 * Converts a Date → "HH:MM" 24h string in local TZ.
 */
function toTimeString(date) {
  return date.toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
}

/**
 * Converts a Date → friendly display string, e.g. "Mon, 28 Mar 2026".
 */
function toDisplayDate(date) {
  return date.toLocaleDateString('en-IN', {
    timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  });
}

/**
 * Converts a Date → friendly display time, e.g. "09:00 AM".
 */
function toDisplayTime(date) {
  return date.toLocaleTimeString('en-IN', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

/**
 * Returns the ISO day of week (0=Sun, 1=Mon…6=Sat) for a given date.
 */
function getDayOfWeek(date) {
  return parseInt(
    date.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short' })
        .replace(/[^0-6]/, '') || date.getDay(),
    10,
  );
}
// Simpler version using Intl
function dayOfWeekOf(date) {
  const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const name = date.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long' }).toLowerCase();
  return dayNames.indexOf(name);
}

/**
 * Parse "HH:MM" (24h) string into minutes-since-midnight.
 */
function timeToMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Returns true if `now` (Date) is within `windowMinutes` of the
 * class defined by `classDate` (YYYY-MM-DD) at `startTime` (HH:MM).
 */
function isWithinClassWindow(classDate, startTime, nowDate, windowMinutes) {
  const window = parseInt(windowMinutes, 10) || 15;
  const classDateTime = parseClassDateTime(classDate, startTime);
  const diffMs = nowDate.getTime() - classDateTime.getTime();
  const diffMin = diffMs / 60000; // negative = before class
  return diffMin >= -window && diffMin <= window;
}

/**
 * Creates a Date object from "YYYY-MM-DD" + "HH:MM" (interpreted as local TZ).
 */
function parseClassDateTime(dateStr, timeStr) {
  // Build ISO string in local time, then parse
  const [h, m] = timeStr.split(':').map(Number);
  const [y, mo, d] = dateStr.split('-').map(Number);
  // Use Date.UTC-style but offset for TZ
  const d2 = new Date(`${dateStr}T${timeStr}:00`);
  // If env TZ is set correctly, this aligns. For IST we can be more explicit:
  return d2;
}

/**
 * Returns an array of { date: "YYYY-MM-DD", dayOfWeek: number }
 * for the current ISO week (Mon–Sun).
 */
function getCurrentWeekDates() {
  const todayDate = new Date();
  const dow = dayOfWeekOf(todayDate); // 0=Sun
  // Adjust to Monday as start
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const results = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(todayDate);
    d.setDate(d.getDate() + mondayOffset + i);
    results.push({
      date:       toDateString(d),
      dayOfWeek:  dayOfWeekOf(d),
      label:      d.toLocaleDateString('en-IN', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' }),
    });
  }
  return results;
}

/**
 * Returns YYYY-MM-DD for N days ago.
 */
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return toDateString(d);
}

/**
 * Generates an array of the last N distinct date strings.
 */
function lastNDates(n) {
  return Array.from({ length: n }, (_, i) => daysAgo(i));
}

/**
 * Friendly relative label for a date string.
 */
function relativeDate(dateStr) {
  const t = today();
  if (dateStr === t)             return 'Today';
  if (dateStr === daysAgo(1))    return 'Yesterday';
  if (dateStr === daysAgo(2))    return '2 days ago';
  return dateStr;
}

/**
 * Convert "HH:MM" to 12h display: "09:00 AM"
 */
function formatTimeDisplay(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour   = h % 12 || 12;
  return `${String(hour).padStart(2,'0')}:${String(m).padStart(2,'0')} ${period}`;
}

module.exports = {
  now, today, toDateString, toTimeString, toDisplayDate, toDisplayTime,
  dayOfWeekOf, timeToMinutes, isWithinClassWindow, parseClassDateTime,
  getCurrentWeekDates, daysAgo, lastNDates, relativeDate, formatTimeDisplay,
};
