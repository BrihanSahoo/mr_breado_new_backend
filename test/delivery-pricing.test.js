const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const settings = require('../src/services/settingsService');
const adminRoutes = fs.readFileSync(path.join(root, 'src/routes/adminWebCompatibility.js'), 'utf8');
const publicRoutes = fs.readFileSync(path.join(root, 'src/routes/public.js'), 'utf8');
const deliveryService = fs.readFileSync(path.join(root, 'src/services/deliveryService.js'), 'utf8');
const orderService = fs.readFileSync(path.join(root, 'src/services/orderService.js'), 'utf8');
const riderRoutes = fs.readFileSync(path.join(root, 'src/routes/riderAppCompatibility.js'), 'utf8');

test('delivery pricing normalizes customer and rider values', () => {
  const pricing = settings.normalizeDeliveryPricing({
    customer: { baseCharge: 10, perKmCharge: 9, minimumCharge: 25, maximumCharge: 180 },
    rider: { basePay: 5, perKmRate: 7, minimumDeliveryPay: 30, assignmentRadiusKm: 10, monthlySettlementDay: 7 },
  });
  assert.deepEqual(pricing.customer, { baseCharge: 10, perKmCharge: 9, minimumCharge: 25, maximumCharge: 180 });
  assert.deepEqual(pricing.rider, { basePay: 5, perKmRate: 7, minimumDeliveryPay: 30, assignmentRadiusKm: 10, monthlySettlementDay: 7 });
});

test('delivery pricing rejects invalid maximum charge', () => {
  assert.throws(
    () => settings.normalizeDeliveryPricing({ customer: { minimumCharge: 100, maximumCharge: 50 } }),
    /cannot be below the minimum/i,
  );
});

test('dedicated admin and public pricing endpoints are present', () => {
  assert.match(adminRoutes, /\/admin\/delivery-pricing/);
  assert.match(adminRoutes, /setDeliveryPricing/);
  assert.match(publicRoutes, /\/public\/delivery-pricing/);
});

test('customer and rider calculations use authoritative pricing service', () => {
  assert.match(deliveryService, /getDeliveryPricing/);
  assert.match(orderService, /getDeliveryPricing/);
  assert.match(riderRoutes, /getDeliveryPricing/);
  assert.doesNotMatch(orderService, /outlet\.deliverySettings \|\|/);
  assert.match(riderRoutes, /perKmRate: rate\.perKm/);
});
