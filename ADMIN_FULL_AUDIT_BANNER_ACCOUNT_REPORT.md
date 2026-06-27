# Mr Breado Admin Full Audit — Banner, Backend Consistency, and Admin Account Recovery

## Scope

This update audits and repairs the uploaded MongoDB backend and admin web after the food/cuisine upload fixes. Existing user, seller, rider, order, payment, stock, delivery-pricing, coupon, verification, and finance behavior is preserved.

## Banner upload root cause

The banner request reached the promotion backend, but the payload builder created `outletIds` and then referenced an undefined variable named `resolvedOutletIds`. That runtime `ReferenceError` was converted into a generic HTTP 500 response.

The banner flow also still had compatibility risks around legacy outlet identifiers and media handling.

## Banner corrections

- Fixed the undefined outlet-variable failure.
- Banner uploads now use the shared hardened Cloudinary media service.
- Supports `CLOUDINARY_URL` or separate Cloudinary credentials.
- Accepts image upload or image URL with proper validation.
- Resolves Mongo ObjectId, legacy numeric ID, code, and slug outlet identifiers.
- Validates coupon activity and coupon/outlet compatibility.
- Validates start/end scheduling and priority.
- Cleans newly uploaded Cloudinary media when database persistence fails.
- Returns contextual validation/media errors instead of an unexplained server error.
- Added responsive desktop dialog and mobile bottom-sheet behavior.
- Added image preview, loading state, duplicate-submit prevention, and safe haptic feedback.

## Admin account and password recovery

Added database-backed admin account controls:

- View/update admin profile.
- Change phone number.
- Change email after current-password verification.
- Change password after current-password verification.
- Forgot-password request.
- OTP reset-password flow.
- Optional recovery-key reset for controlled emergency recovery.
- Password-change timestamp invalidates older JWTs.
- OTP is hashed, expires after ten minutes, and is rate-limited.

Optional production email variables:

- `RESEND_API_KEY`
- `ADMIN_RESET_FROM_EMAIL` or `RESEND_FROM_EMAIL`
- `ADMIN_PASSWORD_RECOVERY_KEY` for controlled recovery-key use

Without Resend configuration, recovery remains available through the configured recovery-key flow; secrets are never returned by the API.

## Remaining admin/backend consistency audit

The following compatibility and persistence gaps were repaired or normalized:

- Customers/users, owners, drivers, profile and status routes.
- Support dashboard, tickets, replies, assignment, status and deletion.
- Reviews.
- Offers and promotion media handling.
- Categories with real multipart image upload, replacement and deletion safeguards.
- Zones converted from local/static UI data to persisted backend settings.
- Restaurant, driver, commission, platform-fee, Maps and payment settings aliases.
- Outlet inventory.
- Verification and restaurant join-request aliases.
- Payment summary and Mr Breado payment reporting.
- Seller messages persisted through notifications.
- Outlet daily reports backed by daily-closing records.
- Seller payout-account verification persisted on the seller profile.
- Franchise/refill request compatibility persisted in settings rather than UI mock data.
- Rider finance totals preserve incoming money from riders and outgoing rider payouts.

## Responsive and premium admin UI

- Mobile navigation drawer and safe-area handling.
- Sticky responsive header.
- Mobile bottom sheets for complex forms.
- Touch targets and 16px mobile inputs to avoid iOS browser zoom.
- Global coarse-pointer haptic support with graceful browser fallback.
- Loading, disabled, validation, empty and error states.
- Responsive cards for shared tables on narrow displays.
- SSR-safe browser storage and theme access.
- Removed irrelevant subscription navigation from the single-company admin model.

## Validation performed

- Backend JavaScript syntax validation: passed.
- Backend automated tests: **45/45 passed**.
- Banner undefined-variable regression test: passed.
- Admin account and recovery route/security tests: passed.
- Admin operations persistence tests: passed.
- Route ordering and compatibility tests: passed.
- Admin Vite/Nitro/Vercel production build: passed.
- Admin client modules transformed: **2,795**.
- Nitro production modules transformed: **2,806**.
- ZIP integrity and excluded-file checks: passed.

## Deployment order

1. Deploy the corrected backend.
2. Confirm `GET /api/version` returns `apiCompatibility: v77-admin-full-audit-banner-account`.
3. Keep one valid Cloudinary configuration:
   - `CLOUDINARY_URL`, or
   - `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`.
4. Configure optional password-recovery variables.
5. Deploy the corrected admin web with `VITE_API_BASE_URL` pointing to the backend `/api` base.
6. Sign out and sign in again after changing admin email or password.

## Verification limitation

The source, automated tests, route contracts, upload paths, and production build were validated locally. A real production Cloudinary upload, email delivery, and deployed MongoDB write cannot be executed without access to the user's private production credentials and environment. The exact screenshot failure was nevertheless identified as a deterministic code error and corrected directly.
