# AgriConnect — Subscriptions, Revenue & Platform Owner module

A B2B agricultural marketplace (farmers ↔ buyers) with a working subscription engine, Razorpay billing,
and nine revenue streams, all configurable from the Owner Console. There are no hardcoded prices, limits, fees or rewards.

## Run

```bash
npm install
npm run dev      # seeds demo farmers/buyers/listings/orders (no fake payments)
npm start        # clean start
npm test         # 24 integration tests
```

Open http://localhost:3000. Logins (change them with `OWNER_PASSWORD` / `ADMIN_PASSWORD`):

| Role | Email | Password |
|---|---|---|
| Platform owner | owner@agriconnect.local | ChangeMe-Owner-2026 |
| Administrator | admin@agriconnect.local | ChangeMe-Admin-2026 |
| Demo farmer / buyer / advertiser (`npm run dev`) | farmer@demo.local · buyer@demo.local · ads@demo.local | demo-pass-123 |

### Payments (Razorpay)

```
RAZORPAY_KEY_ID=rzp_test_...  RAZORPAY_KEY_SECRET=...  RAZORPAY_WEBHOOK_SECRET=...
```

Point a Razorpay webhook at `POST /api/webhooks/razorpay` with these events: `payment.captured`, `order.paid`, `payment.failed`,
`refund.processed`, `refund.failed`, `payment.dispute.*`. Without credentials, paid checkout returns **503** and nothing is activated.
Free plans work without any payment setup.

Other env: `PORT`, `DATABASE_PATH` (SQLite file, default `data/agriconnect.db`), `JOB_INTERVAL_MS` (billing scheduler, default 5 min).

## Architecture

```
src/
  db/schema.sql        all tables + triggers that forbid deleting/rewriting financial records
  db/seed.js           initial plans, prices, entitlements, promotions, fees (data, owner-editable)
  services/
    entitlements.js    entitlement engine: limits/features/levels, usage, 402 upgrade prompts
    plans.js           plan CRUD, versions, impact review, change scopes (new / next renewal / immediate)
    subscriptions.js   checkout, trials, activation, renewals, grace → suspension → expiry, up/downgrade, cancel
    payments.js        Razorpay checkout, signature + API verification, webhooks, idempotent capture, reconciliation
    billing.js         invoices (GST), revenue recognition, refunds (four-eyes), adjustments
    commissions.js     rule engine (plan/category/region/order type/value/period), recognise on completion
    promotions.js      featured/category/regional/homepage/urgent promotions, credits, analytics
    procurement.js     self & platform-assisted sourcing, supplier confirmation, proposals, service fees
    logistics.js       delivery records, coordination/referral fees
    advertising.js     reviewed, paid, "Sponsored"-labelled ads
    referrals.js       codes, eligibility events, rewards, abuse checks
    intelligence.js    market intelligence gated by analytics_level (with k-anonymity)
    analytics.js       owner overview, revenue dashboard, subscription analytics, CSV exports
    scheduler.js       renewal invoices, reminders, grace/suspension, promo/ad expiry, commission invoicing
  routes/api.js        farmer/buyer/advertiser API
  routes/owner.js      owner + admin API (role-based permissions)
public/                single-page UI (no build step)
test/                  integration tests against a local Razorpay API stand-in
```

## Key rules implemented

- **Verified payments only.** An invoice settles only when the Razorpay HMAC signature checks out *and* the payment fetched from Razorpay is `captured` with a matching amount, or when a signature-validated webhook arrives. Replayed events are deduplicated. A second payment on a paid invoice raises a refund request automatically.
- **Backend-enforced entitlements.** Limits (`max_active_listings`, `max_farms`, `max_users`, `max_saved_suppliers`, `max_monthly_orders`, `featured_listing_credits`), features (`multi_farmer_procurement`, `bulk_sourcing`, `buyer_demand_access`, `procurement_reports`, `enterprise_api_access`, …) and levels (`analytics_level`, `marketplace_priority`) return HTTP 402 with upgrade options. Existing listings stay editable.
- **No data loss.** Lapsed or downgraded accounts fall back to the free plan. Listings over the limit are set inactive according to `downgrade_policy`, never deleted, and orders keep processing.
- **Financial controls.** Payments, invoices, refunds, revenue, history and audit rows cannot be deleted (DB triggers). The revenue ledger and audit log are append-only, and the audit log is hash-chained. Refunds are requested by an admin and authorised by the owner. Money-moving POSTs accept `Idempotency-Key`.
- **Initial strategy.** Transaction commissions ship **off** (`commissions.enabled=false`) so farmers and buyers can transact directly. The owner switches them on in *Commission rules*.

## Production notes

- SQLite (`node:sqlite`) keeps the module self-contained; `schema.sql` is plain SQL and ports to PostgreSQL.
- Renewals are invoice-based (pay each cycle through Razorpay Checkout). `payment_methods.provider_token` is in place for Razorpay recurring/e-mandate auto-debit later.
- Email/SMS: notifications are queued in `notification_outbox`; connect a provider to deliver them.
- Invoice downloads are printable HTML tax invoices; use print → *Save as PDF*.
