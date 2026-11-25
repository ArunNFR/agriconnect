'use strict';
/**
 * Buyer sourcing requirements.
 *  self     – posted to the buyer demand board; matching farmers are notified.
 *  assisted – AgriConnect's procurement team identifies, confirms and aggregates supply from multiple
 *             farmers, the buyer approves a proposal, orders are created, and a service fee
 *             (configurable model) is invoiced on completion.
 */
const db = require('../db');
const clock = require('../lib/clock');
const audit = require('../lib/audit');
const settings = require('../lib/settings');
const events = require('../lib/events');
const { notify, notifyPlatform } = require('../lib/notify');
const ent = require('./entitlements');
const billing = require('./billing');
const marketplace = require('./marketplace');
const { bad, notFound, conflict, forbidden, pct, randomCode, rupees } = require('../lib/util');

function feeFor(cfg, valuePaise, qty) {
  let fee = 0;
  if (cfg.model === 'fixed') fee = cfg.fixed_paise;
  else if (cfg.model === 'percentage') fee = pct(valuePaise, cfg.rate_bps);
  else if (cfg.model === 'per_kg') fee = Math.round(qty * cfg.per_kg_paise);
  else if (cfg.model === 'percentage_plus_fixed') fee = pct(valuePaise, cfg.rate_bps) + cfg.fixed_paise;
  if (cfg.min_fee_paise) fee = Math.max(fee, cfg.min_fee_paise);
  if (cfg.max_fee_paise) fee = Math.min(fee, cfg.max_fee_paise);
  return fee;
}

function estimate(buyerAccountId, { quantity, target_price_paise }) {
  const cfg = settings.get('procurement_service_fee');
  const waived = ent.value(buyerAccountId, 'assisted_sourcing_included') === true;
  const value = Math.round(Number(quantity || 0) * Number(target_price_paise || 0));
  return { fee_model: cfg, waived, estimated_fee_paise: waived ? 0 : feeFor(cfg, value, Number(quantity || 0)), basis: value ? 'target price × quantity' : 'set a target price for an estimate' };
}

function create(buyerAccountId, actor, body) {
  for (const f of ['product_name', 'quantity', 'sourcing_mode']) if (!body[f]) throw bad(`${f} is required`);
  if (!['self', 'assisted'].includes(body.sourcing_mode)) throw bad('sourcing_mode must be self or assisted');
  if (body.sourcing_mode === 'self') ent.assertFeature(buyerAccountId, 'buyer_demand_access', 'post_demand');
  const cfg = settings.get('procurement_service_fee');
  const now = clock.iso();
  const id = db.insert('procurement_services', {
    reference: `PRQ-${randomCode(6)}`, buyer_account_id: buyerAccountId, product_name: body.product_name, category_id: body.category_id || null, quantity: Number(body.quantity), unit: body.unit || 'kg',
    required_by: body.required_by || null, delivery_location: body.delivery_location || null, delivery_region: body.delivery_region || null, target_price_paise: body.target_price_paise || null, notes: body.notes || null,
    sourcing_mode: body.sourcing_mode, status: body.sourcing_mode === 'self' ? 'open' : 'submitted', fee_config_json: body.sourcing_mode === 'assisted' ? cfg : null,
    fee_waived: body.sourcing_mode === 'assisted' && ent.value(buyerAccountId, 'assisted_sourcing_included') === true ? 1 : 0, created_at: now, updated_at: now,
  });
  const req = get(id);
  if (req.sourcing_mode === 'self') notifyMatchingFarmers(req);
  else notifyPlatform('procurement_request', 'New assisted sourcing request', `${req.buyer_name} needs ${req.quantity} ${req.unit} ${req.product_name}${req.required_by ? ` by ${req.required_by}` : ''} → ${req.delivery_location || ''}`, { service_id: id });
  return req;
}

/** Buyer demand notifications go to farmers whose plan includes buyer demand access. */
function notifyMatchingFarmers(req) {
  const farmers = db.all("SELECT DISTINCT account_id FROM listings WHERE status IN ('active','inactive') AND (category_id = ? OR product_name LIKE ?)", req.category_id, `%${req.product_name}%`);
  for (const f of farmers) {
    if (ent.value(f.account_id, 'buyer_demand_access') !== true) continue;
    notify(f.account_id, 'buyer_demand', `Buyer demand: ${req.product_name}`, `A buyer needs ${req.quantity} ${req.unit}${req.required_by ? ` by ${req.required_by}` : ''}${req.delivery_region ? ` in ${req.delivery_region}` : ''}.`, { service_id: req.id }, { priority: ent.value(f.account_id, 'priority_notifications') ? 'high' : 'normal' });
  }
}

function get(id) {
  const r = db.one('SELECT ps.*, a.name buyer_name FROM procurement_services ps JOIN accounts a ON a.id = ps.buyer_account_id WHERE ps.id = ?', id);
  if (!r) throw notFound('Sourcing requirement');
  r.lines = db.all('SELECT psl.*, a.name supplier_name, l.product_name, l.unit FROM procurement_service_lines psl JOIN accounts a ON a.id = psl.supplier_account_id LEFT JOIN listings l ON l.id = psl.listing_id WHERE psl.service_id = ? ORDER BY psl.id', id);
  r.fee = db.one('SELECT * FROM procurement_service_fees WHERE service_id = ?', id) || null;
  r.confirmed_quantity = r.lines.filter((l) => ['confirmed', 'ordered'].includes(l.status)).reduce((s, l) => s + l.quantity, 0);
  r.proposal_value_paise = r.lines.filter((l) => ['confirmed', 'ordered'].includes(l.status)).reduce((s, l) => s + Math.round(l.quantity * l.unit_price_paise), 0);
  return r;
}

const forBuyer = (accountId) => db.all('SELECT id FROM procurement_services WHERE buyer_account_id = ? ORDER BY id DESC', accountId).map((r) => get(r.id));
const queue = (status) => db.all(`SELECT id FROM procurement_services WHERE sourcing_mode = 'assisted' ${status ? 'AND status = ?' : ''} ORDER BY id DESC`, ...(status ? [status] : [])).map((r) => get(r.id));

/** Demand board for farmers (entitlement-gated). Buyer identity is withheld until they engage. */
function demandBoard(farmerAccountId) {
  ent.assertFeature(farmerAccountId, 'buyer_demand_access', 'demand_board');
  return db.all("SELECT ps.id, ps.reference, ps.product_name, c.name category, ps.quantity, ps.unit, ps.required_by, ps.delivery_region, ps.target_price_paise, ps.created_at, a.business_type buyer_type FROM procurement_services ps JOIN accounts a ON a.id = ps.buyer_account_id LEFT JOIN categories c ON c.id = ps.category_id WHERE ps.status = 'open' ORDER BY ps.id DESC LIMIT 100");
}

// ---- platform procurement team workflow
function transition(actor, id, from, to) {
  const r = db.one('SELECT * FROM procurement_services WHERE id = ?', id);
  if (!r) throw notFound('Sourcing requirement');
  if (!from.includes(r.status)) throw conflict(`Requirement is ${r.status}`);
  db.update('procurement_services', id, { status: to, updated_at: clock.iso(), ...(actor.userId && !r.assigned_to ? { assigned_to: actor.userId } : {}) });
  audit.log(actor, `procurement.${to}`, 'procurement_service', id, { before: { status: r.status }, after: { status: to } });
  return r;
}

function review(actor, id, { accept, notes }) {
  return db.tx(() => {
    const r = transition(actor, id, ['submitted'], accept ? 'under_review' : 'rejected');
    notify(r.buyer_account_id, 'procurement_update', `Sourcing request ${r.reference} ${accept ? 'accepted' : 'declined'}`, accept ? 'Our procurement team is identifying suppliers.' : `We cannot fulfil this request${notes ? `: ${notes}` : ''}.`);
    return get(id);
  });
}

/** System identifies potential farmers from live inventory. */
function suggestSuppliers(id) {
  const r = get(id);
  return db.all(`SELECT l.id listing_id, l.account_id supplier_account_id, a.name supplier_name, a.verified, l.product_name, l.quantity available, l.unit, l.price_per_unit_paise, l.region,
      (CASE WHEN l.region = ? THEN 1 ELSE 0 END) same_region
    FROM listings l JOIN accounts a ON a.id = l.account_id WHERE l.status = 'active' AND (l.category_id = ? OR l.product_name LIKE ?)
    ORDER BY same_region DESC, a.verified DESC, l.price_per_unit_paise ASC LIMIT 50`, r.delivery_region, r.category_id, `%${r.product_name}%`);
}

function addLine(actor, id, { listing_id, quantity }) {
  return db.tx(() => {
    const r = db.one('SELECT * FROM procurement_services WHERE id = ?', id);
    if (!r || !['under_review', 'sourcing', 'proposal_sent'].includes(r.status)) throw conflict('Requirement is not being sourced');
    const l = marketplace.getListing(listing_id);
    if (Number(quantity) > l.quantity) throw bad(`Supplier only has ${l.quantity} ${l.unit}`);
    const now = clock.iso();
    db.insert('procurement_service_lines', { service_id: id, supplier_account_id: l.account_id, listing_id: l.id, quantity: Number(quantity), unit_price_paise: l.price_per_unit_paise, status: 'contacted', created_at: now, updated_at: now });
    if (r.status === 'under_review') db.update('procurement_services', id, { status: 'sourcing', updated_at: now });
    notify(l.account_id, 'procurement_supply_request', 'AgriConnect sourcing request', `Can you supply ${quantity} ${l.unit} of ${l.product_name}${r.required_by ? ` by ${r.required_by}` : ''}? Please confirm availability in your dashboard.`, { service_id: id });
    return get(id);
  });
}

/** Farmer confirms or declines availability. */
function respondLine(farmerAccountId, lineId, confirm) {
  return db.tx(() => {
    const line = db.one('SELECT * FROM procurement_service_lines WHERE id = ?', lineId);
    if (!line || line.supplier_account_id !== farmerAccountId) throw notFound('Supply request');
    if (line.status !== 'contacted' && line.status !== 'proposed') throw conflict(`Already ${line.status}`);
    db.update('procurement_service_lines', lineId, { status: confirm ? 'confirmed' : 'declined', updated_at: clock.iso() });
    return get(line.service_id);
  });
}
const supplierRequests = (farmerAccountId) => db.all("SELECT psl.*, ps.reference, ps.product_name, ps.required_by, ps.delivery_region FROM procurement_service_lines psl JOIN procurement_services ps ON ps.id = psl.service_id WHERE psl.supplier_account_id = ? ORDER BY psl.id DESC", farmerAccountId);

function sendProposal(actor, id, { notes }) {
  return db.tx(() => {
    const r = get(id);
    if (!r.lines.some((l) => l.status === 'confirmed')) throw conflict('At least one supplier must confirm availability before sending a proposal');
    transition(actor, id, ['sourcing', 'proposal_sent'], 'proposal_sent');
    db.update('procurement_services', id, { proposal_notes: notes || null });
    const cfg = JSON.parse(r.fee_config_json);
    const fee = r.fee_waived ? 0 : feeFor(cfg, r.proposal_value_paise, r.confirmed_quantity);
    notify(r.buyer_account_id, 'procurement_proposal', `Sourcing proposal ready — ${r.reference}`, `${r.confirmed_quantity} ${r.unit} from ${r.lines.filter((l) => l.status === 'confirmed').length} supplier(s), produce value ${rupees(r.proposal_value_paise)}. Estimated service fee ${rupees(fee)}${r.fee_waived ? ' (included in your plan)' : ''}.`, { service_id: id });
    return get(id);
  });
}

/** Buyer approves → orders are created for each confirmed supplier. */
function approve(buyerAccountId, id, { delivery_mode = 'platform_arranged' } = {}) {
  return db.tx(() => {
    const r = get(id);
    if (r.buyer_account_id !== buyerAccountId) throw forbidden();
    if (r.status !== 'proposal_sent') throw conflict('No proposal awaiting approval');
    for (const line of r.lines.filter((l) => l.status === 'confirmed')) {
      const order = marketplace.__createOrder(buyerAccountId, { listing_id: line.listing_id, quantity: line.quantity, delivery_mode, delivery_address: r.delivery_location, order_type: 'procurement' }, { procurementServiceId: id });
      db.update('procurement_service_lines', line.id, { status: 'ordered', order_id: order.id, updated_at: clock.iso() });
    }
    db.update('procurement_services', id, { status: 'fulfilling', updated_at: clock.iso() });
    audit.log({ userId: null, role: 'user' }, 'procurement.approved', 'procurement_service', id, {});
    return get(id);
  });
}

function decline(buyerAccountId, id) {
  const r = get(id);
  if (r.buyer_account_id !== buyerAccountId) throw forbidden();
  if (!['proposal_sent', 'submitted', 'under_review', 'sourcing', 'open'].includes(r.status)) throw conflict(`Requirement is ${r.status}`);
  db.update('procurement_services', id, { status: r.sourcing_mode === 'self' ? 'closed' : 'cancelled', updated_at: clock.iso() });
  return get(id);
}

/** When every order is closed, compute the service fee and invoice it. */
events.on('procurement.order_updated', (order) => {
  const r = db.one('SELECT * FROM procurement_services WHERE id = ?', order.procurement_service_id);
  if (!r || r.status !== 'fulfilling') return;
  const os = db.all('SELECT * FROM orders WHERE procurement_service_id = ?', r.id);
  if (os.some((o) => !['completed', 'cancelled', 'rejected'].includes(o.status))) return;
  const done = os.filter((o) => o.status === 'completed');
  const now = clock.iso();
  db.update('procurement_services', r.id, { status: done.length ? 'completed' : 'cancelled', updated_at: now });
  if (!done.length) return;
  const value = done.reduce((s, o) => s + o.subtotal_paise, 0);
  const qty = done.reduce((s, o) => s + o.quantity, 0);
  const cfg = JSON.parse(r.fee_config_json);
  const fee = feeFor(cfg, value, qty);
  const feeId = db.insert('procurement_service_fees', { service_id: r.id, fee_model: cfg.model, basis_value_paise: value, basis_quantity: qty, fee_paise: r.fee_waived ? 0 : fee, status: r.fee_waived ? 'waived' : 'calculated', created_at: now, updated_at: now });
  if (r.fee_waived || fee <= 0) return;
  const inv = billing.createInvoice({ accountId: r.buyer_account_id, type: 'procurement', items: [{ description: `Platform-assisted sourcing ${r.reference} — ${qty} ${r.unit} ${r.product_name} (${cfg.model.replace(/_/g, ' ')})`, item_type: 'procurement_fee', unit_amount_paise: fee, related_type: 'procurement_service', related_id: r.id }], relatedType: 'procurement_service_fee', relatedId: feeId, dueAt: new Date(clock.now().getTime() + 7 * 86400000).toISOString() });
  db.update('procurement_service_fees', feeId, { status: 'invoiced', invoice_id: inv.id, updated_at: now });
  notify(r.buyer_account_id, 'procurement_completed', `Sourcing ${r.reference} completed`, `All orders are complete. Service fee invoice ${inv.invoice_number}: ${rupees(inv.total_paise)}.`, { invoice_id: inv.id });
});

billing.on('paid', 'procurement', (inv) => db.run("UPDATE procurement_service_fees SET status = 'paid', updated_at = ? WHERE id = ?", clock.iso(), inv.related_id));

module.exports = { create, estimate, get, forBuyer, queue, demandBoard, review, suggestSuppliers, addLine, respondLine, supplierRequests, sendProposal, approve, decline, feeFor };
