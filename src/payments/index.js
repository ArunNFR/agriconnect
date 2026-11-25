'use strict';
// Provider registry — add Cashfree/Stripe/PayU adapters implementing the same interface.
const providers = { razorpay: require('./razorpay') };
const activeName = () => process.env.PAYMENT_PROVIDER || 'razorpay';
module.exports = {
  get: (n = activeName()) => { const p = providers[n]; if (!p) throw new Error(`Unknown payment provider ${n}`); return p; },
  register: (n, impl) => { providers[n] = impl; },
};
