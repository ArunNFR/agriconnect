'use strict';
/* Small SVG chart kit: stacked bars over time (legend + hover tooltip), horizontal bars, meters.
   Colours come from the validated categorical slots (--s1..--s7) in fixed order. */
const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)'];

/** Revenue streams grouped to ≤7 series so colour identity holds (fixed order, never cycled). */
const STREAMS = [
  { key: 'subscriptions', label: 'Subscriptions', cats: ['farmer_subscription', 'buyer_subscription', 'enterprise_subscription'] },
  { key: 'commissions', label: 'Transaction commissions', cats: ['transaction_commission'] },
  { key: 'promotions', label: 'Featured & promoted', cats: ['featured_listing', 'promoted_inventory'] },
  { key: 'procurement', label: 'Procurement services', cats: ['procurement_service'] },
  { key: 'logistics', label: 'Logistics', cats: ['logistics_commission'] },
  { key: 'advertising', label: 'Advertising', cats: ['advertising'] },
  { key: 'other', label: 'Other', cats: ['other'] },
];

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}
const shortInr = (p) => { const r = p / 100; return Math.abs(r) >= 1e5 ? `₹${(r / 1e5).toFixed(1)}L` : Math.abs(r) >= 1e3 ? `₹${(r / 1e3).toFixed(1)}k` : `₹${Math.round(r)}`; };

/**
 * Stacked bar chart. rows: [{ label, values: {seriesKey: paise} }], series: [{ key, label }]
 */
function stackedBars(container, rows, series, { height = 240 } = {}) {
  const used = series.filter((s) => rows.some((r) => r.values[s.key]));
  const legend = used.length > 1 ? `<div class="legend">${used.map((s) => `<span><i style="background:${SERIES[series.indexOf(s)]}"></i>${esc(s.label)}</span>`).join('')}</div>` : '';
  if (!rows.length) { container.innerHTML = '<p class="muted">No revenue recorded in this period.</p>'; return; }
  const W = 720; const H = height; const L = 56; const B = 26; const T = 8;
  const totals = rows.map((r) => series.reduce((s, x) => s + Math.max(0, r.values[x.key] || 0), 0));
  const max = niceMax(Math.max(...totals));
  const bw = (W - L) / rows.length;
  const barW = Math.max(3, Math.min(36, bw - 4));
  const y = (v) => T + (H - T - B) * (1 - v / max);
  let svg = '';
  for (let i = 0; i <= 4; i++) { const v = (max / 4) * i; svg += `<line class="grid-line" x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${shortInr(v)}</text>`; }
  const every = Math.ceil(rows.length / 8);
  rows.forEach((r, i) => {
    const x = L + i * bw + (bw - barW) / 2;
    let acc = 0;
    const segs = series.map((s, si) => ({ s, si, v: Math.max(0, r.values[s.key] || 0) })).filter((z) => z.v > 0);
    segs.forEach((z, k) => {
      const y1 = y(acc + z.v); const y0 = y(acc); acc += z.v;
      const h = Math.max(0, y0 - y1 - (k < segs.length - 1 ? 2 : 0)); // 2px surface gap between segments
      const top = k === segs.length - 1;
      svg += top ? `<path d="M${x},${y1 + h} V${y1 + 4} q0,-4 4,-4 H${x + barW - 4} q4,0 4,4 V${y1 + h} Z" fill="${SERIES[z.si]}"/>` : `<rect x="${x}" y="${y1 + (k < segs.length - 1 ? 2 : 0)}" width="${barW}" height="${h}" fill="${SERIES[z.si]}"/>`;
    });
    svg += `<rect data-i="${i}" x="${L + i * bw}" y="${T}" width="${bw}" height="${H - T - B}" fill="transparent"/>`;
    if (i % every === 0) svg += `<text class="axis" x="${x + barW / 2}" y="${H - 8}" text-anchor="middle">${esc(r.short || r.label)}</text>`;
  });
  container.innerHTML = `${legend}<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Revenue by stream over time">${svg}</svg><div class="tip" hidden></div></div>`;
  const tip = container.querySelector('.tip');
  const chart = container.querySelector('.chart');
  container.querySelector('svg').addEventListener('mousemove', (ev) => {
    const i = ev.target.dataset?.i;
    if (i === undefined) { tip.hidden = true; return; }
    const r = rows[i];
    tip.innerHTML = `<div class="t">${esc(r.label)}</div>${series.filter((s) => r.values[s.key]).map((s) => `<div class="l"><span><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${SERIES[series.indexOf(s)]};margin-right:4px"></i>${esc(s.label)}</span><span class="num">${inr(r.values[s.key])}</span></div>`).join('')}<div class="l" style="border-top:1px solid var(--border);margin-top:4px;padding-top:4px"><strong>Total</strong><strong class="num">${inr(totals[i])}</strong></div>`;
    tip.hidden = false;
    const rect = chart.getBoundingClientRect();
    const xpx = ev.clientX - rect.left;
    tip.style.left = `${Math.min(xpx + 12, rect.width - 180)}px`;
    tip.style.top = `${ev.clientY - rect.top + 12}px`;
  });
  container.querySelector('svg').addEventListener('mouseleave', () => { tip.hidden = true; });
}

/** Horizontal bars for one measure (single colour; the label names the bar). */
function hbars(rows, { value = (r) => r.amount, label = (r) => r.label, fmt = inr } = {}) {
  if (!rows.length) return '<p class="muted">No data for this period.</p>';
  const max = Math.max(...rows.map(value), 1);
  return rows.map((r) => `<div class="hbar" title="${esc(label(r))}: ${esc(fmt(value(r)))}"><span>${esc(label(r))}</span><div class="track"><div class="fill" style="width:${Math.max(0, (value(r) / max) * 100)}%"></div></div><span class="num">${fmt(value(r))}</span></div>`).join('');
}

function meter(used, limit) {
  if (limit < 0) return '<div class="meter"><span style="width:8%"></span></div>';
  if (limit === 0) return '<div class="meter"><span style="width:0"></span></div>';
  const pctv = Math.min(100, Math.round((used / limit) * 100));
  return `<div class="meter ${pctv >= 100 ? 'full' : pctv >= 80 ? 'hot' : ''}"><span style="width:${pctv}%"></span></div>`;
}
