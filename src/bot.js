'use strict';

const db = require('./db/database');
const studentFlow = require('./menus/student');
const crFlow = require('./menus/cr');
const { welcomeMessage, registrationComplete } = require('./utils/formatter');

let _sendFn = null;

function initBot(sendFn) {
  _sendFn = sendFn;
}

async function handleMessage(msgInfo) {
  const { jid, text, isGroup } = msgInfo;
  
  // Ignore empty messages
  if (!text) return;

  const phone = jid;
  const user = db.getUser(phone);
  const isSuperadmin = phone === process.env.BOOTSTRAP_CR_PHONE || (user && user.role === 'superadmin');

  // Handle group registration setup first
  if (isGroup) {
      // If a CR messages "link section N" in a group, save the group_jid to the section.
      if (text.toLowerCase().startsWith('link section ') && (isSuperadmin || (user && user.role === 'cr'))) {
          const sectionNum = text.replace(/[^0-9]/g, '');
          const sectionId = parseInt(sectionNum, 10);
          if (isNaN(sectionId)) {
             await _sendFn(jid, `❌ Invalid format. Use: link section 1`);
             return;
          }
          const section = db.getSectionById(sectionId);
          if (!section) {
             await _sendFn(jid, `❌ Section ${sectionId} not found.`);
             return;
          }
          db.linkSectionToGroup(sectionId, jid);
          await _sendFn(jid, `✅ Group linked to ${section.name}. Bot will now broadcast here.`);
          return;
      }

      // Inside groups, the bot only responds to explicit commands meant for the group
      // or allows students to DM it. To keep group spam low, we ignore standard 
      // 1:1 commands here.
      if (text.toLowerCase().trim() === 'menu') {
          await _sendFn(jid, `ℹ️ Please DM me to interact with the bot menus.`);
      }
      return; 
  }

  // ==== Private Message Flow ====

  const lowerText = text.toLowerCase().trim();

  // Auto-expire stale conversation states older than 30 minutes (#18)
  if (user) {
    const conv = db.getConvState(phone);
    if (conv.state !== 'idle') {
      const ageMinutes = db.getConvStateAge(phone);
      if (ageMinutes > 30) {
        db.clearConvState(phone);
        const menuFn = (user.role === 'cr' || user.role === 'superadmin')
          ? require('./utils/formatter').crMenu
          : require('./utils/formatter').studentMenu;
        await _sendFn(jid, `⏰ Your previous session timed out after 30 minutes.\n\n` + menuFn());
        return;
      }
    }
  }

  // Fresh user registration
  if (!user) {
    let conv = db.getConvState(phone);
    // Unregistered user sends an image → nudge them to register first (#24)
    if (msgInfo.imageMessage) {
      await _sendFn(jid, welcomeMessage(process.env.CLASS_NAME || 'Your Class'));
      db.setConvState(phone, 'reg_name');
      return;
    }
    if (conv.state === 'idle') {
       db.setConvState(phone, 'reg_name');
       await _sendFn(jid, welcomeMessage(process.env.CLASS_NAME || 'Your Class'));
       return;
    }
    
    if (conv.state === 'reg_name') {
       const name = text.trim();
       // Guard: don't register with a blank name
       if (!name || name.length < 2) {
         await _sendFn(jid, `✏️ Please enter your full name (at least 2 characters):`);
         return;
       }
       const role = phone.startsWith(process.env.BOOTSTRAP_CR_PHONE) ? 'superadmin' : 'student';
       db.upsertUser({ phone, name, role, section_id: 1 });
       db.clearConvState(phone);
       await _sendFn(jid, require('./utils/formatter').registrationComplete(name));
       return;
    }
  }

  // Update last seen
  if (user) db.touchUser(phone);

  // Global exit
  if (['exit', 'cancel', 'menu'].includes(lowerText)) {
      db.clearConvState(phone);
      if (user.role === 'cr' || user.role === 'superadmin') {
          await _sendFn(jid, require('./utils/formatter').crMenu());
      } else {
          await _sendFn(jid, require('./utils/formatter').studentMenu());
      }
      return;
  }

  // Self deletion — requires a confirmation step (#23)
  if (lowerText === 'delete my account') {
    db.setConvState(phone, 'confirm_delete');
    await _sendFn(jid,
      `⚠️ *Are you sure?*\n\n` +
      `This will permanently delete your account, phone number, and ALL attendance history.\n\n` +
      `Reply *yes, delete my account* to confirm, or anything else to cancel.`
    );
    return;
  }

  const conv = db.getConvState(phone);
  if (conv.state === 'confirm_delete') {
    db.clearConvState(phone);
    if (lowerText === 'yes, delete my account') {
      db.deleteUser(phone);
      await _sendFn(jid, `🗑️ Your account and all related data have been permanently deleted.`);
    } else {
      await _sendFn(jid, `✅ Deletion cancelled. Your account is safe.`);
    }
    return;
  }

  // Route to specific FSM
  if (user.role === 'cr' || user.role === 'superadmin') {
     await crFlow.processMessage(user, msgInfo, _sendFn);
  } else {
     await studentFlow.processMessage(user, msgInfo, _sendFn);
  }
}

module.exports = {
  initBot,
  handleMessage,
};
