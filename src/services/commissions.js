'use strict';
/**
 * Transaction commission engine.
 * Rules match on seller plan, buyer plan, category, region, order type, order value and validity window
 * (promotional periods). Highest priority wins, then most specific. If no rule matches, the seller plan's
 * commission fields apply. Commission is quoted at order time, recognised only when the order completes,
 * voided on cancellation, and billed on a periodic commission invoice.
 */
const db = require('../db');
const clock = require('../lib/clock');
const audit = require('../lib/audit');
const settings = require('../lib/settings');
const billing = require('./billing');
const ent = require('./entitlements');
const { bad, notFound, pct, rupees } = require('../lib/util');

const CONDITIONS = ['seller_plan_id', 'buyer_plan_id', 'category_id', 'region', 'order_type'];
const RULE_FIELDS = ['name', 'priority', 'status', 'model', 'rate_bps', 'fixed_paise', 'min_fee_paise', 'max_fee_paise', 'charged_to', 'buyer_share_bps', ...CONDITIONS, 'min_order_paise', 'max_order_paise', 'valid_from', 'valid_until'];

function planOf(accountId) {
  const s = ent.currentSubscription(accountId);
  return s && ent.ACCESS_STATUSES.includes(s.status) ? s.plan_id : ent.defaultPlan(db.one('SELECT type FROM accounts WHERE id = ?', accountId).type)?.id;
}

function matchRule(ctx) {
  const at = ctx.at || clock.iso();
  const rules = db.all("SELECT * FROM commission_rules WHERE status = 'active' AND (valid_from IS NULL OR valid_from <= ?) AND (valid_until IS NULL OR valid_until > ?)", at, at);
  const ok = rules.filter((r) =>
    (r.seller_plan_id == null || r.seller_plan_id === ctx.sellerPlanId) && (r.buyer_plan_id == null || r.buyer_plan_id === ctx.buyerPlanId) &&
    (r.category_id == null || r.category_id === ctx.categoryId) && (r.region == null || r.region === ctx.region) &&
    (r.order_type == null || r.order_type === ctx.orderType) && (r.min_order_paise == null || ctx.orderValue >= r.min_order_paise) &&
    (r.max_order_paise == null || ctx.orderValue <= r.max_order_paise));
  const spec = (r) => CONDITIONS.filter((c) => r[c] != null).length + (r.min_order_paise != null || r.max_order_paise != null ? 1 : 0);
  ok.sort((a, b) => b.priority - a.priority || spec(b) - spec(a) || b.id - a.id);
  return ok[0] || null;
}

function feeFor(rule, value) {
  let fee = 0;
  if (rule.model === 'percentage') fee = pct(value, rule.rate_bps);
  else if (rule.model === 'fixed') fee = rule.fixed_paise;
  else fee = pct(value, rule.rate_bps) + rule.fixed_paise;
  if (rule.min_fee_paise != null) fee = Math.max(fee, rule.min_fee_paise);
  if (rule.max_fee_paise != null) fee = Math.min(fee, rule.max_fee_paise);
  return Math.min(fee, value);
}

/** Quote the platform commission for a prospective order (shown before confirmation). */
function quote({ sellerAccountId, buyerAccountId, categoryId, region, orderType = 'standard', orderValue }) {
  const cfg = settings.get('commissions');
  const none = { enabled: false, commission_paise: 0, buyer_portion_paise: 0, seller_portion_paise: 0, charged_to: null, rule_source: 'none', rule: null, description: 'No platform commission on this order' };
  if (!cfg.enabled) return none;
  const ctx = { sellerPlanId: planOf(sellerAccountId), buyerPlanId: planOf(buyerAccountId), categoryId, region, orderType, orderValue };
  let rule = matchRule(ctx);
  let source = 'rule';
  if (!rule) {
    const plan = db.one('SELECT * FROM subscription_plans WHERE id = ?', ctx.sellerPlanId);
    if (!plan || (plan.commission_bps == null && plan.commission_fixed_paise == null)) return { ...none, enabled: true };
    rule = { id: null, name: `${plan.name} plan rate`, model: plan.commission_fixed_paise ? (plan.commission_bps ? 'percentage_plus_fixed' : 'fixed') : 'percentage', rate_bps: plan.commission_bps || 0, fixed_paise: plan.commission_fixed_paise || 0, min_fee_paise: null, max_fee_paise: null, charged_to: cfg.default_charged_to, buyer_share_bps: 5000 };
    source = 'plan';
  }
  const fee = feeFor(rule, orderValue);
  let buyer = 0;
  let seller = 0;
  if (rule.charged_to === 'buyer') buyer = fee;
  else if (rule.charged_to === 'both') { buyer = pct(fee, rule.buyer_share_bps); seller = fee - buyer; } else seller = fee; // seller | included_in_price | deducted_from_payout
  const rate = rule.model === 'fixed' ? rupees(rule.fixed_paise) : rule.model === 'percentage' ? `${rule.rate_bps / 100}%` : `${rule.rate_bps / 100}% + ${rupees(rule.fixed_paise)}`;
  const who = { seller: 'charged to the seller', buyer: 'charged to the buyer', both: 'shared by buyer and seller', included_in_price: 'included in the listed price', deducted_from_payout: "deducted from the seller's payout" }[rule.charged_to];
  return { enabled: true, commission_paise: fee, buyer_portion_paise: buyer, seller_portion_paise: seller, charged_to: rule.charged_to, rule_source: source, rule: { id: rule.id, name: rule.name, model: rule.model, rate_bps: rule.rate_bps, fixed_paise: rule.fixed_paise }, description: `Platform fee ${rate} (${rupees(fee)}) ${who}` };
}

function recordForOrder(order, q) {
  const now = clock.iso();
  db.insert('transaction_commissions', {
    order_id: order.id, rule_id: q.rule?.id ?? null, rule_source: q.rule_source, rule_snapshot_json: q, order_value_paise: order.subtotal_paise,
    commission_paise: q.commission_paise, buyer_portion_paise: q.buyer_portion_paise, seller_portion_paise: q.seller_portion_paise,
    charged_to: q.charged_to || 'seller', status: q.commission_paise > 0 ? 'pending' : 'void', created_at: now, updated_at: now,
  });
}

/** Recognise commission revenue only when the order completes. */
function onOrderCompleted(order) {
  const tc = db.one("SELECT * FROM transaction_commissions WHERE order_id = ? AND status = 'pending'", order.id);
  if (!tc) return;
  const now = clock.iso();
  db.update('transaction_commissions', tc.id, { status: 'recognised', recognised_at: now, updated_at: now });
  billing.recordRevenue({ category: 'transaction_commission', amount: tc.commission_paise, accountId: order.seller_account_id, sourceType: 'transaction_commission', sourceId: tc.id, orderId: order.id, planId: planOf(order.seller_account_id) });
}

function onOrderCancelled(order) {
  const tc = db.one('SELECT * FROM transaction_commissions WHERE order_id = ?', order.id);
  if (!tc) return;
  if (tc.status === 'pending') db.update('transaction_commissions', tc.id, { status: 'void', updated_at: clock.iso() });
  else if (tc.status === 'recognised' || tc.status === 'invoiced') {
    db.update('transaction_commissions', tc.id, { status: 'reversed', updated_at: clock.iso() });
    billing.recordRevenue({ category: 'transaction_commission', entryType: 'reversal', amount: -tc.commission_paise, accountId: order.seller_account_id, sourceType: 'transaction_commission', sourceId: tc.id, orderId: order.id, notes: 'Order cancelled after completion' });
  }
}

/** Bill recognised commissions (and logistics fees) per payer account. */
function invoiceOutstanding(actor = 'system') {
  const created = [];
  db.tx(() => {
    const rows = db.all("SELECT tc.*, o.order_number, o.buyer_account_id, o.seller_account_id FROM transaction_commissions tc JOIN orders o ON o.id = tc.order_id WHERE tc.status = 'recognised' AND tc.invoice_id IS NULL");
    const byAccount = {};
    for (const r of rows) {
      if (r.seller_portion_paise > 0) (byAccount[r.seller_account_id] ||= []).push({ description: `Platform commission — order ${r.order_number}`, item_type: 'commission', unit_amount_paise: r.seller_portion_paise, related_type: 'transaction_commission', related_id: r.id });
      if (r.buyer_portion_paise > 0) (byAccount[r.buyer_account_id] ||= []).push({ description: `Platform fee — order ${r.order_number}`, item_type: 'commission', unit_amount_paise: r.buyer_portion_paise, related_type: 'transaction_commission', related_id: r.id });
    }
    const lc = db.all("SELECT lc.*, o.order_number FROM logistics_commissions lc JOIN logistics_transactions lt ON lt.id = lc.logistics_transaction_id JOIN orders o ON o.id = lt.order_id WHERE lc.status = 'recognised' AND lc.invoice_id IS NULL AND lc.payer_account_id IS NOT NULL");
    for (const r of lc) (byAccount[r.payer_account_id] ||= []).push({ description: `Logistics coordination fee — order ${r.order_number}`, item_type: 'logistics_fee', unit_amount_paise: r.amount_paise, related_type: 'logistics_commission', related_id: r.id });
    for (const [accountId, items] of Object.entries(byAccount)) {
      const inv = billing.createInvoice({ accountId: Number(accountId), type: 'commission', items, actor, applyAccountCredit: false, dueAt: new Date(clock.now().getTime() + settings.get('commissions').invoice_due_days * 86400000).toISOString() });
      for (const it of items) {
        if (it.related_type === 'transaction_commission') db.run("UPDATE transaction_commissions SET status = 'invoiced', invoice_id = COALESCE(invoice_id, ?), updated_at = ? WHERE id = ?", inv.id, clock.iso(), it.related_id);
        else db.run("UPDATE logistics_commissions SET status = 'invoiced', invoice_id = ?, updated_at = ? WHERE id = ?", inv.id, clock.iso(), it.related_id);
      }
      created.push(inv.id);
    }
  });
  return created;
}

// --- admin CRUD
function validate(r) {
  if (!r.name) throw bad('Rule name is required');
  if (!['percentage', 'fixed', 'percentage_plus_fixed'].includes(r.model)) throw bad('model must be percentage, fixed or percentage_plus_fixed');
  if (!['seller', 'buyer', 'both', 'included_in_price', 'deducted_from_payout'].includes(r.charged_to)) throw bad('Invalid charged_to');
  if (r.rate_bps < 0 || r.rate_bps > 5000) throw bad('rate_bps must be between 0 and 5000 (0–50%)');
}
function create(actor, body) {
  const row = Object.fromEntries(RULE_FIELDS.filter((f) => body[f] !== undefined && body[f] !== '').map((f) => [f, body[f]]));
  row.rate_bps = Number(row.rate_bps || 0); row.fixed_paise = Number(row.fixed_paise || 0);
  validate(row);
  return db.tx(() => {
    const id = db.insert('commission_rules', { ...row, created_by: actor.userId, created_at: clock.iso(), updated_at: clock.iso() });
    audit.log(actor, 'commission_rule.created', 'commission_rule', id, { after: row });
    return db.one('SELECT * FROM commission_rules WHERE id = ?', id);
  });
}
function update(actor, id, body) {
  const before = db.one('SELECT * FROM commission_rules WHERE id = ?', id);
  if (!before) throw notFound('Commission rule');
  const patch = Object.fromEntries(RULE_FIELDS.filter((f) => body[f] !== undefined).map((f) => [f, body[f] === '' ? null : body[f]]));
  validate({ ...before, ...patch });
  return db.tx(() => {
    db.update('commission_rules', id, { ...patch, updated_at: clock.iso() });
    audit.log(actor, 'commission_rule.updated', 'commission_rule', id, { before, after: patch });
    return db.one('SELECT * FROM commission_rules WHERE id = ?', id);
  });
}
const list = () => db.all('SELECT r.*, sp.name seller_plan, bp.name buyer_plan, c.name category FROM commission_rules r LEFT JOIN subscription_plans sp ON sp.id = r.seller_plan_id LEFT JOIN subscription_plans bp ON bp.id = r.buyer_plan_id LEFT JOIN categories c ON c.id = r.category_id ORDER BY r.status, r.priority DESC, r.id');

module.exports = { quote, matchRule, feeFor, recordForOrder, onOrderCompleted, onOrderCancelled, invoiceOutstanding, create, update, list, planOf };
