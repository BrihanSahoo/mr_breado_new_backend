const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const app = read('src/app.js');
const publicRoutes = read('src/routes/public.js');
const promotionAdmin = read('src/routes/promotionAdmin.js');
const tracking = read('src/routes/customerCompatibility.js');
const orderService = read('src/services/orderService.js');
const riderManagement = read('src/routes/riderManagement.js');

function routeIndex(name) { return app.indexOf(`./routes/${name}`); }

test('promotion admin routes are registered before broad admin compatibility routes', () => {
  assert.ok(routeIndex('promotionAdmin') > -1);
  assert.ok(routeIndex('promotionAdmin') < routeIndex('adminWebCompatibility'));
});

test('public product discovery is brand slug, outlet, stock and distance aware', () => {
  assert.ok(publicRoutes.includes('query.brandSlug'));
  assert.ok(publicRoutes.includes('Brand.findOne'));
  assert.ok(publicRoutes.includes('OutletProduct.find'));
  assert.ok(publicRoutes.includes('distanceKm'));
  assert.ok(publicRoutes.includes('outOfRange'));
  assert.ok(publicRoutes.includes('relatedProducts'));
});

test('tracking accepts compatibility identifiers and returns a cached road route', () => {
  assert.ok(tracking.includes('findOneCompat(Order, req.params.id'));
  assert.ok(tracking.includes('trackingRouteService.getDrivingRoute'));
  assert.ok(tracking.includes('encodedPolyline'));
  assert.ok(tracking.includes('navigationDestination'));
});

test('coupon administration includes outlet scopes, free delivery and usage reporting', () => {
  for (const token of [
    "'/admin/banners'",
    "'/admin/coupons'",
    "'/admin/coupon-usages'",
    "'/admin/coupons/usage-history'",
    'FREE_DELIVERY',
    'appliesToAllOutlets',
    'outletIds',
  ]) assert.ok(promotionAdmin.includes(token), token);
  assert.ok(orderService.includes('originalDeliveryFee'));
  assert.ok(orderService.includes('couponSavings'));
});

test('admin rider finance exposes business-wide incoming and outgoing totals', () => {
  assert.ok(riderManagement.includes("'/admin/riders/finance-summary'"));
  assert.ok(riderManagement.includes('totalCodCollected'));
  assert.ok(riderManagement.includes('totalReceivedFromRiders'));
  assert.ok(riderManagement.includes('totalPaidToRiders'));
});
