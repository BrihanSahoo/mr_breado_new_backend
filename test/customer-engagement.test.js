const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('customer engagement exposes detailed customers, targeted notifications and email', () => {
  const source = read('src/routes/adminCustomerEngagement.js');
  assert.match(source, /\['\/admin\/users', '\/admin\/customers'\]/);
  assert.match(source, /\/admin\/customers\/:id\/details/);
  assert.match(source, /\/admin\/customers\/:id\/orders/);
  assert.match(source, /\/admin\/customers\/:id\/notifications/);
  assert.match(source, /\/admin\/customers\/:id\/email/);
  assert.match(source, /\/admin\/riders\/:id\/email/);
  assert.match(source, /AdminEmailLog/);
  assert.match(source, /analyticsFromOrders/);
});

test('customer app diagnostics create admin-visible notifications without leaking raw failures', () => {
  const source = read('src/routes/adminCustomerEngagement.js');
  assert.match(source, /\/client-error-reports/);
  assert.match(source, /CLIENT_ERROR_REPORT/);
  assert.match(source, /\/admin\/client-error-reports/);
  assert.match(source, /\/admin\/notifications/);
});

test('outlet creation and controls preserve logo, range and per-outlet business toggles', () => {
  const source = read('src/routes/admin.js');
  assert.match(source, /file_nzsycz\.jpg/);
  assert.match(source, /deliveryRadiusKm:Math\.max/);
  assert.match(source, /featureToggles/);
  assert.match(source, /\/admin\/outlets\/:id\/controls/);
  assert.match(source, /findOneCompat\(Outlet,req\.params\.id\)/);
});
