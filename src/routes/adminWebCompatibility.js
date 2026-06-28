const express = require('express');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const ah = require('../utils/asyncHandler');
const { ok } = require('../utils/respond');
const { requireAuth, allowRoles } = require('../middleware/auth');
const { AppError } = require('../utils/errors');
const {
  User, Outlet, Category, Brand, Cuisine, Product, OutletProduct, Order, OrderEvent,
  Payment, Refund, OfflineSale, DailyClosing, InventoryMovement, Invoice, BiteStory,
} = require('../models');
const settings = require('../services/settingsService');
const orderService = require('../services/orderService');
const invoiceService = require('../services/invoiceService');
const { buildVariantFields, serializeVariantFields } = require('../utils/productVariants');
const deliveryService = require('../services/deliveryService');
const { findOneCompat, resolveObjectId } = require('../utils/compatId');
const { Notification } = require('../models');
const { imageUpload: upload, uploadImage: uploadMedia, deleteImage, imageFromUrl } = require('../services/mediaService');

const r = express.Router();
r.use('/admin', requireAuth, allowRoles('ADMIN'));

const imageUrl = (value) => {
  if (!value) return undefined;
  if (typeof value === 'string') return { url: value };
  if (typeof value === 'object' && value.url) return value;
  return undefined;
};
const normalizeOutlet = (o) => o ? ({
  ...o,
  id: String(o._id), outletId: String(o._id), outletName: o.name,
  isOpen: o.open, status: o.active ? 'ACTIVE' : 'INACTIVE',
  isPrimary: Boolean(o.primary), serviceRadiusKm: o.deliveryRadiusKm,
  latitude: o.location?.coordinates?.[1] ?? 0,
  longitude: o.location?.coordinates?.[0] ?? 0,
  addressText: [o.address?.line1,o.address?.area,o.address?.city,o.address?.state,o.address?.pincode].filter(Boolean).join(', '),
}) : null;
const normalizeCategory = (c) => {
  if (!c) return null;
  const raw = typeof c.toObject === 'function' ? c.toObject() : c;
  const url = typeof raw.image === 'string' ? raw.image : (raw.image?.url || '');
  return { ...raw, id: String(raw._id), title: raw.name, image: url, imageUrl: url, icon: url, status: raw.active ? 'ACTIVE' : 'INACTIVE', enabled: Boolean(raw.active) };
};
const normalizeProduct = (p) => p ? ({
  ...p,
  id: String(p._id), productId: String(p._id), title: p.name,
  price: p.basePrice, effectivePrice: p.offerPrice || p.basePrice,
  image: p.images?.[0]?.url || '', imageUrl: p.images?.[0]?.url || '',
  categoryName: p.categoryId?.name || '', categoryId: p.categoryId?._id || p.categoryId, cuisineId:p.cuisineId?._id||p.cuisineId||null, cuisineName:p.cuisineId?.name||'', cuisineSlug:p.cuisineId?.slug||'', cuisine:p.cuisineId||null, brandId:p.brandId?._id||p.brandId||null, brandName:p.brandId?.name||'', brandSlug:p.brandId?.slug||'', brand:p.brandId||null, foodType:p.foodType, isVeg:p.foodType==='VEG', isAvailable: p.active, isBestseller:Boolean(p.featured),
  ...serializeVariantFields(p),
}) : null;
const normalizeOrder = (o) => o ? ({
  ...o,
  id: String(o._id), orderId: String(o._id), orderNumber: o.slug,
  customer: o.customerId, customerName: o.customerId?.name,
  customerMobile: o.customerId?.phone, customerEmail: o.customerId?.email,
  outlet: o.outletId && typeof o.outletId==='object' ? normalizeOutlet(o.outletId) : o.outletId, outletName: o.outletId?.name, restaurantName: o.outletId?.name,
  rider: o.riderId, riderName: o.riderId?.name,
  grandTotal: o.total, paymentType: o.paymentMethod, orderType: o.fulfilmentType,
  deliveryAddress: [o.address?.line1,o.address?.area,o.address?.city,o.address?.state,o.address?.pincode].filter(Boolean).join(', '),
  items: (o.items || []).map(i => ({...i, id:String(i._id), productId:String(i.productId||''), productName:i.name, price:i.unitPrice, totalPrice:i.finalTotal})),
}) : null;

async function dashboardData() {
  const [orders, outlets, customers, sellers, riders, products, deliveredAgg, payments] = await Promise.all([
    Order.find().sort({createdAt:-1}).limit(10).populate('customerId outletId riderId').lean(),
    Outlet.find().lean(), User.countDocuments({role:'CUSTOMER'}), User.countDocuments({role:'SELLER'}),
    User.countDocuments({role:'RIDER'}), Product.countDocuments({active:true}),
    Order.aggregate([{$match:{status:'DELIVERED'}},{$group:{_id:null,total:{$sum:'$total'},count:{$sum:1}}}]),
    Payment.aggregate([{$match:{status:{$in:['SUCCESS','PAID','CAPTURED']} }},{$group:{_id:null,total:{$sum:'$amount'}}}]),
  ]);
  return {
    totalOrders: await Order.countDocuments(), totalSales: deliveredAgg[0]?.total || 0,
    totalRevenue: deliveredAgg[0]?.total || 0, deliveredOrdersCount: deliveredAgg[0]?.count || 0,
    totalCustomers: customers, totalUsers: customers+sellers+riders+1, totalRestaurants: outlets.length,
    totalOutlets: outlets.length, totalDrivers:riders, totalDeliveryBoys:riders, totalProducts:products,
    onlinePayments: payments[0]?.total || 0,
    recentOrders: orders.map(normalizeOrder), outlets: outlets.map(normalizeOutlet),
  };
}

r.get(['/admin/head-office/dashboard','/admin/dashboard/overview','/admin/business/dashboard'], ah(async(req,res)=>ok(res,await dashboardData())));

async function primaryOutletHandler(req,res){
  const outlet=await Outlet.findOne({primary:true}).lean() || await Outlet.findOne({active:true}).sort({createdAt:1}).lean();
  return ok(res,normalizeOutlet(outlet),'Primary outlet fetched');
}
r.get(['/admin/mr-breado/restaurant','/admin/mr-breado/store','/admin/primary-outlet','/admin/outlets/primary'],ah(primaryOutletHandler));

const cleanText = (value) => String(value ?? '').trim();
const asBoolean = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['true', '1', 'yes', 'on', 'active', 'available'].includes(cleanText(value).toLowerCase());
};
const imageList = (value) => {
  if (!value) return [];
  let source = value;
  if (typeof source === 'string') {
    const text = source.trim();
    if (!text) return [];
    try { source = JSON.parse(text); } catch (_) { source = text; }
  }
  const rows = Array.isArray(source) ? source : [source];
  return rows.map((item) => {
    if (typeof item === 'string') return imageFromUrl(item);
    if (item && typeof item === 'object' && item.url) return {
      url: cleanText(item.url),
      publicId: cleanText(item.publicId ?? item.public_id),
      alt: cleanText(item.alt),
    };
    return null;
  }).filter((item) => item?.url);
};

async function resolveCategory(body){
  let category=null;
  if(body.categoryId||body.category_id) category=await Category.findById(body.categoryId||body.category_id);
  if(!category&&(body.categoryName||body.category_name||body.category)) category=await Category.findOne({name:new RegExp(`^${String(body.categoryName||body.category_name||body.category).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}$`,'i')});
  if(!category||!category.active) throw new AppError('Select an active Admin category',400,'INVALID_CATEGORY');
  return category;
}

async function resolveCuisine(body, existing = {}) {
  const raw = body.cuisineId ?? body.cuisine_id ?? body.cuisine ?? body.cuisineName ?? body.cuisine_name ?? existing.cuisineId;
  if (!raw) throw new AppError('Select an active cuisine', 400, 'INVALID_CUISINE');
  let cuisine = null;
  if (mongoose.isValidObjectId(raw)) cuisine = await Cuisine.findById(raw);
  if (!cuisine) {
    const escaped = String(raw).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    cuisine = await Cuisine.findOne({
      $or: [{ slug: cleanText(raw).toLowerCase() }, { name: new RegExp(`^${escaped}$`, 'i') }],
      active: true,
    });
  }
  if (!cuisine || !cuisine.active) throw new AppError('Select an active cuisine', 400, 'INVALID_CUISINE');
  return cuisine;
}

async function resolveBrand(body, existing={}) {
  const hasExplicitBrand = ['brandId','brand_id','brand','brandSlug','brand_slug']
    .some((key) => Object.prototype.hasOwnProperty.call(body, key));
  const raw = hasExplicitBrand
    ? (body.brandId ?? body.brand_id ?? body.brand ?? body.brandSlug ?? body.brand_slug)
    : existing.brandId;
  // An explicitly empty value means the admin selected “No brand”. This must
  // clear a previously assigned brand instead of silently keeping it.
  if (!cleanText(raw)) return null;
  let brand = null;
  if (mongoose.isValidObjectId(raw)) brand = await Brand.findById(raw);
  if (!brand) brand = await Brand.findOne({ $or:[{slug:String(raw).toLowerCase()},{name:new RegExp(`^${String(raw).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}$`,'i')}], active:true });
  if (!brand) throw new AppError('Select an active Admin-created brand',400,'INVALID_BRAND');
  return brand;
}

async function compatibilityProductPayload(body, existing = {}) {
  const name = cleanText(body.name || body.title || existing.name);
  if (!name) throw new AppError('Food title is required', 400, 'PRODUCT_NAME_REQUIRED');
  if (name.length > 140) throw new AppError('Food title must be 140 characters or fewer', 400, 'PRODUCT_NAME_TOO_LONG');

  const category = await resolveCategory(body);
  const cuisine = await resolveCuisine(body, existing);
  const brand = await resolveBrand(body, existing);
  const variants = buildVariantFields({ ...existing, ...body }, category);

  const explicitType = cleanText(body.foodType || body.food_type || existing.foodType).toUpperCase().replace('-', '_');
  const foodType = ['VEG', 'NON_VEG', 'EGG', 'VEGAN', 'OTHER'].includes(explicitType)
    ? explicitType
    : (asBoolean(body.isVeg ?? body.is_veg, existing.foodType === 'VEG') ? 'VEG' : 'NON_VEG');

  const suppliedImages = imageList(body.images || body.imageUrl || body.image_url || body.thumbnail);
  const images = suppliedImages.length ? suppliedImages : imageList(existing.images);
  const offerPrice = Number(variants.offerPrice ?? 0);
  const basePrice = Number(variants.basePrice ?? 0);
  if (!Number.isFinite(basePrice) || basePrice <= 0) {
    throw new AppError('Food price must be greater than zero', 400, 'INVALID_PRODUCT_PRICE');
  }
  if (offerPrice < 0 || (offerPrice > 0 && offerPrice > basePrice)) {
    throw new AppError('Offer price must be lower than or equal to the base price', 400, 'INVALID_OFFER_PRICE');
  }

  return {
    name,
    description: cleanText(body.description ?? existing.description),
    categoryId: category._id,
    cuisineId: cuisine._id,
    brandId: brand?._id || null,
    images,
    foodType,
    active: asBoolean(body.active ?? body.isAvailable ?? body.available, existing.active ?? true),
    featured: asBoolean(body.featured ?? body.isFeatured ?? body.bestseller, existing.featured ?? false),
    ...variants,
  };
}

r.route('/admin/mr-breado/products')
 .get(ah(async(req,res)=>ok(res,(await Product.find().populate('categoryId brandId cuisineId').sort({createdAt:-1}).lean()).map(normalizeProduct))))
 .post(upload.single('image'),ah(async(req,res)=>{
   const body={...req.body};
   const uploaded=await uploadMedia(req.file,'products');
   if(uploaded) body.images=[uploaded];
   let product;
   try {
     const payload=await compatibilityProductPayload(body);
     if(!payload.images.length) throw new AppError('Select a food image from your device',400,'PRODUCT_IMAGE_REQUIRED');
     product=await Product.create({...payload,slug:req.body.slug||`${String(payload.name).trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')}-${require('nanoid').nanoid(5)}`,createdBy:req.user.id});
   } catch (error) {
     if(uploaded?.publicId) await deleteImage(uploaded.publicId);
     throw error;
   }
   ok(res,normalizeProduct(await Product.findById(product._id).populate('categoryId brandId cuisineId').lean()),'Product created',201);
 }));
r.route('/admin/mr-breado/products/:id')
 .get(ah(async(req,res)=>{const p=await Product.findById(req.params.id).populate('categoryId brandId cuisineId').lean();if(!p)throw new AppError('Product not found',404);ok(res,normalizeProduct(p))}))
 .put(upload.single('image'),ah(async(req,res)=>{
   const existing=await Product.findById(req.params.id).lean();
   if(!existing)throw new AppError('Product not found',404);
   const body={...req.body};
   const uploaded=await uploadMedia(req.file,'products');
   if(uploaded) body.images=[uploaded];
   let product;
   try {
     const payload=await compatibilityProductPayload(body,existing);
     product=await Product.findByIdAndUpdate(req.params.id,{$set:payload},{new:true,runValidators:true}).populate('categoryId brandId cuisineId').lean();
   } catch (error) {
     if(uploaded?.publicId) await deleteImage(uploaded.publicId);
     throw error;
   }
   if(uploaded?.publicId){
     const previous=(existing.images||[]).find((item)=>item?.publicId)?.publicId;
     if(previous&&previous!==uploaded.publicId) await deleteImage(previous);
   }
   ok(res,normalizeProduct(product),'Product updated');
 }))
 .delete(ah(async(req,res)=>{await Product.findByIdAndUpdate(req.params.id,{$set:{active:false}});ok(res,null,'Product disabled')}));
r.patch('/admin/mr-breado/products/:id/availability',ah(async(req,res)=>ok(res,normalizeProduct(await Product.findByIdAndUpdate(req.params.id,{$set:{active:asBoolean(req.body.isAvailable??req.body.available,true)}},{new:true}).populate('categoryId brandId cuisineId').lean()))));


const normalizeStory = (story) => {
  if (!story) return null;
  const raw = typeof story.toObject === 'function' ? story.toObject() : story;
  const mediaUrl = raw.media?.url || raw.mediaUrl || raw.thumbnailUrl || '';
  return {...raw,id:String(raw._id),mediaUrl,media_url:mediaUrl,thumbnailUrl:mediaUrl,thumbnail_url:mediaUrl,image:mediaUrl,imageUrl:mediaUrl,active:raw.active!==false};
};

r.route('/admin/stories')
 .get(ah(async(req,res)=>ok(res,(await BiteStory.find().sort({sortOrder:1,createdAt:-1}).lean()).map(normalizeStory))))
 .post(upload.single('image'),ah(async(req,res)=>{
   const title=String(req.body.title||'').trim();
   if(!title) throw new AppError('Story title is required',400,'STORY_TITLE_REQUIRED');
   const uploaded=await uploadMedia(req.file,'stories');
   const supplied=imageUrl(req.body.mediaUrl||req.body.thumbnailUrl||req.body.imageUrl||req.body.image);
   const media=uploaded||supplied;
   if(!media) throw new AppError('Select a story image from your computer',400,'STORY_IMAGE_REQUIRED');
   const story=await BiteStory.create({title,subtitle:String(req.body.subtitle||''),description:String(req.body.description||''),media,mediaType:'IMAGE',actionType:String(req.body.actionType||''),actionValue:String(req.body.actionValue||''),sortOrder:Number(req.body.sortOrder||0),active:String(req.body.active)!=='false',createdBy:req.user.id});
   ok(res,normalizeStory(story),'Story created',201);
 }));

r.route('/admin/stories/:id')
 .get(ah(async(req,res)=>{const story=await BiteStory.findById(req.params.id).lean();if(!story)throw new AppError('Story not found',404);ok(res,normalizeStory(story));}))
 .put(upload.single('image'),ah(async(req,res)=>{
   const story=await BiteStory.findById(req.params.id);if(!story)throw new AppError('Story not found',404);
   const uploaded=await uploadMedia(req.file,'stories');
   if(req.body.title!==undefined){const title=String(req.body.title).trim();if(!title)throw new AppError('Story title is required',400,'STORY_TITLE_REQUIRED');story.title=title;}
   for(const k of ['subtitle','description','actionType','actionValue']) if(req.body[k]!==undefined) story[k]=String(req.body[k]||'');
   if(req.body.sortOrder!==undefined) story.sortOrder=Number(req.body.sortOrder||0);
   if(req.body.active!==undefined) story.active=String(req.body.active)!=='false';
   if(uploaded) story.media=uploaded; else {const supplied=imageUrl(req.body.mediaUrl||req.body.thumbnailUrl||req.body.imageUrl||req.body.image);if(supplied)story.media=supplied;}
   await story.save();ok(res,normalizeStory(story),'Story updated');
 }))
 .delete(ah(async(req,res)=>{const story=await BiteStory.findByIdAndDelete(req.params.id);if(!story)throw new AppError('Story not found',404);if(story.media?.publicId) await deleteImage(story.media.publicId);ok(res,null,'Story deleted');}));
r.patch('/admin/stories/:id/status',ah(async(req,res)=>{const active=String(req.body.active??req.body.enabled??true)!=='false';const story=await BiteStory.findByIdAndUpdate(req.params.id,{$set:{active}},{new:true,runValidators:true}).lean();if(!story)throw new AppError('Story not found',404);ok(res,normalizeStory(story),'Story status updated');}));

r.route('/admin/brands')
 .get(ah(async(req,res)=>ok(res,(await Brand.find().sort({name:1}).lean()).map(b=>({...b,id:String(b._id),image:b.image?.url||'',imageUrl:b.image?.url||''})))))
 .post(upload.single('image'),ah(async(req,res)=>{const name=String(req.body.name||'').trim();if(!name)throw new AppError('Brand name is required',400);const media=await uploadMedia(req.file,'brands');const slug=String(req.body.slug||name).trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');const brand=await Brand.create({name,slug,image:media||imageUrl(req.body.imageUrl||req.body.image),active:req.body.active!==false&&String(req.body.active)!=='false'});ok(res,{...brand.toObject(),id:String(brand._id),image:brand.image?.url||'',imageUrl:brand.image?.url||''},'Brand created',201)}));
r.route('/admin/brands/:id')
 .put(upload.single('image'),ah(async(req,res)=>{const update={};if(req.body.name)update.name=String(req.body.name).trim();if(req.body.slug||req.body.name)update.slug=String(req.body.slug||req.body.name).trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');if(req.body.active!==undefined)update.active=String(req.body.active)!=='false';const media=await uploadMedia(req.file,'brands');if(media)update.image=media;else if(req.body.imageUrl||req.body.image)update.image=imageUrl(req.body.imageUrl||req.body.image);const brand=await Brand.findByIdAndUpdate(req.params.id,{$set:update},{new:true,runValidators:true}).lean();ok(res,{...brand,id:String(brand._id),image:brand.image?.url||'',imageUrl:brand.image?.url||''},'Brand updated')}))
 .delete(ah(async(req,res)=>{await Brand.findByIdAndUpdate(req.params.id,{$set:{active:false}});ok(res,null,'Brand disabled')}));
r.patch('/admin/brands/:id/status',ah(async(req,res)=>{const active=String(req.body.active??req.body.enabled??true)!=='false';const brand=await Brand.findByIdAndUpdate(req.params.id,{$set:{active}},{new:true,runValidators:true}).lean();if(!brand)throw new AppError('Brand not found',404);ok(res,{...brand,id:String(brand._id),image:brand.image?.url||'',imageUrl:brand.image?.url||''},active?'Brand enabled':'Brand disabled')}));

r.get('/admin/dashboard/recent-orders', ah(async(req,res)=>ok(res,(await Order.find().populate('customerId outletId riderId').sort({createdAt:-1}).limit(10).lean()).map(normalizeOrder))));
r.get('/admin/dashboard/revenue', ah(async(req,res)=>ok(res,{items:await Order.aggregate([{$match:{status:'DELIVERED'}},{$group:{_id:{$dateToString:{format:'%Y-%m-%d',date:'$deliveredAt'}},revenue:{$sum:'$total'},orders:{$sum:1}}},{$sort:{_id:1}},{$limit:30}])})));
r.get('/admin/dashboard/payments', ah(async(req,res)=>ok(res,await Payment.aggregate([{$group:{_id:'$status',amount:{$sum:'$amount'},count:{$sum:1}}}]))));
r.get('/admin/dashboard/user-growth', ah(async(req,res)=>ok(res,await User.aggregate([{$group:{_id:{$dateToString:{format:'%Y-%m-%d',date:'$createdAt'}},count:{$sum:1}}},{$sort:{_id:1}},{$limit:30}]))));
r.get('/admin/dashboard/order-status-chart', ah(async(req,res)=>ok(res,await Order.aggregate([{$group:{_id:'$status',count:{$sum:1}}}]))));

r.get('/admin/category-summary', ah(async(req,res)=>{const [total,active,sub]=await Promise.all([Category.countDocuments(),Category.countDocuments({active:true}),Category.countDocuments({parentId:{$ne:null}})]);ok(res,{totalCategories:total,activeCategories:active,inactiveCategories:total-active,totalSubCategories:sub})}));
r.get(['/admin/food-categories','/admin/sub-categories'], ah(async(req,res)=>{const q=req.path.includes('sub-categories')?{parentId:{$ne:null}}:{};ok(res,(await Category.find(q).sort({sortOrder:1,name:1}).lean()).map(normalizeCategory))}));

r.get('/admin/products/:id', ah(async(req,res)=>ok(res,normalizeProduct(await Product.findById(req.params.id).populate('categoryId brandId').lean()))));
r.patch(['/admin/products/:id/stock','/admin/products/:id/availability'], ah(async(req,res)=>ok(res,normalizeProduct(await Product.findByIdAndUpdate(req.params.id,{$set:{active:req.body.isAvailable??req.body.available??req.body.active??true}},{new:true}).populate('categoryId').lean()))));

r.put('/admin/outlets/:id', ah(async(req,res)=>{
  const update={...req.body};
  if(req.body.outletName&&!req.body.name)update.name=req.body.outletName;
  if(req.body.serviceRadiusKm!==undefined)update.deliveryRadiusKm=Number(req.body.serviceRadiusKm);
  if(req.body.isOpen!==undefined)update.open=Boolean(req.body.isOpen);
  if(req.body.status)update.active=String(req.body.status).toUpperCase()==='ACTIVE';
  if(req.body.latitude!==undefined||req.body.longitude!==undefined){ const c=deliveryService.coordinatePair(req.body.latitude,req.body.longitude); update.location={type:'Point',coordinates:[c.longitude,c.latitude]}; }
  if(typeof req.body.logo==='string')update.logo=imageUrl(req.body.logo);
  if(typeof req.body.coverImage==='string')update.coverImage=imageUrl(req.body.coverImage);
  const out=await Outlet.findByIdAndUpdate(req.params.id,{$set:update},{new:true,runValidators:true}).lean();
  ok(res,normalizeOutlet(out),'Outlet updated');
}));
r.get('/admin/outlets/:id/gstin', ah(async(req,res)=>{const o=await Outlet.findById(req.params.id).lean();if(!o)throw new AppError('Outlet not found',404);ok(res,{gstin:o.gstin,invoiceLegalName:o.name,invoiceAddress:[o.address?.line1,o.address?.area,o.address?.city,o.address?.state,o.address?.pincode].filter(Boolean).join(', ')})}));
r.put('/admin/outlets/:id/gstin', ah(async(req,res)=>ok(res,normalizeOutlet(await Outlet.findByIdAndUpdate(req.params.id,{$set:{gstin:req.body.gstin,name:req.body.invoiceLegalName||undefined,'address.line1':req.body.invoiceAddress||undefined}},{new:true}).lean()))));
r.post('/admin/outlets/:id/set-location', ah(async(req,res)=>{
  const outletId=await resolveObjectId(Outlet,req.params.id);
  if(!outletId)throw new AppError('Outlet not found',404,'OUTLET_NOT_FOUND');
  const radius=Number(req.body.serviceRadiusKm ?? req.body.deliveryRadiusKm ?? req.body.delivery_radius_km ?? req.body.radiusKm ?? req.body.radius_km);
  if(!Number.isFinite(radius)||radius<=0||radius>100) throw new AppError('Delivery radius must be greater than 0 and at most 100 km',400,'INVALID_DELIVERY_RADIUS');
  const coords=await deliveryService.normalizeCoordinates({latitude:req.body.latitude,longitude:req.body.longitude,address:req.body.address,pincode:req.body.pincode,city:req.body.city,state:req.body.state});
  const set={location:{type:'Point',coordinates:[coords.longitude,coords.latitude]},deliveryRadiusKm:radius};
  if(req.body.address||coords.formattedAddress)set['address.line1']=req.body.address||coords.formattedAddress;
  if(req.body.city)set['address.city']=req.body.city;
  if(req.body.state)set['address.state']=req.body.state;
  if(req.body.pincode||coords.pincode)set['address.pincode']=req.body.pincode||coords.pincode;
  const out=await Outlet.findByIdAndUpdate(outletId,{$set:set},{new:true,runValidators:true}).lean();
  ok(res,{...normalizeOutlet(out),coordinatesCorrected:Boolean(coords.suppliedCoordinatesSwapped)},'Outlet location updated');
}));
r.post('/admin/outlets/:id/branding', ah(async(req,res)=>ok(res,normalizeOutlet(await Outlet.findByIdAndUpdate(req.params.id,{$set:{logo:imageUrl(req.body.profileImage||req.body.logo),coverImage:imageUrl(req.body.bannerImage||req.body.coverImage),managerPhone:req.body.phone,email:req.body.email,'address.line1':req.body.address}},{new:true}).lean()))));
r.post('/admin/outlets/:id/credentials', ah(async(req,res)=>{
  const mongoose=require('mongoose');
  const outletId=String(req.params.id||'').trim();
  if(!mongoose.isValidObjectId(outletId)) throw new AppError('The selected outlet id is invalid. Refresh the page and try again.',400,'INVALID_OUTLET_ID');
  const outlet=await Outlet.findById(outletId);
  if(!outlet) throw new AppError('The selected outlet no longer exists.',404,'OUTLET_NOT_FOUND');

  const password=String(req.body.password||'');
  if(password.length<8) throw new AppError('Password must contain at least 8 characters',400,'WEAK_PASSWORD');

  const username=String(req.body.username||'').trim().toLowerCase();
  const email=String(req.body.email||'').trim().toLowerCase();
  const phone=String(req.body.phone||'').replace(/\s+/g,'').trim();
  if(!username&&!email&&!phone) throw new AppError('Enter a username, email or phone for outlet login',400,'SELLER_IDENTITY_REQUIRED');
  if(username&&!/^[a-z0-9._-]{3,40}$/.test(username)) throw new AppError('Username must be 3-40 characters and use only letters, numbers, dot, underscore or hyphen.',400,'INVALID_USERNAME');
  if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError('Enter a valid outlet manager email address.',400,'INVALID_EMAIL');
  if(phone&&!/^\+?[0-9]{8,15}$/.test(phone)) throw new AppError('Enter a valid outlet manager phone number.',400,'INVALID_PHONE');

  let user=null;
  if(outlet.managerUserId) user=await User.findOne({_id:outlet.managerUserId,role:'SELLER'}).select('+passwordHash');
  if(!user) user=await User.findOne({role:'SELLER',assignedOutletIds:outletId}).select('+passwordHash');
  const identities=[];
  if(username) identities.push({username});
  if(email) identities.push({email});
  if(phone) identities.push({phone});

  const conflict=identities.length?await User.findOne({...(user?{_id:{$ne:user._id}}:{}),$or:identities}).lean():null;
  if(conflict){
    const field=conflict.username===username&&username?'username':conflict.email===email&&email?'email':'phone';
    throw new AppError(`This ${field} is already used by another account. Enter a unique ${field} for this outlet manager.`,409,'SELLER_IDENTITY_CONFLICT',{field});
  }

  if(!user) user=new User({role:'SELLER'});
  user.name=String(req.body.name||req.body.managerName||user.name||'Outlet Manager').trim();
  user.username=username||undefined;
  user.email=email||undefined;
  user.phone=phone||undefined;
  user.passwordHash=await bcrypt.hash(password,12);
  user.assignedOutletIds=[outletId];
  user.active=true;
  await user.save();
  // An outlet has exactly one manager account. Remove this outlet from stale
  // seller assignments so future logins cannot resolve ambiguously.
  await User.updateMany({_id:{$ne:user._id},role:'SELLER',assignedOutletIds:outletId},{$pull:{assignedOutletIds:outletId}});

  outlet.managerName=user.name;
  outlet.managerUserId=user._id;
  if(phone) outlet.managerPhone=phone;
  if(email) outlet.email=email;
  await outlet.save();

  ok(res,{id:String(user._id),username:user.username,email:user.email,phone:user.phone,assignedOutletIds:user.assignedOutletIds.map(String),loginWith:user.username||user.email||user.phone},'Outlet credentials saved');
}));
r.get('/admin/outlets/:id/orders', ah(async(req,res)=>ok(res,(await Order.find({outletId:req.params.id}).populate('customerId outletId riderId').sort({createdAt:-1}).lean()).map(normalizeOrder))));
r.get('/admin/outlets/:id/stock-ledger', ah(async(req,res)=>ok(res,await InventoryMovement.find({outletId:req.params.id}).populate('productId').sort({createdAt:-1}).limit(500).lean())));
r.get('/admin/outlets/:id/stock-submissions', ah(async(req,res)=>ok(res,await DailyClosing.find({outletId:req.params.id}).populate('sellerId').sort({businessDate:-1}).lean())));
r.get('/admin/outlets/:id/business-audit', ah(async(req,res)=>ok(res,{orderEvents:await OrderEvent.find({orderId:{$in:await Order.distinct('_id',{outletId:req.params.id})}}).sort({createdAt:-1}).limit(200).lean(),inventoryMovements:await InventoryMovement.find({outletId:req.params.id}).sort({createdAt:-1}).limit(200).lean()})));

r.get('/admin/selected-outlet', ah(async(req,res)=>{
  const selected=await settings.get('admin_selected_outlet');
  const outletId=String(selected?.outletId||selected||'').trim();
  if(!outletId) return ok(res,{outletId:null,outlet:null});
  const outlet=mongoose.isValidObjectId(outletId)?await Outlet.findById(outletId).lean():null;
  if(!outlet){ await settings.set('admin_selected_outlet',{outletId:null},req.user.id,false,{requestId:req.id}); return ok(res,{outletId:null,outlet:null}); }
  ok(res,{outletId:String(outlet._id),outlet:normalizeOutlet(outlet)});
}));
r.put('/admin/selected-outlet', ah(async(req,res)=>{
  const outletId=String(req.body.outletId||'').trim();
  if(!mongoose.isValidObjectId(outletId)) throw new AppError('Select a valid outlet',400,'INVALID_OUTLET_ID');
  const outlet=await Outlet.findById(outletId).lean();
  if(!outlet) throw new AppError('Selected outlet was not found',404,'OUTLET_NOT_FOUND');
  await settings.set('admin_selected_outlet',{outletId:String(outlet._id)},req.user.id,false,{requestId:req.id});
  ok(res,{outletId:String(outlet._id),outlet:normalizeOutlet(outlet)},'Admin operating outlet updated');
}));

async function adminCancelOrder(req,res){
  const order=await findOneCompat(Order,req.params.id);
  if(!order) throw new AppError('Order not found',404,'ORDER_NOT_FOUND');
  if(['DELIVERED','CANCELLED','REJECTED','REFUNDED'].includes(String(order.status).toUpperCase())) throw new AppError('This order is already final and cannot be cancelled',409,'ORDER_FINAL');
  const reason=String(req.body.reason||'Cancelled by administrator').trim()||'Cancelled by administrator';
  const changed=await orderService.changeStatus(order,req.user,'CANCELLED',reason,req.headers['idempotency-key']||`${req.id}:ADMIN_CANCEL`,{force:true});
  ok(res,normalizeOrder(changed.toObject?.()||changed),'Order cancelled');
}
r.post(['/admin/orders/:id/cancel','/admin/mr-breado/orders/:id/cancel','/admin/orders/:id/reject'], ah(adminCancelOrder));

r.get(['/admin/outlets/:id/performance','/admin/outlets/:id/calendar'], ah(async(req,res)=>{const orders=await Order.find({outletId:req.params.id}).lean();ok(res,{orders:orders.length,delivered:orders.filter(x=>x.status==='DELIVERED').length,cancelled:orders.filter(x=>x.status==='CANCELLED').length,revenue:orders.filter(x=>x.status==='DELIVERED').reduce((a,x)=>a+Number(x.total||0),0),items:orders})}));

r.get(['/admin/payment-controls','/admin/api-keys','/admin/business/settings'], ah(async(req,res)=>{
  const [features,adminSettings,pricing,razorpay]=await Promise.all([settings.getBusinessFeatures(),settings.adminSettings(),settings.getDeliveryPricing(),settings.getRazorpayConfig(false)]);
  const rp=adminSettings.secrets.find(x=>x.key==='razorpay_credentials')||{};const gm=adminSettings.secrets.find(x=>x.key==='google_maps_credentials')||{};
  ok(res,{codEnabled:features.feature_toggles.cod,onlinePaymentEnabled:features.feature_toggles.onlinePayment,mrBreadoTakeawayEnabled:features.feature_toggles.takeaway,takeawayEnabled:features.feature_toggles.takeaway,takeawayAdvancePercentage:features.takeaway.advanceValue,razorpayMode:String(razorpay?.keyId||'').startsWith('rzp_live_')?'LIVE':'TEST',razorpayKeyId:razorpay?.keyId||'',razorpaySecretConfigured:Boolean(razorpay?.keySecret),razorpayWebhookSecretConfigured:Boolean(razorpay?.webhookSecret),googleMapKey:'',googleMapsApiKey:'',googleMapsApiKeyConfigured:Boolean(gm.configured&&gm.apiKey),googleMapsAdminActionRequired:!Boolean(gm.configured&&gm.apiKey),googleMapsStatusMessage:Boolean(gm.configured&&gm.apiKey)?'Google Maps API key is configured':'Google Maps API key is required before delivery can be enabled',baseDeliveryCharge:pricing.customer.baseCharge,deliveryChargePerKm:pricing.customer.perKmCharge,minimumDeliveryCharge:pricing.customer.minimumCharge,maximumDeliveryCharge:pricing.customer.maximumCharge,riderBasePay:pricing.rider.basePay,riderPayPerKm:pricing.rider.perKmRate,minimumRiderDeliveryPay:pricing.rider.minimumDeliveryPay,assignmentRadiusKm:pricing.rider.assignmentRadiusKm,monthlySettlementDay:pricing.rider.monthlySettlementDay,distanceProvider:'GOOGLE'});
}));

r.get(['/admin/delivery-pricing','/admin/delivery-charges'], ah(async(req,res)=>{
  const pricing=await settings.getDeliveryPricing();
  ok(res,{...pricing,baseDeliveryCharge:pricing.customer.baseCharge,deliveryChargePerKm:pricing.customer.perKmCharge,minimumDeliveryCharge:pricing.customer.minimumCharge,maximumDeliveryCharge:pricing.customer.maximumCharge,riderBasePay:pricing.rider.basePay,riderPayPerKm:pricing.rider.perKmRate,minimumRiderDeliveryPay:pricing.rider.minimumDeliveryPay,assignmentRadiusKm:pricing.rider.assignmentRadiusKm,monthlySettlementDay:pricing.rider.monthlySettlementDay,formula:{customer:'max(minimum, min(maximum, base + distance × perKm))',rider:'max(minimum, base + distance × perKm)'}});
}));

r.put(['/admin/delivery-pricing','/admin/delivery-charges'], ah(async(req,res)=>{
  const pricing=await settings.setDeliveryPricing({
    customer:req.body.customer||{
      baseCharge:req.body.baseDeliveryCharge,
      perKmCharge:req.body.deliveryChargePerKm,
      minimumCharge:req.body.minimumDeliveryCharge,
      maximumCharge:req.body.maximumDeliveryCharge,
    },
    rider:req.body.rider||{
      basePay:req.body.riderBasePay,
      perKmRate:req.body.riderPayPerKm??req.body.riderDeliveryPayPerKm,
      minimumDeliveryPay:req.body.minimumRiderDeliveryPay,
      assignmentRadiusKm:req.body.assignmentRadiusKm,
      monthlySettlementDay:req.body.monthlySettlementDay,
    },
  },req.user.id,{requestId:req.id});
  ok(res,{...pricing,baseDeliveryCharge:pricing.customer.baseCharge,deliveryChargePerKm:pricing.customer.perKmCharge,minimumDeliveryCharge:pricing.customer.minimumCharge,maximumDeliveryCharge:pricing.customer.maximumCharge,riderBasePay:pricing.rider.basePay,riderPayPerKm:pricing.rider.perKmRate,minimumRiderDeliveryPay:pricing.rider.minimumDeliveryPay,assignmentRadiusKm:pricing.rider.assignmentRadiusKm,monthlySettlementDay:pricing.rider.monthlySettlementDay},'Delivery pricing saved');
}));
r.put('/admin/payment-controls', ah(async(req,res)=>{
  await settings.setBusinessFeatures({
    onlinePaymentEnabled:req.body.onlinePaymentEnabled,
    takeawayEnabled:req.body.mrBreadoTakeawayEnabled??req.body.takeawayEnabled,
    takeawayAdvancePercentage:req.body.takeawayAdvancePercentage??0,
    feature_toggles:{cod:req.body.codEnabled!==false},
  },req.user.id,{requestId:req.id});

  const current=await settings.getRazorpayConfig(false);
  const mode=String(req.body.razorpayMode||req.body.mode||current.mode||'TEST').toUpperCase()==='LIVE'?'LIVE':'TEST';
  const preserve=(next,old)=>{const v=String(next||'').trim();return !v||v.includes('*')?old:v;};
  const credentials={
    enabled:req.body.onlinePaymentEnabled!==false,
    mode,
    testKeyId:preserve(req.body.razorpayTestKeyId??(mode==='TEST'?req.body.razorpayKeyId:null),current.testKeyId||(current.mode==='TEST'?current.keyId:'')),
    testKeySecret:preserve(req.body.razorpayTestKeySecret??(mode==='TEST'?req.body.razorpayKeySecret:null),current.testKeySecret||(current.mode==='TEST'?current.keySecret:'')),
    testWebhookSecret:preserve(req.body.razorpayTestWebhookSecret??(mode==='TEST'?req.body.razorpayWebhookSecret:null),current.testWebhookSecret||(current.mode==='TEST'?current.webhookSecret:'')),
    liveKeyId:preserve(req.body.razorpayLiveKeyId??(mode==='LIVE'?req.body.razorpayKeyId:null),current.liveKeyId||(current.mode==='LIVE'?current.keyId:'')),
    liveKeySecret:preserve(req.body.razorpayLiveKeySecret??(mode==='LIVE'?req.body.razorpayKeySecret:null),current.liveKeySecret||(current.mode==='LIVE'?current.keySecret:'')),
    liveWebhookSecret:preserve(req.body.razorpayLiveWebhookSecret??(mode==='LIVE'?req.body.razorpayWebhookSecret:null),current.liveWebhookSecret||(current.mode==='LIVE'?current.webhookSecret:'')),
  };
  const activeKeyId=mode==='LIVE'?credentials.liveKeyId:credentials.testKeyId;
  const activeSecret=mode==='LIVE'?credentials.liveKeySecret:credentials.testKeySecret;
  if(credentials.enabled){
    const expectedPrefix=mode==='LIVE'?'rzp_live_':'rzp_test_';
    if(!String(activeKeyId||'').startsWith(expectedPrefix)) throw new AppError(`Enter a valid ${mode.toLowerCase()} Razorpay Key ID`,400,'INVALID_RAZORPAY_KEY_ID');
    if(!activeSecret) throw new AppError(`${mode} Razorpay Secret Key is required`,400,'INVALID_RAZORPAY_SECRET');
  }
  await settings.setSecret('razorpay_credentials',credentials,req.user.id,{requestId:req.id});
  ok(res,{...(await settings.getBusinessFeatures()),razorpayMode:mode,razorpayKeyId:activeKeyId,razorpayConfigured:Boolean(activeKeyId&&activeSecret),razorpaySecretConfigured:Boolean(activeSecret)},'Payment controls saved');
}));
r.put(['/admin/api-keys','/admin/business/settings'], ah(async(req,res)=>{
  const suppliedApiKey=String(req.body.googleMapKey||req.body.googleMapsApiKey||'').trim();
  const apiKey=suppliedApiKey.includes('*')?'':suppliedApiKey;
  const current=await settings.getGoogleMapsConfig(false);
  if(!apiKey&&!current?.apiKey) throw new AppError('Google Maps API key is required',400,'GOOGLE_MAPS_KEY_REQUIRED');
  if(apiKey) await settings.setSecret('google_maps_credentials',{apiKey,enabled:req.body.googleMapsEnabled!==false,adminConfigured:true},req.user.id,{requestId:req.id});
  const containsLegacyPricing=['baseDeliveryCharge','deliveryChargePerKm','minimumDeliveryCharge','maximumDeliveryCharge','riderBasePay','riderPayPerKm','minimumRiderDeliveryPay'].some((key)=>req.body[key]!==undefined);
  if(containsLegacyPricing){
    const currentPricing=await settings.getDeliveryPricing();
    await settings.setDeliveryPricing({
      customer:{...currentPricing.customer,baseCharge:req.body.baseDeliveryCharge??currentPricing.customer.baseCharge,perKmCharge:req.body.deliveryChargePerKm??currentPricing.customer.perKmCharge,minimumCharge:req.body.minimumDeliveryCharge??currentPricing.customer.minimumCharge,maximumCharge:req.body.maximumDeliveryCharge??currentPricing.customer.maximumCharge},
      rider:{...currentPricing.rider,basePay:req.body.riderBasePay??currentPricing.rider.basePay,perKmRate:req.body.riderPayPerKm??currentPricing.rider.perKmRate,minimumDeliveryPay:req.body.minimumRiderDeliveryPay??currentPricing.rider.minimumDeliveryPay,monthlySettlementDay:req.body.monthlySettlementDay??currentPricing.rider.monthlySettlementDay},
    },req.user.id,{requestId:req.id});
  }
  ok(res,{saved:true,googleMapsApiKeyConfigured:Boolean(apiKey||current?.apiKey)},'API settings saved');
}));
r.get('/admin/maps/browser-config', ah(async(_req,res)=>{const cfg=await settings.getGoogleMapsConfig(false);ok(res,{configured:Boolean(cfg.apiKey),enabled:cfg.enabled!==false,apiKey:cfg.enabled!==false?cfg.apiKey:'',message:cfg.apiKey?'Google Maps is ready':'Add a Google Maps API key from API Keys before using the map picker'});}));
r.post('/admin/api-keys/validate-google', ah(async(req,res)=>ok(res,await settings.validateIntegration('google_maps_credentials'),'Google Maps API key is valid')));

r.get(['/admin/mr-breado/orders','/admin/orders/:id'], ah(async(req,res,next)=>{if(req.params.id){const o=await Order.findById(req.params.id).populate('customerId outletId riderId').lean();if(!o)throw new AppError('Order not found',404);return ok(res,normalizeOrder(o));}return ok(res,(await Order.find().populate('customerId outletId riderId').sort({createdAt:-1}).lean()).map(normalizeOrder));}));
for(const [suffix,status] of [['accept','ACCEPTED'],['preparing','PREPARING'],['prep','PREPARING'],['ready','READY'],['reject','REJECTED']]) {
  r.post([`/admin/mr-breado/orders/:id/${suffix}`,`/admin/orders/:id/${suffix}`],ah(async(req,res)=>{
    const o=await findOneCompat(Order,req.params.id);
    if(!o)throw new AppError('Order not found',404,'ORDER_NOT_FOUND');
    const force=status==='REJECTED'&&String(req.user.role).toUpperCase()==='ADMIN';
    const changed=await orderService.changeStatus(o,req.user,status,req.body.reason,req.headers['idempotency-key']||`${req.id}:${status}`,{force});
    ok(res,normalizeOrder(changed.toObject?.()||changed));
  }));
}
r.get(['/admin/mr-breado/orders/:id/invoice.pdf','/admin/orders/:id/invoice.pdf','/admin/orders/:id/invoice'], ah(async(req,res)=>{
  const order=await findOneCompat(Order,req.params.id);
  if(!order) throw new AppError('Order not found',404,'ORDER_NOT_FOUND');
  return invoiceService.stream(order,req.user,res);
}));
r.post(['/admin/mr-breado/orders/:id/invoice/send-to-customer','/admin/orders/:id/invoice/send-to-customer','/admin/orders/:id/send-invoice'], ah(async(req,res)=>{
  const order=await findOneCompat(Order,req.params.id);
  if(!order) throw new AppError('Order not found',404,'ORDER_NOT_FOUND');
  await Notification.create({userId:order.customerId,outletId:order.outletId,role:'CUSTOMER',title:'Order receipt ready',message:`Your receipt for ${order.slug} is ready to download.`,type:'INVOICE_READY',data:{orderId:String(order._id),orderSlug:order.slug}});
  ok(res,{orderId:String(order._id),orderSlug:order.slug,status:'READY'},'Receipt sent to customer');
}));

r.get('/admin/online-transactions', ah(async(req,res)=>ok(res,await Payment.find().populate('orderId customerId outletId').sort({createdAt:-1}).lean())));
r.get('/admin/online-transactions/:id', ah(async(req,res)=>ok(res,await Payment.findById(req.params.id).populate('orderId customerId outletId').lean())));
r.get('/admin/online-transactions/:id/receipt.pdf', ah(async(req,res)=>{const p=await Payment.findById(req.params.id).lean();if(!p)throw new AppError('Transaction not found',404);if(!p.orderId)throw new AppError('No order invoice available',404);return invoiceService.stream(String(p.orderId),req.user,res)}));

module.exports = r;
