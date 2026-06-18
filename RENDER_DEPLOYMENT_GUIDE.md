# Render deployment guide

## Render service configuration

- Runtime: Node
- Node version: `22.x` (declared in `package.json`)
- Build command: `npm ci --omit=dev --no-audit --no-fund`
- Start command: `npm start`
- Health check path: `/api/health`

MongoDB Atlas must allow connections from Render. Prefer a restricted network rule where possible; `0.0.0.0/0` is acceptable only temporarily while validating deployment.

## Required environment variables

| Variable | Required | Purpose |
|---|---:|---|
| `NODE_ENV` | Yes | Set to `production`. |
| `PORT` | No | Render injects this automatically. The app defaults to `8080`. |
| `API_PREFIX` | No | Defaults to `/api`. |
| `MONGODB_URI` | Yes | MongoDB Atlas connection URI, including database name. |
| `JWT_SECRET` | Yes | Long random JWT signing secret, preferably 64+ characters. |
| `JWT_EXPIRES_IN` | No | Defaults to `30d`. |
| `SETTINGS_ENCRYPTION_KEY` | Yes | Stable 32+ character secret used to encrypt dynamic Razorpay and Maps credentials. Never rotate without re-encrypting stored values. |
| `CORS_ORIGIN` | Yes | Comma-separated permitted Admin/Web origins. Do not use `*` in production when credentials are enabled. |
| `BUSINESS_TIMEZONE` | No | Defaults to `Asia/Kolkata`. |
| `AUTO_CANCEL_SELLER_MINUTES` | No | Defaults to `30`. |
| `AUTO_CANCEL_RIDER_MINUTES` | No | Defaults to `45`. |
| `ENABLE_IN_PROCESS_AUTOCANCEL` | No | Keep `false` on Render web instances. Run the worker as a scheduled job instead. |
| `ADMIN_BOOTSTRAP_EMAIL` | Only for initial seed | Initial admin email used by `npm run seed`. |
| `ADMIN_BOOTSTRAP_PASSWORD` | Only for initial seed | Initial admin password. Change it immediately after first login. |

## Optional fallback integration variables

These are optional because Admin can save and rotate the credentials dynamically. They are used only until dynamic settings are stored in MongoDB.

| Variable | Purpose |
|---|---|
| `RAZORPAY_KEY_ID` | Fallback Razorpay public key ID. |
| `RAZORPAY_KEY_SECRET` | Fallback Razorpay private secret. |
| `RAZORPAY_WEBHOOK_SECRET` | Fallback webhook signing secret. |
| `GOOGLE_MAPS_API_KEY` | Fallback Google Maps API key. |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary cloud name. |
| `CLOUDINARY_API_KEY` | Cloudinary API key. |
| `CLOUDINARY_API_SECRET` | Cloudinary API secret. |

## Dynamic Admin settings

Admin can change Razorpay, Maps, online-payment availability, takeaway availability and takeaway advance percentage without redeployment. Dynamic credentials are encrypted in MongoDB and override environment fallbacks.

Run the one-time seed locally or from a Render shell:

```bash
npm run seed
```

Run auto-cancellation through one Render Cron Job or background worker:

```bash
npm run jobs:auto-cancel
```
