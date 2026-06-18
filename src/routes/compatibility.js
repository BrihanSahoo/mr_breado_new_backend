const r=require('express').Router();
const ah=require('../utils/asyncHandler');
const {ok}=require('../utils/respond');
const {requireAuth,allowRoles}=require('../middleware/auth');
const {User,Outlet,Order,Brand,Banner,Offer,Coupon,Review,WalletTransaction,SupportTicket,VerificationRequest,Notification,Product}=require('../models');
const {haversineKm}=require('../utils/geo');
const {AppError}=require('../utils/errors');

r.get(['/delivery/distance','/delivery/validate','/orders/validate-delivery','/restaurants/:id/delivery-check'],ah(async(req,res)=>{
  const outletId=req.params.id||req.query.outletId||req.body?.outletId;
  const outlet=await Outlet.findById(outletId).lean();
  if(!outlet)throw new AppError('Outlet not found',404);
  const lat=Number(req.query.latitude||req.query.lat),lng=Number(req.query.longitude||req.query.lng);
  if(!Number.isFinite(lat)||!Number.isFinite(lng))throw new AppError('Latitude and longitude are required');
  const [oLng,oLat]=outlet.location.coordinates;
  const distanceKm=Number(haversineKm(oLat,oLng,lat,lng).toFixed(2));
  ok(res,{distanceKm,deliveryRadiusKm:outlet.deliveryRadiusKm,serviceable:distanceKm<=outlet.deliveryRadiusKm});
}));

r.use(requireAuth);
r.get('/user/addresses',ah(async(req,res)=>ok(res,(await User.findById(req.user.id).lean())?.addresses||[])));
r.post('/user/addresses',ah(async(req,res)=>{const u=await User.findById(req.user.id);if(req.body.isDefault)u.addresses.forEach(a=>a.isDefault=false);u.addresses.push(req.body);await u.save();ok(res,u.addresses.at(-1),'Address added',201)}));
r.put('/user/addresses/:id',ah(async(req,res)=>{const u=await User.findById(req.user.id);const a=u.addresses.id(req.params.id);if(!a)throw new AppError('Address not found',404);Object.assign(a,req.body);if(req.body.isDefault)u.addresses.forEach(x=>x._id.equals(a._id)||(x.isDefault=false));await u.save();ok(res,a,'Address updated')}));
r.delete('/user/addresses/:id',ah(async(req,res)=>{const u=await User.findById(req.user.id);u.addresses.id(req.params.id)?.deleteOne();await u.save();ok(res,null,'Address deleted')}));
r.patch('/user/addresses/:id/default',ah(async(req,res)=>{const u=await User.findById(req.user.id);let found=false;u.addresses.forEach(a=>{a.isDefault=String(a._id)===req.params.id;if(a.isDefault)found=true});if(!found)throw new AppError('Address not found',404);await u.save();ok(res,u.addresses.find(a=>a.isDefault),'Default address updated')}));

r.get('/wallet',ah(async(req,res)=>{const u=await User.findById(req.user.id).lean();ok(res,{balance:u.walletBalance||0,rewardPoints:u.rewardPoints||0})}));
r.get('/wallet/transactions',ah(async(req,res)=>ok(res,await WalletTransaction.find({userId:req.user.id}).sort({createdAt:-1}).lean())));

r.get('/favorites',ah(async(req,res)=>{const u=await User.findById(req.user.id).populate('favoriteProductIds');ok(res,u.favoriteProductIds)}));
r.post('/favorites/:productId',ah(async(req,res)=>{await User.updateOne({_id:req.user.id},{$addToSet:{favoriteProductIds:req.params.productId}});ok(res,null,'Added to favorites')}));
r.delete('/favorites/:productId',ah(async(req,res)=>{await User.updateOne({_id:req.user.id},{$pull:{favoriteProductIds:req.params.productId}});ok(res,null,'Removed from favorites')}));

r.get('/reviews',ah(async(req,res)=>ok(res,await Review.find(req.query.outletId?{outletId:req.query.outletId}:{customerId:req.user.id}).populate('customerId productId outletId').sort({createdAt:-1}).lean())));
r.get('/support/tickets',ah(async(req,res)=>ok(res,await SupportTicket.find({userId:req.user.id}).sort({createdAt:-1}).lean())));
r.post('/support/tickets',ah(async(req,res)=>ok(res,await SupportTicket.create({userId:req.user.id,subject:req.body.subject,message:req.body.message,priority:req.body.priority}),'Ticket created',201)));

r.get('/notifications/settings',ah(async(req,res)=>ok(res,{push:true,email:true,sms:false})));
r.put('/notifications/settings',ah(async(req,res)=>ok(res,req.body,'Notification settings updated')));

r.get(['/delivery/profile','/rider/profile'],allowRoles('RIDER','ADMIN'),ah(async(req,res)=>ok(res,req.user)));
r.get(['/delivery/orders/:id','/rider/orders/:id'],allowRoles('RIDER','ADMIN'),ah(async(req,res)=>{const q={_id:req.params.id};if(req.user.role==='RIDER')q.riderId=req.user.id;ok(res,await Order.findOne(q).populate('outletId customerId'))}));
r.get(['/delivery/cash/summary','/rider/cash/summary'],allowRoles('RIDER','ADMIN'),ah(async(req,res)=>ok(res,{collected:0,deposited:0,pending:0})));

r.post(['/seller/verification/request','/rider/verification/request'],allowRoles('SELLER','RIDER'),ah(async(req,res)=>ok(res,await VerificationRequest.create({userId:req.user.id,outletId:req.body.outletId,type:req.user.role,documents:req.body.documents||[],note:req.body.note}),'Verification submitted',201)));
r.get(['/seller/verification/status','/rider/verification/status'],allowRoles('SELLER','RIDER'),ah(async(req,res)=>ok(res,await VerificationRequest.findOne({userId:req.user.id}).sort({createdAt:-1}).lean())));

r.use('/admin',allowRoles('ADMIN'));
function adminPayload(path,body){const out={...body};const raw=body.imageUrl||body.image_url||body.image||body.banner||body.bannerImage;if(raw)out.image=typeof raw==='string'?{url:raw}:raw;if(path==='offers'||path==='coupons'){if(out.code)out.code=String(out.code).trim().toUpperCase();if(out.startDate&&!out.startAt)out.startAt=out.startDate;if(out.endDate&&!out.endAt)out.endAt=out.endDate;if(out.freeDelivery===true&&!out.type)out.type='FREE_DELIVERY';}if(path==='banners'&&(out.couponCode||out.code)){out.actionType='COUPON';out.actionValue=out.couponCode||out.code;}return out;}
function adminOut(doc){const raw=doc?.toObject?doc.toObject():doc;if(!raw)return raw;const image=typeof raw.image==='string'?raw.image:(raw.image?.secure_url||raw.image?.secureUrl||raw.image?.url||raw.image?.src||'');const code=String(raw.code||(raw.actionType==='COUPON'?raw.actionValue:'')||'').toUpperCase();return{...raw,id:String(raw._id),image,imageUrl:image,image_url:image,banner:image,bannerImage:image,couponCode:code,coupon_code:code,code};}
for (const [path,Model] of [['brands',Brand],['banners',Banner],['offers',Offer],['coupons',Coupon]]) {
  r.get(`/admin/${path}`,ah(async(req,res)=>ok(res,(await Model.find().sort({createdAt:-1}).lean()).map(adminOut))));
  r.post(`/admin/${path}`,ah(async(req,res)=>ok(res,adminOut(await Model.create(adminPayload(path,req.body))),`${path.slice(0,-1)} created`,201)));
  r.put(`/admin/${path}/:id`,ah(async(req,res)=>ok(res,adminOut(await Model.findByIdAndUpdate(req.params.id,adminPayload(path,req.body),{new:true,runValidators:true})))));
  r.delete(`/admin/${path}/:id`,ah(async(req,res)=>{await Model.findByIdAndDelete(req.params.id);ok(res,null,'Deleted')}));
}
r.get('/admin/users',ah(async(req,res)=>ok(res,await User.find(req.query.role?{role:req.query.role}:{}).select('-passwordHash').sort({createdAt:-1}).lean())));
r.get('/admin/support/tickets',ah(async(req,res)=>ok(res,await SupportTicket.find().populate('userId').sort({createdAt:-1}).lean())));
r.patch('/admin/support/tickets/:id',ah(async(req,res)=>ok(res,await SupportTicket.findByIdAndUpdate(req.params.id,req.body,{new:true}))));
r.get('/admin/verifications',ah(async(req,res)=>ok(res,await VerificationRequest.find(req.query.status?{status:req.query.status}:{}).populate('userId outletId').sort({createdAt:-1}).lean())));
r.patch('/admin/verifications/:id',ah(async(req,res)=>ok(res,await VerificationRequest.findByIdAndUpdate(req.params.id,{$set:{status:req.body.status,note:req.body.note,reviewedBy:req.user.id,reviewedAt:new Date()}},{new:true}))));
r.post(['/admin/notifications/send','/admin/notifications/send-all'],ah(async(req,res)=>{const users=req.body.userIds?.length?await User.find({_id:{$in:req.body.userIds}}).select('_id role assignedOutletIds'):await User.find(req.body.role?{role:req.body.role}:{}).select('_id role assignedOutletIds');const docs=users.map(u=>({userId:u._id,role:u.role,title:req.body.title,message:req.body.message,type:req.body.type||'ADMIN',data:req.body.data}));if(docs.length)await Notification.insertMany(docs);ok(res,{sent:docs.length},'Notifications created')}));

module.exports=r;
