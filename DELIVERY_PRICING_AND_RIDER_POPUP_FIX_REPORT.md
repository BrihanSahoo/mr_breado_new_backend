# Mr. Breado Delivery Pricing and Rider Verification Popup Fix

## Rider app

- The `Rider verified` success dialog is now acknowledged persistently per rider account.
- It appears only once after the account becomes verified.
- Closing through Continue, back, or outside dismissal records the acknowledgement.
- Logout/login and normal app restarts do not show it again for the same rider account.

## Admin web

A dedicated **Business Config → Delivery Pricing** page was added to the sidebar.

Customer configuration:
- Base delivery charge
- Delivery charge per kilometre
- Minimum delivery charge
- Maximum delivery charge

Rider configuration:
- Rider base pay
- Rider pay per kilometre
- Minimum rider delivery pay
- Delivery offer assignment radius
- Monthly settlement day

The page loads from and saves to the backend. It also includes live 1 km, 5 km and 10 km calculation previews.

Pricing fields were removed from the visible general Settings and API Keys pages. API Keys remains responsible only for Google Maps configuration. Masked Google API keys are never written back as real credentials.

## Backend and MongoDB

The authoritative setting key is `delivery_pricing`.

For backward compatibility, saving also mirrors normalized values to:
- `delivery`
- `delivery_settings`
- `rider`
- `rider_settings`

### Customer formula

`max(minimumCharge, min(maximumCharge, baseCharge + distanceKm × perKmCharge))`

The calculation is performed by the backend during serviceability and order pricing. The resulting distance and delivery charge are stored on the order.

### Rider formula

`max(minimumDeliveryPay, basePay + distanceKm × perKmRate)`

The same formula is used for delivery offers, rider dashboard values and final rider earning records created after delivery completion.

## Endpoints

Admin:
- `GET /api/admin/delivery-pricing`
- `PUT /api/admin/delivery-pricing`
- Compatibility aliases: `/api/admin/delivery-charges`

Public/app-readable:
- `GET /api/delivery-pricing`
- `GET /api/delivery-charges`
- `GET /api/public/delivery-pricing`
- `GET /api/settings/delivery-pricing`

Deployment version check:
- `GET /api/version`
- Expected `apiCompatibility`: `v71-delivery-pricing-single-source`

## Validation

- Backend JavaScript syntax validation: passed
- Backend automated tests: 28/28 passed
- Admin production Vite/Nitro build: passed, 2,789 modules transformed
- Rider changes are limited to the persistent acknowledgement and dialog trigger logic; the supplied rider source is a `lib`-style source bundle without a complete Flutter project, so a full Flutter build could not be executed in this environment.

## Deployment order

1. Deploy the backend.
2. Confirm `/api/version` returns `v71-delivery-pricing-single-source`.
3. Deploy the admin web.
4. Open **Delivery Pricing**, enter the required production values, and save once.
5. Build/install the updated rider app.
