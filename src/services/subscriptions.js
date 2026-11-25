'use strict';
/**
 * Subscription lifecycle:
 *  select plan → checkout → payment → verified payment event → activation → entitlements
 *  → renewal invoice + reminders → renewal payment → continued access
 *  failure path: payment_failed → past_due (grace, access kept) → suspended (premium off) → expired
 * Data is never deleted: lapsed accounts fall back to the free plan, excess listings are
 * deactivated per the configurable downgrade policy, and orders keep processing.
 */
const db = require('../db');
const clock = require('../lib/clock');
const audit = require('../lib/audit');
const settings = require('../lib/settings');
const events = require('../lib/events');
const { notify, notifyPlatform } = require('../lib/notify');
const ent = require('./entitlements');
const plans = require('./plans');
const billing = require('./billing');
const discounts = require('./discounts');
const { bad, notFound, conflict, addMonths, addDays, rupees, parseJSON } = require('../lib/util');

const ACCESS = ent.ACCESS_STATUSES;

function hist(sub, event, extra = {}) {
  db.insert('subscription_history', {
    subscription_id: sub.id, account_id: sub.account_id, event,
    from_plan_id: extra.from_plan_id ?? sub.plan_id, to_plan_id: extra.to_plan_id ?? sub.plan_id,
    from_status: extra.from_status ?? sub.status, to_status: extra.to_status ?? sub.status,
    amount_paise: extra.amount ?? null, metadata_json: extra.meta ?? null, actor_user_id: extra.actor?.userId ?? null, created_at: clock.iso(),
  });
}
const getSub = (id) => db.one('SELECT * FROM subscriptions WHERE id = ?', id);
const planRow = (id) => db.one('SELECT * FROM subscription_plans WHERE id = ?', id);

function priceRow(planId, frequency) {
  const pr = db.one("SELECT * FROM plan_prices WHERE plan_id = ? AND billing_frequency = ? AND status = 'active'", planId, frequency);
  if (!pr) throw bad(`This plan is not available with ${frequency} billing`);
  return pr;
}

function newSubRow(accountId, plan, { status, price = null, extra = {} }) {
  const now = clock.iso();
  return db.insert('subscriptions', {
    account_id: accountId, plan_id: plan.id, plan_version: plan.version, plan_price_id: price?.id ?? null,
    billing_frequency: price?.billing_frequency ?? null, interval_months: price?.interval_months ?? null,
    price_paise: price ? price.price_paise : 0, status, is_current: 0, entitlements_json: ent.planEntitlements(plan.id),
    created_at: now, updated_at: now, ...extra,
  });
}

/** Make `newId` the account's current subscription, closing the previous one. */
function makeCurrent(accountId, newId, endStatus = 'cancelled') {
  const prev = db.one('SELECT * FROM subscriptions WHERE account_id = ? AND is_current = 1', accountId);
  if (prev && prev.id !== newId) {
    db.update('subscriptions', prev.id, { is_current: 0, status: ['pending'].includes(prev.status) ? 'expired' : endStatus, ended_at: clock.iso(), updated_at: clock.iso() });
    // Unpaid invoices of the superseded subscription are voided (never deleted)
    for (const inv of db.all("SELECT id FROM invoices WHERE subscription_id = ? AND status IN ('issued','overdue')", prev.id)) billing.voidInvoice(inv.id, 'system', 'Subscription superseded');
  }
  db.update('subscriptions', newId, { is_current: 1, previous_subscription_id: prev && prev.id !== newId ? prev.id : null, updated_at: clock.iso() });
  return prev;
}

/** Every farmer/buyer account starts on the default free plan without payment. */
function ensureDefault(accountId, actor = 'system') {
  const acct = db.one('SELECT * FROM accounts WHERE id = ?', accountId);
  if (!['farmer', 'buyer'].includes(acct.type)) return null;
  const cur = ent.currentSubscription(accountId);
  if (cur) return cur;
  const plan = ent.defaultPlan(acct.type);
  if (!plan) throw conflict(`No default ${acct.type} plan is configured`);
  const id = newSubRow(accountId, plan, { status: 'active', extra: { activated_at: clock.iso(), current_period_start: clock.iso() } });
  makeCurrent(accountId, id);
  hist(getSub(id), 'activated', { from_status: null, to_status: 'active', actor });
  return ent.currentSubscription(accountId);
}

function trialEligible(accountId, plan) {
  if (!plan.trial_days) return false;
  const prior = db.one("SELECT COUNT(*) c FROM subscriptions s JOIN subscription_plans p ON p.id = s.plan_id WHERE s.account_id = ? AND (s.trial_ends_at IS NOT NULL OR (p.pricing_model != 'free' AND s.status != 'pending' AND s.status != 'expired'))", accountId).c;
  return prior === 0;
}

function classify(cur, plan) {
  if (!cur || !ACCESS.includes(cur.status)) return 'new';
  if (cur.plan_id === plan.id) return 'same';
  return plan.tier_rank > cur.tier_rank ? 'upgrade' : 'downgrade';
}

/** Remaining value of the current paid cycle, credited on upgrade. */
function prorationCredit(cur) {
  if (!cur || cur.status !== 'active' || !cur.price_paise || !cur.current_period_end) return 0;
  const cycle = db.one("SELECT * FROM billing_cycles WHERE subscription_id = ? AND status = 'paid' AND period_start <= ? AND period_end > ? ORDER BY cycle_number DESC LIMIT 1", cur.id, clock.iso(), clock.iso());
  if (!cycle) return 0;
  const total = new Date(cycle.period_end) - new Date(cycle.period_start);
  const left = new Date(cycle.period_end) - clock.now();
  return Math.max(0, Math.round((cycle.amount_paise * left) / total));
}

/** Price, discounts, credit and tax preview — shown before the user confirms. */
function quote(accountId, { plan_code, frequency = 'monthly', discount_code }) {
  const acct = db.one('SELECT * FROM accounts WHERE id = ?', accountId);
  const plan = db.one('SELECT * FROM subscription_plans WHERE code = ?', plan_code);
  if (!plan || plan.status !== 'active') throw notFound('Plan');
  if (plan.audience !== acct.type) throw bad(`This plan is for ${plan.audience}s`);
  const cur = ent.currentSubscription(accountId);
  const action = classify(cur, plan);
  const out = { plan: { id: plan.id, code: plan.code, name: plan.name, pricing_model: plan.pricing_model, tier_rank: plan.tier_rank }, action, frequency };
  if (plan.pricing_model === 'custom') return { ...out, timing: 'contact_sales', requires_quote: true };
  if (plan.pricing_model === 'free') return { ...out, timing: action === 'downgrade' && cur.price_paise > 0 && cur.status !== 'trial' ? 'period_end' : 'immediate', effective_at: action === 'downgrade' && cur.price_paise > 0 && cur.status !== 'trial' ? cur.current_period_end : clock.iso(), total_paise: 0, lines: [] };
  const price = priceRow(plan.id, frequency);
  if (action === 'same') {
    if (cur.billing_frequency === frequency) return { ...out, timing: 'none', message: 'You are already on this plan' };
    return { ...out, action: 'change_frequency', timing: 'period_end', effective_at: cur.current_period_end || cur.trial_ends_at };
  }
  if (action === 'downgrade' && cur.status !== 'trial') return { ...out, timing: 'period_end', effective_at: cur.current_period_end, recurring_price_paise: price.price_paise };
  const trial = (action === 'new' || (cur && cur.price_paise === 0)) && trialEligible(accountId, plan);
  const base = plans.effectivePrice(price);
  const lines = [{ description: `${plan.name} — ${frequency} subscription`, item_type: 'plan', unit_amount_paise: base, related_type: 'plan', related_id: plan.id }];
  if (base !== price.price_paise) lines[0].description += ` (${price.promo_label || 'promotional price'})`;
  const credit = action === 'upgrade' ? Math.min(prorationCredit(cur), base) : 0;
  if (credit) lines.push({ description: `Credit for unused time on ${cur.plan_name}`, item_type: 'proration_credit', unit_amount_paise: -credit });
  let discount = null;
  if (discount_code) {
    if (!plan.discount_eligible) throw bad('Discount codes cannot be used with this plan');
    discount = discounts.evaluate(discount_code, { accountId, audience: acct.type, planId: plan.id, frequency, purpose: 'subscription', amount: base - credit });
    if (discount.amount) lines.push({ description: `Discount ${discount.code.code}`, item_type: 'discount', unit_amount_paise: -discount.amount, related_type: 'discount_code', related_id: discount.code.id });
  }
  const tax = settings.get('tax');
  const subtotal = base;
  const reductions = credit + (discount?.amount || 0);
  const taxable = Math.max(0, subtotal - reductions);
  const taxPaise = Math.round((taxable * tax.rate_bps) / 10000);
  const accountCredit = Math.min(billing.accountCreditBalance(accountId), taxable);
  const taxAfterCredit = Math.round(((taxable - accountCredit) * tax.rate_bps) / 10000);
  return {
    ...out, timing: 'immediate', trial: trial ? { days: plan.trial_days, ends_at: addDays(clock.iso(), plan.trial_days) } : null,
    recurring_price_paise: price.price_paise, interval_months: price.interval_months, lines, subtotal_paise: subtotal, discount_paise: reductions,
    account_credit_paise: accountCredit, tax_label: tax.label, tax_rate_bps: tax.rate_bps, tax_paise: accountCredit ? taxAfterCredit : taxPaise,
    total_paise: trial ? 0 : taxable - accountCredit + (accountCredit ? taxAfterCredit : taxPaise),
    due_today_paise: trial ? 0 : taxable - accountCredit + (accountCredit ? taxAfterCredit : taxPaise),
    discount: discount ? { code: discount.code.code, amount_paise: discount.amount, cycles: discount.code.duration_cycles } : null,
  };
}

/** Steps 4–9 of the farmer/buyer workflow. Paid plans return an invoice that must be paid & verified. */
function checkout(accountId, actor, body) {
  const q = quote(accountId, body);
  const plan = planRow(q.plan.id);
  const cur = ent.currentSubscription(accountId);
  if (q.timing === 'contact_sales') throw bad('This plan has custom pricing. Submit an enterprise enquiry and our team will prepare a quote.');
  if (q.timing === 'none') throw conflict(q.message);
  const allowed = parseJSON(cur ? planRow(cur.plan_id)[q.action === 'downgrade' ? 'downgrade_to_json' : 'upgrade_to_json'] : '[]', []);
  if (cur && ['upgrade', 'downgrade'].includes(q.action) && allowed.length && !allowed.includes(plan.code)) throw bad(`Moving from ${cur.plan_name} to ${plan.name} is not an available ${q.action} path`);

  return db.tx(() => {
    // Abandon earlier unpaid checkouts
    for (const p of db.all("SELECT * FROM subscriptions WHERE account_id = ? AND status = 'pending' AND is_current = 0", accountId)) {
      for (const inv of db.all("SELECT id FROM invoices WHERE subscription_id = ? AND status IN ('issued','overdue')", p.id)) billing.voidInvoice(inv.id, actor, 'Replaced by a newer checkout');
      db.update('subscriptions', p.id, { status: 'expired', ended_at: clock.iso(), updated_at: clock.iso() });
    }

    if (q.action === 'change_frequency') {
      db.update('subscriptions', cur.id, { scheduled_plan_id: plan.id, scheduled_frequency: body.frequency, updated_at: clock.iso() });
      voidUpcomingRenewal(cur, actor, 'Billing frequency change scheduled');
      hist(cur, 'frequency_change_scheduled', { meta: { frequency: body.frequency }, actor });
      return { scheduled: true, effective_at: q.effective_at, subscription: dashboard(accountId) };
    }

    if (q.timing === 'period_end') { // downgrade of a paid, running subscription
      db.update('subscriptions', cur.id, { scheduled_plan_id: plan.id, scheduled_frequency: plan.pricing_model === 'free' ? null : body.frequency || cur.billing_frequency, updated_at: clock.iso() });
      voidUpcomingRenewal(cur, actor, 'Downgrade scheduled');
      hist(cur, 'downgrade_scheduled', { to_plan_id: plan.id, meta: { effective_at: cur.current_period_end }, actor });
      notify(accountId, 'downgrade_scheduled', 'Plan change scheduled', `Your plan will change from ${cur.plan_name} to ${plan.name} on ${fmtDate(cur.current_period_end)}. You keep ${cur.plan_name} features until then.`, { plan_id: plan.id });
      return { scheduled: true, effective_at: cur.current_period_end, subscription: dashboard(accountId) };
    }

    if (plan.pricing_model === 'free') {
      const id = newSubRow(accountId, plan, { status: 'active', extra: { activated_at: clock.iso(), current_period_start: clock.iso() } });
      makeCurrent(accountId, id, 'cancelled');
      hist(getSub(id), cur && cur.price_paise > 0 ? 'downgraded' : 'activated', { from_plan_id: cur?.plan_id, from_status: cur?.status, to_status: 'active', actor });
      const deactivated = applyLimitsPolicy(accountId);
      notify(accountId, 'subscription_activated', `${plan.name} plan active`, `You are now on the ${plan.name} plan.${deactivated.length ? ` ${deactivated.length} listing(s) above the plan limit were set inactive — nothing was deleted.` : ''}`);
      return { activated: true, subscription: dashboard(accountId) };
    }

    const price = priceRow(plan.id, body.frequency || 'monthly');
    const promoActive = plans.effectivePrice(price) !== price.price_paise;
    const extra = {
      discount_code_id: q.discount?.code ? db.one('SELECT id FROM discount_codes WHERE code = ?', q.discount.code).id : null,
      discount_cycles_remaining: q.discount ? q.discount.cycles : 0,
      promo_cycles_remaining: promoActive ? price.promo_cycles : 0,
    };

    if (q.trial) {
      const ends = q.trial.ends_at;
      const id = newSubRow(accountId, plan, { status: 'trial', price, extra: { ...extra, trial_ends_at: ends, current_period_start: clock.iso(), current_period_end: ends, next_billing_at: ends, activated_at: clock.iso() } });
      makeCurrent(accountId, id, 'cancelled');
      hist(getSub(id), 'trial_started', { from_plan_id: cur?.plan_id, from_status: cur?.status, to_status: 'trial', meta: { ends_at: ends }, actor });
      notify(accountId, 'trial_started', `Your ${plan.name} trial has started`, `Enjoy ${plan.name} features free until ${fmtDate(ends)}. Pay the first invoice before then to continue without interruption.`);
      events.emit('subscription.trial_started', { accountId, planId: plan.id });
      return { trial: true, trial_ends_at: ends, subscription: dashboard(accountId) };
    }

    const id = newSubRow(accountId, plan, { status: 'pending', price, extra });
    const sub = getSub(id);
    hist(sub, 'created', { from_plan_id: cur?.plan_id, from_status: null, to_status: 'pending', meta: { action: q.action, frequency: price.billing_frequency }, actor });
    const cycleId = db.insert('billing_cycles', { subscription_id: id, cycle_number: 1, period_start: clock.iso(), period_end: addMonths(clock.iso(), price.interval_months), amount_paise: q.subtotal_paise - q.discount_paise, status: 'invoiced', created_at: clock.iso() });
    const inv = billing.createInvoice({ accountId, type: 'subscription', items: q.lines, subscriptionId: id, billingCycleId: cycleId, relatedType: 'subscription', relatedId: id, actor });
    db.update('billing_cycles', cycleId, { invoice_id: inv.id });
    if (q.discount) discounts.reserve(extra.discount_code_id, accountId, inv.id, id, q.discount.amount_paise);
    if (inv.total_paise === 0) { billing.settleZeroInvoice(inv); return { activated: true, invoice: billing.getInvoice(inv.id), subscription: dashboard(accountId) }; }
    return { requires_payment: true, invoice: inv, subscription_id: id };
  });
}

function voidUpcomingRenewal(sub, actor, reason) {
  for (const c of db.all("SELECT * FROM billing_cycles WHERE subscription_id = ? AND status = 'invoiced' AND period_start >= ?", sub.id, sub.current_period_end || clock.iso())) {
    if (c.invoice_id) billing.voidInvoice(c.invoice_id, actor, reason);
  }
}

// ------------------------------------------------------------------ payment hooks
billing.on('paid', 'subscription', (inv) => {
  const sub = getSub(inv.subscription_id);
  const cycle = inv.billing_cycle_id ? db.one('SELECT * FROM billing_cycles WHERE id = ?', inv.billing_cycle_id) : null;
  const plan = planRow(sub.plan_id);
  const now = clock.iso();
  if (sub.status === 'pending') {
    const cur = ent.currentSubscription(sub.account_id);
    const end = addMonths(now, sub.interval_months || 1);
    db.update('subscriptions', sub.id, { status: 'active', activated_at: now, current_period_start: now, current_period_end: end, next_billing_at: end, updated_at: now,
      discount_cycles_remaining: Math.max(0, sub.discount_cycles_remaining - 1), promo_cycles_remaining: Math.max(0, sub.promo_cycles_remaining - 1) });
    if (cycle) db.update('billing_cycles', cycle.id, { period_start: now, period_end: end });
    makeCurrent(sub.account_id, sub.id, 'cancelled');
    const event = cur && ACCESS.includes(cur.status) && cur.price_paise > 0 ? (plan.tier_rank > cur.tier_rank ? 'upgraded' : 'downgraded') : 'activated';
    hist(getSub(sub.id), event, { from_plan_id: cur?.plan_id, from_status: 'pending', to_status: 'active', amount: inv.total_paise });
    if (sub.is_custom_contract) db.run("UPDATE enterprise_enquiries SET status = 'converted', updated_at = ? WHERE subscription_id = ?", now, sub.id);
    notify(sub.account_id, 'subscription_activated', `${plan.name} activated`, `Your ${plan.name} subscription is active until ${fmtDate(end)}. All plan features are now enabled.`, { subscription_id: sub.id });
    events.emit('subscription.paid', { accountId: sub.account_id, subscriptionId: sub.id });
    return;
  }
  if (['past_due', 'suspended'].includes(sub.status) && sub.is_current) {
    const end = addMonths(now, sub.interval_months || 1);
    const refreshed = refreshPatch(sub);
    db.update('subscriptions', sub.id, { status: 'active', grace_ends_at: null, current_period_start: now, current_period_end: end, next_billing_at: end, updated_at: now, ...refreshed });
    if (cycle) db.update('billing_cycles', cycle.id, { period_start: now, period_end: end });
    hist(sub, 'restored', { to_status: 'active', amount: inv.total_paise });
    notify(sub.account_id, 'subscription_restored', 'Subscription restored', `Thanks for your payment. ${plan.name} features are restored until ${fmtDate(end)}.`);
    events.emit('subscription.paid', { accountId: sub.account_id, subscriptionId: sub.id });
    return;
  }
  if (sub.status === 'payment_failed') db.update('subscriptions', sub.id, { status: 'active', updated_at: now });
  hist(sub, 'renewal_paid', { to_status: sub.status === 'payment_failed' ? 'active' : sub.status, amount: inv.total_paise, meta: { cycle: cycle?.cycle_number } });
  events.emit('subscription.paid', { accountId: sub.account_id, subscriptionId: sub.id });
});

billing.on('failed', 'subscription', (inv) => {
  const sub = getSub(inv.subscription_id);
  if (!sub || !sub.is_current) return;
  if (sub.status === 'active') { db.update('subscriptions', sub.id, { status: 'payment_failed', updated_at: clock.iso() }); hist(sub, 'payment_failed', { to_status: 'payment_failed' }); }
  else hist(sub, 'payment_failed', { to_status: sub.status });
});

billing.on('voided', 'subscription', (inv) => {
  const sub = getSub(inv.subscription_id);
  if (sub && sub.status === 'pending') db.update('subscriptions', sub.id, { status: 'expired', ended_at: clock.iso(), updated_at: clock.iso() });
});

function refreshPatch(sub) {
  if (!sub.refresh_on_renewal || sub.is_custom_contract) return {};
  const plan = planRow(sub.plan_id);
  const pr = db.one("SELECT * FROM plan_prices WHERE plan_id = ? AND billing_frequency = ? AND status = 'active'", sub.plan_id, sub.billing_frequency);
  return { entitlements_json: JSON.stringify(ent.planEntitlements(plan.id)), plan_version: plan.version, refresh_on_renewal: 0, ...(pr ? { price_paise: pr.price_paise, plan_price_id: pr.id } : {}) };
}

// ------------------------------------------------------------------ user actions
function cancel(accountId, actor, { reason } = {}) {
  return db.tx(() => {
    const cur = ent.currentSubscription(accountId);
    if (!cur || cur.pricing_model === 'free') throw bad('You are on a free plan — there is nothing to cancel');
    if (cur.status === 'trial' || ['past_due', 'suspended'].includes(cur.status)) {
      endToDefault(getSub(cur.id), 'cancelled', actor, reason);
      return dashboard(accountId);
    }
    if (cur.cancel_at_period_end) throw conflict('Cancellation is already scheduled');
    db.update('subscriptions', cur.id, { cancel_at_period_end: 1, cancel_reason: reason || null, cancelled_at: clock.iso(), updated_at: clock.iso() });
    voidUpcomingRenewal(cur, actor, 'Subscription cancelled');
    hist(cur, 'cancel_scheduled', { meta: { reason, effective_at: cur.current_period_end }, actor });
    notify(accountId, 'cancellation_scheduled', 'Cancellation confirmed', `Your ${cur.plan_name} subscription will end on ${fmtDate(cur.current_period_end)}. You keep all features until then, and your listings, orders and history stay safe afterwards.`);
    return dashboard(accountId);
  });
}

/** Renew: undo a scheduled cancellation, pay an overdue invoice, or pay the next cycle early. */
function renew(accountId, actor) {
  return db.tx(() => {
    const cur = ent.currentSubscription(accountId);
    if (!cur || cur.pricing_model === 'free') throw bad('Choose a paid plan to subscribe');
    if (cur.cancel_at_period_end) {
      db.update('subscriptions', cur.id, { cancel_at_period_end: 0, cancel_reason: null, cancelled_at: null, updated_at: clock.iso() });
      hist(cur, 'cancel_reverted', { actor });
      notify(accountId, 'subscription_resumed', 'Subscription resumed', `Your ${cur.plan_name} subscription will renew on ${fmtDate(cur.current_period_end)}.`);
    }
    if (cur.scheduled_plan_id) {
      db.update('subscriptions', cur.id, { scheduled_plan_id: null, scheduled_frequency: null, updated_at: clock.iso() });
      hist(cur, 'downgrade_reverted', { actor });
    }
    const open = db.one("SELECT i.* FROM invoices i WHERE i.subscription_id = ? AND i.status IN ('issued','overdue') ORDER BY i.id DESC LIMIT 1", cur.id);
    if (open) return { invoice: billing.getInvoice(open.id), subscription: dashboard(accountId) };
    const inv = generateRenewalInvoice(getSub(cur.id), { force: true });
    return { invoice: inv ? billing.getInvoice(inv.id) : null, subscription: dashboard(accountId) };
  });
}

/** Enterprise / custom pricing: enquiry → owner quote → invoice → verified payment → activation. */
function requestEnterprise(accountId, actor, { plan_code, requirements }) {
  const plan = plans.byCode(plan_code);
  const acct = db.one('SELECT * FROM accounts WHERE id = ?', accountId);
  if (plan.audience !== acct.type) throw bad(`This plan is for ${plan.audience}s`);
  const id = db.insert('enterprise_enquiries', { account_id: accountId, plan_id: plan.id, requirements, status: 'open', created_at: clock.iso(), updated_at: clock.iso() });
  notifyPlatform('enterprise_enquiry', 'New enterprise enquiry', `${acct.name} requested ${plan.name}: ${requirements || ''}`, { enquiry_id: id });
  return db.one('SELECT * FROM enterprise_enquiries WHERE id = ?', id);
}

function quoteEnterprise(actor, enquiryId, { price_paise, frequency = 'annual', interval_months, entitlement_overrides = {}, notes }) {
  return db.tx(() => {
    const q = db.one('SELECT * FROM enterprise_enquiries WHERE id = ?', enquiryId);
    if (!q) throw notFound('Enquiry');
    if (!['open', 'quoted'].includes(q.status)) throw conflict(`Enquiry is ${q.status}`);
    const price = Number(price_paise);
    if (!Number.isInteger(price) || price <= 0) throw bad('price_paise must be a positive integer');
    const months = interval_months ? Number(interval_months) : plans.FREQ_MONTHS[frequency] || 12;
    const plan = planRow(q.plan_id);
    const values = { ...ent.planEntitlements(plan.id), ...entitlement_overrides };
    const now = clock.iso();
    if (q.subscription_id) { const old = getSub(q.subscription_id); if (old?.status === 'pending') for (const inv of db.all("SELECT id FROM invoices WHERE subscription_id = ? AND status = 'issued'", old.id)) billing.voidInvoice(inv.id, actor, 'Re-quoted'); }
    const id = db.insert('subscriptions', { account_id: q.account_id, plan_id: plan.id, plan_version: plan.version, billing_frequency: frequency, interval_months: months, price_paise: price, status: 'pending', is_current: 0, entitlements_json: values, is_custom_contract: 1, created_at: now, updated_at: now });
    hist(getSub(id), 'created', { from_status: null, to_status: 'pending', meta: { custom: true, notes }, actor });
    const cycleId = db.insert('billing_cycles', { subscription_id: id, cycle_number: 1, period_start: now, period_end: addMonths(now, months), amount_paise: price, status: 'invoiced', created_at: now });
    const inv = billing.createInvoice({ accountId: q.account_id, type: 'subscription', items: [{ description: `${plan.name} — custom ${frequency} contract`, item_type: 'plan', unit_amount_paise: price, related_type: 'plan', related_id: plan.id }], subscriptionId: id, billingCycleId: cycleId, relatedType: 'subscription', relatedId: id, actor, notes });
    db.update('billing_cycles', cycleId, { invoice_id: inv.id });
    db.update('enterprise_enquiries', enquiryId, { status: 'quoted', quoted_price_paise: price, quoted_frequency: frequency, subscription_id: id, handled_by: actor.userId, updated_at: now });
    audit.log(actor, 'enterprise.quoted', 'enterprise_enquiry', enquiryId, { after: { price, frequency, months, entitlement_overrides } });
    notify(q.account_id, 'enterprise_quote', `Your ${plan.name} quote is ready`, `We have prepared a custom ${frequency} contract at ${rupees(price)} + tax. Pay invoice ${inv.invoice_number} to activate.`, { invoice_id: inv.id });
    return { enquiry: db.one('SELECT * FROM enterprise_enquiries WHERE id = ?', enquiryId), invoice: inv };
  });
}

// ------------------------------------------------------------------ lifecycle jobs
function nextTerms(sub) {
  const planId = sub.scheduled_plan_id || sub.plan_id;
  const plan = planRow(planId);
  if (plan.pricing_model === 'free') return { plan, amount: 0 };
  if (sub.is_custom_contract && !sub.scheduled_plan_id) return { plan, amount: sub.price_paise, months: sub.interval_months, frequency: sub.billing_frequency };
  const freq = sub.scheduled_frequency || sub.billing_frequency;
  const pr = db.one("SELECT * FROM plan_prices WHERE plan_id = ? AND billing_frequency = ? AND status = 'active'", planId, freq);
  if (!pr) return { plan, amount: sub.price_paise, months: sub.interval_months, frequency: freq };
  let amount = sub.scheduled_plan_id || sub.refresh_on_renewal ? pr.price_paise : sub.price_paise;
  let promo = false;
  if (sub.promo_cycles_remaining > 0 && !sub.scheduled_plan_id && pr.promo_price_paise != null) { amount = pr.promo_price_paise; promo = true; }
  if (sub.status === 'trial') { amount = plans.effectivePrice(pr); promo = amount !== pr.price_paise; }
  return { plan, amount, months: pr.interval_months, frequency: freq, price: pr, promo };
}

function generateRenewalInvoice(sub, { force = false } = {}) {
  if (sub.cancel_at_period_end) return null;
  const startAt = sub.status === 'trial' ? sub.trial_ends_at : sub.next_billing_at || sub.current_period_end;
  if (!startAt) return null;
  const existing = db.one("SELECT * FROM billing_cycles WHERE subscription_id = ? AND period_start = ? AND status IN ('invoiced','paid')", sub.id, startAt);
  if (existing) return existing.invoice_id ? db.one('SELECT * FROM invoices WHERE id = ?', existing.invoice_id) : null;
  const billingCfg = settings.get('billing');
  if (!force && new Date(startAt) - clock.now() > billingCfg.renewal_invoice_lead_days * 86400000) return null;
  const t = nextTerms(sub);
  if (!t.amount) return null;
  const n = (db.one('SELECT MAX(cycle_number) m FROM billing_cycles WHERE subscription_id = ?', sub.id).m || 0) + 1;
  const items = [{ description: `${t.plan.name} — ${t.frequency} renewal (${fmtDate(startAt)} – ${fmtDate(addMonths(startAt, t.months))})${t.promo ? ' (promotional price)' : ''}`, item_type: 'plan', unit_amount_paise: t.amount, related_type: 'plan', related_id: t.plan.id }];
  let disc = 0;
  if (sub.discount_code_id && sub.discount_cycles_remaining > 0 && !sub.scheduled_plan_id) {
    disc = discounts.amountFor(sub.discount_code_id, t.amount);
    if (disc) items.push({ description: 'Discount (multi-cycle offer)', item_type: 'discount', unit_amount_paise: -disc, related_type: 'discount_code', related_id: sub.discount_code_id });
  }
  const cycleId = db.insert('billing_cycles', { subscription_id: sub.id, cycle_number: n, period_start: startAt, period_end: addMonths(startAt, t.months), amount_paise: t.amount - disc, status: 'invoiced', created_at: clock.iso() });
  const inv = billing.createInvoice({ accountId: sub.account_id, type: 'subscription', items, subscriptionId: sub.id, billingCycleId: cycleId, relatedType: 'subscription', relatedId: sub.id, dueAt: startAt });
  db.update('billing_cycles', cycleId, { invoice_id: inv.id });
  if (disc) discounts.reserve(sub.discount_code_id, sub.account_id, inv.id, sub.id, disc);
  notify(sub.account_id, 'renewal_invoice', sub.status === 'trial' ? 'Your trial is ending soon' : 'Upcoming renewal',
    `${sub.status === 'trial' ? 'Your trial ends' : 'Your subscription renews'} on ${fmtDate(startAt)}. Invoice ${inv.invoice_number} for ${rupees(inv.total_paise)} is ready to pay.`, { invoice_id: inv.id }, { dedupeKey: `renewal-invoice:${inv.id}` });
  if (inv.total_paise === 0) billing.settleZeroInvoice(inv);
  return inv;
}

function rollPeriod(sub, cycle) {
  const now = clock.iso();
  const fromTrial = sub.status === 'trial';
  if (sub.scheduled_plan_id && sub.scheduled_plan_id !== sub.plan_id) {
    const plan = planRow(sub.scheduled_plan_id);
    const pr = db.one("SELECT * FROM plan_prices WHERE plan_id = ? AND billing_frequency = ? AND status = 'active'", plan.id, sub.scheduled_frequency || sub.billing_frequency);
    const id = newSubRow(sub.account_id, plan, { status: 'active', price: pr, extra: { activated_at: now, current_period_start: cycle.period_start, current_period_end: cycle.period_end, next_billing_at: cycle.period_end } });
    db.update('billing_cycles', cycle.id, {}); // cycle stays linked to the subscription that was invoiced
    makeCurrent(sub.account_id, id, 'cancelled');
    hist(getSub(id), plan.tier_rank < planRow(sub.plan_id).tier_rank ? 'downgraded' : 'upgraded', { from_plan_id: sub.plan_id, from_status: sub.status, to_status: 'active' });
    const deactivated = applyLimitsPolicy(sub.account_id);
    notify(sub.account_id, 'plan_changed', `You are now on ${plan.name}`, `Your scheduled plan change is complete.${deactivated.length ? ` ${deactivated.length} listing(s) above your new limit were set inactive (not deleted).` : ''}`);
    return;
  }
  if (sub.scheduled_frequency) {
    const pr = db.one("SELECT * FROM plan_prices WHERE plan_id = ? AND billing_frequency = ? AND status = 'active'", sub.plan_id, sub.scheduled_frequency);
    if (pr) Object.assign(sub, { billing_frequency: pr.billing_frequency, interval_months: pr.interval_months, price_paise: pr.price_paise, plan_price_id: pr.id });
  }
  db.update('subscriptions', sub.id, {
    status: 'active', current_period_start: cycle.period_start, current_period_end: cycle.period_end, next_billing_at: cycle.period_end, grace_ends_at: null,
    billing_frequency: sub.billing_frequency, interval_months: sub.interval_months, price_paise: sub.price_paise, plan_price_id: sub.plan_price_id, scheduled_plan_id: null, scheduled_frequency: null,
    discount_cycles_remaining: Math.max(0, sub.discount_cycles_remaining - (sub.discount_code_id ? 1 : 0)), promo_cycles_remaining: Math.max(0, sub.promo_cycles_remaining - 1), updated_at: now, ...refreshPatch(sub),
  });
  hist(sub, fromTrial ? 'trial_converted' : 'renewed', { to_status: 'active', amount: cycle.amount_paise });
  if (fromTrial) notify(sub.account_id, 'trial_converted', 'Welcome aboard!', 'Your trial has converted to a paid subscription.');
}

function endToDefault(sub, event, actor = 'system', reason = null) {
  const acct = db.one('SELECT type FROM accounts WHERE id = ?', sub.account_id);
  const plan = ent.defaultPlan(acct.type);
  const id = newSubRow(sub.account_id, plan, { status: 'active', extra: { activated_at: clock.iso(), current_period_start: clock.iso() } });
  makeCurrent(sub.account_id, id, event === 'expired' ? 'expired' : 'cancelled');
  hist(sub, event, { to_plan_id: plan.id, to_status: event === 'expired' ? 'expired' : 'cancelled', meta: reason ? { reason } : null, actor });
  const deactivated = applyLimitsPolicy(sub.account_id);
  const p = planRow(sub.plan_id);
  notify(sub.account_id, `subscription_${event}`, `${p.name} has ended`, `Your account is now on the ${plan.name} plan. Your listings, orders and history are kept.${deactivated.length ? ` ${deactivated.length} listing(s) above the free limit were set inactive — upgrade any time to reactivate them.` : ''}`);
}

/** Run all time-based subscription transitions. Idempotent; safe to run every few minutes. */
function runLifecycle() {
  const cfg = settings.get('billing');
  const now = clock.now();
  const nowIso = now.toISOString();
  const report = { renewal_invoices: 0, reminders: 0, renewed: 0, past_due: 0, suspended: 0, expired: 0, cancelled: 0, pending_expired: 0 };

  // 1. Abandoned checkouts
  for (const s of db.all("SELECT * FROM subscriptions WHERE status = 'pending' AND created_at < ?", new Date(now - cfg.pending_checkout_expiry_hours * 3600000).toISOString())) {
    db.tx(() => {
      for (const inv of db.all("SELECT id FROM invoices WHERE subscription_id = ? AND status IN ('issued','overdue') AND amount_paid_paise = 0", s.id)) billing.voidInvoice(inv.id, 'system', 'Checkout abandoned');
      db.update('subscriptions', s.id, { status: 'expired', ended_at: nowIso, updated_at: nowIso });
    });
    report.pending_expired++;
  }

  // 2. Renewal invoices ahead of the billing date
  for (const s of db.all("SELECT * FROM subscriptions WHERE is_current = 1 AND status IN ('active','trial','payment_failed') AND cancel_at_period_end = 0 AND next_billing_at IS NOT NULL")) {
    if (db.tx(() => generateRenewalInvoice(s))) report.renewal_invoices++;
  }

  // 3. Reminders for unpaid upcoming renewals (configurable days before)
  for (const r of db.all("SELECT i.*, c.period_start FROM invoices i JOIN billing_cycles c ON c.id = i.billing_cycle_id JOIN subscriptions s ON s.id = i.subscription_id WHERE i.status = 'issued' AND s.is_current = 1 AND c.period_start > ?", nowIso)) {
    const days = Math.ceil((new Date(r.period_start) - now) / 86400000);
    const d = [...cfg.renewal_reminder_days].sort((a, b) => a - b).find((x) => days <= x);
    if (d === undefined) continue;
    if (notify(r.account_id, 'renewal_reminder', `Renewal due in ${days} day(s)`, `Invoice ${r.invoice_number} for ${rupees(r.total_paise)} is due on ${fmtDate(r.period_start)}. Pay now to keep your plan features.`, { invoice_id: r.id }, { dedupeKey: `renewal-reminder:${r.id}:${d}` })) report.reminders++;
  }

  // 4. Period ends
  for (const s of db.all("SELECT * FROM subscriptions WHERE is_current = 1 AND status IN ('active','trial','payment_failed') AND current_period_end IS NOT NULL AND current_period_end <= ?", nowIso)) {
    db.tx(() => {
      if (s.cancel_at_period_end) { endToDefault(s, 'cancelled'); report.cancelled++; return; }
      if (s.scheduled_plan_id && planRow(s.scheduled_plan_id).pricing_model === 'free') { endToDefault(s, 'downgraded'); report.cancelled++; return; }
      const cycle = db.one("SELECT * FROM billing_cycles WHERE subscription_id = ? AND period_start = ? AND status = 'paid'", s.id, s.current_period_end);
      if (cycle) { rollPeriod(s, cycle); report.renewed++; return; }
      const graceDays = s.status === 'trial' ? cfg.trial_grace_days : cfg.grace_period_days;
      if (graceDays <= 0) { suspend(s); report.suspended++; return; }
      const grace = addDays(s.current_period_end, graceDays);
      db.update('subscriptions', s.id, { status: 'past_due', grace_ends_at: grace, updated_at: nowIso });
      db.run("UPDATE invoices SET status = 'overdue' WHERE subscription_id = ? AND status = 'issued'", s.id);
      hist(s, 'past_due', { to_status: 'past_due', meta: { grace_ends_at: grace } });
      if (!db.one("SELECT 1 FROM invoices WHERE subscription_id = ? AND status IN ('issued','overdue')", s.id)) generateRenewalInvoice(getSub(s.id), { force: true });
      notify(s.account_id, 'payment_overdue', 'Payment overdue — grace period started', `We could not collect your renewal payment. Your features stay on until ${fmtDate(grace)}. Pay the outstanding invoice to avoid suspension.`, {}, { priority: 'high' });
      report.past_due++;
    });
  }

  // 5. Grace expiry → suspend (premium features disabled, data kept)
  for (const s of db.all("SELECT * FROM subscriptions WHERE is_current = 1 AND status = 'past_due' AND grace_ends_at <= ?", nowIso)) { db.tx(() => suspend(s)); report.suspended++; }

  // 6. Long suspensions → expire, fall back to free plan
  for (const s of db.all("SELECT * FROM subscriptions WHERE is_current = 1 AND status = 'suspended' AND updated_at <= ?", addDays(nowIso, -cfg.suspension_to_expiry_days))) {
    db.tx(() => {
      for (const inv of db.all("SELECT id FROM invoices WHERE subscription_id = ? AND status IN ('issued','overdue') AND amount_paid_paise = 0", s.id)) billing.voidInvoice(inv.id, 'system', 'Subscription expired');
      endToDefault(s, 'expired');
    });
    report.expired++;
  }
  return report;
}

function suspend(s) {
  db.update('subscriptions', s.id, { status: 'suspended', updated_at: clock.iso() });
  hist(s, 'suspended', { to_status: 'suspended' });
  const deactivated = applyLimitsPolicy(s.account_id);
  notify(s.account_id, 'subscription_suspended', 'Subscription suspended', `Premium features are paused because the renewal payment was not received. Your data is safe${deactivated.length ? ` and ${deactivated.length} listing(s) above the free limit were set inactive` : ''}. Pay the outstanding invoice to restore access instantly.`, {}, { priority: 'high' });
}

/** Configurable downgrade policy: excess listings beyond the effective limit become inactive (never deleted). */
function applyLimitsPolicy(accountId) {
  const policy = settings.get('downgrade_policy');
  const limit = ent.value(accountId, 'max_active_listings');
  if (limit === undefined || limit < 0 || policy.excess_listings === 'keep_active') return [];
  const active = db.all(`SELECT id, product_name FROM listings WHERE account_id = ? AND status = 'active' ORDER BY created_at ${policy.excess_listings === 'deactivate_newest' ? 'ASC' : 'DESC'}, id ${policy.excess_listings === 'deactivate_newest' ? 'ASC' : 'DESC'}`, accountId);
  const excess = active.slice(limit);
  for (const l of excess) db.update('listings', l.id, { status: 'inactive', deactivated_reason: 'plan_limit', updated_at: clock.iso() });
  return excess;
}

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '—');

/** Subscription dashboard payload (section 7). */
function dashboard(accountId) {
  const cur = ent.currentSubscription(accountId) || ensureDefault(accountId);
  const acct = db.one('SELECT * FROM accounts WHERE id = ?', accountId);
  const plan = plans.byId(cur.plan_id);
  const effective = ent.forAccount(accountId);
  const defs = Object.fromEntries(ent.definitions().map((d) => [d.key, d]));
  const openInvoices = db.all("SELECT id, invoice_number, invoice_type, total_paise, amount_paid_paise, status, due_at FROM invoices WHERE account_id = ? AND status IN ('issued','overdue') ORDER BY due_at", accountId);
  const lastInv = db.one("SELECT status FROM invoices WHERE subscription_id = ? AND status != 'void' ORDER BY id DESC LIMIT 1", cur.id);
  const pending = db.one("SELECT s.id, p.name plan_name, i.id invoice_id, i.total_paise FROM subscriptions s JOIN subscription_plans p ON p.id = s.plan_id LEFT JOIN invoices i ON i.subscription_id = s.id AND i.status = 'issued' WHERE s.account_id = ? AND s.status = 'pending' ORDER BY s.id DESC LIMIT 1", accountId);
  const available = plans.list({ audience: acct.type }).map((p) => ({ ...p, relation: p.id === cur.plan_id ? 'current' : p.tier_rank > cur.tier_rank ? 'upgrade' : 'downgrade', trial_eligible: trialEligible(accountId, p) }));
  return {
    account: { id: acct.id, name: acct.name, type: acct.type, region: acct.region },
    subscription: {
      id: cur.id, plan_id: cur.plan_id, plan_code: cur.plan_code, plan_name: cur.plan_name, pricing_model: cur.pricing_model, status: cur.status,
      price_paise: cur.price_paise, billing_frequency: cur.billing_frequency, start_date: cur.activated_at || cur.created_at,
      current_period_start: cur.current_period_start, current_period_end: cur.current_period_end, next_billing_at: cur.cancel_at_period_end ? null : cur.next_billing_at,
      renewal_date: cur.cancel_at_period_end ? null : cur.current_period_end, trial_ends_at: cur.trial_ends_at, grace_ends_at: cur.grace_ends_at,
      cancel_at_period_end: !!cur.cancel_at_period_end, ends_at: cur.cancel_at_period_end ? cur.current_period_end : null,
      scheduled_change: cur.scheduled_plan_id ? { plan: planRow(cur.scheduled_plan_id).name, frequency: cur.scheduled_frequency, effective_at: cur.current_period_end } : null,
      payment_status: lastInv ? lastInv.status : cur.pricing_model === 'free' ? 'not_required' : 'none', is_custom_contract: !!cur.is_custom_contract,
      access: effective.source === 'subscription' ? 'full' : 'free_fallback',
    },
    plan: { features: plan.features, description: plan.description },
    entitlements: Object.entries(effective.values).filter(([k]) => defs[k] && (defs[k].audience === 'both' || defs[k].audience === acct.type)).map(([k, v]) => ({ key: k, label: defs[k].label, type: defs[k].value_type, value: v })),
    usage: ent.usage(accountId),
    promotion_credits: promotionCreditSummary(accountId),
    account_credit_paise: billing.accountCreditBalance(accountId),
    open_invoices: openInvoices,
    pending_checkout: pending || null,
    payment_methods: db.all("SELECT id, provider, method_type, label, is_default FROM payment_methods WHERE account_id = ? AND status = 'active' ORDER BY is_default DESC, id DESC", accountId),
    available_plans: available,
    upgrade_options: available.filter((p) => p.relation === 'upgrade'),
    downgrade_options: available.filter((p) => p.relation === 'downgrade'),
  };
}

function promotionCreditSummary(accountId) {
  const allowance = ent.value(accountId, 'featured_listing_credits') || 0;
  const used = ent.counter(accountId, 'featured_listing_credits');
  const bonus = db.one("SELECT COALESCE(SUM(amount),0) b FROM credit_ledger WHERE account_id = ? AND credit_type = 'promotion' AND (expires_at IS NULL OR expires_at > ?)", accountId, clock.iso()).b;
  return { plan_allowance: allowance, plan_used: used, plan_remaining: Math.max(0, allowance - used), bonus_credits: bonus };
}

function history(accountId) {
  return db.all('SELECT h.*, fp.name from_plan, tp.name to_plan FROM subscription_history h LEFT JOIN subscription_plans fp ON fp.id = h.from_plan_id LEFT JOIN subscription_plans tp ON tp.id = h.to_plan_id WHERE h.account_id = ? ORDER BY h.id DESC LIMIT 100', accountId);
}

module.exports = { ensureDefault, quote, checkout, cancel, renew, requestEnterprise, quoteEnterprise, runLifecycle, applyLimitsPolicy, dashboard, history, promotionCreditSummary, generateRenewalInvoice, trialEligible };
