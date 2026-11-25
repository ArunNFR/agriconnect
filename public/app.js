'use strict';
/* AgriConnect SPA core: API client, router, layout, auth, shared UI helpers, payment flow. */
const S = { token: null, me: null, config: null };
try { S.token = localStorage.getItem('ac_token'); } catch { /* storage unavailable */ }
const PAGES = {};
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (p, dp = 0) => (p == null ? '—' : (p < 0 ? '−' : '') + '₹' + (Math.abs(p) / 100).toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp === 0 ? 0 : 2 }));
const inr2 = (p) => inr(p, 2);
const date = (iso) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const dt = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const title = (s) => String(s ?? '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));
const limitTxt = (v) => (v < 0 ? 'Unlimited' : v);

const STATUS_TONE = { active: 'good', paid: 'good', captured: 'good', completed: 'good', processed: 'good', rewarded: 'good', approved: 'good', delivered: 'good', confirmed: 'good',
  trial: 'info', pending: 'info', issued: 'info', placed: 'info', submitted: 'info', open: 'info', scheduled: 'info', accepted: 'info', requested: 'info', under_review: 'info', sourcing: 'info', proposal_sent: 'warn', fulfilling: 'info', pending_review: 'warn', pending_payment: 'warn',
  payment_failed: 'warn', past_due: 'warn', overdue: 'warn', partially_refunded: 'warn', inactive: 'warn', sold_out: 'warn',
  suspended: 'bad', failed: 'bad', cancelled: 'bad', expired: 'bad', rejected: 'bad', void: '', refunded: 'warn', declined: 'bad' };
const pill = (s) => `<span class="pill ${STATUS_TONE[s] || ''}">${esc(title(s))}</span>`;

async function api(method, path, body, { idem = false, raw = false } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (S.token) headers.authorization = `Bearer ${S.token}`;
  if (idem) headers['idempotency-key'] = typeof idem === 'string' ? idem : uid();
  const res = await fetch('/api' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (raw) return res;
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 && S.token) { logout(); }
  if (!res.ok) { const e = new Error(json?.error?.message || `Request failed (${res.status})`); e.status = res.status; e.code = json?.error?.code; e.details = json?.error?.details; throw e; }
  return json;
}
const GET = (p) => api('GET', p);
const POST = (p, b, o) => api('POST', p, b || {}, o);
const PUT = (p, b) => api('PUT', p, b || {});

function toast(msg, bad = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (bad ? ' bad' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4200);
}

/** Every 402 from the backend becomes an upgrade prompt. */
function handleError(e) {
  if (e.code === 'upgrade_required') return upgradePrompt(e);
  toast(e.message, true);
}
function upgradePrompt(e) {
  const opts = e.details?.upgrade_options || [];
  modal(`<h2>Upgrade to unlock this</h2><p>${esc(e.message)}</p>
    ${opts.length ? `<p class="muted small">Plans that include it:</p><div class="row">${opts.map((o) => `<span class="pill info">${esc(o.name)}</span>`).join('')}</div>` : ''}
    <div class="row" style="margin-top:16px"><a class="btn primary" href="#/subscription" data-close>See plans</a><button class="btn" data-close>Not now</button></div>`);
}

function modal(html, onMount) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  const close = () => bg.remove();
  bg.addEventListener('click', (ev) => { if (ev.target === bg || ev.target.closest('[data-close]')) close(); });
  document.body.appendChild(bg);
  if (onMount) onMount(bg.querySelector('.modal'), close);
  return close;
}
function formData(form) {
  const o = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') o[el.name] = el.checked;
    else if (el.value !== '') o[el.name] = el.dataset.paise !== undefined ? Math.round(Number(el.value) * 100) : el.type === 'number' ? Number(el.value) : el.value;
  }
  return o;
}
const opts = (list, sel, { blank } = {}) => (blank ? `<option value="">${esc(blank)}</option>` : '') + list.map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(sel) ? 'selected' : ''}>${esc(o.label)}</option>`).join('');
const regionOpts = (sel, blank) => opts(S.config.regions.map((r) => ({ value: r.code, label: r.name })), sel, { blank });
const categoryOpts = (sel, blank) => opts(S.config.categories.map((c) => ({ value: c.id, label: c.name })), sel, { blank });
function table(cols, rows, empty = 'Nothing here yet.') {
  if (!rows.length) return `<p class="muted">${esc(empty)}</p>`;
  return `<div class="table-wrap"><table><thead><tr>${cols.map((c) => `<th class="${c.r ? 'r' : ''}">${esc(c.h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td class="${c.r ? 'r' : ''}">${c.f ? c.f(r) : esc(r[c.k])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
const stat = (label, value, sub = '') => `<div class="card stat"><div class="label">${esc(label)}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;

/* ------------------------------------------------------------------ payments (Razorpay Checkout) */
let rzpLoaded = null;
function loadRazorpay() {
  if (!rzpLoaded) rzpLoaded = new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://checkout.razorpay.com/v1/checkout.js'; s.onload = res; s.onerror = () => rej(new Error('Could not load the payment window. Check your connection.')); document.head.appendChild(s); });
  return rzpLoaded;
}
/**
 * Pay an invoice. The UI never marks anything paid: it hands the Razorpay response to the server,
 * which verifies the signature and the payment with Razorpay before settling the invoice.
 */
async function payInvoice(invoiceId, { onDone } = {}) {
  let co;
  try { co = await POST('/payments/checkout', { invoice_id: invoiceId }, { idem: `pay-${invoiceId}-${Math.floor(Date.now() / 60000)}` }); } catch (e) { return handleError(e); }
  try { await loadRazorpay(); } catch (e) { return toast(e.message, true); }
  const rzp = new window.Razorpay({
    ...co.checkout,
    theme: { color: '#2f7a3c' },
    handler: async (resp) => {
      try {
        const r = await POST('/payments/verify', resp);
        if (r.status === 'captured') toast('Payment verified — thank you!');
        else if (r.status === 'processing') { toast(r.message); await pollInvoice(invoiceId); } else toast('Payment failed. You can retry from Billing.', true);
      } catch (e) { toast(e.message, true); }
      if (onDone) onDone(); else route();
    },
    modal: { ondismiss: () => toast('Payment window closed — your invoice is still open in Billing.') },
  });
  rzp.on('payment.failed', (r) => toast(`Payment failed: ${r.error?.description || 'declined'}`, true));
  rzp.open();
}
async function pollInvoice(id) {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const s = await GET(`/payments/status/${id}`).catch(() => null);
    if (s?.status === 'paid') { toast('Payment confirmed'); return; }
  }
}
async function downloadInvoice(id) {
  const res = await api('GET', `/billing/invoices/${id}/download`, undefined, { raw: true });
  if (!res.ok) return toast('Could not download invoice', true);
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (res.headers.get('content-disposition') || '').split('filename=')[1]?.replace(/"/g, '') || `invoice-${id}.html`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
async function downloadCsv(path, name) {
  const res = await api('GET', path, undefined, { raw: true });
  if (!res.ok) { const j = await res.json().catch(() => ({})); return handleError(Object.assign(new Error(j?.error?.message || 'Export failed'), { code: j?.error?.code, details: j?.error?.details })); }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await res.blob());
  a.download = name;
  a.click();
}
document.addEventListener('click', (ev) => {
  const p = ev.target.closest('[data-pay]');
  if (p) { ev.preventDefault(); payInvoice(Number(p.dataset.pay)); }
  const d = ev.target.closest('[data-invoice]');
  if (d) { ev.preventDefault(); downloadInvoice(Number(d.dataset.invoice)); }
});

/* ------------------------------------------------------------------ auth */
function logout() { S.token = null; S.me = null; try { localStorage.removeItem('ac_token'); } catch { /* */ } location.hash = '#/login'; render(); }
function setToken(t) { S.token = t; try { localStorage.setItem('ac_token', t); } catch { /* */ } }

const BUSINESS_TYPES = {
  farmer: [['farmer', 'Farmer'], ['producer', 'Producer / agricultural business'], ['mushroom_grower', 'Mushroom grower'], ['hydroponic', 'Hydroponic producer'], ['greenhouse', 'Greenhouse farm'], ['vertical_farm', 'Vertical / smart farm'], ['producer_group', 'Producer group / FPO']],
  buyer: [['restaurant', 'Restaurant'], ['restaurant_chain', 'Restaurant chain'], ['retailer', 'Retailer / shop'], ['supermarket', 'Supermarket chain'], ['wholesaler', 'Wholesaler'], ['distributor', 'Distributor'], ['exporter', 'Exporter'], ['food_processor', 'Food processor'], ['institution', 'Institutional procurement']],
  advertiser: [['agri_inputs', 'Seeds / growing supplies'], ['equipment', 'Equipment / technology'], ['cold_storage', 'Cold storage / logistics'], ['finance', 'Agricultural finance / insurance'], ['packaging', 'Packaging']],
};

function authView(mode) {
  const role = new URLSearchParams(location.hash.split('?')[1] || '').get('role') || 'farmer';
  const ref = new URLSearchParams(location.hash.split('?')[1] || '').get('ref') || '';
  return `<div class="auth"><div class="logo" style="justify-content:center;font-size:24px">${LOGO} AgriConnect</div>
  <p class="muted" style="text-align:center;margin-top:-8px">Connecting farmers and buyers for real-time produce sourcing</p>
  <div class="card">
  ${mode === 'login' ? `<h2>Sign in</h2><form class="form" id="f">
    <label>Email<input name="email" type="email" required autocomplete="email"></label>
    <label>Password<input name="password" type="password" required autocomplete="current-password"></label>
    <button class="btn primary">Sign in</button></form>
    <p class="small muted">New to AgriConnect? <a href="#/register">Create a free account</a></p>`
    : `<h2>Create your free account</h2><form class="form" id="f">
    <div><label style="margin-bottom:6px">I am a</label><div class="seg" id="roleSeg">${[['farmer', 'Farmer / Producer'], ['buyer', 'Buyer'], ['advertiser', 'Advertiser']].map(([v, l]) => `<button type="button" data-role="${v}" class="${v === role ? 'on' : ''}">${l}</button>`).join('')}</div></div>
    <input type="hidden" name="role" value="${esc(role)}">
    <label>Business type<select name="business_type">${opts(BUSINESS_TYPES[role].map(([v, l]) => ({ value: v, label: l })))}</select></label>
    <label>Business / farm name<input name="business_name" required></label>
    <label>Your name<input name="name" required autocomplete="name"></label>
    <div class="grid g2"><label>Region<select name="region">${regionOpts('KA')}</select></label><label>Phone<input name="phone" autocomplete="tel"></label></div>
    <label>Email<input name="email" type="email" required autocomplete="email"></label>
    <label>Password (min 8 characters)<input name="password" type="password" minlength="8" required autocomplete="new-password"></label>
    ${role !== 'advertiser' ? `<label>Referral code (optional)<input name="referral_code" value="${esc(ref)}"></label>` : ''}
    <button class="btn primary">Create free account</button>
    <p class="small muted">Free plans need no payment. You can upgrade any time.</p></form>
    <p class="small muted">Already registered? <a href="#/login">Sign in</a></p>`}
  </div></div>`;
}
function mountAuth(mode) {
  $('#roleSeg')?.addEventListener('click', (e) => { const b = e.target.closest('[data-role]'); if (b) { location.hash = `#/register?role=${b.dataset.role}`; } });
  $('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const body = formData(e.target);
      const r = await POST(mode === 'login' ? '/auth/login' : '/auth/register', body);
      setToken(r.token);
      if (r.referral_status === 'rejected') toast('Referral code could not be applied to this signup.', true);
      location.hash = mode === 'login' ? '#/' : (body.role === 'advertiser' ? '#/ads' : '#/profile?onboarding=1');
      await render();
    } catch (err) { handleError(err); }
  });
}

/* ------------------------------------------------------------------ layout & router */
const LOGO = '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 29C16 18 8 12 3 12c0 9 5 15 13 17zm0 0c0-11 8-17 13-17 0 9-5 15-13 17zM16 22V4" fill="var(--brand)" stroke="var(--brand)" stroke-width="2" stroke-linejoin="round"/></svg>';
const NAV = {
  farmer: [['', 'Selling'], ['#/', 'Dashboard'], ['#/inventory', 'Inventory'], ['#/orders', 'Orders'], ['#/demand', 'Buyer demand'], ['#/promotions', 'Promotions'], ['#/insights', 'Market insights'], ['', 'Account'], ['#/subscription', 'Subscription'], ['#/billing', 'Billing & invoices'], ['#/referrals', 'Refer & earn'], ['#/team', 'Team'], ['#/profile', 'Business profile'], ['#/notifications', 'Notifications']],
  buyer: [['', 'Sourcing'], ['#/', 'Dashboard'], ['#/marketplace', 'Marketplace'], ['#/basket', 'Sourcing basket'], ['#/orders', 'Orders'], ['#/sourcing', 'Sourcing requests'], ['#/suppliers', 'Suppliers'], ['#/insights', 'Market insights'], ['', 'Account'], ['#/subscription', 'Subscription'], ['#/billing', 'Billing & invoices'], ['#/referrals', 'Refer & earn'], ['#/team', 'Team'], ['#/profile', 'Business profile'], ['#/notifications', 'Notifications']],
  advertiser: [['', 'Advertising'], ['#/ads', 'My ads'], ['#/billing', 'Billing & invoices'], ['#/notifications', 'Notifications']],
  owner: [['', 'Platform owner'], ['#/owner', 'Overview'], ['#/owner/revenue', 'Revenue'], ['#/owner/subscriptions', 'Subscription analytics'], ['#/owner/intelligence', 'Market intelligence'], ['', 'Monetisation'], ['#/owner/plans', 'Subscription plans'], ['#/owner/commissions', 'Commission rules'], ['#/owner/promotions', 'Promotion products'], ['#/owner/discounts', 'Discounts & referrals'], ['#/owner/settings', 'Fees & policies'], ['#/owner/enterprise', 'Enterprise deals'], ['', 'Finance'], ['#/admin/refunds', 'Refunds'], ['#/admin/payments', 'Payments'], ['#/admin/invoices', 'Invoices'], ['#/admin/reconcile', 'Reconciliation'], ['#/owner/audit', 'Audit log'], ['', 'Operations'], ['#/admin/procurement', 'Procurement desk'], ['#/admin/logistics', 'Logistics'], ['#/admin/ads', 'Ad review'], ['#/admin/users', 'Users'], ['#/admin/risk', 'Risk & webhooks']],
  admin: [['', 'Operations'], ['#/admin/procurement', 'Procurement desk'], ['#/admin/logistics', 'Logistics'], ['#/admin/ads', 'Ad review'], ['#/admin/users', 'Users'], ['', 'Finance'], ['#/admin/payments', 'Payments'], ['#/admin/refunds', 'Refunds'], ['#/admin/invoices', 'Invoices'], ['#/admin/reconcile', 'Reconciliation'], ['#/admin/risk', 'Risk & webhooks']],
};

function shell(content) {
  const role = S.me.user.role;
  const cur = location.hash.split('?')[0] || '#/';
  const home = role === 'owner' ? '#/owner' : role === 'admin' ? '#/admin/procurement' : role === 'advertiser' ? '#/ads' : '#/';
  return `<div class="shell"><aside class="side" id="side"><a class="logo" href="${home}" style="text-decoration:none;color:inherit">${LOGO} AgriConnect</a>
    <nav class="nav">${NAV[role].map(([h, l]) => (h ? `<a href="${h}" class="${cur === h ? 'active' : ''}">${esc(l)}${h === '#/notifications' && S.me.unread_notifications ? ` <span class="pill warn">${S.me.unread_notifications}</span>` : ''}</a>` : `<div class="grp">${esc(l)}</div>`)).join('')}</nav>
    <div style="margin-top:20px;padding:0 10px" class="small muted">${esc(S.me.account.name)}<br>${esc(S.me.user.email)}${S.me.subscription?.plan ? `<br><a href="#/subscription">${esc(S.me.subscription.plan)}</a> ${pill(S.me.subscription.status)}` : ''}<br><a href="#" id="logout">Sign out</a></div></aside>
    <main class="main"><button class="btn sm menu-btn" id="menu" style="margin-bottom:12px">☰ Menu</button><div id="page">${content}</div></main></div>`;
}

async function render() {
  const app = $('#app');
  if (!S.config) S.config = await GET('/config').catch(() => ({ regions: [], categories: [], payments: {} }));
  const [path, qs] = (location.hash.slice(1) || '/').split('?');
  const q = Object.fromEntries(new URLSearchParams(qs || ''));
  if (!S.token) {
    const mode = path.startsWith('/register') ? 'register' : 'login';
    app.innerHTML = authView(mode);
    return mountAuth(mode);
  }
  try { S.me = await GET('/me'); } catch { return; }
  const role = S.me.user.role;
  let key = path;
  if (path === '/' && role === 'owner') key = '/owner';
  if (path === '/' && role === 'admin') key = '/admin/procurement';
  if (path === '/' && role === 'advertiser') key = '/ads';
  const page = PAGES[key] || PAGES[key.replace(/\/\d+$/, '/:id')];
  app.innerHTML = shell('<p class="muted">Loading…</p>');
  $('#logout').onclick = (e) => { e.preventDefault(); logout(); };
  $('#menu').onclick = () => $('#side').classList.toggle('open');
  if (!page) { $('#page').innerHTML = '<h1>Not found</h1>'; return; }
  try { await page($('#page'), q); } catch (e) { $('#page').innerHTML = `<div class="banner bad">${esc(e.message)}</div>`; if (e.code === 'upgrade_required') upgradePrompt(e); }
}
const route = render;
window.addEventListener('hashchange', render);
document.addEventListener('DOMContentLoaded', render); // all page scripts are registered by then

/* ------------------------------------------------------------------ shared pages */
PAGES['/notifications'] = async (el) => {
  const list = await GET('/notifications');
  el.innerHTML = `<div class="topbar"><div><h1>Notifications</h1></div><button class="btn" id="read">Mark all read</button></div>
  <div class="card">${list.length ? list.map((n) => `<div style="padding:10px 0;border-bottom:1px solid var(--border)"><div class="row between"><strong>${esc(n.title)}</strong><span class="small muted">${dt(n.created_at)}${n.read_at ? '' : ' · <span class="pill info">new</span>'}</span></div><div class="small">${esc(n.body)}</div></div>`).join('') : '<p class="muted">No notifications.</p>'}</div>`;
  $('#read').onclick = async () => { await POST('/notifications/read'); route(); };
};

PAGES['/profile'] = async (el, q) => {
  const a = S.me.account;
  const types = BUSINESS_TYPES[S.me.user.role] || [];
  el.innerHTML = `<div class="topbar"><div><h1>Business profile</h1>${q.onboarding ? '<p class="muted">Step 1 of 2 — complete your profile, then choose a plan (the free plan is already active).</p>' : ''}</div></div>
  <div class="card"><form class="form cols" id="pf">
    <label>Business name<input name="name" value="${esc(a.name)}" required></label>
    <label>Business type<select name="business_type">${opts(types.map(([v, l]) => ({ value: v, label: l })), a.business_type)}</select></label>
    <label>Region<select name="region">${regionOpts(a.region)}</select></label>
    <label>City<input name="city" value="${esc(a.city)}"></label>
    <label>Address<input name="address" value="${esc(a.address)}"></label>
    <label>Phone<input name="phone" value="${esc(a.phone)}"></label>
    <label>GSTIN (for tax invoices)<input name="gstin" value="${esc(a.gstin)}"></label>
    <div style="align-self:end"><button class="btn primary">Save profile</button></div></form></div>`;
  $('#pf').onsubmit = async (e) => {
    e.preventDefault();
    try { await PUT('/me/profile', formData(e.target)); toast('Profile saved'); if (q.onboarding) location.hash = '#/subscription?onboarding=1'; else route(); } catch (err) { handleError(err); }
  };
};

PAGES['/team'] = async (el) => {
  const [team, sub] = await Promise.all([GET('/team'), GET('/subscription')]);
  const m = sub.usage.metrics.find((x) => x.key === 'max_users');
  el.innerHTML = `<div class="topbar"><div><h1>Team</h1><p class="muted">${m ? `${m.used} / ${limitTxt(m.limit)} users on your plan` : ''}</p></div></div>
  <div class="grid g2"><div class="card">${table([{ h: 'Name', k: 'name' }, { h: 'Email', k: 'email' }, { h: 'Role', f: (r) => title(r.account_role) }], team)}</div>
  <div class="card"><h2>Add team member</h2><form class="form" id="tf"><label>Name<input name="name" required></label><label>Email<input name="email" type="email" required></label>
  <label>Role<select name="account_role"><option value="staff">Staff — inventory & orders</option><option value="manager">Manager — also billing</option></select></label>
  <label>Temporary password<input name="password" type="password" minlength="8" required></label><button class="btn primary">Add member</button></form></div></div>`;
  $('#tf').onsubmit = async (e) => { e.preventDefault(); try { await POST('/team', formData(e.target)); toast('Member added'); route(); } catch (err) { handleError(err); } };
};
