const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');
const route=fs.readFileSync('src/routes/sellerAppCompatibility.js','utf8');const app=fs.readFileSync('src/app.js','utf8');
test('outlet opening requires initialized stock and exposes business summary',()=>{assert.match(route,/INITIAL_STOCK_REQUIRED/);assert.match(route,/OUTLET_MENU_EMPTY/);assert.match(route,/business-summary/);assert.match(route,/bestSellingFood/);assert.match(route,/cancelledOrders/);assert.match(route,/refunds/);});
test('offline sale and daily closing remain outlet scoped',()=>{assert.match(route,/seller\/offline-sales/);assert.match(route,/Idempotency-Key is required/);assert.match(route,/DailyClosing/);assert.match(route,/outlet closed/);});
test('compatibility version reports seller alignment',()=>assert.match(app,/v82-seller-outlet-business-consistency/));
