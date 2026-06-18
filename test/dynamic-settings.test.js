const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

test('payment service resolves runtime credentials instead of static env credentials',()=>{
  const source=fs.readFileSync(require.resolve('../src/services/paymentService'),'utf8');
  assert.match(source,/getRazorpayConfig/);
  assert.doesNotMatch(source,/env\.razorpay/);
});

test('secret settings use authenticated encryption',()=>{
  const source=fs.readFileSync(require.resolve('../src/services/settingsService'),'utf8');
  assert.match(source,/aes-256-gcm/);
  assert.match(source,/encryptedValue/);
  assert.match(source,/encryptionTag/);
});

test('business feature settings validate takeaway percentage',()=>{
  const settings=require('../src/services/settingsService');
  assert.deepEqual(settings.normalizeTakeaway({advancePercentage:35}),{advanceType:'PERCENT',advanceValue:35});
  assert.throws(()=>settings.normalizeTakeaway({advancePercentage:101}),/between 0 and 100/);
});
