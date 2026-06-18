const express = require('express');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const ah = require('../utils/asyncHandler');
const { ok } = require('../utils/respond');
const { requireAuth, allowRoles } = require('../middleware/auth');
const { AppError } = require('../utils/errors');
const {
  User, Outlet, Category, Product, OutletProduct, Order, OrderEvent,
  Payment, Refund, OfflineSale, DailyClosing, InventoryMovement, Invoice,
} = require('../models');
const settings = require('../services/settingsService');
const orderService = require('../services/orderService');
const invoiceService = require('../services/invoiceService');

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
const normalizeProduct = (p) => p ? ({
  ...p,
  id: String(p._id), productId: String(p._id), title: p.name,
  price: p.basePrice, effectivePrice: p.offerPrice || p.basePrice,
  image: p.images?.[0]?.url || '', imageUrl: p.images?.[0]?.url || '',
  categoryName: p.categoryId?.name || '', isAvailable: p.active,
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
r.get('/admin/dashboard/recent-orders', ah(async(req,res)=>ok(res,(await Order.find().populate('customerId outletId riderId').sort({createdAt:-1}).limit(10).lean()).map(normalizeOrder))));
r.get('/admin/dashboard/revenue', ah(async(req,res)=>ok(res,{items:await Order.aggregate([{$match:{status:'DELIVERED'}},{$group:{_id:{$dateToString:{format:'%Y-%m-%d',date:'$deliveredAt'}},revenue:{$sum:'$total'},orders:{$sum:1}}},{$sort:{_id:1}},{$limit:30}])})));
r.get('/admin/dashboard/payments', ah(async(req,res)=>ok(res,await Payment.aggregate([{$group:{_id:'$status',amount:{$sum:'$amount'},count:{$sum:1}}}]))));
r.get('/admin/dashboard/user-growth', ah(async(req,res)=>ok(res,await User.aggregate([{$group:{_id:{$dateToString:{format:'%Y-%m-%d',date:'$createdAt'}},count:{$sum:1}}},{$sort:{_id:1}},{$limit:30}]))));
r.get('/admin/dashboard/order-status-chart', ah(async(req,res)=>ok(res,await Order.aggregate([{$group:{_id:'$status',count:{$sum:1}}}]))));

r.get('/admin/category-summary', ah(async(req,res)=>{const [total,active,sub]=await Promise.all([Category.countDocuments(),Category.countDocuments({active:true}),Category.countDocuments({parentId:{$ne:null}})]);ok(res,{totalCategories:total,activeCategories:active,inactiveCategories:total-active,totalSubCategories:sub})}));
r.get(['/admin/food-categories','/admin/sub-categories'], ah(async(req,res)=>{const q=req.path.includes('sub-categories')?{parentId:{$ne:null}}:{};ok(res,await Category.find(q).sort({sortOrder:1,name:1}).lean())}));

r.get('/admin/products/:id', ah(async(req,res)=>ok(res,normalizeProduct(await Product.findById(req.params.id).populate('categoryId brandId').lean()))));
r.patch(['/admin/products/:id/stock','/admin/products/:id/availability'], ah(async(req,res)=>ok(res,normalizeProduct(await Product.findByIdAndUpdate(req.params.id,{$set:{active:req.body.isAvailable??req.body.available??req.body.active??true}},{new:true}).populate('categoryId').lean()))));

r.put('/admin/outlets/:id', ah(async(req,res)=>{
  const update={...req.body};
  if(req.body.outletName&&!req.body.name)update.name=req.body.outletName;
  if(req.body.serviceRadiusKm!==undefined)update.deliveryRadiusKm=Number(req.body.serviceRadiusKm);
  if(req.body.isOpen!==undefined)update.open=Boolean(req.body.isOpen);
  if(req.body.status)update.active=String(req.body.status).toUpperCase()==='ACTIVE';
  if(req.body.latitude!==undefined||req.body.longitude!==undefined) update.location={type:'Point',coordinates:[Number(req.body.longitude||0),Number(req.body.latitude||0)]};
  if(typeof req.body.logo==='string')update.logo=imageUrl(req.body.logo);
  if(typeof req.body.coverImage==='string')update.coverImage=imageUrl(req.body.coverImage);
  const out=await Outlet.findByIdAndUpdate(req.params.id,{$set:update},{new:true,runValidators:true}).lean();
  ok(res,normalizeOutlet(out),'Outlet updated');
}));
r.get('/admin/outlets/:id/gstin', ah(async(req,res)=>{const o=await Outlet.findById(req.params.id).lean();if(!o)throw new AppError('Outlet not found',404);ok(res,{gstin:o.gstin,invoiceLegalName:o.name,invoiceAddress:[o.address?.line1,o.address?.area,o.address?.city,o.address?.state,o.address?.pincode].filter(Boolean).join(', ')})}));
r.put('/admin/outlets/:id/gstin', ah(async(req,res)=>ok(res,normalizeOutlet(await Outlet.findByIdAndUpdate(req.params.id,{$set:{gstin:req.body.gstin,name:req.body.invoiceLegalName||undefined,'address.line1':req.body.invoiceAddress||undefined}},{new:true}).lean()))));
r.post('/admin/outlets/:id/set-location', ah(async(req,res)=>ok(res,normalizeOutlet(await Outlet.findByIdAndUpdate(req.params.id,{$set:{location:{type:'Point',coordinates:[Number(req.body.longitude),Number(req.body.latitude)]},deliveryRadiusKm:Number(req.body.serviceRadiusKm??req.body.deliveryRadiusKm),address:{line1:req.body.address,city:req.body.city,pincode:req.body.pincode}}},{new:true}).lean()))));
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
  ok(res,{codEnabled:features.feature_toggles.cod,onlinePaymentEnabled:features.feature_toggles.onlinePayment,mrBreadoTakeawayEnabled:features.feature_toggles.takeaway,takeawayEnabled:features.feature_toggles.takeaway,takeawayAdvancePercentage:features.takeaway.advanceValue,razorpayKeyId:rp.keyId||'',razorpaySecretConfigured:rp.keySecretConfigured,razorpayWebhookSecretConfigured:rp.webhookSecretConfigured,googleMapKey:gm.apiKey||'',googleMapsApiKey:gm.apiKey||'',googleMapsApiKeyConfigured:gm.configured,baseDeliveryCharge:delivery?.baseCharge||0,deliveryChargePerKm:delivery?.perKmCharge||0,minimumDeliveryCharge:delivery?.minimumCharge||0,maximumDeliveryCharge:delivery?.maximumCharge||9999,riderBasePay:rider?.basePay||0,riderPayPerKm:rider?.perKmRate||0,distanceProvider:'GOOGLE'});
}));
r.put('/admin/payment-controls', ah(async(req,res)=>{await settings.setBusinessFeatures({onlinePaymentEnabled:req.body.onlinePaymentEnabled,takeawayEnabled:req.body.mrBreadoTakeawayEnabled??req.body.takeawayEnabled,takeawayAdvancePercentage:req.body.takeawayAdvancePercentage??0,feature_toggles:{cod:req.body.codEnabled!==false}},req.user.id,{requestId:req.id});if(req.body.razorpayKeyId||req.body.razorpayKeySecret)await settings.setSecret('razorpay_credentials',{keyId:req.body.razorpayKeyId,keySecret:req.body.razorpayKeySecret||undefined,webhookSecret:req.body.razorpayWebhookSecret||undefined,enabled:req.body.onlinePaymentEnabled!==false},req.user.id,{requestId:req.id});ok(res,await settings.getBusinessFeatures(),'Payment controls saved')}));
r.put(['/admin/api-keys','/admin/business/settings'], ah(async(req,res)=>{if(req.body.googleMapKey||req.body.googleMapsApiKey)await settings.setSecret('google_maps_credentials',{apiKey:req.body.googleMapKey||req.body.googleMapsApiKey,enabled:req.body.googleMapsEnabled!==false},req.user.id,{requestId:req.id});await settings.set('delivery_settings',{baseCharge:Number(req.body.baseDeliveryCharge||0),perKmCharge:Number(req.body.deliveryChargePerKm||0),minimumCharge:Number(req.body.minimumDeliveryCharge||0),maximumCharge:Number(req.body.maximumDeliveryCharge||9999)},req.user.id,true,{requestId:req.id});await settings.set('rider_settings',{basePay:Number(req.body.riderBasePay||0),perKmRate:Number(req.body.riderPayPerKm||0),monthlySettlementDay:Number(req.body.monthlySettlementDay||1)},req.user.id,false,{requestId:req.id});ok(res,{saved:true},'API and business settings saved')}));

r.get(['/admin/mr-breado/orders','/admin/orders/:id'], ah(async(req,res,next)=>{if(req.params.id){const o=await Order.findById(req.params.id).populate('customerId outletId riderId').lean();if(!o)throw new AppError('Order not found',404);return ok(res,normalizeOrder(o));}return ok(res,(await Order.find().populate('customerId outletId riderId').sort({createdAt:-1}).lean()).map(normalizeOrder));}));
for(const [suffix,status] of [['accept','ACCEPTED'],['preparing','PREPARING'],['ready','READY'],['reject','REJECTED']]) r.post(`/admin/mr-breado/orders/:id/${suffix}`,ah(async(req,res)=>{const o=await Order.findById(req.params.id);if(!o)throw new AppError('Order not found',404);ok(res,normalizeOrder((await orderService.changeStatus(o,req.user,status,req.body.reason,req.headers['idempotency-key']||`${req.id}:${status}`)).toObject?.()||o))}));
r.get(['/admin/mr-breado/orders/:id/invoice.pdf','/admin/orders/:id/invoice.pdf'], ah(async(req,res)=>invoiceService.stream(req.params.id,req.user,res)));
r.post('/admin/mr-breado/orders/:id/invoice/send-to-customer', ah(async(req,res)=>{const inv=await Invoice.findOne({orderId:req.params.id});ok(res,inv||{orderId:req.params.id,status:'READY'},'Invoice ready for customer download')}));

r.get('/admin/online-transactions', ah(async(req,res)=>ok(res,await Payment.find().populate('orderId customerId outletId').sort({createdAt:-1}).lean())));
r.get('/admin/online-transactions/:id', ah(async(req,res)=>ok(res,await Payment.findById(req.params.id).populate('orderId customerId outletId').lean())));
r.get('/admin/online-transactions/:id/receipt.pdf', ah(async(req,res)=>{const p=await Payment.findById(req.params.id).lean();if(!p)throw new AppError('Transaction not found',404);if(!p.orderId)throw new AppError('No order invoice available',404);return invoiceService.stream(String(p.orderId),req.user,res)}));

module.exports = r;
