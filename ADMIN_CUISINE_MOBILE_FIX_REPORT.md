# Mr. Breado Admin Cuisine Upload and Mobile Web Fix

## Root causes repaired

1. Cuisine image upload errors from Cloudinary were not translated into structured API errors, so failures appeared as a generic 500.
2. The backend accepted only JPEG, PNG, WebP and GIF MIME types. Images selected from mobile devices can be HEIC, HEIF, AVIF or `application/octet-stream` with a valid image extension.
3. The backend only supported three separate Cloudinary variables and did not support a changed `CLOUDINARY_URL` connection string.
4. Duplicate cuisine slugs could produce a MongoDB duplicate-key error instead of a clear conflict response.
5. The admin cuisine form closed before the upload request completed, making failed uploads look lost.
6. The cuisine image table renderer did not return its JSX, so uploaded images did not appear in the list.
7. The admin theme read `localStorage` during SSR rendering, which could crash or fail hydration in browser deployments.
8. Generic admin tables were desktop-first and difficult to use on narrow mobile browsers.

## Backend changes

- Added a shared Cloudinary media service using memory upload streams.
- Supports either `CLOUDINARY_URL` or the separate Cloudinary variables.
- Trims accidental quotes and whitespace from deployed secrets.
- Supports JPG, JPEG, PNG, WebP, GIF, AVIF, HEIC and HEIF images.
- Maximum cuisine image size is 8 MB.
- Added structured errors for unsupported images, oversized images, invalid Cloudinary configuration, invalid credentials and upload failures.
- Added duplicate cuisine validation and clean 409 responses.
- Added image cleanup when a cuisine image is replaced or a cuisine is deleted.
- Added JSON image URL compatibility for migrations and existing records.
- Improved CORS origin normalization, wildcard support, mobile preflight handling and safe exposed headers.
- API version: `v74-cuisine-media-mobile-admin`.

## Admin changes

- Rebuilt the Cuisine page as a responsive premium form.
- Image preview, file type/size validation, loading state and persistent modal on failure.
- Save waits for the backend before closing.
- Safe user-facing errors; backend internals are not rendered.
- Cuisine images now display correctly in lists.
- Status, sort order and description are supported.
- Responsive bottom-sheet presentation on mobile.
- Generic `DataTable` now uses readable cards on mobile and tables on desktop.
- Search, export and pagination controls are touch friendly.
- Fixed SSR-unsafe theme storage access.
- Added safe-area, iOS form zoom prevention, reduced-motion support and touch feedback.
- Web vibration remains best-effort because iOS Safari does not expose the Vibration API.

## Deployment variables

Set either:

```text
CLOUDINARY_URL=cloudinary://API_KEY:API_SECRET@CLOUD_NAME
```

or:

```text
CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...
```

For the admin web, set:

```text
VITE_API_BASE_URL=https://YOUR-RENDER-SERVICE.onrender.com/api
```

For backend CORS, set the exact deployed admin origin. The updated backend also supports wildcard preview domains:

```text
CORS_ORIGINS=https://your-admin.vercel.app,https://*.vercel.app
```

## Validation

- Backend JavaScript syntax check passed.
- Backend regression suite passed: 39/39.
- Admin client build passed: 2,794 modules transformed.
- Admin SSR/Nitro/Vercel build passed: 2,805 modules transformed.
- No environment files or credentials are included in the deliverables.
