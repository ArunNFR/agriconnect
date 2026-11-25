'use strict';
/**
 * Platform Owner + Administrator routes. Permission checks are per endpoint:
 * owner-only = monetisation configuration, revenue/analytics, refund authorisation, audit log.
 */
const express = require('express');
const db = require('../db');
const clock = require('../lib/clock');
const audit = require('../lib/audit');
const settings = require('../lib/settings');
const { h } = require('../lib/http');
const { requireAuth, requirePerm, actor } = require('../lib/auth');
const { bad, notFound } = require('../lib/util');
const plans = require('../services/plans');
const subs = require('../services/subscriptions');
const billing = require('../services/billing');
const payments = require('../services/payments');
const commissions = require('../services/commissions');
const promotions = require('../services/promotions');
const discounts = require('../services/discounts');
const procurement = require('../services/procurement');
const logistics = require('../services/logistics');
const ads = require('../services/advertising');
const analytics = require('../services/analytics');
const intelligence = require('../services/intelligence');
const scheduler = require('../services/scheduler');
const ent = require('../services/entitlements');
const providers = require('../payments');
const marketplace = require('../services/marketplace');

const r = express.Router();
const P = (perm) => [requireAuth, requirePerm(perm)];
const OWNER = P('owner.access');
const csvOut = (res, name, body) => res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="${name}"`).send(body);

// ------------------------------------------------------------- owner dashboards (sections 16–18)
r.get('/owner/overview', OWNER, h((req) => analytics.overview(req.query)));
r.get('/owner/revenue', OWNER, h((req) => analytics.revenue(req.query)));
r.get('/owner/subscription-analytics', OWNER, h((req) => analytics.subscriptionAnalytics(req.query)));
r.get('/owner/intelligence', OWNER, h(() => intelligence.forPlatform()));
r.get('/owner/export/revenue.csv', OWNER, h((req, res) => csvOut(res, 'revenue.csv', analytics.exportRevenue(req.query))));
r.get('/owner/export/financial-report.csv', OWNER, h((req, res) => csvOut(res, 'financial-report.csv', analytics.exportFinancialReport(req.query))));
r.post('/owner/revenue/adjustments', OWNER, h((req) => billing.adjustRevenue(actor(req), req.body || {})));
r.get('/owner/audit-log', OWNER, h((req) => ({ chain: audit.verifyChain(), entries: db.all('SELECT f.*, u.email actor_email FROM financial_audit_logs f LEFT JOIN users u ON u.id = f.actor_user_id ORDER BY f.id DESC LIMIT ?', Math.min(Number(req.query.limit) || 200, 1000)) })));

// ------------------------------------------------------------- plan management (section 19)
r.get('/owner/entitlement-definitions', P('plans.view'), h(() => ent.definitions()));
r.get('/owner/plans', P('plans.view'), h((req) => plans.list({ audience: req.query.audience, includeAll: true })));
r.get('/owner/plans/:id', P('plans.view'), h((req) => ({ ...plans.byId(Number(req.params.id)), versions: plans.versions(Number(req.params.id)) })));
r.post('/owner/plans', OWNER, h((req) => plans.create(actor(req), req.body || {})));
r.post('/owner/plans/:id/impact', OWNER, h((req) => plans.impact(Number(req.params.id), req.body || {})));
r.put('/owner/plans/:id', OWNER, h((req) => plans.update(actor(req), Number(req.params.id), req.body || {})));
r.post('/owner/plans/:id/publish', OWNER, h((req) => plans.publish(actor(req), Number(req.params.id))));
r.post('/owner/plans/:id/status', OWNER, h((req) => plans.setStatus(actor(req), Number(req.params.id), req.body?.status)));
r.post('/owner/plans/:id/delete', OWNER, h((req) => plans.remove(actor(req), Number(req.params.id))));
r.get('/owner/subscribers', P('billing.view'), h((req) => db.all(`SELECT s.id, s.account_id, a.name account, a.type, a.region, p.name plan, s.status, s.billing_frequency, s.price_paise, s.current_period_end, s.trial_ends_at, s.grace_ends_at, s.cancel_at_period_end, s.is_custom_contract
  FROM subscriptions s JOIN accounts a ON a.id = s.account_id JOIN subscription_plans p ON p.id = s.plan_id WHERE s.is_current = 1 ${req.query.status ? 'AND s.status = ?' : ''} ORDER BY s.id DESC LIMIT 500`, ...(req.query.status ? [req.query.status] : []))));

// ------------------------------------------------------------- monetisation configuration (section 24)
r.get('/owner/settings', OWNER, h(() => settings.getAll()));
r.put('/owner/settings/:key', OWNER, h((req) => { if (req.body?.value === undefined) throw bad('value is required'); settings.get(req.params.key); return settings.set(req.params.key, req.body.value, actor(req)); }));
r.get('/owner/commission-rules', OWNER, h(() => commissions.list()));
r.post('/owner/commission-rules', OWNER, h((req) => commissions.create(actor(req), req.body || {})));
r.put('/owner/commission-rules/:id', OWNER, h((req) => commissions.update(actor(req), Number(req.params.id), req.body || {})));
r.post('/owner/commission-rules/preview', OWNER, h((req) => commissions.quote({ sellerAccountId: Number(req.body.seller_account_id), buyerAccountId: Number(req.body.buyer_account_id), categoryId: req.body.category_id ? Number(req.body.category_id) : null, region: req.body.region, orderType: req.body.order_type, orderValue: Number(req.body.order_value_paise) })));
r.get('/owner/promotion-products', OWNER, h(() => promotions.catalog({ all: true })));
r.post('/owner/promotion-products', OWNER, h((req) => promotions.createProduct(actor(req), req.body || {})));
r.put('/owner/promotion-products/:id', OWNER, h((req) => promotions.updateProduct(actor(req), Number(req.params.id), req.body || {})));
r.get('/owner/discount-codes', OWNER, h(() => discounts.list()));
r.post('/owner/discount-codes', OWNER, h((req) => discounts.create(actor(req), req.body || {})));
r.put('/owner/discount-codes/:id', OWNER, h((req) => discounts.update(actor(req), Number(req.params.id), req.body || {})));
r.get('/owner/referrals', OWNER, h(() => db.all('SELECT r.*, a.name referrer, b.name referee FROM referrals r JOIN accounts a ON a.id = r.referrer_account_id JOIN accounts b ON b.id = r.referee_account_id ORDER BY r.id DESC LIMIT 300')));
r.post('/owner/credits', OWNER, h((req) => {
  const { account_id, credit_type, amount, reason } = req.body || {};
  if (!account_id || !['promotion', 'account'].includes(credit_type) || !Number.isInteger(Number(amount)) || !reason) throw bad('account_id, credit_type (promotion|account), integer amount and reason are required');
  return db.tx(() => {
    const id = db.insert('credit_ledger', { account_id, credit_type, amount: Number(amount), reason, related_type: 'manual', created_by: req.user.id, created_at: clock.iso() });
    audit.log(actor(req), 'credit.granted', 'credit_ledger', id, { after: { account_id, credit_type, amount }, reason });
    return db.one('SELECT * FROM credit_ledger WHERE id = ?', id);
  });
}));

// enterprise / custom pricing
r.get('/owner/enterprise-enquiries', P('enterprise.view'), h(() => db.all('SELECT e.*, a.name account, a.type, p.name plan FROM enterprise_enquiries e JOIN accounts a ON a.id = e.account_id JOIN subscription_plans p ON p.id = e.plan_id ORDER BY e.id DESC')));
r.post('/owner/enterprise-enquiries/:id/quote', OWNER, h((req) => subs.quoteEnterprise(actor(req), Number(req.params.id), req.body || {})));

// ------------------------------------------------------------- refunds: admin requests, owner authorises
r.post('/admin/refunds', P('refunds.request'), h((req) => billing.requestRefund(actor(req), Number(req.body?.payment_id), req.body?.amount_paise, req.body?.reason)));
r.get('/admin/refunds', P('payments.view'), h(() => db.all('SELECT r.*, i.invoice_number, a.name account, p.provider_payment_id FROM refunds r JOIN invoices i ON i.id = r.invoice_id JOIN accounts a ON a.id = r.account_id JOIN payments p ON p.id = r.payment_id ORDER BY r.id DESC')));
r.post('/owner/refunds/:id/decision', OWNER, h((req) => billing.decideRefund(actor(req), Number(req.params.id), !!req.body?.approve, req.body?.notes, providers.get())));

// ------------------------------------------------------------- admin: payments, billing, reconciliation (section 20)
r.get('/admin/payments', P('payments.view'), h((req) => db.all(`SELECT p.*, a.name account, i.invoice_number, i.invoice_type FROM payments p JOIN accounts a ON a.id = p.account_id JOIN invoices i ON i.id = p.invoice_id ${req.query.status ? 'WHERE p.status = ?' : ''} ORDER BY p.id DESC LIMIT 500`, ...(req.query.status ? [req.query.status] : []))));
r.get('/admin/payments/failed', P('payments.view'), h(() => ({ attempts: db.all("SELECT pa.*, p.amount_paise, a.name account, i.invoice_number FROM payment_attempts pa JOIN payments p ON p.id = pa.payment_id JOIN accounts a ON a.id = p.account_id JOIN invoices i ON i.id = p.invoice_id WHERE pa.status IN ('failed','signature_invalid') ORDER BY pa.id DESC LIMIT 300"), accounts: analytics.failedPaymentAccounts() })));
r.get('/admin/invoices', P('billing.view'), h((req) => db.all(`SELECT i.*, a.name account FROM invoices i JOIN accounts a ON a.id = i.account_id ${req.query.status ? 'WHERE i.status = ?' : ''} ORDER BY i.id DESC LIMIT 500`, ...(req.query.status ? [req.query.status] : []))));
r.get('/admin/invoices/:id', P('billing.view'), h((req) => billing.getInvoice(Number(req.params.id))));
r.post('/admin/invoices/:id/void', P('billing.view'), h((req) => { if (!req.body?.reason) throw bad('reason is required'); billing.voidInvoice(Number(req.params.id), actor(req), req.body.reason); return billing.getInvoice(Number(req.params.id)); }));
r.get('/admin/webhook-events', P('payments.view'), h(() => db.all('SELECT id, provider, event_id, event_type, signature_valid, processing_status, error, received_at FROM payment_events ORDER BY id DESC LIMIT 300')));
r.get('/admin/disputes', P('disputes.manage'), h(() => db.all('SELECT d.*, p.provider_payment_id, a.name account FROM payment_disputes d LEFT JOIN payments p ON p.id = d.payment_id LEFT JOIN accounts a ON a.id = p.account_id ORDER BY d.id DESC')));
r.post('/admin/disputes/:id', P('disputes.manage'), h((req) => {
  const d = db.one('SELECT * FROM payment_disputes WHERE id = ?', Number(req.params.id));
  if (!d) throw notFound('Dispute');
  const patch = { updated_at: clock.iso() };
  if (req.body?.status) { if (!['open', 'under_review', 'won', 'lost', 'closed'].includes(req.body.status)) throw bad('Invalid status'); patch.status = req.body.status; }
  if (req.body?.notes) patch.notes = req.body.notes;
  db.update('payment_disputes', d.id, patch);
  audit.log(actor(req), 'dispute.updated', 'payment_dispute', d.id, { before: d, after: patch });
  return db.one('SELECT * FROM payment_disputes WHERE id = ?', d.id);
}));
r.post('/admin/reconcile', P('payments.reconcile'), h((req) => payments.reconcile(actor(req), { from: req.body?.from, to: req.body?.to, repair: !!req.body?.repair })));
r.get('/admin/export/payments.csv', P('finance.export'), h((req, res) => { audit.log(actor(req), 'finance.export', 'payments', null, { after: req.query }); csvOut(res, 'payments.csv', analytics.exportPayments(req.query)); }));
r.get('/admin/export/invoices.csv', P('finance.export'), h((req, res) => { audit.log(actor(req), 'finance.export', 'invoices', null, { after: req.query }); csvOut(res, 'invoices.csv', analytics.exportInvoices(req.query)); }));
r.get('/admin/risk-flags', P('risk.view'), h(() => db.all('SELECT f.*, a.name account FROM risk_flags f LEFT JOIN accounts a ON a.id = f.account_id ORDER BY f.id DESC LIMIT 300')));
r.post('/admin/risk-flags/:id', P('risk.view'), h((req) => { db.update('risk_flags', Number(req.params.id), { status: req.body?.status === 'dismissed' ? 'dismissed' : 'reviewed' }); return { ok: true }; }));

// ------------------------------------------------------------- admin: operations
r.get('/admin/users', P('users.view'), h(() => db.all(`SELECT a.id account_id, a.name, a.type, a.region, a.status, a.verified, a.premium_badge, a.created_at, p.name plan, s.status subscription_status, (SELECT email FROM users WHERE account_id = a.id AND account_role = 'owner' LIMIT 1) email
  FROM accounts a LEFT JOIN subscriptions s ON s.account_id = a.id AND s.is_current = 1 LEFT JOIN subscription_plans p ON p.id = s.plan_id WHERE a.type != 'platform' ORDER BY a.id DESC LIMIT 1000`)));
r.post('/admin/accounts/:id/verify', P('users.manage'), h((req) => {
  const id = Number(req.params.id);
  const badgeAllowed = ent.value(id, 'premium_badge_eligible') === true;
  db.update('accounts', id, { verified: 1, premium_badge: badgeAllowed && req.body?.premium_badge ? 1 : 0 });
  return db.one('SELECT * FROM accounts WHERE id = ?', id);
}));
r.post('/admin/accounts/:id/status', P('users.manage'), h((req) => { if (!['active', 'suspended'].includes(req.body?.status)) throw bad('status must be active or suspended'); db.update('accounts', Number(req.params.id), { status: req.body.status }); return { ok: true }; }));
r.post('/admin/orders/:id/status', P('orders.manage'), h((req) => marketplace.updateOrderStatus(actor(req), null, Number(req.params.id), req.body?.status)));
r.get('/admin/procurement', P('procurement.manage'), h((req) => procurement.queue(req.query.status)));
r.get('/admin/procurement/:id/suppliers', P('procurement.manage'), h((req) => procurement.suggestSuppliers(Number(req.params.id))));
r.post('/admin/procurement/:id/review', P('procurement.manage'), h((req) => procurement.review(actor(req), Number(req.params.id), req.body || {})));
r.post('/admin/procurement/:id/lines', P('procurement.manage'), h((req) => procurement.addLine(actor(req), Number(req.params.id), req.body || {})));
r.post('/admin/procurement/:id/proposal', P('procurement.manage'), h((req) => procurement.sendProposal(actor(req), Number(req.params.id), req.body || {})));
r.get('/admin/logistics', P('logistics.manage'), h(() => ({ deliveries: logistics.list(), providers: db.all('SELECT * FROM logistics_providers ORDER BY id') })));
r.post('/admin/logistics/providers', P('logistics.manage'), h((req) => logistics.registerProvider(actor(req), req.body || {})));
r.put('/admin/logistics/providers/:id', P('logistics.manage'), h((req) => logistics.updateProvider(actor(req), Number(req.params.id), req.body || {})));
r.post('/admin/logistics/:orderId/schedule', P('logistics.manage'), h((req) => logistics.schedule(actor(req), Number(req.params.orderId), req.body || {})));
r.post('/admin/logistics/:orderId/status', P('logistics.manage'), h((req) => logistics.setStatus(actor(req), Number(req.params.orderId), req.body?.status)));
r.get('/admin/ads', P('ads.review'), h((req) => ads.all(req.query.status)));
r.post('/admin/ads/:id/review', P('ads.review'), h((req) => ads.review(actor(req), Number(req.params.id), req.body || {})));
r.post('/admin/jobs/run', P('jobs.run'), h((req) => scheduler.runAll({ forceCommissionInvoicing: !!req.body?.invoice_commissions })));

module.exports = r;
