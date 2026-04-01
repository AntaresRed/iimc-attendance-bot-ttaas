# 🤖 WhatsApp Attendance Bot

> A self-hosted WhatsApp bot for automated class attendance tracking, built for student cohorts of any size. Students interact entirely through WhatsApp — no app download, no login, no friction.

---

## ✨ Features

### For Students
- 📸 **Timetable Upload** — Send a photo of your class schedule; OCR automatically parses it
- ✅ **Live Attendance Marking** — Get a WhatsApp prompt at class start; reply to mark present/absent
- 📅 **Today's Schedule** — View today's classes on demand
- 📊 **Attendance Dashboard** — See your attendance percentage per subject
- 📜 **History & Self-Edit** — View past attendance and correct mistakes (with audit trail)
- 🔄 **Class Rescheduling** — Request personal class reschedules or cancellations

### For CRs (Class Representatives)
- 📢 **Broadcast Reschedules** — Notify all students of a class change in one message
- 📢 **Broadcast Cancellations** — Mark a class as cancelled for the whole cohort
- 📢 **Extra Class Announcements** — Add unscheduled classes with a broadcast

### For Admins
- 🖥️ **Web Dashboard** — Password-protected admin panel at `/` on the hosted URL
- 👥 **User Management** — View, edit, and delete user accounts
- 📅 **Timetable Editor** — Visual Mon–Sun grid; add/edit/delete individual class slots
- ✅ **Attendance Override** — Toggle present/absent on any record, for any student
- 🔄 **Override Manager** — View all active schedule overrides
- 📋 **Audit Log** — Full history of every attendance edit
- 🤖 **Bot Status** — Live connection status with QR code for remote pairing

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| WhatsApp Client | [Baileys](https://github.com/WhiskeySockets/Baileys) (multi-device) |
| Runtime | Node.js 20+ |
| Database | SQLite via `better-sqlite3` |
| OCR | Tesseract.js (timetable image parsing) |
| Web Dashboard | Express + Vanilla JS/CSS SPA |
| Hosting | Railway / Oracle Cloud / any Node.js host |

---

## 🚀 Quick Start (Local)

### Prerequisites
- Node.js 20+
- A WhatsApp number (spare SIM recommended)

### Setup

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/attendance-bot.git
cd attendance-bot

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your settings (see configuration section below)

# Start the bot
npm start
```

On first run, a QR code appears in the terminal. Scan it from WhatsApp → **Linked Devices → Link a Device**.

After scanning, the session is saved — subsequent `npm start` reconnects automatically without a QR.

---

## ⚙️ Configuration

Copy `.env.example` to `.env` and fill in:

```env
# Your phone number (bootstrap admin) — country code + number, no +
BOOTSTRAP_CR_PHONE=919876543210

# Institution name shown in messages
CLASS_NAME=IIMC

# Minutes before/after class start to allow attendance marking
ATTENDANCE_WINDOW_MINUTES=15

# Timezone
TZ=Asia/Kolkata

# Admin dashboard
DASHBOARD_PORT=4000
DASHBOARD_PASSWORD=your-strong-password
SESSION_SECRET=your-random-secret-string
```

---

## 📁 Project Structure

```
src/
├── index.js              # Entry point — WhatsApp connection & lifecycle
├── bot.js                # Message router & conversation state manager
├── db/
│   ├── database.js       # All DB queries (better-sqlite3)
│   └── schema.sql        # SQLite schema
├── features/
│   ├── attendance.js     # Attendance marking & history
│   ├── scheduler.js      # Cron-like class-start prompt system
│   ├── timetable.js      # Schedule resolution (overrides, recurring)
│   └── broadcast.js      # CR broadcast messages
├── menus/
│   ├── student.js        # Student conversation FSM
│   └── cr.js             # CR conversation FSM
├── utils/
│   ├── ocr.js            # Tesseract image → timetable parser
│   ├── formatter.js      # All WhatsApp message templates
│   ├── messageQueue.js   # Throttled send queue (anti-ban)
│   └── timeUtils.js      # Date/time helpers
└── dashboard/
    ├── server.js         # Express API server
    └── public/
        └── index.html    # Admin SPA frontend
```

---

## 🌐 Deploying to Railway

1. Push this repo to GitHub (private)
2. Go to [railway.app](https://railway.app) → **New Project → Deploy from GitHub**
3. Add all environment variables from `.env` in the Railway dashboard
4. Add two **Volumes**:
   - Mount path `/app/data` — SQLite database
   - Mount path `/app/sessions` — WhatsApp session files
5. Deploy → open your Railway URL → log into the dashboard → scan QR from **Bot Status** page

---

## 🔒 Security

- `.env` is gitignored — secrets never touch version control
- Dashboard is password-protected with session-based auth
- All API routes require authentication
- WhatsApp session files are stored in a persistent volume, not the repo
- Message sending is rate-limited (anti-ban queue with jitter)

---

## 🛡️ Anti-Ban Measures

This bot implements several measures to reduce WhatsApp ban risk at scale:

1. **Message rate limiting** — max ~4 messages/second with 300–900ms random jitter
2. **Typing indicators** — simulates human composing before every direct reply  
3. **Personalised messages** — each student receives a unique attendance prompt (6 variants) so bulk sends don't share identical content hashes
4. **Read receipts** — all incoming messages are marked as read
5. **Presence heartbeat** — sends "available" status every 30 minutes
6. **Graceful shutdown** — clean WebSocket close prevents session invalidation on restart

---

## 📄 License

Private — All rights reserved.
