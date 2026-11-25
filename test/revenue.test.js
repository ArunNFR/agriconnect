'use strict';
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, DAY } = require('./helpers');

let t; let owner; let admin; let farmer; let farmer2; let buyer; let lst; let lst2;
before(async () => {
  t = await setup();
  owner = await t.login('owner@agriconnect.local', 'owner-pass-123');
  admin = await t.login('admin@agriconnect.local', 'admin-pass-123');
  farmer = await t.register('farmer', 'f1@x.in');
  farmer2 = await t.register('farmer', 'f2@x.in', { region: 'MH' });
  buyer = await t.register('buyer', 'b1@x.in');
  lst = await t.ok('POST', '/api/listings', farmer, { product_name: 'Oyster Mushrooms', quantity: 2000, price_per_unit_paise: 18000, category_id: 1, min_order_qty: 1 });
  lst2 = await t.ok('POST', '/api/listings', farmer2, { product_name: 'Oyster Mushrooms', quantity: 1500, price_per_unit_paise: 17500, category_id: 1, min_order_qty: 1 });
});
after(() => t.close());
afterEach(() => t.clock.reset());

const complete = async (orderId, seller, buyerTok) => {
  await t.ok('POST', `/api/orders/${orderId}/status`, seller, { status: 'accepted' });
  await t.ok('POST', `/api/orders/${orderId}/status`, seller, { status: 'dispatched' });
  await t.ok('POST', `/api/orders/${orderId}/status`, buyerTok, { status: 'delivered' });
  return t.ok('POST', `/api/orders/${orderId}/status`, buyerTok, { status: 'completed' });
};

test('transaction commission: off by default, tiered by seller plan, shown before confirmation, recognised on completion, invoiced', async () => {
  let q = await t.ok('POST', '/api/orders/quote', buyer, { listing_id: lst.id, quantity: 10 });
  assert.equal(q.commission.enabled, false);
  assert.equal(q.commission.commission_paise, 0);

  await t.ok('PUT', '/api/owner/settings/commissions', owner, { value: { enabled: true, default_charged_to: 'seller', invoice_day_of_month: 1, invoice_due_days: 15 } });
  q = await t.ok('POST', '/api/orders/quote', buyer, { listing_id: lst.id, quantity: 10 }); // ₹1,800 order, Starter plan 2.5%
  assert.equal(q.subtotal_paise, 180000);
  assert.equal(q.commission.commission_paise, 4500);
  assert.equal(q.commission.rule_source, 'plan');
  assert.match(q.charges_note, /2.5%/);

  // A rule for buyer-paid fixed fee on a category overrides the plan rate
  const rule = await t.ok('POST', '/api/owner/commission-rules', owner, { name: 'Mushroom buyer fee', priority: 5, model: 'percentage_plus_fixed', rate_bps: 150, fixed_paise: 1000, charged_to: 'buyer', category_id: 1 });
  q = await t.ok('POST', '/api/orders/quote', buyer, { listing_id: lst.id, quantity: 10 });
  assert.equal(q.commission.commission_paise, 2700 + 1000);
  assert.equal(q.total_buyer_paise, 180000 + 3700);
  await t.ok('PUT', `/api/owner/commission-rules/${rule.id}`, owner, { status: 'inactive' });

  const order = await t.ok('POST', '/api/orders', buyer, { listing_id: lst.id, quantity: 10 });
  assert.equal(t.db.one('SELECT status FROM transaction_commissions WHERE order_id = ?', order.id).status, 'pending');
  assert.equal(t.db.one("SELECT COUNT(*) c FROM revenue_records WHERE category = 'transaction_commission'").c, 0, 'not recognised before completion');
  await complete(order.id, farmer, buyer);
  const rr = t.db.one("SELECT * FROM revenue_records WHERE category = 'transaction_commission' AND order_id = ?", order.id);
  assert.equal(rr.amount_paise, 4500);

  // cancelled orders never generate commission
  const o2 = await t.ok('POST', '/api/orders', buyer, { listing_id: lst.id, quantity: 5 });
  await t.ok('POST', `/api/orders/${o2.id}/status`, buyer, { status: 'cancelled' });
  assert.equal(t.db.one('SELECT status FROM transaction_commissions WHERE order_id = ?', o2.id).status, 'void');

  const jobs = await t.runJobs(owner, { invoice_commissions: true });
  assert.equal(jobs.commission_invoices.length, 1);
  const inv = t.db.one("SELECT * FROM invoices WHERE invoice_type = 'commission'");
  assert.equal(inv.subtotal_paise, 4500);
  await t.payInvoice(farmer, inv.id);
  assert.equal(t.db.one("SELECT COUNT(*) c FROM revenue_records WHERE category = 'transaction_commission'").c, 1, 'paying the commission invoice does not double-count');
  await t.ok('PUT', '/api/owner/settings/commissions', owner, { value: { enabled: false, default_charged_to: 'seller', invoice_day_of_month: 1, invoice_due_days: 15 } });
});

test('buyer entitlements: multi-farmer basket and saved-supplier limits need an upgrade', async () => {
  const items = [{ listing_id: lst.id, quantity: 5 }, { listing_id: lst2.id, quantity: 5 }];
  const quote = await t.ok('POST', '/api/orders/basket/quote', buyer, { items });
  assert.equal(quote.upgrade_required.entitlement, 'multi_farmer_procurement');
  const blocked = await t.api('POST', '/api/orders/basket', buyer, { items });
  assert.equal(blocked.status, 402);
  assert.ok(blocked.body.error.details.upgrade_options.some((o) => o.code === 'buyer_pro'));
  // individual orders still work
  await t.ok('POST', '/api/orders', buyer, { listing_id: lst2.id, quantity: 5 });
  assert.equal((await t.api('POST', '/api/suppliers/compare', buyer, { supplier_ids: [1, 2] })).status, 402);

  const pro = await t.register('buyer', 'bpro@x.in');
  const p = (await t.ok('GET', '/api/owner/plans', owner)).find((x) => x.code === 'buyer_pro');
  await t.ok('PUT', `/api/owner/plans/${p.id}`, owner, { trial_days: 0, change_scope: 'new_only' });
  const co = await t.ok('POST', '/api/subscription/checkout', pro, { plan_code: 'buyer_pro', frequency: 'monthly' });
  await t.payInvoice(pro, co.invoice.id);
  const basket = await t.ok('POST', '/api/orders/basket', pro, { items });
  assert.equal(basket.orders.length, 2);
  assert.equal(basket.orders[0].order_type, 'multi_farmer');
  assert.ok(t.db.one('SELECT COUNT(*) c FROM upgrade_prompts WHERE entitlement_key = ?', 'multi_farmer_procurement').c >= 1, 'denials feed "likely to upgrade" analytics');
});

test('featured listing: paid promotion activates after payment, ranks first with a label, tracks performance, expires', async () => {
  const start = Date.now();
  t.clock.set(start);
  const cat = await t.ok('GET', '/api/promotions/catalog', farmer2);
  assert.ok(cat.find((c) => c.code === 'featured_3d'));
  const pur = await t.ok('POST', '/api/promotions/purchase', farmer2, { listing_id: lst2.id, promotion_code: 'featured_3d' });
  assert.equal(pur.requires_payment, true);
  assert.equal(pur.purchase.status, 'pending_payment');
  let s = await t.ok('GET', '/api/marketplace/search?q=Oyster', buyer);
  assert.equal(s.results.find((r) => r.id === lst2.id).sponsored, false);
  await t.payInvoice(farmer2, pur.invoice.id);
  s = await t.ok('GET', '/api/marketplace/search?q=Oyster', buyer);
  assert.equal(s.results[0].id, lst2.id);
  assert.equal(s.results[0].promotion_label, 'Featured');
  await t.ok('GET', `/api/marketplace/listings/${lst2.id}`, buyer);
  await t.ok('POST', `/api/marketplace/listings/${lst2.id}/enquire`, buyer, { message: 'Need 200kg weekly' });
  await t.ok('POST', '/api/orders', buyer, { listing_id: lst2.id, quantity: 20 });
  const mine = await t.ok('GET', '/api/promotions/mine', farmer2);
  const perf = mine[0].performance;
  assert.equal(perf.impressions, 1);
  assert.equal(perf.views, 1);
  assert.equal(perf.enquiries, 1);
  assert.equal(perf.orders, 1);
  assert.equal(perf.revenue_paise, 350000);
  assert.equal(t.db.one('SELECT category FROM revenue_records WHERE invoice_id = ?', pur.invoice.id).category, 'featured_listing');

  t.clock.set(start + 3 * DAY + 60000);
  await t.runJobs(owner);
  assert.equal((await t.ok('GET', '/api/promotions/mine', await t.login('f2@x.in', 'password-123')))[0].status, 'expired');
});

test('promotion credits from the plan are consumed before paying, and reset per cycle', async () => {
  const g = await t.register('farmer', 'credits@x.in');
  await t.ok('POST', '/api/subscription/checkout', g, { plan_code: 'farmer_growth', frequency: 'monthly' }); // 14-day trial
  const l = await t.ok('POST', '/api/listings', g, { product_name: 'Basil', quantity: 50, price_per_unit_paise: 40000 });
  const r = await t.ok('POST', '/api/promotions/purchase', g, { listing_id: l.id, promotion_code: 'featured_7d', use_credits: true });
  assert.equal(r.activated, true);
  assert.equal(r.purchase.paid_with, 'plan_credits');
  const d = await t.ok('GET', '/api/subscription', g);
  assert.equal(d.promotion_credits.plan_used, 4);
  assert.equal(d.promotion_credits.plan_remaining, 1);
  const l2 = await t.ok('POST', '/api/listings', g, { product_name: 'Mint', quantity: 50, price_per_unit_paise: 30000 });
  const no = await t.api('POST', '/api/promotions/purchase', g, { listing_id: l2.id, promotion_code: 'featured_3d', use_credits: true });
  assert.equal(no.status, 402);
});

test('platform-assisted procurement: request → sourcing → farmer confirmation → proposal → orders → fee invoice → revenue', async () => {
  const exp = await t.register('buyer', 'exporter@x.in', { business_type: 'exporter' });
  const est = await t.ok('POST', '/api/procurement/estimate', exp, { quantity: 2000, target_price_paise: 18000 });
  assert.equal(est.estimated_fee_paise, 1080000); // 3% of ₹3,60,000
  const req = await t.ok('POST', '/api/procurement', exp, { product_name: 'Oyster Mushrooms', category_id: 1, quantity: 1000, required_by: '2026-12-01', delivery_location: 'Mumbai', delivery_region: 'MH', sourcing_mode: 'assisted' });
  assert.equal(req.status, 'submitted');
  await t.ok('POST', `/api/admin/procurement/${req.id}/review`, admin, { accept: true });
  const sugg = await t.ok('GET', `/api/admin/procurement/${req.id}/suppliers`, admin);
  assert.ok(sugg.length >= 2);
  assert.equal(sugg[0].region, 'MH', 'suppliers in the delivery region rank first');
  await t.ok('POST', `/api/admin/procurement/${req.id}/lines`, admin, { listing_id: lst.id, quantity: 600 });
  await t.ok('POST', `/api/admin/procurement/${req.id}/lines`, admin, { listing_id: lst2.id, quantity: 400 });
  assert.equal((await t.api('POST', `/api/admin/procurement/${req.id}/proposal`, admin, {})).status, 409, 'needs a confirmed supplier');
  for (const [tok] of [[farmer], [farmer2]]) {
    const reqs = await t.ok('GET', '/api/supply-requests', tok);
    await t.ok('POST', `/api/supply-requests/${reqs[0].id}/respond`, tok, { confirm: true });
  }
  await t.ok('POST', `/api/admin/procurement/${req.id}/proposal`, admin, { notes: 'Two suppliers, 1000kg' });
  const approved = await t.ok('POST', `/api/procurement/${req.id}/approve`, exp, {});
  assert.equal(approved.status, 'fulfilling');
  const orders = t.db.all('SELECT * FROM orders WHERE procurement_service_id = ?', req.id);
  assert.equal(orders.length, 2);
  await complete(orders[0].id, farmer, exp);
  await complete(orders[1].id, farmer2, exp);
  const done = (await t.ok('GET', '/api/procurement', exp)).find((x) => x.id === req.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.fee.fee_paise, Math.round((600 * 18000 + 400 * 17500) * 0.03));
  assert.equal(done.fee.status, 'invoiced');
  await t.payInvoice(exp, done.fee.invoice_id);
  assert.equal(t.db.one('SELECT category FROM revenue_records WHERE invoice_id = ?', done.fee.invoice_id).category, 'procurement_service');
});

test('logistics: platform-arranged delivery earns a coordination fee recognised at delivery', async () => {
  const o = await t.ok('POST', '/api/orders', buyer, { listing_id: lst.id, quantity: 10, delivery_mode: 'platform_arranged', delivery_address: 'Bengaluru' });
  const prov = await t.ok('POST', '/api/admin/logistics/providers', admin, { name: 'Speedy Reefers', vehicle_types: 'reefer', regions: 'KA' });
  const lt = await t.ok('POST', `/api/admin/logistics/${o.id}/schedule`, admin, { provider_id: prov.id, vehicle: 'KA01 AB 1234', transport_charge_paise: 200000 });
  assert.equal(lt.platform_fee_paise, 10000 + 4900); // 5% + ₹49
  await t.ok('POST', `/api/admin/logistics/${o.id}/status`, admin, { status: 'picked_up' });
  await t.ok('POST', `/api/admin/logistics/${o.id}/status`, admin, { status: 'delivered' });
  const rr = t.db.one("SELECT * FROM revenue_records WHERE category = 'logistics_commission' AND order_id = ?", o.id);
  assert.equal(rr.amount_paise, 14900);
});

test('advertising: review → invoice → verified payment → served with Sponsored label', async () => {
  const adv = await t.register('advertiser', 'ads@x.in');
  const now = Date.now();
  assert.equal((await t.api('POST', '/api/ads', adv, { title: 'Crypto!', body: 'x', ad_category: 'crypto', start_at: new Date(now).toISOString(), end_at: new Date(now + 3 * DAY).toISOString() })).status, 400, 'non-agricultural ads are refused');
  const ad = await t.ok('POST', '/api/ads', adv, { title: 'Cold storage in Bengaluru', body: '2–8°C rooms by the day', ad_category: 'cold_storage', placement: 'marketplace', cta_url: 'https://example.com', start_at: new Date(now - 60000).toISOString(), end_at: new Date(now + 3 * DAY).toISOString() });
  await t.ok('POST', `/api/ads/${ad.id}/submit`, adv);
  const reviewed = await t.ok('POST', `/api/admin/ads/${ad.id}/review`, admin, { approve: true });
  assert.equal(reviewed.status, 'approved');
  let s = await t.ok('GET', '/api/marketplace/search', buyer);
  assert.equal(s.sponsored_content.length, 0, 'unpaid ads never run');
  await t.payInvoice(adv, reviewed.invoice_id);
  s = await t.ok('GET', '/api/marketplace/search', buyer);
  assert.equal(s.sponsored_content[0].label, 'Sponsored');
  assert.equal(t.db.one('SELECT category FROM revenue_records WHERE invoice_id = ?', reviewed.invoice_id).category, 'advertising');
});

test('referrals: referee eligibility triggers rewards for both sides; self-device referrals are rejected', async () => {
  const code = (await t.ok('GET', '/api/referrals', farmer)).code;
  const referee = await t.register('farmer', 'ref1@x.in', { referral_code: code });
  // registration from the same IP as the referrer is treated as same-device and rejected
  assert.equal(t.db.one('SELECT status, rejection_reason FROM referrals ORDER BY id DESC LIMIT 1').rejection_reason, 'same_device_or_network');
  // simulate a genuine referral from another network
  t.db.run("UPDATE users SET signup_ip = '10.9.9.9' WHERE email = 'f1@x.in'");
  const referee2 = await t.register('farmer', 'ref2@x.in', { referral_code: code });
  assert.equal(t.db.one('SELECT status FROM referrals ORDER BY id DESC LIMIT 1').status, 'registered');
  await t.ok('POST', '/api/listings', referee2, { product_name: 'Kale', quantity: 10, price_per_unit_paise: 9000 });
  const ref = t.db.one('SELECT * FROM referrals ORDER BY id DESC LIMIT 1');
  assert.equal(ref.status, 'rewarded');
  assert.equal((await t.ok('GET', '/api/subscription', farmer)).promotion_credits.bonus_credits, 2);
  assert.equal((await t.ok('GET', '/api/subscription', referee2)).promotion_credits.bonus_credits, 1);
  assert.ok(referee);
});

test('refunds: admin requests, owner authorises (four-eyes), revenue reversed; financial records cannot be deleted', async () => {
  const f = await t.register('farmer', 'refund@x.in');
  const p = (await t.ok('GET', '/api/owner/plans', owner)).find((x) => x.code === 'farmer_pro');
  await t.ok('PUT', `/api/owner/plans/${p.id}`, owner, { trial_days: 0, change_scope: 'new_only' });
  const co = await t.ok('POST', '/api/subscription/checkout', f, { plan_code: 'farmer_pro', frequency: 'monthly' });
  await t.payInvoice(f, co.invoice.id);
  const pay = t.db.one('SELECT * FROM payments WHERE invoice_id = ? AND status = ?', co.invoice.id, 'captured');

  assert.equal((await t.api('GET', '/api/owner/revenue', admin)).status, 403, 'admins cannot see owner revenue');
  assert.equal((await t.api('POST', `/api/owner/plans/${p.id}/status`, admin, { status: 'inactive' })).status, 403);
  const rf = await t.ok('POST', '/api/admin/refunds', admin, { payment_id: pay.id, amount_paise: 58941, reason: 'Goodwill — onboarding issue' });
  assert.equal((await t.api('POST', `/api/owner/refunds/${rf.id}/decision`, admin, { approve: true })).status, 403, 'admins cannot authorise refunds');
  const done = await t.ok('POST', `/api/owner/refunds/${rf.id}/decision`, owner, { approve: true, notes: 'ok' });
  assert.equal(done.status, 'processed');
  const inv = t.db.one('SELECT * FROM invoices WHERE id = ?', co.invoice.id);
  assert.equal(inv.status, 'partially_refunded');
  const rev = t.db.one("SELECT SUM(amount_paise) s FROM revenue_records WHERE invoice_id = ?", co.invoice.id).s;
  assert.equal(rev, 99900 - 49950);
  // owner cannot approve own request
  const own = await t.ok('POST', '/api/admin/refunds', owner, { payment_id: pay.id, amount_paise: 100, reason: 'test' });
  assert.equal((await t.api('POST', `/api/owner/refunds/${own.id}/decision`, owner, { approve: true })).status, 400);

  assert.throws(() => t.db.run('DELETE FROM payments WHERE id = ?', pay.id), /cannot be deleted/);
  assert.throws(() => t.db.run('DELETE FROM invoices WHERE id = ?', co.invoice.id), /cannot be deleted/);
  assert.throws(() => t.db.run('UPDATE revenue_records SET amount_paise = 1'), /append-only/);
  assert.throws(() => t.db.run('UPDATE invoices SET total_paise = 1 WHERE id = ?', co.invoice.id), /immutable/);
  const log = await t.ok('GET', '/api/owner/audit-log', owner);
  assert.equal(log.chain.ok, true);
  assert.ok(log.entries.some((e) => e.action === 'refund.approved'));
});

test('owner dashboards: overview, revenue by category/plan/region with filters, subscription analytics, CSV export', async () => {
  const ov = await t.ok('GET', '/api/owner/overview', owner);
  assert.ok(ov.users.total_farmers >= 3);
  assert.ok(ov.revenue.total_paise > 0);
  assert.ok(ov.revenue.mrr_paise > 0);
  const rv = await t.ok('GET', '/api/owner/revenue?granularity=day', owner);
  const cats = rv.totals.by_category.map((c) => c.category);
  for (const c of ['farmer_subscription', 'buyer_subscription', 'featured_listing', 'procurement_service', 'logistics_commission', 'advertising', 'transaction_commission']) assert.ok(cats.includes(c), c);
  assert.ok(rv.by_plan.length > 0);
  assert.equal(rv.forecast.projection.length, 3);
  const onlyAds = await t.ok('GET', '/api/owner/revenue?category=advertising', owner);
  assert.equal(onlyAds.totals.by_category.length, 1);
  const sa = await t.ok('GET', '/api/owner/subscription-analytics', owner);
  assert.ok(sa.totals.paying_subscriptions >= 1);
  assert.ok(Array.isArray(sa.insights.likely_to_upgrade));
  const csv = await t.api('GET', '/api/owner/export/revenue.csv', owner);
  assert.match(csv.body, /^id,recognised_at,category/);
});
