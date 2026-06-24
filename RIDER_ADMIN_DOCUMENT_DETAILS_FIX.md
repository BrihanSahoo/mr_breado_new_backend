# Rider admin document/details fix

## Root cause
New riders created from accounts without a numeric `legacyId` were serialized with an empty `driverId`. The admin web then requested `/admin/drivers/undefined/...`, so the modal retained partial/stale list data and could not load the linked user profile or verification documents.

A second mismatch made `/admin/drivers/:id/verification-details` return a verification-request-shaped object rather than the complete rider-control object expected by the admin modal.

## Fix
- `driverId` and `profileId` now fall back to the MongoDB user id.
- Full rider details return phone, email, verification status and the latest verification request with normalized document URLs.
- Verification compatibility output now includes rider email and phone aliases.
- Existing requests/documents remain unchanged in MongoDB and become visible after deployment.
