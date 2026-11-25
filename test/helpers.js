'use strict';
/**
 * Test harness: in-memory DB, the real app on an ephemeral port, and a local stand-in for the
 * Razorpay REST API. Payments are "made" by recording them in the stand-in and producing the
 * same HMAC signatures Razorpay would — so the production verification code runs unmodified.
 */
const http = require('node:http');
const crypto = require('node:crypto');

process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
process.env.RAZORPAY_KEY_SECRET = 'test_key_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'test_webhook_secret';
process.env.OWNER_PASSWORD = 'owner-pass-123';
process.env.ADMIN_PASSWORD = 'admin-pass-123';

const db = require('../src/db');
const clock = require('../src/lib/clock');
const { seed } = require('../src/db/seed');
const { createApp } = require('../src/app');

function fakeRazorpay() {
  const orders = {};
  const payments = {};
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const auth = Buffer.from((req.headers.authorization || '').replace('Basic ', ''), 'base64').toString();
      if (auth !== 'rzp_test_key:test_key_secret') return send(401, { error: { description: 'auth failed' } });
      const url = new URL(req.url, 'http://x');
      const p = url.pathname.replace(/^\/v1/, '');
      if (req.method === 'POST' && p === '/orders') { const b = JSON.parse(body); const id = `order_${++n}`; orders[id] = { id, ...b, status: 'created' }; return send(200, orders[id]); }
      let m = p.match(/^\/payments\/([^/]+)$/);
      if (req.method === 'GET' && m) return payments[m[1]] ? send(200, payments[m[1]]) : send(404, { error: { description: 'not found' } });
      m = p.match(/^\/payments\/([^/]+)\/refund$/);
      if (req.method === 'POST' && m) { const b = JSON.parse(body); return send(200, { id: `rfnd_${++n}`, payment_id: m[1], amount: b.amount, status: api.refundStatus, notes: b.notes }); }
      if (req.method === 'GET' && p === '/payments') return send(200, { items: Object.values(payments) });
      send(404, { error: { description: 'unknown' } });
    });
  });
  const api = {
    server, orders, payments, refundStatus: 'processed',
    /** Customer completes Checkout for an order. Returns the callback payload the browser would post. */
    pay(orderId, { status = 'captured', method = 'upi', amount } = {}) {
      const id = `pay_${++n}`;
      const o = orders[orderId];
      payments[id] = { id, entity: 'payment', order_id: orderId, amount: amount ?? o.amount, currency: 'INR', status, method, vpa: method === 'upi' ? 'farmer@okhdfc' : undefined, card: method === 'card' ? { network: 'Visa', last4: '1111' } : undefined, error_code: status === 'failed' ? 'BAD_REQUEST_ERROR' : undefined, error_description: status === 'failed' ? 'Payment declined by bank' : undefined, created_at: Math.floor(Date.now() / 1000) };
      const signature = crypto.createHmac('sha256', 'test_key_secret').update(`${orderId}|${id}`).digest('hex');
      return { razorpay_order_id: orderId, razorpay_payment_id: id, razorpay_signature: signature };
    },
  };
  return api;
}

async function setup() {
  clock.reset();
  db.open(':memory:');
  seed();
  const rzp = fakeRazorpay();
  await new Promise((r) => rzp.server.listen(0, r));
  process.env.RAZORPAY_API_BASE = `http://127.0.0.1:${rzp.server.address().port}/v1`;
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function api(method, path, token, body, headers = {}) {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  }
  const ok = async (...a) => { const r = await api(...a); if (r.status >= 300) throw new Error(`${a[0]} ${a[1]} → ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
  async function register(role, email, extra = {}) {
    const r = await ok('POST', '/api/auth/register', null, { role, email, password: 'password-123', name: email.split('@')[0], business_name: `${email.split('@')[0]} Co`, region: 'KA', ...extra });
    return r.token;
  }
  const login = async (email, password) => (await ok('POST', '/api/auth/login', null, { email, password })).token;
  async function webhook(event, entityKey, entity, { secret = 'test_webhook_secret', eventId } = {}) {
    const raw = JSON.stringify({ event, created_at: Math.floor(Date.now() / 1000), payload: { [entityKey]: { entity } } });
    const sig = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    const res = await fetch(`${base}/api/webhooks/razorpay`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-razorpay-signature': sig, 'x-razorpay-event-id': eventId || `evt_${crypto.randomUUID()}` }, body: raw });
    return { status: res.status, body: await res.json() };
  }
  /** Full paid checkout through the real verification path. */
  async function payInvoice(token, invoiceId, opts = {}) {
    const co = await ok('POST', '/api/payments/checkout', token, { invoice_id: invoiceId });
    const cb = rzp.pay(co.checkout.order_id, opts);
    return api('POST', '/api/payments/verify', token, cb);
  }
  // jobs are run as the owner with a fresh session (tests move the clock far ahead)
  const runJobs = async (_token, body = {}) => ok('POST', '/api/admin/jobs/run', await login('owner@agriconnect.local', 'owner-pass-123'), body);
  const close = () => { server.close(); rzp.server.close(); };
  return { api, ok, register, login, webhook, payInvoice, runJobs, rzp, close, db, clock };
}

const DAY = 86400000;
module.exports = { setup, DAY };
