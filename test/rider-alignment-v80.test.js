const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');
const compat = fs.readFileSync(path.join(root, 'src/routes/riderAppCompatibility.js'), 'utf8');

test('rider pay uses authoritative pricing and distance fallback', () => {
  assert.match(compat, /resolvedDeliveryDistance\(hydrated, outlet\)/);
  assert.match(compat, /function haversineKm\(/);
  assert.match(compat, /calculateRiderPay\(distance, rate\)/);
});

test('dashboard remains compatible with explicit out-for-delivery status', () => {
  assert.match(compat, /'RIDER_ASSIGNED', 'PICKED_UP', 'OUT_FOR_DELIVERY'/);
});
