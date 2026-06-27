const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('outlet inventory is based on the global food catalog and resolves compatibility ids', () => {
  const source = read('src/routes/admin.js');
  assert.match(source, /\/admin\/outlets\/:id\/available-products/);
  assert.match(source, /Product\.find\(\{active:true\}\)/);
  assert.match(source, /resolveObjectId\(Outlet,req\.params\.id\)/);
  assert.match(source, /resolveObjectId\(Product,rawProductId\)/);
  assert.match(source, /stockInitialized:true/);
  assert.match(source, /enabled:false,available:false/);
});

test('SMTP replaces sender API integration and remains dynamically configurable', () => {
  const settings = read('src/services/settingsService.js');
  const email = read('src/services/emailService.js');
  const routes = read('src/routes/adminCustomerEngagement.js');
  assert.match(settings, /smtp_credentials/);
  assert.match(settings, /SMTP_HOST/);
  assert.match(email, /require\('nodemailer'\)/);
  assert.match(email, /createTransport/);
  assert.doesNotMatch(email, /resend\.com/);
  assert.match(routes, /\/admin\/email\/settings/);
  assert.match(routes, /\/admin\/email\/settings\/validate/);
});

test('authenticated admin browser map configuration and compatibility version are exposed', () => {
  const mapRoutes = read('src/routes/adminWebCompatibility.js');
  const app = read('src/app.js');
  assert.match(mapRoutes, /\/admin\/maps\/browser-config/);
  assert.match(mapRoutes, /getGoogleMapsConfig/);
  assert.match(app, /v79-outlet-stock-smtp-map-user-premium/);
});
