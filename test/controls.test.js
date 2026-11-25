'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');

let t; let owner; let admin;
before(async () => {
  t = await setup();
  owner = await t.login('owner@agriconnect.local', 'owner-pass-123');
  admin = await t.login('admin@agriconnect.local', 'admin-pass-123');
});
after(() => t.close());

test('without payment credentials, paid checkout is refused (no simulated success) while free plans keep working', async () => {
  const f = await t.register('farmer', 'nokeys@x.in');
  const p = (await t.ok('GET', '/api/owner/plans', owner)).find((x) => x.code === 'farmer_pro');
  await t.ok('PUT', `/api/owner/plans/${p.id}`, owner, { trial_days: 0, change_scope: 'new_only' });
  const co = await t.ok('POST', '/api/subscription/checkout', f, { plan_code: 'farmer_pro', frequency: 'monthly' });
  const saved = process.env.RAZORPAY_KEY_SECRET;
  delete process.env.RAZORPAY_KEY_SECRET;
  try {
    const r = await t.api('POST', '/api/payments/checkout', f, { invoice_id: co.invoice.id });
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, 'payments_unavailable');
    const wh = await t.webhook('payment.captured', 'payment', { id: 'pay_x', order_id: 'order_x', amount: 1, currency: 'INR', status: 'captured' });
    assert.equal(wh.status, 400, 'webhooks cannot be verified without a secret');
  } finally { process.env.RAZORPAY_KEY_SECRET = saved; }
  assert.equal((await t.ok('GET', '/api/subscription', f)).subscription.plan_code, 'farmer_starter');
  const listing = await t.ok('POST', '/api/listings', f, { product_name: 'Spinach', quantity: 10, price_per_unit_paise: 4000 });
  assert.equal(listing.status, 'active');
});

test('reconciliation detects a capture the platform missed and repairs it on request', async () => {
  const b = await t.register('buyer', 'recon@x.in');
  const p = (await t.ok('GET', '/api/owner/plans', owner)).find((x) => x.code === 'buyer_pro');
  await t.ok('PUT', `/api/owner/plans/${p.id}`, owner, { trial_days: 0, change_scope: 'new_only' });
  const co = await t.ok('POST', '/api/subscription/checkout', b, { plan_code: 'buyer_pro', frequency: 'monthly' });
  const pc = await t.ok('POST', '/api/payments/checkout', b, { invoice_id: co.invoice.id });
  t.rzp.pay(pc.checkout.order_id); // customer paid, but neither callback nor webhook reached us
  const from = new Date(Date.now() - 86400000).toISOString();
  const to = new Date(Date.now() + 86400000).toISOString();
  const report = await t.ok('POST', '/api/admin/reconcile', admin, { from, to });
  assert.equal(report.issues[0].type, 'missed_capture');
  assert.equal((await t.ok('GET', '/api/subscription', b)).subscription.plan_code, 'buyer_free');
  const fixed = await t.ok('POST', '/api/admin/reconcile', admin, { from, to, repair: true });
  assert.equal(fixed.issues[0].repaired, true);
  assert.equal((await t.ok('GET', '/api/subscription', b)).subscription.plan_code, 'buyer_pro');
});

test('staff team members cannot change billing; team size is limited by plan', async () => {
  const f = await t.register('farmer', 'team@x.in');
  const add = await t.api('POST', '/api/team', f, { email: 'staff@x.in', name: 'Staff', password: 'password-123' });
  assert.equal(add.status, 402, 'Starter allows a single user');
  const p = (await t.ok('GET', '/api/owner/plans', owner)).find((x) => x.code === 'farmer_pro');
  const co = await t.ok('POST', '/api/subscription/checkout', f, { plan_code: 'farmer_pro', frequency: 'monthly' });
  await t.payInvoice(f, co.invoice.id);
  await t.ok('POST', '/api/team', f, { email: 'staff@x.in', name: 'Staff', password: 'password-123' });
  const staff = await t.login('staff@x.in', 'password-123');
  assert.equal((await t.api('POST', '/api/subscription/cancel', staff, {})).status, 403);
  assert.ok((await t.ok('POST', '/api/listings', staff, { product_name: 'Enoki', quantity: 5, price_per_unit_paise: 50000 })).id, 'staff can manage inventory');
  assert.ok(p);
});

test('invoice download renders a tax invoice; users cannot read other accounts\' invoices', async () => {
  const f = await t.register('farmer', 'inv@x.in');
  const co = await t.ok('POST', '/api/subscription/checkout', f, { plan_code: 'farmer_pro', frequency: 'annual' });
  const html = await t.api('GET', `/api/billing/invoices/${co.invoice.id}/download`, f);
  assert.match(html.body, /Tax Invoice/);
  assert.match(html.body, /GST @ 18%/);
  const other = await t.register('farmer', 'other@x.in');
  assert.equal((await t.api('GET', `/api/billing/invoices/${co.invoice.id}`, other)).status, 404);
});
