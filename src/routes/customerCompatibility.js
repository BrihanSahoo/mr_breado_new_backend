const r = require('express').Router();
const ah = require('../utils/asyncHandler');
const { ok, embeddedLegacyId } = require('../utils/respond');
const { requireAuth, allowRoles } = require('../middleware/auth');
const {
  User, Outlet, Category, Brand, Banner, BiteStory, Offer, Coupon, Product, OutletProduct, Cart, Order,
  OrderEvent, Review, RiderLocation, Payment, Notification, SupportTicket
} = require('../models');
const settings = require('../services/settingsService');
const orderService = require('../services/orderService');
const paymentService = require('../services/paymentService');
const invoiceService = require('../services/invoiceService');
const { haversineKm, deliveryCharge } = require('../utils/geo');
const { AppError } = require('../utils/errors');
const { serializeVariantFields } = require('../utils/productVariants');
const { findOneCompat, resolveObjectId, findEmbeddedByCompatId } = require('../utils/compatId');
const deliveryService = require('../services/deliveryService');
const trackingRouteService = require('../services/trackingRouteService');

const activeOutlet = { active: true, open: true };
const numberOrNull = (v) => Number.isFinite(Number(v)) ? Number(v) : null;
const readLat = (x = {}) => numberOrNull(x.latitude ?? x.lat ?? x.userLat ?? x.userLatitude ?? x.user_latitude);
const readLng = (x = {}) => numberOrNull(x.longitude ?? x.lng ?? x.userLng ?? x.userLongitude ?? x.user_longitude);
const text = (v) => String(v ?? '').trim();
const imageUrl = (v) => { if (!v) return ''; if (typeof v === 'string') { let t=v.trim(); if(!t||t==='[object Object]') return ''; if((t.startsWith('{')&&t.endsWith('}'))||(t.startsWith('[')&&t.endsWith(']'))){ try{return imageUrl(JSON.parse(t));}catch(_){} } if(t.startsWith('//'))t=`https:${t}`; if(t.startsWith('http://res.cloudinary.com/'))t=t.replace('http://','https://'); if(t.includes('res.cloudinary.com/')&&t.includes('/upload/')){t=t.replace(/f_auto/g,'f_jpg');if(!t.includes('/upload/f_jpg')&&!t.includes('/upload/q_auto,f_jpg'))t=t.replace('/upload/','/upload/q_auto,f_jpg/');} return t; } if (Array.isArray(v)) return imageUrl(v[0]); return imageUrl(v.secure_url || v.secureUrl || v.url || v.src || v.path || v.image || v.imageUrl); };
const categoryOut = (c) => ({ ...c, id: c.legacyId ?? String(c._id), categoryId: c.legacyId ?? String(c._id), title: c.name, image: imageUrl(c.image), imageUrl: imageUrl(c.image), icon: imageUrl(c.image), status: c.active ? 'ACTIVE' : 'INACTIVE' });
const bannerOut = (b) => ({ ...b, id: b.legacyId ?? String(b._id), image: imageUrl(b.image), imageUrl: imageUrl(b.image), banner: imageUrl(b.image), couponCode: b.actionType === 'COUPON' ? b.actionValue : undefined });
const offerOut = (o) => { const image=imageUrl(o.image ?? o.banner ?? o.imageUrl ?? o.image_url); const code=text(o.code ?? o.couponCode ?? o.coupon_code).toUpperCase(); const type=text(o.type ?? o.discountType ?? o.discount_type).toUpperCase(); return ({ ...o, id: o.legacyId ?? String(o._id), image, imageUrl:image, image_url:image, banner:image, bannerImage:image, couponCode:code, coupon_code:code, code, discountType:type, discount_type:type, discountValue:Number(o.value ?? o.discountValue ?? o.discount_value ?? 0), discount_value:Number(o.value ?? o.discountValue ?? o.discount_value ?? 0), subtitle:o.subtitle ?? '', activeNow:o.active !== false }); };
const outletOut = (o) => { if(!o) return o; const logo=imageUrl(o.logo); const banner=imageUrl(o.coverImage ?? o.cover_image ?? o.bannerImage ?? o.banner); const address=[o.address?.line1,o.address?.line2,o.address?.area,o.address?.landmark,o.address?.city,o.address?.state,o.address?.pincode].filter(Boolean).join(', '); return ({...o,id:o.legacyId ?? String(o._id),outletId:o.legacyId ?? String(o._id),restaurantId:o.legacyId ?? String(o._id),outletName:o.name,restaurantName:o.name,logo:logo,logoImage:logo,profileImage:logo,image:banner||logo,imageUrl:banner||logo,banner:banner,bannerImage:banner,coverImage:banner,address:address,addressText:address,fullAddress:address,latitude:o.location?.coordinates?.[1]??0,longitude:o.location?.coordinates?.[0]??0,deliveryRadiusKm:Number(o.deliveryRadiusKm||0),serviceRadiusKm:Number(o.deliveryRadiusKm||0),radiusKm:Number(o.deliveryRadiusKm||0)}); };

async function nearestOutlet(lat, lng) {
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    const rows = await Outlet.aggregate([
      { $geoNear: { near: { type: 'Point', coordinates: [lng, lat] }, distanceField: 'distanceMeters', spherical: true, query: activeOutlet } },
      { $addFields: { distanceKm: { $divide: ['$distanceMeters', 1000] } } },
      { $match: { $expr: { $lte: ['$distanceKm', '$deliveryRadiusKm'] } } },
      { $sort: { primary: -1, distanceMeters: 1 } },
      { $limit: 1 }
    ]);
    if (rows[0]) return rows[0];
  }
  return Outlet.findOne({ ...activeOutlet, primary: true }).lean()
    || Outlet.findOne(activeOutlet).sort({ primary: -1, createdAt: 1 }).lean();
}

async function resolveOutlet(value) {
  return findOneCompat(Outlet, value, activeOutlet);
}

async function menu(outletId, query = {}) {
  const rows = await OutletProduct.find({ outletId, enabled: true, available: true })
    .populate({ path: 'productId', match: { active: true }, populate: [{ path: 'categoryId' }, { path: 'brandId' }] })
    .populate('outletId')
    .lean();
  const search = text(query.search ?? query.q).toLowerCase();
  const category = text(query.categoryId ?? query.category).toLowerCase();
  const requestedBrand = text(query.brandId ?? query.brand_id ?? query.brandSlug ?? query.brand_slug ?? query.brand).toLowerCase();

  // Brand pages must be strict. A requested brand is resolved only against an
  // active admin-created Brand record, and products without that exact brandId
  // are excluded. Never infer a brand from product/outlet names.
  let resolvedBrandId = '';
  if (requestedBrand) {
    const brand = await Brand.findOne({
      active: true,
      $or: [
        ...(require('mongoose').isValidObjectId(requestedBrand) ? [{ _id: requestedBrand }] : []),
        { slug: requestedBrand },
        { name: new RegExp(`^${requestedBrand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
      ],
    }).select('_id slug').lean();
    if (!brand) return [];
    resolvedBrandId = String(brand._id);
  }

  return rows
    .filter((row) => row.productId && row.outletId)
    .filter((row) => !search || [row.productId.name, row.productId.description, row.productId.sku].some((v) => text(v).toLowerCase().includes(search)))
    .filter((row) => !category || [
      String(row.productId.categoryId?._id || ''),
      String(row.productId.categoryId?.legacyId || ''),
      text(row.productId.categoryId?.slug).toLowerCase(),
      text(row.productId.categoryId?.name).toLowerCase()
    ].includes(category))
    .filter((row) => !resolvedBrandId || String(row.productId.brandId?._id || row.productId.brandId || '') === resolvedBrandId)
    .map((row) => ({
      ...row.productId,
      ...serializeVariantFields(row.productId),
      id: row.productId.legacyId ?? String(row.productId._id),
      productId: row.productId.legacyId ?? String(row.productId._id),
      product_id: row.productId.legacyId ?? String(row.productId._id),
      title: row.productId.name,
      image: imageUrl(row.productId.images),
      imageUrl: imageUrl(row.productId.images),
      thumbnail: imageUrl(row.productId.images),
      categoryName: row.productId.categoryId?.name || '',
      brandId: row.productId.brandId?._id ? String(row.productId.brandId._id) : '',
      brand_id: row.productId.brandId?._id ? String(row.productId.brandId._id) : '',
      brandName: row.productId.brandId?.name || '',
      brand_name: row.productId.brandId?.name || '',
      brandSlug: row.productId.brandId?.slug || '',
      brand_slug: row.productId.brandId?.slug || '',
      brand: row.productId.brandId || null,
      foodType: row.productId.foodType,
      food_type: row.productId.foodType,
      isVeg: row.productId.foodType === 'VEG',
      is_veg: row.productId.foodType === 'VEG',
      veg: row.productId.foodType === 'VEG',
      outletProductId: row._id,
      outletId: row.outletId._id,
      restaurantId: row.outletId.legacyId,
      restaurant_id: row.outletId.legacyId,
      outlet: row.outletId,
      restaurant: row.outletId,
      stockQuantity: row.stockQuantity,
      stock_quantity: row.stockQuantity,
      reservedQuantity: row.reservedQuantity,
      availableStock: row.stockQuantity - row.reservedQuantity,
      available: row.available && row.stockQuantity - row.reservedQuantity > 0,
      isAvailable: row.available && row.stockQuantity - row.reservedQuantity > 0,
      inStock: row.stockQuantity - row.reservedQuantity > 0,
      outOfStock: row.stockQuantity - row.reservedQuantity <= 0,
      enabled: row.enabled,
      price: row.offerPriceOverride ?? row.priceOverride ?? (row.productId.offerPrice > 0 ? row.productId.offerPrice : row.productId.basePrice),
      effectivePrice: row.offerPriceOverride ?? row.priceOverride ?? (row.productId.offerPrice > 0 ? row.productId.offerPrice : row.productId.basePrice),
      preparationMinutes: row.preparationMinutes
    }));
}

async function addressForUser(userId, compatId) {
  const user = await User.findById(userId);
  if (!user) throw new AppError('User not found', 404);
  const address = findEmbeddedByCompatId(user.addresses, compatId);
  if (!address) throw new AppError('Address not found', 404);
  return { user, address };
}

async function cartForUser(userId) {
  const cart = await Cart.findOne({ customerId: userId }).populate({path:'items.productId',populate:{path:'categoryId'}}).populate('outletId').lean();
  if (!cart) return null;
  const outlet = cart.outletId;
  const items = (cart.items || []).map((item) => {
    const p = item.productId || {};
    const img = imageUrl(p.images);
    const baseUnitPrice = Number(p.offerPrice > 0 ? p.offerPrice : p.basePrice || 0);
    const selectedSize = String(item.selectedSize || '').trim().toLowerCase();
    const selectedWeight = String(item.selectedWeight || '').trim().toLowerCase().replace(/\s+/g, '');
    let unitPrice = baseUnitPrice;
    if (p.variantType === 'PIZZA' && ['small','medium','large'].includes(selectedSize) && p.sizePrices?.[selectedSize] != null) unitPrice = Number(p.sizePrices[selectedSize]);
    if (p.variantType === 'CAKE') {
      if (p.customWeightEnabled) {
        const custom = (p.customWeightOptions || []).find((row) => row.active !== false && String(row.label || '').trim().toLowerCase().replace(/\s+/g, '') === selectedWeight);
        if (custom) unitPrice = Number(custom.price);
      } else {
        const weightKey = { '500gm':'gm500', '500g':'gm500', '1kg':'kg1', '1.5kg':'kg15', '2kg':'kg2' }[selectedWeight];
        if (weightKey && p.weightPrices?.[weightKey] != null) unitPrice = Number(p.weightPrices[weightKey]);
      }
    }
    const customizationTotal = (item.customizations || []).reduce((sum, c) => {
      const groupName = String(c.groupName || '').toLowerCase();
      return sum + (/pizza\s*size|cake\s*weight|size|weight/.test(groupName) ? 0 : Number(c.price || 0));
    }, 0);
    const lineTotal = Number(((unitPrice + customizationTotal) * Number(item.quantity || 1)).toFixed(2));
    return {
      ...item,
      id: item.legacyId ?? String(item._id),
      cartItemId: item.legacyId ?? String(item._id),
      cart_item_id: item.legacyId ?? String(item._id),
      selectedSize: item.selectedSize || (item.customizations || []).find((c) => /size/i.test(String(c.groupName || '')))?.optionName || '',
      selected_size: item.selectedSize || (item.customizations || []).find((c) => /size/i.test(String(c.groupName || '')))?.optionName || '',
      selectedWeight: item.selectedWeight || (item.customizations || []).find((c) => /weight/i.test(String(c.groupName || '')))?.optionName || '',
      selected_weight: item.selectedWeight || (item.customizations || []).find((c) => /weight/i.test(String(c.groupName || '')))?.optionName || '',
      cakeMessage: item.cakeMessage || '',
      cake_message: item.cakeMessage || '',
      product: {
        ...p,
        id: p.legacyId ?? String(p._id),
        productId: p.legacyId ?? String(p._id),
        product_id: p.legacyId ?? String(p._id),
        title: p.name,
        image: img,
        imageUrl: img,
        price: unitPrice,
        effectivePrice: unitPrice,
        effective_price: unitPrice,
        foodType: p.foodType,
        food_type: p.foodType,
        isVeg: p.foodType === 'VEG',
        is_veg: p.foodType === 'VEG',
        categoryName: p.categoryId?.name || ''
      },
      productId: p.legacyId ?? String(p._id),
      product_id: p.legacyId ?? String(p._id),
      unitPrice,
      unit_price: unitPrice,
      price: unitPrice,
      lineTotal,
      line_total: lineTotal,
      totalPrice: lineTotal,
      total_price: lineTotal,
      image: img,
      imageUrl: img,
      title: p.name
    };
  });
  const subtotal = items.reduce((sum, i) => sum + Number(i.lineTotal || 0), 0);
  return {
    ...cart,
    items,
    restaurant: outlet,
    outlet,
    restaurantId: outlet?.legacyId ?? String(outlet?._id || ''),
    restaurant_id: outlet?.legacyId ?? String(outlet?._id || ''),
    outletId: outlet?.legacyId ?? String(outlet?._id || ''),
    outlet_id: outlet?.legacyId ?? String(outlet?._id || ''),
    restaurantName: outlet?.name || '',
    restaurant_name: outlet?.name || '',
    subtotal,
    sub_total: subtotal,
    itemsTotal: subtotal,
    items_total: subtotal,
    total: subtotal
  };
}

async function resolveCartProduct(value) {
  const product = await findOneCompat(Product, value, { active: true });
  if (!product) throw new AppError('Food not found', 404);
  return product;
}

async function resolveCartOutlet(productId, requestedOutlet) {
  if (requestedOutlet != null && text(requestedOutlet)) {
    const outlet = await resolveOutlet(requestedOutlet);
    if (!outlet) throw new AppError('Outlet not found', 404);
    const available = await OutletProduct.exists({ outletId: outlet._id, productId, enabled: true, available: true, stockQuantity: { $gt: 0 } });
    if (!available) throw new AppError('Food is not available in this outlet', 409);
    return outlet;
  }
  const row = await OutletProduct.findOne({ productId, enabled: true, available: true, stockQuantity: { $gt: 0 } }).populate('outletId').sort({ createdAt: 1 });
  if (!row?.outletId?.active || !row.outletId.open) throw new AppError('Food is not available at an active outlet', 409);
  return row.outletId;
}

// Public compatibility endpoints used by the existing customer app.
r.get('/platform/settings', ah(async (req, res) => { const pub=await settings.publicSettings(); const f=await settings.getBusinessFeatures(); ok(res,{...pub,razorpayConfigured:Boolean(pub.payment?.onlinePaymentConfigured),onlinePaymentConfigured:Boolean(pub.payment?.onlinePaymentConfigured),razorpayKeyId:pub.razorpayKeyId||pub.payment?.razorpayKeyId||'',onlinePaymentEnabled:f.feature_toggles.onlinePayment,codEnabled:f.feature_toggles.cod,takeawayEnabled:f.feature_toggles.takeaway,mrBreadoTakeawayEnabled:f.feature_toggles.takeaway,takeawayAdvancePercentage:f.takeaway.advanceValue,takeawayBookingFeePercent:f.takeaway.advanceValue,featureToggles:f.feature_toggles,feature_toggles:f.feature_toggles,takeaway:f.takeaway}); }));
r.get('/home', ah(async (req, res) => {
  const lat=readLat(req.query), lng=readLng(req.query), now=new Date();
  const dateFilter={$and:[{$or:[{startAt:null},{startAt:{$exists:false}},{startAt:{$lte:now}}]},{$or:[{endAt:null},{endAt:{$exists:false}},{endAt:{$gte:now}}]}]};
  let serviceability=null, outlet=null, normalizedOutlets=[];
  const rawOutlets=await Outlet.find(activeOutlet).sort({primary:-1,createdAt:1}).limit(30).lean();
  if(Number.isFinite(lat)&&Number.isFinite(lng)){
    serviceability=await deliveryService.checkServiceability({latitude:lat,longitude:lng});
    const road=await deliveryService.googleRoadDistances({latitude:lat,longitude:lng},rawOutlets).catch(()=>new Map());
    normalizedOutlets=rawOutlets.map(o=>{const r=road.get(String(o._id));return outletOut({...o,distanceKm:r?.distanceKm,exactDistanceKm:r?.distanceKm,estimatedTravelMinutes:r?.durationMinutes});}).filter(o=>Number(o.distanceKm)<=Number(o.deliveryRadiusKm||0));
    if(serviceability?.serviceable) outlet=await Outlet.findById(serviceability.nearestOutletId).lean();
  } else normalizedOutlets=rawOutlets.map(outletOut);
  const outletId=outlet?._id;
  const [categories,banners,brands,offerDocs,coupons,stories,products]=await Promise.all([
    Category.find({active:true}).sort({sortOrder:1,name:1}).lean(),
    Banner.find({active:true}).sort({sortOrder:1}).lean(),
    Brand.find({active:true}).sort({name:1}).lean(),
    Offer.find({active:true,...dateFilter,...(outletId?{$or:[{outletIds:{$size:0}},{outletIds:outletId}]}:{})}).lean(),
    Coupon.find({active:true,...dateFilter}).lean(),
    BiteStory.find({active:true,$and:[{$or:[{startsAt:null},{startsAt:{$exists:false}},{startsAt:{$lte:now}}]},{$or:[{endsAt:null},{endsAt:{$exists:false}},{endsAt:{$gte:now}}]}]}).sort({sortOrder:1,createdAt:-1}).lean(),
    outlet?menu(outlet._id,req.query):[]
  ]);
  const couponByCode=new Map(coupons.map(c=>[text(c.code).toUpperCase(),c]));
  const promotions=offerDocs.map(o=>{const n=offerOut(o);const c=couponByCode.get(n.code);return {...n,hasValidCoupon:Boolean(c),exploreEnabled:Boolean(c),coupon:c?offerOut(c):null,outletId:outletId?String(outletId):null};});
  const nearest=outlet?outletOut({...outlet,distanceKm:serviceability?.distanceKm,exactDistanceKm:serviceability?.distanceKm,estimatedTravelMinutes:serviceability?.estimatedTravelMinutes}):null;
  ok(res,{banners:banners.map(bannerOut),categories:categories.map(categoryOut),brands:brands.map(b=>({...b,id:String(b._id),image:imageUrl(b.image),imageUrl:imageUrl(b.image),logo:imageUrl(b.image)})),stories:stories.map(s=>{const media=imageUrl(s.media);return {...s,id:String(s._id),mediaUrl:media,thumbnailUrl:media,image:media,imageUrl:media};}),offers:promotions,coupons:coupons.map(offerOut),outlets:normalizedOutlets,restaurants:normalizedOutlets,products,items:products,featured_foods:products,popular_foods:products,nearestOutlet:nearest,serviceability,noOutletAvailable:Boolean(serviceability&&!serviceability.serviceable),message:serviceability?.message||''});
}));
r.get('/products', ah(async (req, res) => {
  const requested = req.query.outletId ?? req.query.outlet_id ?? req.query.restaurantId ?? req.query.restaurant_id ?? req.query.store;
  const outlet = requested ? await resolveOutlet(requested) : await nearestOutlet(readLat(req.query), readLng(req.query));
  ok(res, outlet ? await menu(outlet._id, req.query) : []);
}));
r.get('/outlets/nearest', ah(async (req, res) => {
  const lat=readLat(req.query),lng=readLng(req.query);
  if(!Number.isFinite(lat)||!Number.isFinite(lng)) throw new AppError('Current latitude and longitude are required',400,'USER_LOCATION_REQUIRED');
  const result=await deliveryService.checkServiceability({latitude:lat,longitude:lng});
  if(!result.serviceable) throw new AppError(result.message,404,result.code);
  const outlet=await Outlet.findById(result.nearestOutletId).lean();
  if(!outlet) throw new AppError('No serviceable outlet found',404);
  ok(res,outletOut({...outlet,distanceKm:result.distanceKm,exactDistanceKm:result.distanceKm,estimatedTravelMinutes:result.estimatedTravelMinutes}));
}));
r.get('/menu/nearest', ah(async (req, res) => {
  const outlet = await nearestOutlet(readLat(req.query), readLng(req.query));
  if (!outlet) throw new AppError('No serviceable outlet found', 404);
  const products = await menu(outlet._id, req.query);
  ok(res, { outlet:outletOut(outlet), products, items: products });
}));
r.get('/outlets/:id/menu', ah(async (req, res) => {
  const outlet = await resolveOutlet(req.params.id);
  if (!outlet) throw new AppError('Outlet not found', 404);
  { const items=await menu(outlet._id, req.query); ok(res, { outlet:outletOut(outlet), products:items, items }); }
}));
r.get('/outlets/:id/contact', ah(async (req, res) => {
  const outlet = await resolveOutlet(req.params.id);
  if (!outlet) throw new AppError('Outlet not found', 404);
  ok(res, { outletId: outlet.legacyId, name: outlet.name, managerName: outlet.managerName, phone: outlet.managerPhone, email: outlet.email, address: outlet.address, latitude: outlet.location.coordinates[1], longitude: outlet.location.coordinates[0] });
}));

r.post(['/delivery/check-pincode','/serviceability/check-pincode','/addresses/check-serviceability'], ah(async(req,res)=>{
  const source={...req.query,...req.body};
  const pincode=deliveryService.cleanPincode(source.pincode ?? source.zipcode);
  if(!/^\d{6}$/.test(pincode)) throw new AppError('Enter a valid 6 digit pincode',400,'INVALID_PINCODE');
  const result=await deliveryService.checkServiceability({pincode,address:source.address ?? source.line1,city:source.city,state:source.state,latitude:source.latitude ?? source.lat,longitude:source.longitude ?? source.lng,outletId:source.outletId ?? source.restaurantId});
  ok(res,{...result,pincode});
}));

// IMPORTANT: never apply a customer role guard globally on this compatibility
// router. The router itself is mounted at /api, so an unscoped guard would also
// intercept /delivery/* and /rider/* before the rider routers are reached.
// Protect only the customer-owned namespaces. Notifications are intentionally
// shared by every authenticated role and therefore require authentication only.
r.use([
  '/user',
  '/cart',
  '/checkout',
  '/payments',
  '/payment',
  '/razorpay',
  '/reviews',
  '/delivery/validate',
  '/orders/validate-delivery',
], requireAuth, allowRoles('CUSTOMER', 'ADMIN'));
r.use('/notifications', requireAuth);

// Addresses with embedded numeric compatibility IDs.
r.get('/user/addresses', ah(async (req, res) => ok(res, (await User.findById(req.user.id).lean())?.addresses || [])));
r.post('/user/addresses', ah(async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) throw new AppError('User not found', 404);
  const pincode=req.body.pincode ?? req.body.zipcode;
  const line1=req.body.line1 ?? req.body.address ?? req.body.addressLine ?? req.body.address_line;
  const validation=await deliveryService.checkServiceability({latitude:req.body.latitude,longitude:req.body.longitude,pincode,address:line1,city:req.body.city,state:req.body.state});
  if (req.body.isDefault ?? req.body.is_default) user.addresses.forEach((a) => { a.isDefault = false; });
  user.addresses.push({
    label: req.body.label ?? req.body.type, line1, line2: req.body.line2, area: req.body.area, city: req.body.city, state: req.body.state,
    pincode: validation.pincode || pincode, landmark: req.body.landmark, latitude: validation.latitude, longitude: validation.longitude,
    isDefault: Boolean(req.body.isDefault ?? req.body.is_default), serviceable: validation.serviceable, serviceabilityCheckedAt:new Date(),
    nearestOutletId:validation.nearestOutletId, distanceKm:validation.distanceKm, allowedRadiusKm:validation.allowedRadiusKm, validationMessage:validation.message
  });
  await user.save();
  ok(res, {...user.addresses.at(-1).toObject(), serviceability:validation}, validation.message, 201);
}));
r.put('/user/addresses/:id', ah(async (req, res) => {
  const { user, address } = await addressForUser(req.user.id, req.params.id);
  const line1=req.body.line1 ?? req.body.address ?? req.body.addressLine ?? req.body.address_line ?? address.line1;
  const pincode=req.body.pincode ?? req.body.zipcode ?? address.pincode;
  const validation=await deliveryService.checkServiceability({latitude:req.body.latitude ?? address.latitude,longitude:req.body.longitude ?? address.longitude,pincode,address:line1,city:req.body.city ?? address.city,state:req.body.state ?? address.state});
  Object.assign(address, {
    label: req.body.label ?? req.body.type ?? address.label, line1, line2: req.body.line2 ?? address.line2, area: req.body.area ?? address.area,
    city: req.body.city ?? address.city, state: req.body.state ?? address.state, pincode: validation.pincode || pincode, landmark: req.body.landmark ?? address.landmark,
    latitude: validation.latitude, longitude: validation.longitude, serviceable:validation.serviceable, serviceabilityCheckedAt:new Date(), nearestOutletId:validation.nearestOutletId, distanceKm:validation.distanceKm, allowedRadiusKm:validation.allowedRadiusKm, validationMessage:validation.message
  });
  if (req.body.isDefault ?? req.body.is_default) user.addresses.forEach((a) => { a.isDefault = a._id.equals(address._id); });
  await user.save(); ok(res, {...address.toObject(),serviceability:validation}, validation.message);
}));
r.delete('/user/addresses/:id', ah(async (req, res) => {
  const { user, address } = await addressForUser(req.user.id, req.params.id); address.deleteOne(); await user.save(); ok(res, null, 'Address deleted');
}));
r.all('/user/addresses/:id/default', ah(async (req, res) => {
  const { user, address } = await addressForUser(req.user.id, req.params.id); user.addresses.forEach((a) => { a.isDefault = a._id.equals(address._id); }); await user.save(); ok(res, address, 'Default address updated');
}));

// Cart operations. The outlet is inferred safely when old clients omit outletId.
r.get('/cart', ah(async (req, res) => ok(res, await cartForUser(req.user.id))));
r.post('/cart/items', ah(async (req, res) => {
  const product = await resolveCartProduct(req.body.productId ?? req.body.product_id);
  const outlet = await resolveCartOutlet(product._id, req.body.outletId ?? req.body.outlet_id ?? req.body.restaurantId ?? req.body.restaurant_id);
  const quantity = Math.max(1, Number(req.body.quantity || 1));
  const inventory = await OutletProduct.findOne({ outletId: outlet._id, productId: product._id, enabled: true, available: true });
  if (!inventory || inventory.stockQuantity - inventory.reservedQuantity < quantity) throw new AppError('Food is out of stock', 409);
  let cart = await Cart.findOne({ customerId: req.user.id });
  if (cart && String(cart.outletId) !== String(outlet._id)) throw new AppError('Cart has items from a different outlet. Clear cart first.', 409);
  if (!cart) cart = new Cart({ customerId: req.user.id, outletId: outlet._id, items: [] });
  const selectedSize = text(req.body.selectedSize ?? req.body.selected_size);
  const selectedWeight = text(req.body.selectedWeight ?? req.body.selected_weight);
  const selectedLabel = selectedSize || selectedWeight;
  const requestedOptionIds = Array.isArray(req.body.customizationOptionIds ?? req.body.customization_option_ids) ? (req.body.customizationOptionIds ?? req.body.customization_option_ids).map(String) : [];
  const selectedCustomizations = [];
  for (const group of product.customizationGroups || []) {
    for (const option of group.options || []) {
      const matchesId = requestedOptionIds.includes(String(option._id));
      const matchesLabel = selectedLabel && text(option.name).toLowerCase() === selectedLabel.toLowerCase();
      if (matchesId || matchesLabel) selectedCustomizations.push({ groupName: group.name, optionName: option.name, price: Number(option.price || 0) });
    }
  }
  if (selectedLabel && !selectedCustomizations.length) throw new AppError('Selected food size or weight is not available', 400, 'INVALID_VARIANT');
  const cakeMessage = text(req.body.cakeMessage ?? req.body.cake_message);
  if (cakeMessage && product.cakeMessageEnabled) selectedCustomizations.push({ groupName: 'Cake Message Text', optionName: cakeMessage, price: Number(product.cakeMessageCharge || 0) });
  const normalizeVariant = (value) => text(value).toLowerCase().replace(/\s+/g, '');
  const existing = cart.items.find((item) =>
    String(item.productId) === String(product._id) &&
    normalizeVariant(item.selectedSize) === normalizeVariant(selectedSize) &&
    normalizeVariant(item.selectedWeight) === normalizeVariant(selectedWeight) &&
    text(item.cakeMessage) === cakeMessage &&
    JSON.stringify(item.customizations || []) === JSON.stringify(selectedCustomizations)
  );
  if (existing) {
    existing.quantity += quantity;
    existing.selectedSize = selectedSize;
    existing.selectedWeight = selectedWeight;
    existing.cakeMessage = cakeMessage;
    existing.customizations = selectedCustomizations;
  } else {
    cart.items.push({
      productId: product._id,
      quantity,
      selectedSize,
      selectedWeight,
      cakeMessage,
      customizations: selectedCustomizations,
    });
  }
  await cart.save(); ok(res, await cartForUser(req.user.id), 'Cart updated', 201);
}));
r.put('/cart/items/:id', ah(async (req, res) => {
  const cart = await Cart.findOne({ customerId: req.user.id });
  const item = findEmbeddedByCompatId(cart?.items, req.params.id);
  if (!item) throw new AppError('Cart item not found', 404);
  item.quantity = Number(req.body.quantity);
  if (item.quantity <= 0) item.deleteOne();
  await cart.save(); ok(res, await cartForUser(req.user.id));
}));
r.delete('/cart/items/:id', ah(async (req, res) => {
  const cart = await Cart.findOne({ customerId: req.user.id });
  const item = findEmbeddedByCompatId(cart?.items, req.params.id);
  if (!item) throw new AppError('Cart item not found', 404);
  item.deleteOne(); await cart.save(); ok(res, await cartForUser(req.user.id));
}));
r.delete(['/cart', '/cart/clear'], ah(async (req, res) => { await Cart.deleteMany({ customerId: req.user.id }); ok(res, null, 'Cart cleared'); }));

async function checkoutContext(req) {
  const cart = await Cart.findOne({ customerId: req.user.id });
  if (!cart?.items?.length) throw new AppError('Cart is empty', 400);

  // The cart is the source of truth for outlet ownership. A client may send an
  // old/current-outlet value from another screen, but an order must never be
  // priced or created for a different outlet than the cart inventory.
  const requestedOutletRef = req.body.outletId ?? req.body.outlet_id ?? req.body.restaurantId ?? req.body.restaurant_id;
  if (requestedOutletRef != null && String(requestedOutletRef).trim()) {
    const requestedOutlet = await findOneCompat(Outlet, requestedOutletRef);
    if (!requestedOutlet || String(requestedOutlet._id) !== String(cart.outletId)) {
      throw new AppError('Your cart belongs to another outlet. Please refresh the cart and try again.', 409, 'CART_OUTLET_MISMATCH');
    }
  }

  const addressId = req.body.addressId ?? req.body.address_id;
  let address = null;
  if (String(req.body.orderType ?? req.body.order_type ?? req.body.fulfilmentType ?? 'DELIVERY').toUpperCase() !== 'TAKEAWAY') {
    ({ address } = await addressForUser(req.user.id, addressId));
  }
  return { cart, address };
}
r.post('/checkout/summary', ah(async (req, res) => {
  const { cart, address } = await checkoutContext(req);
  const pricing = await orderService.buildPricing({ outletId: cart.outletId, items: cart.items, address, fulfilmentType: req.body.orderType ?? req.body.order_type ?? req.body.fulfilmentType ?? 'DELIVERY', couponCode: req.body.promoCode ?? req.body.promo_code ?? req.body.couponCode ?? req.body.coupon_code, customerId: req.user.id, paymentMethod: req.body.paymentMethod ?? req.body.payment_method ?? 'COD' });
  ok(res, { ...pricing, items: pricing.snapshots, cart, restaurant: pricing.outlet, outlet: pricing.outlet });
}));

async function deliveryValidation(req, res) {
  const source = { ...req.query, ...req.body };
  const cart = await Cart.findOne({ customerId: req.user.id });
  let address = null;
  const addressRef = source.addressId ?? source.address_id;
  if (addressRef != null && String(addressRef).trim()) {
    address = (await addressForUser(req.user.id, addressRef)).address;
  }

  // When a saved address is selected it is authoritative. Device GPS describes
  // where the phone currently is, not necessarily where the customer wants the
  // order delivered, and must not override the selected delivery address.
  const requestedOutletRef = source.outletId ?? source.outlet_id ?? source.restaurantId ?? source.restaurant_id;
  let outletId = cart?.outletId || null;
  if (requestedOutletRef != null && String(requestedOutletRef).trim()) {
    const requestedOutlet = await findOneCompat(Outlet, requestedOutletRef);
    if (!requestedOutlet) throw new AppError('Outlet not found', 404, 'OUTLET_NOT_FOUND');
    if (cart?.outletId && String(requestedOutlet._id) !== String(cart.outletId)) {
      throw new AppError('Your cart belongs to another outlet. Please refresh the cart and try again.', 409, 'CART_OUTLET_MISMATCH');
    }
    outletId = requestedOutlet._id;
  }

  const result = await deliveryService.checkServiceability({
    outletId,
    latitude: address ? address.latitude : readLat(source),
    longitude: address ? address.longitude : readLng(source),
    pincode: address?.pincode ?? source.pincode ?? source.zipcode,
    address: address?.line1 ?? source.address,
    city: address?.city ?? source.city,
    state: address?.state ?? source.state,
  });
  ok(res, { ...result, outletId: result.nearestOutletId ?? (outletId ? String(outletId) : null) });
}
r.post(['/delivery/validate', '/orders/validate-delivery'], ah(deliveryValidation));

async function createOrderFromCart(req, paymentMethod) {
  const { cart, address } = await checkoutContext(req);
  return orderService.createOrder({
    customerId: req.user.id,
    outletId: cart.outletId,
    items: cart.items,
    address,
    fulfilmentType: req.body.orderType ?? req.body.order_type ?? req.body.fulfilmentType ?? 'DELIVERY',
    paymentMethod,
    couponCode: req.body.promoCode ?? req.body.promo_code ?? req.body.couponCode ?? req.body.coupon_code,
    clientRequestId: req.headers['idempotency-key'] ?? req.body.clientRequestId ?? `customer:${req.user.id}:${Date.now()}`
  });
}

r.post(['/payments/create-order', '/payment/create-order', '/razorpay/create-order', '/payments/razorpay/create-order', '/checkout/razorpay/create-order', '/checkout/payment/create-order'], ah(async (req, res) => {
  let order = req.body.orderId || req.body.appOrderId ? await findOneCompat(Order, req.body.orderId ?? req.body.appOrderId, { customerId: req.user.id }) : null;
  if (!order) order = await createOrderFromCart(req, 'ONLINE');
  const data = await paymentService.createOrder({ orderId: order._id, userId: req.user.id, idempotencyKey: req.headers['idempotency-key'] ?? `payment:${order._id}` });
  ok(res, { ...data, appOrderId: order.legacyId, orderId: order.legacyId, orderSlug: order.slug });
}));
r.post(['/payments/verify', '/payment/verify', '/razorpay/verify', '/payments/razorpay/verify', '/checkout/razorpay/verify', '/checkout/payment/verify'], ah(async (req, res) => ok(res, await paymentService.verify(req.body, req.user), 'Payment verified')));
r.post(['/payments/failed','/razorpay/failed','/checkout/payment/failed'], ah(async(req,res)=>ok(res,await paymentService.markFailed(req.body,req.user),'Payment failure recorded')));

r.post('/user/orders', ah(async (req, res) => {
  const gatewayOrderId = req.body.razorpayOrderId ?? req.body.razorpay_order_id;
  if (gatewayOrderId) {
    const payment = await Payment.findOne({ gatewayOrderId, customerId: req.user.id, status: 'SUCCESS' }).populate('orderId');
    if (!payment?.orderId) throw new AppError('Verified payment order not found', 409);
    await Cart.deleteMany({ customerId: req.user.id });
    return ok(res, payment.orderId, 'Order confirmed', 201);
  }
  const methodRaw = String(req.body.paymentType ?? req.body.payment_type ?? 'COD').toUpperCase();
  const method = methodRaw.includes('ONLINE') ? 'ONLINE' : methodRaw.includes('WALLET') ? 'WALLET' : 'COD';
  const order = await createOrderFromCart(req, method);
  await Cart.deleteMany({ customerId: req.user.id });
  ok(res, order, 'Order created', 201);
}));

r.get('/user/orders', ah(async (req, res) => ok(res, await Order.find({ customerId: req.user.id }).populate('outletId riderId').sort({ createdAt: -1 }).lean())));
r.get('/user/orders/:id', ah(async (req, res) => {
  const order = await findOneCompat(Order, req.params.id, { customerId: req.user.id });
  if (!order) throw new AppError('Order not found', 404);
  await order.populate('outletId riderId customerId'); ok(res, order);
}));
r.post('/user/orders/:id/cancel', ah(async (req, res) => {
  const order = await findOneCompat(Order, req.params.id, { customerId: req.user.id });
  if (!order) throw new AppError('Order not found', 404);
  ok(res, await orderService.changeStatus(order, req.user, 'CANCELLED', req.body.reason || 'Customer cancelled', req.headers['idempotency-key']));
}));
r.get(['/user/orders/:id/invoice', '/user/orders/:id/invoice.pdf', '/user/orders/:id/transaction-receipt.pdf'], ah(async (req, res) => {
  const order = await findOneCompat(Order, req.params.id, { customerId: req.user.id });
  if (!order) throw new AppError('Order not found', 404);
  await order.populate('outletId customerId'); await invoiceService.stream(order, res);
}));
r.get(['/user/orders/:id/tracking', '/user/orders/:id/live-location'], ah(async (req, res) => {
  const order = await findOneCompat(Order, req.params.id, { customerId: req.user.id });
  if (!order) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');
  await order.populate('outletId riderId customerId');
  const latest = await RiderLocation.findOne({ orderId: order._id }).sort({ recordedAt: -1 }).lean();
  const outlet = order.outletId || null;
  const rider = order.riderId || null;
  const riderLocation = latest ? {
    latitude: latest.location?.coordinates?.[1],
    longitude: latest.location?.coordinates?.[0],
    heading: latest.heading,
    speed: latest.speed,
    accuracy: latest.accuracy,
    updatedAt: latest.recordedAt || latest.updatedAt,
  } : null;
  const customer = {
    name: order.customerId?.name || order.address?.label || 'Delivery customer',
    phone: order.customerId?.phone || '',
    address: [order.address?.line1, order.address?.line2, order.address?.area, order.address?.landmark, order.address?.city, order.address?.state, order.address?.pincode].filter(Boolean).join(', '),
    latitude: numberOrNull(order.address?.latitude),
    longitude: numberOrNull(order.address?.longitude),
  };
  const restaurant = outlet ? {
    id: outlet.legacyId ?? String(outlet._id),
    outletId: outlet.legacyId ?? String(outlet._id),
    name: outlet.name,
    address: [outlet.address?.line1, outlet.address?.line2, outlet.address?.area, outlet.address?.landmark, outlet.address?.city, outlet.address?.state, outlet.address?.pincode].filter(Boolean).join(', '),
    latitude: numberOrNull(outlet.location?.coordinates?.[1]),
    longitude: numberOrNull(outlet.location?.coordinates?.[0]),
    logo: imageUrl(outlet.logo),
    banner: imageUrl(outlet.coverImage),
  } : null;
  let distanceToCustomerKm = null;
  let etaMinutes = null;
  const prePickupStatuses = new Set(['PENDING', 'PLACED', 'CONFIRMED', 'ACCEPTED', 'PREPARING', 'READY', 'RIDER_ASSIGNED', 'ASSIGNED']);
  const beforePickup = prePickupStatuses.has(String(order.status || '').toUpperCase());
  const navigationDestination = beforePickup && restaurant?.latitude != null && restaurant?.longitude != null
    ? { latitude: restaurant.latitude, longitude: restaurant.longitude, label: 'Outlet pickup' }
    : customer.latitude != null && customer.longitude != null
      ? { latitude: customer.latitude, longitude: customer.longitude, label: 'Customer delivery' }
      : null;
  let route = null;
  if (riderLocation?.latitude != null && riderLocation?.longitude != null && navigationDestination) {
    route = await trackingRouteService.getDrivingRoute(
      { latitude: riderLocation.latitude, longitude: riderLocation.longitude },
      navigationDestination,
    );
    if (route?.distanceKm > 0) {
      distanceToCustomerKm = Number(route.distanceKm.toFixed(2));
      etaMinutes = route.etaMinutes;
    } else {
      distanceToCustomerKm = Number(haversineKm(riderLocation.latitude, riderLocation.longitude, navigationDestination.latitude, navigationDestination.longitude).toFixed(2));
      const speedKmh = Math.max(12, Number(riderLocation.speed || 0) * 3.6 || 20);
      etaMinutes = Math.max(1, Math.ceil(distanceToCustomerKm / speedKmh * 60));
    }
  }
  const riderPayload = rider ? {
    id: rider.legacyId ?? String(rider._id),
    riderId: rider.legacyId ?? String(rider._id),
    name: rider.name || 'Delivery Partner',
    phone: rider.phone || '',
    mobile: rider.phone || '',
    profileImage: imageUrl(rider.riderProfile?.passportPhoto || rider.avatar),
    vehicleNumber: rider.riderProfile?.vehicle?.vehicleNumber || '',
  } : null;
  ok(res, {
    order: {
      id: order.legacyId ?? String(order._id),
      mongoId: String(order._id),
      orderId: order.legacyId ?? String(order._id),
      orderNumber: order.slug,
      slug: order.slug,
      status: order.status,
      fulfilmentType: order.fulfilmentType,
      updatedAt: order.updatedAt,
    },
    orderId: order.legacyId ?? String(order._id),
    orderNumber: order.slug,
    orderStatus: order.status,
    status: order.status,
    rider: riderPayload,
    driver: riderPayload,
    restaurant,
    outlet: restaurant,
    store: restaurant,
    customer,
    drop: customer,
    deliveryAddress: customer,
    location: riderLocation,
    riderLocation,
    isLive: Boolean(riderLocation),
    live: Boolean(riderLocation),
    distanceToCustomerKm,
    distance_to_customer_km: distanceToCustomerKm,
    estimatedArrivalMinutes: etaMinutes,
    estimated_arrival_minutes: etaMinutes,
    beforePickup,
    navigationDestination,
    route,
    encodedPolyline: route?.encodedPolyline || '',
    distanceText: route?.distanceText || (distanceToCustomerKm != null ? `${distanceToCustomerKm.toFixed(1)} km` : ''),
    durationText: route?.durationText || (etaMinutes != null ? `${etaMinutes} min` : ''),
    updatedAt: riderLocation?.updatedAt || order.updatedAt,
  });
}));

r.get('/reviews/order/:id/eligibility', ah(async (req, res) => {
  const order = await findOneCompat(Order, req.params.id, { customerId: req.user.id });
  const old = order ? await Review.findOne({ orderId: order._id, customerId: req.user.id }) : null;
  ok(res, { orderId: order?.legacyId, orderNumber: order?.slug, eligible: Boolean(order && order.status === 'DELIVERED' && !old), canReview: Boolean(order && order.status === 'DELIVERED' && !old), alreadyReviewed: Boolean(old), reason: !order ? 'Order not found' : order.status !== 'DELIVERED' ? 'Order is not delivered' : old ? 'Already reviewed' : '' });
}));
async function submitReview(req, res) {
  const order = await findOneCompat(Order, req.params.id, { customerId: req.user.id, status: 'DELIVERED' });
  if (!order) throw new AppError('Only delivered orders can be reviewed', 409);
  const review = await Review.findOneAndUpdate({ customerId: req.user.id, orderId: order._id }, { $setOnInsert: { customerId: req.user.id, orderId: order._id, outletId: order.outletId }, $set: { rating: Number(req.body.rating ?? req.body.restaurantRating ?? req.body.restaurant_rating), comment: req.body.comment ?? req.body.restaurantReview ?? req.body.restaurant_review } }, { upsert: true, new: true, runValidators: true });
  ok(res, review, 'Review submitted', 201);
}
r.post(['/reviews/order/:id', '/user/orders/:id/review'], ah(submitReview));
r.post('/user/orders/:id/report', ah(async (req, res) => {
  const order = await findOneCompat(Order, req.params.id, { customerId: req.user.id });
  if (!order) throw new AppError('Order not found', 404);
  ok(res, await SupportTicket.create({ userId: req.user.id, subject: `Order report ${order.slug}`, message: `${req.body.reason || 'Issue'}\n${req.body.details || ''}`, priority: 'HIGH' }), 'Report submitted', 201);
}));

r.get('/notifications', ah(async (req, res) => ok(res, await Notification.find({ userId: req.user.id }).sort({ createdAt: -1 }).lean())));
r.patch('/notifications/:id/read', ah(async (req, res) => {
  const notification = await findOneCompat(Notification, req.params.id, { userId: req.user.id });
  if (!notification) throw new AppError('Notification not found', 404);
  notification.read = true; await notification.save(); ok(res, notification);
}));
r.patch('/notifications/read-all', ah(async (req, res) => { await Notification.updateMany({ userId: req.user.id }, { read: true }); ok(res, null, 'Notifications marked read'); }));

r.get('/user/payments', ah(async (req, res) => {
  const rows=await Payment.find({ customerId:req.user.id }).populate('orderId customerId outletId').sort({createdAt:-1}).lean();
  ok(res,rows.map((p)=>{const o=p.orderId||{},u=p.customerId||{},out=p.outletId||{};return {id:String(p._id),gateway:p.gateway||'RAZORPAY',status:p.status,amount:p.amount,currency:p.currency,createdAt:p.createdAt,paidAt:p.updatedAt,razorpayOrderId:p.gatewayOrderId,razorpayPaymentId:p.gatewayPaymentId,orderId:o._id?String(o._id):String(p.orderId||''),orderNumber:o.slug||'',orderSlug:o.slug||'',customerName:u.name||o.address?.name||'',customerPhone:u.phone||o.address?.phone||'',customerEmail:u.email||'',restaurantName:out.name||'',outletName:out.name||'',outletId:out._id?String(out._id):String(p.outletId||''),sellerId:out.sellerId||'',items:o.items||[],subtotal:o.subtotal||0,tax:o.tax||0,deliveryCharge:o.deliveryCharge||0,discount:o.discount||0,total:o.total||p.amount,paymentStatus:o.paymentStatus||p.status,fulfilmentType:o.fulfilmentType||'DELIVERY',failureReason:p.failureReason||'',receiptUrl:`/user/payments/${p._id}/receipt.pdf`};}));
}));
r.get(['/user/payments/:id/receipt', '/user/payments/:id/receipt.pdf'], ah(async (req, res) => {
  const payment = await findOneCompat(Payment, req.params.id, { customerId: req.user.id });
  if (!payment) throw new AppError('Payment not found', 404);
  await payment.populate('orderId customerId outletId');
  if (req.path.endsWith('.pdf') && payment.orderId) return invoiceService.stream(payment.orderId, res);
  ok(res, payment);
}));

module.exports = r;
