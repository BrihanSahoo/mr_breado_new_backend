const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

test('production business and reconciliation endpoints are registered', () => {
  const source = read('src/routes/production.js');
  for (const endpoint of ['/admin/business-metrics', '/admin/outlet-performance', '/admin/operational-alerts', '/admin/reconciliation/payments', '/admin/inventory/alerts']) {
    assert.match(source, new RegExp(endpoint.replaceAll('/', '\\/')));
  }
});

test('Razorpay webhook processing is idempotent and amount-aware', () => {
  const source = read('src/services/paymentService.js');
  assert.match(source, /PaymentWebhookEvent\.create/);
  assert.match(source, /duplicate: true/);
  assert.match(source, /PAYMENT_AMOUNT_MISMATCH/);
  assert.match(source, /payments\.fetch/);
});
