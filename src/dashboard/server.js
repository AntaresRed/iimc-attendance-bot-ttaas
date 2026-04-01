'use strict';

const express  = require('express');
const session  = require('express-session');
const path     = require('path');
const db       = require('../db/database');

const PORT     = parseInt(process.env.PORT || process.env.DASHBOARD_PORT || '4000', 10);
const PASSWORD = process.env.DASHBOARD_PASSWORD || 'Antares@2265';
const SECRET   = process.env.SESSION_SECRET     || 'att-dash-secret-fallback';

// ─── Shared bot status (updated from index.js) ───────────────────────────────
let _botStatus = { connected: false, qrPending: false, phoneNumber: null, connectedAt: null };
function setBotStatus(update) { _botStatus = { ..._botStatus, ...update }; }

// ─── Helpers ──────────────────────────────────────────────────────────────────
const D = () => db.getDb();
const requireAuth = (req, res, next) =>
  req.session && req.session.auth ? next() : res.status(401).json({ error: 'Unauthorized' });

// ─── Server factory ───────────────────────────────────────────────────────────
function createDashboardServer() {
  const app = express();

  app.use(express.json());
  app.use(session({
    secret: SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: false, maxAge: 8 * 60 * 60 * 1000 },
  }));
  app.use(express.static(path.join(__dirname, 'public')));

  // ── Auth ───────────────────────────────────────────────────────────────────
  app.post('/api/login', (req, res) => {
    if (req.body && req.body.password === PASSWORD) {
      req.session.auth = true;
      // Explicitly save before responding — required in Express 5 to ensure
      // the Set-Cookie header is included in this very response.
      req.session.save((err) => {
        if (err) { console.error('[Dashboard] Session save error:', err); return res.status(500).json({ error: 'Session error' }); }
        res.json({ ok: true });
      });
    } else {
      res.status(401).json({ error: 'Wrong password' });
    }
  });
  app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
  app.get('/api/auth/check', (req, res) => res.json({ ok: !!(req.session && req.session.auth) }));

  // ── Bot status ─────────────────────────────────────────────────────────────
  app.get('/api/bot/status', requireAuth, (_req, res) => res.json(_botStatus));

  // ── Courses list (for autocomplete) ───────────────────────────────────────
  const { VALID_COURSES } = require('../utils/ocr');
  app.get('/api/courses', requireAuth, (_req, res) => res.json(VALID_COURSES));

  // ── Overview ───────────────────────────────────────────────────────────────
  app.get('/api/overview', requireAuth, (_req, res) => {
    const dow      = new Date().getDay();
    const todayStr = new Date().toISOString().slice(0, 10);
    const totalUsers   = D().prepare(`SELECT COUNT(*) c FROM users WHERE is_active=1`).get().c;
    const stats        = D().prepare(`SELECT COUNT(*) total, SUM(status='present') present FROM attendance_logs`).get();
    const activeOvr    = D().prepare(`SELECT COUNT(*) c FROM schedule_overrides WHERE new_date >= date('now')`).get().c;
    const todaySessions = D().prepare(`
      SELECT se.subject, se.start_time, se.end_time, u.name user_name
      FROM schedule_entries se JOIN users u ON u.id=se.user_id
      WHERE se.day_of_week=? ORDER BY se.start_time`).all(dow);
    const bySubject = D().prepare(`
      SELECT subject, COUNT(*) total, SUM(status='present') present
      FROM attendance_logs GROUP BY subject ORDER BY total DESC LIMIT 12`).all();
    res.json({ totalUsers, stats, activeOvr, todaySessions, bySubject });
  });

  // ── Users ──────────────────────────────────────────────────────────────────
  app.get('/api/users', requireAuth, (_req, res) => {
    res.json(D().prepare(`
      SELECT u.*, s.name section_name,
             COUNT(al.id) total_logs, SUM(al.status='present') present_logs
      FROM users u
      LEFT JOIN sections s ON s.id=u.section_id
      LEFT JOIN attendance_logs al ON al.user_id=u.id
      GROUP BY u.id ORDER BY u.registered_at DESC`).all());
  });
  app.put('/api/users/:id', requireAuth, (req, res) => {
    const { name, role, section_id, is_active } = req.body;
    D().prepare(`UPDATE users SET name=?,role=?,section_id=?,is_active=? WHERE id=?`)
      .run(name, role, section_id || null, is_active ? 1 : 0, req.params.id);
    res.json({ ok: true });
  });
  app.delete('/api/users/:id', requireAuth, (req, res) => {
    const u = D().prepare('SELECT phone FROM users WHERE id=?').get(req.params.id);
    if (u) db.deleteUser(u.phone);
    res.json({ ok: true });
  });

  // ── Sections ───────────────────────────────────────────────────────────────
  app.get('/api/sections', requireAuth, (_req, res) => res.json(db.getSections()));
  app.put('/api/sections/:id', requireAuth, (req, res) => {
    D().prepare('UPDATE sections SET name=? WHERE id=?').run(req.body.name, req.params.id);
    res.json({ ok: true });
  });

  // ── Timetable ──────────────────────────────────────────────────────────────
  app.get('/api/timetable/:userId', requireAuth, (req, res) =>
    res.json(db.getScheduleForUser(req.params.userId)));
  app.post('/api/timetable/:userId', requireAuth, (req, res) => {
    const { subject, day_of_week, start_time, end_time, room } = req.body;
    db.insertScheduleEntry({ user_id: +req.params.userId, subject, day_of_week: +day_of_week, start_time, end_time, room: room || null });
    res.json({ ok: true });
  });
  app.put('/api/timetable/entry/:id', requireAuth, (req, res) => {
    const { subject, start_time, end_time, room } = req.body;
    D().prepare(`UPDATE schedule_entries SET subject=?,start_time=?,end_time=?,room=? WHERE id=?`)
      .run(subject, start_time, end_time, room || null, req.params.id);
    res.json({ ok: true });
  });
  app.delete('/api/timetable/entry/:id', requireAuth, (req, res) => {
    D().prepare('DELETE FROM schedule_entries WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  });

  // ── Attendance ─────────────────────────────────────────────────────────────
  app.get('/api/attendance', requireAuth, (req, res) => {
    const { userId, date, subject, status, limit = 100, offset = 0 } = req.query;
    let sql = `SELECT al.*, u.name user_name FROM attendance_logs al JOIN users u ON u.id=al.user_id WHERE 1=1`;
    const p = [];
    if (userId)  { sql += ' AND al.user_id=?';       p.push(userId); }
    if (date)    { sql += ' AND al.session_date=?';   p.push(date); }
    if (subject) { sql += ' AND al.subject LIKE ?';   p.push(`%${subject}%`); }
    if (status)  { sql += ' AND al.status=?';         p.push(status); }
    sql += ' ORDER BY al.session_date DESC, al.session_start DESC LIMIT ? OFFSET ?';
    p.push(+limit, +offset);
    res.json(D().prepare(sql).all(...p));
  });
  app.put('/api/attendance/:id', requireAuth, (req, res) => {
    const { status } = req.body;
    if (!['present','absent'].includes(status)) return res.status(400).json({ error: 'Bad status' });
    db.editAttendance(+req.params.id, status);
    res.json({ ok: true });
  });
  app.delete('/api/attendance/:id', requireAuth, (req, res) => {
    D().prepare('DELETE FROM attendance_logs WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  });

  // ── Overrides ──────────────────────────────────────────────────────────────
  app.get('/api/overrides', requireAuth, (_req, res) => {
    res.json(D().prepare(`
      SELECT so.*, u.name user_name, cb.name created_by_name
      FROM schedule_overrides so
      JOIN users u ON u.id=so.user_id
      LEFT JOIN users cb ON cb.id=so.created_by
      ORDER BY so.created_at DESC LIMIT 200`).all());
  });
  app.delete('/api/overrides/:id', requireAuth, (req, res) => {
    D().prepare('DELETE FROM schedule_overrides WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  });

  // ── Audit log ──────────────────────────────────────────────────────────────
  app.get('/api/audit', requireAuth, (_req, res) => {
    res.json(D().prepare(`
      SELECT a.*, u.name user_name, al.session_date, al.subject, al.session_start
      FROM audit_log a
      JOIN users u ON u.id=a.user_id
      JOIN attendance_logs al ON al.id=a.attendance_id
      ORDER BY a.edited_at DESC LIMIT 500`).all());
  });

  // ── SPA catch-all ──────────────────────────────────────────────────────────
  app.get('/{*path}', (_req, res) =>
    res.sendFile(path.join(__dirname, 'public', 'index.html')));

  app.listen(PORT, () => console.log(`[Dashboard] http://localhost:${PORT}`));
  return app;
}

module.exports = { createDashboardServer, setBotStatus };
