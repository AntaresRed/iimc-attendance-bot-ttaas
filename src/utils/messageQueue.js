'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Throttled message queue — the core anti-ban layer.
//
// What it does:
//   1. Enforces a random delay between every outgoing message (jitter)
//      so the bot doesn't look like it's firing at machine speed.
//   2. Optionally simulates a human typing indicator before sending.
//   3. Retries failed sends with exponential backoff (helps with transient
//      WhatsApp WS errors without hammering the connection).
//
// All outgoing messages MUST go through this queue.
// ─────────────────────────────────────────────────────────────────────────────

const MIN_JITTER_MS  = 300;   // minimum delay between messages
const MAX_JITTER_MS  = 900;   // maximum delay between messages
const MAX_RETRIES    = 3;
const RETRY_BASE_MS  = 2000;  // doubles each retry: 2s → 4s → 8s

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class MessageQueue {
  constructor() {
    this._queue   = [];
    this._running = false;
    this._rawSend = null; // async (jid, text) => void
    this._sock    = null; // Baileys socket (for typing + presence)
  }

  /**
   * Must be called once after the WhatsApp socket is created.
   */
  init(rawSendFn, sock) {
    this._rawSend = rawSendFn;
    this._sock    = sock;
  }

  /**
   * Enqueue a message for delivery.
   *
   * @param {string} jid           - WhatsApp JID
   * @param {string} text          - Message text
   * @param {object} [opts]
   * @param {boolean} [opts.typing=false]   - Simulate typing indicator first
   * @param {number}  [opts.typingMs=1200]  - How long to show typing (ms)
   */
  send(jid, text, opts = {}) {
    return new Promise((resolve, reject) => {
      this._queue.push({ jid, text, opts, resolve, reject, retries: 0 });
      if (!this._running) this._drain();
    });
  }

  async _drain() {
    this._running = true;
    while (this._queue.length > 0) {
      const item = this._queue.shift();
      await this._deliver(item);

      // Inter-message jitter — only pause if there are more messages waiting
      if (this._queue.length > 0) {
        const jitter = MIN_JITTER_MS + Math.random() * (MAX_JITTER_MS - MIN_JITTER_MS);
        await sleep(jitter);
      }
    }
    this._running = false;
  }

  async _deliver(item) {
    try {
      // Typing indicator — makes the bot look human on direct replies
      if (item.opts.typing && this._sock) {
        const typingMs = item.opts.typingMs ?? (800 + Math.random() * 1200);
        try {
          await this._sock.sendPresenceUpdate('composing', item.jid);
          await sleep(typingMs);
          await this._sock.sendPresenceUpdate('paused', item.jid);
        } catch (_) { /* non-fatal — still send the message */ }
      }

      await this._rawSend(item.jid, item.text);
      item.resolve();

    } catch (err) {
      if (item.retries < MAX_RETRIES) {
        item.retries++;
        const backoff = RETRY_BASE_MS * Math.pow(2, item.retries - 1);
        console.warn(`[Queue] Send failed, retry ${item.retries}/${MAX_RETRIES} in ${backoff}ms — ${err.message}`);
        await sleep(backoff);
        this._queue.unshift(item); // back to front of queue
      } else {
        console.error(`[Queue] Permanently failed to send to ${item.jid} after ${MAX_RETRIES} retries`);
        item.reject(err);
      }
    }
  }
}

// Export as singleton — the whole app shares one queue
module.exports = new MessageQueue();
