'use strict';
const path = require('node:path');
const db = require('./db');
const { seed } = require('./db/seed');
const { createApp } = require('./app');
const scheduler = require('./services/scheduler');

db.open(process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'agriconnect.db'));
seed({ demo: process.env.SEED_DEMO === '1' || process.argv.includes('--demo') });
const port = Number(process.env.PORT || 3000);
createApp().listen(port, () => {
  console.log(`AgriConnect running on http://localhost:${port}`);
  const p = require('./payments').get();
  console.log(p.isConfigured() ? `Payments: ${p.name} configured` : 'Payments: NOT configured — paid checkout is disabled until RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET are set');
});
scheduler.start(Number(process.env.JOB_INTERVAL_MS || 5 * 60 * 1000));
