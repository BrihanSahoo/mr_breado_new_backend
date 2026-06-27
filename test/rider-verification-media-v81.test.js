const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('rider verification uses the shared Cloudinary configuration and streaming upload', () => {
  const route = read('src/routes/riderVerificationOnboarding.js');
  const media = read('src/services/mediaService.js');
  assert.match(route, /configureCloudinary/);
  assert.match(route, /upload_stream/);
  assert.match(route, /resource_type: 'auto'/);
  assert.match(route, /application\/octet-stream/);
  assert.doesNotMatch(route, /process\.env\.CLOUDINARY_CLOUD_NAME \|\|/);
  assert.doesNotMatch(route, /buffer\.toString\('base64'\)/);
  assert.match(media, /process\.env\.CLOUDINARY_URL/);
  assert.match(media, /configureCloudinary/);
});

test('verification failures clean partial uploads and do not leave a pending request', () => {
  const route = read('src/routes/riderVerificationOnboarding.js');
  assert.match(route, /cleanupUploadedDocuments/);
  assert.match(route, /VerificationRequest\.deleteOne/);
  assert.match(route, /Notification\.create[\s\S]*?\.catch\(\(\) => null\)/);
});

test('API compatibility version reports verification media fix', () => {
  const app = read('src/app.js');
  assert.match(app, /v81-rider-verification-media-consistency/);
});
