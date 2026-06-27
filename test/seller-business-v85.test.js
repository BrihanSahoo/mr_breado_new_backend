const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');

const route = fs.readFileSync(require.resolve('../src/routes/sellerAppCompatibility'), 'utf8');

test('seller business routes accept canonical and compatibility outlet context', () => {
  assert.match(route, /req\.query\.outletId/);
  assert.match(route, /req\.query\.outlet_id/);
  assert.match(route, /x-outlet-id/);
  assert.match(route, /outlet-manager\/business-summary/);
});
