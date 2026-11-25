'use strict';
/**
 * Payment orchestration. A paid invoice is ONLY settled after server-side verification:
 *  - checkout callback: HMAC signature check + fetching the payment from the provider API, or
 *  - webhook: HMAC-validated provider event (deduplicated by event id).
 * Both paths converge on capture(), which is idempotent and protects against duplicate payments.
 */
const db = require('../db');
const clock = require('../lib/clock');
const audit = require('../lib/audit');
const settings = require('../lib/settings');
const { notify, notifyPlatform } = require('../lib/notify');
const providers = require('../payments');
const billing = require('./billing');
const { bad, notFound, conflict, forbidden, AppError, rupees, parseJSON } = require('../lib/util');

function flagRisk(accountId, type, severity, details) {
  db.insert('risk_flags', { account_id: accountId, flag_type: type, severity, details_json: details, created_at: clock.iso() });
}

/** Create (or reuse) a provider order for an invoice and return checkout options. */
async function startCheckout(accountId, invoiceId, { idempotencyKey } = {}) {
  const inv = db.one('SELECT * FROM invoices WHERE id = ?', invoiceId);
  if (!inv || inv.account_id !== accountId) throw notFound('Invoice');
  if (!['issued', 'overdue'].includes(inv.status)) throw conflict(`Invoice is ${inv.status}`);
  const due = inv.total_paise - inv.amount_paid_paise;
  if (due <= 0) throw conflict('Invoice has no balance due');
  const provider = providers.get();
  if (!provider.isConfigured()) throw new AppError(503, 'payments_unavailable', 'Online payments are not configured on this server yet. Please contact support to complete payment.');

  // Duplicate protection: reuse an open order for the same invoice and amount
  let pay = db.one("SELECT * FROM payments WHERE invoice_id = ? AND status IN ('created','failed') AND amount_paise = ? AND provider = ? ORDER BY id DESC LIMIT 1", inv.id, due, provider.name);
  if (pay && new Date(pay.created_at) < new Date(clock.now().getTime() - 12 * 3600000)) pay = null; // provider orders go stale
  if (!pay) {
    const order = await provider.createOrder({ amount: due, currency: inv.currency, receipt: inv.invoice_number, notes: { invoice_id: String(inv.id), account_id: String(accountId), invoice_type: inv.invoice_type } });
    if (order.amount !== due) throw new AppError(502, 'provider_error', 'Provider order amount mismatch');
    const now = clock.iso();
    const id = db.insert('payments', { account_id: accountId, invoice_id: inv.id, provider: provider.name, provider_order_id: order.id, amount_paise: due, currency: inv.currency, status: 'created', idempotency_key: idempotencyKey || null, created_at: now, updated_at: now });
    pay = db.one('SELECT * FROM payments WHERE id = ?', id);
    audit.log({ role: 'user' }, 'payment.order_created', 'payment', id, { after: { provider_order_id: order.id, amount: due, invoice_id: inv.id } });
  }
  const acct = db.one('SELECT * FROM accounts WHERE id = ?', accountId);
  const user = db.one("SELECT name, email, phone FROM users WHERE account_id = ? AND account_role = 'owner' ORDER BY id LIMIT 1", accountId);
  const pm = db.one("SELECT method_type FROM payment_methods WHERE account_id = ? AND is_default = 1 AND status = 'active'", accountId);
  return {
    provider: provider.name,
    payment_id: pay.id,
    checkout: {
      key: provider.publicKey(), order_id: pay.provider_order_id, amount: pay.amount_paise, currency: pay.currency,
      name: 'AgriConnect', description: `Invoice ${inv.invoice_number}`,
      prefill: { name: user?.name || acct.name, email: user?.email, contact: user?.phone || acct.phone, ...(pm ? { method: pm.method_type } : {}) },
      notes: { invoice_id: String(inv.id) },
    },
    invoice: billing.getInvoice(inv.id),
  };
}

/** Handle the browser callback. Signature AND provider API state must agree before capture. */
async function verifyCallback(accountId, { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature }) {
  if (!orderId || !paymentId || !signature) throw bad('order id, payment id and signature are required');
  const pay = db.one('SELECT * FROM payments WHERE provider_order_id = ?', orderId);
  if (!pay) throw notFound('Payment');
  if (pay.account_id !== accountId) throw forbidden();
  const provider = providers.get(pay.provider);
  if (!provider.verifyPaymentSignature(orderId, paymentId, signature)) {
    db.insert('payment_attempts', { payment_id: pay.id, provider_payment_id: paymentId, status: 'signature_invalid', source: 'client_callback', created_at: clock.iso() });
    flagRisk(accountId, 'invalid_payment_signature', 'high', { order_id: orderId, payment_id: paymentId });
    audit.log({ role: 'user' }, 'payment.signature_invalid', 'payment', pay.id, { after: { provider_payment_id: paymentId } });
    throw new AppError(400, 'verification_failed', 'Payment verification failed. If money was debited it will be reconciled automatically.');
  }
  const remote = provider.normalisePayment(await provider.fetchPayment(paymentId));
  if (remote.orderId !== orderId) throw new AppError(400, 'verification_failed', 'Payment does not belong to this order');
  if (remote.status === 'captured') return capture(pay.id, remote, 'signature+api');
  if (remote.status === 'failed') { recordFailure(pay.id, remote, 'api_fetch'); return { status: 'failed', invoice: billing.getInvoice(pay.invoice_id) }; }
  db.insert('payment_attempts', { payment_id: pay.id, provider_payment_id: paymentId, status: remote.status, method: remote.method, source: 'client_callback', created_at: clock.iso() });
  if (remote.status === 'authorized') db.update('payments', pay.id, { status: 'authorized', updated_at: clock.iso() });
  return { status: 'processing', message: 'Payment is being confirmed by the bank. Your subscription will activate as soon as it is captured.', invoice: billing.getInvoice(pay.invoice_id) };
}

/** Idempotent capture of a verified provider payment. */
function capture(paymentRowId, remote, via) {
  return db.tx(() => {
    const pay = db.one('SELECT * FROM payments WHERE id = ?', paymentRowId);
    if (['captured', 'refunded', 'partially_refunded'].includes(pay.status)) {
      if (pay.provider_payment_id === remote.id) return { status: 'captured', duplicate_event: true, invoice: billing.getInvoice(pay.invoice_id) };
    }
    if (remote.amount !== pay.amount_paise || (remote.currency && remote.currency !== pay.currency)) {
      flagRisk(pay.account_id, 'amount_mismatch', 'high', { expected: pay.amount_paise, received: remote.amount, payment_id: remote.id });
      audit.log('provider', 'payment.amount_mismatch', 'payment', pay.id, { after: remote });
      throw new AppError(400, 'verification_failed', 'Captured amount does not match the order');
    }
    const now = clock.iso();
    const inv = db.one('SELECT * FROM invoices WHERE id = ?', pay.invoice_id);
    // A second captured payment for an already settled invoice (or a second payment id on the same order)
    const alreadySettled = inv.status !== 'issued' && inv.status !== 'overdue';
    const secondOnSameOrder = ['captured', 'refunded', 'partially_refunded'].includes(pay.status) && pay.provider_payment_id !== remote.id;
    let rowId = pay.id;
    if (secondOnSameOrder) {
      rowId = db.insert('payments', { account_id: pay.account_id, invoice_id: pay.invoice_id, provider: pay.provider, provider_payment_id: remote.id, amount_paise: remote.amount, currency: pay.currency, status: 'captured', method: remote.method, verified_via: via, captured_at: now, created_at: now, updated_at: now });
    } else {
      db.update('payments', pay.id, { provider_payment_id: remote.id, status: 'captured', method: remote.method, verified_via: via, captured_at: now, updated_at: now });
    }
    db.insert('payment_attempts', { payment_id: rowId, provider_payment_id: remote.id, status: 'captured', method: remote.method, source: via === 'webhook' ? 'webhook' : 'api_fetch', created_at: now });
    savePaymentMethod(pay.account_id, pay.provider, remote, rowId);
    audit.log('provider', 'payment.captured', 'payment', rowId, { after: { provider_payment_id: remote.id, amount: remote.amount, via } });

    if (alreadySettled || secondOnSameOrder) {
      // Duplicate payment protection: never fulfil twice — queue an automatic refund request for review.
      const r = billing.requestRefund({ role: 'system' }, rowId, remote.amount, 'Duplicate payment for an invoice that was already paid');
      flagRisk(pay.account_id, 'duplicate_payment', 'medium', { invoice_id: inv.id, payment_id: rowId, refund_id: r.id });
      notifyPlatform('duplicate_payment', 'Duplicate payment detected', `Invoice ${inv.invoice_number} received a second payment of ${rupees(remote.amount)}. A refund request was raised for approval.`, { refund_id: r.id });
      return { status: 'captured', duplicate_payment: true, invoice: billing.getInvoice(inv.id) };
    }
    billing.settleInvoice(inv.id, db.one('SELECT * FROM payments WHERE id = ?', rowId));
    notify(pay.account_id, 'payment_received', 'Payment received', `We received ${rupees(remote.amount)} for invoice ${inv.invoice_number}. Thank you!`, { invoice_id: inv.id });
    return { status: 'captured', invoice: billing.getInvoice(inv.id) };
  });
}

function savePaymentMethod(accountId, provider, remote, paymentId) {
  if (!remote.method) return;
  const now = clock.iso();
  db.run('INSERT INTO payment_methods (account_id, provider, method_type, label, provider_token, is_default, created_at) VALUES (?,?,?,?,?,0,?) ON CONFLICT(account_id, provider, label) DO UPDATE SET status = \'active\', provider_token = COALESCE(excluded.provider_token, provider_token)',
    accountId, provider, remote.method, remote.label, remote.token, now);
  if (!db.one("SELECT 1 FROM payment_methods WHERE account_id = ? AND is_default = 1 AND status = 'active'", accountId)) {
    db.run('UPDATE payment_methods SET is_default = 1 WHERE account_id = ? AND provider = ? AND label = ?', accountId, provider, remote.label);
  }
  const pm = db.one('SELECT id FROM payment_methods WHERE account_id = ? AND provider = ? AND label = ?', accountId, provider, remote.label);
  db.update('payments', paymentId, { payment_method_id: pm.id });
}

function recordFailure(paymentRowId, remote, source) {
  db.tx(() => {
    const pay = db.one('SELECT * FROM payments WHERE id = ?', paymentRowId);
    const dup = db.one('SELECT 1 FROM payment_attempts WHERE payment_id = ? AND provider_payment_id = ? AND status = ?', pay.id, remote.id, 'failed');
    if (dup) return;
    db.insert('payment_attempts', { payment_id: pay.id, provider_payment_id: remote.id, status: 'failed', method: remote.method, error_code: remote.errorCode, error_description: remote.errorDescription, source, created_at: clock.iso() });
    if (['captured', 'refunded', 'partially_refunded'].includes(pay.status)) return;
    db.update('payments', pay.id, { status: 'failed', failure_reason: remote.errorDescription || remote.errorCode, updated_at: clock.iso() });
    audit.log('provider', 'payment.failed', 'payment', pay.id, { after: { provider_payment_id: remote.id, error: remote.errorDescription } });
    const inv = db.one('SELECT * FROM invoices WHERE id = ?', pay.invoice_id);
    notify(pay.account_id, 'payment_failed', 'Payment failed', `Your payment of ${rupees(pay.amount_paise)} for invoice ${inv.invoice_number} failed${remote.errorDescription ? ` (${remote.errorDescription})` : ''}. Please retry from Billing.`, { invoice_id: inv.id }, { priority: 'high' });
    billing.invoiceFailed(inv.id, pay, remote.errorDescription);
    const risk = settings.get('risk');
    const fails = db.one("SELECT COUNT(*) c FROM payment_attempts pa JOIN payments p ON p.id = pa.payment_id WHERE p.account_id = ? AND pa.status = 'failed' AND pa.created_at > ?", pay.account_id, new Date(clock.now().getTime() - 86400000).toISOString()).c;
    if (fails >= risk.max_failed_payments_24h) flagRisk(pay.account_id, 'repeated_payment_failures', 'medium', { failures_24h: fails });
  });
}

/** Provider webhook entry point. rawBody must be the exact bytes received. */
function handleWebhook(rawBody, signature, eventIdHeader) {
  const provider = providers.get('razorpay');
  const valid = provider.verifyWebhookSignature(rawBody, signature);
  const payload = parseJSON(rawBody, {});
  const eventId = eventIdHeader || `${payload.event}:${payload?.payload?.payment?.entity?.id || payload?.payload?.refund?.entity?.id || ''}:${payload.created_at || ''}`;
  if (!valid) {
    db.run('INSERT OR IGNORE INTO payment_events (provider, event_id, event_type, payload_json, signature_valid, processing_status, received_at) VALUES (?,?,?,?,0,?,?)', provider.name, `invalid:${clock.now().getTime()}:${Math.random()}`, payload.event || 'unknown', rawBody, 'rejected', clock.iso());
    throw new AppError(400, 'invalid_signature', 'Invalid webhook signature');
  }
  const existing = db.one('SELECT * FROM payment_events WHERE provider = ? AND event_id = ?', provider.name, eventId);
  if (existing && existing.processing_status === 'processed') return { duplicate: true };
  if (!existing) db.insert('payment_events', { provider: provider.name, event_id: eventId, event_type: payload.event, payload_json: rawBody, signature_valid: 1, processing_status: 'received', received_at: clock.iso() });
  try {
    const status = processEvent(provider, payload);
    db.run('UPDATE payment_events SET processing_status = ?, error = NULL WHERE provider = ? AND event_id = ?', status, provider.name, eventId);
    return { processed: status };
  } catch (e) {
    db.run("UPDATE payment_events SET processing_status = 'failed', error = ? WHERE provider = ? AND event_id = ?", e.message, provider.name, eventId);
    throw e;
  }
}

function processEvent(provider, payload) {
  const ev = payload.event;
  const pe = payload?.payload?.payment?.entity;
  if (ev === 'payment.captured' || ev === 'order.paid') {
    const remote = provider.normalisePayment(pe);
    const pay = db.one('SELECT * FROM payments WHERE provider_order_id = ?', remote.orderId);
    if (!pay) return 'ignored';
    capture(pay.id, remote, 'webhook');
    return 'processed';
  }
  if (ev === 'payment.failed') {
    const remote = provider.normalisePayment(pe);
    const pay = db.one('SELECT * FROM payments WHERE provider_order_id = ?', remote.orderId);
    if (!pay) return 'ignored';
    recordFailure(pay.id, remote, 'webhook');
    return 'processed';
  }
  if (ev === 'payment.authorized') return 'ignored'; // capture follows (auto-capture)
  if (ev === 'refund.processed' || ev === 'refund.failed') {
    const re = payload.payload.refund.entity;
    const r = db.one('SELECT * FROM refunds WHERE provider_refund_id = ?', re.id) || (re.notes?.refund_id ? db.one('SELECT * FROM refunds WHERE id = ?', Number(re.notes.refund_id)) : null);
    if (!r) return 'ignored';
    if (!r.provider_refund_id) db.update('refunds', r.id, { provider_refund_id: re.id });
    if (ev === 'refund.processed') billing.finaliseRefund(r.id, 'provider');
    else db.tx(() => { db.update('refunds', r.id, { status: 'failed', updated_at: clock.iso() }); audit.log('provider', 'refund.failed', 'refund', r.id, {}); });
    return 'processed';
  }
  if (ev && ev.startsWith('payment.dispute.')) {
    const de = payload.payload.dispute.entity;
    const pay = db.one('SELECT * FROM payments WHERE provider_payment_id = ?', de.payment_id);
    const statusMap = { 'payment.dispute.created': 'open', 'payment.dispute.under_review': 'under_review', 'payment.dispute.won': 'won', 'payment.dispute.lost': 'lost', 'payment.dispute.closed': 'closed', 'payment.dispute.action_required': 'open' };
    const now = clock.iso();
    db.run(`INSERT INTO payment_disputes (payment_id, provider_dispute_id, amount_paise, reason, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(provider_dispute_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`, pay?.id ?? null, de.id, de.amount, de.reason_description || de.reason_code, statusMap[ev] || 'open', now, now);
    audit.log('provider', ev, 'payment_dispute', de.id, { after: de });
    if (pay) notifyPlatform('payment_dispute', 'Payment dispute update', `Dispute ${de.id} on payment ${de.payment_id}: ${statusMap[ev]}`, { dispute_id: de.id });
    return 'processed';
  }
  return 'ignored';
}

/** Compare provider records with local payments for a window; optionally repair missed captures. */
async function reconcile(actor, { from, to, repair = false }) {
  const provider = providers.get();
  const fromTs = Math.floor(new Date(from).getTime() / 1000);
  const toTs = Math.floor(new Date(to).getTime() / 1000);
  const remote = [];
  for (let skip = 0; ; skip += 100) {
    const page = await provider.listPayments({ from: fromTs, to: toTs, count: 100, skip });
    remote.push(...(page.items || []).map(provider.normalisePayment));
    if (!page.items || page.items.length < 100) break;
  }
  const issues = [];
  const seen = new Set();
  for (const r of remote) {
    seen.add(r.id);
    const local = db.one('SELECT * FROM payments WHERE provider_payment_id = ?', r.id) || db.one('SELECT * FROM payments WHERE provider_order_id = ?', r.orderId);
    if (!local) { issues.push({ type: 'unknown_at_platform', provider_payment_id: r.id, amount: r.amount, status: r.status }); continue; }
    if (r.status === 'captured' && !['captured', 'refunded', 'partially_refunded'].includes(local.status)) {
      const issue = { type: 'missed_capture', payment_id: local.id, provider_payment_id: r.id, amount: r.amount };
      if (repair) { capture(local.id, r, 'reconciliation'); issue.repaired = true; }
      issues.push(issue);
    } else if (local.provider_payment_id === r.id && local.amount_paise !== r.amount) {
      issues.push({ type: 'amount_mismatch', payment_id: local.id, local: local.amount_paise, provider: r.amount });
    }
  }
  const localCaptured = db.all("SELECT * FROM payments WHERE status IN ('captured','refunded','partially_refunded') AND captured_at >= ? AND captured_at < ? AND provider_payment_id IS NOT NULL", new Date(from).toISOString(), new Date(to).toISOString());
  for (const l of localCaptured) if (!seen.has(l.provider_payment_id)) issues.push({ type: 'missing_at_provider', payment_id: l.id, provider_payment_id: l.provider_payment_id, amount: l.amount_paise });
  const report = { from, to, provider_payments: remote.length, local_captured: localCaptured.length, issues, ok: issues.length === 0 };
  audit.log(actor, 'payments.reconciled', 'reconciliation', `${from}..${to}`, { after: { issues: issues.length, repaired: issues.filter((i) => i.repaired).length } });
  return report;
}

module.exports = { startCheckout, verifyCallback, capture, recordFailure, handleWebhook, reconcile, flagRisk };
