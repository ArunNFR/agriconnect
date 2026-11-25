'use strict';
const express = require('express');
const db = require('../db');
const clock = require('../lib/clock');
const events = require('../lib/events');
const { h, idempotent } = require('../lib/http');
const { hashPassword, verifyPassword, issueSession, requireAuth, requireRole, requireBillingRole, actor } = require('../lib/auth');
const { bad, notFound, conflict, forbidden, AppError } = require('../lib/util');
const ent = require('../services/entitlements');
const plans = require('../services/plans');
const subs = require('../services/subscriptions');
const billing = require('../services/billing');
const payments = require('../services/payments');
const market = require('../services/marketplace');
const promotions = require('../services/promotions');
const procurement = require('../services/procurement');
const logistics = require('../services/logistics');
const ads = require('../services/advertising');
const referrals = require('../services/referrals');
const intelligence = require('../services/intelligence');
const analytics = require('../services/analytics');
const invoiceRender = require('../services/invoiceRender');
const providers = require('../payments');

const r = express.Router();
const farmer = requireRole('farmer');
const buyer = requireRole('buyer');
const member = requireRole('farmer', 'buyer');

// ------------------------------------------------------------------ public
r.get('/config', h(() => ({
  payments: { provider: providers.get().name, configured: providers.get().isConfigured(), key: providers.get().publicKey() || null },
  regions: db.all('SELECT * FROM regions ORDER BY name'),
  categories: db.all('SELECT * FROM categories ORDER BY name'),
})));
r.get('/plans', h((req) => plans.list({ audience: req.query.audience })));

// ------------------------------------------------------------------ auth (workflow steps 1–3)
r.post('/auth/register', h((req) => {
  const b = req.body || {};
  for (const f of ['email', 'password', 'name', 'role', 'business_name']) if (!b[f]) throw bad(`${f} is required`);
  if (!['farmer', 'buyer', 'advertiser'].includes(b.role)) throw bad('role must be farmer, buyer or advertiser');
  const email = String(b.email).trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Invalid email');
  if (db.one('SELECT 1 FROM users WHERE email = ?', email)) throw conflict('An account with this email already exists');
  const pw = hashPassword(b.password);
  const out = db.tx(() => {
    const accountId = db.insert('accounts', { type: b.role, name: b.business_name, business_type: b.business_type || null, region: b.region || null, city: b.city || null, phone: b.phone || null, created_at: clock.iso() });
    const userId = db.insert('users', { account_id: accountId, email, name: b.name, phone: b.phone || null, password_hash: pw, role: b.role, account_role: 'owner', signup_ip: req.ip, created_at: clock.iso() });
    subs.ensureDefault(accountId, { userId, role: b.role });
    if (b.role !== 'advertiser') referrals.codeFor(accountId);
    const referral = b.referral_code ? referrals.onRegister(accountId, b.referral_code, req.ip) : null;
    return { userId, accountId, referral };
  });
  return { token: issueSession(out.userId), account_id: out.accountId, referral_status: out.referral?.status || null };
}));

r.post('/auth/login', h((req) => {
  const u = db.one('SELECT * FROM users WHERE email = ?', String(req.body?.email || '').trim().toLowerCase());
  if (!u || !verifyPassword(req.body?.password || '', u.password_hash) || u.status !== 'active') throw new AppError(401, 'invalid_credentials', 'Incorrect email or password');
  return { token: issueSession(u.id), role: u.role };
}));

r.use(requireAuth);

r.get('/me', h((req) => {
  const acct = db.one('SELECT * FROM accounts WHERE id = ?', req.user.accountId);
  const unread = db.one('SELECT COUNT(*) c FROM notifications WHERE account_id = ? AND read_at IS NULL', req.user.accountId).c;
  const base = { user: { id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role, account_role: req.user.accountRole }, account: acct, unread_notifications: unread };
  if (['farmer', 'buyer'].includes(req.user.role)) {
    const e = ent.forAccount(req.user.accountId);
    base.subscription = { plan: e.subscription?.plan_name, plan_code: e.subscription?.plan_code, status: e.subscription?.status, access: e.source };
    base.entitlements = e.values;
  }
  return base;
}));

r.put('/me/profile', h((req) => {
  const b = req.body || {};
  const patch = {};
  for (const f of ['name', 'business_type', 'region', 'city', 'address', 'gstin', 'phone']) if (b[f] !== undefined) patch[f] = b[f];
  const acct = db.one('SELECT * FROM accounts WHERE id = ?', req.user.accountId);
  const merged = { ...acct, ...patch };
  const complete = Boolean(merged.name && merged.business_type && merged.region && merged.phone);
  db.update('accounts', req.user.accountId, { ...patch, profile_completed: complete ? 1 : 0 });
  if (complete && !acct.profile_completed) events.emit('profile.completed', { accountId: req.user.accountId });
  return db.one('SELECT * FROM accounts WHERE id = ?', req.user.accountId);
}));

r.get('/notifications', h((req) => db.all('SELECT * FROM notifications WHERE account_id = ? ORDER BY id DESC LIMIT 100', req.user.accountId)));
r.post('/notifications/read', h((req) => { db.run('UPDATE notifications SET read_at = ? WHERE account_id = ? AND read_at IS NULL', clock.iso(), req.user.accountId); return { ok: true }; }));

// ------------------------------------------------------------------ subscription (sections 5–8)
r.get('/subscription', member, h((req) => subs.dashboard(req.user.accountId)));
r.get('/subscription/history', member, h((req) => subs.history(req.user.accountId)));
r.get('/subscription/usage', member, h((req) => ent.usage(req.user.accountId)));
r.post('/subscription/quote', member, h((req) => subs.quote(req.user.accountId, req.body || {})));
r.post('/subscription/checkout', member, requireBillingRole, idempotent((req) => subs.checkout(req.user.accountId, actor(req), req.body || {})));
r.post('/subscription/cancel', member, requireBillingRole, h((req) => subs.cancel(req.user.accountId, actor(req), req.body || {})));
r.post('/subscription/renew', member, requireBillingRole, h((req) => subs.renew(req.user.accountId, actor(req))));
r.post('/subscription/enterprise-enquiry', member, requireBillingRole, h((req) => subs.requestEnterprise(req.user.accountId, actor(req), req.body || {})));

// ------------------------------------------------------------------ billing (section 20)
r.get('/billing/invoices', h((req) => db.all('SELECT id, invoice_number, invoice_type, status, total_paise, amount_paid_paise, amount_refunded_paise, tax_paise, issued_at, due_at, paid_at FROM invoices WHERE account_id = ? ORDER BY id DESC', req.user.accountId)));
r.get('/billing/invoices/:id', h((req) => { const inv = billing.getInvoice(Number(req.params.id)); if (inv.account_id !== req.user.accountId) throw notFound('Invoice'); return inv; }));
r.get('/billing/invoices/:id/download', h((req, res) => {
  const inv = billing.getInvoice(Number(req.params.id));
  if (inv.account_id !== req.user.accountId) throw notFound('Invoice');
  res.set('Content-Type', 'text/html; charset=utf-8').set('Content-Disposition', `attachment; filename="invoice-${inv.invoice_number.replace(/\//g, '-')}.html"`).send(invoiceRender.render(inv));
}));
r.get('/billing/summary', h((req) => {
  const a = req.user.accountId;
  return {
    payments: db.all('SELECT p.id, p.amount_paise, p.amount_refunded_paise, p.status, p.method, p.provider_payment_id, p.captured_at, p.created_at, i.invoice_number, i.invoice_type FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE p.account_id = ? ORDER BY p.id DESC', a),
    refunds: db.all('SELECT r.id, r.amount_paise, r.status, r.reason, r.created_at, r.processed_at, i.invoice_number FROM refunds r JOIN invoices i ON i.id = r.invoice_id WHERE r.account_id = ? ORDER BY r.id DESC', a),
    pending: db.all("SELECT id, invoice_number, invoice_type, total_paise - amount_paid_paise due_paise, due_at, status FROM invoices WHERE account_id = ? AND status IN ('issued','overdue') ORDER BY due_at", a),
    commissions: db.all("SELECT tc.*, o.order_number FROM transaction_commissions tc JOIN orders o ON o.id = tc.order_id WHERE (o.seller_account_id = ? AND tc.seller_portion_paise > 0) OR (o.buyer_account_id = ? AND tc.buyer_portion_paise > 0) ORDER BY tc.id DESC LIMIT 200", a, a),
    service_fees: db.all('SELECT f.*, ps.reference FROM procurement_service_fees f JOIN procurement_services ps ON ps.id = f.service_id WHERE ps.buyer_account_id = ? ORDER BY f.id DESC', a),
    promotion_charges: db.all("SELECT pp.id, p.name, pp.amount_charged_paise, pp.paid_with, pp.credits_used, pp.status, pp.created_at FROM promotion_purchases pp JOIN promotions p ON p.id = pp.promotion_id WHERE pp.account_id = ? ORDER BY pp.id DESC", a),
    account_credit_paise: billing.accountCreditBalance(a),
  };
}));
r.get('/billing/payment-methods', h((req) => db.all("SELECT id, provider, method_type, label, is_default, created_at FROM payment_methods WHERE account_id = ? AND status = 'active' ORDER BY is_default DESC, id DESC", req.user.accountId)));
r.post('/billing/payment-methods/:id/default', requireBillingRole, h((req) => {
  const pm = db.one("SELECT * FROM payment_methods WHERE id = ? AND account_id = ? AND status = 'active'", Number(req.params.id), req.user.accountId);
  if (!pm) throw notFound('Payment method');
  db.run('UPDATE payment_methods SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE account_id = ?', pm.id, req.user.accountId);
  return { ok: true };
}));
r.post('/billing/payment-methods/:id/remove', requireBillingRole, h((req) => { db.run("UPDATE payment_methods SET status = 'removed', is_default = 0 WHERE id = ? AND account_id = ?", Number(req.params.id), req.user.accountId); return { ok: true }; }));

// ------------------------------------------------------------------ payments (section 9)
r.post('/payments/checkout', requireBillingRole, idempotent((req) => payments.startCheckout(req.user.accountId, Number(req.body?.invoice_id), { idempotencyKey: req.get('idempotency-key') })));
r.post('/payments/verify', h((req) => payments.verifyCallback(req.user.accountId, req.body || {})));
r.get('/payments/status/:invoiceId', h((req) => { const inv = billing.getInvoice(Number(req.params.invoiceId)); if (inv.account_id !== req.user.accountId) throw notFound('Invoice'); return { status: inv.status, invoice: inv }; }));

// ------------------------------------------------------------------ marketplace: farmer inventory
r.get('/farms', farmer, h((req) => market.farms(req.user.accountId)));
r.post('/farms', farmer, h((req) => market.createFarm(req.user.accountId, req.body || {})));
r.get('/listings/mine', farmer, h((req) => market.myListings(req.user.accountId)));
r.post('/listings', farmer, h((req) => market.createListing(req.user.accountId, req.body || {})));
r.post('/listings/bulk', farmer, h((req) => market.bulkCreate(req.user.accountId, req.body?.items)));
r.put('/listings/:id', farmer, h((req) => market.updateListing(req.user.accountId, Number(req.params.id), req.body || {})));
r.get('/team', h((req) => market.team(req.user.accountId)));
r.post('/team', requireBillingRole, h((req) => market.addTeamMember(req.user.accountId, actor(req), req.body || {}, hashPassword)));

// ------------------------------------------------------------------ marketplace: discovery & orders
r.get('/marketplace/search', h((req) => ({ results: market.search(req.user.accountId, req.query), sponsored_content: ads.serve('marketplace', { type: req.user.accountType, region: db.one('SELECT region FROM accounts WHERE id = ?', req.user.accountId).region }) })));
r.get('/marketplace/listings/:id', h((req) => market.viewListing(Number(req.params.id))));
r.post('/marketplace/listings/:id/enquire', buyer, h((req) => market.enquire(req.user.accountId, Number(req.params.id), req.body?.message)));
r.get('/enquiries', h((req) => db.all('SELECT e.*, l.product_name, b.name buyer_name FROM enquiries e JOIN listings l ON l.id = e.listing_id JOIN accounts b ON b.id = e.buyer_account_id WHERE e.seller_account_id = ? OR e.buyer_account_id = ? ORDER BY e.id DESC LIMIT 100', req.user.accountId, req.user.accountId)));
r.post('/orders/quote', buyer, h((req) => market.priceOrder(req.user.accountId, req.body || {})));
r.post('/orders', buyer, idempotent((req) => market.placeOrder(req.user.accountId, req.body || {})));
r.post('/orders/basket/quote', buyer, h((req) => market.quoteBasket(req.user.accountId, req.body || {})));
r.post('/orders/basket', buyer, idempotent((req) => market.placeBasket(req.user.accountId, req.body || {})));
r.get('/orders', member, h((req) => market.orders(req.user.accountId, req.user.role)));
r.post('/orders/:id/status', h((req) => market.updateOrderStatus(actor(req), req.user.accountId, Number(req.params.id), req.body?.status)));
r.get('/deliveries', member, h((req) => logistics.list({ accountId: req.user.accountId })));
r.post('/deliveries/:orderId/status', farmer, h((req) => {
  const o = db.one('SELECT * FROM orders WHERE id = ?', Number(req.params.orderId));
  if (!o || o.seller_account_id !== req.user.accountId) throw notFound('Order');
  const lt = db.one('SELECT mode FROM logistics_transactions WHERE order_id = ?', o.id);
  if (lt.mode !== 'farmer_delivery') throw forbidden('This delivery is managed by AgriConnect logistics');
  return logistics.setStatus(actor(req), o.id, req.body?.status);
}));

// buyer tools
r.get('/suppliers/saved', buyer, h((req) => market.savedSuppliers(req.user.accountId)));
r.post('/suppliers/saved', buyer, h((req) => market.saveSupplier(req.user.accountId, Number(req.body?.supplier_account_id))));
r.post('/suppliers/saved/:id/remove', buyer, h((req) => market.removeSupplier(req.user.accountId, Number(req.params.id))));
r.post('/suppliers/compare', buyer, h((req) => market.compareSuppliers(req.user.accountId, req.body?.supplier_ids || [])));
r.get('/searches', buyer, h((req) => market.savedSearches(req.user.accountId)));
r.post('/searches', buyer, h((req) => market.saveSearch(req.user.accountId, req.body || {})));
r.get('/procurement/reports/export', buyer, h((req, res) => {
  ent.assertFeature(req.user.accountId, 'procurement_reports', 'export_procurement');
  const rows = db.all("SELECT o.order_number, o.placed_at, o.status, s.name supplier, l.product_name, o.quantity, o.unit, o.unit_price_paise, o.subtotal_paise, o.buyer_fee_paise, o.total_buyer_paise FROM orders o JOIN accounts s ON s.id = o.seller_account_id JOIN listings l ON l.id = o.listing_id WHERE o.buyer_account_id = ? ORDER BY o.id DESC", req.user.accountId);
  res.set('Content-Type', 'text/csv').set('Content-Disposition', 'attachment; filename="procurement-report.csv"').send(analytics.csv(rows, Object.keys(rows[0] || { order_number: 1 })));
}));
r.get('/sales/reports/export', farmer, h((req, res) => {
  ent.assertFeature(req.user.accountId, 'export_reports', 'export_sales');
  const rows = db.all('SELECT o.order_number, o.placed_at, o.status, b.name buyer, l.product_name, o.quantity, o.unit, o.unit_price_paise, o.subtotal_paise, o.seller_fee_paise, o.seller_payout_paise FROM orders o JOIN accounts b ON b.id = o.buyer_account_id JOIN listings l ON l.id = o.listing_id WHERE o.seller_account_id = ? ORDER BY o.id DESC', req.user.accountId);
  res.set('Content-Type', 'text/csv').set('Content-Disposition', 'attachment; filename="sales-report.csv"').send(analytics.csv(rows, Object.keys(rows[0] || { order_number: 1 })));
}));

// ------------------------------------------------------------------ promotions (section 12)
r.get('/promotions/catalog', farmer, h(() => promotions.catalog()));
r.post('/promotions/quote', farmer, h((req) => promotions.quote(req.user.accountId, req.body || {})));
r.post('/promotions/purchase', farmer, requireBillingRole, idempotent((req) => promotions.purchase(req.user.accountId, actor(req), req.body || {})));
r.get('/promotions/mine', farmer, h((req) => promotions.forAccount(req.user.accountId)));

// ------------------------------------------------------------------ procurement services (section 13)
r.post('/procurement/estimate', buyer, h((req) => procurement.estimate(req.user.accountId, req.body || {})));
r.post('/procurement', buyer, h((req) => procurement.create(req.user.accountId, actor(req), req.body || {})));
r.get('/procurement', buyer, h((req) => procurement.forBuyer(req.user.accountId)));
r.post('/procurement/:id/approve', buyer, h((req) => procurement.approve(req.user.accountId, Number(req.params.id), req.body || {})));
r.post('/procurement/:id/decline', buyer, h((req) => procurement.decline(req.user.accountId, Number(req.params.id))));
r.get('/demand-board', farmer, h((req) => procurement.demandBoard(req.user.accountId)));
r.get('/supply-requests', farmer, h((req) => procurement.supplierRequests(req.user.accountId)));
r.post('/supply-requests/:id/respond', farmer, h((req) => procurement.respondLine(req.user.accountId, Number(req.params.id), !!req.body?.confirm)));

// ------------------------------------------------------------------ intelligence (section 15)
r.get('/intelligence', member, h((req) => (req.user.role === 'farmer' ? intelligence.forFarmer(req.user.accountId) : intelligence.forBuyer(req.user.accountId))));

// ------------------------------------------------------------------ referrals (section 21)
r.get('/referrals', member, h((req) => referrals.summary(req.user.accountId)));

// ------------------------------------------------------------------ advertising (section 9 of revenue streams)
const advertiser = requireRole('advertiser');
r.get('/ads/mine', advertiser, h((req) => ads.forAdvertiser(req.user.accountId)));
r.post('/ads/price', advertiser, h((req) => ads.price(req.body?.placement || 'marketplace', req.body?.start_at, req.body?.end_at)));
r.post('/ads', advertiser, h((req) => ads.create(req.user.accountId, req.body || {})));
r.post('/ads/:id/submit', advertiser, h((req) => ads.submit(req.user.accountId, Number(req.params.id))));
r.get('/ads/serve', h((req) => ads.serve(req.query.placement || 'dashboard', { type: req.user.accountType, region: db.one('SELECT region FROM accounts WHERE id = ?', req.user.accountId).region })));

module.exports = r;
