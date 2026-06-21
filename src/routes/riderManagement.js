const express = require('express');
const ah = require('../utils/asyncHandler');
const { ok } = require('../utils/respond');
const { requireAuth, allowRoles } = require('../middleware/auth');
const { AppError } = require('../utils/errors');
const { findOneCompat } = require('../utils/compatId');
const settings = require('../services/settingsService');
const {
  User, Order, RiderLocation, RiderEarning, RiderCashTransaction,
  RiderPayout, VerificationRequest, Notification,
} = require('../models');

const router = express.Router();
const VERIFIED = new Set(['VERIFIED','APPROVED','ACTIVE']);

function pointDistanceKm(aLat, aLng, bLat, bLng) {
  const rad = (v) => v * Math.PI / 180;
  const dLat = rad(bLat-aLat); const dLng = rad(bLng-aLng);
  const x = Math.sin(dLat/2)**2 + Math.cos(rad(aLat))*Math.cos(rad(bLat))*Math.sin(dLng/2)**2;
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
}

async function riderSettings() {
  const value = await settings.get('rider');
  return {
    assignmentRadiusKm: Number(value?.assignmentRadiusKm ?? value?.deliveryOfferRadiusKm ?? 8),
    perKmRate: Number(value?.perKmRate ?? value?.earningsPerKm ?? 0),
    minimumDeliveryPay: Number(value?.minimumDeliveryPay ?? 0),
  };
}

async function cashSummary(riderId) {
  const rows = await RiderCashTransaction.aggregate([
    { $match: { riderId, status: 'CONFIRMED' } },
    { $group: { _id: '$type', total: { $sum: '$amount' } } },
  ]);
  const collected = Number(rows.find(x => x._id === 'COLLECTED')?.total || 0);
  const deposited = Number(rows.find(x => ['DEPOSIT','ADMIN_CASH_CONFIRMED'].includes(x._id))?.total || 0);
  return { collected, deposited, outstanding: Math.max(0, Number((collected-deposited).toFixed(2))) };
}

async function earningSummary(riderId) {
  const rows = await RiderEarning.aggregate([
    { $match: { riderId } },
    { $group: { _id: '$status', total: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);
  const pending = Number(rows.find(x => x._id === 'PENDING')?.total || 0);
  const paid = Number(rows.find(x => x._id === 'PAID')?.total || 0);
  return { pending, paid, total: pending+paid };
}

async function serializeRider(rider) {
  const [cash, earnings, delivered, latestLocation, verification, payouts] = await Promise.all([
    cashSummary(rider._id), earningSummary(rider._id),
    Order.countDocuments({ riderId:rider._id, status:'DELIVERED' }),
    RiderLocation.findOne({ riderId:rider._id }).sort({ recordedAt:-1 }),
    VerificationRequest.findOne({ userId:rider._id, type:'RIDER' }).sort({ createdAt:-1 }),
    RiderPayout.find({ riderId:rider._id }).sort({ createdAt:-1 }).limit(20),
  ]);
  const profile = rider.riderProfile || {};
  return {
    profileId:rider.legacyId, driverId:rider.legacyId, mongoId:String(rider._id), userId:String(rider._id),
    driverName:rider.name, driverEmail:rider.email, driverMobile:rider.phone,
    online:Boolean(profile.online), available:Boolean(profile.available), blocked:!rider.active,
    verified:VERIFIED.has(String(profile.verificationStatus||'').toUpperCase()),
    verificationStatus:profile.verificationStatus || 'UNVERIFIED', verificationRequestId:verification?._id,
    verificationRequest:verification ? { id:String(verification._id), status:verification.status, documents:(verification.documents||[]).map(d=>({url:d.url,publicId:d.publicId,alt:d.alt,downloadUrl:d.url})), note:verification.note, createdAt:verification.createdAt, reviewedAt:verification.reviewedAt } : null,
    totalDeliveries:delivered, totalEarnings:earnings.total, pendingPayout:earnings.pending, paidEarnings:earnings.paid,
    cashInHand:cash.outstanding, totalCashCollected:cash.collected, totalCashDeposited:cash.deposited,
    cashLimit:Number(profile.cashLimit||0), rating:Number(profile.rating||0),
    upiId:profile.payoutAccount?.upiId || '', payoutAccount:profile.payoutAccount || {},
    latestLocation: latestLocation ? { latitude:latestLocation.location?.coordinates?.[1], longitude:latestLocation.location?.coordinates?.[0], recordedAt:latestLocation.recordedAt } : null,
    payouts:payouts.map(p => ({ id:String(p._id), amount:p.amount,status:p.status,periodStart:p.periodStart,periodEnd:p.periodEnd,upiId:p.upiId,paymentReference:p.paymentReference,paidAt:p.paidAt,note:p.note })),
  };
}

router.get(['/admin/delivery-boys','/admin/riders','/admin/drivers'], requireAuth, allowRoles('ADMIN'), ah(async(req,res)=>{
  const page=Math.max(1,Number(req.query.page||1)); const limit=Math.min(100,Math.max(1,Number(req.query.perPage||req.query.per_page||20)));
  const search=String(req.query.search||'').trim();
  const q={role:'RIDER'}; if(search) q.$or=[{name:new RegExp(search,'i')},{email:new RegExp(search,'i')},{phone:new RegExp(search,'i')}];
  const [rows,total]=await Promise.all([User.find(q).sort({createdAt:-1}).skip((page-1)*limit).limit(limit),User.countDocuments(q)]);
  ok(res,{items:await Promise.all(rows.map(serializeRider)),page,perPage:limit,per_page:limit,total,totalPages:Math.max(1,Math.ceil(total/limit)),total_pages:Math.max(1,Math.ceil(total/limit))});
}));

router.get('/admin/drivers/:id', requireAuth, allowRoles('ADMIN'), ah(async(req,res)=>{
  const rider=await findOneCompat(User,req.params.id,{role:'RIDER'}); if(!rider) throw new AppError('Rider not found',404,'RIDER_NOT_FOUND');
  const orders=await Order.find({riderId:rider._id}).sort({createdAt:-1}).limit(100).populate('outletId customerId');
  const data=await serializeRider(rider);
  data.orders=orders.map(o=>({id:o.legacyId,orderNumber:o.slug,status:o.status,total:o.total,paymentMethod:o.paymentMethod,paymentStatus:o.paymentStatus,distanceKm:o.distanceKm,outletName:o.outletId?.name,customerName:o.customerId?.name,deliveredAt:o.deliveredAt,createdAt:o.createdAt}));
  ok(res,data);
}));

router.patch('/admin/drivers/:id/verification', requireAuth, allowRoles('ADMIN'), ah(async(req,res)=>{
  const rider=await findOneCompat(User,req.params.id,{role:'RIDER'}); if(!rider) throw new AppError('Rider not found',404);
  const status=String(req.query.status||req.body.status||'').toUpperCase();
  if(!['VERIFIED','APPROVED','UNVERIFIED','REJECTED'].includes(status)) throw new AppError('Invalid verification status',400);
  rider.riderProfile.verificationStatus=status; rider.riderProfile.online=false; rider.riderProfile.available=false; await rider.save();
  const vr=await VerificationRequest.findOne({userId:rider._id,type:'RIDER'}).sort({createdAt:-1}); if(vr){vr.status=status;vr.reviewedBy=req.user.id;vr.reviewedAt=new Date();await vr.save();}
  await Notification.create({userId:rider._id,role:'RIDER',title:status==='VERIFIED'?'Verification approved':'Verification updated',message:status==='VERIFIED'?'Your rider account is verified. Add your UPI ID before monthly payout.':`Your verification status is ${status}.`,type:'RIDER_VERIFICATION',data:{status}});
  ok(res,await serializeRider(rider),'Rider verification updated');
}));
router.post('/admin/drivers/:id/approve', requireAuth, allowRoles('ADMIN'), (req,res,next)=>{req.query.status='VERIFIED';next();}, ah(async(req,res)=>{
  const rider=await findOneCompat(User,req.params.id,{role:'RIDER'}); if(!rider) throw new AppError('Rider not found',404); rider.riderProfile.verificationStatus='VERIFIED'; await rider.save();
  const vr=await VerificationRequest.findOne({userId:rider._id,type:'RIDER'}).sort({createdAt:-1}); if(vr){vr.status='VERIFIED';vr.reviewedBy=req.user.id;vr.reviewedAt=new Date();await vr.save();}
  await Notification.create({userId:rider._id,role:'RIDER',title:'Verification approved',message:'Your rider verification has been approved. Add your UPI ID for payouts.',type:'RIDER_VERIFICATION'});
  ok(res,await serializeRider(rider));
}));
router.post('/admin/drivers/:id/reject', requireAuth, allowRoles('ADMIN'), ah(async(req,res)=>{
  const rider=await findOneCompat(User,req.params.id,{role:'RIDER'}); if(!rider) throw new AppError('Rider not found',404); rider.riderProfile.verificationStatus='REJECTED'; rider.riderProfile.online=false;rider.riderProfile.available=false;await rider.save();
  const vr=await VerificationRequest.findOne({userId:rider._id,type:'RIDER'}).sort({createdAt:-1});if(vr){vr.status='REJECTED';vr.note=[vr.note,req.body.reason].filter(Boolean).join('\n');vr.reviewedBy=req.user.id;vr.reviewedAt=new Date();await vr.save();}
  await Notification.create({userId:rider._id,role:'RIDER',title:'Verification needs attention',message:req.body.reason||'Your verification was rejected. Please resubmit valid documents.',type:'RIDER_VERIFICATION'});
  ok(res,await serializeRider(rider));
}));

router.post('/admin/drivers/:id/cash-deposit/verify', requireAuth, allowRoles('ADMIN'), ah(async(req,res)=>{
  const rider=await findOneCompat(User,req.params.id,{role:'RIDER'}); if(!rider) throw new AppError('Rider not found',404);
  const summary=await cashSummary(rider._id); const amount=Number(req.body.amount);
  if(!Number.isFinite(amount)||amount<=0) throw new AppError('Valid collected cash amount is required',400,'INVALID_AMOUNT');
  if(amount>summary.outstanding+0.01) throw new AppError('Amount exceeds rider cash in hand',409,'AMOUNT_EXCEEDS_OUTSTANDING');
  await RiderCashTransaction.create({riderId:rider._id,type:'ADMIN_CASH_CONFIRMED',amount,paymentMethod:req.body.paymentMethod||'CASH',paymentReference:req.body.paymentReference,note:req.body.note||'Cash received and confirmed by admin',status:'CONFIRMED'});
  await Notification.create({userId:rider._id,role:'RIDER',title:'Cash collection settled',message:`Admin confirmed receipt of ₹${amount.toFixed(2)} collected cash.`,type:'RIDER_CASH_SETTLEMENT',data:{amount}});
  ok(res,await serializeRider(rider),'Collected cash confirmed');
}));
router.get('/admin/drivers/:id/cash-transactions', requireAuth, allowRoles('ADMIN'), ah(async(req,res)=>{
  const rider=await findOneCompat(User,req.params.id,{role:'RIDER'});if(!rider) throw new AppError('Rider not found',404);
  const rows=await RiderCashTransaction.find({riderId:rider._id}).sort({createdAt:-1}).populate('orderId');
  ok(res,{items:rows.map(x=>({id:x.legacyId,type:x.type,amount:x.amount,status:x.status,note:x.note,paymentReference:x.paymentReference,orderNumber:x.orderId?.slug,createdAt:x.createdAt}))});
}));

router.post('/admin/drivers/:id/payout', requireAuth, allowRoles('ADMIN'), ah(async(req,res)=>{
  const rider=await findOneCompat(User,req.params.id,{role:'RIDER'});if(!rider) throw new AppError('Rider not found',404);
  const upiId=String(req.body.upiId||rider.riderProfile?.payoutAccount?.upiId||'').trim(); if(!upiId) throw new AppError('Rider UPI ID is required before payout',409,'UPI_ID_REQUIRED');
  const earningIds=(await RiderEarning.find({riderId:rider._id,status:'PENDING'}).select('_id amount')).map(x=>x._id);
  const earnings=await RiderEarning.find({_id:{$in:earningIds}}); const available=earnings.reduce((s,x)=>s+Number(x.amount||0),0);
  const amount=Number(req.body.amount??available); if(!Number.isFinite(amount)||amount<=0) throw new AppError('No payable rider earnings',409,'NO_PENDING_PAYOUT');
  if(amount>available+0.01) throw new AppError('Payout exceeds pending rider earnings',409,'PAYOUT_EXCEEDS_PENDING');
  let remaining=amount; const selected=[]; for(const e of earnings){if(remaining<=0) break; if(Number(e.amount||0)<=remaining+0.01){selected.push(e);remaining-=Number(e.amount||0);}}
  if(Math.abs(remaining)>0.01) throw new AppError('Payout must match complete delivery earning entries',409,'PARTIAL_EARNING_NOT_SUPPORTED');
  const now=new Date(); const periodStart=req.body.periodStart?new Date(req.body.periodStart):new Date(now.getFullYear(),now.getMonth(),1); const periodEnd=req.body.periodEnd?new Date(req.body.periodEnd):now;
  const payout=await RiderPayout.create({riderId:rider._id,periodStart,periodEnd,amount,upiId,paymentMethod:'UPI',paymentReference:req.body.paymentReference,status:'PAID',earningIds:selected.map(x=>x._id),paidBy:req.user.id,paidAt:now,note:req.body.note||'Rider payout approved by admin'});
  await RiderEarning.updateMany({_id:{$in:selected.map(x=>x._id)}},{$set:{status:'PAID',settledAt:now,payoutId:payout._id}});
  await Notification.create({userId:rider._id,role:'RIDER',title:'Rider payout completed',message:`₹${amount.toFixed(2)} was paid to ${upiId}.`,type:'RIDER_PAYOUT',data:{payoutId:payout._id,amount,upiId,paymentReference:payout.paymentReference}});
  ok(res,await serializeRider(rider),'Rider payout recorded');
}));

router.post('/admin/drivers/:id/request-upi', requireAuth, allowRoles('ADMIN'), ah(async(req,res)=>{
  const rider=await findOneCompat(User,req.params.id,{role:'RIDER'});if(!rider) throw new AppError('Rider not found',404);
  rider.riderProfile.upiReminderSentAt=new Date();await rider.save();
  await Notification.create({userId:rider._id,role:'RIDER',title:'UPI ID required for payout',message:req.body.message||'Please submit or verify your UPI ID to receive this month’s rider payout.',type:'RIDER_UPI_REQUIRED'});
  ok(res,{sent:true},'UPI reminder sent');
}));

router.get(['/rider/finance/summary','/delivery/finance/summary'], requireAuth, allowRoles('RIDER'), ah(async(req,res)=>{
  const rider=await User.findById(req.user.id); if(!rider) throw new AppError('Rider not found',404);
  const [cash,earnings,payouts]=await Promise.all([cashSummary(rider._id),earningSummary(rider._id),RiderPayout.find({riderId:rider._id}).sort({createdAt:-1}).limit(50)]);
  ok(res,{cash,earnings,upiId:rider.riderProfile?.payoutAccount?.upiId||'',payouts:payouts.map(p=>({id:String(p._id),amount:p.amount,status:p.status,upiId:p.upiId,paymentReference:p.paymentReference,paidAt:p.paidAt,periodStart:p.periodStart,periodEnd:p.periodEnd}))});
}));

router.get(['/rider/navigation/:orderId','/delivery/navigation/:orderId'], requireAuth, allowRoles('RIDER'), ah(async(req,res)=>{
  const rider=await User.findById(req.user.id); const order=await findOneCompat(Order,req.params.orderId,{riderId:rider._id}); if(!order) throw new AppError('Assigned order not found',404);
  await order.populate('outletId'); const [lng,lat]=order.outletId?.location?.coordinates||[0,0]; const dlat=Number(order.address?.latitude||0),dlng=Number(order.address?.longitude||0);
  const current=await RiderLocation.findOne({riderId:rider._id}).sort({recordedAt:-1}); const clat=current?.location?.coordinates?.[1]||lat,clng=current?.location?.coordinates?.[0]||lng;
  const destination=order.status==='RIDER_ASSIGNED'?{latitude:lat,longitude:lng,label:'Outlet pickup'}:{latitude:dlat,longitude:dlng,label:'Customer delivery'};
  const origin={latitude:clat,longitude:clng};
  const googleMapsUrl=`https://www.google.com/maps/dir/?api=1&origin=${origin.latitude},${origin.longitude}&destination=${destination.latitude},${destination.longitude}&travelmode=driving`;
  let route=null; const maps=await settings.get('googleMaps'); const key=maps?.apiKey||maps?.key;
  if(key&&origin.latitude&&origin.longitude&&destination.latitude&&destination.longitude){
    try{const url=`https://maps.googleapis.com/maps/api/directions/json?origin=${origin.latitude},${origin.longitude}&destination=${destination.latitude},${destination.longitude}&mode=driving&key=${encodeURIComponent(key)}`;const response=await fetch(url);const json=await response.json();const r=json.routes?.[0];const leg=r?.legs?.[0];if(r&&leg)route={polyline:r.overview_polyline?.points,distanceText:leg.distance?.text,distanceMeters:leg.distance?.value,durationText:leg.duration?.text,durationSeconds:leg.duration?.value,steps:leg.steps?.map(s=>({instruction:String(s.html_instructions||'').replace(/<[^>]+>/g,''),distance:s.distance?.text,duration:s.duration?.text,endLocation:s.end_location}))};}catch(_e){}
  }
  ok(res,{origin,destination,googleMapsUrl,route,mapsConfigured:Boolean(key)});
}));

router.get(['/rider/orders/available-in-range','/delivery/orders/available-in-range'], requireAuth, allowRoles('RIDER'), ah(async(req,res)=>{
  const rider=await User.findById(req.user.id); if(!rider) throw new AppError('Rider not found',404);
  if(!VERIFIED.has(String(rider.riderProfile?.verificationStatus||'').toUpperCase())) throw new AppError('Rider verification required',409,'RIDER_NOT_VERIFIED');
  const latest=await RiderLocation.findOne({riderId:rider._id}).sort({recordedAt:-1}); if(!latest) throw new AppError('Update current location to receive nearby orders',409,'RIDER_LOCATION_REQUIRED');
  const cfg=await riderSettings(); const [lng,lat]=latest.location.coordinates;
  const rows=await Order.find({status:{$in:['READY','RIDER_ASSIGNMENT_PENDING']},riderId:null,fulfilmentType:'DELIVERY'}).populate('outletId customerId').sort({readyAt:1}).limit(100);
  const items=rows.map(o=>{const [olng,olat]=o.outletId?.location?.coordinates||[0,0];const pickupDistanceKm=pointDistanceKm(lat,lng,olat,olng);const deliveryDistanceKm=Number(o.distanceKm||0);const earning=Math.max(cfg.minimumDeliveryPay,Number((deliveryDistanceKm*cfg.perKmRate).toFixed(2)));return {id:o.legacyId,mongoId:String(o._id),orderNumber:o.slug,pickupDistanceKm,deliveryDistanceKm,assignmentRadiusKm:cfg.assignmentRadiusKm,riderEarning:earning,ratePerKm:cfg.perKmRate,paymentMethod:o.paymentMethod,paymentStatus:o.paymentStatus,amountToCollect:o.paymentMethod==='COD'?Number(o.balanceDue>0?o.balanceDue:o.total||0):0,prepaid:o.paymentMethod!=='COD'||o.paymentStatus==='PAID',outlet:{name:o.outletId?.name,latitude:olat,longitude:olng},customer:{name:o.customerId?.name,phone:o.customerId?.phone},withinRange:pickupDistanceKm<=cfg.assignmentRadiusKm};}).filter(x=>x.withinRange);
  ok(res,items);
}));

module.exports=router;
