'use strict';

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const DB_PATH = process.env.DB_PATH || './data/attendance.db';
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

// Ensure data directory exists
fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true });

let db;

/**
 * Initialize the database connection and run schema migrations.
 * Called once on app startup.
 */
function init() {
  db = new Database(path.resolve(DB_PATH));
  // Enable WAL mode and foreign keys
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Run schema (CREATE TABLE IF NOT EXISTS is idempotent)
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schema);
  console.log('[DB] Initialized:', path.resolve(DB_PATH));
  return db;
}

function getDb() {
  if (!db) throw new Error('Database not initialized. Call db.init() first.');
  return db;
}

// ─── Users ───────────────────────────────────────────────────────────────────

const userStmts = {
  findByPhone: null,
  insert: null,
  updateName: null,
  updateRole: null,
  updateSection: null,
  updateLastSeen: null,
  listBySection: null,
  listCRs: null,
};

function prepareUserStmts() {
  const d = getDb();
  userStmts.findByPhone   = d.prepare('SELECT * FROM users WHERE phone = ?');
  userStmts.insert        = d.prepare(`
    INSERT INTO users (phone, name, role, section_id)
    VALUES (@phone, @name, @role, @section_id)
    ON CONFLICT(phone) DO NOTHING
  `);
  userStmts.updateName    = d.prepare('UPDATE users SET name = ? WHERE phone = ?');
  userStmts.updateRole    = d.prepare('UPDATE users SET role = ? WHERE phone = ?');
  userStmts.updateSection = d.prepare('UPDATE users SET section_id = ? WHERE phone = ?');
  userStmts.updateLastSeen= d.prepare("UPDATE users SET last_seen = datetime('now') WHERE phone = ?");
  userStmts.listBySection = d.prepare('SELECT * FROM users WHERE section_id = ? AND is_active = 1');
  userStmts.listCRs       = d.prepare("SELECT * FROM users WHERE role IN ('cr','superadmin') AND section_id = ?");
}

function getUser(phone) { return userStmts.findByPhone.get(phone); }

function upsertUser({ phone, name = 'Unknown', role = 'student', section_id = null }) {
  userStmts.insert.run({ phone, name, role, section_id });
  return userStmts.findByPhone.get(phone);
}

function updateUserName(phone, name)        { userStmts.updateName.run(name, phone); }
function updateUserRole(phone, role)        { userStmts.updateRole.run(role, phone); }
function updateUserSection(phone, sectionId){ userStmts.updateSection.run(sectionId, phone); }
function touchUser(phone)                   { userStmts.updateLastSeen.run(phone); }
function getUsersBySection(sectionId)       { return userStmts.listBySection.all(sectionId); }
function getCRsBySection(sectionId)         { return userStmts.listCRs.all(sectionId); }
function getAllActiveUsers()                { return getDb().prepare('SELECT * FROM users WHERE is_active = 1').all(); }

function deleteUser(phone) {
  const user = getUser(phone);
  if (!user) return;
  const d = getDb();
  const tx = d.transaction(() => {
    // Delete dependent records that don't have CASCADE
    d.prepare('DELETE FROM audit_log WHERE user_id = ?').run(user.id);
    d.prepare('UPDATE schedule_overrides SET created_by = NULL WHERE created_by = ?').run(user.id);
    // Finally delete the user (attendance logs delete cascade automatically)
    d.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  });
  tx();
}

// ─── Sections ────────────────────────────────────────────────────────────────

function getSections() {
  return getDb().prepare('SELECT * FROM sections ORDER BY id').all();
}

function getSectionById(id) {
  return getDb().prepare('SELECT * FROM sections WHERE id = ?').get(id);
}

function getSectionByGroupJid(jid) {
  return getDb().prepare('SELECT * FROM sections WHERE group_jid = ?').get(jid);
}

function createSection(name) {
  const stmt = getDb().prepare('INSERT INTO sections (name) VALUES (?) ON CONFLICT(name) DO NOTHING');
  const result = stmt.run(name);
  return getDb().prepare('SELECT * FROM sections WHERE name = ?').get(name);
}

function linkSectionToGroup(sectionId, groupJid) {
  getDb().prepare('UPDATE sections SET group_jid = ? WHERE id = ?').run(groupJid, sectionId);
}

// ─── Schedule Entries ─────────────────────────────────────────────────────────

function insertScheduleEntry({ user_id, subject, day_of_week, start_time, end_time, room = null }) {
  return getDb().prepare(`
    INSERT INTO schedule_entries (user_id, subject, day_of_week, start_time, end_time, room)
    VALUES (@user_id, @subject, @day_of_week, @start_time, @end_time, @room)
    ON CONFLICT(user_id, day_of_week, start_time) DO UPDATE SET
      subject    = excluded.subject,
      end_time   = excluded.end_time,
      room       = excluded.room
  `).run({ user_id, subject, day_of_week, start_time, end_time, room });
}

function getScheduleForDay(userId, dayOfWeek) {
  return getDb().prepare(`
    SELECT * FROM schedule_entries
    WHERE user_id = ? AND day_of_week = ?
    ORDER BY start_time
  `).all(userId, dayOfWeek);
}

function getScheduleForUser(userId) {
  return getDb().prepare(`
    SELECT * FROM schedule_entries WHERE user_id = ? ORDER BY day_of_week, start_time
  `).all(userId);
}

function clearScheduleForUser(userId) {
  getDb().prepare('DELETE FROM schedule_entries WHERE user_id = ?').run(userId);
}

// ─── Schedule Overrides ────────────────────────────────────────────────────────

function addOverride(override) {
  return getDb().prepare(`
    INSERT INTO schedule_overrides
      (user_id, original_entry_id, override_type,
       original_date, original_start_time,
       new_date, new_start_time, new_end_time, new_room, subject,
       reason, created_by)
    VALUES
      (@user_id, @original_entry_id, @override_type,
       @original_date, @original_start_time,
       @new_date, @new_start_time, @new_end_time, @new_room, @subject,
       @reason, @created_by)
  `).run(override);
}

function getOverridesForDate(userId, date) {
  return getDb().prepare(`
    SELECT * FROM schedule_overrides
    WHERE user_id = ?
      AND (original_date = ? OR new_date = ?)
    ORDER BY new_start_time
  `).all(userId, date, date);
}

function getOverridesForWeek(userId, startDate, endDate) {
  return getDb().prepare(`
    SELECT * FROM schedule_overrides
    WHERE user_id = ?
      AND (
        (original_date BETWEEN ? AND ?)
        OR (new_date BETWEEN ? AND ?)
      )
  `).all(userId, startDate, endDate, startDate, endDate);
}

function markBroadcastSent(overrideId) {
  getDb().prepare('UPDATE schedule_overrides SET broadcast_sent = 1 WHERE id = ?').run(overrideId);
}

// ─── Attendance ───────────────────────────────────────────────────────────────

function markAttendance({ user_id, session_date, session_start, subject, status, override_id = null }) {
  return getDb().prepare(`
    INSERT INTO attendance_logs
      (user_id, session_date, session_start, subject, status, override_id)
    VALUES
      (@user_id, @session_date, @session_start, @subject, @status, @override_id)
    ON CONFLICT(user_id, session_date, session_start) DO UPDATE SET
      status    = excluded.status,
      marked_at = datetime('now')
  `).run({ user_id, session_date, session_start, subject, status, override_id });
}

function getAttendanceByDate(userId, date) {
  return getDb().prepare(`
    SELECT * FROM attendance_logs
    WHERE user_id = ? AND session_date = ?
    ORDER BY session_start
  `).all(userId, date);
}

function getAttendanceRecord(userId, sessionDate, sessionStart) {
  return getDb().prepare(`
    SELECT * FROM attendance_logs
    WHERE user_id = ? AND session_date = ? AND session_start = ?
  `).get(userId, sessionDate, sessionStart);
}

function editAttendance(attendanceId, newStatus) {
  getDb().prepare(`
    UPDATE attendance_logs SET status = ?, marked_at = datetime('now') WHERE id = ?
  `).run(newStatus, attendanceId);
}

function getAttendanceStats(userId) {
  // Exclude sessions that were cancelled (no attendance row is created for cancelled classes)
  return getDb().prepare(`
    SELECT
      subject,
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END) AS attended,
      SUM(CASE WHEN status = 'absent'  THEN 1 ELSE 0 END) AS missed
    FROM attendance_logs
    WHERE user_id = ?
    GROUP BY subject
    ORDER BY subject
  `).all(userId);
}

function getOverallStats(userId) {
  return getDb().prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END) AS attended,
      SUM(CASE WHEN status = 'absent'  THEN 1 ELSE 0 END) AS missed
    FROM attendance_logs
    WHERE user_id = ?
  `).get(userId);
}

function getRecentAttendanceDates(userId, limit = 7) {
  return getDb().prepare(`
    SELECT DISTINCT session_date FROM attendance_logs
    WHERE user_id = ?
    ORDER BY session_date DESC
    LIMIT ?
  `).all(userId, limit).map(r => r.session_date);
}

// ─── Audit Log ────────────────────────────────────────────────────────────────

function addAuditEntry({ user_id, attendance_id, old_status, new_status, note = null }) {
  getDb().prepare(`
    INSERT INTO audit_log (user_id, attendance_id, old_status, new_status, note)
    VALUES (@user_id, @attendance_id, @old_status, @new_status, @note)
  `).run({ user_id, attendance_id, old_status, new_status, note });
}

function getAuditForUser(userId, limit = 20) {
  return getDb().prepare(`
    SELECT a.*, al.session_date, al.subject, al.session_start
    FROM audit_log a
    JOIN attendance_logs al ON al.id = a.attendance_id
    WHERE a.user_id = ?
    ORDER BY a.edited_at DESC
    LIMIT ?
  `).all(userId, limit);
}

function getAuditForSection(sectionId, limit = 50) {
  return getDb().prepare(`
    SELECT a.*, u.name AS student_name, u.phone,
           al.session_date, al.subject, al.session_start
    FROM audit_log a
    JOIN users u ON u.id = a.user_id
    JOIN attendance_logs al ON al.id = a.attendance_id
    WHERE u.section_id = ?
    ORDER BY a.edited_at DESC
    LIMIT ?
  `).all(sectionId, limit);
}

// ─── Conversation State ───────────────────────────────────────────────────────

function getConvState(phone) {
  const row = getDb().prepare('SELECT * FROM conversation_state WHERE phone = ?').get(phone);
  if (!row) return { state: 'idle', context: {} };
  return { state: row.state, context: JSON.parse(row.context) };
}

function setConvState(phone, state, context = {}) {
  getDb().prepare(`
    INSERT INTO conversation_state (phone, state, context, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(phone) DO UPDATE SET
      state = excluded.state,
      context = excluded.context,
      updated_at = excluded.updated_at
  `).run(phone, state, JSON.stringify(context));
}

function clearConvState(phone) {
  setConvState(phone, 'idle', {});
}

/**
 * Returns how many minutes ago the conversation state for `phone` was last updated.
 * Returns Infinity if no state row exists (treat as very old). (#18)
 */
function getConvStateAge(phone) {
  const row = getDb().prepare(
    `SELECT CAST((julianday('now') - julianday(updated_at)) * 1440 AS INTEGER) AS age_minutes
     FROM conversation_state WHERE phone = ?`
  ).get(phone);
  return row ? row.age_minutes : Infinity;
}

/**
 * Returns the number of schedule entries saved for a given user.
 * Used to detect if they have never uploaded a timetable. (#25)
 */
function getScheduleEntryCount(userId) {
  const row = getDb().prepare(
    'SELECT COUNT(*) AS cnt FROM schedule_entries WHERE user_id = ?'
  ).get(userId);
  return row ? row.cnt : 0;
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

/**
 * Called once on startup to seed the 6 sections and the superadmin CR.
 */
function bootstrap() {
  const d = getDb();
  const totalSections = parseInt(process.env.TOTAL_SECTIONS || '6', 10);
  const sectionNames  = ['A', 'B', 'C', 'D', 'E', 'F'].slice(0, totalSections);

  const tx = d.transaction(() => {
    for (const name of sectionNames) {
      createSection(`Section ${name}`);
    }
    // Ensure bootstrap CR exists (section assigned later when they register)
    const crPhone = process.env.BOOTSTRAP_CR_PHONE;
    if (crPhone) {
      const jid = crPhone.includes('@') ? crPhone : `${crPhone}@s.whatsapp.net`;
      upsertUser({ phone: jid, name: 'SuperAdmin CR', role: 'superadmin' });
    }
  });
  tx();
}

// Initialize prepared statements (called after init())
function prepareAll() {
  prepareUserStmts();
}

module.exports = {
  init,
  getDb,
  prepareAll,
  bootstrap,
  // Users
  getUser, upsertUser, updateUserName, updateUserRole,
  updateUserSection, touchUser, getUsersBySection, getCRsBySection, getAllActiveUsers, deleteUser,
  // Sections
  getSections, getSectionById, getSectionByGroupJid,
  createSection, linkSectionToGroup,
  // Schedule
  insertScheduleEntry, getScheduleForDay, getScheduleForUser, clearScheduleForUser,
  // Overrides
  addOverride, getOverridesForDate, getOverridesForWeek, markBroadcastSent,
  // Attendance
  markAttendance, getAttendanceByDate, getAttendanceRecord,
  editAttendance, getAttendanceStats, getOverallStats, getRecentAttendanceDates,
  // Audit
  addAuditEntry, getAuditForUser, getAuditForSection,
  // Conversation state
  getConvState, setConvState, clearConvState, getConvStateAge,
  // Schedule helpers
  getScheduleEntryCount,
};
