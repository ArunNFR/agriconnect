'use strict';
/**
 * Razorpay provider adapter (Orders API + Checkout + Webhooks + Refunds).
 * Credentials come from the environment; with none configured, paid checkout is refused
 * (there is no simulated success path).
 */
const crypto = require('node:crypto');
const { AppError } = require('../lib/util');

const cfg = () => ({
  keyId: process.env.RAZORPAY_KEY_ID || '',
  keySecret: process.env.RAZORPAY_KEY_SECRET || '',
  webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
  apiBase: (process.env.RAZORPAY_API_BASE || 'https://api.razorpay.com/v1').replace(/\/$/, ''),
});

const name = 'razorpay';
const isConfigured = () => { const c = cfg(); return Boolean(c.keyId && c.keySecret && c.webhookSecret); };

async function call(method, path, body) {
  const c = cfg();
  if (!isConfigured()) throw new AppError(503, 'payments_unavailable', 'Online payments are not configured on this server. Set RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET.');
  const res = await fetch(c.apiBase + path, {
    method,
    headers: { Authorization: 'Basic ' + Buffer.from(`${c.keyId}:${c.keySecret}`).toString('base64'), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.description || `Razorpay API error ${res.status}`;
    throw new AppError(502, 'provider_error', msg, { provider_status: res.status, provider_code: json?.error?.code });
  }
  return json;
}

const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};
const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');

module.exports = {
  name,
  isConfigured,
  publicKey: () => cfg().keyId,
  createOrder: ({ amount, currency = 'INR', receipt, notes }) => call('POST', '/orders', { amount, currency, receipt, notes, payment_capture: 1 }),
  fetchPayment: (paymentId) => call('GET', `/payments/${encodeURIComponent(paymentId)}`),
  fetchOrderPayments: (orderId) => call('GET', `/orders/${encodeURIComponent(orderId)}/payments`),
  listPayments: ({ from, to, count = 100, skip = 0 }) => call('GET', `/payments?from=${from}&to=${to}&count=${count}&skip=${skip}`),
  refund: (paymentId, { amount, notes }) => call('POST', `/payments/${encodeURIComponent(paymentId)}/refund`, { amount, notes, speed: 'normal' }),
  /** Checkout callback signature: HMAC_SHA256(order_id|payment_id, key_secret) */
  verifyPaymentSignature: (orderId, paymentId, signature) => isConfigured() && safeEqual(hmac(cfg().keySecret, `${orderId}|${paymentId}`), signature),
  /** Webhook signature: HMAC_SHA256(raw_body, webhook_secret) */
  verifyWebhookSignature: (rawBody, signature) => isConfigured() && safeEqual(hmac(cfg().webhookSecret, rawBody), signature),
  /** Normalise a Razorpay payment entity */
  normalisePayment: (p) => ({
    id: p.id, orderId: p.order_id, amount: p.amount, currency: p.currency, status: p.status, method: p.method,
    label: p.method === 'card' && p.card ? `${p.card.network || 'Card'} •••• ${p.card.last4 || ''}`.trim()
      : p.method === 'upi' ? `UPI ${p.vpa || ''}`.trim() : p.method === 'netbanking' ? `Net banking ${p.bank || ''}`.trim()
        : p.method === 'wallet' ? `Wallet ${p.wallet || ''}`.trim() : p.method || 'unknown',
    token: p.token_id || null,
    errorCode: p.error_code || null, errorDescription: p.error_description || null,
    createdAt: p.created_at,
  }),
};
