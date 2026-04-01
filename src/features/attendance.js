'use strict';

const db = require('../db/database');
const { getActiveSession } = require('./timetable');
const { now, toDateString } = require('../utils/timeUtils');

const WINDOW_MINUTES = parseInt(process.env.ATTENDANCE_WINDOW_MINUTES || '15', 10);

/**
 * Marks (or updates) attendance for a student for the currently-active class.
 * Returns { ok, session, error }.
 */
function markLiveAttendance(user, status) {
  const nowDate = now();
  const session = getActiveSession(user.id, nowDate, WINDOW_MINUTES);
  if (!session) return { ok: false, error: 'no_active_class' };

  // Check if already marked for this exact session (#26)
  const existing = db.getAttendanceRecord(user.id, session.session_date, session.start_time);
  if (existing) return { ok: false, error: 'already_marked', session };

  try {
    db.markAttendance({
      user_id:       user.id,
      session_date:  session.session_date,
      session_start: session.start_time,
      subject:       session.subject,
      status,
      override_id:   session.override_id || null,
    });
    return { ok: true, session };
  } catch (e) {
    return { ok: false, error: 'db_error', detail: e.message };
  }
}

/**
 * Marks attendance for a specific session (used by scheduler).
 * `status` defaults to 'absent' (students who don't respond are counted absent).
 */
function markSessionAttendance(userId, sessionDate, sessionStart, subject, status, overrideId = null) {
  return db.markAttendance({
    user_id:       userId,
    session_date:  sessionDate,
    session_start: sessionStart,
    subject,
    status,
    override_id:   overrideId,
  });
}

/**
 * Edits a past attendance record with full audit trail.
 * Returns { ok, error }.
 */
function editPastAttendance(user, sessionDate, sessionStart, newStatus, note = null) {
  const record = db.getAttendanceRecord(user.id, sessionDate, sessionStart);
  if (!record) return { ok: false, error: 'not_found' };
  if (record.status === newStatus) return { ok: false, error: 'same_status' };

  // Audit trail first, then update
  db.addAuditEntry({
    user_id:       user.id,
    attendance_id: record.id,
    old_status:    record.status,
    new_status:    newStatus,
    note,
  });
  db.editAttendance(record.id, newStatus);
  return { ok: true, old: record.status, new: newStatus };
}

/**
 * Returns attendance for a given date, enriched with subject + times.
 */
function getAttendanceForDate(userId, dateStr) {
  return db.getAttendanceByDate(userId, dateStr);
}

/**
 * Returns overall + by-subject stats for a student's dashboard.
 */
function getDashboardStats(userId) {
  const overall    = db.getOverallStats(userId);
  const bySubject  = db.getAttendanceStats(userId);
  return { overall, bySubject };
}

/**
 * Returns the last N dates (strings) on which this user has any attendance record.
 */
function getRecentDates(userId, limit = 7) {
  return db.getRecentAttendanceDates(userId, limit);
}

/**
 * Ensures a student has an attendance row for a session
 * (defaulting to 'absent'). Called by the scheduler at class start.
 */
function initSessionAttendance(userId, session) {
  db.markAttendance({
    user_id:       userId,
    session_date:  session.session_date,
    session_start: session.start_time,
    subject:       session.subject,
    status:        'absent',
    override_id:   session.override_id || null,
  });
}

/**
 * Returns the existing attendance record for a user + session, or null.
 */
function getRecord(userId, sessionDate, sessionStart) {
  return db.getAttendanceRecord(userId, sessionDate, sessionStart);
}

module.exports = {
  markLiveAttendance,
  markSessionAttendance,
  editPastAttendance,
  getAttendanceForDate,
  getDashboardStats,
  getRecentDates,
  initSessionAttendance,
  getRecord,
};
