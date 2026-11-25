'use strict';
/**
 * Initial configuration. Everything here is DATA the platform owner can change from the
 * Owner Console — prices, limits, commissions, fees, rewards, policies. Seeding only inserts
 * missing rows, so owner edits are never overwritten on restart.
 */
const db = require('./index');
const clock = require('../lib/clock');
const { hashPassword } = require('../lib/auth');

const SETTINGS = {
  company: [{ name: 'AgriConnect Marketplace Pvt. Ltd.', address: 'Bengaluru, Karnataka, India', gstin: '' }, 'Legal entity shown on invoices'],
  tax: [{ label: 'GST', rate_bps: 1800 }, 'Tax applied to platform invoices'],
  billing: [{ renewal_invoice_lead_days: 7, renewal_reminder_days: [7, 3, 1], grace_period_days: 7, trial_grace_days: 3, suspension_to_expiry_days: 30, pending_checkout_expiry_hours: 48 }, 'Renewal, reminder, grace and suspension timings'],
  downgrade_policy: [{ excess_listings: 'deactivate_oldest' }, 'What happens to listings above the limit after a downgrade/lapse: deactivate_oldest | deactivate_newest | keep_active (new listings blocked)'],
  commissions: [{ enabled: false, default_charged_to: 'seller', invoice_day_of_month: 1, invoice_due_days: 15 }, 'Transaction commission switch (initial strategy: direct transactions, commission off)'],
  procurement_service_fee: [{ model: 'percentage', rate_bps: 300, fixed_paise: 0, per_kg_paise: 200, min_fee_paise: 50000, max_fee_paise: null }, 'Platform-assisted sourcing fee: fixed | percentage | per_kg | percentage_plus_fixed'],
  logistics_fees: [{ farmer_delivery: { model: 'none' }, buyer_pickup: { model: 'none' }, third_party: { model: 'referral', rate_bps: 300 }, platform_arranged: { model: 'percentage_plus_fixed', rate_bps: 500, fixed_paise: 4900, payer: 'buyer' } }, 'Logistics revenue per delivery mode'],
  referral_program: [{
    enabled: true, max_rewards_per_referrer_per_month: 20,
    farmer: { eligibility: 'first_listing', referrer_reward: { type: 'promotion_credits', value: 2 }, referee_reward: { type: 'promotion_credits', value: 1 } },
    buyer: { eligibility: 'first_completed_order', referrer_reward: { type: 'account_credit', value_paise: 20000 }, referee_reward: { type: 'discount_percent', value_bps: 5000, cycles: 1 } },
  }, 'Referral rewards and eligibility rules'],
  advertising: [{ categories: ['agricultural_equipment', 'seeds', 'growing_supplies', 'packaging', 'cold_storage', 'transport', 'farming_technology', 'hydroponic_equipment', 'greenhouse_equipment', 'agricultural_finance', 'insurance'], placements: { marketplace: { daily_rate_paise: 50000 }, dashboard: { daily_rate_paise: 30000 } } }, 'Sponsored content categories and daily rates'],
  intelligence: [{ min_group_size: 3 }, 'Minimum distinct businesses per aggregated data point'],
  risk: [{ max_failed_payments_24h: 5 }, 'Fraud detection thresholds'],
  refunds: [{ require_separate_approver: true }, 'Four-eyes rule: refund requester cannot approve their own request'],
};

const ENTITLEMENTS = [
  ['max_active_listings', 'Active listings', 'farmer', 'limit', null, '0'],
  ['max_farms', 'Farm locations', 'farmer', 'limit', null, '1'],
  ['max_users', 'Team members', 'both', 'limit', null, '1'],
  ['featured_listing_credits', 'Promotion credits per billing cycle', 'farmer', 'limit', null, '0'],
  ['marketplace_priority', 'Marketplace visibility', 'farmer', 'level', ['standard', 'enhanced', 'priority', 'top'], 'standard'],
  ['analytics_level', 'Analytics', 'both', 'level', ['basic', 'standard', 'advanced', 'enterprise'], 'basic'],
  ['buyer_demand_access', 'Buyer demand board', 'both', 'boolean', null, 'false'],
  ['upcoming_harvest_listings', 'Upcoming harvest listings', 'farmer', 'boolean', null, 'false'],
  ['bulk_inventory_publishing', 'Bulk inventory publishing', 'farmer', 'boolean', null, 'false'],
  ['harvest_forecasting', 'Advanced harvest forecasting', 'farmer', 'boolean', null, 'false'],
  ['export_reports', 'Exportable reports', 'both', 'boolean', null, 'false'],
  ['premium_badge_eligible', 'Premium supplier badge (after verification)', 'farmer', 'boolean', null, 'false'],
  ['priority_notifications', 'Priority notifications', 'both', 'boolean', null, 'false'],
  ['enterprise_api_access', 'API / ERP integration access', 'both', 'boolean', null, 'false'],
  ['max_saved_suppliers', 'Saved suppliers', 'buyer', 'limit', null, '0'],
  ['max_monthly_orders', 'Orders per billing period', 'buyer', 'limit', null, '-1'],
  ['saved_searches', 'Saved searches', 'buyer', 'boolean', null, 'false'],
  ['supplier_comparison', 'Supplier comparison', 'buyer', 'boolean', null, 'false'],
  ['multi_farmer_procurement', 'Multi-farmer sourcing basket', 'buyer', 'boolean', null, 'false'],
  ['bulk_sourcing', 'Bulk order & quotation requests', 'buyer', 'boolean', null, 'false'],
  ['procurement_reports', 'Procurement reports', 'buyer', 'boolean', null, 'false'],
  ['recurring_procurement', 'Recurring procurement', 'buyer', 'boolean', null, 'false'],
  ['supply_shortage_alerts', 'Supply shortage alerts', 'buyer', 'boolean', null, 'false'],
  ['assisted_sourcing_included', 'Assisted sourcing fee included', 'buyer', 'boolean', null, 'false'],
  ['procurement_approval_workflow', 'Procurement approval workflow', 'buyer', 'boolean', null, 'false'],
];

const T = true;
const F = false;
const PLANS = [
  { code: 'farmer_starter', audience: 'farmer', name: 'Farmer Starter', tier_rank: 0, pricing_model: 'free', is_default: 1, commission_bps: 250, target_customers: 'Small farmers, individual growers, new producers, small mushroom & vegetable producers',
    description: 'Everything you need to start selling on AgriConnect — free forever.', prices: [],
    ent: { max_active_listings: 5, max_farms: 1, max_users: 1, featured_listing_credits: 0, marketplace_priority: 'standard', analytics_level: 'basic', buyer_demand_access: F },
    features: ['Farmer & farm profile', 'Up to 5 active inventory listings', 'Basic inventory management', 'Marketplace visibility', 'Buyer enquiries & direct communication', 'Basic order management', 'Basic dashboard & sales history', 'Limited marketplace notifications'] },
  { code: 'farmer_growth', audience: 'farmer', name: 'Farmer Growth', tier_rank: 1, pricing_model: 'fixed', trial_days: 14, commission_bps: 150, marketplace_visibility: 'enhanced', target_customers: 'Commercial farmers, mushroom growers, hydroponic & greenhouse producers',
    description: 'More listings, buyer demand alerts, harvest planning and promotion credits.',
    prices: [{ billing_frequency: 'monthly', price_paise: 49900 }, { billing_frequency: 'quarterly', price_paise: 139900 }, { billing_frequency: 'annual', price_paise: 499000 }],
    ent: { max_active_listings: 25, max_farms: 3, max_users: 2, featured_listing_credits: 5, marketplace_priority: 'enhanced', analytics_level: 'standard', buyer_demand_access: T, upcoming_harvest_listings: T, priority_notifications: T },
    features: ['Everything in Starter', 'Up to 25 active listings', 'Up to 3 farm locations', 'Enhanced marketplace visibility', 'Buyer demand notifications', 'Harvest planning & upcoming harvest listings', 'Sales analytics & buyer insights', 'Product performance analytics', 'Priority notifications', '5 promotion credits every cycle'] },
  { code: 'farmer_pro', audience: 'farmer', name: 'Farmer Pro', tier_rank: 2, pricing_model: 'fixed', trial_days: 14, commission_bps: 50, marketplace_visibility: 'priority', target_customers: 'Large producers, smart & vertical farms, commercial mushroom farms, high-volume suppliers',
    description: 'Unlimited listings (fair use), multiple farms and staff, advanced analytics and priority exposure.',
    prices: [{ billing_frequency: 'monthly', price_paise: 99900 }, { billing_frequency: 'quarterly', price_paise: 279900 }, { billing_frequency: 'annual', price_paise: 999000 }],
    ent: { max_active_listings: -1, max_farms: 10, max_users: 10, featured_listing_credits: 15, marketplace_priority: 'priority', analytics_level: 'advanced', buyer_demand_access: T, upcoming_harvest_listings: T, bulk_inventory_publishing: T, harvest_forecasting: T, export_reports: T, premium_badge_eligible: T, priority_notifications: T },
    features: ['Everything in Growth', 'Unlimited active listings (fair use)', 'Up to 10 farm locations & staff accounts', 'Bulk inventory publishing', 'Advanced harvest forecasting', 'Advanced & buyer demand analytics', 'Priority marketplace exposure', '15 promotion credits every cycle', 'Premium supplier badge (subject to verification)', 'Exportable reports'] },
  { code: 'farm_enterprise', audience: 'farmer', name: 'Farm Enterprise', tier_rank: 3, pricing_model: 'custom', is_enterprise: 1, marketplace_visibility: 'top', target_customers: 'Large agricultural businesses, multi-location farms, producer groups',
    description: 'Custom-priced platform for multi-location producers with integrations and account management.', prices: [],
    ent: { max_active_listings: -1, max_farms: -1, max_users: -1, featured_listing_credits: 50, marketplace_priority: 'top', analytics_level: 'enterprise', buyer_demand_access: T, upcoming_harvest_listings: T, bulk_inventory_publishing: T, harvest_forecasting: T, export_reports: T, premium_badge_eligible: T, priority_notifications: T, enterprise_api_access: T },
    features: ['Unlimited locations & business users', 'User permission management', 'Enterprise inventory & reporting', 'API & ERP integration readiness', 'Dedicated support & account management', 'Custom integrations'] },
  { code: 'buyer_free', audience: 'buyer', name: 'Buyer Free', tier_rank: 0, pricing_model: 'free', is_default: 1, target_customers: 'Restaurants, small shops, individual wholesale buyers, new buyers',
    description: 'Discover suppliers and order directly from farmers — free.', prices: [],
    ent: { max_saved_suppliers: 5, max_monthly_orders: 20, max_users: 1, analytics_level: 'basic' },
    features: ['Marketplace access & product search', 'Supplier discovery', 'Direct farmer communication', 'Basic order placement & tracking', 'Up to 5 saved suppliers', 'Basic procurement history'] },
  { code: 'buyer_business', audience: 'buyer', name: 'Buyer Business', tier_rank: 1, pricing_model: 'fixed', trial_days: 14, target_customers: 'Wholesalers, restaurants, food distributors, retailers, small exporters',
    description: 'Advanced search, saved searches, supplier comparison and bulk order requests.',
    prices: [{ billing_frequency: 'monthly', price_paise: 99900 }, { billing_frequency: 'quarterly', price_paise: 279900 }, { billing_frequency: 'annual', price_paise: 999000 }],
    ent: { max_saved_suppliers: 50, max_monthly_orders: 200, max_users: 3, analytics_level: 'standard', saved_searches: T, supplier_comparison: T, bulk_sourcing: T, buyer_demand_access: T, recurring_procurement: T, priority_notifications: T },
    features: ['Everything in Free', 'Unlimited supplier discovery', 'Up to 50 saved suppliers', 'Advanced & saved searches', 'Supplier & price comparison', 'Buyer demand board', 'Bulk order requests', 'Procurement analytics', 'Recurring procurement requirements', 'Priority notifications'] },
  { code: 'buyer_pro', audience: 'buyer', name: 'Buyer Pro', tier_rank: 2, pricing_model: 'fixed', trial_days: 14, target_customers: 'Exporters, large wholesalers, supermarkets, food processors',
    description: 'Multi-farmer sourcing baskets, shortage alerts, team accounts and exportable reports.',
    prices: [{ billing_frequency: 'monthly', price_paise: 249900 }, { billing_frequency: 'quarterly', price_paise: 699900 }, { billing_frequency: 'annual', price_paise: 2499000 }],
    ent: { max_saved_suppliers: -1, max_monthly_orders: -1, max_users: 10, analytics_level: 'advanced', saved_searches: T, supplier_comparison: T, bulk_sourcing: T, buyer_demand_access: T, recurring_procurement: T, multi_farmer_procurement: T, procurement_reports: T, supply_shortage_alerts: T, export_reports: T, priority_notifications: T },
    features: ['Everything in Business', 'Multi-farmer sourcing & aggregated inventory', 'Bulk procurement basket', 'Supply shortage alerts', 'Supplier performance reports', 'Procurement templates & recurring procurement', 'Bulk quotation requests', 'Team accounts (up to 10)', 'Exportable procurement reports', 'Priority buyer support'] },
  { code: 'buyer_enterprise', audience: 'buyer', name: 'Enterprise Buyer', tier_rank: 3, pricing_model: 'custom', is_enterprise: 1, target_customers: 'Retail & restaurant chains, food processors, exporters, institutional procurement',
    description: 'Enterprise sourcing with approvals, multi-location delivery, SLAs and a dedicated account manager.', prices: [],
    ent: { max_saved_suppliers: -1, max_monthly_orders: -1, max_users: -1, analytics_level: 'enterprise', saved_searches: T, supplier_comparison: T, bulk_sourcing: T, buyer_demand_access: T, recurring_procurement: T, multi_farmer_procurement: T, procurement_reports: T, supply_shortage_alerts: T, export_reports: T, priority_notifications: T, assisted_sourcing_included: T, procurement_approval_workflow: T, enterprise_api_access: T },
    features: ['Everything in Pro', 'Unlimited procurement users & role-based permissions', 'Procurement approval workflow', 'Multiple delivery locations', 'Platform-assisted sourcing included', 'API & ERP integration readiness', 'Custom supplier network', 'Dedicated account manager & SLA options'] },
];

const PROMOS = [
  ['featured_24h', 'Featured Listing – 24 Hours', 'featured', 24, 9900, 1],
  ['featured_3d', 'Featured Listing – 3 Days', 'featured', 72, 24900, 2],
  ['featured_7d', 'Featured Listing – 7 Days', 'featured', 168, 49900, 4],
  ['category_7d', 'Category Promotion – 7 Days', 'category', 168, 34900, 3, { requires_category: 1 }],
  ['regional_7d', 'Regional Promotion – 7 Days', 'regional', 168, 29900, 3, { requires_region: 1 }],
  ['homepage_24h', 'Homepage Promotion – 24 Hours', 'homepage', 24, 79900, 5, { max_concurrent: 6 }],
  ['urgent_harvest_48h', 'Urgent Harvest Promotion – 48 Hours', 'urgent_harvest', 48, 14900, 1],
];

const REGIONS = [['KA', 'Karnataka'], ['MH', 'Maharashtra'], ['TN', 'Tamil Nadu'], ['KL', 'Kerala'], ['AP', 'Andhra Pradesh'], ['TG', 'Telangana'], ['GJ', 'Gujarat'], ['DL', 'Delhi NCR'], ['PB', 'Punjab'], ['UP', 'Uttar Pradesh'], ['WB', 'West Bengal'], ['RJ', 'Rajasthan']];
const CATEGORIES = [['mushrooms', 'Mushrooms'], ['leafy-greens', 'Leafy Greens'], ['vegetables', 'Vegetables'], ['fruits', 'Fruits'], ['herbs', 'Herbs & Microgreens'], ['exotic-vegetables', 'Exotic Vegetables'], ['grains-pulses', 'Grains & Pulses'], ['spices', 'Spices'], ['flowers', 'Flowers'], ['dairy-eggs', 'Dairy & Eggs']];

function seed({ demo = false } = {}) {
  const now = clock.iso();
  db.tx(() => {
    for (const [k, [v, d]] of Object.entries(SETTINGS)) db.run('INSERT OR IGNORE INTO platform_settings (key, value_json, description, updated_at) VALUES (?,?,?,?)', k, JSON.stringify(v), d, now);
    for (const [c, n] of REGIONS) db.run('INSERT OR IGNORE INTO regions (code, name) VALUES (?,?)', c, n);
    for (const [s, n] of CATEGORIES) db.run('INSERT OR IGNORE INTO categories (slug, name) VALUES (?,?)', s, n);
    for (const [key, label, audience, type, levels, def] of ENTITLEMENTS) db.run('INSERT OR IGNORE INTO entitlement_definitions (key, label, audience, value_type, levels_json, default_value) VALUES (?,?,?,?,?,?)', key, label, audience, type, levels ? JSON.stringify(levels) : null, def);
    PLANS.forEach((p, i) => {
      if (db.one('SELECT 1 FROM subscription_plans WHERE code = ?', p.code)) return;
      const id = db.insert('subscription_plans', { code: p.code, audience: p.audience, name: p.name, description: p.description, target_customers: p.target_customers, tier_rank: p.tier_rank, pricing_model: p.pricing_model, trial_days: p.trial_days || 0, is_default: p.is_default || 0, is_enterprise: p.is_enterprise || 0, marketplace_visibility: p.marketplace_visibility || 'standard', commission_bps: p.commission_bps ?? null, status: 'active', version: 1, sort_order: i, published_at: now, created_at: now, updated_at: now });
      const months = { monthly: 1, quarterly: 3, annual: 12 };
      for (const pr of p.prices) db.insert('plan_prices', { plan_id: id, billing_frequency: pr.billing_frequency, interval_months: months[pr.billing_frequency], price_paise: pr.price_paise });
      p.features.forEach((f, j) => db.insert('subscription_features', { plan_id: id, label: f, sort_order: j }));
      for (const [k, v] of Object.entries(p.ent)) db.insert('subscription_entitlements', { plan_id: id, key: k, value: String(v) });
      db.insert('plan_versions', { plan_id: id, version: 1, snapshot_json: JSON.stringify({ ...p }), change_scope: 'new_only', change_summary: 'Initial plan', published_at: now });
    });
    PROMOS.forEach(([code, name, type, hours, price, credits, extra = {}], i) => db.run('INSERT OR IGNORE INTO promotions (code, name, promotion_type, duration_hours, price_paise, credit_cost, requires_region, requires_category, max_concurrent, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      code, name, type, hours, price, credits, extra.requires_region || 0, extra.requires_category || 0, extra.max_concurrent ?? null, i, now, now));
    if (!db.one('SELECT 1 FROM commission_rules')) {
      db.insert('commission_rules', { name: 'Large orders (≥ ₹1,00,000): 1% capped at ₹2,000', priority: 10, model: 'percentage', rate_bps: 100, max_fee_paise: 200000, charged_to: 'seller', min_order_paise: 10000000, created_at: now, updated_at: now });
      db.insert('commission_rules', { name: 'Launch offer — 0% on mushrooms (example, inactive)', priority: 20, status: 'inactive', model: 'fixed', rate_bps: 0, fixed_paise: 0, charged_to: 'seller', category_id: db.one("SELECT id FROM categories WHERE slug = 'mushrooms'").id, created_at: now, updated_at: now });
    }
    if (!db.one("SELECT 1 FROM accounts WHERE type = 'platform'")) {
      const acct = db.insert('accounts', { type: 'platform', name: 'AgriConnect Platform', created_at: now, status: 'active' });
      const ownerEmail = (process.env.OWNER_EMAIL || 'owner@agriconnect.local').toLowerCase();
      const ownerPw = process.env.OWNER_PASSWORD || 'ChangeMe-Owner-2026';
      db.insert('users', { account_id: acct, email: ownerEmail, name: 'Platform Owner', password_hash: hashPassword(ownerPw), role: 'owner', account_role: 'owner', created_at: now });
      db.insert('users', { account_id: acct, email: (process.env.ADMIN_EMAIL || 'admin@agriconnect.local').toLowerCase(), name: 'Platform Admin', password_hash: hashPassword(process.env.ADMIN_PASSWORD || 'ChangeMe-Admin-2026'), role: 'admin', account_role: 'manager', created_at: now });
      if (!process.env.OWNER_PASSWORD) console.log(`[seed] Owner login ${ownerEmail} / ${ownerPw} — set OWNER_PASSWORD in production.`);
    }
  });
  if (demo) seedDemo();
}

/** Optional marketplace demo data: accounts, farms, listings and orders. No payments are fabricated. */
function seedDemo() {
  if (db.one("SELECT 1 FROM users WHERE email = 'farmer@demo.local'")) return;
  const subs = require('../services/subscriptions');
  const market = require('../services/marketplace');
  const cat = (s) => db.one('SELECT id FROM categories WHERE slug = ?', s).id;
  const mk = (type, email, name, region, business_type) => db.tx(() => {
    const a = db.insert('accounts', { type, name, region, business_type, phone: '9800000000', profile_completed: 1, created_at: clock.iso() });
    db.insert('users', { account_id: a, email, name: `${name} (owner)`, password_hash: hashPassword('demo-pass-123'), role: type, account_role: 'owner', created_at: clock.iso() });
    subs.ensureDefault(a);
    return a;
  });
  const farmers = [mk('farmer', 'farmer@demo.local', 'Green Spore Mushrooms', 'KA', 'mushroom_grower'), mk('farmer', 'farmer2@demo.local', 'HydroLeaf Farms', 'KA', 'hydroponic'), mk('farmer', 'farmer3@demo.local', 'Sahyadri Growers', 'MH', 'vegetable_producer'), mk('farmer', 'farmer4@demo.local', 'Nilgiri Fresh', 'TN', 'greenhouse')];
  const buyers = [mk('buyer', 'buyer@demo.local', 'Spice Route Restaurants', 'KA', 'restaurant_chain'), mk('buyer', 'buyer2@demo.local', 'Coastal Exports', 'MH', 'exporter'), mk('buyer', 'buyer3@demo.local', 'FreshMart Supermarkets', 'KA', 'supermarket')];
  mk('advertiser', 'ads@demo.local', 'AgriTech Cold Chain', 'KA', 'cold_storage');
  const items = [
    [0, 'Oyster Mushrooms', 'mushrooms', 400, 18000], [0, 'Button Mushrooms', 'mushrooms', 250, 22000], [1, 'Hydroponic Lettuce', 'leafy-greens', 300, 12000], [1, 'Basil', 'herbs', 60, 40000],
    [2, 'Tomatoes', 'vegetables', 2000, 2800], [2, 'Onions', 'vegetables', 5000, 2200], [3, 'Exotic Bell Peppers', 'exotic-vegetables', 600, 9000], [3, 'Strawberries', 'fruits', 200, 32000], [0, 'Shiitake Mushrooms', 'mushrooms', 80, 90000],
  ];
  const listings = items.map(([f, n, c, q, p]) => market.createListing(farmers[f], { product_name: n, category_id: cat(c), quantity: q, unit: 'kg', price_per_unit_paise: p, min_order_qty: 5 }));
  const plan = [[0, 0, 40], [1, 2, 50], [2, 4, 300], [0, 1, 25], [1, 0, 120], [2, 6, 60], [0, 2, 30], [1, 5, 500], [2, 7, 20]];
  for (const [b, l, q] of plan) {
    const o = market.placeOrder(buyers[b], { listing_id: listings[l].id, quantity: q });
    const seller = listings[l].account_id;
    const step = (s, acc) => market.updateOrderStatus({ role: 'user' }, acc, o.id, s);
    step('accepted', seller); step('dispatched', seller); step('delivered', buyers[b]); step('completed', buyers[b]);
  }
  console.log('[seed] Demo data created (password for all demo users: demo-pass-123)');
}

module.exports = { seed, SETTINGS, PLANS };
