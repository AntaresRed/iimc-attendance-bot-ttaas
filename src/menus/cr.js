'use strict';

const db = require('../db/database');
const studentFlow = require('./student');
const formatter = require('../utils/formatter');
const ocr = require('../utils/ocr');
const fs = require('fs');
const path = require('path');
const { today, parseClassDateTime } = require('../utils/timeUtils');
const broadcast = require('../features/broadcast');
const timetable = require('../features/timetable');

async function downloadMedia(msgInfo) {
  const { downloadContentFromMessage } = await import('@whiskeysockets/baileys');
  const stream = await downloadContentFromMessage(msgInfo.imageMessage, 'image');
  let buffer = Buffer.from([]);
  for await(const chunk of stream) {
      buffer = Buffer.concat([buffer, chunk]);
  }
  return buffer;
}

async function processMessage(user, msgInfo, sendFn) {
  const { jid, text, imageMessage } = msgInfo;
  const phone = user.phone;
  const lowerText = text.toLowerCase().trim();
  let conv = db.getConvState(phone);

  // If a CR uploads an image (timetable)
  if (imageMessage) {
      const isCR = user.role === 'cr' || user.role === 'superadmin';
      if (!isCR) return;

      if (!text.toLowerCase().includes('timetable')) {
         await sendFn(jid, `ℹ️ To upload a timetable, attach the image and add the caption *timetable*.`);
         return;
      }
      
      await sendFn(jid, `⏳ Analyzing timetable image. This may take a minute...`);
      
      try {
         const ext = imageMessage.mimetype.split('/')[1] || 'jpeg';
         const filepath = path.join(process.env.UPLOADS_DIR || './uploads', `tt_${Date.now()}.${ext}`);
         const buffer = await downloadMedia(msgInfo);
         fs.writeFileSync(filepath, buffer);
         
         const { entries } = await ocr.parseTimetableImage(filepath);
         
         if (!entries || entries.length === 0) {
            await sendFn(jid, formatter.formatOCRPreview([]));
            return;
         }

         db.setConvState(phone, 'cr_confirm_ocr', { entries });
         await sendFn(jid, formatter.formatOCRPreview(entries));
      } catch (err) {
         console.error('OCR error:', err);
         await sendFn(jid, `❌ Failed to parse image. Ensure it's clear and retry.`);
      }
      return;
  }

  // Intercepting OCR confirmation
  if (conv.state === 'cr_confirm_ocr') {
      if (lowerText === 'confirm' || lowerText === 'yes') {
          timetable.saveParsedTimetable(user.section_id, conv.context.entries);
          db.clearConvState(phone);
          await sendFn(jid, `✅ Timetable saved successfully for your section!`);
          return;
      }
      if (lowerText === 'retry' || lowerText === 'cancel') {
          db.clearConvState(phone);
          await sendFn(jid, `❌ Timetable upload cancelled. Send a clearer image with caption *timetable* to retry.`);
          return;
      }
  }

  // Fallback to student features for 1-5
  if (['1','2','3','4','5','mark','today','week','history','dashboard'].includes(lowerText)) {
     return studentFlow.processMessage(user, msgInfo, sendFn);
  }

  // CR specific features
  if (lowerText === '6' || lowerText === 'reschedule') {
     const dates = db.getScheduleForSection(user.section_id);
     if (dates.length === 0) {
        await sendFn(jid, formatter.ERRORS.noSchedule);
        return;
     }
     
     // Build a simple list of original schedule items for them to pick
     let msg = `Select a class to reschedule by number:\n\n`;
     msg += timetable.formatEntryList(dates);
     
     db.setConvState(phone, 'cr_resch_select', { dates });
     await sendFn(jid, msg);
     return;
  }

  if (conv.state === 'cr_resch_select') {
      const idx = parseInt(lowerText) - 1;
      const dates = conv.context.dates;
      if (isNaN(idx) || idx < 0 || idx >= dates.length) {
          await sendFn(jid, formatter.ERRORS.invalidInput);
          return;
      }
      const selected = dates[idx];
      db.setConvState(phone, 'cr_resch_date', { original: selected });
      await sendFn(jid, `Rescheduling *${selected.subject}* (${selected.start_time}).\n\nEnter the new date (YYYY-MM-DD):`);
      return;
  }
  
  if (conv.state === 'cr_resch_date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
          await sendFn(jid, `❌ Format must be YYYY-MM-DD.`);
          return;
      }
      // Store new date, ask for original date (which instance of the class are we moving?)
      const data = conv.context;
      data.newDate = text;
      db.setConvState(phone, 'cr_resch_target_date', data);
      await sendFn(jid, `Okay, moving to ${text}.\nWhich specific date is being cancelled/moved? (YYYY-MM-DD):`);
      return;
  }

  if (conv.state === 'cr_resch_target_date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
          await sendFn(jid, `❌ Format must be YYYY-MM-DD.`);
          return;
      }
      const data = conv.context;
      data.origDate = text;
      db.setConvState(phone, 'cr_resch_time', data);
      await sendFn(jid, `Got it. Emter the NEW start and end time (HH:MM HH:MM):`);
      return;
  }

  if (conv.state === 'cr_resch_time') {
      const times = lowerText.split(' ');
      if (times.length !== 2) {
          await sendFn(jid, `❌ Format must be: HH:MM HH:MM`);
          return;
      }
      const [start, end] = times;
      const data = conv.context;
      data.newStart = start;
      data.newEnd = end;
      
      const confMsg = formatter.rescheduleConfirmMsg(data.original.subject, data.origDate, data.original.start_time, data.newDate, start, end);
      db.setConvState(phone, 'cr_resch_confirm', data);
      await sendFn(jid, confMsg);
      return;
  }

  if (conv.state === 'cr_resch_confirm') {
      if (lowerText === 'yes' || lowerText === 'y') {
          const data = conv.context;
          const override = {
             section_id: user.section_id,
             original_entry_id: data.original.id,
             override_type: 'rescheduled',
             original_date: data.origDate,
             original_start_time: data.original.start_time,
             new_date: data.newDate,
             new_start_time: data.newStart,
             new_end_time: data.newEnd,
             subject: data.original.subject,
             created_by: user.id
          };
          
          db.addOverride(override);
          db.clearConvState(phone);
          await sendFn(jid, `✅ Rescheduled successfully! Broadcasting to class...`);
          
          await broadcast.notifyReschedule(
              user.section_id, 
              data.original.subject, 
              data.origDate, data.original.start_time,
              data.newDate, data.newStart, data.newEnd,
              null
          );
          return;
      }
      db.clearConvState(phone);
      await sendFn(jid, `❌ Action cancelled.`);
      return;
  }


  if (lowerText === '7' || lowerText === 'cancel') {
     const dates = db.getScheduleForSection(user.section_id);
     if (dates.length === 0) {
        await sendFn(jid, formatter.ERRORS.noSchedule);
        return;
     }
     
     let msg = `Select a class to *cancel* by number:\n\n`;
     msg += timetable.formatEntryList(dates);
     
     db.setConvState(phone, 'cr_cancel_select', { dates });
     await sendFn(jid, msg);
     return;
  }
  
  if (conv.state === 'cr_cancel_select') {
      const idx = parseInt(lowerText) - 1;
      const dates = conv.context.dates;
      if (isNaN(idx) || idx < 0 || idx >= dates.length) return;
      
      const selected = dates[idx];
      db.setConvState(phone, 'cr_cancel_date', { original: selected });
      await sendFn(jid, `Cancelling *${selected.subject}* (${selected.start_time}).\n\nWhich specific date is cancelled? (YYYY-MM-DD):`);
      return;
  }

  if (conv.state === 'cr_cancel_date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) { await sendFn(jid, `❌ Format must be YYYY-MM-DD.`); return; }
      const data = conv.context;
      const override = {
             section_id: user.section_id,
             original_entry_id: data.original.id,
             override_type: 'cancelled',
             original_date: text,
             original_start_time: data.original.start_time,
             subject: data.original.subject,
             created_by: user.id
      };
      
      db.addOverride(override);
      db.clearConvState(phone);
      await sendFn(jid, `✅ Cancelled successfully! Broadcasting to class...`);
      
      await broadcast.notifyCancellation(
          user.section_id, 
          data.original.subject, 
          text, data.original.start_time,
          null
      );
      return;
  }

  if (lowerText === '10' || lowerText === 'audit') {
      const audits = db.getAuditForSection(user.section_id, 10);
      await sendFn(jid, formatter.formatAuditLog(audits));
      return;
  }

  // Default block
  await sendFn(jid, formatter.ERRORS.invalidInput);
}

module.exports = {
  processMessage,
};
