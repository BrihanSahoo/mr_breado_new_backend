const test=require('node:test');const assert=require('node:assert/strict');const {haversineKm,deliveryCharge}=require('../src/utils/geo');const {canonical,transitions}=require('../src/services/orderService');
test('distance is zero for same coordinates',()=>assert.equal(haversineKm(22.5,88.3,22.5,88.3),0));
test('delivery fee respects min and max',()=>{assert.equal(deliveryCharge(0,{baseCharge:0,perKmCharge:5,minimumCharge:20,maximumCharge:100}),20);assert.equal(deliveryCharge(100,{baseCharge:0,perKmCharge:5,minimumCharge:20,maximumCharge:100}),100)});
test('legacy statuses normalize',()=>{assert.equal(canonical('PLACED'),'RECEIVED');assert.equal(canonical('OUT_FOR_DELIVERY'),'PICKED_UP')});
test('delivered is terminal',()=>assert.deepEqual(transitions.DELIVERED,[]));
