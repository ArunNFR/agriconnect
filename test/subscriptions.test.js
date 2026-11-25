'use strict';
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, DAY } = require('./helpers');

let t; let owner; let admin;
before(async () => {
  t = await setup();
  owner = await t.login('owner@agriconnect.local', 'owner-pass-123');
  admin = await t.login('admin@agriconnect.local', 'admin-pass-123');
  // Owner removes the trial on Farmer Pro and Buyer Pro so the paid path can be tested directly (also exercises plan editing)
  for (const code of ['farmer_pro', 'buyer_pro']) {
    const p = (await t.ok('GET', '/api/owner/plans', owner)).find((x) => x.code === code);
    await t.ok('PUT', `/api/owner/plans/${p.id}`, owner, { trial_days: 0, change_scope: 'new_only' });
  }
});
after(() => t.close());
afterEach(() => t.clock.reset());

const listing = (n) => ({ product_name: `Oyster ${n}`, quantity: 100, price_per_unit_paise: 18000, category_id: 1 });

test('free farmer: registers without payment and is limited to 5 active listings (backend-enforced)', async () => {
  const f = await t.register('farmer', 'free1@x.in');
  const d = await t.ok('GET', '/api/subscription', f);
  assert.equal(d.subscription.plan_code, 'farmer_starter');
  assert.equal(d.subscription.status, 'active');
  assert.equal(d.subscription.payment_status, 'not_required');
  for (let i = 0; i < 5; i++) await t.ok('POST', '/api/listings', f, listing(i));
  const sixth = await t.api('POST', '/api/listings', f, listing(6));
  assert.equal(sixth.status, 402);
  assert.equal(sixth.body.error.code, 'upgrade_required');
  assert.equal(sixth.body.error.details.entitlement, 'max_active_listings');
  assert.ok(sixth.body.error.details.upgrade_options.some((o) => o.code === 'farmer_growth'));
  // editing existing listings is still allowed
  const mine = await t.ok('GET', '/api/listings/mine', f);
  const edited = await t.ok('PUT', `/api/listings/${mine[0].id}`, f, { price_per_unit_paise: 19000 });
  assert.equal(edited.price_per_unit_paise, 19000);
  // creating it inactive is fine, re-activating hits the limit
  const inactive = await t.ok('POST', '/api/listings', f, { ...listing(7), status: 'inactive' });
  assert.equal((await t.api('PUT', `/api/listings/${inactive.id}`, f, { status: 'active' })).status, 402);
  const usage = await t.ok('GET', '/api/subscription/usage', f);
  assert.deepEqual(usage.metrics.find((m) => m.key === 'max_active_listings').used, 5);
});

test('paid upgrade activates ONLY after verified payment; bad signatures and failures do not activate', async () => {
  const f = await t.register('farmer', 'pro1@x.in');
  const quote = await t.ok('POST', '/api/subscription/quote', f, { plan_code: 'farmer_pro', frequency: 'monthly' });
  assert.equal(quote.subtotal_paise, 99900);
  assert.equal(quote.tax_paise, 17982);
  assert.equal(quote.total_paise, 117882);
  const co = await t.ok('POST', '/api/subscription/checkout', f, { plan_code: 'farmer_pro', frequency: 'monthly' });
  assert.equal(co.requires_payment, true);
  assert.equal(co.invoice.total_paise, 117882);
  assert.equal((await t.ok('GET', '/api/subscription', f)).subscription.plan_code, 'farmer_starter', 'not activated before payment');

  const pc = await t.ok('POST', '/api/payments/checkout', f, { invoice_id: co.invoice.id });
  assert.equal(pc.checkout.amount, 117882);
  // forged frontend confirmation
  const forged = await t.api('POST', '/api/payments/verify', f, { razorpay_order_id: pc.checkout.order_id, razorpay_payment_id: 'pay_fake', razorpay_signature: 'deadbeef' });
  assert.equal(forged.status, 400);
  // valid signature but the bank declined
  const failed = await t.api('POST', '/api/payments/verify', f, t.rzp.pay(pc.checkout.order_id, { status: 'failed' }));
  assert.equal(failed.body.status, 'failed');
  assert.equal((await t.ok('GET', '/api/subscription', f)).subscription.plan_code, 'farmer_starter');
  const notes = await t.ok('GET', '/api/notifications', f);
  assert.ok(notes.some((n) => n.type === 'payment_failed'));

  // retry succeeds
  const okRes = await t.ok('POST', '/api/payments/verify', f, t.rzp.pay(pc.checkout.order_id, { method: 'card' }));
  assert.equal(okRes.status, 'captured');
  const d = await t.ok('GET', '/api/subscription', f);
  assert.equal(d.subscription.plan_code, 'farmer_pro');
  assert.equal(d.subscription.status, 'active');
  assert.ok(d.payment_methods.some((m) => m.label.includes('1111')));
  for (let i = 0; i < 8; i++) await t.ok('POST', '/api/listings', f, listing(i)); // unlimited now
  assert.ok((await t.ok('GET', '/api/notifications', f)).some((n) => n.type === 'subscription_activated'));
  const rev = t.db.all("SELECT * FROM revenue_records WHERE invoice_id = ?", co.invoice.id);
  assert.equal(rev.length, 1);
  assert.equal(rev[0].category, 'farmer_subscription');
  assert.equal(rev[0].amount_paise, 99900);
  assert.equal(rev[0].tax_paise, 17982);
});

test('webhooks: signature required, duplicate events are idempotent, second capture triggers duplicate-payment refund request', async () => {
  const b = await t.register('buyer', 'wh1@x.in');
  const co = await t.ok('POST', '/api/subscription/checkout', b, { plan_code: 'buyer_pro', frequency: 'monthly' });
  const pc = await t.ok('POST', '/api/payments/checkout', b, { invoice_id: co.invoice.id });
  const cb = t.rzp.pay(pc.checkout.order_id);
  const entity = t.rzp.payments[cb.razorpay_payment_id];
  const forged = await t.webhook('payment.captured', 'payment', entity, { secret: 'wrong' });
  assert.equal(forged.status, 400);
  assert.equal((await t.ok('GET', '/api/subscription', b)).subscription.plan_code, 'buyer_free');

  const w1 = await t.webhook('payment.captured', 'payment', entity, { eventId: 'evt_A' });
  assert.equal(w1.status, 200);
  assert.equal((await t.ok('GET', '/api/subscription', b)).subscription.plan_code, 'buyer_pro');
  await t.webhook('payment.captured', 'payment', entity, { eventId: 'evt_A' }); // replay
  await t.webhook('order.paid', 'payment', entity); // different event, same payment
  await t.api('POST', '/api/payments/verify', b, cb); // browser callback arrives late
  assert.equal(t.db.one('SELECT COUNT(*) c FROM revenue_records WHERE invoice_id = ?', co.invoice.id).c, 1, 'revenue booked once');

  // a second, different payment captured on the same order
  const cb2 = t.rzp.pay(pc.checkout.order_id);
  await t.webhook('payment.captured', 'payment', t.rzp.payments[cb2.razorpay_payment_id]);
  const refund = t.db.one("SELECT * FROM refunds WHERE reason LIKE 'Duplicate payment%'");
  assert.ok(refund, 'automatic refund request raised');
  assert.equal(refund.status, 'requested');
  assert.equal(t.db.one('SELECT COUNT(*) c FROM revenue_records WHERE invoice_id = ?', co.invoice.id).c, 1);
  assert.ok(t.db.one("SELECT 1 FROM risk_flags WHERE flag_type = 'duplicate_payment'"));
});

test('idempotency key replays checkout instead of creating a second invoice', async () => {
  const f = await t.register('farmer', 'idem@x.in');
  const h = { 'idempotency-key': 'abc-123' };
  const a = await t.api('POST', '/api/subscription/checkout', f, { plan_code: 'farmer_pro', frequency: 'monthly' }, h);
  const b = await t.api('POST', '/api/subscription/checkout', f, { plan_code: 'farmer_pro', frequency: 'monthly' }, h);
  assert.equal(a.body.invoice.id, b.body.invoice.id);
  assert.equal(b.headers.get('idempotent-replay'), 'true');
  const c = await t.api('POST', '/api/subscription/checkout', f, { plan_code: 'farmer_pro', frequency: 'annual' }, h);
  assert.equal(c.status, 409);
});

test('trial → renewal invoice & reminders → unpaid → grace → suspended (data kept) → pay → restored', async () => {
  const start = Date.now();
  t.clock.set(start);
  const f = await t.register('farmer', 'trial@x.in');
  const co = await t.ok('POST', '/api/subscription/checkout', f, { plan_code: 'farmer_growth', frequency: 'monthly' });
  assert.equal(co.trial, true);
  for (let i = 0; i < 12; i++) await t.ok('POST', '/api/listings', f, listing(i));
  let d = await t.ok('GET', '/api/subscription', f);
  assert.equal(d.subscription.status, 'trial');

  t.clock.set(start + 8 * DAY); // 6 days before trial end
  await t.runJobs(owner);
  d = await t.ok('GET', '/api/subscription', f);
  assert.equal(d.open_invoices.length, 1, 'renewal invoice issued ahead of trial end');
  assert.ok((await t.ok('GET', '/api/notifications', f)).some((n) => n.type === 'renewal_reminder' || n.type === 'renewal_invoice'));

  t.clock.set(start + 15 * DAY); // trial over, unpaid
  await t.runJobs(owner);
  d = await t.ok('GET', '/api/subscription', f);
  assert.equal(d.subscription.status, 'past_due');
  assert.equal(d.subscription.access, 'full', 'grace period keeps features');

  t.clock.set(start + 19 * DAY); // trial grace (3 days) expired
  await t.runJobs(owner);
  d = await t.ok('GET', '/api/subscription', f);
  assert.equal(d.subscription.status, 'suspended');
  assert.equal(d.subscription.access, 'free_fallback');
  const mine = await t.ok('GET', '/api/listings/mine', f);
  assert.equal(mine.length, 12, 'no listings deleted');
  assert.equal(mine.filter((l) => l.status === 'active').length, 5);
  assert.equal(mine.filter((l) => l.deactivated_reason === 'plan_limit').length, 7);
  assert.equal((await t.api('POST', '/api/listings', f, listing(99))).status, 402);

  const r = await t.payInvoice(f, d.open_invoices[0].id);
  assert.equal(r.body.status, 'captured');
  d = await t.ok('GET', '/api/subscription', f);
  assert.equal(d.subscription.status, 'active');
  assert.equal(d.subscription.access, 'full');
  t.clock.reset();
});

test('renewal paid in advance rolls into the next period; cancel at period end falls back to free', async () => {
  const start = Date.now();
  t.clock.set(start);
  const f = await t.register('farmer', 'renew@x.in');
  const co = await t.ok('POST', '/api/subscription/checkout', f, { plan_code: 'farmer_pro', frequency: 'monthly' });
  await t.payInvoice(f, co.invoice.id);
  let d = await t.ok('GET', '/api/subscription', f);
  const end1 = d.subscription.current_period_end;

  t.clock.set(new Date(end1).getTime() - 5 * DAY);
  await t.runJobs(owner);
  d = await t.ok('GET', '/api/subscription', f);
  await t.payInvoice(f, d.open_invoices[0].id);
  t.clock.set(new Date(end1).getTime() + 3600000);
  await t.runJobs(owner);
  d = await t.ok('GET', '/api/subscription', f);
  assert.equal(d.subscription.status, 'active');
  assert.equal(d.subscription.current_period_start, end1);
  assert.ok((await t.ok('GET', '/api/subscription/history', f)).some((h) => h.event === 'renewed'));

  await t.ok('POST', '/api/subscription/cancel', f, { reason: 'seasonal' });
  d = await t.ok('GET', '/api/subscription', f);
  assert.equal(d.subscription.cancel_at_period_end, true);
  assert.equal(d.subscription.plan_code, 'farmer_pro', 'access continues until period end');
  t.clock.set(new Date(d.subscription.current_period_end).getTime() + 60000);
  await t.runJobs(owner);
  const f2 = await t.login('renew@x.in', 'password-123'); // idle > 30 days → session expired by design
  d = await t.ok('GET', '/api/subscription', f2);
  assert.equal(d.subscription.plan_code, 'farmer_starter');
  t.clock.reset();
});

test('upgrade gives proration credit; downgrade is scheduled for period end', async () => {
  const b = await t.register('buyer', 'updown@x.in');
  // Business has a trial; remove trial eligibility by going Pro paid first
  const co = await t.ok('POST', '/api/subscription/checkout', b, { plan_code: 'buyer_pro', frequency: 'monthly' });
  await t.payInvoice(b, co.invoice.id);
  const down = await t.ok('POST', '/api/subscription/checkout', b, { plan_code: 'buyer_business', frequency: 'monthly' });
  assert.equal(down.scheduled, true);
  const d = await t.ok('GET', '/api/subscription', b);
  assert.equal(d.subscription.plan_code, 'buyer_pro');
  assert.equal(d.subscription.scheduled_change.plan, 'Buyer Business');
  // revert via renew, then upgrade to annual Pro?  same plan → frequency change scheduled
  await t.ok('POST', '/api/subscription/renew', b);
  assert.equal((await t.ok('GET', '/api/subscription', b)).subscription.scheduled_change, null);

  const f = await t.register('farmer', 'prorate@x.in');
  const p = (await t.ok('GET', '/api/owner/plans', owner)).find((x) => x.code === 'farmer_growth');
  await t.ok('PUT', `/api/owner/plans/${p.id}`, owner, { trial_days: 0, change_scope: 'new_only' });
  const g = await t.ok('POST', '/api/subscription/checkout', f, { plan_code: 'farmer_growth', frequency: 'monthly' });
  await t.payInvoice(f, g.invoice.id);
  const q = await t.ok('POST', '/api/subscription/quote', f, { plan_code: 'farmer_pro', frequency: 'monthly' });
  assert.equal(q.action, 'upgrade');
  const credit = q.lines.find((l) => l.item_type === 'proration_credit');
  assert.ok(credit && -credit.unit_amount_paise > 49000, 'nearly the full Growth month is credited');
  await t.ok('PUT', `/api/owner/plans/${p.id}`, owner, { trial_days: 14, change_scope: 'new_only' });
});

test('discount codes are validated and reserved; new-customer-only codes are enforced', async () => {
  const code = await t.ok('POST', '/api/owner/discount-codes', owner, { code: 'LAUNCH50', discount_type: 'percent', value: 5000, applies_to: 'subscription', audience: 'buyer', max_redemptions: 1, new_customers_only: 1 });
  assert.equal(code.code, 'LAUNCH50');
  const b = await t.register('buyer', 'disc@x.in');
  const q = await t.ok('POST', '/api/subscription/quote', b, { plan_code: 'buyer_pro', frequency: 'monthly', discount_code: 'launch50' });
  assert.equal(q.discount.amount_paise, 124950);
  const co = await t.ok('POST', '/api/subscription/checkout', b, { plan_code: 'buyer_pro', frequency: 'monthly', discount_code: 'LAUNCH50' });
  assert.equal(co.invoice.discount_paise, 124950);
  const b2 = await t.register('buyer', 'disc2@x.in');
  const used = await t.api('POST', '/api/subscription/quote', b2, { plan_code: 'buyer_pro', frequency: 'monthly', discount_code: 'LAUNCH50' });
  assert.equal(used.status, 400);
  const farmer = await t.register('farmer', 'disc3@x.in');
  assert.equal((await t.api('POST', '/api/subscription/quote', farmer, { plan_code: 'farmer_pro', frequency: 'monthly', discount_code: 'LAUNCH50' })).status, 400);
});

test('owner plan lifecycle: create draft → publish → edit with scope → deactivate → delete/archive', async () => {
  const plan = await t.ok('POST', '/api/owner/plans', owner, {
    code: 'farmer_seasonal', audience: 'farmer', name: 'Farmer Seasonal', description: 'Harvest season pass', tier_rank: 1, pricing_model: 'fixed',
    prices: [{ billing_frequency: 'quarterly', price_paise: 99900 }], features: ['15 listings'], entitlements: { max_active_listings: 15, featured_listing_credits: 2 },
  });
  assert.equal(plan.status, 'draft');
  assert.ok(!(await t.ok('GET', '/api/plans?audience=farmer')).some((p) => p.code === 'farmer_seasonal'), 'drafts are not visible');
  await t.ok('POST', `/api/owner/plans/${plan.id}/publish`, owner);
  assert.ok((await t.ok('GET', '/api/plans?audience=farmer')).some((p) => p.code === 'farmer_seasonal'));

  const f = await t.register('farmer', 'seasonal@x.in');
  const co = await t.ok('POST', '/api/subscription/checkout', f, { plan_code: 'farmer_seasonal', frequency: 'quarterly' });
  await t.payInvoice(f, co.invoice.id);
  // edit requires a scope now that it has subscribers
  assert.equal((await t.api('PUT', `/api/owner/plans/${plan.id}`, owner, { entitlements: { max_active_listings: 20 } })).status, 400);
  const impact = await t.ok('POST', `/api/owner/plans/${plan.id}/impact`, owner, { prices: [{ billing_frequency: 'quarterly', price_paise: 129900 }], entitlements: { max_active_listings: 10 } });
  assert.equal(impact.active_subscribers, 1);
  assert.equal(impact.entitlement_reductions[0].key, 'max_active_listings');
  await t.ok('PUT', `/api/owner/plans/${plan.id}`, owner, { entitlements: { max_active_listings: 20 }, change_scope: 'immediate', change_summary: 'More listings' });
  let me = await t.ok('GET', '/api/me', f);
  assert.equal(me.entitlements.max_active_listings, 20, 'immediate scope updates existing subscribers');
  await t.ok('PUT', `/api/owner/plans/${plan.id}`, owner, { entitlements: { max_active_listings: 30 }, change_scope: 'new_only' });
  me = await t.ok('GET', '/api/me', f);
  assert.equal(me.entitlements.max_active_listings, 20, 'new_only scope leaves existing subscribers unchanged');
  assert.ok((await t.ok('GET', '/api/notifications', f)).some((n) => n.type === 'plan_changed'));

  await t.ok('POST', `/api/owner/plans/${plan.id}/status`, owner, { status: 'inactive' });
  assert.ok(!(await t.ok('GET', '/api/plans?audience=farmer')).some((p) => p.code === 'farmer_seasonal'));
  assert.equal((await t.api('POST', `/api/owner/plans/${plan.id}/delete`, owner)).status, 409, 'cannot delete with live subscribers');

  const unused = await t.ok('POST', '/api/owner/plans', owner, { code: 'buyer_tmp', audience: 'buyer', name: 'Tmp', tier_rank: 1, pricing_model: 'free' });
  assert.deepEqual(await t.ok('POST', `/api/owner/plans/${unused.id}/delete`, owner), { deleted: true });
});

test('enterprise custom pricing: enquiry → owner quote → verified payment → custom contract active', async () => {
  const b = await t.register('buyer', 'ent@x.in');
  assert.equal((await t.api('POST', '/api/subscription/checkout', b, { plan_code: 'buyer_enterprise' })).status, 400);
  const enq = await t.ok('POST', '/api/subscription/enterprise-enquiry', b, { plan_code: 'buyer_enterprise', requirements: '40 outlets, weekly mushrooms' });
  const q = await t.ok('POST', `/api/owner/enterprise-enquiries/${enq.id}/quote`, owner, { price_paise: 50000000, frequency: 'annual', entitlement_overrides: { max_users: 40 } });
  const r = await t.payInvoice(b, q.invoice.id);
  assert.equal(r.body.status, 'captured');
  const d = await t.ok('GET', '/api/subscription', b);
  assert.equal(d.subscription.plan_code, 'buyer_enterprise');
  assert.equal(d.subscription.is_custom_contract, true);
  assert.equal(t.db.one('SELECT category FROM revenue_records WHERE invoice_id = ?', q.invoice.id).category, 'enterprise_subscription');
});
