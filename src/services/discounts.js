'use strict';
const db = require('../db');
const clock = require('../lib/clock');
const audit = require('../lib/audit');
const { bad, notFound, conflict, pct, parseJSON, randomCode } = require('../lib/util');

/**
 * Validate a discount code for a purchase context and return the discount amount.
 * ctx: { accountId, audience, planId, frequency, purpose: 'subscription'|'promotion', amount }
 */
function evaluate(code, ctx) {
  const d = db.one('SELECT * FROM discount_codes WHERE code = ? COLLATE NOCASE', String(code || '').trim());
  if (!d || d.status !== 'active') throw bad('This discount code is not valid');
  const now = clock.iso();
  if (d.valid_from && now < d.valid_from) throw bad('This discount code is not active yet');
  if (d.valid_until && now > d.valid_until) throw bad('This discount code has expired');
  if (d.applies_to !== 'any' && d.applies_to !== ctx.purpose) throw bad(`This code cannot be used for ${ctx.purpose} purchases`);
  if (d.audience && d.audience !== ctx.audience) throw bad('This code is not available for your account type');
  if (d.restricted_account_id && d.restricted_account_id !== ctx.accountId) throw bad('This code belongs to another account');
  const plans = parseJSON(d.plan_ids_json, null);
  if (plans && ctx.planId && !plans.includes(ctx.planId)) throw bad('This code does not apply to the selected plan');
  const freqs = parseJSON(d.frequencies_json, null);
  if (freqs && ctx.frequency && !freqs.includes(ctx.frequency)) throw bad(`This code only applies to ${freqs.join('/')} billing`);
  if (d.region) {
    const acct = db.one('SELECT region FROM accounts WHERE id = ?', ctx.accountId);
    if (acct.region !== d.region) throw bad('This code is not available in your region');
  }
  const used = db.one("SELECT COUNT(*) c FROM discount_redemptions WHERE discount_code_id = ? AND status != 'released'", d.id).c;
  if (d.max_redemptions != null && used >= d.max_redemptions) throw bad('This code has reached its redemption limit');
  const mine = db.one("SELECT COUNT(DISTINCT COALESCE(subscription_id, invoice_id)) c FROM discount_redemptions WHERE discount_code_id = ? AND account_id = ? AND status != 'released'", d.id, ctx.accountId).c;
  if (mine >= d.per_account_limit) throw bad('You have already used this code');
  if (d.new_customers_only) {
    const paid = db.one("SELECT COUNT(*) c FROM invoices WHERE account_id = ? AND status IN ('paid','partially_refunded') AND total_paise > 0", ctx.accountId).c;
    if (paid > 0) throw bad('This code is only for new customers');
  }
  const amount = d.discount_type === 'percent' ? pct(ctx.amount, d.value) : Math.min(d.value, ctx.amount);
  return { code: d, amount: Math.min(amount, ctx.amount) };
}

/** Discount amount for subsequent cycles (duration_cycles > 1) without re-validating usage limits. */
function amountFor(codeId, amount) {
  const d = db.one('SELECT * FROM discount_codes WHERE id = ?', codeId);
  if (!d) return 0;
  return Math.min(amount, d.discount_type === 'percent' ? pct(amount, d.value) : d.value);
}

function reserve(codeId, accountId, invoiceId, subscriptionId, amount) {
  db.insert('discount_redemptions', { discount_code_id: codeId, account_id: accountId, invoice_id: invoiceId, subscription_id: subscriptionId, amount_paise: amount, status: 'reserved', created_at: clock.iso() });
}

const FIELDS = ['code', 'description', 'discount_type', 'value', 'applies_to', 'audience', 'plan_ids_json', 'frequencies_json', 'region', 'duration_cycles', 'max_redemptions', 'per_account_limit', 'new_customers_only', 'valid_from', 'valid_until', 'status'];

function create(actor, body) {
  const row = {};
  for (const f of FIELDS) if (body[f] !== undefined) row[f] = body[f];
  if (body.plan_ids) row.plan_ids_json = body.plan_ids;
  if (body.frequencies) row.frequencies_json = body.frequencies;
  row.code = String(row.code || randomCode(8)).toUpperCase();
  if (!['percent', 'fixed'].includes(row.discount_type)) throw bad('discount_type must be percent or fixed');
  if (!(Number(row.value) > 0)) throw bad('value must be positive (bps for percent, paise for fixed)');
  if (row.discount_type === 'percent' && row.value > 10000) throw bad('percent discount cannot exceed 100% (10000 bps)');
  if (db.one('SELECT 1 FROM discount_codes WHERE code = ? COLLATE NOCASE', row.code)) throw conflict('Code already exists');
  return db.tx(() => {
    const id = db.insert('discount_codes', { ...row, created_by: actor.userId ?? null, source: body.source || 'admin', restricted_account_id: body.restricted_account_id ?? null, created_at: clock.iso() });
    audit.log(actor, 'discount.created', 'discount_code', id, { after: row });
    return db.one('SELECT * FROM discount_codes WHERE id = ?', id);
  });
}

function update(actor, id, body) {
  const d = db.one('SELECT * FROM discount_codes WHERE id = ?', id);
  if (!d) throw notFound('Discount code');
  const patch = {};
  for (const f of FIELDS) if (body[f] !== undefined && f !== 'code') patch[f] = body[f];
  if (body.plan_ids !== undefined) patch.plan_ids_json = body.plan_ids;
  if (body.frequencies !== undefined) patch.frequencies_json = body.frequencies;
  return db.tx(() => {
    db.update('discount_codes', id, patch);
    audit.log(actor, 'discount.updated', 'discount_code', id, { before: d, after: patch });
    return db.one('SELECT * FROM discount_codes WHERE id = ?', id);
  });
}

function list() {
  return db.all(`SELECT d.*, (SELECT COUNT(*) FROM discount_redemptions r WHERE r.discount_code_id = d.id AND r.status = 'applied') redemptions,
    (SELECT COALESCE(SUM(amount_paise),0) FROM discount_redemptions r WHERE r.discount_code_id = d.id AND r.status = 'applied') total_discount_paise
    FROM discount_codes d ORDER BY d.id DESC`);
}

module.exports = { evaluate, amountFor, reserve, create, update, list };
