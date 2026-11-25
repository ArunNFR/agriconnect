'use strict';
/** Printable tax invoice (HTML; "Save as PDF" from the browser print dialog). */
const settings = require('../lib/settings');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (p) => '₹' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const d = (iso) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '—');

function render(inv) {
  const seller = settings.get('company');
  const tax = settings.get('tax');
  const rows = inv.items.map((i) => `<tr><td>${esc(i.description)}</td><td class="n">${i.quantity}</td><td class="n">${inr(i.unit_amount_paise)}</td><td class="n">${inr(i.amount_paise)}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Invoice ${esc(inv.invoice_number)}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;color:#1d2b1f;max-width:800px;margin:32px auto;padding:0 16px}h1{font-size:22px;margin:0}table{width:100%;border-collapse:collapse;margin:16px 0}td,th{padding:8px;border-bottom:1px solid #dde5dc;text-align:left}.n{text-align:right;font-variant-numeric:tabular-nums}.grid{display:flex;justify-content:space-between;gap:24px;flex-wrap:wrap}.muted{color:#5b6b5d}.status{display:inline-block;padding:2px 10px;border-radius:99px;background:#e6f2e4;font-weight:600;text-transform:uppercase;font-size:12px}@media print{.noprint{display:none}}</style></head><body>
<div class="grid"><div><h1>${esc(seller.name)}</h1><div class="muted">${esc(seller.address)}<br>GSTIN: ${esc(seller.gstin || '—')}</div></div>
<div style="text-align:right"><h1>Tax Invoice</h1><div>${esc(inv.invoice_number)}</div><div class="muted">Issued ${d(inv.issued_at)} · Due ${d(inv.due_at)}</div><span class="status">${esc(inv.status)}</span></div></div>
<hr><div class="grid"><div><strong>Billed to</strong><br>${esc(inv.billing_name)}<br><span class="muted">${esc(inv.billing_address)}${inv.billing_gstin ? `<br>GSTIN: ${esc(inv.billing_gstin)}` : ''}</span></div>
<div><strong>Type</strong><br>${esc(inv.invoice_type)}</div></div>
<table><thead><tr><th>Description</th><th class="n">Qty</th><th class="n">Unit</th><th class="n">Amount</th></tr></thead><tbody>${rows}</tbody></table>
<table style="width:auto;margin-left:auto"><tr><td>Subtotal</td><td class="n">${inr(inv.subtotal_paise)}</td></tr>
${inv.discount_paise ? `<tr><td>Discounts &amp; credits</td><td class="n">−${inr(inv.discount_paise)}</td></tr>` : ''}
${inv.credit_applied_paise ? `<tr><td>Account credit</td><td class="n">−${inr(inv.credit_applied_paise)}</td></tr>` : ''}
<tr><td>${esc(tax.label)} @ ${inv.tax_rate_bps / 100}%</td><td class="n">${inr(inv.tax_paise)}</td></tr>
<tr><th>Total</th><th class="n">${inr(inv.total_paise)}</th></tr>
<tr><td>Paid</td><td class="n">${inr(inv.amount_paid_paise)}</td></tr>
${inv.amount_refunded_paise ? `<tr><td>Refunded</td><td class="n">${inr(inv.amount_refunded_paise)}</td></tr>` : ''}</table>
${inv.payments.filter((p) => p.status !== 'created').map((p) => `<div class="muted">Payment ${esc(p.provider_payment_id || '')} · ${esc(p.method || '')} · ${esc(p.status)} · ${d(p.captured_at)}</div>`).join('')}
<p class="muted">${esc(inv.notes || '')}</p><button class="noprint" onclick="print()">Print / Save as PDF</button></body></html>`;
}
module.exports = { render };
