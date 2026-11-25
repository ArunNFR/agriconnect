'use strict';
const db = require('../db');
const clock = require('./clock');
const { sha256 } = require('./util');

/**
 * Append a tamper-evident financial audit entry. Each entry's hash covers the previous
 * entry's hash, so edits to history (which DB triggers also block) are detectable.
 * actor: { userId, role } | 'system' | 'provider'
 */
function log(actor, action, entityType, entityId, { before, after, reason, ip } = {}) {
  const a = typeof actor === 'string' ? { userId: null, role: actor } : actor || { role: 'system' };
  const prev = db.one('SELECT hash FROM financial_audit_logs ORDER BY id DESC LIMIT 1');
  const created_at = clock.iso();
  const row = {
    actor_user_id: a.userId ?? null,
    actor_role: a.role,
    action,
    entity_type: entityType,
    entity_id: entityId == null ? null : String(entityId),
    before_json: before === undefined ? null : JSON.stringify(before),
    after_json: after === undefined ? null : JSON.stringify(after),
    reason: reason ?? null,
    ip: ip ?? a.ip ?? null,
    prev_hash: prev ? prev.hash : null,
    created_at,
  };
  row.hash = sha256(JSON.stringify(row));
  return db.insert('financial_audit_logs', row);
}

/** Verify the hash chain; returns { ok, brokenAt } */
function verifyChain() {
  let prev = null;
  for (const r of db.all('SELECT * FROM financial_audit_logs ORDER BY id')) {
    const { id, hash, ...rest } = r;
    if (rest.prev_hash !== prev) return { ok: false, brokenAt: id };
    const expected = sha256(JSON.stringify({
      actor_user_id: rest.actor_user_id, actor_role: rest.actor_role, action: rest.action, entity_type: rest.entity_type,
      entity_id: rest.entity_id, before_json: rest.before_json, after_json: rest.after_json, reason: rest.reason, ip: rest.ip,
      prev_hash: rest.prev_hash, created_at: rest.created_at,
    }));
    if (expected !== hash) return { ok: false, brokenAt: id };
    prev = hash;
  }
  return { ok: true };
}

module.exports = { log, verifyChain };
