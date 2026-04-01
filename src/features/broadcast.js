'use strict';

const db = require('../db/database');
const formatter = require('../utils/formatter');

let _sendMessageFn = null;

/**
 * Called from index.js to inject the Baileys send function.
 */
function setSendFn(fn) {
  _sendMessageFn = fn;
}

/**
 * Broadcasts a message to the group associated with the given section.
 */
async function broadcastToSection(sectionId, messageText) {
  if (!_sendMessageFn) {
    console.error('[Broadcast] No send function injected.');
    return false;
  }
  const section = db.getSectionById(sectionId);
  if (!section || !section.group_jid) {
    console.warn(`[Broadcast] Section ${sectionId} has no linked group.`);
    return false;
  }

  try {
    await _sendMessageFn(section.group_jid, messageText);
    return true;
  } catch (err) {
    console.error(`[Broadcast] Failed to send to section ${sectionId}:`, err);
    return false;
  }
}

/**
 * Sends a cancellation notification to a section.
 */
async function notifyCancellation(sectionId, subject, date, startTime, reason) {
  const msg = formatter.broadcastCancellation(subject, date, startTime, reason);
  return broadcastToSection(sectionId, msg);
}

/**
 * Sends a reschedule notification to a section.
 */
async function notifyReschedule(sectionId, subject, originalDate, originalStart, newDate, newStart, newEnd, reason) {
  const msg = formatter.broadcastReschedule(subject, originalDate, originalStart, newDate, newStart, newEnd, reason);
  return broadcastToSection(sectionId, msg);
}

/**
 * Sends an extra class notification to a section.
 */
async function notifyExtraClass(sectionId, subject, date, startTime, endTime, room, reason) {
  const msg = formatter.broadcastExtraClass(subject, date, startTime, endTime, room, reason);
  return broadcastToSection(sectionId, msg);
}

module.exports = {
  setSendFn,
  broadcastToSection,
  notifyCancellation,
  notifyReschedule,
  notifyExtraClass,
};
