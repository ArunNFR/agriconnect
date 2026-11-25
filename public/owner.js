'use strict';
/* Platform Owner console + Administrator operations. */
const pct = (v) => (v == null ? '—' : `${v}%`);
const isoDay = (d) => new Date(d).toISOString().slice(0, 10);
const CAT_LABEL = { farmer_subscription: 'Farmer subscriptions', buyer_subscription: 'Buyer subscriptions', enterprise_subscription: 'Enterprise subscriptions', transaction_commission: 'Transaction commissions', featured_listing: 'Featured listings', promoted_inventory: 'Promoted inventory', procurement_service: 'Procurement services', logistics_commission: 'Logistics commissions', advertising: 'Advertising', other: 'Other platform revenue' };

function rangeForm(q, extra = '') {
  const to = q.to || isoDay(Date.now() + 86400000);
  const from = q.from || isoDay(Date.now() - 30 * 86400000);
  return `<form class="card form cols" id="rf" style="margin-bottom:16px"><label>From<input type="date" name="from" value="${esc(from)}"></label><label>To<input type="date" name="to" value="${esc(to)}"></label>${extra}<div style="align-self:end"><button class="btn primary">Apply</button></div></form>`;
}
function bindRange(base) { $('#rf').onsubmit = (e) => { e.preventDefault(); location.hash = `${base}?${new URLSearchParams(Object.entries(formData(e.target)))}`; }; }

/* ------------------------------------------------------------------ overview (section 16) */
PAGES['/owner'] = async (el, q) => {
  const o = await GET(`/owner/overview?${new URLSearchParams(q)}`);
  const u = o.users; const s = o.subscriptions; const r = o.revenue; const m = o.marketplace; const h = o.health;
  el.innerHTML = `<div class="topbar"><div><h1>Platform overview</h1><p class="muted">Commercial health of AgriConnect · ${date(o.period.from)} – ${date(o.period.to)}</p></div><a class="btn" href="#/owner/revenue">Revenue dashboard</a></div>
  ${rangeForm(q)}
  <div class="grid g4">${stat('Total platform revenue', inr(r.total_paise), 'net of refunds, this period')}${stat('MRR', inr(r.mrr_paise), `ARR ${inr(r.arr_paise)}`)}${stat('GMV', inr(m.gmv_paise), `${m.completed_transactions} completed transactions`)}${stat('Avg transaction', inr(m.avg_transaction_paise))}</div>
  <div class="grid g4" style="margin-top:16px">${stat('Registered users', u.total_registered_users, `${u.total_farmers} farmers · ${u.total_buyers} buyers`)}${stat('Active farmers', u.active_farmers, `${u.paying_farmers} paying`)}${stat('Active buyers', u.active_buyers, `${u.paying_buyers} paying`)}${stat('Free accounts', u.free_accounts)}</div>
  <div class="grid g4" style="margin-top:16px">${stat('Active subscriptions', s.active, `${s.active_paid} paid`)}${stat('Trials', s.trial)}${stat('Cancelled / expired', `${s.cancelled_in_period} / ${s.expired_in_period}`, `${s.suspended} suspended now`)}${stat('Conversion rate', pct(h.subscription_conversion_rate), 'paying ÷ all accounts')}</div>
  <div class="grid g4" style="margin-top:16px">${stat('User churn', pct(h.user_churn_rate))}${stat('Revenue churn', pct(h.revenue_churn_rate))}${stat('Marketplace growth', pct(m.growth_rate), `${m.new_accounts} new accounts`)}${stat('Order fulfilment', pct(m.fulfilment_rate))}</div>
  <div class="card" style="margin-top:16px"><h2>Revenue by stream</h2>${hbars(Object.entries(r.by_category).map(([k, v]) => ({ label: CAT_LABEL[k], amount: v })).sort((a, b) => b.amount - a.amount))}</div>`;
  bindRange('#/owner');
};

/* ------------------------------------------------------------------ revenue dashboard (section 17) */
PAGES['/owner/revenue'] = async (el, q) => {
  const plans = await GET('/owner/plans');
  const qp = new URLSearchParams(Object.entries({ granularity: 'day', ...q }).filter(([, v]) => v));
  const d = await GET(`/owner/revenue?${qp}`);
  const extra = `<label>Granularity<select name="granularity">${opts(['day', 'week', 'month', 'year'].map((g) => ({ value: g, label: title(g) })), q.granularity || 'day')}</select></label>
    <label>Revenue category<select name="category">${opts(Object.entries(CAT_LABEL).map(([value, label]) => ({ value, label })), q.category, { blank: 'All' })}</select></label>
    <label>Region<select name="region">${regionOpts(q.region, 'All')}</select></label>
    <label>Subscription plan<select name="plan_id">${opts(plans.map((p) => ({ value: p.id, label: p.name })), q.plan_id, { blank: 'All' })}</select></label>
    <label>User type<select name="user_type">${opts([{ value: 'farmer', label: 'Farmers' }, { value: 'buyer', label: 'Buyers' }, { value: 'advertiser', label: 'Advertisers' }], q.user_type, { blank: 'All' })}</select></label>
    <label>Transaction type<select name="transaction_type">${opts([{ value: 'invoice', label: 'Invoiced (paid)' }, { value: 'transaction_commission', label: 'Order commission' }, { value: 'logistics_commission', label: 'Logistics' }, { value: 'refund', label: 'Refund reversal' }, { value: 'manual_adjustment', label: 'Manual adjustment' }], q.transaction_type, { blank: 'All' })}</select></label>`;
  const t = d.totals;
  el.innerHTML = `<div class="topbar"><div><h1>Revenue</h1><p class="muted">${date(d.period.from)} – ${date(d.period.to)}</p></div>
    <div class="row"><button class="btn" id="x1">Export revenue ledger</button><button class="btn primary" id="x2">Export financial report</button></div></div>
  ${rangeForm(q, extra)}
  <div class="grid g4">${stat('Net revenue', inr(t.net_paise), t.growth_rate == null ? 'no prior period' : `${t.growth_rate > 0 ? '▲' : '▼'} ${Math.abs(t.growth_rate)}% vs previous period`)}${stat('MRR', inr(d.recurring.mrr_paise), `${d.recurring.paying_subscriptions} paying subscriptions`)}${stat('ARR', inr(d.recurring.arr_paise))}${stat('Daily average', inr(t.daily_average_paise))}</div>
  <div class="grid g2" style="margin-top:16px">${stat('Refunds', inr(d.refunds.amount_paise), `${d.refunds.count} processed`)}${stat('Failed payments', d.failed_payments.count, `${inr(d.failed_payments.amount_paise)} attempted`)}</div>
  <div class="card" style="margin-top:16px"><h2>Revenue over time by stream</h2><div id="ts"></div></div>
  <div class="grid g2" style="margin-top:16px">
    <div class="card"><h2>By category</h2>${table([{ h: 'Category', f: (c) => esc(CAT_LABEL[c.category]) }, { h: 'Gross', r: 1, f: (c) => inr(c.gross) }, { h: 'Reversals', r: 1, f: (c) => inr(c.reversals) }, { h: 'Net', r: 1, f: (c) => `<strong>${inr(c.net)}</strong>` }, { h: 'GST', r: 1, f: (c) => inr(c.tax) }], t.by_category, 'No revenue in this period.')}</div>
    <div class="card"><h2>By subscription plan</h2>${hbars(d.by_plan.map((p) => ({ label: p.plan, amount: p.amount })))}</div>
    <div class="card"><h2>By region</h2>${hbars(d.by_region.map((p) => ({ label: S.config.regions.find((r) => r.code === p.region)?.name || p.region, amount: p.amount })))}</div>
    <div class="card"><h2>Top customers</h2>${table([{ h: 'Customer', f: (c) => `${esc(c.name)} <span class="small muted">${esc(c.type)}</span>` }, { h: 'Revenue', r: 1, f: (c) => inr(c.amount) }], d.by_customer.slice(0, 10))}</div>
  </div>
  <div class="card" style="margin-top:16px"><h2>Forecast</h2><p class="small muted">${esc(d.forecast.method)}</p>${table([{ h: 'Month', k: 'month' }, { h: 'Revenue', r: 1, f: (x) => inr(x.s ?? x.projected_paise) }, { h: '', f: (x) => (x.projected_paise != null ? '<span class="pill info">Projected</span>' : '<span class="pill">Actual</span>') }], [...d.forecast.history.map((h) => ({ month: h.m, s: h.s })), ...d.forecast.projection])}</div>
  <div class="card" style="margin-top:16px"><h2>Manual adjustment</h2><p class="small muted">Corrections are posted as new, audited adjustment entries; existing revenue records are never edited.</p>
    <form class="form cols" id="adj"><label>Category<select name="category">${opts(Object.entries(CAT_LABEL).map(([value, label]) => ({ value, label })))}</select></label><label>Amount (₹, negative to reduce)<input name="amount_paise" data-paise type="number" step="0.01" required></label><label>Reason<input name="reason" required></label><div style="align-self:end"><button class="btn">Post adjustment</button></div></form></div>`;
  const series = STREAMS;
  const rows = d.series.map((b) => ({ label: b.bucket, short: d.period.granularity === 'day' ? b.bucket.slice(5) : b.bucket, values: Object.fromEntries(series.map((s) => [s.key, s.cats.reduce((a, c) => a + (b[c] || 0), 0)])) }));
  stackedBars($('#ts'), rows, series);
  bindRange('#/owner/revenue');
  const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v));
  $('#x1').onclick = () => downloadCsv(`/owner/export/revenue.csv?${qs}`, 'agriconnect-revenue.csv');
  $('#x2').onclick = () => downloadCsv(`/owner/export/financial-report.csv?${qs}`, 'agriconnect-financial-report.csv');
  $('#adj').onsubmit = async (e) => { e.preventDefault(); if (!confirm('Post this audited adjustment?')) return; try { await POST('/owner/revenue/adjustments', formData(e.target)); toast('Adjustment posted'); route(); } catch (err) { handleError(err); } };
};

/* ------------------------------------------------------------------ subscription analytics (section 18) */
PAGES['/owner/subscriptions'] = async (el, q) => {
  const d = await GET(`/owner/subscription-analytics?${new URLSearchParams(q)}`);
  const t = d.totals; const i = d.insights;
  const top = (list, fmt) => (list.length ? list.map((x) => `<div class="row between small"><span>${esc(x.plan)} <span class="muted">${esc(x.audience)}</span></span><strong>${fmt(x.value)}</strong></div>`).join('') : '<p class="muted small">Not enough data.</p>');
  el.innerHTML = `<div class="topbar"><div><h1>Subscription analytics</h1></div><a class="btn" href="#/owner/plans">Manage plans</a></div>${rangeForm(q)}
  <div class="grid g4">${stat('Active subscriptions', t.active_subscriptions, `${t.paying_subscriptions} paying`)}${stat('New paid', t.new_paid_subscriptions)}${stat('MRR', inr(t.mrr_paise), `ARPA ${inr(t.arpa_paise)}`)}${stat('Conversion', pct(t.conversion_rate))}</div>
  <div class="grid g4" style="margin-top:16px">${stat('Upgrades', t.upgrades)}${stat('Downgrades', t.downgrades, `${t.downgrades_scheduled} scheduled`)}${stat('Cancellations', t.cancellations, `${t.cancellations_scheduled} scheduled`)}${stat('Renewals', t.renewals)}</div>
  <div class="grid g4" style="margin-top:16px">${stat('Failed payments', t.failed_payments)}${stat('Expired / suspended', `${t.expired} / ${t.suspended}`)}${stat('Trial conversion', pct(t.trial_conversion_rate), `${t.trial_conversions} of ${t.trials_started} trials`)}${stat('Churn', `${pct(t.monthly_churn_rate)} / mo`, `${pct(t.annual_churn_rate)} annualised`)}</div>
  <div class="grid g4" style="margin-top:16px"><div class="card"><h3>Most popular</h3>${top(i.most_popular_plans, (v) => v)}</div><div class="card"><h3>Highest revenue</h3>${top(i.highest_revenue_plans, inr)}</div><div class="card"><h3>Highest churn</h3>${top(i.highest_churn_plans, pct)}</div><div class="card"><h3>Highest trial conversion</h3>${top(i.highest_conversion_plans, pct)}</div></div>
  <div class="card" style="margin-top:16px"><h2>By plan</h2>${table([{ h: 'Plan', f: (p) => `${esc(p.name)} <span class="small muted">${esc(p.audience)}</span>` }, { h: 'Subscribers', r: 1, k: 'subscribers' }, { h: 'New', r: 1, k: 'new_subscriptions' }, { h: 'Revenue', r: 1, f: (p) => inr(p.revenue_paise) }, { h: 'Churned', r: 1, k: 'churned' }, { h: 'Churn', r: 1, f: (p) => pct(p.churn_rate) }, { h: 'Trials', r: 1, k: 'trials' }, { h: 'Trial conv.', r: 1, f: (p) => pct(p.trial_conversion_rate) }], d.by_plan)}</div>
  <div class="grid g3" style="margin-top:16px">
    <div class="card"><h2>Approaching limits</h2>${table([{ h: 'Account', f: (a) => `${esc(a.name)}<div class="small muted">${esc(a.plan)}</div>` }, { h: 'Usage', f: (a) => a.metrics.map((m) => `<div class="small">${esc(title(m.key.replace('max_', '')))}: ${m.used}/${m.limit}</div>`).join('') }], i.approaching_limits, 'No accounts near their limits.')}</div>
    <div class="card"><h2>Likely to upgrade</h2>${table([{ h: 'Account', f: (a) => `${esc(a.name)}<div class="small muted">${esc((a.features || '').replace(/_/g, ' '))}</div>` }, { h: 'Upgrade prompts', r: 1, k: 'prompts' }, { h: '', f: (a) => (a.near_limit ? '<span class="pill warn">Near limit</span>' : '') }], i.likely_to_upgrade, 'No upgrade signals in the last 30 days.')}</div>
    <div class="card"><h2>Failed payments</h2>${table([{ h: 'Account', f: (a) => `${esc(a.name)}<div class="small muted">${esc(a.plan)}</div>` }, { h: 'Status', f: (a) => pill(a.subscription_status) }, { h: 'Outstanding', r: 1, f: (a) => inr(a.outstanding_paise) }], i.failed_payment_accounts, 'No accounts with failed payments.')}</div>
  </div>`;
  bindRange('#/owner/subscriptions');
};

PAGES['/owner/intelligence'] = async (el) => {
  const d = await GET('/owner/intelligence');
  el.innerHTML = `<div class="topbar"><div><h1>Market intelligence</h1><p class="muted">Aggregated marketplace data — groups smaller than ${d.min_group_size} businesses are suppressed</p></div></div>
  <div class="grid g2"><div class="card"><h2>Demand vs supply by category</h2>${table([{ h: 'Category', k: 'category' }, { h: 'Searches', r: 1, f: (r) => r.searches ?? 0 }, { h: 'Demand', r: 1, k: 'demand_qty' }, { h: 'Available', r: 1, f: (r) => r.available_qty ?? 0 }, { h: 'Signal', f: (r) => `<span class="pill ${r.signal === 'shortage' ? 'bad' : r.signal === 'high_demand' ? 'warn' : ''}">${esc(title(r.signal))}</span>` }], d.demand_by_category)}</div>
  <div class="card"><h2>Regional activity</h2>${table([{ h: 'Region', k: 'region' }, { h: 'Buyers', r: 1, k: 'active_buyers' }, { h: 'Orders', r: 1, k: 'orders' }, { h: 'Value', r: 1, f: (r) => inr(r.value_paise) }], d.regional_activity)}</div>
  <div class="card"><h2>Supply & prices</h2>${table([{ h: 'Category', k: 'category' }, { h: 'Region', k: 'region' }, { h: 'Qty', r: 1, k: 'qty' }, { h: 'Suppliers', r: 1, k: 'suppliers' }, { h: 'Avg price', r: 1, f: (r) => inr2(r.avg_price_paise) }], d.supply_availability)}</div>
  <div class="card"><h2>Price trends</h2>${table([{ h: 'Category', k: 'category' }, { h: 'Week', k: 'week' }, { h: 'Avg price', r: 1, f: (r) => inr2(r.avg_price_paise) }], d.price_trends.slice(-25))}</div></div>`;
};

/* ------------------------------------------------------------------ plan management (section 19) */
PAGES['/owner/plans'] = async (el, q) => {
  const audience = q.audience || 'farmer';
  const plans = (await GET('/owner/plans')).filter((p) => p.audience === audience);
  el.innerHTML = `<div class="topbar"><div><h1>Subscription plans</h1><p class="muted">Prices, limits, entitlements, trials and commissions are all configured here — no code changes needed.</p></div>
    <div class="row"><div class="seg" id="aud"><button data-a="farmer" class="${audience === 'farmer' ? 'on' : ''}">Farmer plans</button><button data-a="buyer" class="${audience === 'buyer' ? 'on' : ''}">Buyer plans</button></div><button class="btn primary" id="new">Create plan</button></div></div>
  <div class="card">${table([{ h: 'Plan', f: (p) => `<strong>${esc(p.name)}</strong> ${p.is_default ? '<span class="pill">Default</span>' : ''}<div class="small muted">${esc(p.code)} · tier ${p.tier_rank} · v${p.version}</div>` },
    { h: 'Pricing', f: (p) => (p.pricing_model === 'free' ? 'Free' : p.pricing_model === 'custom' ? 'Custom' : p.prices.filter((x) => x.status === 'active').map((x) => `${inr(x.price_paise)}/${x.billing_frequency}${x.effective_price_paise !== x.price_paise ? ` <span class="pill warn">promo ${inr(x.effective_price_paise)}</span>` : ''}`).join('<br>')) },
    { h: 'Trial', r: 1, f: (p) => (p.trial_days ? `${p.trial_days}d` : '—') }, { h: 'Commission', r: 1, f: (p) => (p.commission_bps != null ? `${p.commission_bps / 100}%` : '—') },
    { h: 'Subscribers', r: 1, f: (p) => p.stats.subscribers }, { h: 'MRR', r: 1, f: (p) => inr(p.stats.mrr_paise) }, { h: 'Status', f: (p) => `${pill(p.status)} ${p.visibility === 'hidden' ? '<span class="pill">Hidden</span>' : ''}` },
    { h: '', f: (p) => `<button class="btn sm" data-edit="${p.id}">Edit</button> ${p.status === 'draft' ? `<button class="btn sm primary" data-pub="${p.id}">Publish</button>` : p.status === 'active' ? `<button class="btn sm" data-off="${p.id}">Deactivate</button>` : `<button class="btn sm" data-on="${p.id}">Activate</button>`} <button class="btn sm danger" data-del="${p.id}">Delete</button>` }], plans)}</div>`;
  $('#aud').onclick = (e) => { const b = e.target.closest('[data-a]'); if (b) location.hash = `#/owner/plans?audience=${b.dataset.a}`; };
  $('#new').onclick = () => planEditor(null, audience);
  const act = async (fn, msg) => { try { await fn(); toast(msg); route(); } catch (e) { handleError(e); } };
  el.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = async () => planEditor(await GET(`/owner/plans/${b.dataset.edit}`), audience)));
  el.querySelectorAll('[data-pub]').forEach((b) => (b.onclick = () => act(() => POST(`/owner/plans/${b.dataset.pub}/publish`), 'Plan published — now visible to users')));
  el.querySelectorAll('[data-on]').forEach((b) => (b.onclick = () => act(() => POST(`/owner/plans/${b.dataset.on}/status`, { status: 'active' }), 'Plan activated')));
  el.querySelectorAll('[data-off]').forEach((b) => (b.onclick = () => act(() => POST(`/owner/plans/${b.dataset.off}/status`, { status: 'inactive' }), 'Plan deactivated — existing subscribers keep it')));
  el.querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => { if (confirm('Delete this plan? Plans with subscription history are archived instead.')) act(async () => { const r = await POST(`/owner/plans/${b.dataset.del}/delete`); if (r.archived) toast('Plan had history — archived instead of deleted'); }, 'Done'); }));
};

async function planEditor(p, audience) {
  const defs = (await GET('/owner/entitlement-definitions')).filter((d) => d.audience === 'both' || d.audience === (p?.audience || audience));
  const price = (f) => p?.prices.find((x) => x.billing_frequency === f && x.status === 'active');
  const entInput = (d) => {
    const v = p ? p.entitlements[d.key] : d.value_type === 'boolean' ? false : d.value_type === 'limit' ? Number(d.default_value) : d.default_value;
    if (d.value_type === 'boolean') return `<label class="check"><input type="checkbox" data-ent="${d.key}" ${v ? 'checked' : ''}> ${esc(d.label)}</label>`;
    if (d.value_type === 'level') return `<label>${esc(d.label)}<select data-ent="${d.key}">${opts(d.levels.map((l) => ({ value: l, label: title(l) })), v)}</select></label>`;
    return `<label>${esc(d.label)} <span class="muted">(−1 = unlimited)</span><input type="number" data-ent="${d.key}" value="${v}"></label>`;
  };
  modal(`<h2>${p ? `Edit ${esc(p.name)}` : 'Create plan'}</h2><form class="form" id="pe">
    <div class="grid g2"><label>Plan name<input name="name" value="${esc(p?.name)}" required></label><label>Code<input name="code" value="${esc(p?.code)}" ${p ? 'disabled' : 'required pattern="[a-z0-9_]+"'} placeholder="farmer_seasonal"></label>
    <label>Pricing model<select name="pricing_model">${opts([{ value: 'free', label: 'Free' }, { value: 'fixed', label: 'Fixed price' }, { value: 'custom', label: 'Enterprise / custom' }], p?.pricing_model || 'fixed')}</select></label>
    <label>Tier rank (upgrade order)<input name="tier_rank" type="number" value="${p?.tier_rank ?? 1}"></label>
    <label>Trial period (days)<input name="trial_days" type="number" min="0" value="${p?.trial_days ?? 0}"></label>
    <label>Commission % (seller fallback)<input name="commission_pct" type="number" step="0.01" value="${p?.commission_bps != null ? p.commission_bps / 100 : ''}"></label>
    <label>Visibility<select name="visibility">${opts([{ value: 'public', label: 'Public' }, { value: 'hidden', label: 'Hidden (invite only)' }], p?.visibility)}</select></label>
    <label class="check" style="align-self:end"><input type="checkbox" name="discount_eligible" ${p?.discount_eligible === 0 ? '' : 'checked'}> Discount codes allowed</label></div>
    <label>Description<input name="description" value="${esc(p?.description)}"></label><label>Target customers<input name="target_customers" value="${esc(p?.target_customers)}"></label>
    <h3>Prices (₹ per billing cycle, excl. GST)</h3><div class="grid g3">${['monthly', 'quarterly', 'annual'].map((f) => `<div><label>${title(f)}<input type="number" step="0.01" min="0" data-price="${f}" value="${price(f) ? price(f).price_paise / 100 : ''}"></label><label>Promo price<input type="number" step="0.01" min="0" data-promo="${f}" value="${price(f)?.promo_price_paise != null ? price(f).promo_price_paise / 100 : ''}"></label><label>Promo until<input type="date" data-promountil="${f}" value="${esc(price(f)?.promo_valid_until?.slice(0, 10))}"></label></div>`).join('')}</div>
    <label>Promo label<input name="promo_label" value="${esc(p?.prices?.find((x) => x.promo_label)?.promo_label)}" placeholder="Launch offer"></label>
    <h3>Usage limits & entitlements</h3><div class="grid g3">${defs.map(entInput).join('')}</div>
    <label>Upgrade paths (plan codes, comma-separated; blank = any higher tier)<input name="upgrade_to" value="${esc((p?.upgrade_to || []).join(', '))}"></label>
    <label>Downgrade paths (blank = any lower tier)<input name="downgrade_to" value="${esc((p?.downgrade_to || []).join(', '))}"></label>
    <label>Features shown to users (one per line)<textarea name="features" style="font-family:inherit">${esc((p?.features || []).map((f) => f.label).join('\n'))}</textarea></label>
    ${p && p.status !== 'draft' ? `<div class="banner info"><strong>Apply changes to existing subscribers:</strong>
      <label class="check"><input type="radio" name="change_scope" value="new_only" checked style="width:auto"> New subscribers only</label>
      <label class="check"><input type="radio" name="change_scope" value="next_renewal" style="width:auto"> Existing subscribers at their next renewal</label>
      <label class="check"><input type="radio" name="change_scope" value="immediate" style="width:auto"> Existing subscribers immediately (features now, price from next renewal)</label>
      <label>Change summary sent to subscribers<input name="change_summary" placeholder="e.g. Growth now includes 30 listings"></label></div><div id="imp"></div>` : ''}
    <div class="row"><button type="button" class="btn" id="prev">${p && p.status !== 'draft' ? 'Review impact' : 'Preview'}</button><button class="btn primary">${p ? 'Save & publish changes' : 'Save as draft'}</button>${!p ? '<label class="check"><input type="checkbox" name="publish"> Publish immediately</label>' : ''}</div></form>`, (m, close) => {
    const f = $('#pe', m);
    const collect = () => {
      const b = formData(f);
      const body = { name: b.name, description: b.description, target_customers: b.target_customers, pricing_model: b.pricing_model, tier_rank: Number(b.tier_rank), trial_days: Number(b.trial_days || 0), visibility: b.visibility, discount_eligible: b.discount_eligible ? 1 : 0,
        commission_bps: b.commission_pct === undefined ? null : Math.round(Number(b.commission_pct) * 100), upgrade_to: (b.upgrade_to || '').split(',').map((s) => s.trim()).filter(Boolean), downgrade_to: (b.downgrade_to || '').split(',').map((s) => s.trim()).filter(Boolean),
        features: (b.features || '').split('\n').map((s) => s.trim()).filter(Boolean), entitlements: {}, prices: [] };
      if (!p) { body.code = b.code; body.audience = audience; body.publish = !!b.publish; }
      f.querySelectorAll('[data-ent]').forEach((i) => { body.entitlements[i.dataset.ent] = i.type === 'checkbox' ? i.checked : i.type === 'number' ? Number(i.value) : i.value; });
      if (b.pricing_model === 'fixed') {
        ['monthly', 'quarterly', 'annual'].forEach((fr) => {
          const v = f.querySelector(`[data-price="${fr}"]`).value;
          if (v === '') return;
          const promo = f.querySelector(`[data-promo="${fr}"]`).value;
          const until = f.querySelector(`[data-promountil="${fr}"]`).value;
          body.prices.push({ billing_frequency: fr, price_paise: Math.round(Number(v) * 100), promo_price_paise: promo === '' ? null : Math.round(Number(promo) * 100), promo_label: b.promo_label || null, promo_valid_until: until ? new Date(until + 'T23:59:59').toISOString() : null });
        });
      }
      const scope = f.querySelector('[name=change_scope]:checked');
      if (scope) { body.change_scope = scope.value; body.change_summary = b.change_summary; }
      return body;
    };
    $('#prev', m).onclick = async () => {
      const body = collect();
      if (p && p.status !== 'draft') {
        try { const r = await POST(`/owner/plans/${p.id}/impact`, body); $('#imp', m).innerHTML = `<div class="banner ${r.accounts_over_new_limits.length ? 'warn' : ''}"><strong>Impact:</strong> ${r.active_subscribers} active subscriber(s). MRR ${inr(r.current_mrr_paise)} → ${inr(r.projected_mrr_paise)} if applied to existing subscribers.
          ${r.price_changes.map((c) => `<div class="small">${esc(c.frequency)}: ${inr(c.from)} → ${inr(c.to)} (${c.subscribers} subscribers)</div>`).join('')}
          ${r.entitlement_reductions.map((c) => `<div class="small">Reduces ${esc(c.key)}: ${c.from} → ${c.to}</div>`).join('')}
          ${r.accounts_over_new_limits.length ? `<div class="small"><strong>${r.accounts_over_new_limits.length}</strong> account(s) would exceed new limits; excess listings would be set inactive under the downgrade policy.</div>` : ''}</div>`; } catch (e) { handleError(e); }
      } else {
        const fake = { ...body, features: body.features.map((l) => ({ label: l })), prices: body.prices.map((x) => ({ ...x, status: 'active', effective_price_paise: x.promo_price_paise ?? x.price_paise, interval_months: { monthly: 1, quarterly: 3, annual: 12 }[x.billing_frequency] })), relation: 'upgrade', trial_eligible: body.trial_days > 0 };
        modal(`<h2>Preview</h2><div class="plans">${planCard(fake, {}, false)}</div><p class="small muted">Shown with ${planFreq} pricing.</p><button class="btn" data-close>Close preview</button>`);
      }
    };
    f.onsubmit = async (e) => {
      e.preventDefault();
      try { if (p) await PUT(`/owner/plans/${p.id}`, collect()); else await POST('/owner/plans', collect()); close(); toast(p ? 'Plan updated' : 'Plan saved'); route(); } catch (err) { handleError(err); }
    };
  });
}

/* ------------------------------------------------------------------ commission rules (section 11) */
PAGES['/owner/commissions'] = async (el) => {
  const [rules, settingsList, plans] = await Promise.all([GET('/owner/commission-rules'), GET('/owner/settings'), GET('/owner/plans')]);
  const cfg = settingsList.find((s) => s.key === 'commissions').value;
  const planOpts = (sel, aud) => opts(plans.filter((p) => p.audience === aud).map((p) => ({ value: p.id, label: p.name })), sel, { blank: 'Any' });
  const modelTxt = (r) => (r.model === 'fixed' ? inr2(r.fixed_paise) : r.model === 'percentage' ? `${r.rate_bps / 100}%` : `${r.rate_bps / 100}% + ${inr2(r.fixed_paise)}`);
  el.innerHTML = `<div class="topbar"><div><h1>Transaction commissions</h1><p class="muted">Rules are matched by priority, then specificity. If no rule matches, the seller plan's commission % applies.</p></div></div>
  <div class="card"><div class="row between"><div><strong>Commissions are ${cfg.enabled ? 'ON' : 'OFF'}</strong><div class="small muted">Initial strategy: direct buyer–farmer transactions with no commission. Turn on when ready. Charges are always shown to users before they confirm an order.</div></div>
    <div class="row"><label>Default payer<select id="dcp">${opts(['seller', 'buyer', 'both', 'included_in_price', 'deducted_from_payout'].map((v) => ({ value: v, label: title(v) })), cfg.default_charged_to)}</select></label><button class="btn ${cfg.enabled ? 'danger' : 'primary'}" id="tog">${cfg.enabled ? 'Turn off' : 'Turn on'}</button><button class="btn" id="inv">Invoice outstanding now</button></div></div></div>
  <div class="card" style="margin-top:16px"><h2>Plan rates (fallback)</h2>${table([{ h: 'Plan', k: 'name' }, { h: 'Audience', k: 'audience' }, { h: 'Commission', r: 1, f: (p) => (p.commission_bps != null ? `${p.commission_bps / 100}%` : '—') }], plans.filter((p) => p.audience === 'farmer'))}<p class="small muted">Edit plan rates in <a href="#/owner/plans">Subscription plans</a>.</p></div>
  <div class="card" style="margin-top:16px"><h2>Rules</h2>${table([{ h: 'Rule', f: (r) => `<strong>${esc(r.name)}</strong><div class="small muted">priority ${r.priority}</div>` }, { h: 'Fee', f: modelTxt }, { h: 'Charged to', f: (r) => esc(title(r.charged_to)) },
    { h: 'Conditions', f: (r) => [r.seller_plan && `seller: ${r.seller_plan}`, r.buyer_plan && `buyer: ${r.buyer_plan}`, r.category && `category: ${r.category}`, r.region && `region: ${r.region}`, r.order_type && `type: ${r.order_type}`, r.min_order_paise != null && `≥ ${inr(r.min_order_paise)}`, r.max_order_paise != null && `≤ ${inr(r.max_order_paise)}`, (r.valid_from || r.valid_until) && `${date(r.valid_from)} – ${date(r.valid_until)}`].filter(Boolean).map(esc).join('<br>') || 'All orders' },
    { h: 'Status', f: (r) => pill(r.status) }, { h: '', f: (r) => `<button class="btn sm" data-t="${r.id}" data-s="${r.status === 'active' ? 'inactive' : 'active'}">${r.status === 'active' ? 'Disable' : 'Enable'}</button>` }], rules)}</div>
  <div class="card" style="margin-top:16px"><h2>New rule</h2><form class="form cols" id="cr"><label>Name<input name="name" required></label><label>Priority<input name="priority" type="number" value="10"></label>
    <label>Model<select name="model"><option value="percentage">Percentage</option><option value="fixed">Fixed fee</option><option value="percentage_plus_fixed">Percentage + fixed</option></select></label>
    <label>Rate %<input name="rate_pct" type="number" step="0.01" value="0"></label><label>Fixed fee (₹)<input name="fixed_paise" data-paise type="number" step="0.01" value="0"></label>
    <label>Minimum fee (₹)<input name="min_fee_paise" data-paise type="number" step="0.01"></label><label>Maximum fee (₹)<input name="max_fee_paise" data-paise type="number" step="0.01"></label>
    <label>Charged to<select name="charged_to">${opts(['seller', 'buyer', 'both', 'included_in_price', 'deducted_from_payout'].map((v) => ({ value: v, label: title(v) })))}</select></label>
    <label>Buyer share % (when both)<input name="buyer_share_pct" type="number" value="50"></label>
    <label>Seller plan<select name="seller_plan_id">${planOpts('', 'farmer')}</select></label><label>Buyer plan<select name="buyer_plan_id">${planOpts('', 'buyer')}</select></label>
    <label>Category<select name="category_id">${categoryOpts('', 'Any')}</select></label><label>Region<select name="region">${regionOpts('', 'Any')}</select></label>
    <label>Order type<select name="order_type">${opts(['standard', 'bulk', 'multi_farmer', 'procurement', 'recurring'].map((v) => ({ value: v, label: title(v) })), '', { blank: 'Any' })}</select></label>
    <label>Min order value (₹)<input name="min_order_paise" data-paise type="number"></label><label>Max order value (₹)<input name="max_order_paise" data-paise type="number"></label>
    <label>Valid from<input name="valid_from" type="date"></label><label>Valid until<input name="valid_until" type="date"></label>
    <div style="align-self:end"><button class="btn primary">Create rule</button></div></form></div>`;
  const saveCfg = (patch) => PUT('/owner/settings/commissions', { value: { ...cfg, ...patch } });
  $('#tog').onclick = async () => { if (!confirm(`Turn commissions ${cfg.enabled ? 'off' : 'on'} for new orders?`)) return; await saveCfg({ enabled: !cfg.enabled }); route(); };
  $('#dcp').onchange = async (e) => { await saveCfg({ default_charged_to: e.target.value }); toast('Saved'); };
  $('#inv').onclick = async () => { const r = await POST('/admin/jobs/run', { invoice_commissions: true }); toast(`${(r.commission_invoices || []).length} commission invoice(s) issued`); };
  el.querySelectorAll('[data-t]').forEach((b) => (b.onclick = async () => { await PUT(`/owner/commission-rules/${b.dataset.t}`, { status: b.dataset.s }); route(); }));
  $('#cr').onsubmit = async (e) => {
    e.preventDefault();
    const b = formData(e.target);
    b.rate_bps = Math.round(Number(b.rate_pct || 0) * 100); delete b.rate_pct;
    b.buyer_share_bps = Math.round(Number(b.buyer_share_pct || 50) * 100); delete b.buyer_share_pct;
    for (const k of ['seller_plan_id', 'buyer_plan_id', 'category_id']) if (b[k]) b[k] = Number(b[k]);
    if (b.valid_from) b.valid_from = new Date(b.valid_from).toISOString();
    if (b.valid_until) b.valid_until = new Date(b.valid_until + 'T23:59:59').toISOString();
    try { await POST('/owner/commission-rules', b); toast('Rule created'); route(); } catch (err) { handleError(err); }
  };
};

/* ------------------------------------------------------------------ promotion products */
PAGES['/owner/promotions'] = async (el) => {
  const list = await GET('/owner/promotion-products');
  el.innerHTML = `<div class="topbar"><div><h1>Promotion products</h1><p class="muted">Featured & promoted listing options sold to farmers</p></div></div>
  <div class="card"><div class="table-wrap"><table><tr><th>Option</th><th>Type</th><th class="r">Hours</th><th class="r">Price (₹)</th><th class="r">Credits</th><th class="r">Max slots</th><th>Status</th><th></th></tr>
  ${list.map((p) => `<tr data-row="${p.id}"><td><input data-k="name" value="${esc(p.name)}"></td><td>${esc(title(p.promotion_type))}</td><td class="r"><input data-k="duration_hours" type="number" value="${p.duration_hours}" style="width:80px"></td><td class="r"><input data-k="price" type="number" step="0.01" value="${p.price_paise / 100}" style="width:100px"></td><td class="r"><input data-k="credit_cost" type="number" value="${p.credit_cost}" style="width:70px"></td><td class="r"><input data-k="max_concurrent" type="number" value="${p.max_concurrent ?? ''}" style="width:70px"></td><td><select data-k="status">${opts([{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }], p.status)}</select></td><td><button class="btn sm primary" data-save="${p.id}">Save</button></td></tr>`).join('')}</table></div></div>
  <div class="card" style="margin-top:16px"><h2>New promotion option</h2><form class="form cols" id="np"><label>Code<input name="code" required pattern="[a-z0-9_]+"></label><label>Name<input name="name" required></label>
    <label>Type<select name="promotion_type">${opts(['featured', 'category', 'regional', 'homepage', 'urgent_harvest'].map((v) => ({ value: v, label: title(v) })))}</select></label>
    <label>Duration (hours)<input name="duration_hours" type="number" required></label><label>Price (₹)<input name="price_paise" data-paise type="number" step="0.01" required></label><label>Credit cost<input name="credit_cost" type="number" value="1"></label>
    <label class="check"><input type="checkbox" name="requires_region"> Needs target region</label><label class="check"><input type="checkbox" name="requires_category"> Needs target category</label>
    <div style="align-self:end"><button class="btn primary">Create</button></div></form></div>`;
  el.querySelectorAll('[data-save]').forEach((b) => (b.onclick = async () => {
    const row = el.querySelector(`[data-row="${b.dataset.save}"]`);
    const v = (k) => row.querySelector(`[data-k="${k}"]`).value;
    try { await PUT(`/owner/promotion-products/${b.dataset.save}`, { name: v('name'), duration_hours: Number(v('duration_hours')), price_paise: Math.round(Number(v('price')) * 100), credit_cost: Number(v('credit_cost')), max_concurrent: v('max_concurrent') === '' ? null : Number(v('max_concurrent')), status: v('status') }); toast('Saved'); } catch (e) { handleError(e); }
  }));
  $('#np').onsubmit = async (e) => { e.preventDefault(); const b = formData(e.target); b.requires_region = b.requires_region ? 1 : 0; b.requires_category = b.requires_category ? 1 : 0; try { await POST('/owner/promotion-products', b); route(); } catch (err) { handleError(err); } };
};

/* ------------------------------------------------------------------ discounts & referrals (section 21) */
PAGES['/owner/discounts'] = async (el) => {
  const [codes, refs, settingsList, plans] = await Promise.all([GET('/owner/discount-codes'), GET('/owner/referrals'), GET('/owner/settings'), GET('/owner/plans')]);
  const rp = settingsList.find((s) => s.key === 'referral_program').value;
  el.innerHTML = `<div class="topbar"><div><h1>Discounts & referrals</h1></div></div>
  <div class="card"><h2>Discount codes</h2>${table([{ h: 'Code', f: (c) => `<strong>${esc(c.code)}</strong><div class="small muted">${esc(c.description || c.source)}</div>` }, { h: 'Discount', f: (c) => (c.discount_type === 'percent' ? `${c.value / 100}%` : inr(c.value)) + (c.duration_cycles > 1 ? ` × ${c.duration_cycles} cycles` : '') },
    { h: 'Applies to', f: (c) => esc([c.applies_to, c.audience, c.region, c.new_customers_only ? 'new customers' : ''].filter(Boolean).join(' · ')) }, { h: 'Valid', f: (c) => `${date(c.valid_from)} – ${date(c.valid_until)}` }, { h: 'Used', r: 1, f: (c) => `${c.redemptions}${c.max_redemptions ? ` / ${c.max_redemptions}` : ''}` }, { h: 'Discount given', r: 1, f: (c) => inr(c.total_discount_paise) }, { h: 'Status', f: (c) => pill(c.status) },
    { h: '', f: (c) => `<button class="btn sm" data-dt="${c.id}" data-s="${c.status === 'active' ? 'inactive' : 'active'}">${c.status === 'active' ? 'Disable' : 'Enable'}</button>` }], codes.filter((c) => c.source !== 'referral').slice(0, 50))}
  <h3 style="margin-top:16px">New code</h3><form class="form cols" id="dc"><label>Code<input name="code" placeholder="auto if blank"></label><label>Description<input name="description" placeholder="First-month offer"></label>
    <label>Type<select name="discount_type"><option value="percent">Percent</option><option value="fixed">Fixed ₹</option></select></label><label>Value (% or ₹)<input name="value_in" type="number" step="0.01" required></label>
    <label>Applies to<select name="applies_to"><option value="subscription">Subscriptions</option><option value="promotion">Promotions</option><option value="any">Anything</option></select></label>
    <label>Audience<select name="audience"><option value="">Everyone</option><option value="farmer">Farmers</option><option value="buyer">Buyers</option></select></label>
    <label>Plan<select name="plan_id">${opts(plans.filter((p) => p.pricing_model === 'fixed').map((p) => ({ value: p.id, label: p.name })), '', { blank: 'All paid plans' })}</select></label>
    <label>Billing frequency<select name="frequency"><option value="">Any</option><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="annual">Annual</option></select></label>
    <label>Region (launch offer)<select name="region">${regionOpts('', 'All')}</select></label><label>Billing cycles<input name="duration_cycles" type="number" value="1" min="1"></label>
    <label>Max redemptions<input name="max_redemptions" type="number"></label><label>Valid until<input name="valid_until" type="date"></label>
    <label class="check"><input type="checkbox" name="new_customers_only"> New customers only</label><div style="align-self:end"><button class="btn primary">Create code</button></div></form></div>
  <div class="card" style="margin-top:16px"><h2>Referral programme</h2><p class="small muted">Reward types: promotion_credits (value), account_credit (value_paise), discount_percent (value_bps, cycles), free_months (value). Eligibility: registered, profile_completed, first_listing, first_completed_order, paid_subscription.</p>
    <textarea id="rp" style="min-height:220px">${esc(JSON.stringify(rp, null, 2))}</textarea><div class="row" style="margin-top:8px"><button class="btn primary" id="rps">Save referral rules</button></div>
    <h3 style="margin-top:16px">Referrals</h3>${table([{ h: 'Referrer', k: 'referrer' }, { h: 'New user', k: 'referee' }, { h: 'Type', k: 'referee_type' }, { h: 'Status', f: (r) => pill(r.status) }, { h: 'Note', f: (r) => esc(r.rejection_reason ? title(r.rejection_reason) : JSON.parse(r.referrer_reward_json || 'null')?.granted || '') }, { h: 'Date', f: (r) => date(r.created_at) }], refs.slice(0, 50))}</div>`;
  el.querySelectorAll('[data-dt]').forEach((b) => (b.onclick = async () => { await PUT(`/owner/discount-codes/${b.dataset.dt}`, { status: b.dataset.s }); route(); }));
  $('#dc').onsubmit = async (e) => {
    e.preventDefault();
    const b = formData(e.target);
    const body = { code: b.code, description: b.description, discount_type: b.discount_type, value: b.discount_type === 'percent' ? Math.round(Number(b.value_in) * 100) : Math.round(Number(b.value_in) * 100), applies_to: b.applies_to, audience: b.audience || null, region: b.region || null, duration_cycles: Number(b.duration_cycles || 1), max_redemptions: b.max_redemptions ? Number(b.max_redemptions) : null, new_customers_only: b.new_customers_only ? 1 : 0, valid_until: b.valid_until ? new Date(b.valid_until + 'T23:59:59').toISOString() : null, plan_ids: b.plan_id ? [Number(b.plan_id)] : null, frequencies: b.frequency ? [b.frequency] : null };
    try { const c = await POST('/owner/discount-codes', body); toast(`Code ${c.code} created`); route(); } catch (err) { handleError(err); }
  };
  $('#rps').onclick = async () => { try { await PUT('/owner/settings/referral_program', { value: JSON.parse($('#rp').value) }); toast('Referral rules saved'); } catch (e) { toast(e instanceof SyntaxError ? 'Invalid JSON' : e.message, true); } };
};

/* ------------------------------------------------------------------ fees & policies (section 24) */
PAGES['/owner/settings'] = async (el) => {
  const list = (await GET('/owner/settings')).filter((s) => !['commissions', 'referral_program'].includes(s.key));
  el.innerHTML = `<div class="topbar"><div><h1>Fees & policies</h1><p class="muted">Every monetisation parameter — tax, billing timings, grace periods, downgrade policy, procurement & logistics fees, ad rates. Changes are audited.</p></div></div>
  <div class="grid g2">${list.map((s) => `<div class="card"><h3>${esc(title(s.key))}</h3><p class="small muted">${esc(s.description || '')}</p><textarea data-key="${esc(s.key)}" style="min-height:150px">${esc(JSON.stringify(s.value, null, 2))}</textarea><div class="row between" style="margin-top:8px"><span class="small muted">Updated ${dt(s.updated_at)}</span><button class="btn sm primary" data-save="${esc(s.key)}">Save</button></div></div>`).join('')}</div>`;
  el.querySelectorAll('[data-save]').forEach((b) => (b.onclick = async () => {
    try { await PUT(`/owner/settings/${b.dataset.save}`, { value: JSON.parse(el.querySelector(`[data-key="${b.dataset.save}"]`).value) }); toast('Saved'); } catch (e) { toast(e instanceof SyntaxError ? 'Invalid JSON' : e.message, true); }
  }));
};

/* ------------------------------------------------------------------ enterprise deals */
PAGES['/owner/enterprise'] = async (el) => {
  const list = await GET('/owner/enterprise-enquiries');
  el.innerHTML = `<div class="topbar"><div><h1>Enterprise deals</h1><p class="muted">Custom-priced contracts for large buyers and producers</p></div></div>
  <div class="card">${table([{ h: 'Account', f: (e) => `<strong>${esc(e.account)}</strong><div class="small muted">${esc(e.type)} · ${esc(e.plan)}</div>` }, { h: 'Requirements', f: (e) => esc(e.requirements || '') }, { h: 'Quote', r: 1, f: (e) => (e.quoted_price_paise ? `${inr(e.quoted_price_paise)} / ${esc(e.quoted_frequency)}` : '—') }, { h: 'Status', f: (e) => pill(e.status) }, { h: '', f: (e) => (['open', 'quoted'].includes(e.status) && S.me.user.role === 'owner' ? `<button class="btn sm primary" data-q="${e.id}">${e.status === 'quoted' ? 'Re-quote' : 'Send quote'}</button>` : '') }], list, 'No enquiries yet.')}</div>`;
  el.querySelectorAll('[data-q]').forEach((b) => (b.onclick = () => modal(`<h2>Custom quote</h2><form class="form" id="qf"><div class="grid g2"><label>Price per cycle (₹, excl. GST)<input name="price_paise" data-paise type="number" step="0.01" required></label><label>Billing<select name="frequency"><option value="annual">Annual</option><option value="quarterly">Quarterly</option><option value="monthly">Monthly</option></select></label></div>
    <label>Entitlement overrides (JSON)<textarea name="overrides">{}</textarea></label><label>Notes on invoice<input name="notes"></label><button class="btn primary">Issue quote & invoice</button></form>`, (m, close) => {
    $('#qf', m).onsubmit = async (e) => { e.preventDefault(); const f = formData(e.target); try { await POST(`/owner/enterprise-enquiries/${b.dataset.q}/quote`, { price_paise: f.price_paise, frequency: f.frequency, notes: f.notes, entitlement_overrides: JSON.parse(f.overrides || '{}') }); close(); toast('Quote sent'); route(); } catch (err) { handleError(err); } };
  })));
};

/* ------------------------------------------------------------------ audit log */
PAGES['/owner/audit'] = async (el) => {
  const d = await GET('/owner/audit-log?limit=300');
  el.innerHTML = `<div class="topbar"><div><h1>Financial audit log</h1><p class="muted">Append-only and hash-chained. Financial records are never deleted — only reversed or adjusted.</p></div>${d.chain.ok ? '<span class="pill good">✓ Chain verified</span>' : `<span class="pill bad">Chain broken at #${d.chain.brokenAt}</span>`}</div>
  <div class="card">${table([{ h: 'When', f: (a) => dt(a.created_at) }, { h: 'Actor', f: (a) => `${esc(a.actor_email || a.actor_role)}` }, { h: 'Action', f: (a) => `<code>${esc(a.action)}</code>` }, { h: 'Entity', f: (a) => `${esc(a.entity_type)} ${esc(a.entity_id || '')}` }, { h: 'Details', f: (a) => `<div class="small muted" style="max-width:420px;overflow-wrap:anywhere">${esc(a.reason || '')} ${esc((a.after_json || '').slice(0, 180))}</div>` }], d.entries)}</div>`;
};

/* ================================================================== ADMIN */
PAGES['/admin/payments'] = async (el, q) => {
  const [list, failed] = await Promise.all([GET(`/admin/payments${q.status ? `?status=${q.status}` : ''}`), GET('/admin/payments/failed')]);
  el.innerHTML = `<div class="topbar"><div><h1>Payments</h1></div><div class="row"><button class="btn" id="xp">Export payments</button><button class="btn" id="xi">Export invoices</button></div></div>
  <div class="card"><div class="row" style="margin-bottom:10px">${['', 'captured', 'failed', 'created', 'refunded', 'partially_refunded'].map((s) => `<a class="pill ${q.status === s || (!q.status && !s) ? 'info' : ''}" href="#/admin/payments${s ? `?status=${s}` : ''}">${s ? title(s) : 'All'}</a>`).join('')}</div>
  ${table([{ h: 'Date', f: (p) => dt(p.captured_at || p.created_at) }, { h: 'Account', k: 'account' }, { h: 'Invoice', f: (p) => `${esc(p.invoice_number)}<div class="small muted">${esc(p.invoice_type)}</div>` }, { h: 'Provider ref', f: (p) => `<span class="small">${esc(p.provider_payment_id || p.provider_order_id)}</span>` }, { h: 'Method', k: 'method' }, { h: 'Amount', r: 1, f: (p) => inr2(p.amount_paise) }, { h: 'Refunded', r: 1, f: (p) => (p.amount_refunded_paise ? inr2(p.amount_refunded_paise) : '') }, { h: 'Verified via', k: 'verified_via' }, { h: 'Status', f: (p) => pill(p.status) },
    { h: '', f: (p) => (['captured', 'partially_refunded'].includes(p.status) ? `<button class="btn sm" data-rf="${p.id}" data-max="${p.amount_paise - p.amount_refunded_paise}">Request refund</button>` : '') }], list)}</div>
  <div class="card" style="margin-top:16px"><h2>Failed payment attempts</h2>${table([{ h: 'When', f: (a) => dt(a.created_at) }, { h: 'Account', k: 'account' }, { h: 'Invoice', k: 'invoice_number' }, { h: 'Amount', r: 1, f: (a) => inr2(a.amount_paise) }, { h: 'Reason', f: (a) => esc(a.error_description || a.status) }, { h: 'Source', k: 'source' }], failed.attempts)}</div>`;
  const range = `from=${isoDay(Date.now() - 90 * 86400000)}&to=${isoDay(Date.now() + 86400000)}`;
  $('#xp').onclick = () => downloadCsv(`/admin/export/payments.csv?${range}`, 'payments.csv');
  $('#xi').onclick = () => downloadCsv(`/admin/export/invoices.csv?${range}`, 'invoices.csv');
  el.querySelectorAll('[data-rf]').forEach((b) => (b.onclick = () => modal(`<h2>Request refund</h2><p class="small muted">Refunds need authorisation from the platform owner before money is returned.</p><form class="form" id="rq"><label>Amount (₹, max ${inr2(Number(b.dataset.max))})<input name="amount_paise" data-paise type="number" step="0.01" max="${Number(b.dataset.max) / 100}" value="${Number(b.dataset.max) / 100}" required></label><label>Reason<input name="reason" required></label><button class="btn primary">Submit request</button></form>`, (m, close) => {
    $('#rq', m).onsubmit = async (e) => { e.preventDefault(); try { await POST('/admin/refunds', { payment_id: Number(b.dataset.rf), ...formData(e.target) }); close(); toast('Refund requested'); } catch (err) { handleError(err); } };
  })));
};

PAGES['/admin/refunds'] = async (el) => {
  const list = await GET('/admin/refunds');
  const owner = S.me.user.role === 'owner';
  el.innerHTML = `<div class="topbar"><div><h1>Refunds</h1><p class="muted">Requested by admins (or raised automatically for duplicate payments), authorised by the owner, executed via the payment provider.</p></div></div>
  <div class="card">${table([{ h: 'Requested', f: (r) => dt(r.created_at) }, { h: 'Account', k: 'account' }, { h: 'Invoice', k: 'invoice_number' }, { h: 'Amount', r: 1, f: (r) => inr2(r.amount_paise) }, { h: 'Reason', k: 'reason' }, { h: 'Status', f: (r) => pill(r.status) },
    { h: '', f: (r) => (r.status === 'requested' && owner ? `<button class="btn sm primary" data-ok="${r.id}">Approve</button> <button class="btn sm danger" data-no="${r.id}">Reject</button>` : esc(r.decision_notes || '')) }], list, 'No refunds.')}</div>`;
  const decide = async (id, approve) => { const notes = prompt(approve ? 'Approval note' : 'Reason for rejection') ?? ''; try { await POST(`/owner/refunds/${id}/decision`, { approve, notes }); toast(approve ? 'Refund sent to provider' : 'Refund rejected'); route(); } catch (e) { handleError(e); } };
  el.querySelectorAll('[data-ok]').forEach((b) => (b.onclick = () => decide(b.dataset.ok, true)));
  el.querySelectorAll('[data-no]').forEach((b) => (b.onclick = () => decide(b.dataset.no, false)));
};

PAGES['/admin/invoices'] = async (el, q) => {
  const list = await GET(`/admin/invoices${q.status ? `?status=${q.status}` : ''}`);
  el.innerHTML = `<div class="topbar"><div><h1>Invoices</h1></div></div><div class="card"><div class="row" style="margin-bottom:10px">${['', 'issued', 'overdue', 'paid', 'void', 'refunded', 'partially_refunded'].map((s) => `<a class="pill ${q.status === s || (!q.status && !s) ? 'info' : ''}" href="#/admin/invoices${s ? `?status=${s}` : ''}">${s ? title(s) : 'All'}</a>`).join('')}</div>
  ${table([{ h: 'Invoice', k: 'invoice_number' }, { h: 'Account', k: 'account' }, { h: 'Type', f: (i) => esc(title(i.invoice_type)) }, { h: 'Issued', f: (i) => date(i.issued_at) }, { h: 'Total', r: 1, f: (i) => inr2(i.total_paise) }, { h: 'Paid', r: 1, f: (i) => inr2(i.amount_paid_paise) }, { h: 'Status', f: (i) => pill(i.status) }, { h: '', f: (i) => (['issued', 'overdue'].includes(i.status) && !i.amount_paid_paise ? `<button class="btn sm" data-void="${i.id}">Void</button>` : '') }], list)}</div>`;
  el.querySelectorAll('[data-void]').forEach((b) => (b.onclick = async () => { const reason = prompt('Reason for voiding (audited)'); if (!reason) return; try { await POST(`/admin/invoices/${b.dataset.void}/void`, { reason }); route(); } catch (e) { handleError(e); } }));
};

PAGES['/admin/reconcile'] = async (el) => {
  const disputes = await GET('/admin/disputes');
  el.innerHTML = `<div class="topbar"><div><h1>Reconciliation & disputes</h1><p class="muted">Compare Razorpay's records with AgriConnect's ledger</p></div></div>
  <form class="card form cols" id="rc"><label>From<input type="date" name="from" value="${isoDay(Date.now() - 7 * 86400000)}"></label><label>To<input type="date" name="to" value="${isoDay(Date.now() + 86400000)}"></label><label class="check" style="align-self:end"><input type="checkbox" name="repair"> Repair missed captures</label><div style="align-self:end"><button class="btn primary">Run reconciliation</button></div></form>
  <div id="res" style="margin-top:16px"></div>
  <div class="card" style="margin-top:16px"><h2>Payment disputes</h2>${table([{ h: 'Dispute', k: 'provider_dispute_id' }, { h: 'Account', k: 'account' }, { h: 'Amount', r: 1, f: (d) => inr2(d.amount_paise) }, { h: 'Reason', k: 'reason' }, { h: 'Status', f: (d) => pill(d.status) }, { h: '', f: (d) => `<select data-d="${d.id}">${opts(['open', 'under_review', 'won', 'lost', 'closed'].map((s) => ({ value: s, label: title(s) })), d.status)}</select>` }], disputes, 'No disputes.')}</div>`;
  $('#rc').onsubmit = async (e) => {
    e.preventDefault();
    const b = formData(e.target);
    try {
      const r = await POST('/admin/reconcile', { from: new Date(b.from).toISOString(), to: new Date(b.to).toISOString(), repair: !!b.repair });
      $('#res').innerHTML = `<div class="card"><div class="row"><strong>${r.ok ? '✓ Ledger matches provider' : `${r.issues.length} issue(s) found`}</strong><span class="muted small">${r.provider_payments} provider payments · ${r.local_captured} captured locally</span></div>${table([{ h: 'Issue', f: (i) => esc(title(i.type)) }, { h: 'Payment', f: (i) => esc(i.provider_payment_id || i.payment_id) }, { h: 'Amount', r: 1, f: (i) => inr2(i.amount || i.provider || 0) }, { h: '', f: (i) => (i.repaired ? '<span class="pill good">Repaired</span>' : '') }], r.issues, 'No discrepancies.')}</div>`;
    } catch (err) { handleError(err); }
  };
  el.querySelectorAll('[data-d]').forEach((s) => (s.onchange = async () => { await POST(`/admin/disputes/${s.dataset.d}`, { status: s.value }); toast('Dispute updated'); }));
};

PAGES['/admin/procurement'] = async (el) => {
  const list = await GET('/admin/procurement');
  el.innerHTML = `<div class="topbar"><div><h1>Procurement desk</h1><p class="muted">Platform-assisted sourcing requests</p></div><button class="btn" id="jobs">Run billing jobs now</button></div>
  <div class="stack">${list.map((r) => `<div class="card"><div class="row between"><div><strong>${esc(r.reference)}</strong> · ${esc(r.buyer_name)} needs <strong>${r.quantity} ${esc(r.unit)} ${esc(r.product_name)}</strong> <span class="small muted">${r.required_by ? `by ${esc(r.required_by)}` : ''} → ${esc(r.delivery_location || r.delivery_region || '')}</span></div>${pill(r.status)}</div>
    ${r.lines.length ? table([{ h: 'Supplier', k: 'supplier_name' }, { h: 'Qty', r: 1, k: 'quantity' }, { h: 'Price', r: 1, f: (x) => inr2(x.unit_price_paise) }, { h: 'Status', f: (x) => pill(x.status) }], r.lines) : ''}
    <p class="small">Confirmed ${r.confirmed_quantity} / ${r.quantity} ${esc(r.unit)}${r.fee ? ` · fee ${inr2(r.fee.fee_paise)} ${pill(r.fee.status)}` : ''}</p>
    <div class="row">${r.status === 'submitted' ? `<button class="btn sm primary" data-acc="${r.id}">Accept</button><button class="btn sm danger" data-rej="${r.id}">Reject</button>` : ''}
    ${['under_review', 'sourcing', 'proposal_sent'].includes(r.status) ? `<button class="btn sm" data-find="${r.id}">Find suppliers</button><button class="btn sm primary" data-prop="${r.id}">Send proposal</button>` : ''}</div><div id="sup-${r.id}"></div></div>`).join('') || '<div class="card"><p class="muted">No requests.</p></div>'}</div>`;
  $('#jobs').onclick = async () => { const r = await POST('/admin/jobs/run'); toast(`Jobs run: ${JSON.stringify(r.subscriptions)}`); };
  el.querySelectorAll('[data-acc],[data-rej]').forEach((b) => (b.onclick = async () => { await POST(`/admin/procurement/${b.dataset.acc || b.dataset.rej}/review`, { accept: !!b.dataset.acc }); route(); }));
  el.querySelectorAll('[data-prop]').forEach((b) => (b.onclick = async () => { const notes = prompt('Proposal notes for the buyer') ?? ''; try { await POST(`/admin/procurement/${b.dataset.prop}/proposal`, { notes }); toast('Proposal sent'); route(); } catch (e) { handleError(e); } }));
  el.querySelectorAll('[data-find]').forEach((b) => (b.onclick = async () => {
    const id = b.dataset.find;
    const s = await GET(`/admin/procurement/${id}/suppliers`);
    $(`#sup-${id}`).innerHTML = table([{ h: 'Supplier', f: (x) => `${esc(x.supplier_name)} ${x.verified ? '✓' : ''}` }, { h: 'Product', k: 'product_name' }, { h: 'Region', k: 'region' }, { h: 'Available', r: 1, k: 'available' }, { h: 'Price', r: 1, f: (x) => inr2(x.price_per_unit_paise) }, { h: '', f: (x) => `<input type="number" placeholder="qty" style="width:90px" id="q-${id}-${x.listing_id}"> <button class="btn sm" data-add="${x.listing_id}" data-svc="${id}">Request supply</button>` }], s, 'No matching suppliers.');
    $(`#sup-${id}`).querySelectorAll('[data-add]').forEach((a) => (a.onclick = async () => { try { await POST(`/admin/procurement/${id}/lines`, { listing_id: Number(a.dataset.add), quantity: Number($(`#q-${id}-${a.dataset.add}`).value) }); toast('Supplier contacted'); route(); } catch (e) { handleError(e); } }));
  }));
};

PAGES['/admin/logistics'] = async (el) => {
  const d = await GET('/admin/logistics');
  el.innerHTML = `<div class="topbar"><div><h1>Logistics</h1></div></div>
  <div class="card">${table([{ h: 'Order', k: 'order_number' }, { h: 'Mode', f: (x) => esc(title(x.mode)) }, { h: 'Provider', f: (x) => esc(x.provider_name || '—') }, { h: 'Vehicle', k: 'vehicle' }, { h: 'Route', f: (x) => `${esc(x.pickup_location || '')} → ${esc(x.delivery_location || '')}` }, { h: 'Transport', r: 1, f: (x) => inr2(x.transport_charge_paise) }, { h: 'Platform fee', r: 1, f: (x) => inr2(x.platform_fee_paise) }, { h: 'Pickup', f: (x) => dt(x.pickup_time) }, { h: 'Delivered', f: (x) => dt(x.delivery_time) }, { h: 'Status', f: (x) => pill(x.status) },
    { h: '', f: (x) => (['third_party', 'platform_arranged'].includes(x.mode) ? (x.status === 'requested' ? `<button class="btn sm primary" data-sch="${x.order_id}">Schedule</button>` : { scheduled: 'picked_up', picked_up: 'in_transit', in_transit: 'delivered' }[x.status] ? `<button class="btn sm" data-st="${x.order_id}" data-s="${{ scheduled: 'picked_up', picked_up: 'in_transit', in_transit: 'delivered' }[x.status]}">${title({ scheduled: 'picked_up', picked_up: 'in_transit', in_transit: 'delivered' }[x.status])}</button>` : '') : '') }], d.deliveries, 'No deliveries.')}</div>
  <div class="grid g2" style="margin-top:16px"><div class="card"><h2>Transport providers</h2>${table([{ h: 'Name', k: 'name' }, { h: 'Vehicles', k: 'vehicle_types' }, { h: 'Regions', k: 'regions' }, { h: 'Referral %', r: 1, f: (p) => (p.referral_commission_bps != null ? p.referral_commission_bps / 100 : 'default') }, { h: 'Status', f: (p) => pill(p.status) }], d.providers, 'No providers yet.')}</div>
  <div class="card"><h2>Register provider</h2><form class="form" id="pf"><label>Name<input name="name" required></label><div class="grid g2"><label>Phone<input name="contact_phone"></label><label>Email<input name="contact_email" type="email"></label><label>Vehicle types<input name="vehicle_types" placeholder="reefer, pickup"></label><label>Regions<input name="regions" placeholder="KA, TN"></label></div><label>Referral commission % (blank = default)<input name="ref_pct" type="number" step="0.01"></label><button class="btn primary">Register</button></form></div></div>`;
  $('#pf').onsubmit = async (e) => { e.preventDefault(); const b = formData(e.target); if (b.ref_pct !== undefined) b.referral_commission_bps = Math.round(b.ref_pct * 100); delete b.ref_pct; try { await POST('/admin/logistics/providers', b); route(); } catch (err) { handleError(err); } };
  el.querySelectorAll('[data-st]').forEach((b) => (b.onclick = async () => { try { await POST(`/admin/logistics/${b.dataset.st}/status`, { status: b.dataset.s }); route(); } catch (e) { handleError(e); } }));
  el.querySelectorAll('[data-sch]').forEach((b) => (b.onclick = () => modal(`<h2>Schedule transport</h2><form class="form" id="sf"><label>Provider<select name="provider_id">${opts(d.providers.filter((p) => p.status === 'active').map((p) => ({ value: p.id, label: p.name })), '', { blank: '—' })}</select></label><label>Vehicle<input name="vehicle"></label><label>Transport charge (₹)<input name="transport_charge_paise" data-paise type="number" step="0.01" required></label><label>Pickup time<input name="pickup_time" type="datetime-local"></label><button class="btn primary">Schedule</button></form>`, (m, close) => {
    $('#sf', m).onsubmit = async (e) => { e.preventDefault(); const f = formData(e.target); if (f.provider_id) f.provider_id = Number(f.provider_id); if (f.pickup_time) f.pickup_time = new Date(f.pickup_time).toISOString(); try { const r = await POST(`/admin/logistics/${b.dataset.sch}/schedule`, f); close(); toast(`Scheduled · platform fee ${inr2(r.platform_fee_paise)}`); route(); } catch (err) { handleError(err); } };
  })));
};

PAGES['/admin/ads'] = async (el) => {
  const list = await GET('/admin/ads');
  el.innerHTML = `<div class="topbar"><div><h1>Ad review</h1><p class="muted">Only agriculture-related sponsors. Approved ads run after payment and are always labelled “Sponsored”.</p></div></div>
  <div class="card">${table([{ h: 'Ad', f: (a) => `<strong>${esc(a.title)}</strong><div class="small">${esc(a.body)}</div><div class="small muted">${esc(a.advertiser)} · ${esc(title(a.ad_category))} · ${esc(a.cta_url || '')}</div>` }, { h: 'Runs', f: (a) => `${date(a.start_at)} – ${date(a.end_at)}` }, { h: 'Price', r: 1, f: (a) => inr(a.price_paise) }, { h: 'Impr. / clicks', r: 1, f: (a) => `${a.impressions} / ${a.clicks}` }, { h: 'Status', f: (a) => pill(a.status) },
    { h: '', f: (a) => (a.status === 'pending_review' ? `<button class="btn sm primary" data-ok="${a.id}">Approve</button> <button class="btn sm danger" data-no="${a.id}">Reject</button>` : '') }], list, 'No ads.')}</div>`;
  const review = async (id, approve) => { const notes = approve ? '' : prompt('Reason for rejection'); try { await POST(`/admin/ads/${id}/review`, { approve, notes }); route(); } catch (e) { handleError(e); } };
  el.querySelectorAll('[data-ok]').forEach((b) => (b.onclick = () => review(b.dataset.ok, true)));
  el.querySelectorAll('[data-no]').forEach((b) => (b.onclick = () => review(b.dataset.no, false)));
};

PAGES['/admin/users'] = async (el) => {
  const list = await GET('/admin/users');
  el.innerHTML = `<div class="topbar"><div><h1>Users</h1><p class="muted">${list.length} accounts</p></div><a class="btn" href="#/owner/subscriptions">Subscriber analytics</a></div>
  <div class="card">${table([{ h: 'Account', f: (a) => `<strong>${esc(a.name)}</strong><div class="small muted">${esc(a.email || '')}</div>` }, { h: 'Type', k: 'type' }, { h: 'Region', k: 'region' }, { h: 'Plan', f: (a) => `${esc(a.plan || '—')} ${a.subscription_status ? pill(a.subscription_status) : ''}` }, { h: 'Joined', f: (a) => date(a.created_at) }, { h: 'Verified', f: (a) => (a.verified ? `✓${a.premium_badge ? ' ★' : ''}` : '') }, { h: 'Status', f: (a) => pill(a.status) },
    { h: '', f: (a) => `${a.verified ? '' : `<button class="btn sm" data-ver="${a.account_id}">Verify</button>`} <button class="btn sm" data-st="${a.account_id}" data-s="${a.status === 'active' ? 'suspended' : 'active'}">${a.status === 'active' ? 'Suspend' : 'Reinstate'}</button>` }], list)}</div>`;
  el.querySelectorAll('[data-ver]').forEach((b) => (b.onclick = async () => { await POST(`/admin/accounts/${b.dataset.ver}/verify`, { premium_badge: true }); toast('Verified (premium badge granted if the plan includes it)'); route(); }));
  el.querySelectorAll('[data-st]').forEach((b) => (b.onclick = async () => { await POST(`/admin/accounts/${b.dataset.st}/status`, { status: b.dataset.s }); route(); }));
};

PAGES['/admin/risk'] = async (el) => {
  const [flags, events] = await Promise.all([GET('/admin/risk-flags'), GET('/admin/webhook-events')]);
  el.innerHTML = `<div class="topbar"><div><h1>Risk & webhooks</h1></div></div>
  <div class="card"><h2>Risk flags</h2>${table([{ h: 'When', f: (f) => dt(f.created_at) }, { h: 'Account', k: 'account' }, { h: 'Flag', f: (f) => esc(title(f.flag_type)) }, { h: 'Severity', f: (f) => `<span class="pill ${f.severity === 'high' ? 'bad' : f.severity === 'medium' ? 'warn' : ''}">${esc(f.severity)}</span>` }, { h: 'Details', f: (f) => `<span class="small muted">${esc(f.details_json || '')}</span>` }, { h: 'Status', f: (f) => pill(f.status) }, { h: '', f: (f) => (f.status === 'open' ? `<button class="btn sm" data-rv="${f.id}">Mark reviewed</button>` : '') }], flags, 'No risk flags.')}</div>
  <div class="card" style="margin-top:16px"><h2>Payment webhook events</h2>${table([{ h: 'Received', f: (e) => dt(e.received_at) }, { h: 'Event', k: 'event_type' }, { h: 'Signature', f: (e) => (e.signature_valid ? '<span class="pill good">Valid</span>' : '<span class="pill bad">Invalid</span>') }, { h: 'Processing', f: (e) => pill(e.processing_status) }, { h: 'Error', k: 'error' }], events, 'No webhook events received.')}</div>`;
  el.querySelectorAll('[data-rv]').forEach((b) => (b.onclick = async () => { await POST(`/admin/risk-flags/${b.dataset.rv}`, { status: 'reviewed' }); route(); }));
};
