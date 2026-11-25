'use strict';
/**
 * Subscription plan configuration (owner-managed). Prices, limits, entitlements, trials,
 * commissions and upgrade/downgrade paths are data — nothing is hardcoded.
 */
const db = require('../db');
const clock = require('../lib/clock');
const audit = require('../lib/audit');
const { notify } = require('../lib/notify');
const ent = require('./entitlements');
const { bad, notFound, conflict, parseJSON, rupees } = require('../lib/util');

const FREQ_MONTHS = { monthly: 1, quarterly: 3, annual: 12 };
const PLAN_FIELDS = ['code', 'audience', 'name', 'description', 'target_customers', 'tier_rank', 'pricing_model', 'trial_days', 'is_default', 'is_enterprise', 'visibility', 'marketplace_visibility', 'commission_bps', 'commission_fixed_paise', 'discount_eligible', 'sort_order'];

function hydrate(p, { includeStats = false } = {}) {
  if (!p) return null;
  const out = { ...p, upgrade_to: parseJSON(p.upgrade_to_json, []), downgrade_to: parseJSON(p.downgrade_to_json, []) };
  delete out.upgrade_to_json; delete out.downgrade_to_json;
  out.prices = db.all('SELECT * FROM plan_prices WHERE plan_id = ? ORDER BY interval_months', p.id).map((pr) => ({ ...pr, effective_price_paise: effectivePrice(pr) }));
  out.features = db.all('SELECT id, label, highlight, sort_order FROM subscription_features WHERE plan_id = ? ORDER BY sort_order, id', p.id);
  out.entitlements = ent.planEntitlements(p.id);
  if (includeStats) {
    out.stats = db.one(`SELECT COUNT(*) subscribers, SUM(CASE WHEN status='trial' THEN 1 ELSE 0 END) trials,
      COALESCE(SUM(CASE WHEN status IN ('active','payment_failed','past_due') THEN price_paise * 1.0 / COALESCE(NULLIF(interval_months,0),1) ELSE 0 END),0) mrr_paise
      FROM subscriptions WHERE plan_id = ? AND is_current = 1 AND status IN ('trial','active','payment_failed','past_due')`, p.id);
    out.stats.mrr_paise = Math.round(out.stats.mrr_paise);
  }
  return out;
}

function effectivePrice(pr) {
  if (pr.promo_price_paise != null && (!pr.promo_valid_until || pr.promo_valid_until > clock.iso())) return pr.promo_price_paise;
  return pr.price_paise;
}

function list({ audience, includeAll = false } = {}) {
  const where = [];
  const params = [];
  if (audience) { where.push('audience = ?'); params.push(audience); }
  if (!includeAll) where.push("status = 'active' AND visibility = 'public'");
  else where.push("status != 'archived'");
  return db.all(`SELECT * FROM subscription_plans ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY audience, tier_rank, sort_order`, ...params).map((p) => hydrate(p, { includeStats: includeAll }));
}

const byId = (id) => { const p = db.one('SELECT * FROM subscription_plans WHERE id = ?', id); if (!p) throw notFound('Plan'); return hydrate(p, { includeStats: true }); };
const byCode = (code) => { const p = db.one('SELECT * FROM subscription_plans WHERE code = ?', code); if (!p) throw notFound('Plan'); return hydrate(p); };

function validate(plan, prices, entitlements) {
  if (!['farmer', 'buyer'].includes(plan.audience)) throw bad('audience must be farmer or buyer');
  if (!['free', 'fixed', 'custom'].includes(plan.pricing_model)) throw bad('pricing_model must be free, fixed or custom');
  if (!plan.name) throw bad('Plan name is required');
  if (!/^[a-z0-9_]+$/.test(plan.code || '')) throw bad('Plan code must be lowercase letters, digits or underscores');
  if (plan.pricing_model === 'fixed' && !(prices || []).some((p) => p.price_paise > 0 && p.status !== 'inactive')) throw bad('A fixed-price plan needs at least one active price above zero');
  if (plan.is_default && plan.pricing_model !== 'free') throw bad('Only a free plan can be the default plan');
  for (const p of prices || []) {
    if (!['monthly', 'quarterly', 'annual', 'custom'].includes(p.billing_frequency)) throw bad(`Unknown billing frequency ${p.billing_frequency}`);
    if (!Number.isInteger(Number(p.price_paise)) || p.price_paise < 0) throw bad('Prices must be non-negative integers in paise');
    if (p.promo_price_paise != null && p.promo_price_paise > p.price_paise) throw bad('Promotional price must be lower than the regular price');
  }
  const defs = Object.fromEntries(ent.definitions().map((d) => [d.key, d]));
  for (const [k, v] of Object.entries(entitlements || {})) {
    const d = defs[k];
    if (!d) throw bad(`Unknown entitlement ${k}`);
    if (d.value_type === 'limit' && !Number.isInteger(Number(v))) throw bad(`${k} must be an integer (-1 = unlimited)`);
    if (d.value_type === 'level' && !d.levels.includes(String(v))) throw bad(`${k} must be one of ${d.levels.join(', ')}`);
  }
}

function writeChildren(planId, { prices, features, entitlements }) {
  if (prices) {
    db.run("UPDATE plan_prices SET status = 'inactive' WHERE plan_id = ?", planId);
    for (const p of prices) {
      const months = p.billing_frequency === 'custom' ? Number(p.interval_months || 1) : FREQ_MONTHS[p.billing_frequency];
      db.run(`INSERT INTO plan_prices (plan_id, billing_frequency, interval_months, price_paise, promo_price_paise, promo_label, promo_valid_until, promo_cycles, status)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(plan_id, billing_frequency) DO UPDATE SET interval_months=excluded.interval_months, price_paise=excluded.price_paise,
        promo_price_paise=excluded.promo_price_paise, promo_label=excluded.promo_label, promo_valid_until=excluded.promo_valid_until, promo_cycles=excluded.promo_cycles, status=excluded.status`,
      planId, p.billing_frequency, months, Number(p.price_paise), p.promo_price_paise ?? null, p.promo_label ?? null, p.promo_valid_until ?? null, Number(p.promo_cycles || 1), p.status || 'active');
    }
  }
  if (features) {
    db.run('DELETE FROM subscription_features WHERE plan_id = ?', planId);
    features.forEach((f, i) => db.insert('subscription_features', { plan_id: planId, label: typeof f === 'string' ? f : f.label, highlight: f.highlight ? 1 : 0, sort_order: i }));
  }
  if (entitlements) {
    for (const [k, v] of Object.entries(entitlements)) {
      db.run('INSERT INTO subscription_entitlements (plan_id, key, value) VALUES (?,?,?) ON CONFLICT(plan_id, key) DO UPDATE SET value = excluded.value', planId, k, String(v));
    }
  }
}

function snapshot(planId) {
  const p = hydrate(db.one('SELECT * FROM subscription_plans WHERE id = ?', planId));
  return { ...p, stats: undefined };
}

/** Step 4–18 of "Create Plan": draft is created, previewed, then published. */
function create(actor, body) {
  const plan = { ...Object.fromEntries(PLAN_FIELDS.filter((f) => body[f] !== undefined).map((f) => [f, body[f]])) };
  plan.trial_days = Number(plan.trial_days || 0);
  validate(plan, body.prices, body.entitlements);
  if (db.one('SELECT 1 FROM subscription_plans WHERE code = ?', plan.code)) throw conflict('A plan with this code already exists');
  return db.tx(() => {
    const now = clock.iso();
    const id = db.insert('subscription_plans', { ...plan, upgrade_to_json: body.upgrade_to || [], downgrade_to_json: body.downgrade_to || [], status: 'draft', version: 1, created_by: actor.userId, created_at: now, updated_at: now });
    writeChildren(id, body);
    audit.log(actor, 'plan.created', 'subscription_plan', id, { after: snapshot(id) });
    if (body.publish) publish(actor, id, {});
    return byId(id);
  });
}

/** Review the impact of a proposed change before publishing it. */
function impact(planId, body) {
  const current = byId(planId);
  const subs = db.all("SELECT s.*, a.name account_name FROM subscriptions s JOIN accounts a ON a.id = s.account_id WHERE s.plan_id = ? AND s.is_current = 1 AND s.status IN ('trial','active','payment_failed','past_due')", planId);
  const result = { plan: current.name, active_subscribers: subs.length, current_mrr_paise: current.stats.mrr_paise, price_changes: [], entitlement_reductions: [], accounts_over_new_limits: [] };
  for (const np of body.prices || []) {
    const op = current.prices.find((p) => p.billing_frequency === np.billing_frequency);
    if (op && op.price_paise !== Number(np.price_paise)) {
      const n = subs.filter((s) => s.billing_frequency === np.billing_frequency).length;
      result.price_changes.push({ frequency: np.billing_frequency, from: op.price_paise, to: Number(np.price_paise), subscribers: n, mrr_delta_paise: Math.round(((Number(np.price_paise) - op.price_paise) * n) / op.interval_months) });
    }
  }
  for (const [k, v] of Object.entries(body.entitlements || {})) {
    const old = current.entitlements[k];
    const nv = typeof old === 'number' ? Number(v) : v;
    const reduced = typeof old === 'number' ? (old < 0 ? nv >= 0 : nv >= 0 && nv < old) : (old === true && String(nv) === 'false');
    if (reduced) {
      result.entitlement_reductions.push({ key: k, from: old, to: nv });
      if (typeof old === 'number' && ent.USAGE[k]) {
        for (const s of subs) { const used = ent.USAGE[k](s.account_id); if (used > nv) result.accounts_over_new_limits.push({ account_id: s.account_id, account: s.account_name, key: k, used, new_limit: nv }); }
      }
    }
  }
  result.projected_mrr_paise = result.current_mrr_paise + result.price_changes.reduce((s, c) => s + c.mrr_delta_paise, 0);
  return result;
}

/**
 * Edit a plan. For plans with subscribers the owner picks change_scope:
 *  new_only      – existing subscribers keep their locked price and entitlements
 *  next_renewal  – existing subscribers move to the new terms when they next renew
 *  immediate     – entitlements apply now; price changes still apply from the next renewal invoice
 */
function update(actor, planId, body) {
  const existing = db.one('SELECT * FROM subscription_plans WHERE id = ?', planId);
  if (!existing) throw notFound('Plan');
  if (existing.status === 'archived') throw conflict('Archived plans cannot be edited');
  const merged = { ...existing, ...Object.fromEntries(PLAN_FIELDS.filter((f) => body[f] !== undefined && f !== 'code' && f !== 'audience').map((f) => [f, body[f]])) };
  const prices = body.prices || db.all('SELECT * FROM plan_prices WHERE plan_id = ?', planId);
  validate(merged, prices, body.entitlements);
  const subscribers = db.one("SELECT COUNT(*) c FROM subscriptions WHERE plan_id = ? AND is_current = 1 AND status IN ('trial','active','payment_failed','past_due')", planId).c;
  const scope = body.change_scope || (subscribers ? null : 'new_only');
  if (!['new_only', 'next_renewal', 'immediate'].includes(scope)) throw bad('change_scope is required (new_only, next_renewal or immediate) because this plan has active subscribers');
  const impactReport = impact(planId, body);
  return db.tx(() => {
    const before = snapshot(planId);
    const patch = Object.fromEntries(PLAN_FIELDS.filter((f) => body[f] !== undefined && f !== 'code' && f !== 'audience').map((f) => [f, body[f]]));
    if (body.upgrade_to) patch.upgrade_to_json = body.upgrade_to;
    if (body.downgrade_to) patch.downgrade_to_json = body.downgrade_to;
    patch.updated_at = clock.iso();
    const published = existing.status !== 'draft';
    if (published) patch.version = existing.version + 1;
    db.update('subscription_plans', planId, patch);
    writeChildren(planId, body);
    const after = snapshot(planId);
    if (published) {
      db.insert('plan_versions', { plan_id: planId, version: after.version, snapshot_json: after, change_scope: scope, change_summary: body.change_summary || null, published_by: actor.userId, published_at: clock.iso() });
      applyToSubscribers(actor, planId, scope, after, body.change_summary);
    }
    audit.log(actor, 'plan.updated', 'subscription_plan', planId, { before, after, reason: `scope=${scope}${body.change_summary ? ': ' + body.change_summary : ''}` });
    return { plan: byId(planId), impact: impactReport, change_scope: scope };
  });
}

function applyToSubscribers(actor, planId, scope, plan, summary) {
  if (scope === 'new_only') return;
  const subs = db.all("SELECT * FROM subscriptions WHERE plan_id = ? AND is_current = 1 AND status IN ('trial','active','payment_failed','past_due') AND is_custom_contract = 0", planId);
  const values = ent.planEntitlements(planId);
  for (const s of subs) {
    if (scope === 'immediate') {
      db.update('subscriptions', s.id, { entitlements_json: values, plan_version: plan.version, refresh_on_renewal: 1, updated_at: clock.iso() });
    } else {
      db.update('subscriptions', s.id, { refresh_on_renewal: 1, updated_at: clock.iso() });
    }
    db.insert('subscription_history', { subscription_id: s.id, account_id: s.account_id, event: 'plan_changed', from_plan_id: planId, to_plan_id: planId, from_status: s.status, to_status: s.status, metadata_json: { scope, version: plan.version, summary }, actor_user_id: actor.userId, created_at: clock.iso() });
    const pr = plan.prices.find((p) => p.billing_frequency === s.billing_frequency);
    const priceNote = pr && pr.price_paise !== s.price_paise ? ` The price for your ${s.billing_frequency} billing will be ${rupees(pr.price_paise)} from your next renewal.` : '';
    notify(s.account_id, 'plan_changed', `Changes to your ${plan.name} plan`,
      `${summary || 'Your plan has been updated.'} ${scope === 'immediate' ? 'Feature changes are effective now.' : 'Changes take effect at your next renewal.'}${priceNote}`, { plan_id: planId, scope });
  }
}

function publish(actor, planId) {
  return db.tx(() => {
    const p = db.one('SELECT * FROM subscription_plans WHERE id = ?', planId);
    if (!p) throw notFound('Plan');
    if (p.status === 'archived') throw conflict('Archived plans cannot be published');
    validate(p, db.all('SELECT * FROM plan_prices WHERE plan_id = ?', planId), {});
    db.update('subscription_plans', planId, { status: 'active', published_at: p.published_at || clock.iso(), updated_at: clock.iso() });
    if (!db.one('SELECT 1 FROM plan_versions WHERE plan_id = ? AND version = ?', planId, p.version)) {
      db.insert('plan_versions', { plan_id: planId, version: p.version, snapshot_json: snapshot(planId), change_scope: 'new_only', change_summary: 'Published', published_by: actor.userId, published_at: clock.iso() });
    }
    audit.log(actor, 'plan.published', 'subscription_plan', planId, { before: { status: p.status }, after: { status: 'active' } });
    return byId(planId);
  });
}

function setStatus(actor, planId, status) {
  if (!['active', 'inactive'].includes(status)) throw bad('status must be active or inactive');
  if (status === 'active') return publish(actor, planId);
  return db.tx(() => {
    const p = db.one('SELECT * FROM subscription_plans WHERE id = ?', planId);
    if (!p) throw notFound('Plan');
    if (p.is_default) throw conflict('The default free plan cannot be deactivated; mark another free plan as default first');
    db.update('subscription_plans', planId, { status: 'inactive', updated_at: clock.iso() });
    audit.log(actor, 'plan.deactivated', 'subscription_plan', planId, { before: { status: p.status }, after: { status: 'inactive' } });
    return byId(planId);
  });
}

/** Plans never used by a subscription are deleted; otherwise they are archived (history is preserved). */
function remove(actor, planId) {
  return db.tx(() => {
    const p = db.one('SELECT * FROM subscription_plans WHERE id = ?', planId);
    if (!p) throw notFound('Plan');
    if (p.is_default) throw conflict('The default plan cannot be deleted');
    const used = db.one('SELECT COUNT(*) c FROM subscriptions WHERE plan_id = ?', planId).c;
    const current = db.one("SELECT COUNT(*) c FROM subscriptions WHERE plan_id = ? AND is_current = 1 AND status NOT IN ('cancelled','expired')", planId).c;
    if (current) throw conflict(`${current} account(s) are still subscribed. Deactivate the plan and migrate subscribers first.`);
    if (used || db.one('SELECT COUNT(*) c FROM commission_rules WHERE seller_plan_id = ? OR buyer_plan_id = ?', planId, planId).c) {
      db.update('subscription_plans', planId, { status: 'archived', visibility: 'hidden', updated_at: clock.iso() });
      audit.log(actor, 'plan.archived', 'subscription_plan', planId, { before: { status: p.status }, reason: 'Plan has subscription history; archived instead of deleted' });
      return { archived: true };
    }
    audit.log(actor, 'plan.deleted', 'subscription_plan', planId, { before: snapshot(planId) });
    db.run('DELETE FROM subscription_entitlements WHERE plan_id = ?', planId);
    db.run('DELETE FROM subscription_features WHERE plan_id = ?', planId);
    db.run('DELETE FROM plan_prices WHERE plan_id = ?', planId);
    db.run('DELETE FROM plan_versions WHERE plan_id = ?', planId);
    db.run('DELETE FROM subscription_plans WHERE id = ?', planId);
    return { deleted: true };
  });
}

function versions(planId) {
  return db.all('SELECT id, version, change_scope, change_summary, published_by, published_at FROM plan_versions WHERE plan_id = ? ORDER BY version DESC', planId);
}

module.exports = { list, byId, byCode, create, update, impact, publish, setStatus, remove, versions, effectivePrice, FREQ_MONTHS, hydrate };
