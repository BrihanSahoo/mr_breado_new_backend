const {AppError}=require('../utils/errors');
module.exports=(param='outletId')=>(req,res,next)=>{if(req.user.role==='ADMIN')return next();const id=String(req.params[param]||req.body.outletId||req.query.outletId||'');const allowed=(req.user.assignedOutletIds||[]).map(String);if(!id||!allowed.includes(id))return next(new AppError('Outlet access denied',403,'OUTLET_FORBIDDEN'));next();};
