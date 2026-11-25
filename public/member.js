'use strict';
/* Farmer, buyer and advertiser pages. Gated features call the API and show upgrade prompts on 402. */
const isFarmer = () => S.me.user.role === 'farmer';
const catName = (id) => S.config.categories.find((c) => c.id === Number(id))?.name || '—';
const FREQ = { monthly: 'month', quarterly: 'quarter', annual: 'year' };

/* ------------------------------------------------------------------ dashboard */
PAGES['/'] = async (el) => {
  const [sub, orders] = await Promise.all([GET('/subscription'), GET('/orders')]);
  const s = sub.subscription;
  const open = orders.filter((o) => !['completed', 'cancelled', 'rejected'].includes(o.status));
  const done = orders.filter((o) => o.status === 'completed');
  const ads = await GET('/ads/serve?placement=dashboard').catch(() => []);
  el.innerHTML = `<div class="topbar"><div><h1>${esc(S.me.account.name)}</h1><p class="muted">${isFarmer() ? 'Your farm at a glance' : 'Your procurement at a glance'}</p></div>
    <div class="row">${isFarmer() ? '<a class="btn primary" href="#/inventory">Add produce</a>' : '<a class="btn primary" href="#/marketplace">Find produce</a>'}</div></div>
  ${banners(sub)}
  <div class="grid g4">${stat('Plan', esc(s.plan_name), pill(s.status))}${stat('Open orders', open.length)}${stat(isFarmer() ? 'Completed sales' : 'Completed purchases', done.length, inr(done.reduce((a, o) => a + o.subtotal_paise, 0)))}${stat(isFarmer() ? 'Promotion credits' : 'Account credit', isFarmer() ? sub.promotion_credits.plan_remaining + sub.promotion_credits.bonus_credits : inr(sub.account_credit_paise))}</div>
  <div class="grid g2" style="margin-top:16px"><div class="card"><div class="row between"><h2>Plan usage</h2><a href="#/subscription" class="small">Manage plan</a></div>${usageList(sub.usage.metrics)}</div>
  <div class="card"><h2>Recent orders</h2>${table([{ h: 'Order', k: 'order_number' }, { h: 'Product', k: 'product_name' }, { h: isFarmer() ? 'Buyer' : 'Seller', f: (o) => esc(isFarmer() ? o.buyer_name : o.seller_name) }, { h: 'Value', r: 1, f: (o) => inr(o.subtotal_paise) }, { h: 'Status', f: (o) => pill(o.status) }], orders.slice(0, 6), 'No orders yet.')}</div></div>
  ${ads.length ? `<div class="grid g2" style="margin-top:16px">${ads.map(adCard).join('')}</div>` : ''}`;
};
const adCard = (a) => `<div class="card"><div class="sponsored">Sponsored · ${esc(a.advertiser)}</div><h3 style="margin-top:4px">${esc(a.title)}</h3><p class="small">${esc(a.body)}</p><a class="btn sm" href="${esc(a.click_url)}" target="_blank" rel="noopener sponsored">${esc(a.cta_label || 'Learn more')}</a></div>`;

function banners(sub) {
  const s = sub.subscription;
  const out = [];
  if (s.status === 'trial') out.push(`<div class="banner info">Free trial of <strong>${esc(s.plan_name)}</strong> until ${date(s.trial_ends_at)}. ${sub.open_invoices.length ? `<a href="#" data-pay="${sub.open_invoices[0].id}">Pay ${inr(sub.open_invoices[0].total_paise - sub.open_invoices[0].amount_paid_paise)}</a> to continue after the trial.` : ''}</div>`);
  if (s.status === 'payment_failed') out.push(`<div class="banner warn">Your last payment failed. ${sub.open_invoices[0] ? `<a href="#" data-pay="${sub.open_invoices[0].id}">Retry payment</a>` : ''}</div>`);
  if (s.status === 'past_due') out.push(`<div class="banner warn"><strong>Payment overdue.</strong> Features stay on until ${date(s.grace_ends_at)} (grace period). ${sub.open_invoices[0] ? `<a href="#" data-pay="${sub.open_invoices[0].id}">Pay now</a>` : ''}</div>`);
  if (s.status === 'suspended') out.push(`<div class="banner bad"><strong>Subscription suspended.</strong> Premium features are paused; your data is safe. ${sub.open_invoices[0] ? `<a href="#" data-pay="${sub.open_invoices[0].id}">Pay to restore instantly</a>` : ''}</div>`);
  if (s.cancel_at_period_end) out.push(`<div class="banner warn">Your plan ends on ${date(s.ends_at)}. <a href="#/subscription">Keep my plan</a></div>`);
  if (sub.pending_checkout?.invoice_id) out.push(`<div class="banner info">Upgrade to ${esc(sub.pending_checkout.plan_name)} is awaiting payment. <a href="#" data-pay="${sub.pending_checkout.invoice_id}">Complete payment</a></div>`);
  return out.length ? `<div class="stack" style="margin-bottom:16px">${out.join('')}</div>` : '';
}
const usageList = (metrics) => (metrics.length ? metrics.map((m) => `<div style="margin:10px 0"><div class="row between small"><span>${esc(m.label)}</span><span class="num"><strong>${m.used}</strong> / ${limitTxt(m.limit)}</span></div>${meter(m.used, m.limit)}</div>`).join('') : '<p class="muted">No usage limits on your plan.</p>');

/* ------------------------------------------------------------------ subscription dashboard (section 7) */
let planFreq = 'monthly';
PAGES['/subscription'] = async (el, q) => {
  const d = await GET('/subscription');
  const s = d.subscription;
  const hist = await GET('/subscription/history');
  const canBill = ['owner', 'manager'].includes(S.me.user.account_role);
  el.innerHTML = `<div class="topbar"><div><h1>Subscription</h1>${q.onboarding ? '<p class="muted">Step 2 of 2 — you are on the free plan already. Upgrade now or any time later.</p>' : ''}</div>
    <div class="row"><a class="btn" href="#/billing">Billing history</a></div></div>
  ${banners(d)}
  <div class="grid g2"><div class="card">
    <div class="row between"><div><div class="small muted">CURRENT PLAN</div><h2 style="margin:2px 0">${esc(s.plan_name)}</h2></div>${pill(s.status)}</div>
    <div class="grid g2 small" style="margin-top:8px;gap:8px">
      <div><span class="muted">Price</span><br><strong>${s.price_paise ? `${inr(s.price_paise)} / ${FREQ[s.billing_frequency] || s.billing_frequency}` : 'Free'}</strong>${s.price_paise ? ' <span class="muted">+ GST</span>' : ''}</div>
      <div><span class="muted">Billing frequency</span><br>${esc(title(s.billing_frequency || '—'))}</div>
      <div><span class="muted">Started</span><br>${date(s.start_date)}</div>
      <div><span class="muted">${s.cancel_at_period_end ? 'Ends' : 'Renews'}</span><br>${date(s.cancel_at_period_end ? s.ends_at : s.renewal_date)}</div>
      <div><span class="muted">Next billing</span><br>${date(s.next_billing_at)}</div>
      <div><span class="muted">Trial ends</span><br>${date(s.trial_ends_at)}</div>
      <div><span class="muted">Payment status</span><br>${s.payment_status === 'not_required' ? 'Not required' : pill(s.payment_status)}</div>
      ${s.grace_ends_at ? `<div><span class="muted">Grace period ends</span><br>${date(s.grace_ends_at)}</div>` : ''}
    </div>
    ${s.scheduled_change ? `<div class="banner info" style="margin-top:12px">Changing to <strong>${esc(s.scheduled_change.plan)}</strong>${s.scheduled_change.frequency ? ` (${esc(s.scheduled_change.frequency)})` : ''} on ${date(s.scheduled_change.effective_at)}.</div>` : ''}
    ${canBill ? `<div class="row" style="margin-top:14px">
      ${s.pricing_model !== 'free' ? `<button class="btn ${s.cancel_at_period_end || s.scheduled_change || ['past_due', 'suspended', 'payment_failed'].includes(s.status) ? 'primary' : ''}" id="renew">${s.cancel_at_period_end ? 'Keep my plan' : s.scheduled_change ? 'Cancel scheduled change' : ['past_due', 'suspended', 'payment_failed'].includes(s.status) ? 'Pay & renew' : 'Renew early'}</button>` : ''}
      ${s.pricing_model !== 'free' && !s.cancel_at_period_end ? '<button class="btn danger" id="cancel">Cancel subscription</button>' : ''}
    </div>` : '<p class="small muted">Only the account owner or a manager can change the plan.</p>'}
  </div>
  <div class="card"><h2>Usage this period</h2>${usageList(d.usage.metrics)}
    ${isFarmer() && d.promotion_credits.bonus_credits ? `<p class="small">+${d.promotion_credits.bonus_credits} bonus promotion credit(s) from referrals</p>` : ''}
    <p class="small muted">Period ${date(d.usage.period.start)} – ${date(d.usage.period.end)}</p></div></div>

  <div class="grid g2" style="margin-top:16px"><div class="card"><h2>What your plan includes</h2><div class="table-wrap"><table>${d.entitlements.map((e) => `<tr><td>${esc(e.label)}</td><td class="r">${e.type === 'boolean' ? (e.value ? '✓ Included' : '<span class="muted">Not included</span>') : e.type === 'limit' ? limitTxt(e.value) : esc(title(e.value))}</td></tr>`).join('')}</table></div></div>
  <div class="card"><h2>Payment methods</h2>
    ${d.payment_methods.length ? table([{ h: 'Method', f: (m) => `${esc(m.label)} ${m.is_default ? '<span class="pill good">Default</span>' : ''}` }, { h: '', f: (m) => (canBill ? `${m.is_default ? '' : `<button class="btn sm" data-pmdef="${m.id}">Make default</button>`} <button class="btn sm danger" data-pmrm="${m.id}">Remove</button>` : '') }], d.payment_methods)
    : '<p class="muted">No saved methods yet. Methods you pay with (UPI, cards, net banking) are saved here; card numbers are never stored by AgriConnect.</p>'}
    <p class="small muted">Your default method is pre-selected the next time you pay. You can choose any UPI app, card or bank in the payment window.</p>
    ${d.open_invoices.length ? `<h3 style="margin-top:12px">Outstanding</h3>${table([{ h: 'Invoice', k: 'invoice_number' }, { h: 'Due', f: (i) => date(i.due_at) }, { h: 'Amount', r: 1, f: (i) => inr2(i.total_paise - i.amount_paid_paise) }, { h: '', f: (i) => (canBill ? `<button class="btn sm primary" data-pay="${i.id}">Pay</button>` : '') }], d.open_invoices)}` : ''}
  </div></div>

  <div class="card" style="margin-top:16px"><div class="row between"><h2 style="margin:0">Plans</h2>
    <div class="seg" id="freq">${['monthly', 'quarterly', 'annual'].map((f) => `<button data-f="${f}" class="${planFreq === f ? 'on' : ''}">${title(f)}</button>`).join('')}</div></div>
    <div class="plans" style="margin-top:14px">${d.available_plans.map((p) => planCard(p, s, canBill)).join('')}</div></div>

  <div class="card" style="margin-top:16px"><h2>Subscription history</h2>${table([{ h: 'Date', f: (h) => dt(h.created_at) }, { h: 'Event', f: (h) => esc(title(h.event)) }, { h: 'Plan', f: (h) => esc(h.from_plan === h.to_plan ? h.to_plan : `${h.from_plan || '—'} → ${h.to_plan || '—'}`) }, { h: 'Amount', r: 1, f: (h) => (h.amount_paise ? inr2(h.amount_paise) : '') }], hist.slice(0, 20))}</div>`;

  $('#freq').onclick = (e) => { const b = e.target.closest('[data-f]'); if (b) { planFreq = b.dataset.f; route(); } };
  el.querySelectorAll('[data-choose]').forEach((b) => (b.onclick = () => choosePlan(b.dataset.choose)));
  el.querySelectorAll('[data-enterprise]').forEach((b) => (b.onclick = () => enterpriseEnquiry(b.dataset.enterprise)));
  el.querySelectorAll('[data-pmdef]').forEach((b) => (b.onclick = async () => { await POST(`/billing/payment-methods/${b.dataset.pmdef}/default`); route(); }));
  el.querySelectorAll('[data-pmrm]').forEach((b) => (b.onclick = async () => { await POST(`/billing/payment-methods/${b.dataset.pmrm}/remove`); route(); }));
  $('#renew')?.addEventListener('click', async () => {
    try { const r = await POST('/subscription/renew'); if (r.invoice && ['issued', 'overdue'].includes(r.invoice.status)) payInvoice(r.invoice.id); else { toast('Subscription updated'); route(); } } catch (e) { handleError(e); }
  });
  $('#cancel')?.addEventListener('click', () => modal(`<h2>Cancel ${esc(s.plan_name)}?</h2><p>You keep every feature until <strong>${date(s.current_period_end)}</strong>. After that your account moves to the free plan — your listings, orders and history are kept, and listings above the free limit are set inactive (never deleted).</p>
    <label>Reason (optional)<select id="why"><option value="">Choose…</option><option>Too expensive</option><option>Seasonal — will be back</option><option>Missing features</option><option>Not enough orders</option><option>Other</option></select></label>
    <div class="row" style="margin-top:14px"><button class="btn danger" id="yes">Cancel at period end</button><button class="btn" data-close>Keep plan</button></div>`, (m, close) => {
    $('#yes', m).onclick = async () => { try { await POST('/subscription/cancel', { reason: $('#why', m).value }); close(); toast('Cancellation scheduled'); route(); } catch (e) { handleError(e); } };
  }));
};

function planCard(p, s, canBill) {
  const price = p.prices.find((x) => x.billing_frequency === planFreq && x.status === 'active');
  const monthly = p.prices.find((x) => x.billing_frequency === 'monthly');
  const saving = price && monthly && price.interval_months > 1 ? Math.round((1 - price.price_paise / (monthly.price_paise * price.interval_months)) * 100) : 0;
  let priceHtml = 'Free';
  if (p.pricing_model === 'custom') priceHtml = 'Custom';
  else if (p.pricing_model === 'fixed') priceHtml = price ? `${price.effective_price_paise !== price.price_paise ? `<s class="muted" style="font-size:16px">${inr(price.price_paise)}</s> ` : ''}${inr(price.effective_price_paise)}<span class="small muted"> / ${FREQ[planFreq]}</span>` : '<span class="small muted">Not offered ' + planFreq + '</span>';
  const current = p.relation === 'current' && (s.billing_frequency === planFreq || p.pricing_model !== 'fixed');
  let action = '';
  if (!canBill) action = '';
  else if (current) action = '<span class="pill good">Current plan</span>';
  else if (p.pricing_model === 'custom') action = `<button class="btn" data-enterprise="${esc(p.code)}">Contact sales</button>`;
  else if (p.pricing_model === 'fixed' && !price) action = '';
  else action = `<button class="btn ${p.relation === 'upgrade' ? 'primary' : ''}" data-choose="${esc(p.code)}">${p.relation === 'current' ? `Switch to ${planFreq}` : p.relation === 'upgrade' ? (p.trial_eligible ? `Start ${p.trial_days}-day free trial` : 'Upgrade') : 'Downgrade'}</button>`;
  return `<div class="card plan ${p.relation === 'current' ? 'current' : ''}"><div><h3 style="margin:0">${esc(p.name)}</h3><div class="small muted">${esc(p.target_customers || '')}</div></div>
    <div class="price">${priceHtml}</div>${saving > 0 ? `<span class="pill good">Save ${saving}% vs monthly</span>` : ''}${price?.promo_label && price.effective_price_paise !== price.price_paise ? `<span class="pill warn">${esc(price.promo_label)}</span>` : ''}
    <ul>${p.features.map((f) => `<li>${esc(f.label)}</li>`).join('')}</ul><div class="actions">${action}</div></div>`;
}

async function choosePlan(code, discount) {
  let q;
  try { q = await POST('/subscription/quote', { plan_code: code, frequency: planFreq, discount_code: discount || undefined }); } catch (e) { return handleError(e); }
  const body = q.timing === 'period_end'
    ? `<p>${q.action === 'change_frequency' ? 'Your billing frequency' : 'Your plan'} will change on <strong>${date(q.effective_at)}</strong>. You keep your current features until then${q.recurring_price_paise ? `, then pay ${inr(q.recurring_price_paise)} + GST per ${FREQ[planFreq]}` : ''}.</p><p class="small muted">If you have more active listings than the new plan allows, the extra listings are set inactive (not deleted). Orders already placed continue as normal.</p>`
    : q.trial ? `<div class="banner good">Free for ${q.trial.days} days — no payment today. Your first invoice (${inr(q.recurring_price_paise)} + GST) is issued before the trial ends on ${date(q.trial.ends_at)}.</div>`
      : q.total_paise === 0 && q.plan.pricing_model === 'free' ? '<p>No payment needed.</p>'
        : `<div class="table-wrap"><table>${q.lines.map((l) => `<tr><td>${esc(l.description)}</td><td class="r">${inr2(l.unit_amount_paise)}</td></tr>`).join('')}
          ${q.account_credit_paise ? `<tr><td>Account credit</td><td class="r">−${inr2(q.account_credit_paise)}</td></tr>` : ''}
          <tr><td>${esc(q.tax_label)} (${q.tax_rate_bps / 100}%)</td><td class="r">${inr2(q.tax_paise)}</td></tr><tr><th>Due today</th><th class="r">${inr2(q.total_paise)}</th></tr></table></div>
          <p class="small muted">Renews at ${inr(q.recurring_price_paise)} + GST every ${FREQ[planFreq]}. Your plan activates as soon as the payment is confirmed by the bank.</p>`;
  modal(`<h2>${esc(q.plan.name)}</h2>${body}
    ${q.timing === 'immediate' && q.plan.pricing_model === 'fixed' && !q.trial ? `<form class="row" id="dc" style="margin-top:8px"><input name="code" placeholder="Discount code" value="${esc(discount || '')}" style="max-width:220px"><button class="btn sm">Apply</button></form>${q.discount ? `<p class="small" style="color:var(--good)">Code ${esc(q.discount.code)} applied${q.discount.cycles > 1 ? ` for ${q.discount.cycles} billing cycles` : ''}.</p>` : ''}` : ''}
    <div class="row" style="margin-top:16px"><button class="btn primary" id="go">${q.timing === 'period_end' ? 'Schedule change' : q.trial ? 'Start free trial' : q.total_paise ? `Continue to payment (${inr2(q.total_paise)})` : 'Confirm'}</button><button class="btn" data-close>Back</button></div>`, (m, close) => {
    $('#dc', m)?.addEventListener('submit', (e) => { e.preventDefault(); close(); choosePlan(code, e.target.code.value); });
    $('#go', m).onclick = async () => {
      $('#go', m).disabled = true;
      try {
        const r = await POST('/subscription/checkout', { plan_code: code, frequency: planFreq, discount_code: discount || undefined }, { idem: true });
        close();
        if (r.requires_payment) payInvoice(r.invoice.id);
        else { toast(r.scheduled ? `Change scheduled for ${date(r.effective_at)}` : r.trial ? 'Trial started — enjoy!' : 'Plan activated'); route(); }
      } catch (e) { $('#go', m).disabled = false; handleError(e); }
    };
  });
}

function enterpriseEnquiry(code) {
  modal(`<h2>Enterprise pricing</h2><p>Tell us about your sourcing or production needs and we will prepare a custom contract.</p><form class="form" id="ef"><label>Requirements<textarea name="requirements" placeholder="Locations, volumes, products, users, integrations, SLA…" required style="font-family:inherit"></textarea></label><button class="btn primary">Send enquiry</button></form>`, (m, close) => {
    $('#ef', m).onsubmit = async (e) => { e.preventDefault(); try { await POST('/subscription/enterprise-enquiry', { plan_code: code, ...formData(e.target) }); close(); toast('Enquiry sent — our team will contact you with a quote.'); } catch (err) { handleError(err); } };
  });
}

/* ------------------------------------------------------------------ billing (section 20) */
PAGES['/billing'] = async (el) => {
  const [inv, sum] = await Promise.all([GET('/billing/invoices'), GET('/billing/summary')]);
  const canBill = ['owner', 'manager'].includes(S.me.user.account_role);
  el.innerHTML = `<div class="topbar"><div><h1>Billing & invoices</h1><p class="muted">Invoices, payments, refunds and platform charges</p></div></div>
  <div class="grid g3">${stat('Pending payments', inr2(sum.pending.reduce((a, p) => a + p.due_paise, 0)), `${sum.pending.length} invoice(s)`)}${stat('Paid to date', inr2(sum.payments.filter((p) => p.status !== 'failed' && p.status !== 'created').reduce((a, p) => a + p.amount_paise, 0)))}${stat('Account credit', inr2(sum.account_credit_paise), 'Applied automatically to your next invoice')}</div>
  <div class="card" style="margin-top:16px"><h2>Invoices</h2>${table([{ h: 'Invoice', k: 'invoice_number' }, { h: 'Type', f: (i) => esc(title(i.invoice_type)) }, { h: 'Issued', f: (i) => date(i.issued_at) }, { h: 'Total', r: 1, f: (i) => inr2(i.total_paise) }, { h: 'Status', f: (i) => pill(i.status) },
    { h: '', f: (i) => `<button class="btn sm" data-invoice="${i.id}">Download</button> ${['issued', 'overdue'].includes(i.status) && canBill ? `<button class="btn sm primary" data-pay="${i.id}">Pay</button>` : ''}` }], inv)}</div>
  <div class="grid g2" style="margin-top:16px"><div class="card"><h2>Payment history</h2>${table([{ h: 'Date', f: (p) => dt(p.captured_at || p.created_at) }, { h: 'Invoice', k: 'invoice_number' }, { h: 'Method', f: (p) => esc(p.method || '—') }, { h: 'Amount', r: 1, f: (p) => inr2(p.amount_paise) }, { h: 'Status', f: (p) => pill(p.status) }], sum.payments.filter((p) => p.status !== 'created'))}</div>
  <div class="card"><h2>Refunds</h2>${table([{ h: 'Date', f: (r) => date(r.created_at) }, { h: 'Invoice', k: 'invoice_number' }, { h: 'Amount', r: 1, f: (r) => inr2(r.amount_paise) }, { h: 'Status', f: (r) => pill(r.status) }], sum.refunds, 'No refunds.')}</div></div>
  <div class="grid g2" style="margin-top:16px"><div class="card"><h2>Transaction commissions</h2>${table([{ h: 'Order', k: 'order_number' }, { h: 'Order value', r: 1, f: (c) => inr(c.order_value_paise) }, { h: 'Fee', r: 1, f: (c) => inr2(c.commission_paise) }, { h: 'Charged to', f: (c) => esc(title(c.charged_to)) }, { h: 'Status', f: (c) => pill(c.status) }], sum.commissions, 'No commissions charged.')}</div>
  <div class="card"><h2>Service fees & promotion charges</h2>${table([{ h: 'Item', f: (x) => esc(x.reference ? `Sourcing ${x.reference}` : x.name) }, { h: 'Amount', r: 1, f: (x) => (x.fee_paise != null ? inr2(x.fee_paise) : x.paid_with === 'payment' ? inr2(x.amount_charged_paise) : `${x.credits_used} credit(s)`) }, { h: 'Status', f: (x) => pill(x.status) }], [...sum.service_fees, ...sum.promotion_charges], 'No service fees or promotions.')}</div></div>`;
};

/* ------------------------------------------------------------------ farmer: inventory & promotions */
PAGES['/inventory'] = async (el) => {
  const [list, farms, sub] = await Promise.all([GET('/listings/mine'), GET('/farms'), GET('/subscription')]);
  const m = sub.usage.metrics.find((x) => x.key === 'max_active_listings');
  const ent = Object.fromEntries(sub.entitlements.map((e) => [e.key, e.value]));
  el.innerHTML = `<div class="topbar"><div><h1>Inventory</h1><p class="muted">${m ? `${m.used} / ${limitTxt(m.limit)} active listings` : ''}</p></div>
    <div class="row"><button class="btn" id="bulk">Bulk publish</button><button class="btn" id="farm">Add farm location</button><button class="btn primary" id="add">Add listing</button></div></div>
  ${list.some((l) => l.deactivated_reason === 'plan_limit') ? '<div class="banner warn" style="margin-bottom:16px">Some listings were set inactive because they exceed your plan limit. They are safe — <a href="#/subscription">upgrade</a> to reactivate them.</div>' : ''}
  <div class="card">${table([{ h: 'Product', f: (l) => `<strong>${esc(l.product_name)}</strong><div class="small muted">${esc(l.category_name || '')}${l.availability === 'upcoming' ? ` · harvest ${date(l.harvest_date)}` : ''}</div>` },
    { h: 'Qty', r: 1, f: (l) => `${l.quantity} ${esc(l.unit)}` }, { h: 'Price', r: 1, f: (l) => `${inr2(l.price_per_unit_paise)}/${esc(l.unit)}` }, { h: 'Views', r: 1, k: 'views' },
    { h: 'Status', f: (l) => `${pill(l.status)}${l.active_promotion_id ? ' <span class="pill info">Promoted</span>' : ''}` },
    { h: '', f: (l) => `<button class="btn sm" data-edit="${l.id}">Edit</button> ${l.status === 'active' ? `<button class="btn sm" data-off="${l.id}">Deactivate</button> <button class="btn sm primary" data-promote="${l.id}">Promote</button>` : `<button class="btn sm" data-on="${l.id}">Activate</button>`}` }], list, 'No listings yet. Add your first produce listing.')}</div>
  <div class="card" style="margin-top:16px"><h2>Farm locations</h2>${table([{ h: 'Farm', k: 'name' }, { h: 'Type', k: 'farm_type' }, { h: 'Region', k: 'region' }], farms, 'No farm locations yet.')}</div>`;
  const byId = Object.fromEntries(list.map((l) => [l.id, l]));
  $('#add').onclick = () => listingForm(null, farms, ent);
  $('#farm').onclick = () => modal(`<h2>Add farm location</h2><form class="form" id="ff"><label>Name<input name="name" required></label><label>Type<input name="farm_type" placeholder="Mushroom unit, greenhouse…"></label><label>Region<select name="region">${regionOpts(S.me.account.region)}</select></label><label>Address<input name="address"></label><button class="btn primary">Save</button></form>`, (mm, close) => {
    $('#ff', mm).onsubmit = async (e) => { e.preventDefault(); try { await POST('/farms', formData(e.target)); close(); route(); } catch (err) { close(); handleError(err); } };
  });
  $('#bulk').onclick = () => modal(`<h2>Bulk publish</h2><p class="small muted">One listing per line: <code>product, category, quantity, unit, price per unit (₹)</code></p><textarea id="csv" placeholder="Oyster Mushrooms, Mushrooms, 500, kg, 180"></textarea><div class="row" style="margin-top:12px"><button class="btn primary" id="pub">Publish all</button></div>`, (mm, close) => {
    $('#pub', mm).onclick = async () => {
      const items = $('#csv', mm).value.split('\n').map((l) => l.split(',').map((x) => x.trim())).filter((r) => r[0]).map(([n, c, q, u, p]) => ({ product_name: n, category_id: S.config.categories.find((x) => x.name.toLowerCase() === (c || '').toLowerCase())?.id, quantity: Number(q), unit: u || 'kg', price_per_unit_paise: Math.round(Number(p) * 100) }));
      try { await POST('/listings/bulk', { items }); close(); toast(`${items.length} listings published`); route(); } catch (e) { close(); handleError(e); }
    };
  });
  el.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => listingForm(byId[b.dataset.edit], farms, ent)));
  el.querySelectorAll('[data-on]').forEach((b) => (b.onclick = async () => { try { await PUT(`/listings/${b.dataset.on}`, { status: 'active' }); route(); } catch (e) { handleError(e); } }));
  el.querySelectorAll('[data-off]').forEach((b) => (b.onclick = async () => { await PUT(`/listings/${b.dataset.off}`, { status: 'inactive' }); route(); }));
  el.querySelectorAll('[data-promote]').forEach((b) => (b.onclick = () => promoteFlow(byId[b.dataset.promote], sub)));
};

function listingForm(l, farms, ent) {
  modal(`<h2>${l ? 'Edit listing' : 'New listing'}</h2><form class="form cols" id="lf">
    <label>Product<input name="product_name" value="${esc(l?.product_name)}" required></label>
    <label>Category<select name="category_id">${categoryOpts(l?.category_id)}</select></label>
    <label>Quantity<input name="quantity" type="number" step="0.1" min="0.1" value="${l?.quantity ?? ''}" required></label>
    <label>Unit<select name="unit">${opts(['kg', 'quintal', 'tonne', 'box', 'dozen', 'piece'].map((u) => ({ value: u, label: u })), l?.unit || 'kg')}</select></label>
    <label>Price per unit (₹)<input name="price_per_unit_paise" data-paise type="number" step="0.01" min="0.01" value="${l ? l.price_per_unit_paise / 100 : ''}" required></label>
    <label>Minimum order<input name="min_order_qty" type="number" step="0.1" value="${l?.min_order_qty ?? 1}"></label>
    <label>Farm<select name="farm_id">${opts(farms.map((f) => ({ value: f.id, label: f.name })), l?.farm_id, { blank: '—' })}</select></label>
    <label>Region<select name="region">${regionOpts(l?.region || S.me.account.region)}</select></label>
    <label>Availability<select name="availability">${opts([{ value: 'available', label: 'Available now' }, { value: 'upcoming', label: `Upcoming harvest${ent.upcoming_harvest_listings ? '' : ' (Growth+)'}` }], l?.availability)}</select></label>
    <label>Harvest date<input name="harvest_date" type="date" value="${esc(l?.harvest_date?.slice(0, 10))}"></label>
    <label style="grid-column:1/-1">Description<input name="description" value="${esc(l?.description)}"></label>
    <div><button class="btn primary">${l ? 'Save' : 'Publish listing'}</button></div></form>`, (m, close) => {
    $('#lf', m).onsubmit = async (e) => {
      e.preventDefault();
      const b = formData(e.target);
      try { if (l) await PUT(`/listings/${l.id}`, b); else await POST('/listings', b); close(); toast('Saved'); route(); } catch (err) { close(); handleError(err); }
    };
  });
}

async function promoteFlow(l, sub) {
  const cat = await GET('/promotions/catalog');
  const credits = sub.promotion_credits.plan_remaining + sub.promotion_credits.bonus_credits;
  modal(`<h2>Promote “${esc(l.product_name)}”</h2><p class="small muted">Promoted listings appear first in relevant searches with a clear label. You have <strong>${credits}</strong> promotion credit(s).</p>
  <form class="form" id="pf"><label>Promotion<select name="promotion_code" id="pc">${cat.map((c) => `<option value="${esc(c.code)}" data-region="${c.requires_region}" data-cat="${c.requires_category}">${esc(c.name)} — ${inr(c.price_paise)} or ${c.credit_cost} credit(s)</option>`).join('')}</select></label>
  <label id="rg">Target region<select name="target_region">${regionOpts(l.region)}</select></label>
  <label id="ct">Target category<select name="target_category_id">${categoryOpts(l.category_id)}</select></label>
  <label class="check"><input type="checkbox" name="use_credits" ${credits ? '' : 'disabled'}> Use promotion credits instead of paying</label>
  <label>Discount code (optional)<input name="discount_code"></label>
  <div id="pq" class="small"></div><button class="btn primary">Continue</button></form>`, (m, close) => {
    const sync = () => { const o = $('#pc', m).selectedOptions[0]; $('#rg', m).hidden = o.dataset.region !== '1'; $('#ct', m).hidden = o.dataset.cat !== '1'; const c = cat.find((x) => x.code === o.value); $('#pq', m).innerHTML = `${c.duration_hours} hours · ${inr2(c.price_paise)} + GST`; };
    $('#pc', m).onchange = sync; sync();
    $('#pf', m).onsubmit = async (e) => {
      e.preventDefault();
      const b = formData(e.target);
      try {
        const r = await POST('/promotions/purchase', { ...b, listing_id: l.id }, { idem: true });
        close();
        if (r.requires_payment) payInvoice(r.invoice.id, { onDone: () => { location.hash = '#/promotions'; route(); } });
        else { toast('Promotion is live'); location.hash = '#/promotions'; }
      } catch (err) { close(); handleError(err); }
    };
  });
}

PAGES['/promotions'] = async (el) => {
  const list = await GET('/promotions/mine');
  const spent = list.reduce((a, p) => a + p.amount_charged_paise, 0);
  const rev = list.reduce((a, p) => a + p.performance.revenue_paise, 0);
  el.innerHTML = `<div class="topbar"><div><h1>Promotions</h1><p class="muted">Promote listings from <a href="#/inventory">Inventory</a></p></div></div>
  <div class="grid g4">${stat('Promotions', list.length)}${stat('Spend', inr(spent))}${stat('Orders from promotions', list.reduce((a, p) => a + p.performance.orders, 0))}${stat('Revenue generated', inr(rev))}</div>
  <div class="card" style="margin-top:16px">${table([{ h: 'Listing', f: (p) => `<strong>${esc(p.product_name)}</strong><div class="small muted">${esc(p.promotion_name)}</div>` }, { h: 'Period', f: (p) => (p.starts_at ? `${dt(p.starts_at)} – ${dt(p.ends_at)}` : '—') },
    { h: 'Cost', r: 1, f: (p) => (p.paid_with === 'payment' ? inr(p.amount_charged_paise) : `${p.credits_used} cr`) }, { h: 'Impr.', r: 1, f: (p) => p.performance.impressions }, { h: 'Views', r: 1, f: (p) => p.performance.views }, { h: 'Enquiries', r: 1, f: (p) => p.performance.enquiries },
    { h: 'Orders', r: 1, f: (p) => p.performance.orders }, { h: 'Conv.', r: 1, f: (p) => `${p.performance.conversion_rate}%` }, { h: 'Revenue', r: 1, f: (p) => inr(p.performance.revenue_paise) }, { h: 'Status', f: (p) => `${pill(p.status)}${p.status === 'pending_payment' && p.invoice_id ? ` <button class="btn sm primary" data-pay="${p.invoice_id}">Pay</button>` : ''}` }], list, 'No promotions yet.')}</div>`;
};

/* ------------------------------------------------------------------ orders (both sides) */
PAGES['/orders'] = async (el) => {
  const list = await GET('/orders');
  const next = isFarmer() ? { placed: ['accepted', 'rejected'], accepted: ['dispatched', 'cancelled'], dispatched: ['delivered'], delivered: ['completed'] } : { placed: ['cancelled'], dispatched: ['delivered'], delivered: ['completed'] };
  el.innerHTML = `<div class="topbar"><div><h1>Orders</h1><p class="muted">Orders always continue to be processed, whatever your plan status.</p></div>
    <button class="btn" id="exp">Export CSV</button></div>
  <div class="card">${table([{ h: 'Order', f: (o) => `<strong>${esc(o.order_number)}</strong><div class="small muted">${dt(o.placed_at)}${o.basket_ref ? ` · ${esc(o.basket_ref)}` : ''}</div>` }, { h: 'Product', f: (o) => `${esc(o.product_name)}<div class="small muted">${o.quantity} ${esc(o.unit)} @ ${inr2(o.unit_price_paise)}</div>` },
    { h: isFarmer() ? 'Buyer' : 'Seller', f: (o) => esc(isFarmer() ? o.buyer_name : o.seller_name) }, { h: 'Value', r: 1, f: (o) => inr2(o.subtotal_paise) }, { h: 'Platform fee', r: 1, f: (o) => (isFarmer() ? (o.seller_fee_paise ? inr2(o.seller_fee_paise) : '—') : (o.buyer_fee_paise ? inr2(o.buyer_fee_paise) : '—')) },
    { h: 'Delivery', f: (o) => `${esc(title(o.delivery_mode))}<div class="small">${o.delivery_status ? pill(o.delivery_status) : ''}</div>` }, { h: 'Status', f: (o) => pill(o.status) },
    { h: '', f: (o) => (next[o.status] || []).map((s) => `<button class="btn sm ${s === 'completed' || s === 'accepted' ? 'primary' : ''}" data-o="${o.id}" data-s="${s}">${esc(title(s === 'accepted' ? 'accept' : s === 'rejected' ? 'reject' : s === 'dispatched' ? 'dispatch' : s === 'delivered' ? 'mark delivered' : s === 'completed' ? 'complete' : 'cancel'))}</button>`).join(' ') }], list, 'No orders yet.')}</div>`;
  el.querySelectorAll('[data-o]').forEach((b) => (b.onclick = async () => { try { await POST(`/orders/${b.dataset.o}/status`, { status: b.dataset.s }); route(); } catch (e) { handleError(e); } }));
  $('#exp').onclick = () => downloadCsv(isFarmer() ? '/sales/reports/export' : '/procurement/reports/export', isFarmer() ? 'sales-report.csv' : 'procurement-report.csv');
};

/* ------------------------------------------------------------------ farmer: demand board & supply requests */
PAGES['/demand'] = async (el) => {
  const reqs = await GET('/supply-requests');
  let board = null; let locked = null;
  try { board = await GET('/demand-board'); } catch (e) { if (e.code === 'upgrade_required') locked = e; else throw e; }
  el.innerHTML = `<div class="topbar"><div><h1>Buyer demand</h1><p class="muted">Live sourcing requirements from buyers, and supply requests from AgriConnect's procurement team</p></div></div>
  <div class="card"><h2>Supply requests for you</h2>${table([{ h: 'Request', f: (r) => `${esc(r.reference)}<div class="small muted">${esc(r.product_name)}</div>` }, { h: 'Quantity', r: 1, f: (r) => r.quantity }, { h: 'Price', r: 1, f: (r) => inr2(r.unit_price_paise) }, { h: 'Needed by', f: (r) => esc(r.required_by || '—') }, { h: 'Status', f: (r) => pill(r.status) },
    { h: '', f: (r) => (r.status === 'contacted' ? `<button class="btn sm primary" data-yes="${r.id}">Confirm availability</button> <button class="btn sm" data-no="${r.id}">Decline</button>` : '') }], reqs, 'No supply requests right now.')}</div>
  <div class="card" style="margin-top:16px"><h2>Buyer demand board</h2>${locked ? `<div class="banner info">${esc(locked.message)} See what buyers need right now with <a href="#/subscription">Farmer Growth</a>.</div>`
    : table([{ h: 'Product', f: (r) => `<strong>${esc(r.product_name)}</strong><div class="small muted">${esc(r.category || '')} · ${esc(title(r.buyer_type || 'buyer'))}</div>` }, { h: 'Quantity', r: 1, f: (r) => `${r.quantity} ${esc(r.unit)}` }, { h: 'Target price', r: 1, f: (r) => (r.target_price_paise ? inr2(r.target_price_paise) : '—') }, { h: 'Needed by', f: (r) => esc(r.required_by || '—') }, { h: 'Region', k: 'delivery_region' }], board, 'No open buyer requirements.')}</div>`;
  el.querySelectorAll('[data-yes],[data-no]').forEach((b) => (b.onclick = async () => { await POST(`/supply-requests/${b.dataset.yes || b.dataset.no}/respond`, { confirm: !!b.dataset.yes }); route(); }));
};

/* ------------------------------------------------------------------ intelligence (section 15) */
PAGES['/insights'] = async (el) => {
  const d = await GET('/intelligence');
  const block = (t, html) => `<div class="card"><h2>${esc(t)}</h2>${html}</div>`;
  const parts = [];
  if (isFarmer()) {
    parts.push(block('Your sales', `<div class="grid g3">${stat('Completed orders', d.sales_summary.orders)}${stat('Revenue', inr(d.sales_summary.revenue_paise))}${stat('Buyers', d.sales_summary.buyers)}</div><h3 style="margin-top:14px">Product performance</h3>${table([{ h: 'Product', k: 'product_name' }, { h: 'Qty sold', r: 1, k: 'qty' }, { h: 'Views', r: 1, k: 'views' }, { h: 'Revenue', r: 1, f: (r) => inr(r.revenue_paise) }], d.product_performance)}`));
    if (d.repeat_buyers) parts.push(block('Repeat buyers', table([{ h: 'Buyer', k: 'buyer' }, { h: 'Orders', r: 1, k: 'orders' }], d.repeat_buyers, 'No repeat buyers yet.')));
  } else {
    parts.push(block('Procurement history', `${stat('Total spend', inr(d.spend_paise))}${table([{ h: 'Month', k: 'month' }, { h: 'Product', k: 'product_name' }, { h: 'Qty', r: 1, k: 'qty' }, { h: 'Avg price', r: 1, f: (r) => inr2(r.avg_price_paise) }, { h: 'Spend', r: 1, f: (r) => inr(r.spend_paise) }], d.procurement_history)}`));
    if (d.supply_availability) parts.push(block('Supply availability & price comparison', table([{ h: 'Category', k: 'category' }, { h: 'Region', k: 'region' }, { h: 'Available', r: 1, k: 'qty' }, { h: 'Suppliers', r: 1, k: 'suppliers' }, { h: 'Min', r: 1, f: (r) => inr2(r.min_price_paise) }, { h: 'Avg', r: 1, f: (r) => inr2(r.avg_price_paise) }, { h: 'Max', r: 1, f: (r) => inr2(r.max_price_paise) }], d.supply_availability, 'Not enough suppliers yet to show aggregated data.')));
    if (d.shortage_alerts) parts.push(block('Supply shortage alerts', table([{ h: 'Category', k: 'category' }, { h: 'Demand', r: 1, k: 'demand_qty' }, { h: 'Available', r: 1, k: 'available_qty' }], d.shortage_alerts, 'No shortages detected.')));
    if (d.supplier_performance) parts.push(block('Supplier performance', table([{ h: 'Supplier', k: 'supplier' }, { h: 'Orders', r: 1, k: 'orders' }, { h: 'Completed', r: 1, k: 'completed' }], d.supplier_performance)));
  }
  if (d.demand_by_category) parts.push(block('Demand by category', table([{ h: 'Category', k: 'category' }, { h: 'Demand', r: 1, k: 'demand_qty' }, { h: 'Available', r: 1, f: (r) => r.available_qty ?? 0 }, { h: 'Signal', f: (r) => `<span class="pill ${r.signal === 'shortage' ? 'bad' : r.signal === 'high_demand' ? 'warn' : ''}">${esc(title(r.signal))}</span>` }], d.demand_by_category, 'Not enough activity yet.')));
  if (d.price_trends) parts.push(block('Price trends (weekly average)', table([{ h: 'Category', k: 'category' }, { h: 'Week', k: 'week' }, { h: 'Avg price', r: 1, f: (r) => inr2(r.avg_price_paise) }, { h: 'Orders', r: 1, k: 'orders' }], d.price_trends.slice(-20), 'Not enough orders yet.')));
  if (d.regional_buyer_activity) parts.push(block('Regional buyer activity', table([{ h: 'Region', k: 'region' }, { h: 'Active buyers', r: 1, k: 'active_buyers' }, { h: 'Orders', r: 1, k: 'orders' }], d.regional_buyer_activity, 'Not enough activity yet.')));
  if (d.harvest_outlook) parts.push(block('Harvest outlook', table([{ h: 'Category', k: 'category' }, { h: 'Month', k: 'month' }, { h: 'Upcoming qty', r: 1, k: 'qty' }], d.harvest_outlook, 'No upcoming harvests listed.')));
  if (d.buyer_sourcing_requirements) parts.push(block('Buyer sourcing requirements', table([{ h: 'Product', k: 'product_name' }, { h: 'Qty', r: 1, k: 'quantity' }, { h: 'Needed by', k: 'required_by' }, { h: 'Region', k: 'delivery_region' }], d.buyer_sourcing_requirements, 'None open.')));
  el.innerHTML = `<div class="topbar"><div><h1>Market insights</h1><p class="muted">Analytics level: <strong>${esc(title(d.level))}</strong>. Aggregated data hides any group smaller than 3 businesses.</p></div></div>
  ${d.locked.length ? `<div class="banner info" style="margin-bottom:16px">Unlock ${d.locked.map(title).join(', ')} with a <a href="#/subscription">higher plan</a>.</div>` : ''}
  <div class="grid g2">${parts.join('')}</div>`;
};

/* ------------------------------------------------------------------ referrals (section 21) */
PAGES['/referrals'] = async (el) => {
  const r = await GET('/referrals');
  const rules = r.program[S.me.user.role];
  const rw = (x) => (!x ? '—' : x.type === 'promotion_credits' ? `${x.value} promotion credit(s)` : x.type === 'account_credit' ? `${inr(x.value_paise)} marketplace credit` : x.type === 'discount_percent' ? `${x.value_bps / 100}% off a subscription` : `${x.value} free premium month(s)`);
  const link = `${location.origin}/#/register?role=${S.me.user.role}&ref=${r.code}`;
  el.innerHTML = `<div class="topbar"><div><h1>Refer & earn</h1><p class="muted">Invite other ${S.me.user.role}s to AgriConnect</p></div></div>
  <div class="grid g2"><div class="card"><div class="small muted">YOUR CODE</div><div style="font-size:28px;font-weight:700;letter-spacing:.06em">${esc(r.code)}</div>
    <div class="row" style="margin-top:10px"><input readonly value="${esc(link)}" id="lnk"><button class="btn" id="cp">Copy link</button></div></div>
  <div class="card"><h2>How it works</h2><ol class="small"><li>Share your code or link.</li><li>A new ${S.me.user.role} registers with it.</li><li>When they ${esc(title(rules?.eligibility || '').toLowerCase())}, you get <strong>${esc(rw(rules?.referrer_reward))}</strong> and they get <strong>${esc(rw(rules?.referee_reward))}</strong>.</li></ol></div></div>
  <div class="card" style="margin-top:16px"><h2>Your referrals</h2>${table([{ h: 'Business', k: 'referee' }, { h: 'Joined', f: (x) => date(x.created_at) }, { h: 'Status', f: (x) => pill(x.status) }, { h: 'Your reward', f: (x) => esc(JSON.parse(x.referrer_reward_json || 'null')?.granted || (x.rejection_reason ? title(x.rejection_reason) : '—')) }], r.referrals, 'No referrals yet.')}</div>`;
  $('#cp').onclick = () => { navigator.clipboard?.writeText(link); toast('Link copied'); };
};

/* ------------------------------------------------------------------ buyer: marketplace & basket */
let basket = [];
try { basket = JSON.parse(localStorage.getItem('ac_basket') || '[]'); } catch { basket = []; }
const saveBasket = () => { try { localStorage.setItem('ac_basket', JSON.stringify(basket)); } catch { /* */ } };

PAGES['/marketplace'] = async (el, q) => {
  const params = new URLSearchParams(Object.entries(q).filter(([, v]) => v));
  const [res, saved] = await Promise.all([GET(`/marketplace/search?${params}`), GET('/searches').catch(() => [])]);
  el.innerHTML = `<div class="topbar"><div><h1>Marketplace</h1><p class="muted">Fresh produce direct from farmers</p></div><a class="btn" href="#/basket">Basket (${basket.length})</a></div>
  <form class="card form cols" id="sf" style="margin-bottom:16px"><label>Search<input name="q" value="${esc(q.q)}" placeholder="e.g. oyster mushrooms"></label>
    <label>Category<select name="category_id">${categoryOpts(q.category_id, 'All categories')}</select></label><label>Region<select name="region">${regionOpts(q.region, 'All regions')}</select></label>
    <label>Availability<select name="availability">${opts([{ value: 'available', label: 'Available now' }, { value: 'upcoming', label: 'Upcoming harvest' }], q.availability, { blank: 'Any' })}</select></label>
    <div class="row" style="align-self:end"><button class="btn primary">Search</button><button class="btn" type="button" id="ss">Save search</button></div></form>
  ${saved.length ? `<div class="row small" style="margin-bottom:12px"><span class="muted">Saved:</span>${saved.map((s) => `<a class="pill" href="#/marketplace?${new URLSearchParams(JSON.parse(s.query_json))}">${esc(s.name)}</a>`).join('')}</div>` : ''}
  ${res.sponsored_content.length ? `<div class="grid g2" style="margin-bottom:16px">${res.sponsored_content.map(adCard).join('')}</div>` : ''}
  <div class="grid g3">${res.results.map((l) => `<div class="card" style="display:flex;flex-direction:column;gap:6px">
    ${l.sponsored ? `<div class="sponsored">${esc(l.promotion_label)} · Promoted</div>` : ''}
    <div class="row between"><h3 style="margin:0">${esc(l.product_name)}</h3>${l.availability === 'upcoming' ? '<span class="pill info">Upcoming</span>' : ''}</div>
    <div class="small muted">${esc(l.seller_name)}${l.seller_verified ? ' · ✓ Verified' : ''}${l.premium_badge ? ' · ★ Premium supplier' : ''} · ${esc(l.region || '')}</div>
    <div><strong class="num">${inr2(l.price_per_unit_paise)}</strong> / ${esc(l.unit)} · <span class="small">${l.quantity} ${esc(l.unit)} available</span></div>
    <div class="row" style="margin-top:auto"><button class="btn sm primary" data-order="${l.id}">Order</button><button class="btn sm" data-bask="${l.id}">Add to basket</button><button class="btn sm" data-enq="${l.id}">Enquire</button><button class="btn sm" data-save="${l.account_id}">Save supplier</button></div></div>`).join('') || '<p class="muted">No produce matches your search.</p>'}</div>`;
  const byId = Object.fromEntries(res.results.map((l) => [l.id, l]));
  $('#sf').onsubmit = (e) => { e.preventDefault(); location.hash = `#/marketplace?${new URLSearchParams(Object.entries(formData(e.target)))}`; };
  $('#ss').onclick = async () => { const name = prompt('Name this search'); if (!name) return; try { await POST('/searches', { name, query: formData($('#sf')) }); toast('Search saved'); route(); } catch (e) { handleError(e); } };
  el.querySelectorAll('[data-order]').forEach((b) => (b.onclick = () => orderFlow(byId[b.dataset.order])));
  el.querySelectorAll('[data-bask]').forEach((b) => (b.onclick = () => { const l = byId[b.dataset.bask]; basket.push({ listing_id: l.id, quantity: l.min_order_qty, name: l.product_name, seller: l.seller_name, unit: l.unit, price: l.price_per_unit_paise }); saveBasket(); toast('Added to basket'); route(); }));
  el.querySelectorAll('[data-save]').forEach((b) => (b.onclick = async () => { try { await POST('/suppliers/saved', { supplier_account_id: Number(b.dataset.save) }); toast('Supplier saved'); } catch (e) { handleError(e); } }));
  el.querySelectorAll('[data-enq]').forEach((b) => (b.onclick = () => modal(`<h2>Enquire</h2><form class="form" id="ef"><label>Message<textarea name="message" required style="font-family:inherit" placeholder="Quantity, frequency, delivery…"></textarea></label><button class="btn primary">Send</button></form>`, (m, close) => {
    $('#ef', m).onsubmit = async (e) => { e.preventDefault(); try { await POST(`/marketplace/listings/${b.dataset.enq}/enquire`, formData(e.target)); close(); toast('Enquiry sent'); } catch (err) { handleError(err); } };
  })));
};

function orderFlow(l) {
  modal(`<h2>Order ${esc(l.product_name)}</h2><p class="small muted">${esc(l.seller_name)} · ${inr2(l.price_per_unit_paise)}/${esc(l.unit)} · min ${l.min_order_qty} ${esc(l.unit)}</p>
  <form class="form" id="of"><div class="grid g2"><label>Quantity (${esc(l.unit)})<input name="quantity" type="number" step="0.1" min="${l.min_order_qty}" max="${l.quantity}" value="${l.min_order_qty}" required></label>
  <label>Delivery<select name="delivery_mode">${opts([{ value: 'buyer_pickup', label: 'I will pick up' }, { value: 'farmer_delivery', label: 'Farmer delivers' }, { value: 'platform_arranged', label: 'AgriConnect arranges transport' }, { value: 'third_party', label: 'Third-party transporter' }])}</select></label></div>
  <label>Order type<select name="order_type">${opts([{ value: 'standard', label: 'Standard' }, { value: 'bulk', label: 'Bulk order (Business+)' }, { value: 'recurring', label: 'Recurring (Business+)' }])}</select></label>
  <label>Delivery address<input name="delivery_address"></label><div id="oq" class="banner">Calculating charges…</div><button class="btn primary" id="place">Confirm order</button></form>`, (m, close) => {
    const f = $('#of', m);
    const quote = async () => {
      try {
        const q = await POST('/orders/quote', { ...formData(f), listing_id: l.id });
        $('#oq', m).innerHTML = `<div class="row between"><span>Produce</span><strong class="num">${inr2(q.subtotal_paise)}</strong></div>${q.buyer_fee_paise ? `<div class="row between"><span>Platform charges to you</span><strong class="num">${inr2(q.buyer_fee_paise)}</strong></div>` : ''}<div class="row between"><span>Total payable to seller & platform</span><strong class="num">${inr2(q.total_buyer_paise)}</strong></div><div class="small muted" style="margin-top:6px">${esc(q.charges_note)}. Payment for produce is settled directly with the farmer.</div>`;
      } catch (e) { $('#oq', m).textContent = e.message; }
    };
    f.oninput = quote; quote();
    f.onsubmit = async (e) => { e.preventDefault(); try { const o = await POST('/orders', { ...formData(f), listing_id: l.id }, { idem: true }); close(); toast(`Order ${o.order_number} placed`); } catch (err) { close(); handleError(err); } };
  });
}

PAGES['/basket'] = async (el) => {
  let q = null;
  if (basket.length) q = await POST('/orders/basket/quote', { items: basket.map(({ listing_id, quantity }) => ({ listing_id, quantity })), delivery_mode: 'platform_arranged' }).catch((e) => ({ error: e.message }));
  el.innerHTML = `<div class="topbar"><div><h1>Sourcing basket</h1><p class="muted">Source from several farmers in one go (multi-farmer procurement)</p></div></div>
  ${q?.upgrade_required ? `<div class="banner warn" style="margin-bottom:16px">Your basket has produce from ${q.suppliers} farmers. Multi-farmer sourcing is part of <a href="#/subscription">Buyer Pro</a> — you can still order from each farmer individually.</div>` : ''}
  ${q?.error ? `<div class="banner bad">${esc(q.error)}</div>` : ''}
  <div class="card">${basket.length ? `<div class="table-wrap"><table><tr><th>Product</th><th>Farmer</th><th class="r">Qty</th><th class="r">Value</th><th></th></tr>${basket.map((b, i) => `<tr><td>${esc(b.name)}</td><td>${esc(b.seller)}</td><td class="r"><input type="number" min="0.1" step="0.1" value="${b.quantity}" data-q="${i}" style="width:90px"></td><td class="r">${inr2(Math.round(b.quantity * b.price))}</td><td><button class="btn sm" data-rm="${i}">Remove</button></td></tr>`).join('')}</table></div>
    ${q?.lines ? `<p class="row between"><span>Total incl. platform charges (${q.suppliers} supplier${q.suppliers > 1 ? 's' : ''})</span><strong>${inr2(q.total_buyer_paise)}</strong></p>` : ''}
    <div class="row"><select id="dm" style="max-width:280px">${opts([{ value: 'platform_arranged', label: 'AgriConnect arranges transport' }, { value: 'buyer_pickup', label: 'I will pick up' }, { value: 'farmer_delivery', label: 'Farmers deliver' }])}</select><input id="addr" placeholder="Delivery address" style="max-width:320px"><button class="btn primary" id="place">Place all orders</button></div>` : '<p class="muted">Your basket is empty. Add produce from the <a href="#/marketplace">marketplace</a>.</p>'}</div>`;
  el.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => { basket.splice(Number(b.dataset.rm), 1); saveBasket(); route(); }));
  el.querySelectorAll('[data-q]').forEach((i) => (i.onchange = () => { basket[Number(i.dataset.q)].quantity = Number(i.value); saveBasket(); route(); }));
  $('#place')?.addEventListener('click', async () => {
    try { const r = await POST('/orders/basket', { items: basket.map(({ listing_id, quantity }) => ({ listing_id, quantity })), delivery_mode: $('#dm').value, delivery_address: $('#addr').value }, { idem: true }); basket = []; saveBasket(); toast(`${r.orders.length} orders placed (${r.basket_ref})`); location.hash = '#/orders'; } catch (e) { handleError(e); }
  });
};

/* ------------------------------------------------------------------ buyer: sourcing requests (section 13) */
PAGES['/sourcing'] = async (el) => {
  const list = await GET('/procurement');
  el.innerHTML = `<div class="topbar"><div><h1>Sourcing requests</h1><p class="muted">Post a requirement to the demand board, or let AgriConnect source it for you</p></div><button class="btn primary" id="new">New requirement</button></div>
  <div class="stack">${list.map((r) => `<div class="card"><div class="row between"><div><strong>${esc(r.reference)}</strong> · ${esc(r.product_name)} — ${r.quantity} ${esc(r.unit)} <span class="small muted">${r.required_by ? `by ${esc(r.required_by)}` : ''} ${r.delivery_location ? `→ ${esc(r.delivery_location)}` : ''}</span></div><div class="row"><span class="pill">${r.sourcing_mode === 'assisted' ? 'Platform-assisted' : 'Self-sourcing'}</span>${pill(r.status)}</div></div>
    ${r.lines.length ? `<div style="margin-top:10px">${table([{ h: 'Supplier', k: 'supplier_name' }, { h: 'Qty', r: 1, k: 'quantity' }, { h: 'Price', r: 1, f: (x) => inr2(x.unit_price_paise) }, { h: 'Status', f: (x) => pill(x.status) }], r.lines)}<p class="small">Confirmed ${r.confirmed_quantity} ${esc(r.unit)} · produce value ${inr(r.proposal_value_paise)}${r.fee_waived ? ' · service fee included in your plan' : ''}</p></div>` : ''}
    ${r.proposal_notes ? `<p class="small">${esc(r.proposal_notes)}</p>` : ''}
    ${r.fee ? `<p class="small">Service fee: <strong>${inr2(r.fee.fee_paise)}</strong> ${pill(r.fee.status)} ${r.fee.status === 'invoiced' ? `<button class="btn sm primary" data-pay="${r.fee.invoice_id}">Pay fee</button>` : ''}</p>` : ''}
    <div class="row">${r.status === 'proposal_sent' ? `<button class="btn primary sm" data-ok="${r.id}">Approve proposal & create orders</button>` : ''}${['proposal_sent', 'submitted', 'open', 'under_review', 'sourcing'].includes(r.status) ? `<button class="btn sm" data-no="${r.id}">${r.status === 'open' ? 'Close' : 'Cancel'}</button>` : ''}</div></div>`).join('') || '<div class="card"><p class="muted">No requirements yet.</p></div>'}</div>`;
  el.querySelectorAll('[data-ok]').forEach((b) => (b.onclick = async () => { try { await POST(`/procurement/${b.dataset.ok}/approve`, {}); toast('Orders created'); route(); } catch (e) { handleError(e); } }));
  el.querySelectorAll('[data-no]').forEach((b) => (b.onclick = async () => { await POST(`/procurement/${b.dataset.no}/decline`); route(); }));
  $('#new').onclick = () => modal(`<h2>New sourcing requirement</h2><form class="form" id="rf"><div class="grid g2"><label>Product<input name="product_name" required></label><label>Category<select name="category_id">${categoryOpts()}</select></label>
    <label>Quantity<input name="quantity" type="number" step="0.1" required></label><label>Unit<select name="unit">${opts(['kg', 'quintal', 'tonne', 'box'].map((u) => ({ value: u, label: u })))}</select></label>
    <label>Required by<input name="required_by" type="date"></label><label>Target price / unit (₹)<input name="target_price_paise" data-paise type="number" step="0.01"></label>
    <label>Delivery location<input name="delivery_location"></label><label>Delivery region<select name="delivery_region">${regionOpts(S.me.account.region)}</select></label></div>
    <label>Notes<input name="notes"></label>
    <div><label style="margin-bottom:6px">How should we source it?</label><label class="check"><input type="radio" name="sourcing_mode" value="self" checked style="width:auto"> Self-sourcing — post to the buyer demand board (Business+)</label><label class="check"><input type="radio" name="sourcing_mode" value="assisted" style="width:auto"> Platform-assisted — AgriConnect finds & aggregates supply from multiple farmers</label></div>
    <div id="fee" class="small muted"></div><button class="btn primary">Submit</button></form>`, (m, close) => {
    const f = $('#rf', m);
    const est = async () => { const b = formData(f); const mode = f.querySelector('[name=sourcing_mode]:checked').value; if (mode !== 'assisted') { $('#fee', m).textContent = ''; return; } const e = await POST('/procurement/estimate', b).catch(() => null); if (e) $('#fee', m).innerHTML = e.waived ? 'Assisted sourcing is included in your plan.' : `Estimated service fee ${inr2(e.estimated_fee_paise)} + GST (${esc(e.fee_model.model.replace(/_/g, ' '))}; ${esc(e.basis)}). Charged only on completed orders.`; };
    f.oninput = est;
    f.onsubmit = async (e) => { e.preventDefault(); const b = formData(f); b.sourcing_mode = f.querySelector('[name=sourcing_mode]:checked').value; try { await POST('/procurement', b); close(); toast('Requirement submitted'); route(); } catch (err) { close(); handleError(err); } };
  });
};

PAGES['/suppliers'] = async (el) => {
  const saved = await GET('/suppliers/saved');
  const sub = await GET('/subscription');
  const m = sub.usage.metrics.find((x) => x.key === 'max_saved_suppliers');
  el.innerHTML = `<div class="topbar"><div><h1>Suppliers</h1><p class="muted">${m ? `${m.used} / ${limitTxt(m.limit)} saved suppliers` : ''}</p></div><button class="btn primary" id="cmp">Compare selected</button></div>
  <div class="card">${table([{ h: '', f: (s) => `<input type="checkbox" data-s="${s.id}" style="width:auto">` }, { h: 'Supplier', f: (s) => `${esc(s.name)} ${s.verified ? '<span class="pill good">Verified</span>' : ''}` }, { h: 'Region', k: 'region' }, { h: 'Saved', f: (s) => date(s.created_at) }, { h: '', f: (s) => `<button class="btn sm" data-rm="${s.id}">Remove</button>` }], saved, 'Save suppliers from the marketplace.')}</div><div id="cmpres" style="margin-top:16px"></div>`;
  el.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = async () => { await POST(`/suppliers/saved/${b.dataset.rm}/remove`); route(); }));
  $('#cmp').onclick = async () => {
    const ids = [...el.querySelectorAll('[data-s]:checked')].map((c) => Number(c.dataset.s));
    if (ids.length < 2) return toast('Select at least two suppliers', true);
    try {
      const r = await POST('/suppliers/compare', { supplier_ids: ids });
      $('#cmpres').innerHTML = `<div class="card"><h2>Comparison</h2>${table([{ h: 'Supplier', k: 'name' }, { h: 'Active listings', r: 1, k: 'active_listings' }, { h: 'Lowest price', r: 1, f: (x) => inr2(x.min_price) }, { h: 'Avg price', r: 1, f: (x) => inr2(x.avg_price) }, { h: 'Orders', r: 1, k: 'orders' }, { h: 'Fulfilment', r: 1, f: (x) => (x.fulfilment_rate == null ? '—' : `${x.fulfilment_rate}%`) }, { h: 'Avg days', r: 1, f: (x) => x.avg_fulfilment_days ?? '—' }], r)}</div>`;
    } catch (e) { handleError(e); }
  };
};

/* ------------------------------------------------------------------ advertiser */
PAGES['/ads'] = async (el) => {
  const ads = await GET('/ads/mine');
  el.innerHTML = `<div class="topbar"><div><h1>Sponsored content</h1><p class="muted">Reach farmers and buyers with agriculture-related products and services. All ads are reviewed and labelled “Sponsored”.</p></div><button class="btn primary" id="new">Create ad</button></div>
  <div class="card">${table([{ h: 'Ad', f: (a) => `<strong>${esc(a.title)}</strong><div class="small muted">${esc(title(a.ad_category))} · ${esc(a.placement)} · ${esc(a.target_audience)}</div>` }, { h: 'Runs', f: (a) => `${date(a.start_at)} – ${date(a.end_at)}` }, { h: 'Price', r: 1, f: (a) => inr(a.price_paise) },
    { h: 'Impr.', r: 1, k: 'impressions' }, { h: 'Clicks', r: 1, k: 'clicks' }, { h: 'Status', f: (a) => pill(a.status) }, { h: '', f: (a) => (['draft', 'rejected'].includes(a.status) ? `<button class="btn sm primary" data-sub="${a.id}">Submit for review</button>` : a.status === 'approved' && a.invoice_id ? `<button class="btn sm primary" data-pay="${a.invoice_id}">Pay to schedule</button>` : '') + (a.review_notes ? `<div class="small muted">${esc(a.review_notes)}</div>` : '') }], ads, 'No ads yet.')}</div>`;
  el.querySelectorAll('[data-sub]').forEach((b) => (b.onclick = async () => { try { await POST(`/ads/${b.dataset.sub}/submit`); toast('Submitted for review'); route(); } catch (e) { handleError(e); } }));
  $('#new').onclick = () => {
    const cats = ['agricultural_equipment', 'seeds', 'growing_supplies', 'packaging', 'cold_storage', 'transport', 'farming_technology', 'hydroponic_equipment', 'greenhouse_equipment', 'agricultural_finance', 'insurance'];
    const today = new Date().toISOString().slice(0, 10);
    modal(`<h2>Create ad</h2><form class="form" id="af"><label>Headline<input name="title" maxlength="80" required></label><label>Text<input name="body" maxlength="200" required></label>
      <div class="grid g2"><label>Category<select name="ad_category">${opts(cats.map((c) => ({ value: c, label: title(c) })))}</select></label><label>Placement<select name="placement"><option value="marketplace">Marketplace</option><option value="dashboard">Dashboard</option></select></label>
      <label>Audience<select name="target_audience"><option value="all">Farmers & buyers</option><option value="farmer">Farmers</option><option value="buyer">Buyers</option></select></label><label>Region<select name="target_region">${regionOpts('', 'All regions')}</select></label>
      <label>Start<input name="start_at" type="date" value="${today}" required></label><label>End<input name="end_at" type="date" required></label>
      <label>Button label<input name="cta_label" value="Learn more"></label><label>Link (https://)<input name="cta_url" type="url"></label></div>
      <div id="ap" class="small muted"></div><button class="btn primary">Save draft</button></form>`, (m, close) => {
      const f = $('#af', m);
      f.oninput = async () => { const b = formData(f); if (!b.end_at) return; const p = await POST('/ads/price', b).catch(() => null); if (p) $('#ap', m).textContent = `${p.days} day(s) × ${inr(p.daily_rate_paise)} = ${inr(p.price_paise)} + GST`; };
      f.onsubmit = async (e) => { e.preventDefault(); try { await POST('/ads', formData(f)); close(); route(); } catch (err) { handleError(err); } };
    });
  };
};
