'use strict';
/**
 * Referral programme. Rewards and eligibility rules are configured in platform_settings.referral_program.
 * Reward types: promotion_credits | account_credit | discount_percent | free_months
 * Eligibility: registered | profile_completed | first_listing | first_completed_order | paid_subscription
 */
const db = require('../db');
const clock = require('../lib/clock');
const audit = require('../lib/audit');
const settings = require('../lib/settings');
const events = require('../lib/events');
const { notify } = require('../lib/notify');
const { randomCode, rupees } = require('../lib/util');

function codeFor(accountId) {
  let r = db.one('SELECT * FROM referral_codes WHERE account_id = ?', accountId);
  if (!r) {
    let code;
    do code = `AC${randomCode(6)}`; while (db.one('SELECT 1 FROM referral_codes WHERE code = ?', code));
    db.insert('referral_codes', { account_id: accountId, code, created_at: clock.iso() });
    r = db.one('SELECT * FROM referral_codes WHERE account_id = ?', accountId);
  }
  return r;
}

/** Called at registration. Self-referrals and same-device signups are rejected and flagged. */
function onRegister(refereeAccountId, code, signupIp) {
  const cfg = settings.get('referral_program');
  if (!cfg.enabled || !code) return null;
  const rc = db.one("SELECT * FROM referral_codes WHERE code = ? COLLATE NOCASE AND status = 'active'", String(code).trim());
  if (!rc) return null;
  const referee = db.one('SELECT * FROM accounts WHERE id = ?', refereeAccountId);
  const rules = cfg[referee.type];
  if (!rules) return null;
  const now = clock.iso();
  let status = 'registered';
  let rejection = null;
  if (rc.account_id === refereeAccountId) { status = 'rejected'; rejection = 'self_referral'; }
  else if (signupIp && db.one('SELECT 1 FROM users WHERE account_id = ? AND signup_ip = ?', rc.account_id, signupIp)) { status = 'rejected'; rejection = 'same_device_or_network'; }
  const id = db.insert('referrals', { referral_code_id: rc.id, referrer_account_id: rc.account_id, referee_account_id: refereeAccountId, referee_type: referee.type, status, eligibility_rule: rules.eligibility, rejection_reason: rejection, created_at: now, updated_at: now });
  if (rejection) db.insert('risk_flags', { account_id: refereeAccountId, flag_type: 'referral_abuse', severity: 'low', details_json: { referral_id: id, reason: rejection }, created_at: now });
  else check(refereeAccountId, 'registered');
  return db.one('SELECT * FROM referrals WHERE id = ?', id);
}

function check(accountId, event) {
  const ref = db.one("SELECT * FROM referrals WHERE referee_account_id = ? AND status = 'registered'", accountId);
  if (!ref || ref.eligibility_rule !== event) return;
  db.tx(() => reward(ref));
}

function reward(ref) {
  const cfg = settings.get('referral_program');
  const rules = cfg[ref.referee_type];
  const monthStart = new Date(Date.UTC(clock.now().getUTCFullYear(), clock.now().getUTCMonth(), 1)).toISOString();
  const given = db.one("SELECT COUNT(*) c FROM referrals WHERE referrer_account_id = ? AND status = 'rewarded' AND rewarded_at >= ?", ref.referrer_account_id, monthStart).c;
  const now = clock.iso();
  db.update('referrals', ref.id, { status: 'eligible', updated_at: now });
  const referrerReward = given < cfg.max_rewards_per_referrer_per_month ? grant(ref.referrer_account_id, rules.referrer_reward, ref.id) : { skipped: 'monthly_cap_reached' };
  const refereeReward = grant(ref.referee_account_id, rules.referee_reward, ref.id);
  db.update('referrals', ref.id, { status: 'rewarded', referrer_reward_json: referrerReward, referee_reward_json: refereeReward, rewarded_at: now, updated_at: now });
  audit.log('system', 'referral.rewarded', 'referral', ref.id, { after: { referrerReward, refereeReward } });
}

function grant(accountId, rw, referralId) {
  if (!rw || !rw.type) return null;
  const now = clock.iso();
  const acct = db.one('SELECT type FROM accounts WHERE id = ?', accountId);
  let text;
  if (rw.type === 'promotion_credits') {
    db.insert('credit_ledger', { account_id: accountId, credit_type: 'promotion', amount: rw.value, reason: 'Referral reward', related_type: 'referral', related_id: referralId, expires_at: rw.expires_days ? new Date(clock.now().getTime() + rw.expires_days * 86400000).toISOString() : null, created_at: now });
    text = `${rw.value} promotion credit(s)`;
  } else if (rw.type === 'account_credit') {
    db.insert('credit_ledger', { account_id: accountId, credit_type: 'account', amount: rw.value_paise, reason: 'Referral reward', related_type: 'referral', related_id: referralId, created_at: now });
    text = `${rupees(rw.value_paise)} marketplace credit`;
  } else if (rw.type === 'discount_percent' || rw.type === 'free_months') {
    const code = `REF${randomCode(7)}`;
    db.insert('discount_codes', { code, description: 'Referral reward', discount_type: 'percent', value: rw.type === 'free_months' ? 10000 : rw.value_bps, applies_to: 'subscription', audience: acct.type, frequencies_json: rw.type === 'free_months' ? ['monthly'] : null, duration_cycles: rw.type === 'free_months' ? rw.value : rw.cycles || 1, per_account_limit: 1, max_redemptions: 1, restricted_account_id: accountId, source: 'referral', valid_until: new Date(clock.now().getTime() + 180 * 86400000).toISOString(), created_at: now });
    text = rw.type === 'free_months' ? `${rw.value} free premium month(s) — use code ${code}` : `${rw.value_bps / 100}% off your subscription — use code ${code}`;
  } else return null;
  notify(accountId, 'referral_reward', 'You earned a referral reward', `Thanks for growing AgriConnect! You received ${text}.`);
  return { ...rw, granted: text };
}

function summary(accountId) {
  const rc = codeFor(accountId);
  const cfg = settings.get('referral_program');
  return {
    code: rc.code, program: { enabled: cfg.enabled, farmer: cfg.farmer, buyer: cfg.buyer },
    referrals: db.all('SELECT r.id, r.status, r.referee_type, r.created_at, r.rewarded_at, r.referrer_reward_json, r.rejection_reason, a.name referee FROM referrals r JOIN accounts a ON a.id = r.referee_account_id WHERE r.referrer_account_id = ? ORDER BY r.id DESC', accountId),
  };
}

// Eligibility listeners
events.on('listing.created', ({ accountId }) => check(accountId, 'first_listing'));
events.on('order.completed', (o) => { check(o.buyer_account_id, 'first_completed_order'); check(o.seller_account_id, 'first_completed_order'); });
events.on('subscription.paid', ({ accountId }) => check(accountId, 'paid_subscription'));
events.on('profile.completed', ({ accountId }) => check(accountId, 'profile_completed'));

module.exports = { codeFor, onRegister, summary, check };
