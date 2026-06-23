const r=require('express').Router();const ah=require('../utils/asyncHandler');const {ok}=require('../utils/respond');const svc=require('../services/authService');const {requireAuth}=require('../middleware/auth');const {User}=require('../models');
r.post(['/auth/login','/login','/admin/login','/admin/auth/login'],ah(async(req,res)=>ok(res,await svc.login(req.body),'Login successful')));
r.post(['/seller/outlet-login','/outlet-manager/login','/outlet/auth/login'],ah(async(req,res)=>{const data=await svc.login(req.body);if(data.user?.role!=='SELLER')return res.status(403).json({success:false,code:'OUTLET_LOGIN_NOT_ALLOWED',message:'This account is not configured as an outlet manager.'});ok(res,data,'Outlet login successful');}));
r.post(['/auth/register','/register'],ah(async(req,res)=>ok(res,await svc.register(req.body),'Registered successfully',201)));
r.post('/rider/auth/register',ah(async(req,res)=>ok(res,await svc.register({...req.body,role:'RIDER',phone:req.body.phone||req.body.mobile}),'Rider registered. Submit verification documents to continue.',201)));
r.post('/rider/auth/login',ah(async(req,res)=>ok(res,await svc.login({...req.body,email:req.body.email||req.body.emailOrMobile||req.body.identifier,phone:req.body.phone||req.body.mobile||req.body.emailOrMobile||req.body.identifier}),'Rider login successful')));
r.get(['/auth/me','/user/profile'],requireAuth,ah(async(req,res)=>ok(res,req.user)));
r.put(['/auth/update-profile','/user/profile'],requireAuth,ah(async(req,res)=>{const u=await User.findByIdAndUpdate(req.user.id,{$set:{name:req.body.name,email:req.body.email,phone:req.body.phone}},{new:true});ok(res,u,'Profile updated')}));
module.exports=r;
