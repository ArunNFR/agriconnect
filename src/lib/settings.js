'use strict';
const db = require('../db');
const clock = require('./clock');
const audit = require('./audit');
const { notFound } = require('./util');

/** Monetisation configuration lives in platform_settings; nothing is hardcoded in services. */
function get(key) {
  const r = db.one('SELECT value_json FROM platform_settings WHERE key = ?', key);
  if (!r) throw notFound(`Setting ${key}`);
  return JSON.parse(r.value_json);
}
function getAll() {
  return db.all('SELECT key, value_json, description, updated_at, updated_by FROM platform_settings ORDER BY key')
    .map((r) => ({ ...r, value: JSON.parse(r.value_json), value_json: undefined }));
}
function set(key, value, actor, description) {
  return db.tx(() => {
    const existing = db.one('SELECT value_json FROM platform_settings WHERE key = ?', key);
    if (existing) {
      db.run('UPDATE platform_settings SET value_json = ?, updated_by = ?, updated_at = ? WHERE key = ?', JSON.stringify(value), actor?.userId ?? null, clock.iso(), key);
    } else {
      db.insert('platform_settings', { key, value_json: JSON.stringify(value), description, updated_by: actor?.userId ?? null, updated_at: clock.iso() });
    }
    audit.log(actor || 'system', 'settings.update', 'platform_setting', key, { before: existing ? JSON.parse(existing.value_json) : null, after: value });
    return value;
  });
}
module.exports = { get, getAll, set };
