# Rider 403 Forbidden — Final Root-Cause Fix

## Root cause
The MongoDB rider record was already correct (`role: RIDER` and `riderProfile.verificationStatus: VERIFIED`). The requests were blocked before reaching rider controllers.

`customerCompatibility.js` and `sellerAppCompatibility.js` are both mounted directly at the global API prefix. Each contained an unscoped router-wide role middleware:

- customer compatibility accepted only CUSTOMER/ADMIN
- seller compatibility accepted only SELLER/ADMIN

Because those routers are mounted before rider routers, authenticated rider calls such as `/delivery/dashboard`, `/delivery/location`, `/delivery/orders/history`, and `/rider/earnings` were rejected with 403 by the wrong router.

## Repair
- Customer authorization is now scoped only to customer-owned URL namespaces.
- `/notifications` is shared by all authenticated roles.
- Seller authorization is now scoped only to `/seller` and `/outlet-manager`.
- Rider routes can now reach their own RIDER authorization middleware and controllers.
- Added regression tests preventing unscoped CUSTOMER or SELLER guards from being restored.

## Validation
- JavaScript syntax checks passed.
- Full backend test suite passed: 24/24.
