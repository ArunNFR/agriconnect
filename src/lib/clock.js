'use strict';
// Central clock so billing jobs and tests can run against a controlled time.
let offsetMs = 0;
let fixed = null;
const now = () => (fixed ? new Date(fixed) : new Date(Date.now() + offsetMs));
module.exports = {
  now,
  iso: () => now().toISOString(),
  set(dateLike) { fixed = dateLike ? new Date(dateLike).getTime() : null; },
  advance(ms) { if (fixed) fixed += ms; else offsetMs += ms; },
  reset() { fixed = null; offsetMs = 0; },
};
