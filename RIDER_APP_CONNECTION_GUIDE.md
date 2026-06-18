# Rider App Connection Guide

The rider Flutter source is aligned with the MongoDB backend through the existing `/delivery/**` and `/rider/**` endpoint families.

## Supported flows

- Rider registration and login
- Verification submission and verification status
- Online/available status
- Active delivery offers
- Atomic offer acceptance
- Offer rejection
- Current delivery
- Pickup, out-for-delivery, reached-drop and delivered lifecycle
- COD collection enforcement
- Cash-in-hand limit and deposits
- Rider earnings
- Payout account
- General and order-specific live location
- Delivery history

## Flutter runtime URL

```bash
flutter run --dart-define=API_BASE_URL=https://YOUR-RENDER-SERVICE.onrender.com/api
```

## Important backend rules

- Only verified riders can go online and accept offers.
- Only one rider can atomically accept a delivery.
- COD orders cannot be completed before cash collection is recorded.
- Rider location for an order is accepted only for the assigned rider.
- Rider earnings use the stored order distance and the admin-configured per-KM rate.
- Cash holding limits can block new COD acceptance until a deposit is recorded.
