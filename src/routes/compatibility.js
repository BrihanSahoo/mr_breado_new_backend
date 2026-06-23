const r=require('express').Router();
const ah=require('../utils/asyncHandler');
const {ok}=require('../utils/respond');
const {requireAuth,allowRoles}=require('../middleware/auth');
const {User,Outlet,Order,Brand,Cuisine,Banner,Offer,Coupon,Review,WalletTransaction,SupportTicket,VerificationRequest,Notification,Product}=require('../models');
const {haversineKm}=require('../utils/geo');
const {AppError}=require('../utils/errors');
const multer=require('multer');const {v2:cloudinary}=require('cloudinary');
const mediaUpload=multer({storage:multer.memoryStorage(),limits:{fileSize:5*1024*1024},fileFilter:(_r,f,cb)=>cb(null,/^image\/(jpeg|png|webp|gif)$/.test(f.mimetype))});
async function cloudUpload(file,folder){if(!file)return null;if(!process.env.CLOUDINARY_CLOUD_NAME||!process.env.CLOUDINARY_API_KEY||!process.env.CLOUDINARY_API_SECRET)throw new AppError('Cloudinary configuration is required',503);cloudinary.config({cloud_name:process.env.CLOUDINARY_CLOUD_NAME,api_key:process.env.CLOUDINARY_API_KEY,api_secret:process.env.CLOUDINARY_API_SECRET});const result=await cloudinary.uploader.upload(`data:${file.mimetype};base64,${file.buffer.toString('base64')}`,{folder:`mr-breado/${folder}`,resource_type:'image'});return{url:result.secure_url,publicId:result.public_id,alt:file.originalname};}
const arrayField=(v)=>{if(Array.isArray(v))return v;try{return v?JSON.parse(v):[]}catch{return String(v||'').split(',').map(x=>x.trim()).filter(Boolean)}};
const boolField=(v,d=true)=>v===undefined?d:!['false','0','off'].includes(String(v).toLowerCase());

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
for (const [path,Model] of [['brands',Brand],['banners',Banner]]) {
  r.get(`/admin/${path}`,ah(async(req,res)=>ok(res,(await Model.find().sort({createdAt:-1}).lean()).map(adminOut))));
  r.post(`/admin/${path}`,ah(async(req,res)=>ok(res,adminOut(await Model.create(adminPayload(path,req.body))),`${path.slice(0,-1)} created`,201)));
  r.put(`/admin/${path}/:id`,ah(async(req,res)=>ok(res,adminOut(await Model.findByIdAndUpdate(req.params.id,adminPayload(path,req.body),{new:true,runValidators:true})))));
  r.delete(`/admin/${path}/:id`,ah(async(req,res)=>{await Model.findByIdAndDelete(req.params.id);ok(res,null,'Deleted')}));
}

function promoPayload(body,image,kind){const code=String(body.code||body.couponCode||'').trim().toUpperCase();const all=boolField(body.appliesToAllOutlets,!(arrayField(body.outletIds).length));return{title:body.title||'',description:body.description||'',...(image?{image}:{}),...(code?{code}:{}),campaignType:kind==='offer'?(body.campaignType||(code?'COUPON_OFFER':'BANNER')):undefined,type:body.type||body.discountType||'PERCENT',value:Number(body.value??body.discountValue??0),minOrder:Number(body.minOrder??body.minOrderAmount??0),maxDiscount:Number(body.maxDiscount??body.maxDiscountAmount??0),usageLimit:Number(body.usageLimit||0),perUserLimit:Number(body.perUserLimit||0),startAt:body.startAt||body.startsAt||body.validFrom||null,endAt:body.endAt||body.expiresAt||body.endsAt||body.validTo||null,active:boolField(body.active??body.enabled,true),appliesToAllOutlets:all,outletIds:all?[]:arrayField(body.outletIds),productIds:arrayField(body.productIds),paymentMethods:arrayField(body.paymentMethods),fulfilmentTypes:arrayField(body.fulfilmentTypes),eligibleCustomerIds:arrayField(body.eligibleCustomerIds)};}

// Real cuisine CRUD backed by MongoDB + Cloudinary. No synthetic restaurant-derived rows.
const cuisineOut=(doc)=>{const raw=doc?.toObject?doc.toObject():doc;if(!raw)return raw;const image=typeof raw.image==='string'?raw.image:(raw.image?.url||raw.image?.secure_url||'');return{...raw,id:String(raw._id),title:raw.name,image,imageUrl:image,img:image,status:raw.active?'Active':'Inactive'};};
r.get('/admin/cuisines',ah(async(req,res)=>ok(res,(await Cuisine.find().sort({sortOrder:1,name:1}).lean()).map(cuisineOut))));
r.post('/admin/cuisines',mediaUpload.single('image'),ah(async(req,res)=>{const name=String(req.body.name||req.body.title||'').trim();if(!name)throw new AppError('Cuisine name is required',400,'CUISINE_NAME_REQUIRED');const image=await cloudUpload(req.file,'cuisines');const slug=String(req.body.slug||name).trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');const doc=await Cuisine.create({name,slug,image:image||null,description:req.body.description||'',active:boolField(req.body.active??req.body.status!=='Inactive',true),sortOrder:Number(req.body.sortOrder||0)});ok(res,cuisineOut(doc),'Cuisine created',201)}));
r.put('/admin/cuisines/:id',mediaUpload.single('image'),ah(async(req,res)=>{const existing=await Cuisine.findById(req.params.id);if(!existing)throw new AppError('Cuisine not found',404);const image=await cloudUpload(req.file,'cuisines');if(req.body.name!==undefined)existing.name=String(req.body.name).trim();if(req.body.slug!==undefined||req.body.name!==undefined)existing.slug=String(req.body.slug||existing.name).trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');if(req.body.description!==undefined)existing.description=req.body.description;if(req.body.active!==undefined||req.body.status!==undefined)existing.active=boolField(req.body.active??req.body.status==='Active',true);if(req.body.sortOrder!==undefined)existing.sortOrder=Number(req.body.sortOrder||0);if(image)existing.image=image;await existing.save();ok(res,cuisineOut(existing),'Cuisine updated')}));
r.patch('/admin/cuisines/:id/status',ah(async(req,res)=>{const active=boolField(req.body.active??req.body.status==='Active',true);const doc=await Cuisine.findByIdAndUpdate(req.params.id,{$set:{active}},{new:true});if(!doc)throw new AppError('Cuisine not found',404);ok(res,cuisineOut(doc),'Cuisine status updated')}));
r.delete('/admin/cuisines/:id',ah(async(req,res)=>{const used=await Product.exists({cuisineId:req.params.id});if(used)throw new AppError('Cuisine is assigned to products and cannot be deleted. Deactivate it instead.',409,'CUISINE_IN_USE');await Cuisine.findByIdAndDelete(req.params.id);ok(res,null,'Cuisine deleted')}));

r.get('/admin/offers',ah(async(req,res)=>ok(res,(await Offer.find().populate('outletIds','name code').sort({createdAt:-1}).lean()).map(adminOut))));
r.post('/admin/offers',mediaUpload.single('image'),ah(async(req,res)=>{const image=await cloudUpload(req.file,'offers');const doc=await Offer.create(promoPayload(req.body,image,'offer'));ok(res,adminOut(doc),'Offer created',201)}));
r.put('/admin/offers/:id',mediaUpload.single('image'),ah(async(req,res)=>{const image=await cloudUpload(req.file,'offers');const doc=await Offer.findByIdAndUpdate(req.params.id,{$set:promoPayload(req.body,image,'offer')},{new:true,runValidators:true});ok(res,adminOut(doc),'Offer updated')}));
r.delete('/admin/offers/:id',ah(async(req,res)=>{await Offer.findByIdAndDelete(req.params.id);ok(res,null,'Deleted')}));
r.get('/admin/coupons',ah(async(req,res)=>ok(res,(await Coupon.find().populate('outletIds','name code').sort({createdAt:-1}).lean()).map(adminOut))));
r.post('/admin/coupons',ah(async(req,res)=>{const doc=await Coupon.create(promoPayload(req.body,null,'coupon'));ok(res,adminOut(doc),'Coupon created',201)}));
r.put('/admin/coupons/:id',ah(async(req,res)=>{const doc=await Coupon.findByIdAndUpdate(req.params.id,{$set:promoPayload(req.body,null,'coupon')},{new:true,runValidators:true});ok(res,adminOut(doc),'Coupon updated');}));
r.delete('/admin/coupons/:id',ah(async(req,res)=>{await Coupon.findByIdAndDelete(req.params.id);ok(res,null,'Deleted')}));
r.get('/admin/users',ah(async(req,res)=>ok(res,await User.find(req.query.role?{role:req.query.role}:{}).select('-passwordHash').sort({createdAt:-1}).lean())));
r.get('/admin/support/tickets',ah(async(req,res)=>ok(res,await SupportTicket.find().populate('userId').sort({createdAt:-1}).lean())));
r.patch('/admin/support/tickets/:id',ah(async(req,res)=>ok(res,await SupportTicket.findByIdAndUpdate(req.params.id,req.body,{new:true}))));
r.get('/admin/verifications',ah(async(req,res)=>ok(res,await VerificationRequest.find(req.query.status?{status:req.query.status}:{}).populate('userId outletId').sort({createdAt:-1}).lean())));
r.patch('/admin/verifications/:id',ah(async(req,res)=>ok(res,await VerificationRequest.findByIdAndUpdate(req.params.id,{$set:{status:req.body.status,note:req.body.note,reviewedBy:req.user.id,reviewedAt:new Date()}},{new:true}))));
r.post(['/admin/notifications/send','/admin/notifications/send-all','/admin/notifications/send-to-all','/admin/notifications/send-to-customers','/admin/notifications/send-to-sellers','/admin/notifications/send-to-drivers','/admin/customer-messages/send','/admin/seller-messages'],ah(async(req,res)=>{let role=req.body.role;const path=req.path;if(path.includes('customers')||path.includes('customer-messages'))role='CUSTOMER';if(path.includes('sellers')||path.includes('seller-messages'))role='SELLER';if(path.includes('drivers'))role='RIDER';const query=req.body.userIds?.length?{_id:{$in:req.body.userIds}}:(role?{role}:{});const users=await User.find(query).select('_id role assignedOutletIds');const docs=users.map(u=>({userId:u._id,outletId:req.body.outletId||u.assignedOutletIds?.[0],role:u.role,title:req.body.title||'Message from Admin',message:req.body.message||req.body.description,type:req.body.type||'ADMIN_MESSAGE',data:{...(req.body.data||{}),sentByAdmin:true,targetRole:role||'ALL'}}));if(docs.length)await Notification.insertMany(docs);ok(res,{sent:docs.length,targetRole:role||'ALL'},'Messages sent successfully')}));

module.exports=r;
