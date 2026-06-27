const test = require('node:test');
const assert = require('node:assert/strict');
const { buildVariantFields, serializeVariantFields } = require('../src/utils/productVariants');

test('cake custom weights are validated, persisted and serialized', () => {
  const fields = buildVariantFields({
    cake500gmPrice: 300, cake1kgPrice: 550, cake15kgPrice: 800, cake2kgPrice: 1000,
    customWeightEnabled: true,
    customWeightOptions: JSON.stringify([
      { label: '2.5 kg', grams: 2500, price: 1250 },
      { label: '3 kg', grams: 3000, price: 1450 },
    ]),
  }, { name: 'Birthday Cake', slug: 'cake' });
  assert.equal(fields.variantType, 'CAKE');
  assert.equal(fields.customWeightOptions.length, 2);
  assert.equal(fields.customizationGroups[0].options.at(-1).name, '3 kg');
  const output = serializeVariantFields(fields);
  assert.equal(output.custom_weight_options[0].grams, 2500);
});
