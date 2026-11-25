'use strict';
/**
 * Sponsored content from approved agriculture-related businesses. Every ad is reviewed,
 * invoiced, activated only after verified payment, and always rendered with a "Sponsored" label.
 */
const db = require('../db');
const clock = require('../lib/clock');
const audit = require('../lib/audit');
const settings = require('../lib/settings');
const { notify, notifyPlatform } = require('../lib/notify');
const billing = require('./billing');
const { bad, notFound, conflict, forbidden } = require('../lib/util');

function price(placement, startAt, endAt) {
  const cfg = settings.get('advertising');
  const p = cfg.placements[placement];
  if (!p) throw bad(`Unknown placement. Options: ${Object.keys(cfg.placements).join(', ')}`);
  const days = Math.max(1, Math.ceil((new Date(endAt) - new Date(startAt)) / 86400000));
  return { days, daily_rate_paise: p.daily_rate_paise, price_paise: days * p.daily_rate_paise };
}

function create(accountId, body) {
  const cfg = settings.get('advertising');
  for (const f of ['title', 'body', 'ad_category', 'start_at', 'end_at']) if (!body[f]) throw bad(`${f} is required`);
  if (!cfg.categories.includes(body.ad_category)) throw bad(`Ads must be agriculture-related. Allowed categories: ${cfg.categories.join(', ')}`);
  if (new Date(body.end_at) <= new Date(body.start_at)) throw bad('end_at must be after start_at');
  if (body.cta_url && !/^https:\/\//.test(body.cta_url)) throw bad('cta_url must be an https:// link');
  const placement = body.placement || 'marketplace';
  const pr = price(placement, body.start_at, body.end_at);
  const now = clock.iso();
  const id = db.insert('advertisements', { advertiser_account_id: accountId, title: body.title, body: body.body, cta_label: body.cta_label || 'Learn more', cta_url: body.cta_url || null, ad_category: body.ad_category, placement, target_audience: body.target_audience || 'all', target_region: body.target_region || null, start_at: new Date(body.start_at).toISOString(), end_at: new Date(body.end_at).toISOString(), price_paise: pr.price_paise, status: 'draft', created_at: now, updated_at: now });
  return get(id);
}

function submit(accountId, id) {
  const ad = get(id);
  if (ad.advertiser_account_id !== accountId) throw forbidden();
  if (!['draft', 'rejected'].includes(ad.status)) throw conflict(`Ad is ${ad.status}`);
  db.update('advertisements', id, { status: 'pending_review', updated_at: clock.iso() });
  notifyPlatform('ad_review', 'Ad awaiting review', `"${ad.title}" (${ad.ad_category}) needs review.`, { ad_id: id });
  return get(id);
}

/** Admin review. Approval issues the advertiser's invoice; the ad runs only once it is paid. */
function review(actor, id, { approve, notes }) {
  return db.tx(() => {
    const ad = get(id);
    if (ad.status !== 'pending_review') throw conflict(`Ad is ${ad.status}`);
    if (!approve) {
      db.update('advertisements', id, { status: 'rejected', review_notes: notes || null, reviewed_by: actor.userId, updated_at: clock.iso() });
      notify(ad.advertiser_account_id, 'ad_rejected', 'Ad not approved', notes || 'Your ad did not meet our sponsored content guidelines.');
      audit.log(actor, 'ad.rejected', 'advertisement', id, { reason: notes });
      return get(id);
    }
    const pr = price(ad.placement, ad.start_at, ad.end_at);
    const inv = billing.createInvoice({ accountId: ad.advertiser_account_id, type: 'advertising', items: [{ description: `Sponsored placement "${ad.title}" — ${ad.placement}, ${pr.days} day(s)`, item_type: 'advertising', quantity: pr.days, unit_amount_paise: pr.daily_rate_paise, related_type: 'advertisement', related_id: id }], relatedType: 'advertisement', relatedId: id, actor });
    db.update('advertisements', id, { status: 'approved', review_notes: notes || null, reviewed_by: actor.userId, invoice_id: inv.id, price_paise: inv.subtotal_paise, updated_at: clock.iso() });
    audit.log(actor, 'ad.approved', 'advertisement', id, { after: { invoice_id: inv.id } });
    notify(ad.advertiser_account_id, 'ad_approved', 'Ad approved', `Pay invoice ${inv.invoice_number} to schedule your ad.`, { invoice_id: inv.id });
    return get(id);
  });
}

billing.on('paid', 'advertising', () => lifecycle());

/** Start paid ads in their window; end expired ones. */
function lifecycle() {
  const now = clock.iso();
  const started = db.all("SELECT a.id FROM advertisements a JOIN invoices i ON i.id = a.invoice_id WHERE a.status = 'approved' AND i.status = 'paid' AND a.start_at <= ? AND a.end_at > ?", now, now);
  for (const a of started) db.update('advertisements', a.id, { status: 'active', updated_at: now });
  const ended = db.all("SELECT id FROM advertisements WHERE status IN ('active','approved') AND end_at <= ?", now);
  for (const a of ended) db.update('advertisements', a.id, { status: 'ended', updated_at: now });
  return { started: started.length, ended: ended.length };
}

/** Serve ads for a viewer. Always labelled sponsored. */
function serve(placement, viewer, limit = 2) {
  const rows = db.all("SELECT a.id, a.title, a.body, a.cta_label, a.ad_category, ac.name advertiser FROM advertisements a JOIN accounts ac ON ac.id = a.advertiser_account_id WHERE a.status = 'active' AND a.placement = ? AND a.start_at <= ? AND a.end_at > ? AND (a.target_audience = 'all' OR a.target_audience = ?) AND (a.target_region IS NULL OR a.target_region = ?) ORDER BY RANDOM() LIMIT ?",
    placement, clock.iso(), clock.iso(), viewer.type || 'all', viewer.region || '', limit);
  for (const r of rows) db.run('UPDATE advertisements SET impressions = impressions + 1 WHERE id = ?', r.id);
  return rows.map((r) => ({ ...r, sponsored: true, label: 'Sponsored', click_url: `/api/ads/${r.id}/click` }));
}

function click(id) {
  const ad = db.one("SELECT * FROM advertisements WHERE id = ? AND status = 'active'", id);
  if (!ad) throw notFound('Ad');
  db.run('UPDATE advertisements SET clicks = clicks + 1 WHERE id = ?', id);
  return ad.cta_url;
}

function get(id) { const a = db.one('SELECT a.*, ac.name advertiser FROM advertisements a JOIN accounts ac ON ac.id = a.advertiser_account_id WHERE a.id = ?', id); if (!a) throw notFound('Ad'); return a; }
const forAdvertiser = (accountId) => db.all('SELECT * FROM advertisements WHERE advertiser_account_id = ? ORDER BY id DESC', accountId);
const all = (status) => db.all(`SELECT a.*, ac.name advertiser FROM advertisements a JOIN accounts ac ON ac.id = a.advertiser_account_id ${status ? 'WHERE a.status = ?' : ''} ORDER BY a.id DESC`, ...(status ? [status] : []));

module.exports = { price, create, submit, review, lifecycle, serve, click, get, forAdvertiser, all };
