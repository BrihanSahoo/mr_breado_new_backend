const r=require('express').Router();const ah=require('../utils/asyncHandler');const {ok}=require('../utils/respond');const svc=require('../services/authService');const {requireAuth}=require('../middleware/auth');const {User}=require('../models');
r.post(['/auth/login','/login','/admin/login','/admin/auth/login','/seller/outlet-login','/outlet-manager/login','/outlet/auth/login'],ah(async(req,res)=>ok(res,await svc.login(req.body),'Login successful')));
r.post(['/auth/register','/register'],ah(async(req,res)=>ok(res,await svc.register(req.body),'Registered successfully',201)));
r.get(['/auth/me','/user/profile'],requireAuth,ah(async(req,res)=>ok(res,req.user)));
r.put(['/auth/update-profile','/user/profile'],requireAuth,ah(async(req,res)=>{const u=await User.findByIdAndUpdate(req.user.id,{$set:{name:req.body.name,email:req.body.email,phone:req.body.phone}},{new:true});ok(res,u,'Profile updated')}));
module.exports=r;
