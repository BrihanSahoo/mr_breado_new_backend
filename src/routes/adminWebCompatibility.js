const express = require('express');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
const ah = require('../utils/asyncHandler');
const { ok } = require('../utils/respond');
const { requireAuth, allowRoles } = require('../middleware/auth');
const { AppError } = require('../utils/errors');
const {
  User, Outlet, Category, Brand, Product, OutletProduct, Order, OrderEvent,
  Payment, Refund, OfflineSale, DailyClosing, InventoryMovement, Invoice, BiteStory,
} = require('../models');
const settings = require('../services/settingsService');
const orderService = require('../services/orderService');
const invoiceService = require('../services/invoiceService');
const { buildVariantFields, serializeVariantFields } = require('../utils/productVariants');
const deliveryService = require('../services/deliveryService');

const r = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: (_req,file,cb)=>cb(null,/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) });
async function uploadMedia(file, folder='products'){
  if(!file) return null;
  if(!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) throw new AppError('Cloudinary configuration is required for image upload',503,'IMAGE_STORAGE_NOT_CONFIGURED');
  cloudinary.config({cloud_name:process.env.CLOUDINARY_CLOUD_NAME,api_key:process.env.CLOUDINARY_API_KEY,api_secret:process.env.CLOUDINARY_API_SECRET});
  const data=`data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
  const result=await cloudinary.uploader.upload(data,{folder:`mr-breado/${folder}`,resource_type:'image'});
  return {url:result.secure_url,publicId:result.public_id,alt:file.originalname};
}
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
  categoryName: p.categoryId?.name || '', categoryId: p.categoryId?._id || p.categoryId, brandId:p.brandId?._id||p.brandId||null, brandName:p.brandId?.name||'', brandSlug:p.brandId?.slug||'', brand:p.brandId||null, isAvailable: p.active,
  ...serializeVariantFields(p),
}) : null;
const normalizeOrder = (o) => o ? ({
  ...o,
  id: String(o._id), orderId: String(o._id), orderNumber: o.slug,
  customer: o.customerId, customerName: o.customerId?.name,
  customerMobile: o.customerId?.phone, customerEmail: o.customerId?.email,
  outlet: o.outletId, outletName: o.outletId?.name, restaurantName: o.outletId?.name,
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

async function resolveCategory(body){
  let category=null;
  if(body.categoryId||body.category_id) category=await Category.findById(body.categoryId||body.category_id);
  if(!category&&(body.categoryName||body.category_name||body.category)) category=await Category.findOne({name:new RegExp(`^${String(body.categoryName||body.category_name||body.category).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}$`,'i')});
  if(!category||!category.active) throw new AppError('Select an active Admin category',400,'INVALID_CATEGORY');
  return category;
}

async function resolveBrand(body, existing={}) {
  const raw = body.brandId ?? body.brand_id ?? body.brand ?? body.brandSlug ?? body.brand_slug ?? existing.brandId;
  if (!raw) return null;
  let brand = null;
  if (mongoose.isValidObjectId(raw)) brand = await Brand.findById(raw);
  if (!brand) brand = await Brand.findOne({ $or:[{slug:String(raw).toLowerCase()},{name:new RegExp(`^${String(raw).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}$`,'i')}], active:true });
  if (!brand) throw new AppError('Select an active Admin-created brand',400,'INVALID_BRAND');
  return brand;
}

async function compatibilityProductPayload(body,existing={}){
  const category=await resolveCategory(body);
  const variants=buildVariantFields({...existing,...body},category);
  const brand=await resolveBrand(body,existing);
  const images=Array.isArray(body.images)?body.images.map(x=>typeof x==='string'?{url:x}:x).filter(x=>x?.url):(existing.images||[]);
  return {...body,name:body.name||body.title||existing.name,categoryId:category._id,brandId:brand?._id||null,images,...variants};
}
r.route('/admin/mr-breado/products')
 .get(ah(async(req,res)=>ok(res,(await Product.find().populate('categoryId').sort({createdAt:-1}).lean()).map(normalizeProduct))))
 .post(upload.single('image'),ah(async(req,res)=>{const body={...req.body};const uploaded=await uploadMedia(req.file,'products');if(uploaded)body.images=[uploaded];const payload=await compatibilityProductPayload(body);const product=await Product.create({...payload,slug:req.body.slug||`${String(payload.name).trim().toLowerCase().replace(/[^a-z0-9]+/g,'-')}-${require('nanoid').nanoid(5)}`,createdBy:req.user.id});ok(res,normalizeProduct(await Product.findById(product._id).populate('categoryId brandId').lean()),'Product created',201)}));
r.route('/admin/mr-breado/products/:id')
 .get(ah(async(req,res)=>{const p=await Product.findById(req.params.id).populate('categoryId brandId').lean();if(!p)throw new AppError('Product not found',404);ok(res,normalizeProduct(p))}))
 .put(upload.single('image'),ah(async(req,res)=>{const existing=await Product.findById(req.params.id).lean();if(!existing)throw new AppError('Product not found',404);const body={...req.body};const uploaded=await uploadMedia(req.file,'products');if(uploaded)body.images=[uploaded];const payload=await compatibilityProductPayload(body,existing);const p=await Product.findByIdAndUpdate(req.params.id,{$set:payload},{new:true,runValidators:true}).populate('categoryId brandId').lean();ok(res,normalizeProduct(p),'Product updated')}))
 .delete(ah(async(req,res)=>{await Product.findByIdAndUpdate(req.params.id,{$set:{active:false}});ok(res,null,'Product disabled')}));
r.patch('/admin/mr-breado/products/:id/availability',ah(async(req,res)=>ok(res,normalizeProduct(await Product.findByIdAndUpdate(req.params.id,{$set:{active:req.body.isAvailable??req.body.available??true}},{new:true}).populate('categoryId').lean()))));


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
 .delete(ah(async(req,res)=>{const story=await BiteStory.findByIdAndDelete(req.params.id);if(!story)throw new AppError('Story not found',404);if(story.media?.publicId){cloudinary.config({cloud_name:process.env.CLOUDINARY_CLOUD_NAME,api_key:process.env.CLOUDINARY_API_KEY,api_secret:process.env.CLOUDINARY_API_SECRET});await cloudinary.uploader.destroy(story.media.publicId).catch(()=>{});}ok(res,null,'Story deleted');}));
r.patch('/admin/stories/:id/status',ah(async(req,res)=>{const active=String(req.body.active??req.body.enabled??true)!=='false';const story=await BiteStory.findByIdAndUpdate(req.params.id,{$set:{active}},{new:true,runValidators:true}).lean();if(!story)throw new AppError('Story not found',404);ok(res,normalizeStory(story),'Story status updated');}));

r.route('/admin/brands')
 .get(ah(async(req,res)=>ok(res,(await Brand.find().sort({name:1}).lean()).map(b=>({...b,id:String(b._id),image:b.image?.url||'',imageUrl:b.image?.url||''})))))
 .post(upload.single('image'),ah(async(req,res)=>{const name=String(req.body.name||'').trim();if(!name)throw new AppError('Brand name is required',400);const media=await uploadMedia(req.file,'brands');const slug=String(req.body.slug||name).trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');const brand=await Brand.create({name,slug,image:media||imageUrl(req.body.imageUrl||req.body.image),active:req.body.active!==false&&String(req.body.active)!=='false'});ok(res,{...brand.toObject(),id:String(brand._id),image:brand.image?.url||'',imageUrl:brand.image?.url||''},'Brand created',201)}));
r.route('/admin/brands/:id')
 .put(upload.single('image'),ah(async(req,res)=>{const update={};if(req.body.name)update.name=String(req.body.name).trim();if(req.body.slug||req.body.name)update.slug=String(req.body.slug||req.body.name).trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');if(req.body.active!==undefined)update.active=String(req.body.active)!=='false';const media=await uploadMedia(req.file,'brands');if(media)update.image=media;else if(req.body.imageUrl||req.body.image)update.image=imageUrl(req.body.imageUrl||req.body.image);const brand=await Brand.findByIdAndUpdate(req.params.id,{$set:update},{new:true,runValidators:true}).lean();ok(res,{...brand,id:String(brand._id),image:brand.image?.url||'',imageUrl:brand.image?.url||''},'Brand updated')}))
 .delete(ah(async(req,res)=>{await Brand.findByIdAndUpdate(req.params.id,{$set:{active:false}});ok(res,null,'Brand disabled')}));

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
  const radius=Number(req.body.serviceRadiusKm ?? req.body.deliveryRadiusKm ?? req.body.delivery_radius_km ?? req.body.radiusKm ?? req.body.radius_km);
  if(!Number.isFinite(radius)||radius<=0||radius>100) throw new AppError('Delivery radius must be greater than 0 and at most 100 km',400,'INVALID_DELIVERY_RADIUS');
  const coords=await deliveryService.normalizeCoordinates({latitude:req.body.latitude,longitude:req.body.longitude,address:req.body.address,pincode:req.body.pincode,city:req.body.city,state:req.body.state});
  const set={location:{type:'Point',coordinates:[coords.longitude,coords.latitude]},deliveryRadiusKm:radius};
  if(req.body.address||coords.formattedAddress)set['address.line1']=req.body.address||coords.formattedAddress;
  if(req.body.city)set['address.city']=req.body.city;
  if(req.body.state)set['address.state']=req.body.state;
  if(req.body.pincode||coords.pincode)set['address.pincode']=req.body.pincode||coords.pincode;
  const out=await Outlet.findByIdAndUpdate(req.params.id,{$set:set},{new:true,runValidators:true}).lean();
  if(!out)throw new AppError('Outlet not found',404);
  ok(res,{...normalizeOutlet(out),coordinatesCorrected:Boolean(coords.suppliedCoordinatesSwapped)},'Outlet location updated');
}));
r.post('/admin/outlets/:id/branding', ah(async(req,res)=>ok(res,normalizeOutlet(await Outlet.findByIdAndUpdate(req.params.id,{$set:{logo:imageUrl(req.body.profileImage||req.body.logo),coverImage:imageUrl(req.body.bannerImage||req.body.coverImage),managerPhone:req.body.phone,email:req.body.email,'address.line1':req.body.address}},{new:true}).lean()))));
r.post('/admin/outlets/:id/credentials', ah(async(req,res)=>{const password=String(req.body.password||'');if(password.length<8)throw new AppError('Password must contain at least 8 characters');let user=await User.findOne({role:'SELLER',$or:[{email:req.body.email?.toLowerCase()},{phone:req.body.phone}].filter(x=>Object.values(x)[0])}).select('+passwordHash');if(!user)user=new User({name:req.body.name||req.body.managerName||'Outlet Manager',email:req.body.email?.toLowerCase(),phone:req.body.phone,role:'SELLER',passwordHash:await bcrypt.hash(password,12),assignedOutletIds:[req.params.id]});else{user.passwordHash=await bcrypt.hash(password,12);user.assignedOutletIds=[req.params.id];user.active=true;}await user.save();ok(res,{id:user._id,email:user.email,phone:user.phone,assignedOutletIds:user.assignedOutletIds},'Outlet credentials saved')}));
r.get('/admin/outlets/:id/orders', ah(async(req,res)=>ok(res,(await Order.find({outletId:req.params.id}).populate('customerId outletId riderId').sort({createdAt:-1}).lean()).map(normalizeOrder))));
r.get('/admin/outlets/:id/stock-ledger', ah(async(req,res)=>ok(res,await InventoryMovement.find({outletId:req.params.id}).populate('productId').sort({createdAt:-1}).limit(500).lean())));
r.get('/admin/outlets/:id/stock-submissions', ah(async(req,res)=>ok(res,await DailyClosing.find({outletId:req.params.id}).populate('sellerId').sort({businessDate:-1}).lean())));
r.get('/admin/outlets/:id/business-audit', ah(async(req,res)=>ok(res,{orderEvents:await OrderEvent.find({orderId:{$in:await Order.distinct('_id',{outletId:req.params.id})}}).sort({createdAt:-1}).limit(200).lean(),inventoryMovements:await InventoryMovement.find({outletId:req.params.id}).sort({createdAt:-1}).limit(200).lean()})));
r.get(['/admin/outlets/:id/performance','/admin/outlets/:id/calendar'], ah(async(req,res)=>{const orders=await Order.find({outletId:req.params.id}).lean();ok(res,{orders:orders.length,delivered:orders.filter(x=>x.status==='DELIVERED').length,cancelled:orders.filter(x=>x.status==='CANCELLED').length,revenue:orders.filter(x=>x.status==='DELIVERED').reduce((a,x)=>a+Number(x.total||0),0),items:orders})}));

r.get(['/admin/payment-controls','/admin/api-keys','/admin/business/settings'], ah(async(req,res)=>{
  const [features,adminSettings,delivery,rider]=await Promise.all([settings.getBusinessFeatures(),settings.adminSettings(),settings.get('delivery_settings'),settings.get('rider_settings')]);
  const rp=adminSettings.secrets.find(x=>x.key==='razorpay_credentials')||{};const gm=adminSettings.secrets.find(x=>x.key==='google_maps_credentials')||{};
  ok(res,{codEnabled:features.feature_toggles.cod,onlinePaymentEnabled:features.feature_toggles.onlinePayment,mrBreadoTakeawayEnabled:features.feature_toggles.takeaway,takeawayEnabled:features.feature_toggles.takeaway,takeawayAdvancePercentage:features.takeaway.advanceValue,razorpayKeyId:rp.keyId||'',razorpaySecretConfigured:rp.keySecretConfigured,razorpayWebhookSecretConfigured:rp.webhookSecretConfigured,googleMapKey:gm.apiKey||'',googleMapsApiKey:gm.apiKey||'',googleMapsApiKeyConfigured:Boolean(gm.configured&&gm.apiKey),googleMapsAdminActionRequired:!Boolean(gm.configured&&gm.apiKey),googleMapsStatusMessage:Boolean(gm.configured&&gm.apiKey)?'Google Maps API key is configured':'Google Maps API key is required before delivery can be enabled',baseDeliveryCharge:delivery?.baseCharge||0,deliveryChargePerKm:delivery?.perKmCharge||0,minimumDeliveryCharge:delivery?.minimumCharge||0,maximumDeliveryCharge:delivery?.maximumCharge||9999,riderBasePay:rider?.basePay||0,riderPayPerKm:rider?.perKmRate||0,distanceProvider:'GOOGLE'});
}));
r.put('/admin/payment-controls', ah(async(req,res)=>{await settings.setBusinessFeatures({onlinePaymentEnabled:req.body.onlinePaymentEnabled,takeawayEnabled:req.body.mrBreadoTakeawayEnabled??req.body.takeawayEnabled,takeawayAdvancePercentage:req.body.takeawayAdvancePercentage??0,feature_toggles:{cod:req.body.codEnabled!==false}},req.user.id,{requestId:req.id});if(req.body.razorpayKeyId||req.body.razorpayKeySecret)await settings.setSecret('razorpay_credentials',{keyId:req.body.razorpayKeyId,keySecret:req.body.razorpayKeySecret||undefined,webhookSecret:req.body.razorpayWebhookSecret||undefined,enabled:req.body.onlinePaymentEnabled!==false},req.user.id,{requestId:req.id});ok(res,await settings.getBusinessFeatures(),'Payment controls saved')}));
r.put(['/admin/api-keys','/admin/business/settings'], ah(async(req,res)=>{
  const apiKey=String(req.body.googleMapKey||req.body.googleMapsApiKey||'').trim();
  const current=await settings.getGoogleMapsConfig(false);
  if(!apiKey&&!current?.apiKey) throw new AppError('Google Maps API key is required',400,'GOOGLE_MAPS_KEY_REQUIRED');
  if(apiKey) await settings.setSecret('google_maps_credentials',{apiKey,enabled:req.body.googleMapsEnabled!==false,adminConfigured:true},req.user.id,{requestId:req.id});
  await settings.set('delivery_settings',{baseCharge:Number(req.body.baseDeliveryCharge||0),perKmCharge:Number(req.body.deliveryChargePerKm||0),minimumCharge:Number(req.body.minimumDeliveryCharge||0),maximumCharge:Number(req.body.maximumDeliveryCharge||9999)},req.user.id,true,{requestId:req.id});
  await settings.set('rider_settings',{basePay:Number(req.body.riderBasePay||0),perKmRate:Number(req.body.riderPayPerKm||0),monthlySettlementDay:Number(req.body.monthlySettlementDay||1)},req.user.id,false,{requestId:req.id});
  ok(res,{saved:true,googleMapsApiKeyConfigured:true},'API and business settings saved');
}));
r.post('/admin/api-keys/validate-google', ah(async(req,res)=>ok(res,await settings.validateIntegration('google_maps_credentials'),'Google Maps API key is valid')));

r.get(['/admin/mr-breado/orders','/admin/orders/:id'], ah(async(req,res,next)=>{if(req.params.id){const o=await Order.findById(req.params.id).populate('customerId outletId riderId').lean();if(!o)throw new AppError('Order not found',404);return ok(res,normalizeOrder(o));}return ok(res,(await Order.find().populate('customerId outletId riderId').sort({createdAt:-1}).lean()).map(normalizeOrder));}));
for(const [suffix,status] of [['accept','ACCEPTED'],['preparing','PREPARING'],['ready','READY'],['reject','REJECTED']]) r.post(`/admin/mr-breado/orders/:id/${suffix}`,ah(async(req,res)=>{const o=await Order.findById(req.params.id);if(!o)throw new AppError('Order not found',404);ok(res,normalizeOrder((await orderService.changeStatus(o,req.user,status,req.body.reason,req.headers['idempotency-key']||`${req.id}:${status}`)).toObject?.()||o))}));
r.get(['/admin/mr-breado/orders/:id/invoice.pdf','/admin/orders/:id/invoice.pdf'], ah(async(req,res)=>invoiceService.stream(req.params.id,req.user,res)));
r.post('/admin/mr-breado/orders/:id/invoice/send-to-customer', ah(async(req,res)=>{const inv=await Invoice.findOne({orderId:req.params.id});ok(res,inv||{orderId:req.params.id,status:'READY'},'Invoice ready for customer download')}));

r.get('/admin/online-transactions', ah(async(req,res)=>ok(res,await Payment.find().populate('orderId customerId outletId').sort({createdAt:-1}).lean())));
r.get('/admin/online-transactions/:id', ah(async(req,res)=>ok(res,await Payment.findById(req.params.id).populate('orderId customerId outletId').lean())));
r.get('/admin/online-transactions/:id/receipt.pdf', ah(async(req,res)=>{const p=await Payment.findById(req.params.id).lean();if(!p)throw new AppError('Transaction not found',404);if(!p.orderId)throw new AppError('No order invoice available',404);return invoiceService.stream(String(p.orderId),req.user,res)}));

module.exports = r;
