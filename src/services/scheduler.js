'use strict';
/** Periodic billing & marketplace jobs. Every job is idempotent. */
const db = require('../db');
const clock = require('../lib/clock');
const settings = require('../lib/settings');
const subscriptions = require('./subscriptions');
const promotions = require('./promotions');
const advertising = require('./advertising');
const commissions = require('./commissions');

let last = null;
function runAll({ forceCommissionInvoicing = false } = {}) {
  const out = { at: clock.iso() };
  out.subscriptions = subscriptions.runLifecycle();
  out.promotions_expired = promotions.expire();
  out.ads = advertising.lifecycle();
  // non-subscription invoices past due → overdue
  out.overdue = Number(db.run("UPDATE invoices SET status = 'overdue' WHERE status = 'issued' AND invoice_type IN ('commission','procurement','advertising') AND due_at < ?", clock.iso()).changes);
  const cfg = settings.get('commissions');
  const today = clock.now().getUTCDate();
  const key = clock.iso().slice(0, 7);
  if (forceCommissionInvoicing || (today === cfg.invoice_day_of_month && db.one("SELECT 1 FROM platform_settings WHERE key = 'commissions'") && last !== key)) {
    out.commission_invoices = commissions.invoiceOutstanding();
    last = key;
  }
  return out;
}

function start(intervalMs = 5 * 60 * 1000) {
  const t = setInterval(() => { try { runAll(); } catch (e) { console.error('[scheduler]', e); } }, intervalMs);
  t.unref();
  return t;
}
module.exports = { runAll, start };
