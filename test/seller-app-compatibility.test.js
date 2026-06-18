const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const routePath = path.join(__dirname, '..', 'src', 'routes', 'sellerAppCompatibility.js');
const appPath = path.join(__dirname, '..', 'src', 'app.js');
const routeSource = fs.readFileSync(routePath, 'utf8');
const appSource = fs.readFileSync(appPath, 'utf8');

test('outlet manager compatibility router is mounted before base seller router', () => {
  assert.ok(appSource.indexOf("'./routes/sellerAppCompatibility'") < appSource.indexOf("'./routes/seller'"));
});

test('critical seller app endpoint families are present', () => {
  for (const endpoint of [
    '/seller/restaurant', '/seller/restaurant/status', '/seller/products',
    '/seller/orders', '/seller/orders/:id/invoice.pdf', '/outlet-manager/dashboard',
    '/outlet-manager/stock', '/outlet-manager/offline-sales', '/outlet-manager/close-day'
  ]) assert.match(routeSource, new RegExp(endpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('seller operations enforce outlet access and idempotency', () => {
  assert.match(routeSource, /ensureOutlet\(req\.user/);
  assert.match(routeSource, /idempotency-key/);
  assert.match(routeSource, /Outlet access denied/);
});
