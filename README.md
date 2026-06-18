# Mr. Breado MongoDB Backend

A clean Node.js/Express/Mongoose implementation for MongoDB Atlas that preserves the existing `/api` endpoint contract used by the Admin, Seller, Customer, and Rider applications.

## Quick start

```bash
cp .env.example .env
npm install
npm run seed
npm run dev
```

Set `MONGODB_URI` to an online MongoDB Atlas connection string. Atlas must allow the Render/local IP and use a replica set (Atlas does by default) for transactions.

## Production

```bash
npm ci --omit=dev --no-audit --no-fund
npm start
```

Render build command: `npm ci --omit=dev --no-audit --no-fund`
Render start command: `npm start`

Run auto-cancellation from one cron worker:

```bash
npm run jobs:auto-cancel
```

## Core guarantees

- One immutable outlet per order.
- Global product catalog plus outlet-specific inventory.
- Transactional stock reservation, consumption, release, and offline sales.
- Idempotent payment/order/stock operations.
- Authenticated Razorpay creation and signature verification.
- Role and outlet isolation for Admin, Seller, Rider, and Customer.
- PDF invoice generation.
- Rider location updates over Socket.IO and tracking endpoints.
- End-of-day outlet stock/sales closing.

## Dynamic Razorpay and Google Maps configuration

Razorpay and Google Maps credentials may be changed by an authenticated ADMIN without redeploying the backend. Values are encrypted in MongoDB with AES-256-GCM using `SETTINGS_ENCRYPTION_KEY`. The Razorpay service resolves the active credentials on every payment create, verify, and webhook request, so a saved rotation applies immediately.

Admin endpoints:

- `GET /api/admin/settings` — returns regular settings and masked integration status only.
- `PUT /api/admin/settings/razorpay` — saves/replaces `keyId`, `keySecret`, optional `webhookSecret`, and `enabled`.
- `PATCH /api/admin/settings/razorpay/status` — enables/disables online payment credentials without deleting them.
- `PUT /api/admin/settings/google-maps` — saves/replaces `apiKey` and `enabled`.
- `PATCH /api/admin/settings/google-maps/status` — enables/disables the Maps key without deleting it.
- `POST /api/admin/settings/integrations/razorpay_credentials/validate`
- `POST /api/admin/settings/integrations/google_maps_credentials/validate`

Compatibility aliases are also registered for `/api/admin/payment-settings/razorpay`, `/api/admin/razorpay-settings`, `/api/admin/google-maps-settings`, and `/api/admin/maps-settings`.

The public settings endpoints expose the Razorpay Key ID and Google Maps browser key when enabled, but never expose the Razorpay secret or webhook secret. Environment values remain fallback credentials until the admin saves dynamic values.


## Dynamic business feature settings

Admin can enable or disable online payment and takeaway, and set the percentage of the total that must be paid online for takeaway orders. Changes apply immediately without redeployment.

```http
GET /api/admin/settings/business-features
PUT /api/admin/settings/business-features
PATCH /api/admin/settings/online-payment/status
PATCH /api/admin/settings/takeaway/status
PATCH /api/admin/settings/takeaway/advance
```

Example combined update:

```json
{
  "onlinePaymentEnabled": true,
  "takeawayEnabled": true,
  "takeawayAdvancePercentage": 30
}
```

When takeaway advance is above 0%, online payment must remain enabled. Checkout returns `takeawayAdvancePercentage`, `payableOnlineAmount`, and `balanceDue`. Razorpay charges only the configured advance amount; the remaining balance stays recorded on the order.

See `RENDER_DEPLOYMENT_GUIDE.md` for every Render environment variable.
