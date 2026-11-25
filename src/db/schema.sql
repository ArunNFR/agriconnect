-- AgriConnect schema: marketplace core + subscription, billing and revenue module.
-- Money is stored as integer paise (₹1 = 100 paise). Rates are integer basis points (1% = 100 bps).
-- Financial tables are append-only / status-driven: DELETE is blocked by triggers at the bottom.

PRAGMA foreign_keys = ON;

-- =====================================================================
-- CORE MARKETPLACE
-- =====================================================================
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('farmer','buyer','advertiser','platform')),
  name TEXT NOT NULL,
  business_type TEXT,                    -- e.g. mushroom_grower, exporter, supermarket
  region TEXT,                           -- region code (state-level)
  city TEXT,
  address TEXT,
  gstin TEXT,
  phone TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  premium_badge INTEGER NOT NULL DEFAULT 0,
  profile_completed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('farmer','buyer','advertiser','admin','owner')),
  account_role TEXT NOT NULL DEFAULT 'owner' CHECK (account_role IN ('owner','manager','staff')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  signup_ip TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS regions (code TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS farms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL,
  farm_type TEXT,
  region TEXT,
  address TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  farm_id INTEGER REFERENCES farms(id),
  category_id INTEGER REFERENCES categories(id),
  product_name TEXT NOT NULL,
  description TEXT,
  quantity REAL NOT NULL,
  unit TEXT NOT NULL DEFAULT 'kg',
  price_per_unit_paise INTEGER NOT NULL,
  min_order_qty REAL NOT NULL DEFAULT 1,
  region TEXT,
  availability TEXT NOT NULL DEFAULT 'available' CHECK (availability IN ('available','upcoming')),
  harvest_date TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','sold_out','archived')),
  deactivated_reason TEXT,
  views INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_listings_account ON listings(account_id, status);

CREATE TABLE IF NOT EXISTS enquiries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  buyer_account_id INTEGER NOT NULL REFERENCES accounts(id),
  seller_account_id INTEGER NOT NULL REFERENCES accounts(id),
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number TEXT UNIQUE NOT NULL,
  buyer_account_id INTEGER NOT NULL REFERENCES accounts(id),
  seller_account_id INTEGER NOT NULL REFERENCES accounts(id),
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  category_id INTEGER,
  region TEXT,
  quantity REAL NOT NULL,
  unit TEXT NOT NULL,
  unit_price_paise INTEGER NOT NULL,
  subtotal_paise INTEGER NOT NULL,
  buyer_fee_paise INTEGER NOT NULL DEFAULT 0,      -- platform charges payable by buyer
  seller_fee_paise INTEGER NOT NULL DEFAULT 0,     -- platform charges payable by / deducted from seller
  logistics_charge_paise INTEGER NOT NULL DEFAULT 0,
  total_buyer_paise INTEGER NOT NULL,
  seller_payout_paise INTEGER NOT NULL,
  order_type TEXT NOT NULL DEFAULT 'standard' CHECK (order_type IN ('standard','bulk','multi_farmer','procurement','recurring')),
  basket_ref TEXT,
  procurement_service_id INTEGER,
  delivery_mode TEXT NOT NULL DEFAULT 'buyer_pickup' CHECK (delivery_mode IN ('farmer_delivery','buyer_pickup','third_party','platform_arranged')),
  delivery_address TEXT,
  promotion_purchase_id INTEGER,                    -- attribution for promotion analytics
  status TEXT NOT NULL DEFAULT 'placed' CHECK (status IN ('placed','accepted','dispatched','delivered','completed','cancelled','rejected')),
  placed_at TEXT NOT NULL,
  completed_at TEXT,
  cancelled_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_orders_buyer ON orders(buyer_account_id, placed_at);
CREATE INDEX IF NOT EXISTS ix_orders_seller ON orders(seller_account_id, placed_at);

CREATE TABLE IF NOT EXISTS saved_suppliers (
  buyer_account_id INTEGER NOT NULL REFERENCES accounts(id),
  supplier_account_id INTEGER NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (buyer_account_id, supplier_account_id)
);

CREATE TABLE IF NOT EXISTS saved_searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL,
  query_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS search_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER,
  query TEXT,
  category_id INTEGER,
  region TEXT,
  results INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  user_id INTEGER,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  data_json TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_notifications_account ON notifications(account_id, created_at);

-- Outbound channel queue (email / SMS / WhatsApp providers plug in here)
CREATE TABLE IF NOT EXISTS notification_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_id INTEGER REFERENCES notifications(id),
  channel TEXT NOT NULL,
  recipient TEXT NOT NULL,
  subject TEXT,
  body TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  dedupe_key TEXT UNIQUE,
  created_at TEXT NOT NULL
);

-- Monetisation configuration (prices, fees, policies). Values are JSON. Never hardcoded in code.
CREATE TABLE IF NOT EXISTS platform_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  description TEXT,
  updated_by INTEGER,
  updated_at TEXT NOT NULL
);

-- =====================================================================
-- SUBSCRIPTIONS
-- =====================================================================
CREATE TABLE IF NOT EXISTS subscription_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  audience TEXT NOT NULL CHECK (audience IN ('farmer','buyer')),
  name TEXT NOT NULL,
  description TEXT,
  target_customers TEXT,
  tier_rank INTEGER NOT NULL DEFAULT 0,          -- used to classify upgrade vs downgrade
  pricing_model TEXT NOT NULL CHECK (pricing_model IN ('free','fixed','custom')),
  trial_days INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,          -- plan new accounts land on (must be free)
  is_enterprise INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','hidden')),
  marketplace_visibility TEXT NOT NULL DEFAULT 'standard',
  commission_bps INTEGER,                        -- plan-level commission fallback (NULL = none)
  commission_fixed_paise INTEGER,
  discount_eligible INTEGER NOT NULL DEFAULT 1,
  upgrade_to_json TEXT NOT NULL DEFAULT '[]',     -- allowed target plan codes ([] = any higher tier)
  downgrade_to_json TEXT NOT NULL DEFAULT '[]',   -- allowed target plan codes ([] = any lower tier)
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','inactive','archived')),
  version INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  published_at TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Price points per billing frequency (monthly / quarterly / annual / custom) incl. promotional pricing
CREATE TABLE IF NOT EXISTS plan_prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES subscription_plans(id),
  billing_frequency TEXT NOT NULL CHECK (billing_frequency IN ('monthly','quarterly','annual','custom')),
  interval_months INTEGER NOT NULL,
  price_paise INTEGER NOT NULL,
  promo_price_paise INTEGER,
  promo_label TEXT,
  promo_valid_until TEXT,
  promo_cycles INTEGER NOT NULL DEFAULT 1,      -- number of cycles promo price applies
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  UNIQUE (plan_id, billing_frequency)
);

CREATE TABLE IF NOT EXISTS subscription_features (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES subscription_plans(id),
  label TEXT NOT NULL,
  highlight INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- Catalogue of entitlement keys the backend understands
CREATE TABLE IF NOT EXISTS entitlement_definitions (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'both',
  value_type TEXT NOT NULL CHECK (value_type IN ('limit','boolean','level')),
  levels_json TEXT,                              -- ordered levels for value_type=level
  default_value TEXT NOT NULL,
  description TEXT
);

-- Per-plan entitlement values. limit: integer, -1 = unlimited (fair use); boolean: 'true'/'false'; level: one of levels
CREATE TABLE IF NOT EXISTS subscription_entitlements (
  plan_id INTEGER NOT NULL REFERENCES subscription_plans(id),
  key TEXT NOT NULL REFERENCES entitlement_definitions(key),
  value TEXT NOT NULL,
  PRIMARY KEY (plan_id, key)
);

-- Immutable record of every published plan version (for "apply at next renewal" and audits)
CREATE TABLE IF NOT EXISTS plan_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES subscription_plans(id),
  version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  change_scope TEXT,                             -- new_only | next_renewal | immediate
  change_summary TEXT,
  published_by INTEGER,
  published_at TEXT NOT NULL,
  UNIQUE (plan_id, version)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  plan_id INTEGER NOT NULL REFERENCES subscription_plans(id),
  plan_version INTEGER NOT NULL,
  plan_price_id INTEGER REFERENCES plan_prices(id),
  billing_frequency TEXT,
  interval_months INTEGER,
  price_paise INTEGER NOT NULL DEFAULT 0,        -- recurring price locked for this subscription
  status TEXT NOT NULL CHECK (status IN ('pending','trial','active','payment_failed','past_due','suspended','cancelled','expired')),
  is_current INTEGER NOT NULL DEFAULT 0,         -- exactly one current subscription per account
  entitlements_json TEXT NOT NULL,               -- entitlement snapshot governing access
  refresh_on_renewal INTEGER NOT NULL DEFAULT 0, -- plan changed with scope next_renewal
  trial_ends_at TEXT,
  current_period_start TEXT,
  current_period_end TEXT,
  next_billing_at TEXT,
  grace_ends_at TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  cancel_reason TEXT,
  cancelled_at TEXT,
  scheduled_plan_id INTEGER REFERENCES subscription_plans(id),
  scheduled_frequency TEXT,
  previous_subscription_id INTEGER REFERENCES subscriptions(id),
  discount_code_id INTEGER,
  discount_cycles_remaining INTEGER NOT NULL DEFAULT 0,
  promo_cycles_remaining INTEGER NOT NULL DEFAULT 0,
  is_custom_contract INTEGER NOT NULL DEFAULT 0,
  activated_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_subscriptions_account ON subscriptions(account_id, is_current);
CREATE UNIQUE INDEX IF NOT EXISTS ux_subscriptions_current ON subscriptions(account_id) WHERE is_current = 1;

CREATE TABLE IF NOT EXISTS subscription_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER REFERENCES subscriptions(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  event TEXT NOT NULL,      -- created, activated, trial_started, trial_converted, renewed, upgraded, downgrade_scheduled, downgraded, cancel_scheduled, cancel_reverted, cancelled, payment_failed, past_due, restored, suspended, expired, plan_changed
  from_plan_id INTEGER,
  to_plan_id INTEGER,
  from_status TEXT,
  to_status TEXT,
  amount_paise INTEGER,
  metadata_json TEXT,
  actor_user_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sub_history_event ON subscription_history(event, created_at);

-- Cycle-based usage counters (e.g. featured credits consumed, monthly orders)
CREATE TABLE IF NOT EXISTS subscription_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  subscription_id INTEGER REFERENCES subscriptions(id),
  metric TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE (account_id, metric, period_start)
);

CREATE TABLE IF NOT EXISTS billing_cycles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL REFERENCES subscriptions(id),
  cycle_number INTEGER NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  invoice_id INTEGER,
  amount_paise INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('upcoming','invoiced','paid','failed','waived','void')),
  created_at TEXT NOT NULL,
  UNIQUE (subscription_id, cycle_number)
);

CREATE TABLE IF NOT EXISTS enterprise_enquiries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  plan_id INTEGER NOT NULL REFERENCES subscription_plans(id),
  requirements TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','quoted','converted','closed')),
  quoted_price_paise INTEGER,
  quoted_frequency TEXT,
  subscription_id INTEGER,
  handled_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS upgrade_prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  entitlement_key TEXT NOT NULL,
  context TEXT,
  created_at TEXT NOT NULL
);

-- =====================================================================
-- PAYMENTS & BILLING
-- =====================================================================
CREATE TABLE IF NOT EXISTS payment_methods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  provider TEXT NOT NULL,
  method_type TEXT NOT NULL,       -- upi, card, netbanking, wallet, emi
  label TEXT NOT NULL,             -- masked (never full card numbers)
  provider_token TEXT,             -- provider-side token/customer reference for future auto-debit
  is_default INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  created_at TEXT NOT NULL,
  UNIQUE (account_id, provider, label)
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_number TEXT UNIQUE NOT NULL,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  invoice_type TEXT NOT NULL CHECK (invoice_type IN ('subscription','promotion','procurement','logistics','advertising','commission','other')),
  status TEXT NOT NULL CHECK (status IN ('issued','paid','void','overdue','refunded','partially_refunded')),
  subscription_id INTEGER REFERENCES subscriptions(id),
  billing_cycle_id INTEGER,
  related_type TEXT,
  related_id INTEGER,
  currency TEXT NOT NULL DEFAULT 'INR',
  subtotal_paise INTEGER NOT NULL,
  discount_paise INTEGER NOT NULL DEFAULT 0,
  credit_applied_paise INTEGER NOT NULL DEFAULT 0,
  tax_paise INTEGER NOT NULL DEFAULT 0,
  total_paise INTEGER NOT NULL,
  amount_paid_paise INTEGER NOT NULL DEFAULT 0,
  amount_refunded_paise INTEGER NOT NULL DEFAULT 0,
  tax_rate_bps INTEGER NOT NULL DEFAULT 0,
  billing_name TEXT,
  billing_gstin TEXT,
  billing_address TEXT,
  due_at TEXT,
  issued_at TEXT NOT NULL,
  paid_at TEXT,
  voided_at TEXT,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS ix_invoices_account ON invoices(account_id, issued_at);

CREATE TABLE IF NOT EXISTS invoice_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  description TEXT NOT NULL,
  item_type TEXT NOT NULL,           -- plan, proration_credit, discount, promotion, commission, procurement_fee, logistics_fee, advertising, credit
  quantity REAL NOT NULL DEFAULT 1,
  unit_amount_paise INTEGER NOT NULL,
  amount_paise INTEGER NOT NULL,
  related_type TEXT,
  related_id INTEGER
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  provider TEXT NOT NULL,
  provider_order_id TEXT UNIQUE,
  provider_payment_id TEXT UNIQUE,
  amount_paise INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  status TEXT NOT NULL CHECK (status IN ('created','authorized','captured','failed','refunded','partially_refunded','cancelled')),
  method TEXT,
  payment_method_id INTEGER REFERENCES payment_methods(id),
  verified_via TEXT,                   -- signature+api | webhook
  failure_reason TEXT,
  amount_refunded_paise INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT,
  captured_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_payments_invoice ON payments(invoice_id);

CREATE TABLE IF NOT EXISTS payment_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER NOT NULL REFERENCES payments(id),
  provider_payment_id TEXT,
  status TEXT NOT NULL,
  method TEXT,
  error_code TEXT,
  error_description TEXT,
  source TEXT NOT NULL,              -- client_callback | webhook | api_fetch | reconciliation
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  signature_valid INTEGER NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'received', -- received, processed, ignored, failed, rejected
  error TEXT,
  received_at TEXT NOT NULL,
  UNIQUE (provider, event_id)
);

CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER NOT NULL REFERENCES payments(id),
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  amount_paise INTEGER NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('requested','approved','rejected','processing','processed','failed')),
  provider_refund_id TEXT UNIQUE,
  requested_by INTEGER,
  approved_by INTEGER,
  decision_notes TEXT,
  created_at TEXT NOT NULL,
  processed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_disputes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER REFERENCES payments(id),
  provider_dispute_id TEXT UNIQUE,
  amount_paise INTEGER NOT NULL,
  reason TEXT,
  status TEXT NOT NULL CHECK (status IN ('open','under_review','won','lost','closed')),
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS discount_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  description TEXT,
  discount_type TEXT NOT NULL CHECK (discount_type IN ('percent','fixed')),
  value INTEGER NOT NULL,                  -- bps for percent, paise for fixed
  applies_to TEXT NOT NULL DEFAULT 'subscription' CHECK (applies_to IN ('subscription','promotion','any')),
  audience TEXT CHECK (audience IN ('farmer','buyer')),
  plan_ids_json TEXT,                      -- NULL = all eligible plans
  frequencies_json TEXT,                   -- NULL = all frequencies
  region TEXT,
  duration_cycles INTEGER NOT NULL DEFAULT 1,
  max_redemptions INTEGER,
  per_account_limit INTEGER NOT NULL DEFAULT 1,
  new_customers_only INTEGER NOT NULL DEFAULT 0,
  restricted_account_id INTEGER,           -- personal codes (e.g. referral rewards)
  valid_from TEXT,
  valid_until TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  source TEXT NOT NULL DEFAULT 'admin',    -- admin | referral | launch_offer
  created_by INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS discount_redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discount_code_id INTEGER NOT NULL REFERENCES discount_codes(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  invoice_id INTEGER REFERENCES invoices(id),
  subscription_id INTEGER,
  amount_paise INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','applied','released')),
  created_at TEXT NOT NULL
);

-- Credits: promotion credits (count) and account credit (paise)
CREATE TABLE IF NOT EXISTS credit_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  credit_type TEXT NOT NULL CHECK (credit_type IN ('promotion','account')),
  amount INTEGER NOT NULL,                 -- +grant / -spend
  reason TEXT NOT NULL,
  related_type TEXT,
  related_id INTEGER,
  expires_at TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT NOT NULL,
  account_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code INTEGER,
  response_json TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (key, account_id, endpoint)
);

-- =====================================================================
-- COMMISSIONS
-- =====================================================================
CREATE TABLE IF NOT EXISTS commission_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,          -- higher wins
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  model TEXT NOT NULL CHECK (model IN ('percentage','fixed','percentage_plus_fixed')),
  rate_bps INTEGER NOT NULL DEFAULT 0,
  fixed_paise INTEGER NOT NULL DEFAULT 0,
  min_fee_paise INTEGER,
  max_fee_paise INTEGER,
  charged_to TEXT NOT NULL CHECK (charged_to IN ('seller','buyer','both','included_in_price','deducted_from_payout')),
  buyer_share_bps INTEGER NOT NULL DEFAULT 5000,  -- share borne by buyer when charged_to = both
  seller_plan_id INTEGER REFERENCES subscription_plans(id),
  buyer_plan_id INTEGER REFERENCES subscription_plans(id),
  category_id INTEGER REFERENCES categories(id),
  region TEXT,
  order_type TEXT,
  min_order_paise INTEGER,
  max_order_paise INTEGER,
  valid_from TEXT,
  valid_until TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transaction_commissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  rule_id INTEGER REFERENCES commission_rules(id),
  rule_source TEXT NOT NULL,                     -- rule | plan | none
  rule_snapshot_json TEXT NOT NULL,
  order_value_paise INTEGER NOT NULL,
  commission_paise INTEGER NOT NULL,
  buyer_portion_paise INTEGER NOT NULL,
  seller_portion_paise INTEGER NOT NULL,
  charged_to TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','recognised','invoiced','void','reversed')),
  recognised_at TEXT,
  invoice_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- =====================================================================
-- PROMOTIONS
-- =====================================================================
CREATE TABLE IF NOT EXISTS promotions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  promotion_type TEXT NOT NULL CHECK (promotion_type IN ('featured','category','regional','homepage','urgent_harvest')),
  description TEXT,
  duration_hours INTEGER NOT NULL,
  price_paise INTEGER NOT NULL,
  credit_cost INTEGER NOT NULL DEFAULT 1,       -- promotion credits needed instead of paying
  requires_region INTEGER NOT NULL DEFAULT 0,
  requires_category INTEGER NOT NULL DEFAULT 0,
  max_concurrent INTEGER,                       -- slot cap per target (NULL = unlimited)
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS promotion_purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  promotion_id INTEGER NOT NULL REFERENCES promotions(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  target_region TEXT,
  target_category_id INTEGER,
  price_paise INTEGER NOT NULL,                 -- list price at purchase
  amount_charged_paise INTEGER NOT NULL,        -- 0 when paid with credits
  paid_with TEXT NOT NULL CHECK (paid_with IN ('payment','plan_credits','bonus_credits')),
  credits_used INTEGER NOT NULL DEFAULT 0,
  invoice_id INTEGER REFERENCES invoices(id),
  status TEXT NOT NULL CHECK (status IN ('pending_payment','active','expired','cancelled')),
  starts_at TEXT,
  ends_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_promo_purchases_active ON promotion_purchases(status, ends_at);

CREATE TABLE IF NOT EXISTS promotion_analytics (
  purchase_id INTEGER NOT NULL REFERENCES promotion_purchases(id),
  day TEXT NOT NULL,
  impressions INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  enquiries INTEGER NOT NULL DEFAULT 0,
  orders INTEGER NOT NULL DEFAULT 0,
  revenue_paise INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (purchase_id, day)
);

-- =====================================================================
-- PROCUREMENT SERVICES
-- =====================================================================
CREATE TABLE IF NOT EXISTS procurement_services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT UNIQUE NOT NULL,
  buyer_account_id INTEGER NOT NULL REFERENCES accounts(id),
  product_name TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id),
  quantity REAL NOT NULL,
  unit TEXT NOT NULL DEFAULT 'kg',
  required_by TEXT,
  delivery_location TEXT,
  delivery_region TEXT,
  target_price_paise INTEGER,
  notes TEXT,
  sourcing_mode TEXT NOT NULL CHECK (sourcing_mode IN ('self','assisted')),
  status TEXT NOT NULL CHECK (status IN ('open','submitted','under_review','sourcing','proposal_sent','approved','fulfilling','completed','cancelled','rejected','closed')),
  fee_config_json TEXT,                          -- fee model snapshot at submission
  fee_waived INTEGER NOT NULL DEFAULT 0,         -- covered by subscription entitlement
  assigned_to INTEGER,
  proposal_notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS procurement_service_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id INTEGER NOT NULL REFERENCES procurement_services(id),
  supplier_account_id INTEGER NOT NULL REFERENCES accounts(id),
  listing_id INTEGER REFERENCES listings(id),
  quantity REAL NOT NULL,
  unit_price_paise INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed','contacted','confirmed','declined','ordered')),
  order_id INTEGER REFERENCES orders(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS procurement_service_fees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id INTEGER NOT NULL UNIQUE REFERENCES procurement_services(id),
  fee_model TEXT NOT NULL,
  basis_value_paise INTEGER NOT NULL,
  basis_quantity REAL NOT NULL,
  fee_paise INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('calculated','invoiced','paid','waived','void')),
  invoice_id INTEGER REFERENCES invoices(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- =====================================================================
-- LOGISTICS
-- =====================================================================
CREATE TABLE IF NOT EXISTS logistics_providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact_phone TEXT,
  contact_email TEXT,
  vehicle_types TEXT,
  regions TEXT,
  referral_commission_bps INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS logistics_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  mode TEXT NOT NULL CHECK (mode IN ('farmer_delivery','buyer_pickup','third_party','platform_arranged')),
  provider_id INTEGER REFERENCES logistics_providers(id),
  vehicle TEXT,
  pickup_location TEXT,
  delivery_location TEXT,
  transport_charge_paise INTEGER NOT NULL DEFAULT 0,
  platform_fee_paise INTEGER NOT NULL DEFAULT 0,
  fee_config_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('requested','scheduled','picked_up','in_transit','delivered','cancelled')),
  pickup_time TEXT,
  delivery_time TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS logistics_commissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  logistics_transaction_id INTEGER NOT NULL UNIQUE REFERENCES logistics_transactions(id),
  amount_paise INTEGER NOT NULL,
  payer_account_id INTEGER REFERENCES accounts(id),
  commission_type TEXT NOT NULL,                 -- coordination_fee | referral_commission | percentage | fixed
  status TEXT NOT NULL CHECK (status IN ('pending','recognised','invoiced','void')),
  invoice_id INTEGER,
  recognised_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- =====================================================================
-- ADVERTISING
-- =====================================================================
CREATE TABLE IF NOT EXISTS advertisements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  advertiser_account_id INTEGER NOT NULL REFERENCES accounts(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  cta_label TEXT,
  cta_url TEXT,
  ad_category TEXT NOT NULL,     -- agricultural_equipment, seeds, growing_supplies, packaging, cold_storage, transport, farming_technology, hydroponic_equipment, greenhouse_equipment, agricultural_finance, insurance
  placement TEXT NOT NULL DEFAULT 'marketplace',
  target_audience TEXT NOT NULL DEFAULT 'all' CHECK (target_audience IN ('farmer','buyer','all')),
  target_region TEXT,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  price_paise INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','pending_review','approved','active','paused','ended','rejected')),
  review_notes TEXT,
  reviewed_by INTEGER,
  invoice_id INTEGER REFERENCES invoices(id),
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- =====================================================================
-- REFERRALS
-- =====================================================================
CREATE TABLE IF NOT EXISTS referral_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL UNIQUE REFERENCES accounts(id),
  code TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referral_code_id INTEGER NOT NULL REFERENCES referral_codes(id),
  referrer_account_id INTEGER NOT NULL REFERENCES accounts(id),
  referee_account_id INTEGER NOT NULL UNIQUE REFERENCES accounts(id),
  referee_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('registered','eligible','rewarded','rejected')),
  eligibility_rule TEXT,
  referrer_reward_json TEXT,
  referee_reward_json TEXT,
  rejection_reason TEXT,
  created_at TEXT NOT NULL,
  rewarded_at TEXT,
  updated_at TEXT NOT NULL
);

-- =====================================================================
-- REVENUE, AUDIT, RISK
-- =====================================================================
CREATE TABLE IF NOT EXISTS revenue_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL CHECK (category IN ('farmer_subscription','buyer_subscription','enterprise_subscription','transaction_commission','featured_listing','promoted_inventory','procurement_service','logistics_commission','advertising','other')),
  entry_type TEXT NOT NULL CHECK (entry_type IN ('revenue','reversal','adjustment')),
  amount_paise INTEGER NOT NULL,            -- net of tax; negative for reversals
  tax_paise INTEGER NOT NULL DEFAULT 0,
  account_id INTEGER REFERENCES accounts(id),
  account_type TEXT,
  region TEXT,
  plan_id INTEGER,
  source_type TEXT NOT NULL,
  source_id INTEGER,
  payment_id INTEGER REFERENCES payments(id),
  invoice_id INTEGER REFERENCES invoices(id),
  order_id INTEGER REFERENCES orders(id),
  recognised_at TEXT NOT NULL,
  notes TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (source_type, source_id, entry_type, payment_id)
);
CREATE INDEX IF NOT EXISTS ix_revenue_date ON revenue_records(recognised_at, category);

CREATE TABLE IF NOT EXISTS financial_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER,
  actor_role TEXT NOT NULL,         -- owner, admin, user, system, provider
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  before_json TEXT,
  after_json TEXT,
  reason TEXT,
  ip TEXT,
  prev_hash TEXT,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS risk_flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER REFERENCES accounts(id),
  flag_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low','medium','high')),
  details_json TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewed','dismissed')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invoice_sequences (fy TEXT PRIMARY KEY, last_number INTEGER NOT NULL);

-- =====================================================================
-- FINANCIAL CONTROLS: financial records are never deleted
-- =====================================================================
CREATE TRIGGER IF NOT EXISTS trg_no_delete_payments BEFORE DELETE ON payments BEGIN SELECT RAISE(ABORT, 'financial records cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS trg_no_delete_payment_attempts BEFORE DELETE ON payment_attempts BEGIN SELECT RAISE(ABORT, 'financial records cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS trg_no_delete_payment_events BEFORE DELETE ON payment_events BEGIN SELECT RAISE(ABORT, 'financial records cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS trg_no_delete_invoices BEFORE DELETE ON invoices BEGIN SELECT RAISE(ABORT, 'financial records cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS trg_no_delete_invoice_items BEFORE DELETE ON invoice_items BEGIN SELECT RAISE(ABORT, 'financial records cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS trg_no_delete_refunds BEFORE DELETE ON refunds BEGIN SELECT RAISE(ABORT, 'financial records cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS trg_no_delete_revenue BEFORE DELETE ON revenue_records BEGIN SELECT RAISE(ABORT, 'financial records cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS trg_no_delete_txn_comm BEFORE DELETE ON transaction_commissions BEGIN SELECT RAISE(ABORT, 'financial records cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS trg_no_delete_subscriptions BEFORE DELETE ON subscriptions BEGIN SELECT RAISE(ABORT, 'financial records cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS trg_no_delete_sub_history BEFORE DELETE ON subscription_history BEGIN SELECT RAISE(ABORT, 'financial records cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS trg_no_delete_billing_cycles BEFORE DELETE ON billing_cycles BEGIN SELECT RAISE(ABORT, 'financial records cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS trg_no_delete_promo_purchases BEFORE DELETE ON promotion_purchases BEGIN SELECT RAISE(ABORT, 'financial records cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS trg_no_delete_proc_fees BEFORE DELETE ON procurement_service_fees BEGIN SELECT RAISE(ABORT, 'financial records cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS trg_no_delete_log_comm BEFORE DELETE ON logistics_commissions BEGIN SELECT RAISE(ABORT, 'financial records cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS trg_no_delete_credit_ledger BEFORE DELETE ON credit_ledger BEGIN SELECT RAISE(ABORT, 'financial records cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS trg_no_delete_discount_redemptions BEFORE DELETE ON discount_redemptions BEGIN SELECT RAISE(ABORT, 'financial records cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS trg_no_delete_orders BEFORE DELETE ON orders BEGIN SELECT RAISE(ABORT, 'orders cannot be deleted'); END;
-- Append-only ledgers: no updates either
CREATE TRIGGER IF NOT EXISTS trg_no_update_revenue BEFORE UPDATE ON revenue_records BEGIN SELECT RAISE(ABORT, 'revenue records are append-only; post a reversal or adjustment'); END;
CREATE TRIGGER IF NOT EXISTS trg_no_update_credit_ledger BEFORE UPDATE ON credit_ledger BEGIN SELECT RAISE(ABORT, 'credit ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_no_update_audit BEFORE UPDATE ON financial_audit_logs BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_no_delete_audit BEFORE DELETE ON financial_audit_logs BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_no_update_sub_history BEFORE UPDATE ON subscription_history BEGIN SELECT RAISE(ABORT, 'subscription history is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_no_update_payment_attempts BEFORE UPDATE ON payment_attempts BEGIN SELECT RAISE(ABORT, 'payment attempts are append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_no_update_invoice_items BEFORE UPDATE ON invoice_items BEGIN SELECT RAISE(ABORT, 'invoice items are immutable; issue a new invoice'); END;
-- Issued invoice amounts are immutable
CREATE TRIGGER IF NOT EXISTS trg_invoice_amounts_immutable BEFORE UPDATE OF subtotal_paise, discount_paise, tax_paise, total_paise, account_id, invoice_number ON invoices
BEGIN SELECT RAISE(ABORT, 'invoice amounts are immutable; void and re-issue'); END;
