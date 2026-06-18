const mongoose=require('mongoose');
const {nanoid}=require('nanoid');
const {Outlet,Product,OutletProduct,Order,OrderEvent,Payment,Refund,RiderEarning,Coupon,Offer}=require('../models');
const settings=require('./settingsService');
const inventory=require('./inventoryService');
const {haversineKm,deliveryCharge}=require('../utils/geo');
const {AppError}=require('../utils/errors');
const env=require('../config/env');
const transitions={PENDING_PAYMENT:['RECEIVED','PAYMENT_FAILED','CANCELLED'],RECEIVED:['ACCEPTED','REJECTED','CANCELLED'],ACCEPTED:['PREPARING','CANCELLED'],PREPARING:['READY','CANCELLED'],READY:['RIDER_ASSIGNMENT_PENDING','RIDER_ASSIGNED','PICKED_UP','DELIVERED','CANCELLED'],RIDER_ASSIGNMENT_PENDING:['RIDER_ASSIGNED','CANCELLED'],RIDER_ASSIGNED:['PICKED_UP','CANCELLED'],PICKED_UP:['DELIVERED'],REJECTED:[],CANCELLED:[],DELIVERED:[],REFUND_PENDING:['REFUNDED'],PAYMENT_FAILED:[]};
const aliases={PLACED:'RECEIVED',CONFIRMED:'ACCEPTED',PREPARED:'READY',OUT_FOR_DELIVERY:'PICKED_UP',COMPLETED:'DELIVERED'};
const canonical=s=>aliases[String(s||'').toUpperCase()]||String(s||'').toUpperCase();
const imageUrl=v=>{if(!v)return'';if(typeof v==='string'){let u=v.trim();if(u.startsWith('//'))u=`https:${u}`;if(u.startsWith('http://res.cloudinary.com/'))u=u.replace('http://','https://');if(u.includes('res.cloudinary.com/')&&u.includes('/upload/')){u=u.replace(/f_auto/g,'f_jpg');if(!u.includes('/upload/f_jpg')&&!u.includes('/upload/q_auto,f_jpg'))u=u.replace('/upload/','/upload/q_auto,f_jpg/');}return u;}if(Array.isArray(v))return imageUrl(v[0]);return imageUrl(v.secure_url||v.secureUrl||v.url||v.src||v.path||v.image||v.imageUrl);};
function couponDiscount(coupon,subtotal){
  if(!coupon)return 0;
  const type=String(coupon.type||'PERCENT').toUpperCase();
  let value=0;
  if(['FREE_DELIVERY','FREEDELIVERY','DELIVERY'].includes(type))return 0;
  if(['FIXED','FLAT','AMOUNT'].includes(type)) value=Number(coupon.value||0);
  else value=subtotal*Number(coupon.value||0)/100;
  if(Number(coupon.maxDiscount||0)>0)value=Math.min(value,Number(coupon.maxDiscount));
  return Math.max(0,Math.min(subtotal,Number(value.toFixed(2))));
}
async function findCoupon(code,subtotal,outletId,items){
  const normalized=String(code||'').trim().toUpperCase();
  if(!normalized)return null;
  const now=new Date();
  let c=await Coupon.findOne({code:normalized,active:true,$and:[{$or:[{startAt:null},{startAt:{$exists:false}},{startAt:{$lte:now}}]},{$or:[{endAt:null},{endAt:{$exists:false}},{endAt:{$gte:now}}]}]}).lean();
  if(!c)c=await Offer.findOne({code:normalized,active:true,$and:[{$or:[{startAt:null},{startAt:{$exists:false}},{startAt:{$lte:now}}]},{$or:[{endAt:null},{endAt:{$exists:false}},{endAt:{$gte:now}}]}]}).lean();
  if(!c)throw new AppError('Invalid or expired coupon',409,'INVALID_COUPON');
  if(Number(c.minOrder||0)>subtotal)throw new AppError(`Minimum order value is ₹${Number(c.minOrder)}`,409,'COUPON_MIN_ORDER');
  if(Array.isArray(c.outletIds)&&c.outletIds.length&&!c.outletIds.map(String).includes(String(outletId)))throw new AppError('Coupon is not valid for this outlet',409,'COUPON_OUTLET_MISMATCH');
  if(Array.isArray(c.productIds)&&c.productIds.length&&!items.some(i=>c.productIds.map(String).includes(String(i.productId))))throw new AppError('Coupon is not valid for selected foods',409,'COUPON_PRODUCT_MISMATCH');
  if(Number(c.usageLimit||0)>0&&Number(c.usedCount||0)>=Number(c.usageLimit))throw new AppError('Coupon usage limit reached',409,'COUPON_LIMIT_REACHED');
  return c;
}
async function buildPricing({outletId,items,address,fulfilmentType='DELIVERY',couponCode}){
  const type=String(fulfilmentType||'DELIVERY').toUpperCase();
  if(!['DELIVERY','TAKEAWAY'].includes(type))throw new AppError('Invalid fulfilment type',400,'INVALID_FULFILMENT_TYPE');
  const features=await settings.getBusinessFeatures();
  if(type==='DELIVERY'&&!features.feature_toggles.delivery)throw new AppError('Delivery is currently disabled',409,'DELIVERY_DISABLED');
  if(type==='TAKEAWAY'&&!features.feature_toggles.takeaway)throw new AppError('Takeaway is currently disabled',409,'TAKEAWAY_DISABLED');
  const outlet=await Outlet.findById(outletId).lean();
  if(!outlet||!outlet.active||!outlet.open)throw new AppError('Outlet unavailable',409,'OUTLET_UNAVAILABLE');
  const ids=items.map(x=>x.productId);
  const rows=await OutletProduct.find({outletId,productId:{$in:ids},enabled:true,available:true}).populate('productId').lean();
  const map=new Map(rows.map(x=>[String(x.productId._id),x]));
  let subtotal=0;
  const snapshots=items.map(i=>{
    const r=map.get(String(i.productId));
    const qty=Math.max(1,Number(i.quantity||1));
    if(!r||!r.productId?.active||r.stockQuantity-r.reservedQuantity<qty)throw new AppError('One or more foods are unavailable or out of stock',409,'STOCK_UNAVAILABLE');
    const p=r.productId;
    let price=Number(p.offerPrice>0?p.offerPrice:p.basePrice);
    const selectedSize=String(i.selectedSize||i.selected_size||'').toLowerCase();
    const selectedWeight=String(i.selectedWeight||i.selected_weight||'').toLowerCase().replace(/\s/g,'');
    if(p.variantType==='PIZZA'&&selectedSize&&p.sizePrices?.[selectedSize]!=null)price=Number(p.sizePrices[selectedSize]);
    const weightKey={"500gm":'gm500','500g':'gm500','1kg':'kg1','1.5kg':'kg15','2kg':'kg2'}[selectedWeight];
    if(p.variantType==='CAKE'&&weightKey&&p.weightPrices?.[weightKey]!=null)price=Number(p.weightPrices[weightKey]);
    const customizations=Array.isArray(i.customizations)?i.customizations:[];
    const custom=customizations.reduce((a,c)=>a+Number(c.price||0),0);
    const total=(price+custom)*qty;
    subtotal+=total;
    return{productId:p._id,name:p.name,slug:p.slug,sku:p.sku,image:imageUrl(p.images),quantity:qty,unitPrice:price,offerPrice:price,tax:0,customizations,selectedSize:selectedSize||undefined,selectedWeight:selectedWeight||undefined,finalTotal:Number(total.toFixed(2))};
  });
  const taxSettings=await settings.get('tax');
  const tax=Number((subtotal*Number(taxSettings?.rate||0)/100).toFixed(2));
  let distanceKm=0,delCharge=0;
  if(type==='DELIVERY'){
    if(!address)throw new AppError('Delivery address is required',400,'DELIVERY_ADDRESS_REQUIRED');
    const validation=await deliveryService.checkServiceability({
      outletId,
      latitude:address.latitude,
      longitude:address.longitude,
      pincode:address.pincode||address.zipcode,
      address:address.line1||address.address,
      city:address.city,
      state:address.state
    });
    if(!validation.serviceable)throw new AppError(validation.message||'Address is outside outlet delivery area',409,'OUT_OF_RANGE');
    distanceKm=Number(validation.distanceKm||0);
    const ds=outlet.deliverySettings||await settings.get('delivery')||await settings.get('delivery_settings');
    delCharge=deliveryCharge(distanceKm,ds);
  }
  const coupon=features.feature_toggles.offers?await findCoupon(couponCode,subtotal,outletId,snapshots):null;
  const freeDelivery=coupon&&['FREE_DELIVERY','FREEDELIVERY','DELIVERY'].includes(String(coupon.type||'').toUpperCase());
  if(freeDelivery)delCharge=0;
  const discount=couponDiscount(coupon,subtotal);
  const total=Number(Math.max(0,subtotal-discount+tax+delCharge).toFixed(2));
  const takeawayAdvancePercentage=type==='TAKEAWAY'?Number(features.takeaway.advanceValue||0):0;
  const payableOnlineAmount=type==='TAKEAWAY'?Number((total*takeawayAdvancePercentage/100).toFixed(2)):total;
  const balanceDue=type==='TAKEAWAY'?Number((total-payableOnlineAmount).toFixed(2)):0;
  return{outlet,snapshots,subtotal:Number(subtotal.toFixed(2)),discount,tax,deliveryCharge:delCharge,total,distanceKm,fulfilmentType:type,takeawayAdvancePercentage,payableOnlineAmount,balanceDue,featureToggles:features.feature_toggles,couponCode:coupon?.code||null,coupon:{code:coupon?.code||null,type:coupon?.type||null,value:coupon?.value||0,freeDelivery:Boolean(freeDelivery)}};
}
async function createOrder({customerId,outletId,items,address,fulfilmentType,paymentMethod,clientRequestId,couponCode}){const existing=clientRequestId?await Order.findOne({clientRequestId}):null;if(existing)return existing;const pricing=await buildPricing({outletId,items,address,fulfilmentType,couponCode});const method=String(paymentMethod||'COD').toUpperCase();if(method==='ONLINE'&&!pricing.featureToggles.onlinePayment)throw new AppError('Online payment is currently disabled',409,'ONLINE_PAYMENT_DISABLED');if(method==='COD'&&!pricing.featureToggles.cod)throw new AppError('Cash on delivery is currently disabled',409,'COD_DISABLED');if(pricing.fulfilmentType==='TAKEAWAY'&&pricing.takeawayAdvancePercentage>0&&!pricing.featureToggles.onlinePayment)throw new AppError('Takeaway requires online advance payment, but online payment is disabled',409,'TAKEAWAY_PAYMENT_UNAVAILABLE');if(pricing.fulfilmentType==='TAKEAWAY'&&pricing.takeawayAdvancePercentage>0&&!['ONLINE','TAKEAWAY_ADVANCE'].includes(method))throw new AppError(`Takeaway requires ${pricing.takeawayAdvancePercentage}% online advance payment`,409,'TAKEAWAY_ADVANCE_REQUIRED');const effectiveMethod=pricing.fulfilmentType==='TAKEAWAY'&&pricing.takeawayAdvancePercentage>0?'TAKEAWAY_ADVANCE':method;const requiresOnline=effectiveMethod==='ONLINE'||effectiveMethod==='TAKEAWAY_ADVANCE';const session=await mongoose.startSession();let order;try{await session.withTransaction(async()=>{[order]=await Order.create([{slug:`MB-${Date.now()}-${nanoid(6)}`,clientRequestId,customerId,outletId,items:pricing.snapshots,address,fulfilmentType:pricing.fulfilmentType,paymentMethod:effectiveMethod,paymentStatus:'PENDING',status:requiresOnline?'PENDING_PAYMENT':'RECEIVED',subtotal:pricing.subtotal,discount:pricing.discount,tax:pricing.tax,deliveryCharge:pricing.deliveryCharge,total:pricing.total,payableOnlineAmount:requiresOnline?pricing.payableOnlineAmount:0,paidAmount:0,balanceDue:pricing.fulfilmentType==='TAKEAWAY'?pricing.balanceDue:0,takeawayAdvancePercentage:pricing.takeawayAdvancePercentage,distanceKm:pricing.distanceKm,couponCode:pricing.couponCode,sellerAcceptanceDeadline:new Date(Date.now()+Math.max(1,Number(env.autoCancel.sellerMinutes||30))*60000)}],{session});await inventory.reserve(pricing.snapshots,outletId,order._id,customerId,session,`order:${order._id}`);await OrderEvent.create([{orderId:order._id,previousStatus:null,newStatus:order.status,actorType:'CUSTOMER',actorId:customerId,metadata:{fulfilmentType:pricing.fulfilmentType,takeawayAdvancePercentage:pricing.takeawayAdvancePercentage,payableOnlineAmount:requiresOnline?pricing.payableOnlineAmount:0,balanceDue:pricing.balanceDue,coupon:pricing.coupon},idempotencyKey:`order:${order._id}:created`}],{session});});}finally{await session.endSession();}return order;}
async function changeStatus(order,user,nextStatus,reason,idempotencyKey){const next=canonical(nextStatus),prev=canonical(order.status);if(prev===next)return order;if(!(transitions[prev]||[]).includes(next))throw new AppError(`Invalid transition ${prev} -> ${next}`,409,'INVALID_STATUS_TRANSITION');const session=await mongoose.startSession();await session.withTransaction(async()=>{order.status=next;if(next==='ACCEPTED')order.acceptedAt=new Date();if(next==='READY'){order.readyAt=new Date();order.riderAcceptanceDeadline=new Date(Date.now()+Math.max(1,Number(env.autoCancel.riderMinutes||30))*60000);}if(next==='PICKED_UP'){order.pickedUpAt=new Date();order.riderAcceptanceDeadline=null;}if(next==='DELIVERED'){order.deliveredAt=new Date();await inventory.consume(order.items,order.outletId,order._id,user.id,session,`order:${order._id}`);if(order.riderId){const rate=Number((await settings.get('rider'))?.perKmRate||(await settings.get('rider_settings'))?.perKmRate||0);await RiderEarning.updateOne({orderId:order._id},{$setOnInsert:{riderId:order.riderId,orderId:order._id,outletId:order.outletId,distanceKm:order.distanceKm,ratePerKm:rate,amount:Number((order.distanceKm*rate).toFixed(2)),status:'PENDING'}},{upsert:true,session});}}if(['CANCELLED','REJECTED','PAYMENT_FAILED'].includes(next)){order.cancelledAt=new Date();order.cancellationReason=reason;await inventory.release(order.items,order.outletId,order._id,user.id,session,`order:${order._id}`);if(order.paymentStatus==='SUCCESS'){const payment=await Payment.findOne({orderId:order._id,status:'SUCCESS'}).session(session);if(payment){await Refund.updateOne({orderId:order._id,paymentId:payment._id},{$setOnInsert:{customerId:order.customerId,outletId:order.outletId,amount:payment.amount,cancellationReason:reason,status:'PENDING'}},{upsert:true,session});order.refundStatus='PENDING';}}}await order.save({session});await OrderEvent.create([{orderId:order._id,previousStatus:prev,newStatus:next,actorType:user.role,actorId:user.id,reason,idempotencyKey:idempotencyKey||`order:${order._id}:${prev}:${next}`}],{session});});await session.endSession();return order;}
module.exports={buildPricing,createOrder,changeStatus,canonical,transitions};
