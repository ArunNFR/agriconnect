'use strict';
/**
 * Marketplace core (inventory, discovery, enquiries, orders) with subscription entitlements
 * enforced server-side on every gated action.
 */
const db = require('../db');
const clock = require('../lib/clock');
const events = require('../lib/events');
const { notify } = require('../lib/notify');
const ent = require('./entitlements');
const commissions = require('./commissions');
const logistics = require('./logistics');
const promotions = require('./promotions');
const { bad, notFound, forbidden, conflict, randomCode, rupees } = require('../lib/util');

const PRIORITY = { standard: 0, enhanced: 1, priority: 2, top: 3 };

// ------------------------------------------------------------------ farms
function createFarm(accountId, body) {
  if (!body.name) throw bad('Farm name is required');
  ent.assertLimit(accountId, 'max_farms', 1, 'create_farm');
  const id = db.insert('farms', { account_id: accountId, name: body.name, farm_type: body.farm_type, region: body.region, address: body.address, created_at: clock.iso() });
  return db.one('SELECT * FROM farms WHERE id = ?', id);
}
const farms = (accountId) => db.all('SELECT * FROM farms WHERE account_id = ? ORDER BY id', accountId);

// ------------------------------------------------------------------ listings
function validateListing(accountId, b) {
  if (!b.product_name) throw bad('Product name is required');
  if (!(Number(b.quantity) > 0)) throw bad('Quantity must be positive');
  if (!(Number(b.price_per_unit_paise) > 0)) throw bad('Price must be positive');
  if (b.farm_id && !db.one('SELECT 1 FROM farms WHERE id = ? AND account_id = ?', b.farm_id, accountId)) throw bad('Farm not found');
  if (b.availability === 'upcoming') {
    ent.assertFeature(accountId, 'upcoming_harvest_listings', 'upcoming_listing');
    if (!b.harvest_date) throw bad('Upcoming harvest listings need a harvest date');
  }
}

function createListing(accountId, body) {
  validateListing(accountId, body);
  const status = body.status === 'inactive' ? 'inactive' : 'active';
  if (status === 'active') ent.assertLimit(accountId, 'max_active_listings', 1, 'create_listing');
  const acct = db.one('SELECT region FROM accounts WHERE id = ?', accountId);
  const farm = body.farm_id ? db.one('SELECT region FROM farms WHERE id = ?', body.farm_id) : null;
  const now = clock.iso();
  const id = db.insert('listings', {
    account_id: accountId, farm_id: body.farm_id || null, category_id: body.category_id || null, product_name: body.product_name, description: body.description,
    quantity: Number(body.quantity), unit: body.unit || 'kg', price_per_unit_paise: Number(body.price_per_unit_paise), min_order_qty: Number(body.min_order_qty || 1),
    region: body.region || farm?.region || acct.region, availability: body.availability || 'available', harvest_date: body.harvest_date || null, status, created_at: now, updated_at: now,
  });
  events.emit('listing.created', { accountId, listingId: id });
  return getListing(id);
}

/** Bulk inventory publishing (Pro): all-or-nothing against the active listing limit. */
function bulkCreate(accountId, items) {
  if (!Array.isArray(items) || !items.length) throw bad('items must be a non-empty array');
  ent.assertFeature(accountId, 'bulk_inventory_publishing', 'bulk_publish');
  const active = items.filter((i) => i.status !== 'inactive').length;
  ent.assertLimit(accountId, 'max_active_listings', active, 'bulk_publish');
  return db.tx(() => items.map((i) => { validateListing(accountId, i); return createListingUnchecked(accountId, i); }));
}
function createListingUnchecked(accountId, body) {
  const now = clock.iso();
  const acct = db.one('SELECT region FROM accounts WHERE id = ?', accountId);
  const id = db.insert('listings', { account_id: accountId, farm_id: body.farm_id || null, category_id: body.category_id || null, product_name: body.product_name, description: body.description, quantity: Number(body.quantity), unit: body.unit || 'kg', price_per_unit_paise: Number(body.price_per_unit_paise), min_order_qty: Number(body.min_order_qty || 1), region: body.region || acct.region, availability: body.availability || 'available', harvest_date: body.harvest_date || null, status: body.status === 'inactive' ? 'inactive' : 'active', created_at: now, updated_at: now });
  return getListing(id);
}

/** Editing existing listings is always allowed; only (re)activation consumes the limit. */
function updateListing(accountId, id, body) {
  const l = db.one('SELECT * FROM listings WHERE id = ?', id);
  if (!l || l.account_id !== accountId) throw notFound('Listing');
  if (l.status === 'archived') throw conflict('Archived listings cannot be edited');
  const patch = {};
  for (const f of ['product_name', 'description', 'quantity', 'unit', 'price_per_unit_paise', 'min_order_qty', 'region', 'category_id', 'farm_id', 'harvest_date', 'availability']) if (body[f] !== undefined) patch[f] = body[f];
  if (patch.availability === 'upcoming' && l.availability !== 'upcoming') ent.assertFeature(accountId, 'upcoming_harvest_listings', 'upcoming_listing');
  if (body.status && body.status !== l.status) {
    if (!['active', 'inactive', 'sold_out', 'archived'].includes(body.status)) throw bad('Invalid status');
    if (body.status === 'active') ent.assertLimit(accountId, 'max_active_listings', 1, 'activate_listing');
    patch.status = body.status;
    patch.deactivated_reason = body.status === 'active' ? null : 'owner';
  }
  patch.updated_at = clock.iso();
  db.update('listings', id, patch);
  return getListing(id);
}

function getListing(id) {
  const l = db.one('SELECT l.*, c.name category_name, a.name seller_name, a.verified seller_verified, a.premium_badge FROM listings l LEFT JOIN categories c ON c.id = l.category_id JOIN accounts a ON a.id = l.account_id WHERE l.id = ?', id);
  if (!l) throw notFound('Listing');
  return l;
}

function myListings(accountId) {
  return db.all(`SELECT l.*, c.name category_name,
    (SELECT pp.id FROM promotion_purchases pp WHERE pp.listing_id = l.id AND pp.status = 'active' LIMIT 1) active_promotion_id
    FROM listings l LEFT JOIN categories c ON c.id = l.category_id WHERE l.account_id = ? AND l.status != 'archived' ORDER BY l.status, l.id DESC`, accountId);
}

/** Marketplace discovery. Promoted listings are ranked first and labelled; then seller plan priority. */
function search(viewerAccountId, { q, category_id, region, max_price_paise, availability, homepage, limit = 50 }) {
  const where = ["l.status = 'active'", "a.status = 'active'"];
  const params = [];
  if (q) { where.push('(l.product_name LIKE ? OR l.description LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  if (category_id) { where.push('l.category_id = ?'); params.push(Number(category_id)); }
  if (region) { where.push('l.region = ?'); params.push(region); }
  if (max_price_paise) { where.push('l.price_per_unit_paise <= ?'); params.push(Number(max_price_paise)); }
  if (availability) { where.push('l.availability = ?'); params.push(availability); }
  const rows = db.all(`SELECT l.*, c.name category_name, a.name seller_name, a.verified seller_verified, a.premium_badge FROM listings l JOIN accounts a ON a.id = l.account_id LEFT JOIN categories c ON c.id = l.category_id WHERE ${where.join(' AND ')} ORDER BY l.updated_at DESC LIMIT 500`, ...params);
  const promoted = promotions.activeForQuery({ categoryId: category_id, region, homepage: !!homepage });
  const prioCache = {};
  const prio = (acc) => (prioCache[acc] ??= PRIORITY[ent.value(acc, 'marketplace_priority')] || 0);
  const ranked = rows.map((r) => ({ ...r, promotion: promoted[r.id] || null, seller_priority: prio(r.account_id) }))
    .sort((a, b) => (b.promotion?.rank || 0) - (a.promotion?.rank || 0) || b.seller_priority - a.seller_priority || (b.updated_at > a.updated_at ? 1 : -1))
    .slice(0, Math.min(Number(limit) || 50, 100));
  for (const r of ranked) if (r.promotion) promotions.track(r.promotion.purchase_id, 'impressions');
  db.insert('search_logs', { account_id: viewerAccountId, query: q || null, category_id: category_id || null, region: region || null, results: ranked.length, created_at: clock.iso() });
  return ranked.map((r) => ({ ...r, sponsored: !!r.promotion, promotion_label: r.promotion?.label || null, promotion: undefined, promotion_purchase_id: r.promotion?.purchase_id || null }));
}

function viewListing(id) {
  const l = getListing(id);
  db.run('UPDATE listings SET views = views + 1 WHERE id = ?', id);
  const p = promotions.activeForListing(id);
  if (p) promotions.track(p.id, 'views');
  return l;
}

function enquire(buyerAccountId, listingId, message) {
  const l = getListing(listingId);
  if (!message) throw bad('Message is required');
  const id = db.insert('enquiries', { listing_id: l.id, buyer_account_id: buyerAccountId, seller_account_id: l.account_id, message, created_at: clock.iso() });
  const p = promotions.activeForListing(l.id);
  if (p) promotions.track(p.id, 'enquiries');
  const buyer = db.one('SELECT name FROM accounts WHERE id = ?', buyerAccountId);
  notify(l.account_id, 'buyer_enquiry', `New enquiry for ${l.product_name}`, `${buyer.name}: ${message}`, { listing_id: l.id, enquiry_id: id });
  return db.one('SELECT * FROM enquiries WHERE id = ?', id);
}

// ------------------------------------------------------------------ orders
function priceOrder(buyerAccountId, { listing_id, quantity, delivery_mode = 'buyer_pickup', order_type = 'standard' }) {
  const l = getListing(listing_id);
  if (l.status !== 'active') throw conflict('This listing is not available');
  if (l.account_id === buyerAccountId) throw bad('You cannot order your own listing');
  const qty = Number(quantity);
  if (!(qty > 0)) throw bad('Quantity must be positive');
  if (qty < l.min_order_qty) throw bad(`Minimum order is ${l.min_order_qty} ${l.unit}`);
  if (qty > l.quantity) throw conflict(`Only ${l.quantity} ${l.unit} available`);
  const subtotal = Math.round(qty * l.price_per_unit_paise);
  const comm = commissions.quote({ sellerAccountId: l.account_id, buyerAccountId, categoryId: l.category_id, region: l.region, orderType: order_type, orderValue: subtotal });
  const lg = logistics.quote(delivery_mode);
  const buyerFee = comm.buyer_portion_paise + (lg.payer === 'buyer' ? lg.upfront_fee_paise : 0);
  const sellerFee = comm.seller_portion_paise + (lg.payer === 'seller' ? lg.upfront_fee_paise : 0);
  const payout = subtotal - (['deducted_from_payout', 'included_in_price'].includes(comm.charged_to) ? comm.seller_portion_paise : 0);
  return {
    listing: { id: l.id, product_name: l.product_name, seller_account_id: l.account_id, seller_name: l.seller_name, unit: l.unit, unit_price_paise: l.price_per_unit_paise, category_id: l.category_id, region: l.region },
    quantity: qty, subtotal_paise: subtotal, commission: comm, logistics: lg, buyer_fee_paise: buyerFee, seller_fee_paise: sellerFee,
    total_buyer_paise: subtotal + buyerFee, seller_payout_paise: payout,
    charges_note: [comm.enabled && comm.commission_paise ? comm.description : null, lg.description].filter(Boolean).join(' · '),
  };
}

function createOrder(buyerAccountId, body, { basketRef = null, procurementServiceId = null } = {}) {
  const q = priceOrder(buyerAccountId, body);
  const now = clock.iso();
  const promo = promotions.activeForListing(q.listing.id);
  const id = db.insert('orders', {
    order_number: `ORD-${clock.now().getUTCFullYear()}-${randomCode(7)}`, buyer_account_id: buyerAccountId, seller_account_id: q.listing.seller_account_id, listing_id: q.listing.id,
    category_id: q.listing.category_id, region: q.listing.region, quantity: q.quantity, unit: q.listing.unit, unit_price_paise: q.listing.unit_price_paise, subtotal_paise: q.subtotal_paise,
    buyer_fee_paise: q.buyer_fee_paise, seller_fee_paise: q.seller_fee_paise, total_buyer_paise: q.total_buyer_paise, seller_payout_paise: q.seller_payout_paise,
    order_type: body.order_type || 'standard', basket_ref: basketRef, procurement_service_id: procurementServiceId, delivery_mode: body.delivery_mode || 'buyer_pickup',
    delivery_address: body.delivery_address || null, promotion_purchase_id: promo?.id || null, status: 'placed', placed_at: now, updated_at: now,
  });
  const order = db.one('SELECT * FROM orders WHERE id = ?', id);
  db.run("UPDATE listings SET quantity = quantity - ?, status = CASE WHEN quantity - ? <= 0 THEN 'sold_out' ELSE status END, updated_at = ? WHERE id = ?", q.quantity, q.quantity, now, q.listing.id);
  commissions.recordForOrder(order, q.commission);
  const seller = db.one('SELECT name, region FROM accounts WHERE id = ?', order.seller_account_id);
  logistics.createForOrder(order, { pickup: seller.region, delivery: body.delivery_address || null });
  if (promo) promotions.track(promo.id, 'orders', { revenue: q.subtotal_paise });
  const buyer = db.one('SELECT name FROM accounts WHERE id = ?', buyerAccountId);
  notify(order.seller_account_id, 'new_order', `New order ${order.order_number}`, `${buyer.name} ordered ${q.quantity} ${q.listing.unit} of ${q.listing.product_name} (${rupees(q.subtotal_paise)}).`, { order_id: id });
  return order;
}

/** Single-supplier order (all buyer plans). Monthly order cap and bulk orders are entitlement-gated. */
function placeOrder(buyerAccountId, body) {
  if (body.order_type === 'bulk') ent.assertFeature(buyerAccountId, 'bulk_sourcing', 'bulk_order');
  if (body.order_type === 'recurring') ent.assertFeature(buyerAccountId, 'recurring_procurement', 'recurring_order');
  ent.assertLimit(buyerAccountId, 'max_monthly_orders', 1, 'place_order');
  return db.tx(() => createOrder(buyerAccountId, body));
}

/** Multi-farmer sourcing basket — requires multi_farmer_procurement when items span several sellers. */
function placeBasket(buyerAccountId, { items, delivery_mode, delivery_address }) {
  if (!Array.isArray(items) || !items.length) throw bad('Basket is empty');
  const sellers = new Set(items.map((i) => getListing(i.listing_id).account_id));
  if (sellers.size > 1) ent.assertFeature(buyerAccountId, 'multi_farmer_procurement', 'multi_farmer_basket');
  ent.assertLimit(buyerAccountId, 'max_monthly_orders', items.length, 'basket');
  const ref = `BSK-${randomCode(8)}`;
  return db.tx(() => ({ basket_ref: ref, orders: items.map((i) => createOrder(buyerAccountId, { ...i, delivery_mode, delivery_address, order_type: sellers.size > 1 ? 'multi_farmer' : 'standard' }, { basketRef: ref })) }));
}

function quoteBasket(buyerAccountId, { items, delivery_mode }) {
  const lines = items.map((i) => priceOrder(buyerAccountId, { ...i, delivery_mode, order_type: 'multi_farmer' }));
  const sellers = new Set(lines.map((l) => l.listing.seller_account_id));
  let gated = null;
  if (sellers.size > 1 && ent.value(buyerAccountId, 'multi_farmer_procurement') !== true) gated = { entitlement: 'multi_farmer_procurement', upgrade_options: ent.upgradeOptions(buyerAccountId, 'multi_farmer_procurement', true) };
  return { lines, suppliers: sellers.size, total_buyer_paise: lines.reduce((s, l) => s + l.total_buyer_paise, 0), upgrade_required: gated };
}

const ORDER_FLOW = {
  seller: { placed: ['accepted', 'rejected'], accepted: ['dispatched', 'cancelled'], dispatched: ['delivered'], delivered: ['completed'] },
  buyer: { placed: ['cancelled'], dispatched: ['delivered'], delivered: ['completed'] },
  admin: { placed: ['accepted', 'cancelled'], accepted: ['dispatched', 'cancelled'], dispatched: ['delivered'], delivered: ['completed'], completed: ['cancelled'] },
};

/** Orders keep processing regardless of either party's subscription status. */
function updateOrderStatus(actor, accountId, orderId, status) {
  return db.tx(() => {
    const o = db.one('SELECT * FROM orders WHERE id = ?', orderId);
    if (!o) throw notFound('Order');
    const side = actor.role === 'admin' || actor.role === 'owner' ? 'admin' : o.seller_account_id === accountId ? 'seller' : o.buyer_account_id === accountId ? 'buyer' : null;
    if (!side) throw forbidden();
    if (!(ORDER_FLOW[side][o.status] || []).includes(status)) throw conflict(`Cannot change order from ${o.status} to ${status}`);
    const now = clock.iso();
    db.update('orders', o.id, { status, updated_at: now, ...(status === 'completed' ? { completed_at: now } : {}), ...(['cancelled', 'rejected'].includes(status) ? { cancelled_at: now } : {}) });
    const order = db.one('SELECT * FROM orders WHERE id = ?', o.id);
    if (status === 'completed') { commissions.onOrderCompleted(order); events.emit('order.completed', order); }
    if (['cancelled', 'rejected'].includes(status)) {
      commissions.onOrderCancelled(order);
      if (o.status !== 'completed') db.run("UPDATE listings SET quantity = quantity + ?, status = CASE WHEN status = 'sold_out' THEN 'inactive' ELSE status END, updated_at = ? WHERE id = ?", o.quantity, now, o.listing_id);
      db.run("UPDATE logistics_transactions SET status = 'cancelled', updated_at = ? WHERE order_id = ? AND status IN ('requested','scheduled')", now, o.id);
    }
    if (status === 'delivered') db.run("UPDATE logistics_transactions SET status = 'delivered', delivery_time = ?, updated_at = ? WHERE order_id = ? AND mode IN ('farmer_delivery','buyer_pickup') AND status != 'delivered'", now, now, o.id);
    const other = side === 'seller' ? o.buyer_account_id : o.seller_account_id;
    notify(other, 'order_update', `Order ${o.order_number} ${status}`, `Order ${o.order_number} is now ${status}.`, { order_id: o.id });
    if (o.procurement_service_id) events.emit('procurement.order_updated', order);
    return order;
  });
}

function orders(accountId, role) {
  const col = role === 'farmer' ? 'seller_account_id' : 'buyer_account_id';
  return db.all(`SELECT o.*, l.product_name, b.name buyer_name, s.name seller_name, tc.commission_paise, tc.status commission_status, lt.status delivery_status
    FROM orders o JOIN listings l ON l.id = o.listing_id JOIN accounts b ON b.id = o.buyer_account_id JOIN accounts s ON s.id = o.seller_account_id
    LEFT JOIN transaction_commissions tc ON tc.order_id = o.id LEFT JOIN logistics_transactions lt ON lt.order_id = o.id WHERE o.${col} = ? ORDER BY o.id DESC LIMIT 200`, accountId);
}

// ------------------------------------------------------------------ buyer tools
function saveSupplier(buyerAccountId, supplierAccountId) {
  if (!db.one("SELECT 1 FROM accounts WHERE id = ? AND type = 'farmer'", supplierAccountId)) throw notFound('Supplier');
  if (db.one('SELECT 1 FROM saved_suppliers WHERE buyer_account_id = ? AND supplier_account_id = ?', buyerAccountId, supplierAccountId)) return savedSuppliers(buyerAccountId);
  ent.assertLimit(buyerAccountId, 'max_saved_suppliers', 1, 'save_supplier');
  db.insert('saved_suppliers', { buyer_account_id: buyerAccountId, supplier_account_id: supplierAccountId, created_at: clock.iso() });
  return savedSuppliers(buyerAccountId);
}
function removeSupplier(buyerAccountId, supplierAccountId) {
  db.run('DELETE FROM saved_suppliers WHERE buyer_account_id = ? AND supplier_account_id = ?', buyerAccountId, supplierAccountId);
  return savedSuppliers(buyerAccountId);
}
const savedSuppliers = (buyerAccountId) => db.all('SELECT a.id, a.name, a.region, a.verified, a.premium_badge, s.created_at FROM saved_suppliers s JOIN accounts a ON a.id = s.supplier_account_id WHERE s.buyer_account_id = ? ORDER BY s.created_at DESC', buyerAccountId);

function saveSearch(accountId, { name, query }) {
  ent.assertFeature(accountId, 'saved_searches', 'save_search');
  if (!name) throw bad('Name is required');
  const id = db.insert('saved_searches', { account_id: accountId, name, query_json: query || {}, created_at: clock.iso() });
  return db.one('SELECT * FROM saved_searches WHERE id = ?', id);
}
const savedSearches = (accountId) => db.all('SELECT * FROM saved_searches WHERE account_id = ? ORDER BY id DESC', accountId);

/** Supplier comparison (Business+): fulfilment performance computed from platform orders. */
function compareSuppliers(buyerAccountId, supplierIds) {
  ent.assertFeature(buyerAccountId, 'supplier_comparison', 'compare_suppliers');
  return supplierIds.map(Number).map((id) => {
    const a = db.one("SELECT id, name, region, verified, premium_badge FROM accounts WHERE id = ? AND type = 'farmer'", id);
    if (!a) return null;
    const s = db.one(`SELECT COUNT(*) orders, SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) completed, SUM(CASE WHEN status IN ('cancelled','rejected') THEN 1 ELSE 0 END) failed,
      AVG(CASE WHEN completed_at IS NOT NULL THEN (julianday(completed_at) - julianday(placed_at)) END) avg_days FROM orders WHERE seller_account_id = ?`, id);
    const l = db.one("SELECT COUNT(*) active_listings, MIN(price_per_unit_paise) min_price, AVG(price_per_unit_paise) avg_price FROM listings WHERE account_id = ? AND status = 'active'", id);
    return { ...a, ...l, avg_price: Math.round(l.avg_price || 0), orders: s.orders, fulfilment_rate: s.orders ? Math.round((s.completed / s.orders) * 100) : null, avg_fulfilment_days: s.avg_days ? Math.round(s.avg_days * 10) / 10 : null };
  }).filter(Boolean);
}

// ------------------------------------------------------------------ team accounts
function addTeamMember(accountId, actor, { email, name, account_role = 'staff', password }, hashPassword) {
  if (!email || !name || !password) throw bad('email, name and password are required');
  ent.assertLimit(accountId, 'max_users', 1, 'add_user');
  if (db.one('SELECT 1 FROM users WHERE email = ?', email.toLowerCase())) throw conflict('Email already registered');
  const owner = db.one('SELECT role FROM users WHERE id = ?', actor.userId);
  const id = db.insert('users', { account_id: accountId, email: email.toLowerCase(), name, password_hash: hashPassword(password), role: owner.role, account_role: ['manager', 'staff'].includes(account_role) ? account_role : 'staff', created_at: clock.iso() });
  return db.one('SELECT id, email, name, role, account_role, status FROM users WHERE id = ?', id);
}
const team = (accountId) => db.all('SELECT id, email, name, role, account_role, status, created_at FROM users WHERE account_id = ? ORDER BY id', accountId);

module.exports = { __createOrder: createOrder, createFarm, farms, createListing, bulkCreate, updateListing, getListing, myListings, search, viewListing, enquire, priceOrder, placeOrder, placeBasket, quoteBasket, updateOrderStatus, orders, saveSupplier, removeSupplier, savedSuppliers, saveSearch, savedSearches, compareSuppliers, addTeamMember, team };
