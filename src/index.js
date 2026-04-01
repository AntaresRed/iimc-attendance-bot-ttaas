'use strict';

const qrcode = require('qrcode-terminal');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const db = require('./db/database');
const bot = require('./bot');
const scheduler = require('./features/scheduler');
const broadcast = require('./features/broadcast');
const { createDashboardServer, setBotStatus } = require('./dashboard/server');
const mq = require('./utils/messageQueue');

const SESSION_DIR = process.env.SESSION_DIR || './sessions';

// ── Graceful shutdown ────────────────────────────────────────────────────────
// Sends a clean WebSocket close frame to WhatsApp before the process exits.
// Without this, closing CMD / rebooting looks like a network drop to WhatsApp,
// which can cause it to eventually invalidate the session, forcing a new QR.
let _isShuttingDown = false;
let _currentSock    = null;
let _reconnectCount = 0;
const MAX_RECONNECTS = 5;

async function gracefulShutdown(signal) {
  if (_isShuttingDown) return;
  _isShuttingDown = true;
  console.log(`\n[App] ${signal} received — saving session and exiting cleanly...`);
  try {
    if (_currentSock) {
      // Pass no error → WhatsApp receives a clean close, keeps session alive
      _currentSock.end(undefined);
      // Brief pause so the close frame is flushed before we exit
      await new Promise(r => setTimeout(r, 1500));
    }
  } catch (_) { /* non-fatal */ }
  console.log('[App] Goodbye. Run npm start to reconnect (no QR needed).');
  process.exit(0);
}

// Catch every possible termination signal on Windows + Unix
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));   // Ctrl+C
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));  // process manager / Railway
process.on('SIGBREAK',() => gracefulShutdown('SIGBREAK')); // Windows Ctrl+Break

async function connectToWhatsApp() {
  if (_isShuttingDown) return;

  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers,
    fetchLatestBaileysVersion
  } = await import('@whiskeysockets/baileys');

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  
  console.log(`[WA] Using WA v${version.join('.')}, isLatest: ${isLatest}`);
  
  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: process.env.LOG_LEVEL || 'info' }),
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
  });

  // Track current socket for graceful shutdown
  _currentSock = sock;

  // ── Anti-ban send layer ──────────────────────────────────────────────────
  // rawSend: the actual Baileys call (never used directly outside this block)
  // sendFn:  direct replies → go through queue WITH typing indicator
  // broadcastFn: scheduler/broadcast sends → queue WITHOUT typing (speed)
  const rawSend = async (jid, text) => sock.sendMessage(jid, { text });

  mq.init(rawSend, sock);

  const sendFn      = (jid, text) => mq.send(jid, text, { typing: true });
  const broadcastFn = (jid, text) => mq.send(jid, text, { typing: false });

  bot.initBot(sendFn);
  scheduler.setSendFn(broadcastFn);
  broadcast.setSendFn(broadcastFn);

  // ── Presence heartbeat (↑ human-like signal to WA servers) ───────────────
  // Sends an "available" presence update every 30 min so the session looks
  // like an active phone rather than a dead connection.
  const _presenceTimer = setInterval(async () => {
    try { await sock.sendPresenceUpdate('available'); }
    catch (_) { /* non-fatal */ }
  }, 30 * 60 * 1000);

  sock.ev.on('creds.update', saveCreds);

  // ── Bad MAC / Session-key auto-recovery ─────────────────────────────────────
  // Baileys fires this event when it cannot decrypt a message.
  //
  // IMPORTANT — two classes of decrypt error exist:
  //   1. @lid / fromMe:true  — Multi-device sync of our OWN sent messages.
  //      These ALWAYS fail on first connect after a fresh QR scan because we
  //      don't have the old encryption keys. Completely harmless; ignore them.
  //   2. @s.whatsapp.net / fromMe:false — A real incoming message we can't
  //      decrypt. This means our session keys are genuinely stale. Wipe & restart.
  //
  // A 5-min debounce prevents a wipe-restart loop if errors keep firing.
  let _lastWipe = 0;
  sock.ev.on('messages.decrypt-error', (args) => {
    // Baileys may emit an array or a single object — normalise to array
    const failures = Array.isArray(args) ? args : [args];

    for (const item of failures) {
      const failure = item?.failure || item;
      const key     = item?.key || failure?.key || {};
      const jid     = key.remoteJid || '';
      const fromMe  = key.fromMe === true;
      const errMsg  = failure?.message || failure?.err?.message || String(failure);

      // ── Ignore: expected @lid / fromMe sync noise ────────────────────────
      if (jid.endsWith('@lid') || fromMe) {
        console.debug('[WA] Decrypt error for own message sync (expected) — skipping.');
        continue;
      }

      // ── Real incoming-message failure — wipe sessions ────────────────────
      if (errMsg.includes('Bad MAC') || errMsg.includes('No matching sessions') ||
          errMsg.includes('MessageCounterError')) {
        const now = Date.now();
        if (now - _lastWipe < 5 * 60 * 1000) {
          console.warn('[WA] Decrypt error, but wipe already ran recently — skipping duplicate.');
          continue;
        }
        _lastWipe = now;
        console.warn('[WA] ⚠️  Real Bad MAC on incoming message — wiping sessions and reconnecting...');
        try {
          for (const f of fs.readdirSync(SESSION_DIR)) {
            fs.rmSync(path.join(SESSION_DIR, f), { recursive: true, force: true });
          }
        } catch (_) { /* folder may not exist */ }
        sock.end(new Error('Bad MAC — session reset'));
        setTimeout(() => connectToWhatsApp(), 2000);
      }
    }
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
        qrcode.generate(qr, { small: true });
        setBotStatus({ connected: false, qrPending: true, phoneNumber: null, qrCode: qr });
    }

    if (connection === 'close') {
      if (_isShuttingDown) return; // clean shutdown in progress — do nothing

      setBotStatus({ connected: false, qrPending: false });
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut  = statusCode === DisconnectReason.loggedOut;

      console.log(`[WA] Connection closed. Code: ${statusCode}, loggedOut: ${loggedOut}, attempt: ${_reconnectCount + 1}/${MAX_RECONNECTS}`);

      if (!loggedOut && _reconnectCount < MAX_RECONNECTS) {
        // Regular disconnect (network blip, server restart, etc.) — reconnect
        _reconnectCount++;
        const delay = Math.min(3000 * _reconnectCount, 15000); // 3s, 6s, 9s … 15s max
        console.log(`[WA] Reconnecting in ${delay / 1000}s...`);
        setTimeout(() => connectToWhatsApp(), delay);
      } else if (loggedOut) {
        // Genuinely logged out from WhatsApp (removed from Linked Devices)
        // Clear sessions so next startup shows a fresh QR immediately
        console.log('[WA] Logged out from WhatsApp. Clearing session for next startup...');
        try {
          for (const f of fs.readdirSync(SESSION_DIR)) {
            fs.rmSync(path.join(SESSION_DIR, f), { recursive: true, force: true });
          }
        } catch (_) {}
        setBotStatus({ connected: false, qrPending: false, phoneNumber: null });
        console.log('[WA] Sessions cleared. Run npm start to scan a new QR.');
        process.exit(0); // exit 0 so Railway/PM2 restarts and shows QR
      } else {
        console.log('[WA] Max reconnect attempts reached. Restarting process...');
        process.exit(1); // let the process manager restart us
      }
    } else if (connection === 'open') {
      _reconnectCount = 0; // reset counter on successful connection
      console.log('[WA] Connected and ready.');
      const phone = sock.user?.id?.split(':')[0] || null;
      setBotStatus({ connected: true, qrPending: false, phoneNumber: phone, connectedAt: new Date().toISOString() });
      scheduler.startScheduler();
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    
    for (const msg of messages) {
       if (!msg.message) continue;
       
       console.log(`[DEBUG] Incoming msg. fromMe: ${msg.key.fromMe}, from: ${msg.key.remoteJid}`);
       if (msg.key.fromMe) {
           console.log(`[SKIP] Ignored message because it was sent FROM the bot itself.`);
           continue;
       }

       // Mark message as read — signals to WA that a human is actively reading
       try { await sock.readMessages([msg.key]); } catch (_) {}

       const jid = msg.key.remoteJid;
       const isGroup = jid.endsWith('@g.us');
       
       // Handle different text message types (standard text, extended text, buttons response)
       let text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

       // ── Quoted-reply detection ──────────────────────────────────────────────
       // If the user quoted a bot message and sent an empty reply (or just whitespace),
       // try to extract the leading number from the quoted text so it acts like a tap.
       if (!text.trim()) {
         const ctx = msg.message.extendedTextMessage?.contextInfo;
         if (ctx?.quotedMessage) {
           const quotedBody =
             ctx.quotedMessage.conversation ||
             ctx.quotedMessage.extendedTextMessage?.text ||
             '';
           if (quotedBody) {
             // Strip emoji-number sequences like 1️⃣, 2️⃣ … 9️⃣, 🔟
             const emojiNums = { '1️⃣':'1','2️⃣':'2','3️⃣':'3','4️⃣':'4','5️⃣':'5',
                                  '6️⃣':'6','7️⃣':'7','8️⃣':'8','9️⃣':'9','🔟':'10' };
             let normalized = quotedBody;
             for (const [emoji, digit] of Object.entries(emojiNums)) {
               normalized = normalized.replace(emoji, digit);
             }
             // Match a leading digit(s) at the very start of the first line
             const m = normalized.trimStart().match(/^(\d{1,2})[.\s]/);
             if (m) {
               text = m[1]; // e.g. '1', '2', '10' …
               console.log(`[QuotedReply] Resolved quoted option → "${text}"`);
             }
           }
         }
       }
       // ───────────────────────────────────────────────────────────────────────

       // Check for image for timetable upload
       let imageMessage = null;
       if (msg.message.imageMessage) {
           imageMessage = msg.message.imageMessage;
           text = imageMessage.caption || '';
       }

       try {
           await bot.handleMessage({ 
               jid, 
               text, 
               isGroup, 
               msgId: msg.key.id, 
               imageMessage, 
               sock // pass socket if we need to download media
           });
       } catch (err) {
           console.error('[App] Error processing message:', err);
           await sock.sendMessage(jid, { text: `❌ An internal error occurred.` });
       }
    }
  });
}

// ─── App Startup ─────────────────────────────────────────────────────────────

async function start() {
    console.log('[App] Starting...');
    db.init();
    db.prepareAll();
    db.bootstrap();

    if (!fs.existsSync(process.env.UPLOADS_DIR || './uploads')) {
        fs.mkdirSync(process.env.UPLOADS_DIR || './uploads', { recursive: true });
    }

    // Start the admin dashboard web server
    createDashboardServer();

    await connectToWhatsApp();
}

start();
