'use strict';
/**
 * Featured / promoted listings. Paid with a verified payment, or with promotion credits
 * (plan allowance per billing cycle first, then bonus credits from referrals/admin grants).
 */
const db = require('../db');
const clock = require('../lib/clock');
const audit = require('../lib/audit');
const { notify } = require('../lib/notify');
const billing = require('./billing');
const ent = require('./entitlements');
const discounts = require('./discounts');
const { bad, notFound, conflict, forbidden, addHours, rupees } = require('../lib/util');

const LABEL = { featured: 'Featured', category: 'Category spotlight', regional: 'Regional spotlight', homepage: 'Homepage feature', urgent_harvest: 'Urgent harvest' };

function catalog({ all = false } = {}) {
  return db.all(`SELECT * FROM promotions ${all ? '' : "WHERE status = 'active'"} ORDER BY sort_order, id`);
}

function bonusBalance(accountId) {
  return db.one("SELECT COALESCE(SUM(amount),0) b FROM credit_ledger WHERE account_id = ? AND credit_type = 'promotion' AND (expires_at IS NULL OR expires_at > ?)", accountId, clock.iso()).b;
}

function quote(accountId, { listing_id, promotion_code, discount_code }) {
  const promo = db.one("SELECT * FROM promotions WHERE code = ? AND status = 'active'", promotion_code);
  if (!promo) throw notFound('Promotion option');
  const allowance = ent.value(accountId, 'featured_listing_credits') || 0;
  const remaining = Math.max(0, allowance - ent.counter(accountId, 'featured_listing_credits'));
  let disc = null;
  if (discount_code) disc = discounts.evaluate(discount_code, { accountId, audience: 'farmer', purpose: 'promotion', amount: promo.price_paise });
  return { promotion: promo, listing_id, price_paise: promo.price_paise, discount_paise: disc?.amount || 0, credit_cost: promo.credit_cost, plan_credits_remaining: remaining, bonus_credits: bonusBalance(accountId), can_use_credits: remaining + bonusBalance(accountId) >= promo.credit_cost };
}

/** Steps 3–8 of the promotion workflow. */
function purchase(accountId, actor, { listing_id, promotion_code, target_region, target_category_id, use_credits = false, discount_code }) {
  return db.tx(() => {
    const listing = db.one('SELECT * FROM listings WHERE id = ?', listing_id);
    if (!listing) throw notFound('Listing');
    if (listing.account_id !== accountId) throw forbidden('You can only promote your own listings');
    if (listing.status !== 'active') throw bad('Only active listings can be promoted');
    const promo = db.one("SELECT * FROM promotions WHERE code = ? AND status = 'active'", promotion_code);
    if (!promo) throw notFound('Promotion option');
    const region = promo.requires_region ? (target_region || listing.region) : null;
    const category = promo.requires_category ? Number(target_category_id || listing.category_id) : null;
    if (promo.requires_region && !region) throw bad('Choose a target region');
    if (promo.max_concurrent) {
      const n = db.one("SELECT COUNT(*) c FROM promotion_purchases WHERE promotion_id = ? AND status = 'active' AND COALESCE(target_region,'') = COALESCE(?, '') AND COALESCE(target_category_id,0) = COALESCE(?,0)", promo.id, region, category).c;
      if (n >= promo.max_concurrent) throw conflict('All promotion slots for this target are taken right now. Try another region/category or check back later.');
    }
    if (db.one("SELECT 1 FROM promotion_purchases WHERE listing_id = ? AND promotion_id = ? AND status IN ('active','pending_payment')", listing.id, promo.id)) throw conflict('This listing already has this promotion active or awaiting payment');
    const now = clock.iso();
    const base = { promotion_id: promo.id, account_id: accountId, listing_id: listing.id, target_region: region, target_category_id: category, price_paise: promo.price_paise, created_at: now, updated_at: now };

    if (use_credits) {
      const allowance = ent.value(accountId, 'featured_listing_credits') || 0;
      const planLeft = Math.max(0, allowance - ent.counter(accountId, 'featured_listing_credits'));
      const bonus = bonusBalance(accountId);
      if (planLeft + bonus < promo.credit_cost) {
        ent.assertLimit(accountId, 'featured_listing_credits', promo.credit_cost, 'promotion');
        throw bad('Not enough promotion credits');
      }
      const fromPlan = Math.min(planLeft, promo.credit_cost);
      const fromBonus = promo.credit_cost - fromPlan;
      const id = db.insert('promotion_purchases', { ...base, amount_charged_paise: 0, paid_with: fromPlan ? 'plan_credits' : 'bonus_credits', credits_used: promo.credit_cost, status: 'active', starts_at: now, ends_at: addHours(now, promo.duration_hours) });
      if (fromPlan) ent.incrementCounter(accountId, 'featured_listing_credits', fromPlan);
      if (fromBonus) db.insert('credit_ledger', { account_id: accountId, credit_type: 'promotion', amount: -fromBonus, reason: `Used for ${promo.name}`, related_type: 'promotion_purchase', related_id: id, created_at: now });
      notify(accountId, 'promotion_active', `${promo.name} is live`, `"${listing.product_name}" is promoted until ${new Date(addHours(now, promo.duration_hours)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}.`);
      return { activated: true, purchase: get(id) };
    }

    const id = db.insert('promotion_purchases', { ...base, amount_charged_paise: promo.price_paise, paid_with: 'payment', status: 'pending_payment' });
    const items = [{ description: `${promo.name} — "${listing.product_name}"${region ? ` · ${region}` : ''}`, item_type: 'promotion', unit_amount_paise: promo.price_paise, related_type: 'promotion_purchase', related_id: id }];
    let disc = null;
    if (discount_code) {
      disc = discounts.evaluate(discount_code, { accountId, audience: 'farmer', purpose: 'promotion', amount: promo.price_paise });
      if (disc.amount) items.push({ description: `Discount ${disc.code.code}`, item_type: 'discount', unit_amount_paise: -disc.amount, related_type: 'discount_code', related_id: disc.code.id });
    }
    const inv = billing.createInvoice({ accountId, type: 'promotion', items, relatedType: 'promotion_purchase', relatedId: id, actor });
    db.update('promotion_purchases', id, { invoice_id: inv.id });
    if (disc?.amount) discounts.reserve(disc.code.id, accountId, inv.id, null, disc.amount);
    if (inv.total_paise === 0) { billing.settleZeroInvoice(inv); return { activated: true, purchase: get(id) }; }
    return { requires_payment: true, invoice: inv, purchase: get(id) };
  });
}

billing.on('paid', 'promotion', (inv) => {
  const pp = db.one('SELECT * FROM promotion_purchases WHERE id = ?', inv.related_id);
  if (!pp || pp.status !== 'pending_payment') return;
  const promo = db.one('SELECT * FROM promotions WHERE id = ?', pp.promotion_id);
  const now = clock.iso();
  const ends = addHours(now, promo.duration_hours);
  db.update('promotion_purchases', pp.id, { status: 'active', starts_at: now, ends_at: ends, updated_at: now });
  const listing = db.one('SELECT product_name FROM listings WHERE id = ?', pp.listing_id);
  notify(pp.account_id, 'promotion_active', `${promo.name} is live`, `"${listing.product_name}" is promoted until ${new Date(ends).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}.`);
});
billing.on('voided', 'promotion', (inv) => {
  db.run("UPDATE promotion_purchases SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'pending_payment'", clock.iso(), inv.related_id);
});

function expire() {
  const due = db.all("SELECT pp.*, p.name promo_name, l.product_name FROM promotion_purchases pp JOIN promotions p ON p.id = pp.promotion_id JOIN listings l ON l.id = pp.listing_id WHERE pp.status = 'active' AND pp.ends_at <= ?", clock.iso());
  for (const pp of due) {
    db.update('promotion_purchases', pp.id, { status: 'expired', updated_at: clock.iso() });
    const s = stats(pp.id);
    notify(pp.account_id, 'promotion_expired', `${pp.promo_name} ended`, `"${pp.product_name}": ${s.impressions} impressions, ${s.views} views, ${s.enquiries} enquiries, ${s.orders} orders (${rupees(s.revenue_paise)}).`);
  }
  // abandoned unpaid promotions
  for (const pp of db.all("SELECT * FROM promotion_purchases WHERE status = 'pending_payment' AND created_at < ?", new Date(clock.now() - 48 * 3600000).toISOString())) {
    if (pp.invoice_id && db.one("SELECT 1 FROM invoices WHERE id = ? AND status = 'issued' AND amount_paid_paise = 0", pp.invoice_id)) billing.voidInvoice(pp.invoice_id, 'system', 'Promotion checkout abandoned');
  }
  return due.length;
}

/** Active promotions relevant to a marketplace query: listing_id → { purchase_id, type, label } */
function activeForQuery({ categoryId, region, homepage = false }) {
  const rows = db.all("SELECT pp.id, pp.listing_id, pp.target_region, pp.target_category_id, p.promotion_type FROM promotion_purchases pp JOIN promotions p ON p.id = pp.promotion_id WHERE pp.status = 'active' AND pp.starts_at <= ? AND pp.ends_at > ?", clock.iso(), clock.iso());
  const map = {};
  const rank = { homepage: 5, urgent_harvest: 4, featured: 3, category: 2, regional: 2 };
  for (const r of rows) {
    const relevant = r.promotion_type === 'featured' || r.promotion_type === 'urgent_harvest' || (r.promotion_type === 'homepage' && homepage) ||
      (r.promotion_type === 'category' && categoryId && r.target_category_id === Number(categoryId)) ||
      (r.promotion_type === 'regional' && region && r.target_region === region);
    if (!relevant) continue;
    const cur = map[r.listing_id];
    if (!cur || rank[r.promotion_type] > cur.rank) map[r.listing_id] = { purchase_id: r.id, type: r.promotion_type, label: LABEL[r.promotion_type], rank: rank[r.promotion_type] };
  }
  return map;
}

function activeForListing(listingId) {
  return db.one("SELECT id FROM promotion_purchases WHERE listing_id = ? AND status = 'active' AND ends_at > ? ORDER BY id DESC LIMIT 1", listingId, clock.iso());
}

function track(purchaseId, metric, { revenue = 0, by = 1 } = {}) {
  if (!purchaseId) return;
  const day = clock.iso().slice(0, 10);
  db.run(`INSERT INTO promotion_analytics (purchase_id, day, ${metric}, revenue_paise) VALUES (?,?,?,?)
          ON CONFLICT(purchase_id, day) DO UPDATE SET ${metric} = ${metric} + excluded.${metric}, revenue_paise = revenue_paise + excluded.revenue_paise`, purchaseId, day, by, revenue);
}

function stats(purchaseId) {
  const s = db.one('SELECT COALESCE(SUM(impressions),0) impressions, COALESCE(SUM(views),0) views, COALESCE(SUM(enquiries),0) enquiries, COALESCE(SUM(orders),0) orders, COALESCE(SUM(revenue_paise),0) revenue_paise FROM promotion_analytics WHERE purchase_id = ?', purchaseId);
  s.conversion_rate = s.views ? Math.round((s.orders / s.views) * 1000) / 10 : 0;
  s.ctr = s.impressions ? Math.round((s.views / s.impressions) * 1000) / 10 : 0;
  return s;
}

function get(id) {
  const pp = db.one('SELECT pp.*, p.name promotion_name, p.promotion_type, l.product_name FROM promotion_purchases pp JOIN promotions p ON p.id = pp.promotion_id JOIN listings l ON l.id = pp.listing_id WHERE pp.id = ?', id);
  return pp ? { ...pp, performance: stats(pp.id) } : null;
}

function forAccount(accountId) {
  return db.all('SELECT id FROM promotion_purchases WHERE account_id = ? ORDER BY id DESC', accountId).map((r) => get(r.id));
}

const PROMO_FIELDS = ['code', 'name', 'promotion_type', 'description', 'duration_hours', 'price_paise', 'credit_cost', 'requires_region', 'requires_category', 'max_concurrent', 'status', 'sort_order'];
function createProduct(actor, body) {
  const row = Object.fromEntries(PROMO_FIELDS.filter((f) => body[f] !== undefined).map((f) => [f, body[f]]));
  if (!row.code || !row.name || !LABEL[row.promotion_type]) throw bad('code, name and a valid promotion_type are required');
  if (!(row.duration_hours > 0) || !(row.price_paise >= 0)) throw bad('duration_hours and price_paise are required');
  return db.tx(() => {
    const id = db.insert('promotions', { ...row, created_at: clock.iso(), updated_at: clock.iso() });
    audit.log(actor, 'promotion_product.created', 'promotion', id, { after: row });
    return db.one('SELECT * FROM promotions WHERE id = ?', id);
  });
}
function updateProduct(actor, id, body) {
  const before = db.one('SELECT * FROM promotions WHERE id = ?', id);
  if (!before) throw notFound('Promotion option');
  const patch = Object.fromEntries(PROMO_FIELDS.filter((f) => body[f] !== undefined && f !== 'code').map((f) => [f, body[f]]));
  return db.tx(() => {
    db.update('promotions', id, { ...patch, updated_at: clock.iso() });
    audit.log(actor, 'promotion_product.updated', 'promotion', id, { before, after: patch });
    return db.one('SELECT * FROM promotions WHERE id = ?', id);
  });
}

module.exports = { catalog, quote, purchase, expire, activeForQuery, activeForListing, track, stats, get, forAccount, createProduct, updateProduct, bonusBalance, LABEL };
