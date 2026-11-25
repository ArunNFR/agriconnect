'use strict';
/**
 * Market intelligence (premium analytics). Data is aggregated; any bucket built from fewer than
 * `min_group_size` distinct counterparties is suppressed so individual businesses cannot be identified.
 * Access depth follows the analytics_level entitlement: basic < standard < advanced < enterprise.
 */
const db = require('../db');
const clock = require('../lib/clock');
const settings = require('../lib/settings');
const ent = require('./entitlements');
const { addDays } = require('../lib/util');

const k = () => settings.get('intelligence').min_group_size;
const since = (days) => addDays(clock.iso(), -days);

function priceTrends(days = 90) {
  return db.all(`SELECT c.name category, strftime('%Y-W%W', o.placed_at) week, ROUND(AVG(o.unit_price_paise)) avg_price_paise, COUNT(DISTINCT o.seller_account_id) sellers, COUNT(*) orders
    FROM orders o JOIN categories c ON c.id = o.category_id WHERE o.placed_at >= ? AND o.status NOT IN ('cancelled','rejected') GROUP BY c.id, week HAVING sellers >= ? ORDER BY c.name, week`, since(days), k());
}

function demandByCategory(days = 30) {
  const searches = db.all('SELECT c.name category, COUNT(*) searches, COUNT(DISTINCT s.account_id) searchers FROM search_logs s JOIN categories c ON c.id = s.category_id WHERE s.created_at >= ? GROUP BY c.id', since(days));
  const orders = db.all("SELECT c.name category, SUM(o.quantity) qty, COUNT(DISTINCT o.buyer_account_id) buyers FROM orders o JOIN categories c ON c.id = o.category_id WHERE o.placed_at >= ? AND o.status NOT IN ('cancelled','rejected') GROUP BY c.id", since(days));
  const reqs = db.all("SELECT c.name category, SUM(ps.quantity) qty, COUNT(DISTINCT ps.buyer_account_id) buyers FROM procurement_services ps JOIN categories c ON c.id = ps.category_id WHERE ps.created_at >= ? AND ps.status NOT IN ('cancelled','rejected') GROUP BY c.id", since(days));
  const supply = db.all("SELECT c.name category, SUM(l.quantity) qty, COUNT(DISTINCT l.account_id) sellers FROM listings l JOIN categories c ON c.id = l.category_id WHERE l.status = 'active' GROUP BY c.id");
  const cats = {};
  const add = (rows, f) => rows.forEach((r) => Object.assign((cats[r.category] ||= { category: r.category }), f(r)));
  add(searches, (r) => ({ searches: r.searches, searchers: r.searchers }));
  add(orders, (r) => ({ ordered_qty: r.qty, buyers: r.buyers }));
  add(reqs, (r) => ({ requested_qty: r.qty, requesting_buyers: r.buyers }));
  add(supply, (r) => ({ available_qty: r.qty, sellers: r.sellers }));
  return Object.values(cats).map((c) => {
    const demand = (c.ordered_qty || 0) + (c.requested_qty || 0);
    const ratio = c.available_qty ? Math.round((demand / c.available_qty) * 100) / 100 : demand ? null : 0;
    return { ...c, demand_qty: demand, demand_supply_ratio: ratio, signal: ratio === null || ratio > 1 ? 'shortage' : ratio > 0.6 ? 'high_demand' : 'balanced' };
  }).filter((c) => (c.buyers || 0) + (c.requesting_buyers || 0) + (c.searchers || 0) >= k() || (c.sellers || 0) >= k());
}

function regionalActivity(days = 30) {
  return db.all(`SELECT a.region, COUNT(DISTINCT o.buyer_account_id) active_buyers, COUNT(*) orders, SUM(o.subtotal_paise) value_paise FROM orders o JOIN accounts a ON a.id = o.buyer_account_id
    WHERE o.placed_at >= ? GROUP BY a.region HAVING active_buyers >= ? ORDER BY orders DESC`, since(days), k());
}

function supplyAvailability() {
  return db.all(`SELECT c.name category, l.region, SUM(l.quantity) qty, COUNT(DISTINCT l.account_id) suppliers, MIN(l.price_per_unit_paise) min_price_paise, ROUND(AVG(l.price_per_unit_paise)) avg_price_paise, MAX(l.price_per_unit_paise) max_price_paise
    FROM listings l JOIN categories c ON c.id = l.category_id WHERE l.status = 'active' GROUP BY c.id, l.region HAVING suppliers >= ? ORDER BY c.name, l.region`, k());
}

function upcomingHarvests() {
  return db.all(`SELECT c.name category, strftime('%Y-%m', l.harvest_date) month, SUM(l.quantity) qty, COUNT(DISTINCT l.account_id) suppliers FROM listings l JOIN categories c ON c.id = l.category_id
    WHERE l.availability = 'upcoming' AND l.status = 'active' AND l.harvest_date >= ? GROUP BY c.id, month HAVING suppliers >= ? ORDER BY month`, clock.iso().slice(0, 10), k());
}

function forFarmer(accountId) {
  const level = ent.value(accountId, 'analytics_level');
  const own = db.one("SELECT COUNT(*) orders, COALESCE(SUM(subtotal_paise),0) revenue_paise, COUNT(DISTINCT buyer_account_id) buyers FROM orders WHERE seller_account_id = ? AND status = 'completed'", accountId);
  const top = db.all("SELECT l.product_name, SUM(o.quantity) qty, SUM(o.subtotal_paise) revenue_paise, l.views FROM orders o JOIN listings l ON l.id = o.listing_id WHERE o.seller_account_id = ? AND o.status NOT IN ('cancelled','rejected') GROUP BY l.id ORDER BY revenue_paise DESC LIMIT 10", accountId);
  const out = { level, sales_summary: own, product_performance: top, locked: [] };
  if (ent.levelAtLeast(accountId, 'analytics_level', 'standard')) { out.demand_by_category = demandByCategory(); out.price_trends = priceTrends(); out.repeat_buyers = db.all("SELECT b.name buyer, COUNT(*) orders FROM orders o JOIN accounts b ON b.id = o.buyer_account_id WHERE o.seller_account_id = ? AND o.status = 'completed' GROUP BY b.id HAVING orders > 1 ORDER BY orders DESC LIMIT 10", accountId); } else out.locked.push('demand_by_category', 'price_trends', 'buyer_insights');
  if (ent.levelAtLeast(accountId, 'analytics_level', 'advanced')) { out.regional_buyer_activity = regionalActivity(); out.high_demand_products = (out.demand_by_category || demandByCategory()).filter((c) => c.signal !== 'balanced'); out.harvest_outlook = upcomingHarvests(); } else out.locked.push('regional_buyer_activity', 'high_demand_products', 'harvest_outlook');
  if (ent.value(accountId, 'buyer_demand_access') === true) out.buyer_sourcing_requirements = db.all("SELECT ps.product_name, ps.quantity, ps.unit, ps.required_by, ps.delivery_region FROM procurement_services ps WHERE ps.status = 'open' ORDER BY ps.id DESC LIMIT 20");
  else out.locked.push('buyer_sourcing_requirements');
  return out;
}

function forBuyer(accountId) {
  const level = ent.value(accountId, 'analytics_level');
  const history = db.all(`SELECT l.product_name, c.name category, strftime('%Y-%m', o.placed_at) month, SUM(o.quantity) qty, ROUND(AVG(o.unit_price_paise)) avg_price_paise, SUM(o.subtotal_paise) spend_paise
    FROM orders o JOIN listings l ON l.id = o.listing_id LEFT JOIN categories c ON c.id = o.category_id WHERE o.buyer_account_id = ? AND o.status NOT IN ('cancelled','rejected') GROUP BY l.product_name, month ORDER BY month DESC LIMIT 60`, accountId);
  const out = { level, procurement_history: history, spend_paise: history.reduce((s, h) => s + h.spend_paise, 0), locked: [] };
  if (ent.levelAtLeast(accountId, 'analytics_level', 'standard')) { out.supply_availability = supplyAvailability(); out.price_trends = priceTrends(); } else out.locked.push('supply_availability', 'price_comparisons', 'price_trends');
  if (ent.levelAtLeast(accountId, 'analytics_level', 'advanced')) { out.sourcing_trends = demandByCategory(); out.supplier_performance = db.all(`SELECT s.name supplier, COUNT(*) orders, SUM(CASE WHEN o.status='completed' THEN 1 ELSE 0 END) completed FROM orders o JOIN accounts s ON s.id = o.seller_account_id WHERE o.buyer_account_id = ? GROUP BY s.id ORDER BY orders DESC LIMIT 20`, accountId); out.harvest_outlook = upcomingHarvests(); } else out.locked.push('sourcing_trends', 'supplier_performance', 'harvest_outlook');
  if (ent.value(accountId, 'supply_shortage_alerts') === true) out.shortage_alerts = demandByCategory().filter((c) => c.signal === 'shortage');
  else out.locked.push('shortage_alerts');
  return out;
}

function forPlatform() {
  return { demand_by_category: demandByCategory(90), price_trends: priceTrends(180), regional_activity: regionalActivity(90), supply_availability: supplyAvailability(), harvest_outlook: upcomingHarvests(), min_group_size: k() };
}

module.exports = { forFarmer, forBuyer, forPlatform, demandByCategory, priceTrends };
