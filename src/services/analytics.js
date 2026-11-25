'use strict';
/** Platform owner analytics: overview, revenue dashboard, subscription analytics and exports. */
const db = require('../db');
const clock = require('../lib/clock');
const ent = require('./entitlements');
const { addDays } = require('../lib/util');

const CATEGORIES = ['farmer_subscription', 'buyer_subscription', 'enterprise_subscription', 'transaction_commission', 'featured_listing', 'promoted_inventory', 'procurement_service', 'logistics_commission', 'advertising', 'other'];
const PAID_ACCESS = "('active','payment_failed','past_due')";

function range(q) {
  const to = q.to ? new Date(q.to).toISOString() : clock.iso();
  const from = q.from ? new Date(q.from).toISOString() : addDays(to, -30);
  return { from, to };
}

function mrr(filter = {}) {
  const where = [`s.is_current = 1`, `s.status IN ${PAID_ACCESS}`, 's.price_paise > 0'];
  const p = [];
  if (filter.audience) { where.push('pl.audience = ?'); p.push(filter.audience); }
  if (filter.plan_id) { where.push('s.plan_id = ?'); p.push(Number(filter.plan_id)); }
  if (filter.region) { where.push('a.region = ?'); p.push(filter.region); }
  const r = db.one(`SELECT COALESCE(SUM(s.price_paise * 1.0 / COALESCE(NULLIF(s.interval_months,0),1)),0) mrr, COUNT(*) n FROM subscriptions s JOIN subscription_plans pl ON pl.id = s.plan_id JOIN accounts a ON a.id = s.account_id WHERE ${where.join(' AND ')}`, ...p);
  return { mrr_paise: Math.round(r.mrr), paying: r.n };
}

function overview(q = {}) {
  const { from, to } = range(q);
  const d30 = addDays(clock.iso(), -30);
  const c = (sql, ...p) => db.one(sql, ...p).c;
  const users = c("SELECT COUNT(*) c FROM users u JOIN accounts a ON a.id = u.account_id WHERE a.type IN ('farmer','buyer','advertiser')");
  const farmers = c("SELECT COUNT(*) c FROM accounts WHERE type = 'farmer'");
  const buyers = c("SELECT COUNT(*) c FROM accounts WHERE type = 'buyer'");
  const activeFarmers = c("SELECT COUNT(DISTINCT a.id) c FROM accounts a WHERE a.type = 'farmer' AND (EXISTS (SELECT 1 FROM listings l WHERE l.account_id = a.id AND l.status = 'active') OR EXISTS (SELECT 1 FROM orders o WHERE o.seller_account_id = a.id AND o.placed_at >= ?))", d30);
  const activeBuyers = c("SELECT COUNT(DISTINCT a.id) c FROM accounts a WHERE a.type = 'buyer' AND (EXISTS (SELECT 1 FROM orders o WHERE o.buyer_account_id = a.id AND o.placed_at >= ?) OR EXISTS (SELECT 1 FROM search_logs s WHERE s.account_id = a.id AND s.created_at >= ?))", d30, d30);
  const paying = (t) => c(`SELECT COUNT(*) c FROM subscriptions s JOIN accounts a ON a.id = s.account_id WHERE s.is_current = 1 AND s.status IN ${PAID_ACCESS} AND s.price_paise > 0 AND a.type = ?`, t);
  const payingFarmers = paying('farmer');
  const payingBuyers = paying('buyer');
  const subsBy = (st) => c('SELECT COUNT(*) c FROM subscriptions WHERE is_current = 1 AND status = ?', st);
  const m = mrr();
  const rev = Object.fromEntries(CATEGORIES.map((k) => [k, 0]));
  for (const r of db.all('SELECT category, SUM(amount_paise) s FROM revenue_records WHERE recognised_at >= ? AND recognised_at < ? GROUP BY category', from, to)) rev[r.category] = r.s;
  const gmv = db.one("SELECT COALESCE(SUM(subtotal_paise),0) g, COUNT(*) n FROM orders WHERE status = 'completed' AND completed_at >= ? AND completed_at < ?", from, to);
  const closed = db.one("SELECT SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) ok, SUM(CASE WHEN status IN ('cancelled','rejected') THEN 1 ELSE 0 END) bad FROM orders WHERE placed_at >= ? AND placed_at < ?", from, to);
  const churnEvents = c("SELECT COUNT(DISTINCT account_id) c FROM subscription_history WHERE event IN ('cancelled','expired') AND created_at >= ? AND created_at < ?", from, to);
  const payingStart = Math.max(1, payingFarmers + payingBuyers + churnEvents);
  const lostMrr = db.one(`SELECT COALESCE(SUM(s.price_paise * 1.0 / COALESCE(NULLIF(s.interval_months,0),1)),0) v FROM subscription_history h JOIN subscriptions s ON s.id = h.subscription_id WHERE h.event IN ('cancelled','expired','suspended') AND s.price_paise > 0 AND h.created_at >= ? AND h.created_at < ?`, from, to).v;
  const newAccounts = c('SELECT COUNT(*) c FROM accounts WHERE created_at >= ? AND created_at < ?', from, to);
  const prevAccounts = c('SELECT COUNT(*) c FROM accounts WHERE created_at >= ? AND created_at < ?', addDays(from, -(new Date(to) - new Date(from)) / 86400000), from);
  const totalRev = Object.values(rev).reduce((s, v) => s + v, 0);
  return {
    period: { from, to },
    users: { total_registered_users: users, total_farmers: farmers, total_buyers: buyers, active_farmers: activeFarmers, active_buyers: activeBuyers, paying_farmers: payingFarmers, paying_buyers: payingBuyers, free_accounts: farmers + buyers - payingFarmers - payingBuyers },
    subscriptions: { active: subsBy('active') + subsBy('payment_failed') + subsBy('past_due'), active_paid: payingFarmers + payingBuyers, trial: subsBy('trial'), suspended: subsBy('suspended'),
      cancelled_in_period: c("SELECT COUNT(*) c FROM subscription_history WHERE event = 'cancelled' AND created_at >= ? AND created_at < ?", from, to),
      expired_in_period: c("SELECT COUNT(*) c FROM subscription_history WHERE event = 'expired' AND created_at >= ? AND created_at < ?", from, to) },
    revenue: { mrr_paise: m.mrr_paise, arr_paise: m.mrr_paise * 12, by_category: rev, subscription_paise: rev.farmer_subscription + rev.buyer_subscription + rev.enterprise_subscription, total_paise: totalRev },
    marketplace: { gmv_paise: gmv.g, completed_transactions: gmv.n, avg_transaction_paise: gmv.n ? Math.round(gmv.g / gmv.n) : 0, fulfilment_rate: (closed.ok || 0) + (closed.bad || 0) ? Math.round(((closed.ok || 0) / ((closed.ok || 0) + (closed.bad || 0))) * 1000) / 10 : null,
      new_accounts: newAccounts, growth_rate: prevAccounts ? Math.round(((newAccounts - prevAccounts) / prevAccounts) * 1000) / 10 : null },
    health: { subscription_conversion_rate: farmers + buyers ? Math.round(((payingFarmers + payingBuyers) / (farmers + buyers)) * 1000) / 10 : 0, user_churn_rate: Math.round((churnEvents / payingStart) * 1000) / 10, revenue_churn_rate: m.mrr_paise + lostMrr ? Math.round((lostMrr / (m.mrr_paise + lostMrr)) * 1000) / 10 : 0 },
  };
}

function revenueWhere(q) {
  const { from, to } = range(q);
  const where = ['r.recognised_at >= ?', 'r.recognised_at < ?'];
  const p = [from, to];
  if (q.region) { where.push('r.region = ?'); p.push(q.region); }
  if (q.category) { where.push('r.category = ?'); p.push(q.category); }
  if (q.plan_id) { where.push('r.plan_id = ?'); p.push(Number(q.plan_id)); }
  if (q.user_type) { where.push('r.account_type = ?'); p.push(q.user_type); }
  if (q.transaction_type) { where.push('r.source_type = ?'); p.push(q.transaction_type); }
  return { sql: where.join(' AND '), p, from, to };
}

const BUCKET = { day: '%Y-%m-%d', week: '%Y-W%W', month: '%Y-%m', year: '%Y' };

function revenue(q = {}) {
  const w = revenueWhere(q);
  const g = BUCKET[q.granularity] ? q.granularity : 'day';
  const series = db.all(`SELECT strftime('${BUCKET[g]}', r.recognised_at) bucket, r.category, SUM(r.amount_paise) amount FROM revenue_records r WHERE ${w.sql} GROUP BY bucket, r.category ORDER BY bucket`, ...w.p);
  const buckets = {};
  for (const s of series) (buckets[s.bucket] ||= { bucket: s.bucket, total: 0 })[s.category] = s.amount, buckets[s.bucket].total += s.amount;
  const totals = db.all(`SELECT r.category, SUM(CASE WHEN r.entry_type='revenue' THEN r.amount_paise ELSE 0 END) gross, SUM(CASE WHEN r.entry_type='reversal' THEN r.amount_paise ELSE 0 END) reversals, SUM(CASE WHEN r.entry_type='adjustment' THEN r.amount_paise ELSE 0 END) adjustments, SUM(r.amount_paise) net, SUM(r.tax_paise) tax FROM revenue_records r WHERE ${w.sql} GROUP BY r.category`, ...w.p);
  const total = totals.reduce((s, t) => s + t.net, 0);
  const days = Math.max(1, (new Date(w.to) - new Date(w.from)) / 86400000);
  const prev = revenueWhere({ ...q, from: addDays(w.from, -days), to: w.from });
  const prevTotal = db.one(`SELECT COALESCE(SUM(r.amount_paise),0) s FROM revenue_records r WHERE ${prev.sql}`, ...prev.p).s;
  const m = mrr({ plan_id: q.plan_id, region: q.region, audience: q.user_type });
  const failed = db.one("SELECT COUNT(*) c, COALESCE(SUM(p.amount_paise),0) s FROM payment_attempts pa JOIN payments p ON p.id = pa.payment_id WHERE pa.status = 'failed' AND pa.created_at >= ? AND pa.created_at < ?", w.from, w.to);
  const refunds = db.one("SELECT COUNT(*) c, COALESCE(SUM(amount_paise),0) s FROM refunds WHERE status = 'processed' AND processed_at >= ? AND processed_at < ?", w.from, w.to);
  return {
    period: { from: w.from, to: w.to, granularity: g },
    totals: { net_paise: total, by_category: totals, previous_period_net_paise: prevTotal, growth_rate: prevTotal ? Math.round(((total - prevTotal) / Math.abs(prevTotal)) * 1000) / 10 : null, daily_average_paise: Math.round(total / days) },
    recurring: { mrr_paise: m.mrr_paise, arr_paise: m.mrr_paise * 12, paying_subscriptions: m.paying },
    series: Object.values(buckets),
    by_plan: db.all(`SELECT p.id plan_id, p.name plan, p.audience, SUM(r.amount_paise) amount FROM revenue_records r JOIN subscription_plans p ON p.id = r.plan_id WHERE ${w.sql} AND r.category LIKE '%subscription' GROUP BY p.id ORDER BY amount DESC`, ...w.p),
    by_region: db.all(`SELECT COALESCE(r.region,'unknown') region, SUM(r.amount_paise) amount FROM revenue_records r WHERE ${w.sql} GROUP BY r.region ORDER BY amount DESC`, ...w.p),
    by_customer: db.all(`SELECT a.id account_id, a.name, a.type, SUM(r.amount_paise) amount FROM revenue_records r JOIN accounts a ON a.id = r.account_id WHERE ${w.sql} GROUP BY a.id ORDER BY amount DESC LIMIT 20`, ...w.p),
    refunds: { count: refunds.c, amount_paise: refunds.s },
    failed_payments: { count: failed.c, amount_paise: failed.s },
    forecast: forecast(),
  };
}

/** Simple, explainable forecast: linear trend over the last 6 months, floored at current MRR for recurring revenue. */
function forecast() {
  const start = new Date(Date.UTC(clock.now().getUTCFullYear(), clock.now().getUTCMonth() - 5, 1)).toISOString();
  const rows = db.all("SELECT strftime('%Y-%m', recognised_at) m, SUM(amount_paise) s FROM revenue_records WHERE recognised_at >= ? GROUP BY m ORDER BY m", start);
  const ys = rows.map((r) => r.s);
  const n = ys.length;
  const m = mrr().mrr_paise;
  let slope = 0;
  let intercept = n ? ys[n - 1] : m;
  if (n >= 2) {
    const xm = (n - 1) / 2;
    const ym = ys.reduce((a, b) => a + b, 0) / n;
    slope = ys.reduce((s, y, i) => s + (i - xm) * (y - ym), 0) / ys.reduce((s, _, i) => s + (i - xm) ** 2, 0);
    intercept = ym - slope * xm;
  }
  const out = [];
  for (let k = 1; k <= 3; k++) {
    const d = new Date(Date.UTC(clock.now().getUTCFullYear(), clock.now().getUTCMonth() + k, 1));
    out.push({ month: d.toISOString().slice(0, 7), projected_paise: Math.max(m, Math.round(intercept + slope * (n - 1 + k))) });
  }
  return { method: 'Linear trend of the last 6 months of recognised revenue, floored at current MRR', history: rows, projection: out };
}

function subscriptionAnalytics(q = {}) {
  const { from, to } = range(q);
  const ev = Object.fromEntries(db.all('SELECT event, COUNT(*) n FROM subscription_history WHERE created_at >= ? AND created_at < ? GROUP BY event', from, to).map((r) => [r.event, r.n]));
  const newPaid = db.one("SELECT COUNT(*) c FROM subscription_history h JOIN subscription_plans p ON p.id = h.to_plan_id WHERE h.event IN ('activated','upgraded') AND p.pricing_model != 'free' AND h.created_at >= ? AND h.created_at < ?", from, to).c;
  const m = mrr();
  const total = db.one("SELECT COUNT(*) c FROM accounts WHERE type IN ('farmer','buyer')").c;
  const lost = (ev.cancelled || 0) + (ev.expired || 0);
  const monthlyChurn = (lost / Math.max(1, m.paying + lost)) * (30 / Math.max(1, (new Date(to) - new Date(from)) / 86400000));
  const perPlan = db.all(`SELECT p.id, p.name, p.audience, p.pricing_model,
      (SELECT COUNT(*) FROM subscriptions s WHERE s.plan_id = p.id AND s.is_current = 1 AND s.status IN ('trial','active','payment_failed','past_due')) subscribers,
      (SELECT COALESCE(SUM(r.amount_paise),0) FROM revenue_records r WHERE r.plan_id = p.id AND r.recognised_at >= ? AND r.recognised_at < ?) revenue_paise,
      (SELECT COUNT(*) FROM subscription_history h WHERE h.from_plan_id = p.id AND h.event IN ('cancelled','expired') AND h.created_at >= ? AND h.created_at < ?) churned,
      (SELECT COUNT(*) FROM subscription_history h WHERE h.to_plan_id = p.id AND h.event = 'trial_started' AND h.created_at >= ? AND h.created_at < ?) trials,
      (SELECT COUNT(*) FROM subscription_history h WHERE h.to_plan_id = p.id AND h.event = 'trial_converted' AND h.created_at >= ? AND h.created_at < ?) trial_conversions,
      (SELECT COUNT(*) FROM subscription_history h WHERE h.to_plan_id = p.id AND h.event IN ('activated','upgraded') AND h.created_at >= ? AND h.created_at < ?) new_subscriptions
    FROM subscription_plans p WHERE p.status != 'archived' ORDER BY p.audience, p.tier_rank`, from, to, from, to, from, to, from, to, from, to);
  for (const p of perPlan) {
    p.churn_rate = p.subscribers + p.churned ? Math.round((p.churned / (p.subscribers + p.churned)) * 1000) / 10 : 0;
    p.trial_conversion_rate = p.trials ? Math.round((p.trial_conversions / p.trials) * 1000) / 10 : null;
  }
  const paid = perPlan.filter((p) => p.pricing_model !== 'free');
  const top = (arr, key) => [...arr].sort((a, b) => (b[key] ?? -1) - (a[key] ?? -1)).slice(0, 3).map((p) => ({ plan: p.name, audience: p.audience, value: p[key] }));
  return {
    period: { from, to },
    totals: {
      total_subscriptions: db.one("SELECT COUNT(*) c FROM subscriptions WHERE status != 'pending'").c,
      active_subscriptions: db.one("SELECT COUNT(*) c FROM subscriptions WHERE is_current = 1 AND status IN ('active','payment_failed','past_due','trial')").c,
      paying_subscriptions: m.paying, new_paid_subscriptions: newPaid, upgrades: ev.upgraded || 0, downgrades: (ev.downgraded || 0), downgrades_scheduled: ev.downgrade_scheduled || 0,
      cancellations: ev.cancelled || 0, cancellations_scheduled: ev.cancel_scheduled || 0, renewals: ev.renewed || 0, failed_payments: ev.payment_failed || 0, expired: ev.expired || 0, suspended: ev.suspended || 0,
      trials_started: ev.trial_started || 0, trial_conversions: ev.trial_converted || 0,
      trial_conversion_rate: ev.trial_started ? Math.round(((ev.trial_converted || 0) / ev.trial_started) * 1000) / 10 : null,
      monthly_churn_rate: Math.round(monthlyChurn * 1000) / 10, annual_churn_rate: Math.round((1 - (1 - Math.min(1, monthlyChurn)) ** 12) * 1000) / 10,
      conversion_rate: total ? Math.round((m.paying / total) * 1000) / 10 : 0, mrr_paise: m.mrr_paise, arpa_paise: m.paying ? Math.round(m.mrr_paise / m.paying) : 0,
    },
    by_plan: perPlan,
    insights: {
      most_popular_plans: top(paid, 'subscribers'), highest_revenue_plans: top(paid, 'revenue_paise'), highest_churn_plans: top(paid, 'churn_rate'), highest_conversion_plans: top(paid.filter((p) => p.trials), 'trial_conversion_rate'),
      approaching_limits: approachingLimits(), likely_to_upgrade: likelyToUpgrade(), failed_payment_accounts: failedPaymentAccounts(),
    },
  };
}

function approachingLimits(threshold = 80) {
  const accts = db.all("SELECT a.id, a.name, a.type, p.name plan FROM accounts a JOIN subscriptions s ON s.account_id = a.id AND s.is_current = 1 JOIN subscription_plans p ON p.id = s.plan_id WHERE a.type IN ('farmer','buyer') AND a.status = 'active' LIMIT 1000");
  const out = [];
  for (const a of accts) {
    const hot = ent.usage(a.id).metrics.filter((m) => !m.unlimited && m.limit > 0 && m.percent >= threshold);
    if (hot.length) out.push({ account_id: a.id, name: a.name, type: a.type, plan: a.plan, metrics: hot.map((m) => ({ key: m.key, used: m.used, limit: m.limit, percent: m.percent })) });
  }
  return out.sort((x, y) => Math.max(...y.metrics.map((m) => m.percent)) - Math.max(...x.metrics.map((m) => m.percent))).slice(0, 50);
}

function likelyToUpgrade() {
  const since = addDays(clock.iso(), -30);
  const prompts = db.all('SELECT u.account_id, a.name, a.type, COUNT(*) prompts, GROUP_CONCAT(DISTINCT u.entitlement_key) features FROM upgrade_prompts u JOIN accounts a ON a.id = u.account_id WHERE u.created_at >= ? GROUP BY u.account_id ORDER BY prompts DESC LIMIT 50', since);
  const near = new Set(approachingLimits(90).map((a) => a.account_id));
  return prompts.map((p) => ({ ...p, near_limit: near.has(p.account_id), score: p.prompts + (near.has(p.account_id) ? 3 : 0) })).sort((a, b) => b.score - a.score);
}

function failedPaymentAccounts() {
  return db.all(`SELECT a.id account_id, a.name, a.type, s.status subscription_status, s.grace_ends_at, p.name plan,
      (SELECT COUNT(*) FROM payment_attempts pa JOIN payments py ON py.id = pa.payment_id WHERE py.account_id = a.id AND pa.status = 'failed') failed_attempts,
      (SELECT COALESCE(SUM(i.total_paise - i.amount_paid_paise),0) FROM invoices i WHERE i.account_id = a.id AND i.status IN ('issued','overdue')) outstanding_paise
    FROM accounts a JOIN subscriptions s ON s.account_id = a.id AND s.is_current = 1 JOIN subscription_plans p ON p.id = s.plan_id
    WHERE s.status IN ('payment_failed','past_due','suspended') ORDER BY s.status DESC`);
}

// ---------------------------------------------------------------- exports (CSV)
function csv(rows, cols) {
  const esc = (v) => { if (v == null) return ''; const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}
const inr = (p) => (p / 100).toFixed(2);

function exportRevenue(q) {
  const w = revenueWhere(q);
  const rows = db.all(`SELECT r.id, r.recognised_at, r.category, r.entry_type, r.amount_paise, r.tax_paise, a.name account, r.account_type, r.region, p.name plan, r.source_type, r.source_id, i.invoice_number, py.provider_payment_id, o.order_number, r.notes FROM revenue_records r LEFT JOIN accounts a ON a.id = r.account_id LEFT JOIN subscription_plans p ON p.id = r.plan_id LEFT JOIN invoices i ON i.id = r.invoice_id LEFT JOIN payments py ON py.id = r.payment_id LEFT JOIN orders o ON o.id = r.order_id WHERE ${w.sql} ORDER BY r.recognised_at`, ...w.p)
    .map((r) => ({ ...r, amount_inr: inr(r.amount_paise), tax_inr: inr(r.tax_paise) }));
  return csv(rows, ['id', 'recognised_at', 'category', 'entry_type', 'amount_inr', 'tax_inr', 'account', 'account_type', 'region', 'plan', 'source_type', 'source_id', 'invoice_number', 'provider_payment_id', 'order_number', 'notes']);
}

function exportFinancialReport(q) {
  const r = revenue(q);
  const lines = [
    ['AgriConnect financial report'], ['Period', r.period.from, r.period.to], [],
    ['Category', 'Gross (INR)', 'Reversals (INR)', 'Adjustments (INR)', 'Net (INR)', 'Tax collected (INR)'],
    ...r.totals.by_category.map((c) => [c.category, inr(c.gross), inr(c.reversals), inr(c.adjustments), inr(c.net), inr(c.tax)]),
    ['TOTAL', '', '', '', inr(r.totals.net_paise)], [],
    ['MRR (INR)', inr(r.recurring.mrr_paise)], ['ARR (INR)', inr(r.recurring.arr_paise)],
    ['Refunds processed', r.refunds.count, inr(r.refunds.amount_paise)], ['Failed payment attempts', r.failed_payments.count, inr(r.failed_payments.amount_paise)],
    ['Growth vs previous period (%)', r.totals.growth_rate ?? 'n/a'],
  ];
  return lines.map((l) => l.join(',')).join('\n');
}

function exportPayments(q) {
  const { from, to } = range(q);
  const rows = db.all('SELECT p.id, p.created_at, p.captured_at, a.name account, i.invoice_number, i.invoice_type, p.provider, p.provider_order_id, p.provider_payment_id, p.amount_paise, p.amount_refunded_paise, p.status, p.method, p.verified_via FROM payments p JOIN accounts a ON a.id = p.account_id JOIN invoices i ON i.id = p.invoice_id WHERE p.created_at >= ? AND p.created_at < ? ORDER BY p.id', from, to)
    .map((r) => ({ ...r, amount_inr: inr(r.amount_paise), refunded_inr: inr(r.amount_refunded_paise) }));
  return csv(rows, ['id', 'created_at', 'captured_at', 'account', 'invoice_number', 'invoice_type', 'provider', 'provider_order_id', 'provider_payment_id', 'amount_inr', 'refunded_inr', 'status', 'method', 'verified_via']);
}

function exportInvoices(q) {
  const { from, to } = range(q);
  const rows = db.all('SELECT i.invoice_number, i.issued_at, i.paid_at, a.name account, a.gstin, i.invoice_type, i.status, i.subtotal_paise, i.discount_paise, i.credit_applied_paise, i.tax_paise, i.total_paise, i.amount_paid_paise, i.amount_refunded_paise FROM invoices i JOIN accounts a ON a.id = i.account_id WHERE i.issued_at >= ? AND i.issued_at < ? ORDER BY i.id', from, to)
    .map((r) => ({ ...r, subtotal: inr(r.subtotal_paise), discount: inr(r.discount_paise), credit: inr(r.credit_applied_paise), tax: inr(r.tax_paise), total: inr(r.total_paise), paid: inr(r.amount_paid_paise), refunded: inr(r.amount_refunded_paise) }));
  return csv(rows, ['invoice_number', 'issued_at', 'paid_at', 'account', 'gstin', 'invoice_type', 'status', 'subtotal', 'discount', 'credit', 'tax', 'total', 'paid', 'refunded']);
}

module.exports = { overview, revenue, subscriptionAnalytics, approachingLimits, likelyToUpgrade, failedPaymentAccounts, mrr, forecast, exportRevenue, exportFinancialReport, exportPayments, exportInvoices, csv, CATEGORIES };
