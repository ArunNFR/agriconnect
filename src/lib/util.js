'use strict';
const crypto = require('node:crypto');

class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status; this.code = code; this.details = details;
  }
}
const bad = (msg, details) => new AppError(400, 'bad_request', msg, details);
const notFound = (what = 'Resource') => new AppError(404, 'not_found', `${what} not found`);
const forbidden = (msg = 'Forbidden') => new AppError(403, 'forbidden', msg);
const conflict = (msg, details) => new AppError(409, 'conflict', msg, details);

/** 402-style error that the UI turns into an upgrade prompt. */
function upgradeRequired(key, message, details = {}) {
  return new AppError(402, 'upgrade_required', message, { entitlement: key, ...details });
}

function addMonths(iso, months) {
  const d = new Date(iso);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString();
}
const addDays = (iso, days) => new Date(new Date(iso).getTime() + days * 86400000).toISOString();
const addHours = (iso, h) => new Date(new Date(iso).getTime() + h * 3600000).toISOString();

/** basis-point percentage of paise amount, rounded half-up */
const pct = (amountPaise, bps) => Math.round((amountPaise * bps) / 10000);
const rupees = (paise) => '₹' + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = (n = 32) => crypto.randomBytes(n).toString('hex');
const randomCode = (len = 8) => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(len);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
};
const parseJSON = (s, fallback = null) => { if (s == null) return fallback; try { return JSON.parse(s); } catch { return fallback; } };

function req(obj, fields) {
  const missing = fields.filter((f) => obj[f] === undefined || obj[f] === null || obj[f] === '');
  if (missing.length) throw bad(`Missing required field(s): ${missing.join(', ')}`);
}
const int = (v, name) => {
  const n = Number(v);
  if (!Number.isInteger(n)) throw bad(`${name} must be an integer`);
  return n;
};

module.exports = { AppError, bad, notFound, forbidden, conflict, upgradeRequired, addMonths, addDays, addHours, pct, rupees, sha256, randomToken, randomCode, parseJSON, req, int };
