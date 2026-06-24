const r=require('express').Router();const ah=require('../utils/asyncHandler');const {ok}=require('../utils/respond');const svc=require('../services/authService');const {requireAuth}=require('../middleware/auth');const {User,VerificationRequest,RiderLocation}=require('../models');const {AppError}=require('../utils/errors');
r.post(['/auth/login','/login','/admin/login','/admin/auth/login'],ah(async(req,res)=>ok(res,await svc.login(req.body),'Login successful')));
r.post(['/seller/outlet-login','/outlet-manager/login','/outlet/auth/login'],ah(async(req,res)=>{const data=await svc.login(req.body);if(data.user?.role!=='SELLER')return res.status(403).json({success:false,code:'OUTLET_LOGIN_NOT_ALLOWED',message:'This account is not configured as an outlet manager.'});ok(res,data,'Outlet login successful');}));
r.post(['/auth/register','/register'],ah(async(req,res)=>ok(res,await svc.register(req.body),'Registered successfully',201)));
r.post('/rider/auth/register',ah(async(req,res)=>ok(res,await svc.register({...req.body,role:'RIDER',phone:req.body.phone||req.body.mobile}),'Rider registered. Submit verification documents to continue.',201)));
r.post('/rider/auth/login',ah(async(req,res)=>ok(res,await svc.login({...req.body,email:req.body.email||req.body.emailOrMobile||req.body.identifier,phone:req.body.phone||req.body.mobile||req.body.emailOrMobile||req.body.identifier}),'Rider login successful')));
// Rider runtime availability is intentionally mounted in the auth router, which is
// the first application router. This prevents any legacy rider role middleware
// from intercepting a verified rider's online/offline request.
r.post('/rider/auth/runtime-availability',requireAuth,ah(async(req,res)=>{
  const rider=await User.findById(req.user.id);
  if(!rider)throw new AppError('Rider account not found',404,'RIDER_NOT_FOUND');
  if(String(rider.role||'').toUpperCase()==='SELLER')throw new AppError('Seller accounts cannot use rider availability',403,'RIDER_ACTION_NOT_ALLOWED');

  const latest=await VerificationRequest.findOne({userId:rider._id,type:'RIDER'}).sort({createdAt:-1});
  const requestStatus=String(latest?.status||'').trim().toUpperCase();
  const profileStatus=String(rider.riderProfile?.verificationStatus||'').trim().toUpperCase();
  const approved=['VERIFIED','APPROVED','ACTIVE'].includes(requestStatus)||['VERIFIED','APPROVED','ACTIVE'].includes(profileStatus);
  const online=Boolean(req.body.online??req.body.isOnline??req.body.is_online);
  const available=Boolean(req.body.available??req.body.isAvailable??req.body.is_available??online);
  if((online||available)&&!approved)throw new AppError('Admin verification is required before going online',409,'RIDER_NOT_VERIFIED');

  const latitude=Number(req.body.latitude??req.body.lat);
  const longitude=Number(req.body.longitude??req.body.lng??req.body.lon);
  if(online&&(!Number.isFinite(latitude)||!Number.isFinite(longitude)))throw new AppError('Current location is required before going online',400,'RIDER_LOCATION_REQUIRED');

  if(!rider.riderProfile)rider.riderProfile={};
  if(approved){rider.role='RIDER';rider.riderProfile.verificationStatus='VERIFIED';}
  rider.riderProfile.online=online;
  rider.riderProfile.available=online&&available;
  if(Number.isFinite(latitude)&&Number.isFinite(longitude)){
    rider.riderProfile.currentLatitude=latitude;
    rider.riderProfile.currentLongitude=longitude;
    rider.riderProfile.lastLocationAt=new Date();
  }
  await rider.save();

  if(Number.isFinite(latitude)&&Number.isFinite(longitude)){
    await RiderLocation.create({
      riderId:rider._id,
      location:{type:'Point',coordinates:[longitude,latitude]},
      heading:Number(req.body.heading??req.body.headingDegrees??0),
      speed:Number(req.body.speed??req.body.speedMetersPerSecond??0),
      accuracy:Number(req.body.accuracy??req.body.accuracyMeters??0),
      recordedAt:new Date(),
    });
  }

  ok(res,{
    id:rider.legacyId||String(rider._id),mongoId:String(rider._id),
    online:Boolean(rider.riderProfile.online),available:Boolean(rider.riderProfile.available),
    verificationStatus:rider.riderProfile.verificationStatus||'VERIFIED',
    verification_status:rider.riderProfile.verificationStatus||'VERIFIED',
    currentLatitude:rider.riderProfile.currentLatitude,currentLongitude:rider.riderProfile.currentLongitude,
    lastLocationAt:rider.riderProfile.lastLocationAt,
  },online?'Rider is online':'Rider is offline');
}));

r.get(['/auth/me','/user/profile'],requireAuth,ah(async(req,res)=>ok(res,req.user)));
r.put(['/auth/update-profile','/user/profile'],requireAuth,ah(async(req,res)=>{const u=await User.findByIdAndUpdate(req.user.id,{$set:{name:req.body.name,email:req.body.email,phone:req.body.phone}},{new:true});ok(res,u,'Profile updated')}));
module.exports=r;
