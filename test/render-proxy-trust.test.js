const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || 'test-settings-encryption-key';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const app = require('../src/app');

test('Render reverse proxy is trusted by exactly one hop', () => {
  assert.equal(app.get('trust proxy'), 1);
});
