const { AppError } = require('./errors');

const n = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};
const clean = (value) => String(value ?? '').trim();
const b = (value, fallback=false) => { if(value===undefined||value===null||value==='') return fallback; if(typeof value==='boolean') return value; return ['true','1','yes','on'].includes(String(value).trim().toLowerCase()); };
const categoryKind = (category) => {
  const value = `${category?.name || ''} ${category?.slug || ''}`.toLowerCase();
  if (value.includes('pizza')) return 'PIZZA';
  if (value.includes('cake')) return 'CAKE';
  return 'STANDARD';
};

const parseCustomWeights = (value) => {
  if (value === undefined || value === null || value === '') return [];
  let rows = value;
  if (typeof rows === 'string') {
    try { rows = JSON.parse(rows); } catch (_) { throw new AppError('Custom cake weights must be valid JSON', 400, 'INVALID_CUSTOM_WEIGHTS'); }
  }
  if (!Array.isArray(rows)) throw new AppError('Custom cake weights must be a list', 400, 'INVALID_CUSTOM_WEIGHTS');
  const seen = new Set();
  return rows.map((row, index) => {
    const label = clean(row?.label ?? row?.name ?? row?.weight);
    const grams = Number(row?.grams ?? row?.weightGrams ?? row?.weight_grams);
    const price = Number(row?.price);
    if (!label) throw new AppError(`Custom weight ${index + 1} needs a label`, 400, 'INVALID_CUSTOM_WEIGHT_LABEL');
    if (!Number.isFinite(grams) || grams <= 0) throw new AppError(`Custom weight ${label} needs valid grams`, 400, 'INVALID_CUSTOM_WEIGHT_GRAMS');
    if (!Number.isFinite(price) || price <= 0) throw new AppError(`Custom weight ${label} needs a valid price`, 400, 'INVALID_CUSTOM_WEIGHT_PRICE');
    const key = label.toLowerCase().replace(/\s+/g, '');
    if (seen.has(key)) throw new AppError(`Duplicate custom weight: ${label}`, 400, 'DUPLICATE_CUSTOM_WEIGHT');
    seen.add(key);
    return { label, grams: Math.round(grams), price: Number(price.toFixed(2)), active: row?.active !== false };
  }).sort((a,b)=>a.grams-b.grams);
};

const option = (name, absolutePrice, basePrice, isDefault = false) => ({
  name,
  price: Number(Math.max(0, n(absolutePrice) - n(basePrice)).toFixed(2)),
  active: true,
  default: isDefault,
});

function buildVariantFields(body, category) {
  const kind = categoryKind(category);
  if (kind === 'PIZZA') {
    const small = n(body.smallSizePrice ?? body.small_size_price ?? body.smallSizeExtra ?? body.small_price ?? body.basePrice ?? body.price);
    const medium = n(body.mediumSizePrice ?? body.medium_size_price ?? body.mediumSizeExtra ?? body.medium_price, small);
    const large = n(body.largeSizePrice ?? body.large_size_price ?? body.largeSizeExtra ?? body.large_price, medium);
    if (small <= 0) throw new AppError('Small pizza price must be greater than zero', 400, 'INVALID_PIZZA_PRICE');
    return {
      variantType: 'PIZZA', defaultVariant: 'SMALL', basePrice: small,
      offerPrice: n(body.offerPrice ?? body.discountPrice ?? body.discount_price, 0),
      sizePrices: { small, medium, large }, weightPrices: undefined,
      customizationGroups: [{
        name: 'Pizza Size', type: 'SINGLE', required: true, minSelect: 1, maxSelect: 1,
        options: [option('Small', small, small, true), option('Medium', medium, small), option('Large', large, small)],
      }],
    };
  }
  if (kind === 'CAKE') {
    const gm500 = n(body.cake500gmPrice ?? body.cake_500gm_price ?? body.cake500gmExtra ?? body.basePrice ?? body.price);
    const kg1 = n(body.cake1kgPrice ?? body.cake_1kg_price ?? body.cake1kgExtra, gm500);
    const kg15 = n(body.cake15kgPrice ?? body.cake_1_5kg_price ?? body.cake15kgExtra, kg1);
    const kg2 = n(body.cake2kgPrice ?? body.cake_2kg_price ?? body.cake2kgExtra, kg15);
    if (gm500 <= 0) throw new AppError('500gm cake price must be greater than zero', 400, 'INVALID_CAKE_PRICE');
    const cakeMessageEnabled = b(body.cakeMessageEnabled ?? body.cake_message_enabled, false);
    const cakeMessageCharge = n(body.cakeMessageCharge ?? body.cake_message_charge, 0);
    const customWeightEnabled = b(body.customWeightEnabled ?? body.custom_weight_enabled, false);
    const customWeightOptions = customWeightEnabled ? parseCustomWeights(body.customWeightOptions ?? body.custom_weight_options) : [];
    const groups = [{
      name: 'Cake Weight', type: 'SINGLE', required: true, minSelect: 1, maxSelect: 1,
      options: [
        option('500 gm', gm500, gm500, true), option('1 kg', kg1, gm500), option('1.5 kg', kg15, gm500), option('2 kg', kg2, gm500),
        ...customWeightOptions.filter((x) => x.active).map((x) => option(x.label, x.price, gm500)),
      ],
    }];
    if (cakeMessageEnabled) groups.push({
      name: 'Cake Message', type: 'SINGLE', required: false, minSelect: 0, maxSelect: 1,
      options: [{ name: 'Add message on cake', price: cakeMessageCharge, active: true, default: false }],
    });
    return {
      variantType: 'CAKE', defaultVariant: '500_GM', basePrice: gm500,
      offerPrice: n(body.offerPrice ?? body.discountPrice ?? body.discount_price, 0),
      weightPrices: { gm500, kg1, kg15, kg2 }, sizePrices: undefined,
      cakeMessageEnabled, cakeMessageCharge,
      customWeightEnabled, customWeightOptions,
      customizationGroups: groups,
    };
  }
  const basePrice = n(body.basePrice ?? body.price ?? body.sellingPrice);
  return {
    variantType: 'STANDARD', defaultVariant: '', basePrice,
    offerPrice: n(body.offerPrice ?? body.discountPrice ?? body.discount_price, 0),
    sizePrices: undefined, weightPrices: undefined,
    cakeMessageEnabled: false, cakeMessageCharge: 0, customWeightEnabled: false, customWeightOptions: [],
    customizationGroups: Array.isArray(body.customizationGroups) ? body.customizationGroups : [],
  };
}

function serializeVariantFields(product) {
  if (!product) return {};
  const sizes = product.sizePrices || {};
  const weights = product.weightPrices || {};
  return {
    variantType: product.variantType || 'STANDARD', variant_type: product.variantType || 'STANDARD',
    defaultVariant: product.defaultVariant || '', default_variant: product.defaultVariant || '',
    smallSizePrice: sizes.small, small_size_price: sizes.small,
    mediumSizePrice: sizes.medium, medium_size_price: sizes.medium,
    largeSizePrice: sizes.large, large_size_price: sizes.large,
    cake500gmPrice: weights.gm500, cake_500gm_price: weights.gm500,
    cake1kgPrice: weights.kg1, cake_1kg_price: weights.kg1,
    cake15kgPrice: weights.kg15, cake_1_5kg_price: weights.kg15,
    cake2kgPrice: weights.kg2, cake_2kg_price: weights.kg2,
    cakeMessageEnabled: Boolean(product.cakeMessageEnabled), cake_message_enabled: Boolean(product.cakeMessageEnabled),
    cakeMessageCharge: n(product.cakeMessageCharge), cake_message_charge: n(product.cakeMessageCharge),
    customWeightEnabled: Boolean(product.customWeightEnabled), custom_weight_enabled: Boolean(product.customWeightEnabled),
    customWeightOptions: product.customWeightOptions || [], custom_weight_options: product.customWeightOptions || [],
    customizationGroups: product.customizationGroups || [], customization_groups: product.customizationGroups || [],
  };
}

module.exports = { buildVariantFields, serializeVariantFields, categoryKind, clean };
