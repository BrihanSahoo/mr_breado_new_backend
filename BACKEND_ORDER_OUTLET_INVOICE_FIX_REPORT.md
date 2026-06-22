# Mr. Breado Backend Order/Outlet/Invoice Fix

## Root causes corrected

1. Online orders stayed in `PENDING_PAYMENT` after successful Razorpay verification. Payment verification updated only payment totals, not the order status, so the seller never received an actionable order and the customer active-order lock remained forever.
2. Auto-cancellation only checked `RECEIVED` and `READY`; it ignored `PENDING_PAYMENT` and assigned riders who never picked up.
3. Automatic cancellation existed only as a separate command and was not started by the production server unless an external cron was configured.
4. Admin order actions used MongoDB `findById()` only, while the web may send a MongoDB ID, numeric legacy ID, or order slug.
5. Admin cancellation depended on the normal state-transition table, so some unfinished states could not be cancelled.
6. Invoice download rejected every delivery order before completion. The UI therefore exposed a button that always failed for active orders.
7. Seller assignment preferred a stale `assignedOutletIds` entry before the explicit outlet `managerUserId` binding.
8. Seller order authorization checked stale IDs without first resolving the seller's authoritative current outlet.
9. Saving outlet credentials could create ambiguous duplicate seller assignments.

## Implemented behavior

- Successful online payment changes `PENDING_PAYMENT` to `RECEIVED` and starts a fresh seller-acceptance deadline.
- Default seller and rider timeout is 60 minutes.
- Pending online payments time out after 30 minutes by default.
- Auto-cancel runs inside the backend every minute and can still be invoked through `npm run jobs:auto-cancel`.
- Auto-cancel covers:
  - unpaid `PENDING_PAYMENT` orders;
  - seller-unaccepted `RECEIVED` orders;
  - `READY` or `RIDER_ASSIGNMENT_PENDING` orders with no rider;
  - `RIDER_ASSIGNED` orders not picked up within the deadline.
- Cancellation releases reserved stock and coupon usage and creates a pending refund record for successful payments.
- Admin can cancel any unfinished order without a supplied reason; the audit reason defaults to `Cancelled by administrator`.
- Admin action and invoice routes accept MongoDB IDs, numeric legacy IDs, and order slugs.
- Active orders can download an order receipt; delivered orders receive the final tax invoice.
- Sending an invoice creates a customer notification tied to the exact order.
- `Outlet.managerUserId` is authoritative for seller-to-outlet resolution.
- Saving outlet credentials removes the same outlet from stale seller accounts.
- Seller profile aliases are available at `/api/seller/me`, `/api/seller/profile`, `/api/outlet-manager/profile`, and existing outlet-manager routes.

## Environment controls

```env
AUTO_CANCEL_SELLER_MINUTES=60
AUTO_CANCEL_RIDER_MINUTES=60
AUTO_CANCEL_PAYMENT_MINUTES=30
ENABLE_IN_PROCESS_AUTOCANCEL=true
```

`ENABLE_IN_PROCESS_AUTOCANCEL` defaults to enabled unless explicitly set to `false`.

## Validation

- `npm run check:syntax`: passed
- `npm test`: 22/22 passed
