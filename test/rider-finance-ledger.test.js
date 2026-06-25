const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const app = read('src/app.js');
const routes = read('src/routes/riderFinance.js');
const compatibility = read('src/routes/riderAppCompatibility.js');
const verification = read('src/routes/riderVerificationOnboarding.js');
const models = read('src/models/index.js');
const financeService = read('src/services/riderFinanceService.js');

function indexOfRoute(name) { return app.indexOf(`./routes/${name}`); }

test('finance router is mounted before legacy rider compatibility routes', () => {
  assert.ok(indexOfRoute('riderFinance') > -1);
  assert.ok(indexOfRoute('riderFinance') < indexOfRoute('riderManagement'));
  assert.ok(indexOfRoute('riderFinance') < indexOfRoute('riderAppCompatibility'));
});

test('rider finance exposes audited cash, Razorpay, payout and ledger endpoints', () => {
  for (const endpoint of [
    '/rider/finance/summary-v2',
    '/rider/finance/history',
    '/rider/cash/settlements',
    '/rider/cash/settlements/razorpay/order',
    '/rider/cash/settlements/razorpay/verify',
    '/admin/rider-settlements',
    '/admin/rider-settlements/:id/approve',
    '/admin/rider-settlements/:id/reject',
    '/admin/rider-payouts/:id/mark-paid',
    '/admin/rider-finance-ledger',
  ]) assert.ok(routes.includes(endpoint), endpoint);
});

test('legacy cash deposit no longer clears COD without admin approval', () => {
  const depositStart = compatibility.indexOf("router.post(['/delivery/cash/deposit'");
  const payoutStart = compatibility.indexOf("router.get(['/delivery/payout-account'", depositStart);
  const block = compatibility.slice(depositStart, payoutStart);
  assert.ok(block.includes('createCashSettlementRequest'));
  assert.doesNotMatch(block, /RiderCashTransaction\.create/);
});

test('passport photo is persisted and included in verification upload contract', () => {
  assert.ok(models.includes('passportPhoto:imageSchema'));
  assert.ok(verification.includes("{ name: 'passportPhoto', maxCount: 1 }"));
  assert.ok(verification.includes('rider.riderProfile.passportPhoto'));
});

test('finance models preserve both money directions and payout confirmation', () => {
  assert.ok(models.includes("enum:['CASH','RAZORPAY']"));
  assert.ok(models.includes("enum:['PENDING','APPROVED','PAID','REJECTED','FAILED','CANCELLED']"));
  assert.ok(financeService.includes("direction: 'RIDER_TO_ADMIN'"));
  assert.ok(financeService.includes("direction: 'ADMIN_TO_RIDER'"));
  assert.ok(routes.includes("RiderEarning.updateMany"));
});
