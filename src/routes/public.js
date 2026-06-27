const express = require('express');
const r = express.Router();
const ah = require('../utils/asyncHandler');
const { ok } = require('../utils/respond');
const {
  Category, Brand, Cuisine, Banner, BiteStory, Offer, Coupon,
  Product, Outlet, OutletProduct,
} = require('../models');
const deliveryService = require('../services/deliveryService');
const settings = require('../services/settingsService');
const promotions = require('../services/promotionService');
const { serializeVariantFields } = require('../utils/productVariants');
const { haversineKm } = require('../utils/geo');
const { findOneCompat } = require('../utils/compatId');

const PRESET_OUTLET_LOGO = 'https://res.cloudinary.com/dty0zfd7g/image/upload/v1782468916/mr-breado/brands/file_nzsycz.jpg';
const active = { active: true };

function imageUrl(value) {
  if (!value) return '';
  if (typeof value === 'string') {
    let url = value.trim();
    if (url.startsWith('//')) url = `https:${url}`;
    if (url.startsWith('http://res.cloudinary.com/')) url = url.replace('http://', 'https://');
    if (url.includes('res.cloudinary.com/') && url.includes('/upload/')) {
      url = url.replace(/f_auto/g, 'f_jpg');
      if (!url.includes('/upload/f_jpg') && !url.includes('/upload/q_auto,f_jpg')) {
        url = url.replace('/upload/', '/upload/q_auto,f_jpg/');
      }
    }
    return url;
  }
  if (Array.isArray(value)) return imageUrl(value[0]);
  return imageUrl(value.secure_url || value.secureUrl || value.url || value.src || value.path || value.image || value.imageUrl);
}

function addressText(address) {
  if (typeof address === 'string') return address;
  return [address?.line1, address?.line2, address?.area, address?.landmark, address?.city, address?.state, address?.pincode]
    .filter(Boolean).join(', ');
}

function categoryOut(category) {
  return {
    ...category,
    id: String(category._id), categoryId: String(category._id), title: category.name,
    image: imageUrl(category.image), imageUrl: imageUrl(category.image), icon: imageUrl(category.image),
    status: category.active ? 'ACTIVE' : 'INACTIVE',
  };
}

function brandOut(brand) {
  const image = imageUrl(brand.image);
  return { ...brand, id: String(brand._id), brandId: String(brand._id), image, imageUrl: image, logo: image, enabled: brand.active !== false };
}

function storyOut(story) {
  const media = imageUrl(story.media ?? story.mediaUrl ?? story.thumbnailUrl ?? story.image);
  return { ...story, id: String(story._id), mediaUrl: media, media_url: media, thumbnailUrl: media, thumbnail_url: media, image: media, imageUrl: media, active: story.active !== false };
}

function outletOut(outlet, extra = {}) {
  const logo = imageUrl(outlet.logo) || PRESET_OUTLET_LOGO;
  const banner = imageUrl(outlet.coverImage ?? outlet.cover_image ?? outlet.bannerImage ?? outlet.banner);
  const address = addressText(outlet.address);
  const lat = Number(outlet.location?.coordinates?.[1] ?? outlet.latitude ?? 0);
  const lng = Number(outlet.location?.coordinates?.[0] ?? outlet.longitude ?? 0);
  const distanceKm = extra.distanceKm ?? outlet.distanceKm;
  const serviceable = extra.serviceable ?? outlet.serviceable;
  return {
    ...outlet,
    ...extra,
    id: String(outlet._id), outletId: String(outlet._id), restaurantId: String(outlet._id),
    outletName: outlet.name, restaurantName: outlet.name,
    address, addressText: address, fullAddress: address,
    city: outlet.address?.city || '', state: outlet.address?.state || '', pincode: outlet.address?.pincode || '',
    deliveryRadiusKm: Number(outlet.deliveryRadiusKm || 0), serviceRadiusKm: Number(outlet.deliveryRadiusKm || 0), radiusKm: Number(outlet.deliveryRadiusKm || 0),
    latitude: lat, longitude: lng,
    logo, logoImage: logo, profileImage: logo,
    image: banner || logo, imageUrl: banner || logo, banner, bannerImage: banner, coverImage: banner,
    distanceKm: Number.isFinite(Number(distanceKm)) ? Number(distanceKm) : undefined,
    distance_km: Number.isFinite(Number(distanceKm)) ? Number(distanceKm) : undefined,
    featureToggles: outlet.featureToggles || {}, feature_toggles: outlet.featureToggles || {},
    serviceable: typeof serviceable === 'boolean' ? serviceable : undefined,
    outOfRange: typeof serviceable === 'boolean' ? !serviceable : undefined,
  };
}

function parseCoordinates(query) {
  const latitude = Number(query.latitude ?? query.lat ?? query.userLat ?? query.user_latitude);
  const longitude = Number(query.longitude ?? query.lng ?? query.lon ?? query.userLng ?? query.user_longitude);
  return Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) > 0.000001 && Math.abs(longitude) > 0.000001
    ? { latitude, longitude }
    : null;
}

async function distanceMapForOutlets(user, outlets) {
  const map = new Map();
  if (!user || !outlets.length) return map;
  try {
    const road = await deliveryService.googleRoadDistances(user, outlets);
    for (const outlet of outlets) {
      const route = road.get(String(outlet._id));
      if (route) map.set(String(outlet._id), route);
    }
  } catch (_) {
    for (const outlet of outlets) {
      const lng = Number(outlet.location?.coordinates?.[0]);
      const lat = Number(outlet.location?.coordinates?.[1]);
      if (Number.isFinite(lat) && Number.isFinite(lng) && (lat || lng)) {
        const distanceKm = Number(haversineKm(user.latitude, user.longitude, lat, lng).toFixed(2));
        map.set(String(outlet._id), { distanceKm, durationMinutes: Math.max(1, Math.ceil(distanceKm / 0.35)) });
      }
    }
  }
  return map;
}

function productOut(product, row, outlet, distanceInfo = null) {
  const image = imageUrl(product.images);
  const availableStock = Math.max(0, Number(row.stockQuantity || 0) - Number(row.reservedQuantity || 0));
  const defaultPrice = Number(product.offerPrice > 0 ? product.offerPrice : product.basePrice);
  const price = Number(row.offerPriceOverride ?? row.priceOverride ?? defaultPrice);
  const distanceKm = distanceInfo?.distanceKm;
  const radius = Number(outlet?.deliveryRadiusKm || 0);
  const hasDistance = Number.isFinite(Number(distanceKm));
  const serviceable = hasDistance ? Boolean(outlet?.open && Number(distanceKm) <= radius) : null;
  const outletPayload = outlet ? outletOut(outlet, {
    distanceKm,
    estimatedTravelMinutes: distanceInfo?.durationMinutes,
    serviceable,
  }) : null;
  const availabilityMessage = outlet?.open === false
    ? `${outlet.name} is currently closed.`
    : serviceable === false
      ? `This food is ${Number(distanceKm).toFixed(1)} km away and outside the ${radius.toFixed(1)} km delivery range.`
      : availableStock <= 0
        ? 'This food is currently out of stock.'
        : serviceable === true
          ? `Available from ${outlet.name}, ${Number(distanceKm).toFixed(1)} km away.`
          : `Available from ${outlet?.name || 'this outlet'}. Select a delivery location to check the range.`;
  return {
    ...product,
    ...serializeVariantFields(product),
    _id: String(product._id), id: product.legacyId || String(product._id), productId: product.legacyId || String(product._id), legacyId: product.legacyId, title: product.name,
    image, imageUrl: image, thumbnail: image,
    categoryName: product.categoryId?.name || '', categorySlug: product.categoryId?.slug || '',
    brandId: product.brandId?._id ? String(product.brandId._id) : (product.brandId ? String(product.brandId) : ''),
    brandName: product.brandId?.name || '', brandSlug: product.brandId?.slug || '', brand: product.brandId || null,
    cuisineId: product.cuisineId?._id ? String(product.cuisineId._id) : (product.cuisineId ? String(product.cuisineId) : ''),
    cuisineName: product.cuisineId?.name || '', cuisineSlug: product.cuisineId?.slug || '', cuisine: product.cuisineId || null,
    foodType: product.foodType, isVeg: product.foodType === 'VEG', veg: product.foodType === 'VEG',
    outletProductId: String(row._id), outletId: String(outlet?._id || row.outletId?._id || row.outletId),
    restaurantId: String(outlet?._id || row.outletId?._id || row.outletId),
    outlet: outletPayload, restaurant: outletPayload, store: outletPayload,
    outletName: outlet?.name || '', restaurantName: outlet?.name || '', outletSlug: outlet?.slug || '', restaurantSlug: outlet?.slug || '',
    stockQuantity: Number(row.stockQuantity || 0), reservedQuantity: Number(row.reservedQuantity || 0), availableStock,
    inStock: availableStock > 0, isAvailable: row.enabled !== false && row.available !== false && availableStock > 0,
    available: row.enabled !== false && row.available !== false && availableStock > 0,
    price, effectivePrice: price, basePrice: Number(product.basePrice || 0), offerPrice: Number(product.offerPrice || 0),
    preparationMinutes: Number(row.preparationMinutes || 0), preparationTime: Number(row.preparationMinutes || 0),
    lowStockThreshold: Number(row.lowStockThreshold || 5),
    lowStock: availableStock > 0 && availableStock < Number(row.lowStockThreshold || 5),
    stockMessage: availableStock === 0 ? 'Out of stock' : availableStock < Number(row.lowStockThreshold || 5) ? `Only ${availableStock} left` : '',
    distanceKm: hasDistance ? Number(distanceKm) : undefined,
    distance_km: hasDistance ? Number(distanceKm) : undefined,
    distanceText: hasDistance ? `${Number(distanceKm).toFixed(1)} km` : 'Select location',
    estimatedTravelMinutes: distanceInfo?.durationMinutes,
    deliveryRadiusKm: radius,
    serviceable,
    deliverable: serviceable,
    outOfRange: serviceable === false,
    availabilityMessage,
  };
}

function couponOut(coupon) {
  const type = promotions.normalizeCouponType(coupon.type);
  const benefit = promotions.couponBenefit(coupon);
  return {
    ...coupon,
    id: String(coupon._id),
    code: String(coupon.code || '').trim().toUpperCase(),
    couponCode: String(coupon.code || '').trim().toUpperCase(),
    coupon_code: String(coupon.code || '').trim().toUpperCase(),
    type, discountType: type, discount_type: type,
    value: Number(coupon.value || 0), discountValue: Number(coupon.value || 0), discount_value: Number(coupon.value || 0),
    minOrder: Number(coupon.minOrder || 0), minOrderAmount: Number(coupon.minOrder || 0),
    maxDiscount: Number(coupon.maxDiscount || 0), maxDiscountAmount: Number(coupon.maxDiscount || 0),
    freeDelivery: benefit.freeDelivery, discountText: benefit.label,
    outletIds: (coupon.outletIds || []).map(String),
    appliesToAllOutlets: coupon.appliesToAllOutlets === true || !(coupon.outletIds || []).length,
    activeNow: promotions.isActiveNow(coupon),
  };
}

function offerOut(offer, coupon = null) {
  const image = imageUrl(offer.image ?? offer.banner ?? offer.imageUrl ?? offer.image_url);
  const code = String(offer.code ?? offer.couponCode ?? '').trim().toUpperCase();
  const resolved = coupon || null;
  const source = resolved || offer;
  const type = promotions.normalizeCouponType(source.type ?? source.discountType);
  const benefit = promotions.couponBenefit(source);
  const outletIds = (offer.outletIds || resolved?.outletIds || []).map(String);
  return {
    ...offer,
    id: String(offer._id), image, imageUrl: image, image_url: image, banner: image, bannerImage: image,
    couponCode: code, coupon_code: code, code,
    discountType: type, discount_type: type,
    discountValue: Number(source.value ?? source.discountValue ?? 0), discount_value: Number(source.value ?? source.discountValue ?? 0),
    minOrderAmount: Number(source.minOrder || 0), maxDiscountAmount: Number(source.maxDiscount || 0),
    freeDelivery: benefit.freeDelivery, discountText: benefit.label,
    activeNow: promotions.isActiveNow(offer),
    hasValidCoupon: Boolean(resolved), exploreEnabled: Boolean(resolved), coupon: resolved ? couponOut(resolved) : null,
    outletIds, appliesToAllOutlets: offer.appliesToAllOutlets === true || outletIds.length === 0,
  };
}

function bannerOut(banner, coupon = null) {
  const image = imageUrl(banner.image);
  const code = String(banner.couponCode || (banner.actionType === 'COUPON' ? banner.actionValue : '') || coupon?.code || '').trim().toUpperCase();
  const benefit = promotions.couponBenefit(coupon);
  const outletIds = (banner.outletIds || []).map(String);
  const outletNames = (banner.outletIds || []).map((x) => typeof x === 'object' ? x.name : '').filter(Boolean);
  return {
    ...banner,
    id: String(banner._id), image, imageUrl: image, banner: image, bannerImage: image,
    couponCode: code, coupon_code: code, code,
    actionType: code ? 'COUPON' : (banner.actionType || ''), actionValue: code || banner.actionValue || '',
    hasValidCoupon: code ? Boolean(coupon) : true,
    exploreEnabled: code ? Boolean(coupon) : Boolean(banner.actionValue),
    coupon: coupon ? couponOut(coupon) : null,
    freeDelivery: benefit.freeDelivery, discountText: benefit.label,
    outletIds, outletNames,
    appliesToAllOutlets: banner.appliesToAllOutlets === true || outletIds.length === 0,
    scopeText: banner.appliesToAllOutlets === true || outletIds.length === 0 ? 'Available at every outlet' : `Available at ${outletNames.join(', ') || `${outletIds.length} selected outlet${outletIds.length === 1 ? '' : 's'}`}`,
    startsAt: banner.startAt, endsAt: banner.endAt,
    activeNow: promotions.isActiveNow(banner),
  };
}

async function resolveOutlet(reference) {
  if (!reference) return null;
  return findOneCompat(Outlet, reference, { active: true });
}

async function productFilterFromQuery(query) {
  const filter = { active: true };
  if (query.categoryId || query.category) filter.categoryId = query.categoryId || query.category;
  if (query.cuisineId) filter.cuisineId = query.cuisineId;
  if (query.brandId) filter.brandId = query.brandId;
  if (query.search) filter.name = { $regex: String(query.search), $options: 'i' };
  if (query.cuisine || query.cuisineSlug) {
    const cuisine = await Cuisine.findOne({ slug: String(query.cuisine || query.cuisineSlug).toLowerCase(), active: true }).lean();
    if (!cuisine) return null;
    filter.cuisineId = cuisine._id;
  }
  if (query.brand || query.brandSlug) {
    const brand = await Brand.findOne({ slug: String(query.brand || query.brandSlug).toLowerCase(), active: true }).lean();
    if (!brand) return null;
    filter.brandId = brand._id;
  }
  return filter;
}

async function productRows(query) {
  const filter = await productFilterFromQuery(query);
  if (!filter) return [];
  const productIds = await Product.find(filter).select('_id').lean();
  if (!productIds.length) return [];
  const outletRef = query.outletId || query.outlet_id || query.restaurantId;
  const outlet = await resolveOutlet(outletRef);
  if (outletRef && !outlet) return [];
  const rowQuery = {
    productId: { $in: productIds.map((x) => x._id) },
    enabled: true,
    ...(outlet ? { outletId: outlet._id } : {}),
  };
  if (String(query.availableOnly || '').toLowerCase() !== 'false') rowQuery.available = { $ne: false };
  const rows = await OutletProduct.find(rowQuery)
    .populate({ path: 'productId', match: filter, populate: [{ path: 'categoryId' }, { path: 'brandId' }, { path: 'cuisineId' }] })
    .populate({ path: 'outletId', match: { active: true } }).lean();
  return rows.filter((row) => row.productId && row.outletId);
}

async function menu(outletReference, query = {}) {
  const outlet = await resolveOutlet(outletReference);
  if (!outlet || outlet.active === false) return [];
  const rows = await productRows({ ...query, outletId: outlet._id });
  const user = parseCoordinates(query);
  const distances = await distanceMapForOutlets(user, [outlet]);
  return rows
    .map((row) => productOut(row.productId, row, outlet, distances.get(String(outlet._id))))
    .filter((row) => String(query.inStockOnly || '').toLowerCase() !== 'true' || row.inStock);
}

r.get(['/settings', '/payment/settings', '/payments/settings', '/payment/options', '/app/settings', '/public/settings'], ah(async (req, res) => {
  const features = await settings.getBusinessFeatures();
  const pub = await settings.publicSettings();
  ok(res, {
    ...pub,
    razorpayConfigured: Boolean(pub.payment?.onlinePaymentConfigured), onlinePaymentConfigured: Boolean(pub.payment?.onlinePaymentConfigured),
    razorpayKeyId: pub.razorpayKeyId || pub.payment?.razorpayKeyId || '',
    onlinePaymentEnabled: features.feature_toggles.onlinePayment, codEnabled: features.feature_toggles.cod,
    takeawayEnabled: features.feature_toggles.takeaway, mrBreadoTakeawayEnabled: features.feature_toggles.takeaway,
    deliveryEnabled: features.feature_toggles.delivery, offersEnabled: features.feature_toggles.offers,
    takeawayAdvancePercentage: features.takeaway.advanceValue,
    featureToggles: features.feature_toggles, feature_toggles: features.feature_toggles, takeaway: features.takeaway,
  });
}));

r.get(['/delivery-pricing', '/delivery-charges', '/public/delivery-pricing', '/settings/delivery-pricing'], ah(async (req, res) => {
  const pricing = await settings.getDeliveryPricing();
  ok(res, {
    ...pricing,
    baseDeliveryCharge: pricing.customer.baseCharge, deliveryChargePerKm: pricing.customer.perKmCharge,
    minimumDeliveryCharge: pricing.customer.minimumCharge, maximumDeliveryCharge: pricing.customer.maximumCharge,
    riderBasePay: pricing.rider.basePay, riderPayPerKm: pricing.rider.perKmRate,
    minimumRiderDeliveryPay: pricing.rider.minimumDeliveryPay,
  });
}));

r.get(['/categories', '/food-categories'], ah(async (req, res) => ok(res, (await Category.find(active).sort({ sortOrder: 1, name: 1 }).lean()).map(categoryOut))));
r.get('/categories/sub-categories', ah(async (req, res) => ok(res, (await Category.find({ active: true, parentId: { $ne: null } }).lean()).map(categoryOut))));
r.get('/brands', ah(async (req, res) => ok(res, (await Brand.find(active).sort({ name: 1 }).lean()).map(brandOut))));
r.get('/cuisines', ah(async (req, res) => ok(res, (await Cuisine.find(active).sort({ sortOrder: 1, name: 1 }).lean()).map((x) => ({ ...x, id: String(x._id), title: x.name, image: imageUrl(x.image), imageUrl: imageUrl(x.image), status: x.active ? 'Active' : 'Inactive' })))));

r.get('/banners', ah(async (req, res) => {
  await promotions.deactivateExpired();
  const now = new Date();
  const outletId = req.query.outletId || req.query.outlet_id || req.query.restaurantId;
  const scope = outletId ? promotions.outletScope(outletId) : { $or: [{ appliesToAllOutlets: true }, { appliesToAllOutlets: { $exists: false }, outletIds: { $size: 0 } }] };
  const rows = await Banner.find({ active: true, ...promotions.dateWindow(now), ...scope }).populate('outletIds', 'name code slug').sort({ sortOrder: 1, createdAt: -1 }).lean();
  const coupons = await promotions.validCouponMap({ outletId, now });
  ok(res, rows.map((banner) => {
    const code = String(banner.couponCode || (banner.actionType === 'COUPON' ? banner.actionValue : '') || '').trim().toUpperCase();
    return bannerOut(banner, code ? coupons.get(code) : null);
  }).filter((banner) => !banner.couponCode || banner.hasValidCoupon));
}));

r.get('/stories', ah(async (req, res) => {
  const now = new Date();
  const rows = await BiteStory.find({ active: true, $and: [
    { $or: [{ startsAt: null }, { startsAt: { $exists: false } }, { startsAt: { $lte: now } }] },
    { $or: [{ endsAt: null }, { endsAt: { $exists: false } }, { endsAt: { $gte: now } }] },
  ] }).sort({ sortOrder: 1, createdAt: -1 }).lean();
  ok(res, rows.map(storyOut));
}));

r.get('/offers', ah(async (req, res) => {
  await promotions.deactivateExpired();
  const now = new Date();
  const outletId = req.query.outletId || req.query.outlet_id || req.query.restaurantId;
  const scope = outletId ? promotions.outletScope(outletId) : { $or: [{ appliesToAllOutlets: true }, { appliesToAllOutlets: { $exists: false }, outletIds: { $size: 0 } }] };
  const [offers, coupons] = await Promise.all([
    Offer.find({ active: true, ...promotions.dateWindow(now), ...scope }).lean(),
    Coupon.find({ active: true, ...promotions.dateWindow(now), ...scope }).lean(),
  ]);
  const couponByCode = new Map(coupons.map((coupon) => [String(coupon.code || '').trim().toUpperCase(), coupon]));
  ok(res, offers.map((offer) => offerOut(offer, couponByCode.get(String(offer.code || '').trim().toUpperCase()))).filter((offer) => !offer.code || offer.hasValidCoupon));
}));

r.get('/products', ah(async (req, res) => {
  const rows = await productRows(req.query);
  const outletsById = new Map(rows.map((row) => [String(row.outletId._id), row.outletId]));
  const distances = await distanceMapForOutlets(parseCoordinates(req.query), [...outletsById.values()]);
  let result = rows.map((row) => productOut(row.productId, row, row.outletId, distances.get(String(row.outletId._id))));
  if (String(req.query.inStockOnly || '').toLowerCase() === 'true') result = result.filter((row) => row.inStock);
  result.sort((a, b) => (a.distanceKm ?? Number.MAX_SAFE_INTEGER) - (b.distanceKm ?? Number.MAX_SAFE_INTEGER) || a.title.localeCompare(b.title));
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Math.max(1, Number(req.query.per_page || req.query.perPage || req.query.limit || 30)));
  const start = (page - 1) * limit;
  ok(res, { items: result.slice(start, start + limit), page, perPage: limit, per_page: limit, total: result.length, totalPages: Math.max(1, Math.ceil(result.length / limit)), total_pages: Math.max(1, Math.ceil(result.length / limit)) });
}));

r.get('/products/:slug', ah(async (req, res) => {
  const product = await Product.findOne({ slug: req.params.slug, active: true }).populate('categoryId brandId cuisineId').lean();
  if (!product) return ok(res, null);
  const outletRef = req.query.outletId || req.query.outlet_id || req.query.restaurantId;
  const targetOutlet = await resolveOutlet(outletRef);
  const rows = await OutletProduct.find({ productId: product._id, enabled: true, available: { $ne: false }, ...(targetOutlet ? { outletId: targetOutlet._id } : {}) }).populate({ path: 'outletId', match: { active: true } }).lean();
  const validRows = rows.filter((row) => row.outletId);
  const outlets = validRows.map((row) => row.outletId);
  const distances = await distanceMapForOutlets(parseCoordinates(req.query), outlets);
  const choices = validRows.map((row) => ({ row, outlet: row.outletId, distance: distances.get(String(row.outletId._id)) }))
    .sort((a, b) => (a.distance?.distanceKm ?? Number.MAX_SAFE_INTEGER) - (b.distance?.distanceKm ?? Number.MAX_SAFE_INTEGER));
  const selected = choices[0];
  if (!selected) {
    const image = imageUrl(product.images);
    return ok(res, { ...product, ...serializeVariantFields(product), _id: String(product._id), id: product.legacyId || String(product._id), productId: product.legacyId || String(product._id), legacyId: product.legacyId, title: product.name, image, imageUrl: image, available: false, inStock: false, serviceable: false, outOfRange: false, availabilityMessage: 'This food is not enabled at any outlet right now.', relatedProducts: [] });
  }
  const detail = productOut(product, selected.row, selected.outlet, selected.distance);
  const relatedRows = await OutletProduct.find({ outletId: selected.outlet._id, productId: { $ne: product._id }, enabled: true, available: { $ne: false } }).populate({ path: 'productId', match: { active: true }, populate: [{ path: 'categoryId' }, { path: 'brandId' }, { path: 'cuisineId' }] }).limit(12).lean();
  const relatedProducts = relatedRows.filter((row) => row.productId).map((row) => productOut(row.productId, row, selected.outlet, selected.distance));
  ok(res, { ...detail, relatedProducts, discoverMore: relatedProducts, outletFoods: relatedProducts });
}));

r.get(['/restaurants', '/outlets'], ah(async (req, res) => {
  const rows = await Outlet.find({ active: true }).lean();
  const distances = await distanceMapForOutlets(parseCoordinates(req.query), rows);
  const data = rows.map((outlet) => {
    const route = distances.get(String(outlet._id));
    const serviceable = route?.distanceKm != null ? outlet.open && route.distanceKm <= Number(outlet.deliveryRadiusKm || 0) : undefined;
    return outletOut(outlet, { distanceKm: route?.distanceKm, exactDistanceKm: route?.distanceKm, estimatedTravelMinutes: route?.durationMinutes, serviceable });
  }).sort((a, b) => (a.distanceKm ?? Number.MAX_SAFE_INTEGER) - (b.distanceKm ?? Number.MAX_SAFE_INTEGER));
  ok(res, data);
}));

r.get(['/restaurants/nearby', '/outlets/nearby'], ah(async (req, res) => {
  const rows = await Outlet.find({ active: true, open: true }).lean();
  const distances = await distanceMapForOutlets(parseCoordinates(req.query), rows);
  const data = rows.map((outlet) => {
    const route = distances.get(String(outlet._id));
    const serviceable = route?.distanceKm != null && route.distanceKm <= Number(outlet.deliveryRadiusKm || 0);
    return outletOut(outlet, { distanceKm: route?.distanceKm, estimatedTravelMinutes: route?.durationMinutes, serviceable });
  }).filter((outlet) => outlet.serviceable !== false).sort((a, b) => (a.distanceKm ?? Number.MAX_SAFE_INTEGER) - (b.distanceKm ?? Number.MAX_SAFE_INTEGER));
  ok(res, data);
}));

r.get(['/restaurants/:slug', '/stores/:slug'], ah(async (req, res) => {
  const outlet = await Outlet.findOne({ slug: req.params.slug, active: true }).lean();
  if (!outlet) return ok(res, null);
  const distances = await distanceMapForOutlets(parseCoordinates(req.query), [outlet]);
  const route = distances.get(String(outlet._id));
  ok(res, outletOut(outlet, { distanceKm: route?.distanceKm, estimatedTravelMinutes: route?.durationMinutes, serviceable: route?.distanceKm != null ? outlet.open && route.distanceKm <= Number(outlet.deliveryRadiusKm || 0) : undefined }));
}));

r.get(['/outlets/:id/menu', '/user/outlets/:id/menu', '/outlets/:id/foods/search', '/user/outlets/:id/foods/search'], ah(async (req, res) => ok(res, await menu(req.params.id, req.query))));
r.get(['/stores/:slug/menu', '/restaurants/:slug/menu'], ah(async (req, res) => {
  const outlet = await Outlet.findOne({ slug: req.params.slug, active: true });
  ok(res, outlet ? await menu(outlet._id, req.query) : []);
}));

r.get('/home', ah(async (req, res) => {
  await promotions.deactivateExpired();
  const now = new Date();
  const user = parseCoordinates(req.query);
  let outlets = [];
  let nearestOutlet = null;
  let serviceability = null;
  let products = [];
  if (user) {
    serviceability = await deliveryService.checkServiceability(user).catch(() => null);
    if (serviceability?.nearestOutletId) {
      const outlet = await Outlet.findById(serviceability.nearestOutletId).lean();
      if (outlet) {
        nearestOutlet = outletOut(outlet, { distanceKm: serviceability.distanceKm, estimatedTravelMinutes: serviceability.estimatedTravelMinutes, serviceable: serviceability.serviceable });
        outlets = [nearestOutlet];
        products = await menu(outlet._id, req.query);
      }
    }
  } else {
    outlets = (await Outlet.find({ active: true }).limit(10).lean()).map((outlet) => outletOut(outlet));
  }
  const selectedOutletId = nearestOutlet?.id || req.query.outletId || req.query.outlet_id || null;
  const scope = selectedOutletId ? promotions.outletScope(selectedOutletId) : { $or: [{ appliesToAllOutlets: true }, { appliesToAllOutlets: { $exists: false }, outletIds: { $size: 0 } }] };
  const [banners, categories, brands, cuisines, offers, coupons, stories] = await Promise.all([
    Banner.find({ active: true, ...promotions.dateWindow(now), ...scope }).populate('outletIds', 'name code slug').sort({ sortOrder: 1 }).lean(),
    Category.find(active).sort({ sortOrder: 1 }).lean(), Brand.find(active).sort({ name: 1 }).lean(), Cuisine.find(active).sort({ sortOrder: 1, name: 1 }).lean(),
    Offer.find({ active: true, ...promotions.dateWindow(now), ...scope }).lean(), Coupon.find({ active: true, ...promotions.dateWindow(now), ...scope }).lean(),
    BiteStory.find({ active: true, ...promotions.dateWindow(now) }).sort({ sortOrder: 1, createdAt: -1 }).lean(),
  ]);
  const couponByCode = new Map(coupons.map((coupon) => [String(coupon.code || '').trim().toUpperCase(), coupon]));
  const bannerRows = banners.map((banner) => {
    const code = String(banner.couponCode || (banner.actionType === 'COUPON' ? banner.actionValue : '') || '').trim().toUpperCase();
    return bannerOut(banner, code ? couponByCode.get(code) : null);
  }).filter((banner) => !banner.couponCode || banner.hasValidCoupon);
  const offerRows = offers.map((offer) => offerOut(offer, couponByCode.get(String(offer.code || '').trim().toUpperCase()))).filter((offer) => !offer.code || offer.hasValidCoupon);
  ok(res, {
    stories: stories.map(storyOut), banners: bannerRows,
    categories: categories.map(categoryOut), cuisines: cuisines.map((cuisine) => ({ ...cuisine, id: String(cuisine._id), title: cuisine.name, image: imageUrl(cuisine.image), imageUrl: imageUrl(cuisine.image) })),
    brands: brands.map(brandOut), offers: offerRows, coupons: coupons.map(couponOut),
    outlets, restaurants: outlets, nearestOutlet, products, featuredFoods: products, popularFoods: products,
    serviceability, noOutletAvailable: Boolean(serviceability && !serviceability.serviceable), message: serviceability?.message || '',
  });
}));

module.exports = r;
