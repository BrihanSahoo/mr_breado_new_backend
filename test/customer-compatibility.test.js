const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../src/routes/customerCompatibility.js'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');

test('customer compatibility router is mounted before public/payment/order routers', () => {
  const compat = appSource.indexOf('./routes/customerCompatibility');
  const publicRoute = appSource.indexOf('./routes/public');
  const paymentRoute = appSource.indexOf('./routes/payments');
  assert.ok(compat > -1);
  assert.ok(compat < publicRoute);
  assert.ok(compat < paymentRoute);
});

test('customer application endpoint families are implemented', () => {
  for (const endpoint of [
    '/home', '/products', '/platform/settings', '/cart/items', '/checkout/summary',
    '/payments/create-order', '/payments/verify', '/user/orders', '/user/addresses',
    '/delivery/validate', '/notifications', '/reviews/order/:id/eligibility'
  ]) assert.match(source, new RegExp(endpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('legacy numeric id compatibility is present', () => {
  const models = fs.readFileSync(path.join(__dirname, '../src/models/index.js'), 'utf8');
  const respond = fs.readFileSync(path.join(__dirname, '../src/utils/respond.js'), 'utf8');
  assert.match(models, /legacyId/);
  assert.match(respond, /embeddedLegacyId/);
});
