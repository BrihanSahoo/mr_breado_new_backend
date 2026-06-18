# Implementation progress

Implemented:
- MongoDB Atlas/Mongoose database layer
- Canonical models and indexes
- JWT/RBAC/outlet isolation
- Global catalog and outlet inventory
- Customer discovery/cart/checkout/order flow
- Stock reservation/consumption/release ledger
- Razorpay create/verify/webhook foundation
- Admin outlet/category/product/inventory/manager/order/payment/refund/settings APIs
- Seller orders, itemized offline sales, end-of-day closing
- Rider atomic claim, lifecycle, location and earnings
- PDF invoices
- Socket.IO foundation
- Compatibility aliases
- Unit checks and documentation

External verification required:
- Real Atlas credentials and data migration
- Razorpay test account/webhooks/refunds
- Cloudinary uploads
- Mobile/web application contract testing
- Load and concurrency testing on Atlas

## Dynamic integration credentials

- Added encrypted MongoDB storage for Razorpay Key ID, Razorpay Secret, Razorpay Webhook Secret, and Google Maps API key.
- Added masked admin reads, credential rotation, enable/disable controls, validation endpoints, and immutable setting audit records.
- Razorpay create, verify, and webhook flows now resolve active credentials dynamically for every request.
- Public app settings expose only the public Razorpay Key ID and Maps key; private secrets are never serialized.


## Dynamic payment and takeaway controls (v3)

- Added Admin-controlled online-payment enable/disable.
- Added Admin-controlled takeaway enable/disable.
- Added validated takeaway advance percentage from 0 to 100.
- Checkout now enforces feature toggles server-side.
- Takeaway pricing returns advance percentage, online payable amount and remaining balance.
- Razorpay charges only the configured takeaway advance.
- Orders persist paid amount and remaining balance.
- Public settings expose current online-payment and takeaway availability.
- Added complete Render environment-variable guide.
- Added comma-separated production CORS origin support for Express and Socket.IO.

## Customer App Alignment v5

- Added customer compatibility router before public/payment/order legacy routers.
- Added stable numeric API compatibility IDs backed by MongoDB `legacyId` values.
- Added automatic backfill for existing MongoDB documents.
- Added embedded cart/address numeric ID compatibility.
- Connected nearest outlet, outlet-only menu, cart, addresses, checkout, COD, Razorpay, takeaway, orders, invoices, reviews, notifications and live rider tracking.
- Added 3 customer compatibility regression tests.
- Syntax checks passed; 13 tests passed.
