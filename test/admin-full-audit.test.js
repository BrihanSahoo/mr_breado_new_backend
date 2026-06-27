const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');

test('banner upload uses shared media service and resolved outlet ids without undefined variables', () => {
  const src = read('routes/promotionAdmin.js');
  assert.match(src, /media\.imageUpload\.single\('imageFile'\)/);
  assert.match(src, /const outletIds = await validateScope\(requestedIds, appliesToAllOutlets\)/);
  assert.match(src, /outletIds: appliesToAllOutlets \? \[\] : outletIds/);
  assert.doesNotMatch(src, /bannerPayload[\s\S]{0,3000}outletIds: appliesToAllOutlets \? \[\] : resolvedOutletIds/);
});

test('admin account recovery and credential change endpoints are registered securely', () => {
  const src = read('routes/adminAccount.js');
  assert.match(src, /admin\/auth\/forgot-password/);
  assert.match(src, /admin\/auth\/reset-password/);
  assert.match(src, /admin\/account\/password/);
  assert.match(src, /admin\/account\/email/);
  assert.match(src, /bcrypt\.hash\(password, 12\)/);
  assert.match(src, /passwordChangedAt/);
});

test('admin operations endpoints use persistent MongoDB models', () => {
  const src = read('routes/adminUiCompatibility.js');
  for (const route of [
    '/admin/payments/summary',
    '/admin/mr-breado/payments',
    '/admin/seller-messages',
    '/admin/restaurant-reports',
    '/admin/seller-payout-accounts',
    '/admin/outlets/:id/inventory',
  ]) assert.ok(src.includes(route), `${route} should be implemented`);
  assert.match(src, /Payment\.aggregate/);
  assert.match(src, /DailyClosing\.find/);
  assert.match(src, /Notification\.find/);
});

test('admin compatibility router is mounted before broad legacy admin web router', () => {
  const src = read('app.js');
  const promotion = src.indexOf("'./routes/promotionAdmin'");
  const audit = src.indexOf("'./routes/adminUiCompatibility'");
  const legacy = src.indexOf("'./routes/adminWebCompatibility'");
  assert.ok(promotion >= 0 && audit > promotion && legacy > audit);
  assert.match(src, /v77-admin-full-audit-banner-account/);
});
