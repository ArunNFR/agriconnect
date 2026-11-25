'use strict';
/**
 * Invoices, revenue recognition, refunds and reconciliation.
 * Modules (subscriptions, promotions, procurement, ads...) register fulfilment hooks per invoice type
 * so that an invoice is only fulfilled after a verified payment.
 */
const db = require('../db');
const clock = require('../lib/clock');
const audit = require('../lib/audit');
const settings = require('../lib/settings');
const { notify } = require('../lib/notify');
const { bad, notFound, conflict, pct, rupees } = require('../lib/util');

const hooks = { paid: {}, failed: {}, voided: {} };
const on = (event, type, fn) => { hooks[event][type] = fn; };

function nextInvoiceNumber() {
  const d = clock.now();
  const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1; // Indian FY Apr–Mar
  const fy = `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
  db.run('INSERT INTO invoice_sequences (fy, last_number) VALUES (?, 1) ON CONFLICT(fy) DO UPDATE SET last_number = last_number + 1', fy);
  const n = db.one('SELECT last_number FROM invoice_sequences WHERE fy = ?', fy).last_number;
  return `AC/${fy}/${String(n).padStart(6, '0')}`;
}

/**
 * Create an issued invoice.
 * items: [{ description, item_type, quantity?, unit_amount_paise, related_type?, related_id? }]
 * Negative unit amounts are reductions (discounts, proration credit, account credit).
 * GST/tax (configurable) is applied to the net taxable value.
 */
function createInvoice({ accountId, type, items, subscriptionId = null, billingCycleId = null, relatedType = null, relatedId = null, dueAt = null, notes = null, actor = 'system', applyAccountCredit = true }) {
  return db.tx(() => {
    const acct = db.one('SELECT * FROM accounts WHERE id = ?', accountId);
    if (!acct) throw notFound('Account');
    const tax = settings.get('tax');
    const lines = items.map((i) => ({ quantity: 1, ...i, amount_paise: Math.round((i.quantity ?? 1) * i.unit_amount_paise) }));
    let subtotal = lines.filter((l) => l.amount_paise > 0).reduce((s, l) => s + l.amount_paise, 0);
    let discount = -lines.filter((l) => l.amount_paise < 0).reduce((s, l) => s + l.amount_paise, 0);
    if (discount > subtotal) discount = subtotal;
    let credit = 0;
    if (applyAccountCredit && type !== 'commission') {
      const bal = accountCreditBalance(accountId);
      credit = Math.min(bal, subtotal - discount);
    }
    const taxable = subtotal - discount - credit;
    const taxPaise = pct(taxable, tax.rate_bps);
    const total = taxable + taxPaise;
    const now = clock.iso();
    const id = db.insert('invoices', {
      invoice_number: nextInvoiceNumber(), account_id: accountId, invoice_type: type, status: 'issued',
      subscription_id: subscriptionId, billing_cycle_id: billingCycleId, related_type: relatedType, related_id: relatedId,
      subtotal_paise: subtotal, discount_paise: discount, credit_applied_paise: credit, tax_paise: taxPaise, total_paise: total,
      tax_rate_bps: tax.rate_bps, billing_name: acct.name, billing_gstin: acct.gstin, billing_address: [acct.address, acct.city, acct.region].filter(Boolean).join(', '),
      due_at: dueAt || now, issued_at: now, notes,
    });
    for (const l of lines) db.insert('invoice_items', { invoice_id: id, description: l.description, item_type: l.item_type, quantity: l.quantity, unit_amount_paise: l.unit_amount_paise, amount_paise: l.amount_paise, related_type: l.related_type, related_id: l.related_id });
    if (credit > 0) {
      db.insert('invoice_items', { invoice_id: id, description: 'Account credit applied', item_type: 'credit', quantity: 1, unit_amount_paise: -credit, amount_paise: -credit });
      db.insert('credit_ledger', { account_id: accountId, credit_type: 'account', amount: -credit, reason: 'Applied to invoice', related_type: 'invoice', related_id: id, created_at: now });
    }
    audit.log(actor, 'invoice.issued', 'invoice', id, { after: { type, total, subtotal, discount, credit, tax: taxPaise } });
    return getInvoice(id);
  });
}

function getInvoice(id) {
  const inv = db.one('SELECT * FROM invoices WHERE id = ?', id);
  if (!inv) throw notFound('Invoice');
  inv.items = db.all('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id', id);
  inv.payments = db.all('SELECT id, provider, provider_payment_id, amount_paise, status, method, captured_at, amount_refunded_paise FROM payments WHERE invoice_id = ? ORDER BY id', id);
  inv.refunds = db.all('SELECT id, amount_paise, status, reason, created_at, processed_at FROM refunds WHERE invoice_id = ? ORDER BY id', id);
  inv.balance_due_paise = ['issued', 'overdue'].includes(inv.status) ? inv.total_paise - inv.amount_paid_paise : 0;
  return inv;
}

function accountCreditBalance(accountId) {
  return db.one("SELECT COALESCE(SUM(amount),0) b FROM credit_ledger WHERE account_id = ? AND credit_type = 'account' AND (expires_at IS NULL OR expires_at > ?)", accountId, clock.iso()).b;
}

const SUB_CATEGORY = (inv) => {
  const sub = inv.subscription_id ? db.one('SELECT s.is_custom_contract, p.audience, p.is_enterprise, p.id plan_id FROM subscriptions s JOIN subscription_plans p ON p.id = s.plan_id WHERE s.id = ?', inv.subscription_id) : null;
  if (!sub) return { category: 'other' };
  // attribute to the plan actually invoiced (differs from the subscription's plan for scheduled plan changes)
  const item = db.one("SELECT related_id FROM invoice_items WHERE invoice_id = ? AND item_type = 'plan' AND related_type = 'plan' LIMIT 1", inv.id);
  const plan = item ? db.one('SELECT id, audience, is_enterprise FROM subscription_plans WHERE id = ?', item.related_id) : null;
  const planId = plan ? plan.id : sub.plan_id;
  if (sub.is_custom_contract || (plan ? plan.is_enterprise : sub.is_enterprise)) return { category: 'enterprise_subscription', plan_id: planId };
  return { category: sub.audience === 'farmer' ? 'farmer_subscription' : 'buyer_subscription', plan_id: planId };
};

/** Revenue category for a paid invoice (null = revenue already recognised on accrual). */
function revenueCategory(inv) {
  switch (inv.invoice_type) {
    case 'subscription': return SUB_CATEGORY(inv);
    case 'promotion': {
      const pp = inv.related_id ? db.one('SELECT p.promotion_type FROM promotion_purchases pp JOIN promotions p ON p.id = pp.promotion_id WHERE pp.id = ?', inv.related_id) : null;
      return { category: pp && ['featured', 'homepage'].includes(pp.promotion_type) ? 'featured_listing' : 'promoted_inventory' };
    }
    case 'procurement': return { category: 'procurement_service' };
    case 'advertising': return { category: 'advertising' };
    case 'commission': case 'logistics': return null; // recognised when the order/delivery completed
    default: return { category: 'other' };
  }
}

function recordRevenue({ category, entryType = 'revenue', amount, tax = 0, accountId, planId = null, sourceType, sourceId, paymentId = null, invoiceId = null, orderId = null, notes = null, actor = null, recognisedAt }) {
  const acct = accountId ? db.one('SELECT type, region FROM accounts WHERE id = ?', accountId) : null;
  return db.insert('revenue_records', {
    category, entry_type: entryType, amount_paise: amount, tax_paise: tax, account_id: accountId, account_type: acct?.type, region: acct?.region,
    plan_id: planId, source_type: sourceType, source_id: sourceId, payment_id: paymentId, invoice_id: invoiceId, order_id: orderId,
    recognised_at: recognisedAt || clock.iso(), notes, created_by: actor?.userId ?? null, created_at: clock.iso(),
  });
}

/** Called only from verified payment processing. Marks invoice paid, books revenue, fulfils. */
function settleInvoice(invoiceId, payment) {
  const inv = db.one('SELECT * FROM invoices WHERE id = ?', invoiceId);
  const now = clock.iso();
  db.update('invoices', invoiceId, { status: 'paid', amount_paid_paise: inv.amount_paid_paise + (payment ? payment.amount_paise : 0), paid_at: now });
  db.run("UPDATE discount_redemptions SET status = 'applied' WHERE invoice_id = ? AND status = 'reserved'", invoiceId);
  if (inv.billing_cycle_id) db.update('billing_cycles', inv.billing_cycle_id, { status: 'paid' });
  const rc = revenueCategory(inv);
  if (rc && inv.total_paise > 0) {
    recordRevenue({ category: rc.category, amount: inv.total_paise - inv.tax_paise, tax: inv.tax_paise, accountId: inv.account_id, planId: rc.plan_id, sourceType: 'invoice', sourceId: inv.id, paymentId: payment?.id, invoiceId: inv.id });
  }
  if (inv.invoice_type === 'commission') db.run("UPDATE transaction_commissions SET status = 'invoiced' WHERE invoice_id = ?", inv.id);
  audit.log(payment ? 'provider' : 'system', 'invoice.paid', 'invoice', inv.id, { before: { status: inv.status }, after: { status: 'paid', payment_id: payment?.id } });
  const hook = hooks.paid[inv.invoice_type];
  if (hook) hook(db.one('SELECT * FROM invoices WHERE id = ?', invoiceId), payment);
}

/** Zero-value invoices (100% discount / credits) settle without a payment. */
function settleZeroInvoice(invoice) {
  if (invoice.total_paise !== 0) throw bad('Invoice has a balance and requires payment');
  db.tx(() => settleInvoice(invoice.id, null));
  return getInvoice(invoice.id);
}

function voidInvoice(invoiceId, actor, reason) {
  return db.tx(() => {
    const inv = db.one('SELECT * FROM invoices WHERE id = ?', invoiceId);
    if (!inv) throw notFound('Invoice');
    if (!['issued', 'overdue'].includes(inv.status)) throw conflict(`Invoice is ${inv.status} and cannot be voided`);
    if (inv.amount_paid_paise > 0) throw conflict('Invoice has payments; issue a refund instead');
    db.update('invoices', invoiceId, { status: 'void', voided_at: clock.iso() });
    db.run("UPDATE discount_redemptions SET status = 'released' WHERE invoice_id = ? AND status = 'reserved'", invoiceId);
    if (inv.credit_applied_paise > 0) db.insert('credit_ledger', { account_id: inv.account_id, credit_type: 'account', amount: inv.credit_applied_paise, reason: 'Credit restored from voided invoice', related_type: 'invoice', related_id: invoiceId, created_at: clock.iso() });
    if (inv.billing_cycle_id) db.update('billing_cycles', inv.billing_cycle_id, { status: 'void' });
    if (inv.invoice_type === 'commission') db.run("UPDATE transaction_commissions SET status = 'recognised', invoice_id = NULL WHERE invoice_id = ?", invoiceId);
    db.run("UPDATE payments SET status = 'cancelled', updated_at = ? WHERE invoice_id = ? AND status = 'created'", clock.iso(), invoiceId);
    audit.log(actor, 'invoice.voided', 'invoice', invoiceId, { before: { status: inv.status }, after: { status: 'void' }, reason });
    const hook = hooks.voided[inv.invoice_type];
    if (hook) hook(inv);
  });
}

function invoiceFailed(invoiceId, payment, reason) {
  const inv = db.one('SELECT * FROM invoices WHERE id = ?', invoiceId);
  const hook = hooks.failed[inv.invoice_type];
  if (hook) hook(inv, payment, reason);
}

// ---------------------------------------------------------------- refunds
function refundable(payment) { return payment.amount_paise - payment.amount_refunded_paise - db.one("SELECT COALESCE(SUM(amount_paise),0) s FROM refunds WHERE payment_id = ? AND status IN ('requested','approved','processing')", payment.id).s; }

function requestRefund(actor, paymentId, amount, reason) {
  return db.tx(() => {
    const p = db.one('SELECT * FROM payments WHERE id = ?', paymentId);
    if (!p) throw notFound('Payment');
    if (!['captured', 'partially_refunded'].includes(p.status)) throw conflict(`Payment is ${p.status}; only captured payments can be refunded`);
    const amt = amount == null ? refundable(p) : Number(amount);
    if (!Number.isInteger(amt) || amt <= 0) throw bad('Refund amount must be a positive number of paise');
    if (amt > refundable(p)) throw bad(`Refund exceeds refundable amount ${rupees(refundable(p))}`);
    if (!reason) throw bad('A refund reason is required');
    const now = clock.iso();
    const id = db.insert('refunds', { payment_id: p.id, invoice_id: p.invoice_id, account_id: p.account_id, amount_paise: amt, reason, status: 'requested', requested_by: actor.userId ?? null, created_at: now, updated_at: now });
    audit.log(actor, 'refund.requested', 'refund', id, { after: { payment_id: p.id, amount: amt }, reason });
    return db.one('SELECT * FROM refunds WHERE id = ?', id);
  });
}

/** Owner-level authorisation, then the provider refund call. */
async function decideRefund(actor, refundId, approve, notes, provider) {
  const r = db.one('SELECT * FROM refunds WHERE id = ?', refundId);
  if (!r) throw notFound('Refund');
  if (r.status !== 'requested') throw conflict(`Refund is already ${r.status}`);
  if (settings.get('refunds').require_separate_approver && actor.userId && r.requested_by === actor.userId) throw bad('Refunds must be approved by a different person than the requester (four-eyes rule)');
  if (!approve) {
    db.tx(() => { db.update('refunds', r.id, { status: 'rejected', approved_by: actor.userId, decision_notes: notes, updated_at: clock.iso() }); audit.log(actor, 'refund.rejected', 'refund', r.id, { reason: notes }); });
    return db.one('SELECT * FROM refunds WHERE id = ?', r.id);
  }
  db.tx(() => { db.update('refunds', r.id, { status: 'processing', approved_by: actor.userId, decision_notes: notes, updated_at: clock.iso() }); audit.log(actor, 'refund.approved', 'refund', r.id, { reason: notes }); });
  const p = db.one('SELECT * FROM payments WHERE id = ?', r.payment_id);
  try {
    const res = await provider.refund(p.provider_payment_id, { amount: r.amount_paise, notes: { refund_id: String(r.id), reason: r.reason } });
    db.update('refunds', r.id, { provider_refund_id: res.id, updated_at: clock.iso() });
    if (res.status === 'processed') finaliseRefund(r.id, 'provider');
  } catch (e) {
    db.tx(() => { db.update('refunds', r.id, { status: 'failed', decision_notes: `${notes || ''} | provider: ${e.message}`, updated_at: clock.iso() }); audit.log('provider', 'refund.failed', 'refund', r.id, { reason: e.message }); });
    throw e;
  }
  return db.one('SELECT * FROM refunds WHERE id = ?', r.id);
}

function finaliseRefund(refundId, actor = 'provider') {
  db.tx(() => {
    const r = db.one('SELECT * FROM refunds WHERE id = ?', refundId);
    if (r.status === 'processed') return;
    const now = clock.iso();
    db.update('refunds', r.id, { status: 'processed', processed_at: now, updated_at: now });
    const p = db.one('SELECT * FROM payments WHERE id = ?', r.payment_id);
    const refunded = p.amount_refunded_paise + r.amount_paise;
    db.update('payments', p.id, { amount_refunded_paise: refunded, status: refunded >= p.amount_paise ? 'refunded' : 'partially_refunded', updated_at: now });
    const inv = db.one('SELECT * FROM invoices WHERE id = ?', r.invoice_id);
    const invRefunded = inv.amount_refunded_paise + r.amount_paise;
    db.update('invoices', inv.id, { amount_refunded_paise: invRefunded, status: invRefunded >= inv.total_paise ? 'refunded' : 'partially_refunded' });
    // Reverse revenue proportionally (net of tax)
    const original = db.one("SELECT * FROM revenue_records WHERE invoice_id = ? AND entry_type = 'revenue' ORDER BY id LIMIT 1", inv.id);
    if (original && inv.total_paise > 0) {
      const share = r.amount_paise / inv.total_paise;
      recordRevenue({ category: original.category, entryType: 'reversal', amount: -Math.round(original.amount_paise * share), tax: -Math.round(original.tax_paise * share), accountId: inv.account_id, planId: original.plan_id, sourceType: 'refund', sourceId: r.id, paymentId: p.id, invoiceId: inv.id, notes: r.reason });
    }
    audit.log(actor, 'refund.processed', 'refund', r.id, { after: { amount: r.amount_paise, payment_status: refunded >= p.amount_paise ? 'refunded' : 'partially_refunded' } });
    notify(inv.account_id, 'refund_processed', 'Refund processed', `A refund of ${rupees(r.amount_paise)} for invoice ${inv.invoice_number} has been processed to your original payment method.`, { refund_id: r.id, invoice_id: inv.id });
  });
}

/** Manual revenue adjustment — owner only, always audited, never edits existing rows. */
function adjustRevenue(actor, { category, amount_paise, reason, account_id }) {
  if (!reason) throw bad('Adjustment reason is required');
  return db.tx(() => {
    const id = recordRevenue({ category, entryType: 'adjustment', amount: Number(amount_paise), accountId: account_id || null, sourceType: 'manual_adjustment', sourceId: null, notes: reason, actor });
    audit.log(actor, 'revenue.adjustment', 'revenue_record', id, { after: { category, amount_paise }, reason });
    return db.one('SELECT * FROM revenue_records WHERE id = ?', id);
  });
}

module.exports = { on, hooks, createInvoice, getInvoice, settleInvoice, settleZeroInvoice, voidInvoice, invoiceFailed, requestRefund, decideRefund, finaliseRefund, refundable, recordRevenue, adjustRevenue, accountCreditBalance, nextInvoiceNumber };
