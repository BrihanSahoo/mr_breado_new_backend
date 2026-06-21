const r=require('express').Router();const mongoose=require('mongoose');const ah=require('../utils/asyncHandler');const {ok}=require('../utils/respond');const {requireAuth,allowRoles}=require('../middleware/auth');const {Order,OutletProduct,OfflineSale,InventoryMovement,DailyClosing,Outlet}=require('../models');const {AppError}=require('../utils/errors');
r.use(['/seller','/outlet-manager'],requireAuth,allowRoles('SELLER','ADMIN'));
const allowed=(u,id)=>u.role==='ADMIN'||(u.assignedOutletIds||[]).map(String).includes(String(id));
r.get(['/seller/restaurant','/outlet-manager/outlet'],ah(async(req,res)=>ok(res,await Outlet.find({_id:{$in:req.user.assignedOutletIds||[]}}).lean())));
r.get(['/seller/orders','/outlet-manager/orders'],ah(async(req,res)=>{const ids=req.user.role==='ADMIN'?(req.query.outletId?[req.query.outletId]:await Outlet.distinct('_id')):req.user.assignedOutletIds;ok(res,await Order.find({outletId:{$in:ids}}).populate('customerId riderId outletId').sort({createdAt:-1}).lean())}));
r.get(['/seller/products','/outlet-manager/products'],ah(async(req,res)=>{const id=req.query.outletId||req.user.assignedOutletIds?.[0];if(!allowed(req.user,id))throw new AppError('Outlet access denied',403);ok(res,await OutletProduct.find({outletId:id}).populate('productId').lean())}));
r.post(['/seller/offline-sales','/outlet-manager/offline-sales'],ah(async(req,res)=>{const outletId=req.body.outletId||req.user.assignedOutletIds?.[0];if(!allowed(req.user,outletId))throw new AppError('Outlet access denied',403);const key=req.headers['idempotency-key']||req.body.idempotencyKey;if(!key)throw new AppError('Idempotency-Key is required');const old=await OfflineSale.findOne({idempotencyKey:key});if(old)return ok(res,old,'Offline sale already processed');const session=await mongoose.startSession();let sale;await session.withTransaction(async()=>{let subtotal=0;const items=[];for(const item of req.body.items||[]){const row=await OutletProduct.findOne({outletId,productId:item.productId}).populate('productId').session(session);if(!row||row.stockQuantity<Number(item.quantity))throw new AppError('Insufficient stock',409);const before=row.stockQuantity;const price=Number(item.unitPrice??row.priceOverride??row.productId.offerPrice??row.productId.basePrice);row.stockQuantity-=Number(item.quantity);await row.save({session});items.push({productId:row.productId._id,name:row.productId.name,quantity:Number(item.quantity),unitPrice:price,total:price*Number(item.quantity)});subtotal+=price*Number(item.quantity);await InventoryMovement.create([{outletId,productId:row.productId._id,type:'OFFLINE_SALE',quantityBefore:before,quantityChanged:-Number(item.quantity),quantityAfter:row.stockQuantity,reservedBefore:row.reservedQuantity,reservedAfter:row.reservedQuantity,referenceType:'OFFLINE_SALE',reason:'Seller offline sale',performedBy:req.user.id,idempotencyKey:`${key}:${row.productId._id}`}],{session});}[sale]=await OfflineSale.create([{outletId,sellerId:req.user.id,items,subtotal,tax:Number(req.body.tax||0),total:subtotal+Number(req.body.tax||0),paymentMode:req.body.paymentMode||'CASH',idempotencyKey:key}],{session});});await session.endSession();ok(res,sale,'Offline sale recorded',201)}));
r.post(['/seller/day-close','/outlet-manager/day-close','/seller/end-of-day'],ah(async(req,res)=>{
  const outletId=req.body.outletId||req.user.assignedOutletIds?.[0];
  if(!allowed(req.user,outletId))throw new AppError('Outlet access denied',403);
  const outlet=await Outlet.findById(outletId);
  if(!outlet)throw new AppError('Outlet not found',404);
  const gstin=String(outlet.gstin||'').trim().toUpperCase();
  if(!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin))throw new AppError('GSTIN is not configured for this outlet. Contact the administrator.',409,'OUTLET_GSTIN_REQUIRED');
  const businessDate=req.body.businessDate||req.body.date||new Date().toISOString().slice(0,10);
  const inventory=await OutletProduct.find({outletId}).lean();
  const requestedItems=Array.isArray(req.body.items)?req.body.items:[];
  const requestedById=new Map(requestedItems.map(x=>[String(x.productId||x.id),x]));
  const stockSnapshot=inventory.map(x=>{const requested=requestedById.get(String(x.productId));const stockQuantity=requested?.stockQuantity??requested?.stock??x.stockQuantity;return{productId:x.productId,stockQuantity:Number(stockQuantity||0),reservedQuantity:Number(x.reservedQuantity||0),availableStock:Math.max(0,Number(stockQuantity||0)-Number(x.reservedQuantity||0))};});
  const start=new Date(`${businessDate}T00:00:00.000Z`),end=new Date(`${businessDate}T23:59:59.999Z`);
  const [orders,offline]=await Promise.all([Order.find({outletId,status:'DELIVERED',deliveredAt:{$gte:start,$lte:end}}).lean(),OfflineSale.find({outletId,createdAt:{$gte:start,$lte:end}}).lean()]);
  const onlineSales=orders.filter(x=>['ONLINE','TAKEAWAY_ADVANCE','WALLET'].includes(x.paymentMethod)).reduce((a,x)=>a+Number(x.paidAmount||x.total||0),0);
  const codSales=orders.filter(x=>x.paymentMethod==='COD').reduce((a,x)=>a+Number(x.total||0),0);
  const offlineCashSales=Number(req.body.offlineCashSales??req.body.cashSales??0);
  const offlineUpiSales=Number(req.body.offlineUpiSales??req.body.upiSales??0);
  const offlineCardSales=Number(req.body.offlineCardSales??req.body.cardSales??0);
  const offlineOtherSales=Number(req.body.offlineOtherSales??req.body.otherSales??0);
  const suppliedOffline=Number(req.body.offlineSales||0);
  const recordedOffline=offline.reduce((a,x)=>a+Number(x.total||0),0);
  const offlineSales=Math.max(suppliedOffline,offlineCashSales+offlineUpiSales+offlineCardSales+offlineOtherSales,recordedOffline);
  const session=await mongoose.startSession();let closing;
  try{await session.withTransaction(async()=>{
    closing=await DailyClosing.findOneAndUpdate({outletId,businessDate},{$set:{sellerId:req.user.id,stockSnapshot,onlineSales,codSales,offlineSales,offlineCashSales,offlineUpiSales,offlineCardSales,offlineOtherSales,offlineOrderCount:Number(req.body.offlineOrderCount||0),refunds:Number(req.body.refunds||0),expenses:Number(req.body.expenses||0),totalSales:onlineSales+codSales+offlineSales,status:'SUBMITTED',notes:req.body.notes||req.body.note||'',submittedAt:new Date()}},{upsert:true,new:true,session,setDefaultsOnInsert:true});
    if(req.body.closeOutlet===true||req.body.closeOutlet==='true')await Outlet.updateOne({_id:outletId},{$set:{open:false}},{session});
  });}finally{await session.endSession();}
  ok(res,{closing,outletOpen:req.body.closeOutlet===true||req.body.closeOutlet==='true'?false:outlet.open},req.body.closeOutlet?'Closing submitted and outlet closed':'Day closing submitted');
}));
module.exports=r;
