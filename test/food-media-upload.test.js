const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const route = fs.readFileSync(path.join(root, 'src/routes/adminWebCompatibility.js'), 'utf8');
const media = fs.readFileSync(path.join(root, 'src/services/mediaService.js'), 'utf8');

test('food uploads use the shared Cloudinary adapter and preserve cuisine metadata', () => {
  assert.match(route, /imageUpload:\s*upload,\s*uploadImage:\s*uploadMedia/);
  assert.match(route, /post\(upload\.single\('image'\)/);
  assert.match(route, /resolveCuisine\(body,\s*existing\)/);
  assert.match(route, /cuisineId:\s*cuisine\._id/);
  assert.match(route, /populate\('categoryId brandId cuisineId'\)/);
});

test('shared image service accepts CLOUDINARY_URL and larger product multipart forms', () => {
  assert.match(media, /process\.env\.CLOUDINARY_URL/);
  assert.match(media, /upload_stream/);
  assert.match(media, /fields:\s*60/);
  assert.match(media, /MAX_IMAGE_BYTES\s*=\s*8\s*\*\s*1024\s*\*\s*1024/);
});
