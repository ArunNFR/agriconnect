'use strict';
const db = require('../db');
const clock = require('./clock');

/**
 * In-app notification + queued outbound email for every account user.
 * dedupeKey prevents repeated reminders (e.g. "renewal reminder 7 days" for the same cycle).
 */
function notify(accountId, type, title, body, data = {}, { priority = 'normal', dedupeKey } = {}) {
  if (dedupeKey && db.one('SELECT 1 FROM notification_outbox WHERE dedupe_key = ?', dedupeKey)) return null;
  const id = db.insert('notifications', { account_id: accountId, type, title, body, data_json: data, priority, created_at: clock.iso() });
  const users = db.all("SELECT id, email FROM users WHERE account_id = ? AND status = 'active' AND account_role IN ('owner','manager')", accountId);
  users.forEach((u, i) => db.insert('notification_outbox', {
    notification_id: id, channel: 'email', recipient: u.email, subject: title, body,
    dedupe_key: dedupeKey ? `${dedupeKey}:${i}` : null, created_at: clock.iso(),
  }));
  if (dedupeKey && !users.length) db.insert('notification_outbox', { notification_id: id, channel: 'none', recipient: '-', dedupe_key: dedupeKey, created_at: clock.iso() });
  else if (dedupeKey) db.run('UPDATE notification_outbox SET dedupe_key = ? WHERE dedupe_key = ?', dedupeKey, `${dedupeKey}:0`);
  return id;
}

function notifyPlatform(type, title, body, data) {
  const acct = db.one("SELECT id FROM accounts WHERE type = 'platform' ORDER BY id LIMIT 1");
  if (acct) notify(acct.id, type, title, body, data);
}

module.exports = { notify, notifyPlatform };
