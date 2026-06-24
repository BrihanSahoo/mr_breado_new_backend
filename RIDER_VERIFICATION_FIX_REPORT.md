# Rider verification integration fix

## Fixed flow
- Rider registration continues to create a RIDER account and stores the authenticated session.
- An authenticated but unverified rider can submit all five required documents.
- Verification submissions are stored as PENDING and force the rider offline until review.
- Admin verification APIs now return normalized rider identity, contact details, submitted form fields, and document URLs.
- Generic admin approve/reject endpoints now update both the verification request and the rider profile atomically in the same request flow.
- Approval writes VERIFIED to the rider profile, allowing the existing online/availability and delivery-offer gates to work.
- Rejection writes REJECTED, keeps the rider offline, stores the rejection reason, and allows resubmission.
- Rider receives an in-app notification after approval or rejection.
- Existing outlet, customer, seller, order, inventory, payment, settings, and dashboard routes were not removed.

## Validation
- Backend JavaScript syntax check: passed.
- Backend automated test suite: 22/22 passed.
- Admin client build: Vite transformed 2788 modules and emitted the verification route bundle successfully. The combined Nitro/Vercel build continued beyond the execution time limit in this environment, with no TypeScript or source compilation error reported before timeout.
