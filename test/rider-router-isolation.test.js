const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function source(file) {
  return fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', file), 'utf8');
}

test('customer compatibility guard is namespace-scoped and cannot block rider routes', () => {
  const text = source('customerCompatibility.js');
  assert.doesNotMatch(text, /r\.use\(requireAuth,\s*allowRoles\('CUSTOMER',\s*'ADMIN'\)\)/);
  assert.match(text, /'\/user'[\s\S]*requireAuth,\s*allowRoles\('CUSTOMER',\s*'ADMIN'\)/);
  assert.match(text, /r\.use\('\/notifications',\s*requireAuth\)/);
});

test('seller compatibility guard is namespace-scoped and cannot block rider routes', () => {
  const text = source('sellerAppCompatibility.js');
  assert.doesNotMatch(text, /r\.use\(requireAuth,\s*allowRoles\('SELLER',\s*'ADMIN'\)\)/);
  assert.match(text, /r\.use\(\['\/seller',\s*'\/outlet-manager'\],\s*requireAuth,\s*allowRoles\('SELLER',\s*'ADMIN'\)\)/);
});
