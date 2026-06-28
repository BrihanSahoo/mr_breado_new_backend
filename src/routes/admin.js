const r=require('express').Router();const ah=require('../utils/asyncHandler');const {ok}=require('../utils/respond');const {requireAuth,allowRoles}=require('../middleware/auth');const bcrypt=require('bcryptjs');const {nanoid}=require('nanoid');const {User,Outlet,Category,Brand,Product,OutletProduct,Order,Payment,Refund,OfflineSale,DailyClosing,Setting,Banner,Offer,Coupon,InventoryMovement}=require('../models');const settings=require('../services/settingsService');const {AppError}=require('../utils/errors');const {buildVariantFields,serializeVariantFields}=require('../utils/productVariants');const media=require('../services/mediaService');const {findOneCompat,resolveObjectId}=require('../utils/compatId');
r.use('/admin',requireAuth,allowRoles('ADMIN'));
const slug=s=>String(s||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
const categoryOut=c=>{if(!c)return c;const raw=typeof c.toObject==='function'?c.toObject():c;const url=typeof raw.image==='string'?raw.image:(raw.image?.url||'');return {...raw,id:String(raw._id),title:raw.name,image:url,imageUrl:url,icon:url,status:raw.active?'ACTIVE':'INACTIVE',enabled:Boolean(raw.active)};};

r.get('/admin/dashboard',ah(async(req,res)=>{const [orders,revenue,outlets,customers]=await Promise.all([Order.countDocuments(),Order.aggregate([{$match:{status:'DELIVERED'}},{$group:{_id:null,total:{$sum:'$total'}}}]),Outlet.countDocuments(),User.countDocuments({role:'CUSTOMER'})]);ok(res,{totalOrders:orders,totalSales:revenue[0]?.total||0,totalOutlets:outlets,totalCustomers:customers})}));
const DEFAULT_OUTLET_LOGO='https://res.cloudinary.com/dty0zfd7g/image/upload/v1782468916/mr-breado/brands/file_nzsycz.jpg';
r.route('/admin/outlets').get(ah(async(req,res)=>ok(res,await Outlet.find().sort({primary:-1,createdAt:-1}).lean()))).post(ah(async(req,res)=>{
  const body=req.body||{};
  const addressSource=body.address&&typeof body.address==='object'?body.address:{};
  const address={
    line1:String(addressSource.line1||body.addressText||body.address||'').trim(),
    line2:String(addressSource.line2||body.addressLine2||'').trim(),
    area:String(addressSource.area||body.area||'').trim(),
    city:String(addressSource.city||body.city||'').trim(),
    state:String(addressSource.state||body.state||'').trim(),
    pincode:String(addressSource.pincode||body.pincode||'').trim(),
    landmark:String(addressSource.landmark||body.landmark||'').trim(),
  };
  const logoValue=body.logo?.url?body.logo:{url:body.logoUrl||body.logo||DEFAULT_OUTLET_LOGO,publicId:'',alt:'Mr. Breado'};
  const outlet=await Outlet.create({
    name:String(body.name||'').trim(),
    slug:body.slug||`${slug(body.name)}-${nanoid(4)}`,
    code:body.code||undefined,logo:logoValue,coverImage:body.coverImage?.url?body.coverImage:undefined,
    gstin:body.gstin||'',managerName:body.managerName||'',managerPhone:body.managerPhone||'',email:body.managerEmail||body.email||'',
    address,deliveryRadiusKm:Math.max(0,Number(body.serviceRadiusKm??body.deliveryRadiusKm??10)),
    featureToggles:body.featureToggles||body.feature_toggles||undefined,
    active:body.active!==false,open:body.open===true||body.isOpen===true,primary:body.primary===true,
    location:{type:'Point',coordinates:[Number(body.longitude??addressSource.longitude??0),Number(body.latitude??addressSource.latitude??0)]},
    createdBy:req.user.id,
  });
  ok(res,outlet,'Outlet created',201);
}));
r.get('/admin/outlets/primary',ah(async(req,res)=>ok(res,await Outlet.findOne({primary:true}).lean())));
r.patch('/admin/outlets/:id/primary',ah(async(req,res)=>{const session=await require('mongoose').startSession();let out;await session.withTransaction(async()=>{await Outlet.updateMany({primary:true},{$set:{primary:false}},{session});out=await Outlet.findByIdAndUpdate(req.params.id,{$set:{primary:true}},{new:true,session});});await session.endSession();ok(res,out,'Primary outlet updated')}));
r.get('/admin/outlets/:id/full-dashboard',ah(async(req,res)=>{
  const id=req.params.id;
  const from=req.query.from?new Date(`${req.query.from}T00:00:00.000Z`):new Date(new Date().setHours(0,0,0,0));
  const to=req.query.to?new Date(`${req.query.to}T23:59:59.999Z`):new Date();
  if(Number.isNaN(from.getTime())||Number.isNaN(to.getTime())||from>to)throw new AppError('Invalid dashboard date range',400,'INVALID_DATE_RANGE');
  const range={createdAt:{$gte:from,$lte:to}};
  const [outlet,inventory,orders,offline,closings,stockMovements]=await Promise.all([
    Outlet.findById(id).lean(),
    OutletProduct.find({outletId:id}).populate({path:'productId',populate:[{path:'categoryId'},{path:'brandId'}]}).sort({updatedAt:-1}).lean(),
    Order.find({outletId:id,...range}).populate('customerId riderId').sort({createdAt:-1}).lean(),
    OfflineSale.find({outletId:id,...range}).sort({createdAt:-1}).lean(),
    DailyClosing.find({outletId:id,businessDate:{$gte:from.toISOString().slice(0,10),$lte:to.toISOString().slice(0,10)}}).sort({businessDate:1}).lean(),
    InventoryMovement.find({outletId:id,createdAt:{$gte:from,$lte:to}}).populate('productId').sort({createdAt:-1}).limit(100).lean()
  ]);
  if(!outlet)throw new AppError('Outlet not found',404);
  const delivered=orders.filter(x=>x.status==='DELIVERED');
  const cancelled=orders.filter(x=>['CANCELLED','REJECTED'].includes(x.status));
  const active=orders.filter(x=>!['DELIVERED','CANCELLED','REJECTED','REFUNDED'].includes(x.status));
  const onlineSales=delivered.filter(x=>['ONLINE','WALLET','TAKEAWAY_ADVANCE'].includes(x.paymentMethod)).reduce((a,x)=>a+Number(x.paidAmount||x.total||0),0);
  const codSales=delivered.filter(x=>x.paymentMethod==='COD').reduce((a,x)=>a+Number(x.total||0),0);
  const offlineSales=offline.reduce((a,x)=>a+Number(x.total||0),0);
  const deliveredSales=delivered.reduce((a,x)=>a+Number(x.total||0),0);
  const discount=delivered.reduce((a,x)=>a+Number(x.discount||0),0);
  const tax=delivered.reduce((a,x)=>a+Number(x.tax||0),0);
  const deliveryFees=delivered.reduce((a,x)=>a+Number(x.deliveryCharge||0),0);
  const refunds=orders.reduce((a,x)=>a+(String(x.refundStatus||'').toUpperCase()==='PROCESSED'?Number(x.paidAmount||0):0),0);
  const availableStock=inventory.reduce((a,x)=>a+Math.max(0,Number(x.stockQuantity||0)-Number(x.reservedQuantity||0)),0);
  const reservedStock=inventory.reduce((a,x)=>a+Number(x.reservedQuantity||0),0);
  const lowStockRows=inventory.filter(x=>Math.max(0,Number(x.stockQuantity||0)-Number(x.reservedQuantity||0))<=Number(x.lowStockThreshold||0));
  const acceptanceTimes=orders.filter(x=>x.acceptedAt).map(x=>(new Date(x.acceptedAt)-new Date(x.createdAt))/60000).filter(Number.isFinite);
  const pickupTimes=orders.filter(x=>x.pickedUpAt&&x.readyAt).map(x=>(new Date(x.pickedUpAt)-new Date(x.readyAt))/60000).filter(Number.isFinite);
  const dayMap=new Map();
  const addDay=(date,values)=>{const key=new Date(date).toISOString().slice(0,10);const row=dayMap.get(key)||{date:key,orders:0,onlineSales:0,codSales:0,offlineSales:0,totalSales:0};Object.keys(values).forEach(k=>row[k]=(row[k]||0)+Number(values[k]||0));dayMap.set(key,row);};
  orders.forEach(x=>addDay(x.createdAt,{orders:1,onlineSales:['ONLINE','WALLET','TAKEAWAY_ADVANCE'].includes(x.paymentMethod)&&x.status==='DELIVERED'?Number(x.paidAmount||x.total||0):0,codSales:x.paymentMethod==='COD'&&x.status==='DELIVERED'?Number(x.total||0):0,totalSales:x.status==='DELIVERED'?Number(x.total||0):0}));
  offline.forEach(x=>addDay(x.createdAt,{offlineSales:Number(x.total||0),totalSales:Number(x.total||0)}));
  const itemSales=new Map();delivered.forEach(o=>(o.items||[]).forEach(i=>{const key=String(i.productId||i.name);const row=itemSales.get(key)||{productId:i.productId,productName:i.name||'Food item',soldQuantity:0,revenue:0};row.soldQuantity+=Number(i.quantity||0);row.revenue+=Number(i.finalTotal||i.unitPrice*i.quantity||0);itemSales.set(key,row);}));
  const ranked=[...itemSales.values()].sort((a,b)=>b.soldQuantity-a.soldQuantity);
  const statusBreakdown=Object.entries(orders.reduce((m,x)=>(m[x.status]=(m[x.status]||0)+1,m),{})).map(([status,count])=>({status,count}));
  const paymentBreakdown=[{method:'ONLINE',amount:onlineSales},{method:'COD',amount:codSales},{method:'OFFLINE',amount:offlineSales}];
  const stockValue=inventory.reduce((a,x)=>a+(Math.max(0,Number(x.stockQuantity||0)-Number(x.reservedQuantity||0))*Number(x.priceOverride??x.productId?.offerPrice??x.productId?.basePrice??0)),0);
  const summary={orders:orders.length,totalOrders:orders.length,activeOrders:active.length,deliveredOrders:delivered.length,cancelledOrders:cancelled.length,totalSales:deliveredSales+offlineSales,onlineSales,codSales,offlineSales,discount,tax,deliveryFees,refunds,averageOrderValue:delivered.length?deliveredSales/delivered.length:0,stockItems:inventory.length,totalStock:inventory.reduce((a,x)=>a+Number(x.stockQuantity||0),0),reservedStock,availableStock,lowStock:lowStockRows.length,outOfStock:inventory.filter(x=>Math.max(0,Number(x.stockQuantity||0)-Number(x.reservedQuantity||0))===0).length,availableProducts:inventory.filter(x=>x.enabled&&x.available&&Math.max(0,Number(x.stockQuantity||0)-Number(x.reservedQuantity||0))>0).length,stockValue,sellerAcceptanceMinutes:acceptanceTimes.length?acceptanceTimes.reduce((a,x)=>a+x,0)/acceptanceTimes.length:0,riderPickupMinutes:pickupTimes.length?pickupTimes.reduce((a,x)=>a+x,0)/pickupTimes.length:0};
  const closingCalendar=closings.map(x=>({id:String(x._id),closingDate:x.businessDate,closing_date:x.businessDate,onlineSales:Number(x.onlineSales||0),online_sales:Number(x.onlineSales||0),codSales:Number(x.codSales||0),cod_sales:Number(x.codSales||0),offlineSales:Number(x.offlineSales||0),offline_sales:Number(x.offlineSales||0),totalSales:Number(x.totalSales||0),total_sales:Number(x.totalSales||0),status:x.status}));
  const movementRows=stockMovements.map(x=>({id:String(x._id),createdAt:x.createdAt,created_at:x.createdAt,productName:x.productId?.name||'Food item',movementType:x.type,movement_type:x.type,beforeStock:x.quantityBefore,before_stock:x.quantityBefore,afterStock:x.quantityAfter,after_stock:x.quantityAfter,note:x.reason||''}));
  ok(res,{outlet,inventory,orders:orders.slice(0,100),recentOrders:orders.slice(0,12),offlineSalesRows:offline,closings,closingCalendar,stockMovements:movementRows,summary,metrics:summary,salesByDay:[...dayMap.values()].sort((a,b)=>a.date.localeCompare(b.date)),statusBreakdown,paymentBreakdown,topFoods:ranked.slice(0,10),bestFoods:ranked.slice(0,10),slowFoods:ranked.slice().reverse().slice(0,10),lowStock:lowStockRows});
}));
r.get('/admin/outlets/:id/available-products',ah(async(req,res)=>{
  const outletId=await resolveObjectId(Outlet,req.params.id);
  if(!outletId)throw new AppError('Outlet not found',404,'OUTLET_NOT_FOUND');
  const [products,assigned]=await Promise.all([
    Product.find({active:true}).populate('categoryId brandId cuisineId').sort({name:1}).lean(),
    OutletProduct.find({outletId}).populate({path:'productId',populate:[{path:'categoryId'},{path:'brandId'},{path:'cuisineId'}]}).sort({updatedAt:-1}).lean()
  ]);
  const map=new Map(assigned.map(x=>[String(x.productId?._id||x.productId),x]));
  const all=products.map(p=>{const row=map.get(String(p._id));return {...p,productId:String(p._id),assigned:Boolean(row?.enabled),outletInventory:row||null,stockQuantity:Number(row?.stockQuantity||0),reservedQuantity:Number(row?.reservedQuantity||0),availableStock:Math.max(0,Number(row?.stockQuantity||0)-Number(row?.reservedQuantity||0)),enabled:row?.enabled??false,available:row?.available??false,lowStockThreshold:Number(row?.lowStockThreshold||5),priceOverride:row?.priceOverride,offerPriceOverride:row?.offerPriceOverride,preparationMinutes:Number(row?.preparationMinutes||20)};});
  ok(res,{all,assigned,items:assigned,outletId:String(outletId)});
}));
r.post('/admin/outlets/:id/stock',ah(async(req,res)=>{
  const outletId=await resolveObjectId(Outlet,req.params.id);
  if(!outletId)throw new AppError('Outlet not found',404,'OUTLET_NOT_FOUND');
  const items=req.body.items||req.body.products||[];
  if(!Array.isArray(items)||!items.length)throw new AppError('At least one outlet product is required',400,'OUTLET_PRODUCTS_REQUIRED');
  const seen=new Set();
  for(const i of items){
    const rawProductId=i.productId||i.foodId||i.id;
    const productId=await resolveObjectId(Product,rawProductId);
    if(!productId)throw new AppError('One of the selected foods no longer exists. Refresh the catalog and try again.',404,'PRODUCT_NOT_FOUND');
    if(seen.has(String(productId)))continue; seen.add(String(productId));
    const enabled=i.enabled??i.selected??i.isEnabled??true;
    const existing=await OutletProduct.findOne({outletId,productId});
    const before=Number(existing?.stockQuantity||0);
    if(!enabled){
      if(existing) await OutletProduct.updateOne({_id:existing._id},{$set:{enabled:false,available:false,lastStockUpdatedAt:new Date(),lastStockUpdatedBy:req.user.id},$inc:{version:1}});
      continue;
    }
    const rawStock=i.stockQuantity??i.stock_quantity??i.stock??i.quantity??existing?.stockQuantity??0;
    const stockQuantity=Number(rawStock);
    if(!Number.isFinite(stockQuantity)||stockQuantity<0||!Number.isInteger(stockQuantity))throw new AppError('Stock quantity must be a whole number equal to or above zero',400,'INVALID_STOCK_QUANTITY');
    const lowStockThreshold=Math.max(0,Math.trunc(Number(i.lowStockThreshold??i.lowStockAlert??existing?.lowStockThreshold??5)||0));
    const preparationMinutes=Math.max(0,Math.trunc(Number(i.preparationMinutes??i.preparation_minutes??existing?.preparationMinutes??20)||0));
    const available=(i.isAvailable??i.available??true)!==false&&stockQuantity>0;
    const row=await OutletProduct.findOneAndUpdate(
      {outletId,productId},
      {$set:{enabled:true,available,stockQuantity,reservedQuantity:Math.min(Number(existing?.reservedQuantity||0),stockQuantity),stockInitialized:true,lowStockThreshold,preparationMinutes,lastStockUpdatedAt:new Date(),lastStockUpdatedBy:req.user.id},$inc:{version:1}},
      {upsert:true,new:true,runValidators:true,setDefaultsOnInsert:true}
    );
    if(before!==stockQuantity){
      await InventoryMovement.create({outletId,productId,type:'ADMIN_STOCK_SET',quantityBefore:before,quantityChanged:stockQuantity-before,quantityAfter:stockQuantity,reservedBefore:Number(existing?.reservedQuantity||0),reservedAfter:Number(row.reservedQuantity||0),reason:String(i.note||'Admin updated outlet stock'),performedBy:req.user.id,idempotencyKey:`${req.id}:${outletId}:${productId}:${stockQuantity}`}).catch(error=>{if(error?.code!==11000)throw error;});
    }
  }
  const rows=await OutletProduct.find({outletId}).populate({path:'productId',populate:[{path:'categoryId'},{path:'brandId'},{path:'cuisineId'}]}).sort({updatedAt:-1}).lean();
  ok(res,rows,'Outlet products and stock updated');
}));
r.route('/admin/categories').get(ah(async(req,res)=>ok(res,(await Category.find().sort({sortOrder:1}).lean()).map(categoryOut)))).post(media.imageUpload.single('image'),ah(async(req,res)=>{const name=String(req.body.name||req.body.title||'').trim();if(!name)throw new AppError('Category name is required',400,'CATEGORY_NAME_REQUIRED');const categorySlug=slug(req.body.slug||name);if(!categorySlug)throw new AppError('Enter a valid category name',400,'CATEGORY_SLUG_INVALID');if(await Category.exists({$or:[{name:{$regex:`^${name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}$`,$options:'i'}},{slug:categorySlug}]}))throw new AppError('A category with this name or slug already exists',409,'CATEGORY_ALREADY_EXISTS');const uploaded=req.file?await media.uploadImage(req.file,'categories'):null;const remote=media.imageFromUrl(req.body.imageUrl||req.body.image||req.body.icon||'','Category image');try{const created=await Category.create({name,slug:categorySlug,image:uploaded||remote||undefined,description:String(req.body.description||''),active:String(req.body.active??req.body.enabled??true)!=='false',sortOrder:Number(req.body.sortOrder||0)});ok(res,categoryOut(created),'Category created',201)}catch(error){if(uploaded?.publicId)await media.deleteImage(uploaded.publicId);throw error}}));
r.put('/admin/categories/:id',media.imageUpload.single('image'),ah(async(req,res)=>{const existing=await Category.findById(req.params.id);if(!existing)throw new AppError('Category not found',404,'CATEGORY_NOT_FOUND');const name=String(req.body.name||req.body.title||existing.name).trim();const categorySlug=slug(req.body.slug||name||existing.slug);if(await Category.exists({_id:{$ne:existing._id},$or:[{name:{$regex:`^${name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}$`,$options:'i'}},{slug:categorySlug}]}))throw new AppError('A category with this name or slug already exists',409,'CATEGORY_ALREADY_EXISTS');const uploaded=req.file?await media.uploadImage(req.file,'categories'):null;const remote=media.imageFromUrl(req.body.imageUrl||req.body.image||req.body.icon||'','Category image');const previous=existing.image?.publicId||'';existing.name=name;existing.slug=categorySlug;if(req.body.description!==undefined)existing.description=String(req.body.description||'');if(req.body.active!==undefined||req.body.enabled!==undefined)existing.active=String(req.body.active??req.body.enabled)!=='false';if(req.body.sortOrder!==undefined)existing.sortOrder=Number(req.body.sortOrder||0);if(uploaded||remote)existing.image=uploaded||remote;try{await existing.save();if(uploaded?.publicId&&previous&&previous!==uploaded.publicId)await media.deleteImage(previous);ok(res,categoryOut(existing),'Category updated')}catch(error){if(uploaded?.publicId)await media.deleteImage(uploaded.publicId);throw error}}));r.patch('/admin/categories/:id/status',ah(async(req,res)=>{const active=String(req.body.active??req.body.enabled??req.body.status)!=='false'&&String(req.body.status||'').toUpperCase()!=='INACTIVE';const row=await Category.findByIdAndUpdate(req.params.id,{active},{new:true});if(!row)throw new AppError('Category not found',404,'CATEGORY_NOT_FOUND');ok(res,categoryOut(row),'Category status updated')}));r.delete('/admin/categories/:id',ah(async(req,res)=>{const used=await Product.exists({categoryId:req.params.id});if(used)throw new AppError('This category is assigned to foods. Deactivate it instead of deleting it.',409,'CATEGORY_IN_USE');const row=await Category.findByIdAndDelete(req.params.id);if(!row)throw new AppError('Category not found',404,'CATEGORY_NOT_FOUND');if(row.image?.publicId)await media.deleteImage(row.image.publicId);ok(res,null,'Category deleted')}));
async function resolveCategoryForProduct(body){
  const id=body.categoryId||body.category_id;
  const name=body.categoryName||body.category_name||body.category;
  let category=null;
  if(id) category=await Category.findById(id);
  if(!category&&name) category=await Category.findOne({name:{$regex:`^${String(name).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}$`,$options:'i'}});
  if(!category||!category.active) throw new AppError('Select an active Admin category',400,'INVALID_CATEGORY');
  return category;
}
async function productPayload(body,existing={}){
  const category=await resolveCategoryForProduct(body);
  const variants=buildVariantFields({...existing,...body},category);
  const rawImages=body.images||existing.images||[];
  const imageCandidates=Array.isArray(rawImages)?rawImages:[rawImages];
  const direct=body.imageUrl||body.image_url||body.image||body.thumbnail;
  if(direct) imageCandidates.unshift(direct);
  const images=imageCandidates.map(x=>typeof x==='string'?{url:x}:x).filter(x=>x?.url);
  const explicit=String(body.foodType||body.food_type||'').toUpperCase().replace('-','_');
  const foodType=['VEG','NON_VEG','EGG','VEGAN','OTHER'].includes(explicit)?explicit:((body.isVeg??body.is_veg)===false?'NON_VEG':((body.isVeg??body.is_veg)===true?'VEG':(existing.foodType||'OTHER')));
  return {...body,name:body.name||body.title||existing.name,categoryId:category._id,images,foodType,...variants};
}
const productOut=p=>{if(!p)return p;const image=(Array.isArray(p.images)?p.images.find(x=>x?.url)?.url:'')||'';return {...p,...serializeVariantFields(p),id:String(p._id),productId:String(p._id),title:p.name,image,imageUrl:image,foodType:p.foodType,isVeg:p.foodType==='VEG',veg:p.foodType==='VEG',categoryName:p.categoryId?.name||''};};
r.route('/admin/products').get(ah(async(req,res)=>ok(res,(await Product.find().populate('categoryId brandId').lean()).map(productOut)))).post(ah(async(req,res)=>{const payload=await productPayload(req.body);const product=await Product.create({...payload,slug:req.body.slug||`${slug(payload.name)}-${nanoid(5)}`,createdBy:req.user.id});ok(res,productOut(await Product.findById(product._id).populate('categoryId').lean()),'Product created',201)}));
r.get(['/admin/products/catalog','/admin/foods'],ah(async(req,res)=>ok(res,(await Product.find().populate('categoryId').lean()).map(productOut))));
r.put('/admin/products/:id',ah(async(req,res)=>{const existing=await Product.findById(req.params.id).lean();if(!existing)throw new AppError('Product not found',404);const payload=await productPayload(req.body,existing);const product=await Product.findByIdAndUpdate(req.params.id,{$set:payload},{new:true,runValidators:true}).populate('categoryId').lean();ok(res,productOut(product),'Product updated')}));
r.delete('/admin/products/:id',ah(async(req,res)=>{await Product.findByIdAndUpdate(req.params.id,{active:false});ok(res,null,'Product disabled')}));
r.post('/admin/outlet-managers',ah(async(req,res)=>{const password=String(req.body.password||'');if(password.length<8)throw new AppError('Password must contain at least 8 characters');const identity=String(req.body.username||req.body.email||req.body.phone||'').trim();if(!identity)throw new AppError('Username, email or phone is required',400,'SELLER_IDENTITY_REQUIRED');const u=await User.create({name:req.body.name,username:req.body.username?.trim().toLowerCase(),email:req.body.email?.trim().toLowerCase()||undefined,phone:req.body.phone?.trim()||undefined,passwordHash:await bcrypt.hash(password,12),role:'SELLER',assignedOutletIds:req.body.outletIds||[req.body.outletId].filter(Boolean)});ok(res,u,'Outlet manager created',201)}));
r.get('/admin/outlet-managers',ah(async(req,res)=>ok(res,await User.find({role:'SELLER'}).select('-passwordHash').populate('assignedOutletIds').lean())));r.patch('/admin/outlet-managers/:id',ah(async(req,res)=>ok(res,await User.findByIdAndUpdate(req.params.id,{$set:{name:req.body.name,phone:req.body.phone,email:req.body.email,assignedOutletIds:req.body.outletIds,active:req.body.active}},{new:true}))));
r.get('/admin/orders',ah(async(req,res)=>{const q={};if(req.query.outletId)q.outletId=req.query.outletId;if(req.query.status)q.status=req.query.status;ok(res,await Order.find(q).populate('customerId outletId riderId').sort({createdAt:-1}).lean())}));
r.get('/admin/transactions',ah(async(req,res)=>{const q={};if(req.query.outletId)q.outletId=req.query.outletId;if(req.query.status)q.status=req.query.status;ok(res,await Payment.find(q).populate('orderId customerId outletId').sort({createdAt:-1}).lean())}));
r.get('/admin/refunds',ah(async(req,res)=>ok(res,await Refund.find(req.query.status?{status:req.query.status}:{}).populate('orderId customerId outletId paymentId').sort({createdAt:-1}).lean())));r.patch('/admin/refunds/:id',ah(async(req,res)=>ok(res,await Refund.findByIdAndUpdate(req.params.id,{$set:{status:req.body.status,adminAcknowledgement:req.body.refunded===true,adminNote:req.body.note,processedBy:req.user.id,processedAt:['PROCESSED','REJECTED'].includes(req.body.status)?new Date():null}},{new:true}))));
r.get(['/admin/settings','/admin/application-settings','/admin/payment-settings'],ah(async(req,res)=>ok(res,await settings.adminSettings())));

r.get('/admin/outlets/:id/daily-reports',ah(async(req,res)=>ok(res,await DailyClosing.find({outletId:req.params.id}).populate('sellerId').populate('stockSnapshot.productId').sort({businessDate:-1,submittedAt:-1}).lean())));
r.get('/admin/outlets/:id/daily-reports/:reportId',ah(async(req,res)=>{const row=await DailyClosing.findOne({_id:req.params.reportId,outletId:req.params.id}).populate('sellerId').populate('stockSnapshot.productId').lean();if(!row)throw new AppError('Daily report not found',404,'DAILY_REPORT_NOT_FOUND');ok(res,row); }));
r.get(['/admin/settings/business-features','/admin/feature-settings','/admin/takeaway-settings'],ah(async(req,res)=>ok(res,await settings.getBusinessFeatures())));
r.put(['/admin/settings/business-features','/admin/feature-settings','/admin/takeaway-settings'],ah(async(req,res)=>ok(res,await settings.setBusinessFeatures(req.body,req.user.id,{requestId:req.id||req.headers['x-request-id']}),'Business features updated')));
r.patch(['/admin/settings/online-payment/status','/admin/payment-settings/status'],ah(async(req,res)=>ok(res,await settings.setBusinessFeatures({onlinePaymentEnabled:req.body.enabled},req.user.id,{requestId:req.id||req.headers['x-request-id']}),'Online payment status updated')));
r.patch(['/admin/settings/takeaway/status','/admin/takeaway/status'],ah(async(req,res)=>ok(res,await settings.setBusinessFeatures({takeawayEnabled:req.body.enabled},req.user.id,{requestId:req.id||req.headers['x-request-id']}),'Takeaway status updated')));
r.patch(['/admin/settings/takeaway/advance','/admin/takeaway/advance'],ah(async(req,res)=>ok(res,await settings.setBusinessFeatures({takeawayAdvancePercentage:req.body.percentage??req.body.advanceValue},req.user.id,{requestId:req.id||req.headers['x-request-id']}),'Takeaway advance updated')));
const normalizeRazorpay=b=>({keyId:b.keyId??b.razorpayKeyId??b.razorpay_key_id,keySecret:b.keySecret??b.razorpaySecret??b.razorpayKeySecret??b.razorpay_key_secret,webhookSecret:b.webhookSecret??b.razorpayWebhookSecret??b.razorpay_webhook_secret,enabled:b.enabled!==false&&b.active!==false});
const normalizeMaps=b=>({apiKey:b.apiKey??b.googleMapsApiKey??b.google_maps_api_key??b.mapsKey,enabled:b.enabled!==false&&b.active!==false});
r.put(['/admin/settings/razorpay','/admin/payment-settings/razorpay','/admin/razorpay-settings'],ah(async(req,res)=>ok(res,await settings.setSecret('razorpay_credentials',normalizeRazorpay(req.body),req.user.id,{active:req.body.active!==false,requestId:req.id||req.headers['x-request-id']}),'Razorpay settings updated')));
r.patch(['/admin/settings/razorpay/status','/admin/payment-settings/razorpay/status'],ah(async(req,res)=>ok(res,await settings.setSecret('razorpay_credentials',{enabled:req.body.enabled!==false},req.user.id,{requestId:req.id||req.headers['x-request-id']}),'Razorpay status updated')));
r.put(['/admin/settings/google-maps','/admin/google-maps-settings','/admin/maps-settings'],ah(async(req,res)=>ok(res,await settings.setSecret('google_maps_credentials',normalizeMaps(req.body),req.user.id,{active:req.body.active!==false,requestId:req.id||req.headers['x-request-id']}),'Google Maps settings updated')));
r.patch(['/admin/settings/google-maps/status','/admin/google-maps-settings/status'],ah(async(req,res)=>ok(res,await settings.setSecret('google_maps_credentials',{enabled:req.body.enabled!==false},req.user.id,{requestId:req.id||req.headers['x-request-id']}),'Google Maps status updated')));
r.post('/admin/settings/integrations/:key/validate',ah(async(req,res)=>ok(res,await settings.validateIntegration(req.params.key),'Integration validated')));
r.put('/admin/settings/:key',ah(async(req,res)=>{const key=req.params.key;const requestId=req.id||req.headers['x-request-id'];if(['razorpay_credentials','google_maps_credentials'].includes(key))return ok(res,await settings.setSecret(key,req.body.value||req.body,req.user.id,{active:req.body.active!==false,requestId}),'Integration settings updated');return ok(res,await settings.set(key,req.body.value,req.user.id,req.body.public,{active:req.body.active!==false,requestId}),'Setting updated');}));

r.get('/admin/outlets/:id/controls',ah(async(req,res)=>{const outlet=await findOneCompat(Outlet,req.params.id);if(!outlet)throw new AppError('Outlet not found',404,'OUTLET_NOT_FOUND');const global=await settings.getBusinessFeatures();ok(res,{outletId:outlet.legacyId||String(outlet._id),featureToggles:{...global.feature_toggles,...(outlet.featureToggles?.toObject?.()||outlet.featureToggles||{})},serviceRadiusKm:Number(outlet.deliveryRadiusKm||0),deliverySettings:outlet.deliverySettings||{}})}));
r.put('/admin/outlets/:id/controls',ah(async(req,res)=>{const global=await settings.getBusinessFeatures();const source=req.body.featureToggles||req.body.feature_toggles||req.body;const toggles={delivery:source.delivery!==undefined?Boolean(source.delivery):global.feature_toggles.delivery,takeaway:source.takeaway!==undefined?Boolean(source.takeaway):global.feature_toggles.takeaway,cod:source.cod!==undefined?Boolean(source.cod):global.feature_toggles.cod,onlinePayment:source.onlinePayment!==undefined?Boolean(source.onlinePayment):source.online_payment!==undefined?Boolean(source.online_payment):global.feature_toggles.onlinePayment,riderAssignment:source.riderAssignment!==undefined?Boolean(source.riderAssignment):global.feature_toggles.riderAssignment,offers:source.offers!==undefined?Boolean(source.offers):global.feature_toggles.offers};const update={featureToggles:toggles};if(req.body.serviceRadiusKm!==undefined||req.body.deliveryRadiusKm!==undefined)update.deliveryRadiusKm=Math.max(0,Number(req.body.serviceRadiusKm??req.body.deliveryRadiusKm));const current=await findOneCompat(Outlet,req.params.id);if(!current)throw new AppError('Outlet not found',404,'OUTLET_NOT_FOUND');const outlet=await Outlet.findByIdAndUpdate(current._id,{$set:update},{new:true,runValidators:true}).lean();ok(res,{outletId:outlet.legacyId||String(outlet._id),featureToggles:outlet.featureToggles,serviceRadiusKm:Number(outlet.deliveryRadiusKm||0),deliverySettings:outlet.deliverySettings||{}},'Outlet controls updated')}));


r.post('/admin/outlets/:id/restock',ah(async(req,res)=>{const outlet=await findOneCompat(Outlet,req.params.id);if(!outlet)throw new AppError('Outlet not found',404,'OUTLET_NOT_FOUND');const items=Array.isArray(req.body.items)?req.body.items:[];if(!items.length)throw new AppError('Add at least one food to restock',400,'ITEMS_REQUIRED');const key=req.headers['idempotency-key']||req.body.idempotencyKey||`admin-restock:${outlet._id}:${Date.now()}`;const mongoose=require('mongoose');const session=await mongoose.startSession();const updated=[];try{await session.withTransaction(async()=>{for(const item of items){const product=await findOneCompat(Product,item.productId||item.id);if(!product)throw new AppError('Product not found',404,'PRODUCT_NOT_FOUND');const quantity=Number(item.quantity);if(!Number.isInteger(quantity)||quantity<=0)throw new AppError('Restock quantity must be a positive whole number',400,'INVALID_QUANTITY');const row=await OutletProduct.findOne({outletId:outlet._id,productId:product._id}).session(session);if(!row)throw new AppError(`${product.name} is not assigned to this outlet`,404,'OUTLET_PRODUCT_NOT_FOUND');const before=Number(row.stockQuantity||0);row.stockQuantity=before+quantity;row.available=true;row.stockInitialized=true;row.lastStockUpdatedAt=new Date();row.lastStockUpdatedBy=req.user.id;await row.save({session});await InventoryMovement.create([{outletId:outlet._id,productId:product._id,type:'ADMIN_RESTOCK',quantityBefore:before,quantityChanged:quantity,quantityAfter:row.stockQuantity,reservedBefore:row.reservedQuantity,reservedAfter:row.reservedQuantity,referenceType:'ADMIN_RESTOCK',reason:req.body.note||item.note||'Admin restock',performedBy:req.user.id,idempotencyKey:`${key}:${product._id}`}],{session});updated.push({productId:product.legacyId||String(product._id),name:product.name,quantityAdded:quantity,stockQuantity:row.stockQuantity});}});}finally{await session.endSession();}ok(res,{outletId:outlet.legacyId||String(outlet._id),items:updated},'Outlet stock restocked');}));

r.get('/admin/inventory/movements',ah(async(req,res)=>ok(res,await InventoryMovement.find(req.query.outletId?{outletId:req.query.outletId}:{}).populate('productId outletId').sort({createdAt:-1}).limit(500).lean())));
r.get('/admin/daily-closings',ah(async(req,res)=>ok(res,await DailyClosing.find(req.query.outletId?{outletId:req.query.outletId}:{}).populate('outletId sellerId').sort({businessDate:-1}).lean())));
module.exports=r;
