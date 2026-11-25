'use strict';
/**
 * Logistics monetisation: farmer delivery, buyer pickup, third-party transport (referral commission)
 * and platform-arranged transport (coordination fee). Fee models live in platform_settings.logistics_fees.
 */
const db = require('../db');
const clock = require('../lib/clock');
const audit = require('../lib/audit');
const settings = require('../lib/settings');
const billing = require('./billing');
const { notify } = require('../lib/notify');
const { bad, notFound, conflict, pct } = require('../lib/util');

const MODES = ['farmer_delivery', 'buyer_pickup', 'third_party', 'platform_arranged'];
const TRANSITIONS = { requested: ['scheduled', 'cancelled'], scheduled: ['picked_up', 'cancelled'], picked_up: ['in_transit', 'delivered'], in_transit: ['delivered'], delivered: [], cancelled: [] };

function feeConfig(mode) { return settings.get('logistics_fees')[mode] || { model: 'none' }; }

function platformFee(mode, transportCharge, providerId) {
  const c = feeConfig(mode);
  let rate = c.rate_bps || 0;
  if (c.model === 'referral' && providerId) {
    const p = db.one('SELECT referral_commission_bps FROM logistics_providers WHERE id = ?', providerId);
    if (p?.referral_commission_bps != null) rate = p.referral_commission_bps;
  }
  switch (c.model) {
    case 'fixed': return c.fixed_paise || 0;
    case 'percentage': case 'referral': return pct(transportCharge, rate);
    case 'percentage_plus_fixed': return pct(transportCharge, rate) + (c.fixed_paise || 0);
    default: return 0;
  }
}

/** Shown on the order quote before confirmation. */
function quote(mode) {
  if (!MODES.includes(mode)) throw bad('Unknown delivery mode');
  const c = feeConfig(mode);
  const parts = [];
  if (c.model === 'fixed') parts.push(`Coordination fee ₹${(c.fixed_paise / 100).toFixed(2)}`);
  if (['percentage', 'percentage_plus_fixed'].includes(c.model)) parts.push(`${c.rate_bps / 100}% of the transport charge${c.fixed_paise ? ` + ₹${(c.fixed_paise / 100).toFixed(2)}` : ''}`);
  if (c.model === 'referral') parts.push('Transport is billed by the provider; AgriConnect receives a referral commission from the provider');
  return { mode, model: c.model, payer: c.payer || null, upfront_fee_paise: c.model === 'fixed' ? c.fixed_paise : 0, description: parts.join('; ') || 'No platform logistics fee' };
}

function createForOrder(order, { pickup, delivery }) {
  const now = clock.iso();
  const c = feeConfig(order.delivery_mode);
  const fee = c.model === 'fixed' ? c.fixed_paise : 0;
  db.insert('logistics_transactions', { order_id: order.id, mode: order.delivery_mode, pickup_location: pickup, delivery_location: delivery, platform_fee_paise: fee, fee_config_json: c, status: order.delivery_mode === 'buyer_pickup' || order.delivery_mode === 'farmer_delivery' ? 'scheduled' : 'requested', created_at: now, updated_at: now });
}

/** Admin / seller schedules transport: provider, vehicle, charge, pickup time. */
function schedule(actor, orderId, { provider_id, vehicle, transport_charge_paise, pickup_time }) {
  return db.tx(() => {
    const lt = db.one('SELECT * FROM logistics_transactions WHERE order_id = ?', orderId);
    if (!lt) throw notFound('Delivery record');
    if (!['requested', 'scheduled'].includes(lt.status)) throw conflict(`Delivery is ${lt.status}`);
    if (provider_id && !db.one("SELECT 1 FROM logistics_providers WHERE id = ? AND status = 'active'", provider_id)) throw bad('Provider is not active');
    const charge = Number(transport_charge_paise || 0);
    const fee = platformFee(lt.mode, charge, provider_id);
    db.update('logistics_transactions', lt.id, { provider_id: provider_id || null, vehicle: vehicle || null, transport_charge_paise: charge, platform_fee_paise: fee, pickup_time: pickup_time || null, status: 'scheduled', updated_at: clock.iso() });
    db.run('UPDATE orders SET logistics_charge_paise = ?, updated_at = ? WHERE id = ?', lt.mode === 'platform_arranged' ? charge + fee : 0, clock.iso(), orderId);
    audit.log(actor, 'logistics.scheduled', 'logistics_transaction', lt.id, { after: { provider_id, charge, fee } });
    return db.one('SELECT * FROM logistics_transactions WHERE id = ?', lt.id);
  });
}

function setStatus(actor, orderId, status) {
  return db.tx(() => {
    const lt = db.one('SELECT * FROM logistics_transactions WHERE order_id = ?', orderId);
    if (!lt) throw notFound('Delivery record');
    if (!TRANSITIONS[lt.status].includes(status)) throw conflict(`Cannot move delivery from ${lt.status} to ${status}`);
    const patch = { status, updated_at: clock.iso() };
    if (status === 'picked_up') patch.pickup_time = clock.iso();
    if (status === 'delivered') patch.delivery_time = clock.iso();
    db.update('logistics_transactions', lt.id, patch);
    if (status === 'delivered') recognise(db.one('SELECT * FROM logistics_transactions WHERE id = ?', lt.id));
    if (status === 'cancelled') db.run("UPDATE logistics_commissions SET status = 'void', updated_at = ? WHERE logistics_transaction_id = ? AND status = 'pending'", clock.iso(), lt.id);
    return db.one('SELECT * FROM logistics_transactions WHERE id = ?', lt.id);
  });
}

/** Platform logistics revenue is recognised at delivery. */
function recognise(lt) {
  if (!lt.platform_fee_paise || db.one('SELECT 1 FROM logistics_commissions WHERE logistics_transaction_id = ?', lt.id)) return;
  const order = db.one('SELECT * FROM orders WHERE id = ?', lt.order_id);
  const c = JSON.parse(lt.fee_config_json || '{}');
  const payer = c.model === 'referral' ? null : c.payer === 'seller' ? order.seller_account_id : order.buyer_account_id;
  const now = clock.iso();
  const id = db.insert('logistics_commissions', { logistics_transaction_id: lt.id, amount_paise: lt.platform_fee_paise, payer_account_id: payer, commission_type: c.model === 'referral' ? 'referral_commission' : c.model === 'fixed' ? 'coordination_fee' : 'percentage', status: 'recognised', recognised_at: now, created_at: now, updated_at: now });
  billing.recordRevenue({ category: 'logistics_commission', amount: lt.platform_fee_paise, accountId: payer || order.buyer_account_id, sourceType: 'logistics_commission', sourceId: id, orderId: order.id, notes: c.model === 'referral' ? `Referral commission receivable from provider #${lt.provider_id}` : null });
}

// --- providers (registration ready for future self-service onboarding)
function registerProvider(actor, body) {
  if (!body.name) throw bad('Provider name is required');
  const id = db.insert('logistics_providers', { name: body.name, contact_phone: body.contact_phone, contact_email: body.contact_email, vehicle_types: body.vehicle_types, regions: body.regions, referral_commission_bps: body.referral_commission_bps ?? null, status: actor.role === 'owner' || actor.role === 'admin' ? 'active' : 'pending', created_at: clock.iso() });
  return db.one('SELECT * FROM logistics_providers WHERE id = ?', id);
}
function updateProvider(actor, id, body) {
  const before = db.one('SELECT * FROM logistics_providers WHERE id = ?', id);
  if (!before) throw notFound('Provider');
  const patch = {};
  for (const f of ['name', 'contact_phone', 'contact_email', 'vehicle_types', 'regions', 'referral_commission_bps', 'status']) if (body[f] !== undefined) patch[f] = body[f];
  db.update('logistics_providers', id, patch);
  audit.log(actor, 'logistics_provider.updated', 'logistics_provider', id, { before, after: patch });
  return db.one('SELECT * FROM logistics_providers WHERE id = ?', id);
}

function list(filter = {}) {
  const where = filter.accountId ? 'WHERE o.buyer_account_id = ? OR o.seller_account_id = ?' : '';
  const params = filter.accountId ? [filter.accountId, filter.accountId] : [];
  return db.all(`SELECT lt.*, o.order_number, o.buyer_account_id, o.seller_account_id, lp.name provider_name FROM logistics_transactions lt JOIN orders o ON o.id = lt.order_id LEFT JOIN logistics_providers lp ON lp.id = lt.provider_id ${where} ORDER BY lt.id DESC LIMIT 200`, ...params);
}

module.exports = { MODES, quote, createForOrder, schedule, setStatus, registerProvider, updateProvider, list, platformFee };
