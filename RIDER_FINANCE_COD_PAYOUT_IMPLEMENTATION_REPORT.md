# Mr. Breado Rider Finance, COD Settlement, Payout, Passport Photo, and Safe Error Handling

## Release identifier

`v72-rider-finance-ledger-passport-safe-errors`

## Scope

This coordinated update modifies the MongoDB/Node.js backend, admin web dashboard, and Flutter rider application. Existing rider verification, order assignment, online/offline status, location tracking, delivery status, outlet, stock, customer, seller, pricing, and order flows are retained.

## Rider application

### Professional error handling

- Centralized all API error presentation through a safe message mapper.
- Raw backend response bodies, stack information, tokens, and internal error messages are not rendered to the rider.
- HTTP status codes and stable backend error codes are converted into actionable rider-facing messages.
- Debug logging contains only the HTTP method, route, status, and Dio error category; request payloads, authentication tokens, and response bodies are not logged.
- Timeout, offline, expired session, permission, verification, order-state, COD-limit, settlement, and payment failures have dedicated messages.

### Verification and profile image

- Verification now has two separate portrait fields:
  - live profile photo/selfie
  - passport-size photo
- The passport-size image is uploaded as multipart field `passportPhoto`.
- The backend persists it in `user.riderProfile.passportPhoto`.
- The rider profile uses the passport-size image, with a compatible avatar fallback for older rider records.
- Admin rider details and verification views display the passport-size image.

### Money Center

- Rider can view:
  - total COD collected
  - COD already paid to admin
  - outstanding COD owed to admin
  - amount currently awaiting admin cash confirmation
  - available COD amount that can be settled
  - pending rider earnings
  - pending rider payout
  - total rider earnings
  - paid rider earnings
- Rider can save a UPI ID for receiving payouts.
- Rider can submit a physical cash-handover request. The balance remains outstanding until admin approval.
- Rider can pay outstanding COD through Razorpay.
- Razorpay signature and payment state are verified by the backend before the COD balance changes.
- Rider sees incoming and outgoing payment history:
  - rider to admin COD payments
  - admin to rider payouts
- The previous cash-settlement screen redirects to the authoritative Money Center so old navigation cannot bypass admin approval.
- Important actions use haptic feedback.

### Visual consistency

Finance, profile, notifications, history, earnings, verification, and delivery screens retain the same cream/orange/glass-card visual system used by the rider home screen.

## Backend

### Data model additions

- `riderProfile.passportPhoto`
- `RiderSettlement`
  - methods: `CASH`, `RAZORPAY`
  - statuses: `PENDING`, `APPROVED`, `PAID`, `REJECTED`, `FAILED`, `CANCELLED`
- Expanded `RiderPayout`
  - statuses: `PENDING`, `PAID`, `FAILED`, `CANCELLED`
  - UPI ID, payment reference, selected earning IDs, paid-by admin, and paid timestamp
- Idempotency protection for confirmed rider cash transactions.

### COD settlement rules

- Outstanding COD is calculated from confirmed collection and deposit ledger entries.
- Pending settlement requests are reserved, preventing the rider from submitting more than the available balance.
- A physical cash request does not clear the COD due amount until admin approval.
- Admin rejection releases the reserved amount so the rider can submit it again.
- A Razorpay settlement clears COD only after signature validation and Razorpay payment verification.
- Duplicate callbacks cannot create duplicate confirmed cash transactions.

### Rider payout rules

- Rider UPI ID is stored on the rider payout account.
- Admin creates a pending payout from complete pending earning entries.
- Creating a pending payout does not mark earnings as paid.
- Admin must enter the real UPI transaction reference and choose **Mark Paid**.
- Only then are selected earnings marked `PAID` and the rider's amount due becomes zero for those earnings.
- Pending payouts can be cancelled without clearing rider earnings.

### Finance ledger

The combined ledger exposes a normalized direction:

- `RIDER_TO_ADMIN`: COD settlement received from the rider
- `ADMIN_TO_RIDER`: rider payout paid by admin

The admin UI renders incoming transactions with a green arrow and outgoing transactions with a red arrow.

### Main API endpoints

Rider:

- `GET /api/rider/finance/summary-v2`
- `GET /api/rider/finance/history`
- `GET /api/rider/cash/settlements`
- `POST /api/rider/cash/settlements`
- `POST /api/rider/cash/settlements/razorpay/order`
- `POST /api/rider/cash/settlements/razorpay/verify`

Admin:

- `GET /api/admin/rider-settlements`
- `POST /api/admin/rider-settlements/:id/approve`
- `POST /api/admin/rider-settlements/:id/reject`
- `POST /api/admin/drivers/:id/payout`
- `POST /api/admin/rider-payouts/:id/mark-paid`
- `POST /api/admin/rider-payouts/:id/cancel`
- `GET /api/admin/rider-finance-ledger?riderId=...`

Compatible `/delivery/...` rider aliases remain available where required by the current app.

## Admin web

The rider-management view now provides:

- passport-size profile photo
- rider verification and UPI information
- COD collected, deposited, pending confirmation, and outstanding totals
- pending cash-handover requests with approve/reject controls
- rider payout due and pending payout information
- creation of a pending UPI payout
- explicit **Mark Paid** action with required transaction reference
- payout cancellation
- complete incoming/outgoing rider ledger
- green incoming arrow for rider payments to admin
- red outgoing arrow for admin payments to rider
- web vibration feedback where browser support exists
- contextual UI messages rather than raw API response data

## Validation completed

### Backend

- JavaScript syntax validation: passed
- Automated regression tests: 33/33 passed

### Admin web

- Vite client compilation: passed, 2,789 modules transformed
- SSR source transformation: passed, 215 modules transformed
- Final Nitro/Vercel packaging exceeded the execution-time limit in the test environment; no modified-source compilation error appeared before timeout.
- The repository has unrelated pre-existing TypeScript diagnostics outside the modified rider-finance files.

### Rider source

- Dart delimiter/lexical validation: passed for 31 Dart files
- Local Dart import resolution: passed
- Targeted assertions passed for:
  - safe error mapping
  - removal of raw request/response logging
  - passport-size multipart upload
  - passport image profile rendering
  - UPI submission
  - physical cash handover
  - Razorpay settlement
  - payment history
  - legacy cash screen routing to Money Center
- A full Flutter build was not possible because the supplied rider archive contains source files only and does not include `pubspec.yaml` or the platform project.

## Required Flutter dependency

Add this to the complete rider project's `pubspec.yaml`:

```yaml
dependencies:
  razorpay_flutter: ^1.4.0
```

Then run:

```bash
flutter clean
flutter pub get
flutter run
```

## Deployment order

1. Deploy the updated backend.
2. Verify `/api/version` returns `v72-rider-finance-ledger-passport-safe-errors`.
3. Deploy the updated admin web.
4. Add `razorpay_flutter` to the full rider project, replace/update the supplied rider source, and rebuild the app.
5. Configure and enable valid Razorpay credentials in the admin/backend settings before testing online COD settlement.
6. Test one physical cash request, one Razorpay COD payment, and one admin-to-rider UPI payout using a test rider account.
