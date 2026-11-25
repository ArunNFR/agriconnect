'use strict';
const path = require('node:path');
const express = require('express');
const { h, errorHandler } = require('./lib/http');
const { authenticate } = require('./lib/auth');
const payments = require('./services/payments');
const ads = require('./services/advertising');
// load modules that register billing hooks / event listeners
require('./services/subscriptions');
require('./services/promotions');
require('./services/procurement');
require('./services/referrals');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff').set('Referrer-Policy', 'same-origin'); next(); });

  // Provider webhooks need the exact raw body for HMAC verification
  app.post('/api/webhooks/razorpay', express.raw({ type: '*/*', limit: '1mb' }), h((req) => payments.handleWebhook(req.body.toString('utf8'), req.get('x-razorpay-signature'), req.get('x-razorpay-event-id'))));

  app.use(express.json({ limit: '1mb' }));
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/ads/:id/click', h((req, res) => { const url = ads.click(Number(req.params.id)); res.redirect(302, url || '/'); }));
  app.use('/api', authenticate);
  app.use('/api', require('./routes/owner'));
  app.use('/api', require('./routes/api'));
  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Unknown API route' } }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
  app.use(errorHandler);
  return app;
}
module.exports = { createApp };
