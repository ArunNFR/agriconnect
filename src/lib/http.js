'use strict';
const db = require('../db');
const clock = require('./clock');
const { AppError, sha256 } = require('./util');

const h = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res)).then((out) => { if (out !== undefined && !res.headersSent) res.json(out); }).catch(next);

/**
 * Idempotency for money-moving POSTs. Same key + same body → replayed response; same key + different body → 409.
 */
function idempotent(fn) {
  return h(async (req, res) => {
    const key = req.get('idempotency-key');
    if (!key || !req.user) return fn(req, res);
    const endpoint = `${req.method} ${req.baseUrl}${req.route.path}:${JSON.stringify(req.params)}`;
    const hash = sha256(JSON.stringify(req.body || {}));
    const prior = db.one('SELECT * FROM idempotency_keys WHERE key = ? AND account_id = ? AND endpoint = ?', key, req.user.accountId, endpoint);
    if (prior) {
      if (prior.request_hash !== hash) throw new AppError(409, 'idempotency_conflict', 'This Idempotency-Key was already used with a different request');
      if (prior.response_json == null) throw new AppError(409, 'in_progress', 'A request with this Idempotency-Key is still being processed');
      res.status(prior.status_code).set('Idempotent-Replay', 'true');
      return JSON.parse(prior.response_json);
    }
    db.insert('idempotency_keys', { key, account_id: req.user.accountId, endpoint, request_hash: hash, created_at: clock.iso() });
    try {
      const out = await fn(req, res);
      db.run('UPDATE idempotency_keys SET status_code = ?, response_json = ? WHERE key = ? AND account_id = ? AND endpoint = ?', res.statusCode || 200, JSON.stringify(out ?? null), key, req.user.accountId, endpoint);
      return out;
    } catch (e) {
      // failed requests may be retried with the same key
      db.run('DELETE FROM idempotency_keys WHERE key = ? AND account_id = ? AND endpoint = ?', key, req.user.accountId, endpoint);
      throw e;
    }
  });
}

function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'bad_json', message: 'Invalid JSON body' } });
  if (/financial records cannot be deleted|append-only|immutable/.test(err.message)) return res.status(409).json({ error: { code: 'financial_control', message: err.message } });
  console.error(err);
  res.status(500).json({ error: { code: 'internal', message: 'Something went wrong' } });
}

module.exports = { h, idempotent, errorHandler };
