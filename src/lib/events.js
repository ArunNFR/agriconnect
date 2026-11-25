'use strict';
// Tiny synchronous domain-event bus (referrals, analytics, etc. subscribe without circular imports).
const handlers = {};
module.exports = {
  on(evt, fn) { (handlers[evt] ||= []).push(fn); },
  emit(evt, payload) { for (const fn of handlers[evt] || []) fn(payload); },
};
