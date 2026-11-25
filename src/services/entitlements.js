'use strict';
/**
 * Subscription entitlement engine. All feature gating in the backend goes through here.
 * Entitlement values come from the subscription's snapshot (taken from the plan when the
 * subscription started/renewed), so plan edits apply according to the owner's chosen scope.
 */
const db = require('../db');
const clock = require('../lib/clock');
const { upgradeRequired, parseJSON } = require('../lib/util');

// Statuses that keep the paid entitlements switched on (past_due = inside grace period).
const ACCESS_STATUSES = ['trial', 'active', 'payment_failed', 'past_due'];

function definitions() {
  return db.all('SELECT * FROM entitlement_definitions ORDER BY key').map((d) => ({ ...d, levels: parseJSON(d.levels_json, null) }));
}

function parseValue(def, raw) {
  if (!def) return raw;
  if (def.value_type === 'limit') return Number(raw);
  if (def.value_type === 'boolean') return raw === true || raw === 'true' || raw === '1' || raw === 1;
  return String(raw);
}

function planEntitlements(planId) {
  const defs = Object.fromEntries(definitions().map((d) => [d.key, d]));
  const out = {};
  for (const d of Object.values(defs)) out[d.key] = parseValue(d, d.default_value);
  for (const e of db.all('SELECT key, value FROM subscription_entitlements WHERE plan_id = ?', planId)) out[e.key] = parseValue(defs[e.key], e.value);
  return out;
}

function currentSubscription(accountId) {
  return db.one('SELECT s.*, p.code AS plan_code, p.name AS plan_name, p.audience, p.tier_rank, p.pricing_model, p.is_enterprise FROM subscriptions s JOIN subscription_plans p ON p.id = s.plan_id WHERE s.account_id = ? AND s.is_current = 1', accountId);
}

function defaultPlan(audience) {
  return db.one("SELECT * FROM subscription_plans WHERE audience = ? AND is_default = 1 AND status = 'active' ORDER BY id LIMIT 1", audience);
}

/** Effective entitlements for an account. Lapsed subscriptions fall back to the free default plan. */
function forAccount(accountId) {
  const sub = currentSubscription(accountId);
  if (sub && ACCESS_STATUSES.includes(sub.status)) {
    return { source: 'subscription', subscription: sub, values: parseJSON(sub.entitlements_json, {}) };
  }
  const acct = db.one('SELECT type FROM accounts WHERE id = ?', accountId);
  const plan = acct && ['farmer', 'buyer'].includes(acct.type) ? defaultPlan(acct.type) : null;
  return { source: sub ? 'fallback_lapsed' : 'fallback_default', subscription: sub || null, values: plan ? planEntitlements(plan.id) : {} };
}

function value(accountId, key) {
  const v = forAccount(accountId).values[key];
  if (v !== undefined) return v;
  const def = db.one('SELECT * FROM entitlement_definitions WHERE key = ?', key);
  return def ? parseValue(def, def.default_value) : undefined;
}

/** Usage period: the subscription's billing period, or the calendar month for free plans. */
function usagePeriod(accountId) {
  const sub = currentSubscription(accountId);
  const now = clock.now();
  if (sub && sub.current_period_start && sub.current_period_end && new Date(sub.current_period_end) > now) {
    return { start: sub.current_period_start, end: sub.current_period_end, subscriptionId: sub.id };
  }
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  return { start, end, subscriptionId: sub ? sub.id : null };
}

function counter(accountId, metric) {
  const p = usagePeriod(accountId);
  const r = db.one('SELECT used FROM subscription_usage WHERE account_id = ? AND metric = ? AND period_start = ?', accountId, metric, p.start);
  return r ? r.used : 0;
}

function incrementCounter(accountId, metric, by = 1) {
  const p = usagePeriod(accountId);
  db.run(`INSERT INTO subscription_usage (account_id, subscription_id, metric, period_start, period_end, used, updated_at)
          VALUES (?,?,?,?,?,?,?) ON CONFLICT(account_id, metric, period_start) DO UPDATE SET used = used + excluded.used, updated_at = excluded.updated_at`,
  accountId, p.subscriptionId, metric, p.start, p.end, by, clock.iso());
}

/** Live usage metrics mapped to the limit entitlements they consume. */
const USAGE = {
  max_active_listings: (a) => db.one("SELECT COUNT(*) c FROM listings WHERE account_id = ? AND status = 'active'", a).c,
  max_farms: (a) => db.one("SELECT COUNT(*) c FROM farms WHERE account_id = ? AND status = 'active'", a).c,
  max_users: (a) => db.one("SELECT COUNT(*) c FROM users WHERE account_id = ? AND status = 'active'", a).c,
  max_saved_suppliers: (a) => db.one('SELECT COUNT(*) c FROM saved_suppliers WHERE buyer_account_id = ?', a).c,
  max_monthly_orders: (a) => {
    const p = usagePeriod(a);
    return db.one("SELECT COUNT(*) c FROM orders WHERE buyer_account_id = ? AND placed_at >= ? AND placed_at < ? AND status NOT IN ('cancelled','rejected')", a, p.start, p.end).c;
  },
  featured_listing_credits: (a) => counter(a, 'featured_listing_credits'),
};

function usage(accountId) {
  const ent = forAccount(accountId).values;
  const acct = db.one('SELECT type FROM accounts WHERE id = ?', accountId);
  const defs = definitions().filter((d) => d.value_type === 'limit' && (d.audience === 'both' || d.audience === acct?.type));
  const out = [];
  for (const d of defs) {
    if (!(d.key in ent) || !USAGE[d.key]) continue;
    const limit = ent[d.key];
    if (limit === 0 && d.key === 'featured_listing_credits') continue; // not part of this plan
    const used = USAGE[d.key](accountId);
    out.push({ key: d.key, label: d.label, used, limit, unlimited: limit < 0, percent: limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : limit === 0 ? 100 : 0 });
  }
  return { period: usagePeriod(accountId), metrics: out };
}

function recordPrompt(accountId, key, context) {
  db.insert('upgrade_prompts', { account_id: accountId, entitlement_key: key, context, created_at: clock.iso() });
}

/** Plans in the same audience that would grant the entitlement — offered on every denial. */
function upgradeOptions(accountId, key, needed) {
  const acct = db.one('SELECT type FROM accounts WHERE id = ?', accountId);
  const cur = currentSubscription(accountId);
  const def = db.one('SELECT * FROM entitlement_definitions WHERE key = ?', key);
  const plans = db.all("SELECT * FROM subscription_plans WHERE audience = ? AND status = 'active' AND visibility = 'public' ORDER BY tier_rank", acct.type);
  return plans.filter((p) => !cur || p.tier_rank > cur.tier_rank).filter((p) => {
    const v = planEntitlements(p.id)[key];
    if (def.value_type === 'limit') return v < 0 || v >= needed;
    if (def.value_type === 'boolean') return v === true;
    const levels = parseJSON(def.levels_json, []);
    return levels.indexOf(v) >= levels.indexOf(needed);
  }).map((p) => ({ code: p.code, name: p.name, pricing_model: p.pricing_model }));
}

/** Enforce a numeric limit: throws 402 upgrade_required if current usage + increment exceeds it. */
function assertLimit(accountId, key, increment = 1, context = '') {
  const limit = value(accountId, key);
  if (limit === undefined || limit < 0) return { limit: -1 };
  const used = USAGE[key] ? USAGE[key](accountId) : 0;
  if (used + increment > limit) {
    recordPrompt(accountId, key, context);
    const def = db.one('SELECT label FROM entitlement_definitions WHERE key = ?', key);
    throw upgradeRequired(key, `Your plan allows ${limit} ${def ? def.label.toLowerCase() : key}. You are using ${used}. Upgrade your plan to add more.`,
      { limit, used, upgrade_options: upgradeOptions(accountId, key, used + increment) });
  }
  return { limit, used };
}

function assertFeature(accountId, key, context = '') {
  if (value(accountId, key) === true) return true;
  recordPrompt(accountId, key, context);
  const def = db.one('SELECT label FROM entitlement_definitions WHERE key = ?', key);
  throw upgradeRequired(key, `${def ? def.label : key} is not included in your current plan.`, { upgrade_options: upgradeOptions(accountId, key, true) });
}

function levelAtLeast(accountId, key, min) {
  const def = db.one('SELECT levels_json FROM entitlement_definitions WHERE key = ?', key);
  const levels = parseJSON(def?.levels_json, []);
  return levels.indexOf(value(accountId, key)) >= levels.indexOf(min);
}

function assertLevel(accountId, key, min, context = '') {
  if (levelAtLeast(accountId, key, min)) return true;
  recordPrompt(accountId, key, context);
  throw upgradeRequired(key, `This requires ${min} ${key.replace(/_/g, ' ')} or higher.`, { required: min, current: value(accountId, key), upgrade_options: upgradeOptions(accountId, key, min) });
}

module.exports = { ACCESS_STATUSES, definitions, planEntitlements, currentSubscription, defaultPlan, forAccount, value, usage, usagePeriod, counter, incrementCounter, assertLimit, assertFeature, assertLevel, levelAtLeast, upgradeOptions, USAGE };
