'use strict';
const crypto = require('node:crypto');
const db = require('../db');
const clock = require('./clock');
const { AppError, forbidden, sha256, randomToken } = require('./util');

function hashPassword(pw) {
  if (!pw || String(pw).length < 8) throw new AppError(400, 'bad_request', 'Password must be at least 8 characters');
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt) return false;
  const a = crypto.scryptSync(String(pw), salt, 64);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function issueSession(userId) {
  const token = randomToken(32);
  db.insert('sessions', { token_hash: sha256(token), user_id: userId, expires_at: new Date(clock.now().getTime() + 30 * 86400000).toISOString(), created_at: clock.iso() });
  return token;
}

/**
 * Role-based permissions. The platform owner holds every permission; administrators run operations
 * but cannot change pricing/monetisation, view the revenue dashboards, or authorise refunds.
 */
const PERMISSIONS = {
  owner: ['*'],
  admin: ['admin.access', 'users.view', 'users.manage', 'orders.manage', 'ads.review', 'procurement.manage', 'logistics.manage', 'payments.view', 'billing.view', 'refunds.request', 'disputes.manage', 'payments.reconcile', 'finance.export', 'risk.view', 'plans.view', 'enterprise.view', 'jobs.run'],
};
const can = (user, perm) => { const p = PERMISSIONS[user.role] || []; return p.includes('*') || p.includes(perm); };

function authenticate(req, _res, next) {
  const hdr = req.get('authorization') || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  if (token) {
    const s = db.one('SELECT s.user_id, s.expires_at, u.*, a.type account_type, a.status account_status FROM sessions s JOIN users u ON u.id = s.user_id JOIN accounts a ON a.id = u.account_id WHERE s.token_hash = ?', sha256(token));
    if (s && s.expires_at > clock.iso() && s.status === 'active' && s.account_status !== 'closed') {
      // sliding 30-day expiry (refreshed at most daily)
      if (new Date(s.expires_at) - clock.now() < 29 * 86400000) db.run('UPDATE sessions SET expires_at = ? WHERE token_hash = ?', new Date(clock.now().getTime() + 30 * 86400000).toISOString(), sha256(token));
      req.user = { id: s.id, userId: s.id, accountId: s.account_id, role: s.role, accountRole: s.account_role, accountType: s.account_type, email: s.email, name: s.name, ip: req.ip };
    }
  }
  next();
}
const requireAuth = (req, _res, next) => (req.user ? next() : next(new AppError(401, 'unauthenticated', 'Please sign in')));
const requireRole = (...roles) => (req, _res, next) => (req.user && roles.includes(req.user.role) ? next() : next(forbidden()));
const requirePerm = (perm) => (req, _res, next) => (req.user && can(req.user, perm) ? next() : next(forbidden('You do not have permission for this action')));
/** Billing & subscription changes need the account owner or a manager (not staff). */
const requireBillingRole = (req, _res, next) => (req.user && ['owner', 'manager'].includes(req.user.accountRole) ? next() : next(forbidden('Only the account owner or a manager can manage billing')));
const actor = (req) => ({ userId: req.user.id, role: req.user.role, ip: req.ip });

module.exports = { hashPassword, verifyPassword, issueSession, authenticate, requireAuth, requireRole, requirePerm, requireBillingRole, can, actor, PERMISSIONS };
