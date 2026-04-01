-- ============================================================
-- WhatsApp Attendance Bot — SQLite Schema
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ─── Sections ────────────────────────────────────────────────
-- Represents each of the 6 class sections.
-- group_jid is the WhatsApp group JID (set when the bot is added to a group).
CREATE TABLE IF NOT EXISTS sections (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE,          -- e.g. "Section A"
    group_jid   TEXT    UNIQUE,                   -- WA group JID, NULL until bot joins
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ─── Users ───────────────────────────────────────────────────
-- All registered bot users (students + CRs).
CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    phone       TEXT    NOT NULL UNIQUE,          -- WA JID e.g. 919876543210@s.whatsapp.net
    name        TEXT    NOT NULL DEFAULT 'Unknown',
    role        TEXT    NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'cr', 'superadmin')),
    section_id  INTEGER REFERENCES sections(id) ON DELETE SET NULL,
    is_active   INTEGER NOT NULL DEFAULT 1,
    registered_at TEXT  NOT NULL DEFAULT (datetime('now')),
    last_seen   TEXT
);

-- ─── Schedule Entries (Source of Truth — Original Timetable) ─
-- Parsed from the uploaded PNG. One row per period slot per day.
CREATE TABLE IF NOT EXISTS schedule_entries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject     TEXT    NOT NULL,
    day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6), -- 0=Sun,1=Mon,...
    start_time  TEXT    NOT NULL,   -- HH:MM (24h)
    end_time    TEXT    NOT NULL,   -- HH:MM (24h)
    room        TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, day_of_week, start_time)
);

-- ─── Schedule Overrides (The "Changes" List) ─────────────────
-- CR-applied deviations from the original timetable.
CREATE TABLE IF NOT EXISTS schedule_overrides (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    original_entry_id   INTEGER REFERENCES schedule_entries(id) ON DELETE CASCADE,
    override_type       TEXT NOT NULL CHECK (override_type IN ('cancelled', 'rescheduled', 'extra')),

    -- Original slot (for rescheduled / cancelled)
    original_date       TEXT,       -- YYYY-MM-DD (specific date this applies to)
    original_start_time TEXT,       -- HH:MM

    -- New slot (for rescheduled / extra)
    new_date            TEXT,       -- YYYY-MM-DD
    new_start_time      TEXT,       -- HH:MM
    new_end_time        TEXT,       -- HH:MM
    new_room            TEXT,
    subject             TEXT,       -- may differ for 'extra' classes

    reason              TEXT,
    created_by          INTEGER REFERENCES users(id),
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    broadcast_sent      INTEGER NOT NULL DEFAULT 0  -- 0=no, 1=yes
);

-- ─── Attendance Logs ─────────────────────────────────────────
-- One row per (student, session). A "session" is identified by
-- a section_id + date + start_time (resolving overrides).
CREATE TABLE IF NOT EXISTS attendance_logs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_date    TEXT    NOT NULL,   -- YYYY-MM-DD
    session_start   TEXT    NOT NULL,   -- HH:MM (effective start, post-override)
    subject         TEXT    NOT NULL,
    status          TEXT    NOT NULL DEFAULT 'absent' CHECK (status IN ('present', 'absent')),
    override_id     INTEGER REFERENCES schedule_overrides(id),  -- non-NULL if rescheduled
    marked_at       TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, session_date, session_start)
);

-- ─── Audit Log ───────────────────────────────────────────────
-- Records every attendance edit for anti-abuse tracking.
CREATE TABLE IF NOT EXISTS audit_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id),
    attendance_id   INTEGER NOT NULL REFERENCES attendance_logs(id),
    old_status      TEXT    NOT NULL,
    new_status      TEXT    NOT NULL,
    edited_at       TEXT    NOT NULL DEFAULT (datetime('now')),
    note            TEXT    -- optional reason given by student
);

-- ─── Conversation State ──────────────────────────────────────
-- Stores the current FSM state for each user's conversation.
CREATE TABLE IF NOT EXISTS conversation_state (
    phone       TEXT    PRIMARY KEY,
    state       TEXT    NOT NULL DEFAULT 'idle',   -- FSM state key
    context     TEXT    NOT NULL DEFAULT '{}',      -- JSON blob for mid-flow data
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ─── Indexes ─────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_users_phone          ON users(phone);
CREATE INDEX IF NOT EXISTS idx_users_section        ON users(section_id);
CREATE INDEX IF NOT EXISTS idx_schedule_user_day    ON schedule_entries(user_id, day_of_week);
CREATE INDEX IF NOT EXISTS idx_overrides_user       ON schedule_overrides(user_id, new_date);
CREATE INDEX IF NOT EXISTS idx_attendance_user      ON attendance_logs(user_id, session_date);
CREATE INDEX IF NOT EXISTS idx_audit_user           ON audit_log(user_id, edited_at);
