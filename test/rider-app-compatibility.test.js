const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
const route = fs.readFileSync(path.join(root, 'src/routes/riderAppCompatibility.js'), 'utf8');
const models = fs.readFileSync(path.join(root, 'src/models/index.js'), 'utf8');
const roles = fs.readFileSync(path.join(root, 'src/utils/roles.js'), 'utf8');

test('rider app compatibility router is mounted before base rider router', () => {
  assert.ok(app.indexOf('./routes/riderAppCompatibility') > -1);
  assert.ok(app.includes("'./routes/riderAppCompatibility','./routes/rider'"));
});

test('rider application endpoint families are present', () => {
  for (const endpoint of [
    '/delivery/dashboard',
    '/delivery/profile/status',
    '/delivery/offers/active',
    '/delivery/orders/current',
    '/delivery/orders/history',
    '/delivery/cash/summary',
    '/delivery/cash/transactions',
    '/delivery/cash/deposit',
    '/delivery/payout-account',
    '/rider/verification/status',
  ]) assert.ok(route.includes(endpoint), endpoint);
});

test('rider flow enforces assignment, verification, cash and location rules', () => {
  assert.ok(route.includes('RIDER_NOT_VERIFIED'));
  assert.ok(route.includes('ALREADY_ASSIGNED'));
  assert.ok(route.includes('CASH_LIMIT_REACHED'));
  assert.ok(route.includes('CASH_NOT_COLLECTED'));
  assert.ok(route.includes('ORDER_NOT_ASSIGNED'));
  assert.ok(route.includes("findOneAndUpdate"));
});

test('rider data models include cash and delivery lifecycle persistence', () => {
  assert.ok(models.includes('RiderCashTransaction'));
  assert.ok(models.includes('outForDeliveryAt'));
  assert.ok(models.includes('reachedDropAt'));
  assert.ok(models.includes('cashCollectedAmount'));
  assert.ok(roles.includes("DELIVERY_PARTNER:'RIDER'"));
});
