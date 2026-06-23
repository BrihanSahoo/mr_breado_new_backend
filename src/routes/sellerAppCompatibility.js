const express = require('express');
const r = express.Router();
const mongoose = require('mongoose');
const ah = require('../utils/asyncHandler');
const { ok } = require('../utils/respond');
const { requireAuth, allowRoles } = require('../middleware/auth');
const { AppError } = require('../utils/errors');
const { findOneCompat, resolveObjectId } = require('../utils/compatId');
const orderService = require('../services/orderService');
const invoiceService = require('../services/invoiceService');
const {
  User, Outlet, Product, OutletProduct, Order, InventoryMovement,
  OfflineSale, DailyClosing, Payment, Review, Offer, Notification,
  VerificationRequest
} = require('../models');

r.use(requireAuth, allowRoles('SELLER', 'ADMIN'));

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
function validGstin(value) { return GSTIN_RE.test(String(value || '').trim().toUpperCase()); }
async function requireBusinessReady(outletId) {
  const outlet = await Outlet.findById(outletId).lean();
  if (!outlet) throw new AppError('Outlet not found', 404, 'OUTLET_NOT_FOUND');
  if (!validGstin(outlet.gstin)) throw new AppError('GSTIN is not configured for this outlet. Contact the administrator.', 403, 'OUTLET_GSTIN_REQUIRED');
  if (outlet.active === false) throw new AppError('Outlet is inactive. Contact the administrator.', 403, 'OUTLET_INACTIVE');
  return outlet;
}
function outletDto(o) {
  if (!o) return o;
  const raw = typeof o.toObject === 'function' ? o.toObject() : o;
  const address = [raw.address?.line1, raw.address?.line2, raw.address?.area, raw.address?.city, raw.address?.state, raw.address?.pincode].filter(Boolean).join(', ');
  const logo = raw.logo?.url || '';
  const banner = raw.coverImage?.url || '';
  return { ...raw, id: raw.legacyId ?? String(raw._id), mongoId: String(raw._id), outletId: String(raw._id), address, logo, logoImage: logo, banner, bannerImage: banner, gstinRequired: true, businessReady: validGstin(raw.gstin) && raw.active !== false, verificationStatus: 'APPROVED', visibilityStatus: raw.active === false ? 'HIDDEN' : 'VISIBLE', status: raw.open ? 'OPEN' : 'CLOSED' };
}
function orderDto(o) {
  const raw = typeof o?.toObject === 'function' ? o.toObject() : o;
  if (!raw) return raw;
  const customer = raw.customerId && typeof raw.customerId === 'object' ? raw.customerId : {};
  const rider = raw.riderId && typeof raw.riderId === 'object' ? raw.riderId : {};
  const outlet = raw.outletId && typeof raw.outletId === 'object' ? raw.outletId : {};
  return { ...raw, id: raw.legacyId ?? String(raw._id), mongoId: String(raw._id), orderNumber: raw.slug, customer, customerName: customer.name || 'Customer', customerMobile: customer.phone || '', customerEmail: customer.email || '', rider, outlet: outletDto(outlet), grandTotal: Number(raw.total || 0), deliveryAddress: raw.address, orderType: raw.fulfilmentType, paymentType: raw.paymentMethod };
}


function outletIdsFor(user) {
  return (user.assignedOutletIds || []).map((id) => String(id));
}
function ensureOutlet(user, outletId) {
  if (user.role === 'ADMIN') return;
  if (!outletIdsFor(user).includes(String(outletId))) {
    throw new AppError('Outlet access denied', 403, 'OUTLET_ACCESS_DENIED');
  }
}
async function repairCurrentSellerAssignment(req) {
  if (req.user.role !== 'SELLER') return null;

  const direct=await Outlet.findOne({managerUserId:req.user.id}).sort({updatedAt:-1});
  if(direct){
    await User.updateOne({_id:req.user.id},{$set:{assignedOutletIds:[direct._id]}});
    req.user.assignedOutletIds=[direct._id];
    return direct._id;
  }

  const or = [];
  if (req.user.email) {
    const email = String(req.user.email).trim().toLowerCase();
    or.push({ email }, { managerEmail: email });
  }
  if (req.user.phone) {
    const phone = String(req.user.phone).trim();
    or.push({ managerPhone: phone }, { phone });
  }
  if (req.user.name) or.push({ managerName: String(req.user.name).trim() });
  if (!or.length) return null;

  const outlet = await Outlet.findOne({ $or: or }).sort({ updatedAt: -1 });
  if (!outlet) return null;

  await User.updateOne(
    { _id: req.user.id },
    { $set: { assignedOutletIds: [outlet._id] } },
  );
  req.user.assignedOutletIds = [outlet._id];
  return outlet._id;
}

async function currentOutlet(req) {
  const requested = req.query.outletId || req.body?.outletId || req.body?.restaurantId;

  if (req.user.role === 'ADMIN') {
    if (!requested) {
      throw new AppError('Select an outlet first', 400, 'OUTLET_SELECTION_REQUIRED');
    }
    const adminOutletId = await resolveObjectId(Outlet, requested);
    if (!adminOutletId) throw new AppError('Outlet not found', 404, 'OUTLET_NOT_FOUND');
    return adminOutletId;
  }

  let allowedIds = outletIdsFor(req.user);
  if (allowedIds.length) {
    const existing = await Outlet.find({ _id: { $in: allowedIds } }).select('_id').lean();
    allowedIds = existing.map((item) => String(item._id));
  }
  if (!allowedIds.length) {
    const repairedId = await repairCurrentSellerAssignment(req);
    if (repairedId) allowedIds = [String(repairedId)];
  }

  if (!allowedIds.length) {
    throw new AppError(
      'No outlet is assigned to this seller account. Ask the administrator to save outlet login credentials again.',
      403,
      'NO_OUTLET_ASSIGNED',
    );
  }

  if (requested) {
    const requestedId = await resolveObjectId(Outlet, requested);
    if (requestedId && allowedIds.includes(String(requestedId))) return requestedId;
    // A stale mobile selection must never lock out the seller. Ignore it and use
    // the authenticated account's current outlet assignment.
  }

  return allowedIds[0];
}
async function orderForUser(req) {
  const order = await findOneCompat(Order, req.params.id);
  if (!order) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');
  if (req.user.role !== 'ADMIN') {
    const outletId = await currentOutlet(req);
    if (String(order.outletId) !== String(outletId)) {
      throw new AppError('Outlet access denied', 403, 'OUTLET_ACCESS_DENIED');
    }
  }
  return order;
}
function productDto(row) {
  const p = row.productId || {};
  const price = Number(row.offerPriceOverride ?? row.priceOverride ?? p.offerPrice ?? p.basePrice ?? 0);
  return {
    ...row.toObject?.() || row,
    id: p.legacyId ?? String(p._id || ''),
    productId: p.legacyId ?? String(p._id || ''),
    mongoProductId: String(p._id || ''),
    product: p,
    name: p.name,
    description: p.description,
    image: p.images?.[0]?.url || '',
    images: p.images || [],
    sku: p.sku,
    categoryId: p.categoryId,
    price,
    sellingPrice: price,
    stock: Number(row.stockQuantity || 0),
    stock_qty: Number(row.stockQuantity || 0),
    stock_quantity: Number(row.stockQuantity || 0),
    isAvailable: Boolean(row.available && row.enabled),
    available: Boolean(row.available && row.enabled),
    availableStock: Math.max(0, Number(row.stockQuantity||0)-Number(row.reservedQuantity||0)),
    lowStock: Math.max(0, Number(row.stockQuantity||0)-Number(row.reservedQuantity||0)) < Number(row.lowStockThreshold||5),
    outOfStock: Math.max(0, Number(row.stockQuantity||0)-Number(row.reservedQuantity||0)) === 0,
    lowStockThreshold: Number(row.lowStockThreshold||5),
    stockInitialized: Boolean(row.stockInitialized),
  };
}
function orderQuery(req, outletId) {
  const q = { outletId };
  if (req.query.status) q.status = String(req.query.status).toUpperCase();
  if (req.query.orderType || req.query.fulfilmentType) q.fulfilmentType = String(req.query.orderType || req.query.fulfilmentType).toUpperCase();
  if (req.query.paymentType || req.query.paymentMethod) q.paymentMethod = String(req.query.paymentType || req.query.paymentMethod).toUpperCase();
  return q;
}

r.get(['/seller/restaurant', '/seller/me', '/seller/profile', '/outlet-manager/profile', '/outlet-manager/me', '/outlet-manager/outlet', '/seller/session/outlet'], ah(async (req, res) => {
  const id = await currentOutlet(req);
  const outlet = await Outlet.findById(id).lean();
  if (!outlet) throw new AppError('Assigned outlet no longer exists. Ask the administrator to save outlet credentials again.', 403, 'ASSIGNED_OUTLET_NOT_FOUND');
  ok(res, outletDto(outlet));
}));

r.put('/seller/restaurant', ah(async (req, res) => {
  const id = await currentOutlet(req);
  const allowed = ['name','gstin','managerName','managerPhone','email','businessRegistration','operatingHours','deliveryRadiusKm','address'];
  const update = {};
  for (const key of allowed) if (req.body[key] !== undefined) update[key] = req.body[key];
  if (req.body.gstinNumber !== undefined) update.gstin = req.body.gstinNumber;
  if (req.body.gstin_number !== undefined) update.gstin = req.body.gstin_number;
  ok(res, await Outlet.findByIdAndUpdate(id, { $set: update }, { new: true, runValidators: true }), 'Outlet updated');
}));

r.patch(['/seller/restaurant/status','/outlet-manager/outlet/status','/seller/outlet/status'], ah(async (req, res) => {
  const id = await currentOutlet(req);
  const open = Boolean(req.body.open ?? req.body.is_open ?? req.body.isOpen);
  if(!open) throw new AppError('Submit the daily sales report before closing the outlet.',409,'DAILY_REPORT_REQUIRED');
  const outlet=await requireBusinessReady(id);
  const updated=await Outlet.findByIdAndUpdate(id, { $set: { open:true } }, { new: true });
  const rows=await OutletProduct.find({outletId:id,enabled:true}).populate('productId').lean();
  const alerts=rows.filter(x=>Math.max(0,Number(x.stockQuantity||0)-Number(x.reservedQuantity||0))<Number(x.lowStockThreshold||5)).map(x=>({productId:String(x.productId?._id||x.productId),name:x.productId?.name||'Food item',availableStock:Math.max(0,Number(x.stockQuantity||0)-Number(x.reservedQuantity||0)),threshold:Number(x.lowStockThreshold||5)}));
  ok(res,{outlet:outletDto(updated),stockAlerts:alerts},alerts.length?'Outlet opened with low-stock alerts':'Outlet opened');
}));

r.get(['/seller/products','/outlet-manager/products'], ah(async (req, res) => {
  const outletId = await currentOutlet(req);
  await requireBusinessReady(outletId);
  const filter = { outletId };
  if (req.query.available !== undefined) filter.available = String(req.query.available) === 'true';
  const rows = await OutletProduct.find(filter).populate('productId').sort({ updatedAt: -1 });
  const search = String(req.query.search || '').trim().toLowerCase();
  const data = rows.map(productDto).filter((x) => !search || String(x.name || '').toLowerCase().includes(search) || String(x.sku || '').toLowerCase().includes(search));
  ok(res, { items: data, products: data, content: data, total: data.length });
}));

r.put('/seller/products/:id', ah(async (req, res) => {
  const outletId = await currentOutlet(req);
  const productId = await resolveObjectId(Product, req.params.id);
  if (!productId) throw new AppError('Product not found', 404);
  const stockQuantity = Number(req.body.stockQuantity ?? req.body.stock ?? req.body.stock_qty);
  if (!Number.isFinite(stockQuantity) || stockQuantity < 0) throw new AppError('Invalid stock quantity', 400);
  const session = await mongoose.startSession();
  let row;
  try {
    await session.withTransaction(async () => {
      row = await OutletProduct.findOne({ outletId, productId }).session(session);
      if (!row) throw new AppError('Product is not assigned to this outlet', 404);
      const before = row.stockQuantity;
      row.stockQuantity = stockQuantity;
      row.available = stockQuantity > 0;
      row.stockInitialized = true;
      row.lastStockUpdatedAt = new Date();
      row.lastStockUpdatedBy = req.user.id;
      await row.save({ session });
      await InventoryMovement.create([{ outletId, productId, type: 'MANUAL_ADJUSTMENT', quantityBefore: before, quantityChanged: stockQuantity-before, quantityAfter: stockQuantity, reservedBefore: row.reservedQuantity, reservedAfter: row.reservedQuantity, referenceType: 'SELLER_STOCK_UPDATE', reason: req.body.note || 'Seller real-time stock update', performedBy: req.user.id, idempotencyKey: req.headers['idempotency-key'] || `seller-stock:${outletId}:${productId}:${Date.now()}` }], { session });
    });
  } finally { await session.endSession(); }
  await row.populate('productId');
  ok(res, productDto(row), stockQuantity > 0 ? 'Stock updated' : 'Product marked out of stock');
}));

r.patch('/seller/products/:id/availability', ah(async (req, res) => {
  const outletId = await currentOutlet(req);
  const productId = await resolveObjectId(Product, req.params.id);
  const available = Boolean(req.body.available ?? req.body.is_available ?? req.body.isAvailable);
  const row = await OutletProduct.findOneAndUpdate({ outletId, productId }, { $set: { available } }, { new: true }).populate('productId');
  if (!row) throw new AppError('Product is not assigned to this outlet', 404);
  ok(res, productDto(row), 'Availability updated');
}));

r.post(['/outlet-manager/stock','/outlet-manager/daily-stock'], ah(async (req, res) => {
  const outletId = await currentOutlet(req);
  await requireBusinessReady(outletId);
  if (Array.isArray(req.body.items) && req.body.items.length) {
    const results = [];
    for (const item of req.body.items) {
      const productId = await resolveObjectId(Product, item.productId);
      if (!productId) throw new AppError('Product not found', 404);
      const after = Number(item.stockQuantity ?? item.stock ?? 0);
      if (!Number.isFinite(after) || after < 0) throw new AppError('Invalid stock quantity', 400);
      const row = await OutletProduct.findOneAndUpdate({ outletId, productId }, { $set: { stockQuantity: after, available: after > 0, stockInitialized:true, lastStockUpdatedAt:new Date(), lastStockUpdatedBy:req.user.id } }, { new: true }).populate('productId');
      if (!row) throw new AppError('Product is not assigned to this outlet', 404);
      results.push(productDto(row));
    }
    return ok(res, { items: results, products: results }, 'Daily stock updated');
  }
  const productId = await resolveObjectId(Product, req.body.productId);
  if (!productId) throw new AppError('Product not found', 404);
  const session = await mongoose.startSession();
  let row;
  try {
    await session.withTransaction(async () => {
      row = await OutletProduct.findOne({ outletId, productId }).session(session);
      if (!row) throw new AppError('Product is not assigned to this outlet', 404);
      const before = row.stockQuantity;
      const after = Number(req.body.stockQuantity ?? req.body.stock ?? 0);
      if (!Number.isFinite(after) || after < 0) throw new AppError('Invalid stock quantity', 400);
      row.stockQuantity = after;
      row.available = after > 0;
      row.stockInitialized = true;
      row.lastStockUpdatedAt = new Date();
      row.lastStockUpdatedBy = req.user.id;
      await row.save({ session });
      await InventoryMovement.create([{ outletId, productId, type: 'MANUAL_ADJUSTMENT', quantityBefore: before, quantityChanged: after - before, quantityAfter: after, reservedBefore: row.reservedQuantity, reservedAfter: row.reservedQuantity, referenceType: 'SELLER_STOCK_UPDATE', reason: req.body.note || 'Seller stock update', performedBy: req.user.id, idempotencyKey: req.headers['idempotency-key'] || `seller-stock:${outletId}:${productId}:${Date.now()}` }], { session });
    });
  } finally { await session.endSession(); }
  await row.populate('productId');
  ok(res, productDto(row), 'Stock updated');
}));


r.get(['/seller/stock-summary','/outlet-manager/stock-summary','/seller/startup-stock'],ah(async(req,res)=>{const outletId=await currentOutlet(req);const rows=await OutletProduct.find({outletId,enabled:true}).populate('productId').sort({updatedAt:-1});const items=rows.map(productDto);ok(res,{items,total:items.length,needsInitialStock:items.some(x=>!x.stockInitialized),lowStockItems:items.filter(x=>x.lowStock),outOfStockItems:items.filter(x=>x.outOfStock)}); }));
r.get(['/seller/orders','/outlet-manager/orders'], ah(async (req, res) => {
  const outletId = await currentOutlet(req);
  await requireBusinessReady(outletId);
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(200, Math.max(1, Number(req.query.per_page || req.query.limit || 80)));
  const q = orderQuery(req, outletId);
  const [items, total] = await Promise.all([
    Order.find(q).populate('customerId riderId outletId').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Order.countDocuments(q),
  ]);
  const data = items.map(orderDto);
  ok(res, { items: data, orders: data, content: data, total, page, per_page: limit });
}));

r.get('/seller/orders/export.csv', ah(async (req, res) => {
  const outletId = await currentOutlet(req);
  const rows = await Order.find(orderQuery(req, outletId)).sort({ createdAt: -1 }).lean();
  const escape = (v) => `"${String(v ?? '').replaceAll('"','""')}"`;
  const csv = ['Order,Date,Status,Type,Payment,Total', ...rows.map((o) => [o.slug,o.createdAt?.toISOString(),o.status,o.fulfilmentType,o.paymentMethod,o.total].map(escape).join(','))].join('\n');
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition','attachment; filename=seller-orders.csv');
  res.send(csv);
}));

r.get('/seller/orders/:id', ah(async (req, res) => {
  const order = await orderForUser(req);
  await order.populate('customerId riderId outletId');
  ok(res, orderDto(order));
}));

for (const [suffix, status] of [['accept','ACCEPTED'],['preparing','PREPARING'],['ready','READY'],['reject','REJECTED'],['cancel','CANCELLED']]) {
  r.post(`/seller/orders/:id/${suffix}`, ah(async (req, res) => {
    const order = await orderForUser(req);
    await requireBusinessReady(order.outletId);
    const updated = await orderService.changeStatus(order, req.user, status, req.body.reason || req.body.note, req.headers['idempotency-key']);
    ok(res, updated, `Order ${suffix}ed`);
  }));
}

r.get('/seller/orders/:id/invoice.pdf', ah(async (req, res) => {
  const order = await orderForUser(req);
  await order.populate('customerId outletId');
  return invoiceService.stream(order, res);
}));

r.post('/seller/orders/:id/invoice/send-to-customer', ah(async (req, res) => {
  const order = await orderForUser(req);
  await Notification.create({ userId: order.customerId, outletId: order.outletId, role: 'CUSTOMER', title: 'Invoice ready', message: `Invoice for ${order.slug} is ready to download.`, type: 'INVOICE_READY', data: { orderId: order._id } });
  ok(res, null, 'Invoice notification sent to customer');
}));


r.post('/outlet-manager/offline-sales', ah(async (req, res) => {
  const outletId = await currentOutlet(req);
  await requireBusinessReady(outletId);
  const key = req.headers['idempotency-key'] || req.body.idempotencyKey;
  if (!key) throw new AppError('Idempotency-Key is required', 400, 'IDEMPOTENCY_KEY_REQUIRED');
  const existing = await OfflineSale.findOne({ idempotencyKey: key });
  if (existing) return ok(res, existing, 'Offline sale already processed');
  const itemsInput = Array.isArray(req.body.items) ? req.body.items : [];
  if (!itemsInput.length) throw new AppError('At least one sold item is required', 400, 'ITEMS_REQUIRED');
  const session = await mongoose.startSession();
  let sale;
  try {
    await session.withTransaction(async () => {
      let subtotal = 0;
      const items = [];
      for (const item of itemsInput) {
        const productId = await resolveObjectId(Product, item.productId);
        if (!productId) throw new AppError('Product not found', 404);
        const quantity = Number(item.quantity);
        if (!Number.isInteger(quantity) || quantity <= 0) throw new AppError('Invalid sold quantity', 400);
        const row = await OutletProduct.findOne({ outletId, productId }).populate('productId').session(session);
        if (!row || row.stockQuantity < quantity) throw new AppError('Insufficient outlet stock', 409, 'INSUFFICIENT_STOCK');
        const before = row.stockQuantity;
        const price = Number(row.offerPriceOverride ?? row.priceOverride ?? row.productId.offerPrice ?? row.productId.basePrice ?? 0);
        row.stockQuantity -= quantity;
        await row.save({ session });
        const total = Number((price * quantity).toFixed(2));
        items.push({ productId, name: row.productId.name, quantity, unitPrice: price, total });
        subtotal += total;
        await InventoryMovement.create([{ outletId, productId, type: 'OFFLINE_SALE', quantityBefore: before, quantityChanged: -quantity, quantityAfter: row.stockQuantity, reservedBefore: row.reservedQuantity, reservedAfter: row.reservedQuantity, referenceType: 'OFFLINE_SALE', reason: req.body.note || 'Seller offline sale', performedBy: req.user.id, idempotencyKey: `${key}:${productId}` }], { session });
      }
      const tax = Number(req.body.tax || 0);
      [sale] = await OfflineSale.create([{ outletId, sellerId: req.user.id, items, subtotal: Number(subtotal.toFixed(2)), tax, total: Number((subtotal + tax).toFixed(2)), paymentMode: req.body.paymentMode || 'CASH', idempotencyKey: key }], { session });
    });
  } finally { await session.endSession(); }
  ok(res, sale, 'Offline sale recorded', 201);
}));

r.get('/outlet-manager/dashboard', ah(async (req, res) => {
  const outletId = await currentOutlet(req);
  await requireBusinessReady(outletId);
  const start = req.query.from ? new Date(req.query.from) : new Date(new Date().setHours(0,0,0,0));
  const end = req.query.to ? new Date(req.query.to) : new Date();
  const [orders, inventory, offlineSales] = await Promise.all([
    Order.find({ outletId, createdAt: { $gte: start, $lte: end } }).lean(),
    OutletProduct.find({ outletId }).populate('productId').lean(),
    OfflineSale.find({ outletId, createdAt: { $gte: start, $lte: end } }).lean(),
  ]);
  const delivered = orders.filter((o) => o.status === 'DELIVERED');
  const onlineRevenue = delivered.reduce((s,o) => s + Number(o.total || 0), 0);
  const offlineRevenue = offlineSales.reduce((s,o) => s + Number(o.total || 0), 0);
  ok(res, {
    outletId,
    todayOrders: orders.length,
    pendingOrders: orders.filter((o) => !['DELIVERED','CANCELLED','REJECTED'].includes(o.status)).length,
    completedOrders: delivered.length,
    cancelledOrders: orders.filter((o) => ['CANCELLED','REJECTED'].includes(o.status)).length,
    revenue: onlineRevenue + offlineRevenue,
    onlineRevenue,
    offlineRevenue,
    lowStockCount: inventory.filter((x) => x.stockQuantity <= x.lowStockThreshold).length,
    outOfStockCount: inventory.filter((x) => x.stockQuantity <= 0).length,
    inventory: inventory.map(productDto),
    stock: inventory.map(productDto),
    orderCount: orders.length,
    orders: orders.length,
    totalSales: onlineRevenue + offlineRevenue,
    availableProducts: inventory.filter((x) => x.available && x.enabled && x.stockQuantity > 0).length,
    lowStock: inventory.filter((x) => x.stockQuantity <= x.lowStockThreshold).length,
    recentOrders: orders.slice(0, 20),
  });
}));

r.get('/outlet-manager/stock-ledger', ah(async (req, res) => {
  const outletId = await currentOutlet(req);
  ok(res, await InventoryMovement.find({ outletId }).populate('productId').sort({ createdAt: -1 }).limit(500).lean());
}));

r.post(['/outlet-manager/close-day','/outlet-manager/day-close','/outlet-manager/end-of-day','/seller/day-close','/seller/end-of-day'], ah(async (req, res) => {
  const outletId = await currentOutlet(req);
  await requireBusinessReady(outletId);
  const businessDate = req.body.businessDate || req.body.date || new Date().toISOString().slice(0,10);
  const inventory = await OutletProduct.find({ outletId, enabled:true }).lean();
  const requested=Array.isArray(req.body.items)?req.body.items:[];
  const byId=new Map(requested.map(x=>[String(x.productId||x.id),x]));
  const start = new Date(`${businessDate}T00:00:00.000Z`), end = new Date(`${businessDate}T23:59:59.999Z`);
  const [orders, offline, firstMoves, previousClosing] = await Promise.all([
    Order.find({ outletId, status:'DELIVERED', deliveredAt:{ $gte:start,$lte:end } }).lean(),
    OfflineSale.find({ outletId, createdAt:{ $gte:start,$lte:end } }).lean(),
    InventoryMovement.aggregate([{ $match:{outletId:new mongoose.Types.ObjectId(String(outletId)),createdAt:{$gte:start,$lte:end}}},{ $sort:{createdAt:1}},{ $group:{_id:'$productId',openingStock:{$first:'$quantityBefore'}}}]),
    DailyClosing.findOne({outletId,businessDate:{$lt:businessDate}}).sort({businessDate:-1}).lean(),
  ]);
  const moveMap=new Map(firstMoves.map(x=>[String(x._id),Number(x.openingStock||0)]));
  const prevMap=new Map((previousClosing?.stockSnapshot||[]).map(x=>[String(x.productId),Number(x.stockQuantity||0)]));
  const stockSnapshot=inventory.map(x=>{const input=byId.get(String(x.productId));const closingStock=Number(input?.stockQuantity??input?.stock??x.stockQuantity??0);return{productId:x.productId,openingStock:Number(moveMap.get(String(x.productId))??prevMap.get(String(x.productId))??x.stockQuantity??0),stockQuantity:closingStock,reservedQuantity:Number(x.reservedQuantity||0),availableStock:Math.max(0,closingStock-Number(x.reservedQuantity||0)),lowStockThreshold:Number(x.lowStockThreshold||5)};});
  const onlineSales=orders.filter(x=>['ONLINE','WALLET','TAKEAWAY_ADVANCE'].includes(x.paymentMethod)).reduce((a,x)=>a+Number(x.paidAmount||x.total||0),0);
  const codSales=orders.filter(x=>x.paymentMethod==='COD').reduce((a,x)=>a+Number(x.total||0),0);
  const recordedOffline=offline.reduce((a,x)=>a+Number(x.total||0),0);
  const offlineCashSales=Number(req.body.offlineCashSales??req.body.cashSales??0),offlineUpiSales=Number(req.body.offlineUpiSales??req.body.upiSales??0),offlineCardSales=Number(req.body.offlineCardSales??req.body.cardSales??0),offlineOtherSales=Number(req.body.offlineOtherSales??req.body.otherSales??0);
  const offlineSales=Math.max(recordedOffline,Number(req.body.offlineSales||0),offlineCashSales+offlineUpiSales+offlineCardSales+offlineOtherSales);
  const session=await mongoose.startSession();let closing;
  try{await session.withTransaction(async()=>{for(const snap of stockSnapshot){await OutletProduct.updateOne({outletId,productId:snap.productId},{$set:{stockQuantity:snap.stockQuantity,available:snap.availableStock>0,stockInitialized:true,lastStockUpdatedAt:new Date(),lastStockUpdatedBy:req.user.id}},{session});}closing=await DailyClosing.findOneAndUpdate({outletId,businessDate},{$set:{sellerId:req.user.id,stockSnapshot,onlineSales,codSales,offlineSales,offlineCashSales,offlineUpiSales,offlineCardSales,offlineOtherSales,offlineOrderCount:Number(req.body.offlineOrderCount||0),refunds:Number(req.body.refunds||0),expenses:Number(req.body.expenses||0),totalSales:onlineSales+codSales+offlineSales,status:'SUBMITTED',notes:req.body.notes||req.body.note||'',submittedAt:new Date()}},{upsert:true,new:true,runValidators:true,session,setDefaultsOnInsert:true});await Outlet.updateOne({_id:outletId},{$set:{open:false}},{session});});}finally{await session.endSession();}
  ok(res,{closing,outletOpen:false},'Daily sales report submitted and outlet closed');
}));

r.get('/seller/reviews', ah(async (req, res) => {
  const outletId = await currentOutlet(req);
  ok(res, await Review.find({ outletId }).populate('customerId productId').sort({ createdAt: -1 }).lean());
}));

r.get('/seller/offers', ah(async (req, res) => {
  const outletId = await currentOutlet(req);
  ok(res, await Offer.find({ $or: [{ outletIds: outletId }, { outletIds: { $size: 0 } }] }).sort({ createdAt: -1 }).lean());
}));

r.get('/seller/verification/status', ah(async (req, res) => ok(res, await VerificationRequest.findOne({ userId: req.user.id }).sort({ createdAt: -1 }).lean())));
r.post('/seller/verification/restaurant/:id', ah(async (req, res) => {
  const outletId = await resolveObjectId(Outlet, req.params.id);
  ensureOutlet(req.user, outletId);
  ok(res, await VerificationRequest.create({ userId: req.user.id, outletId, type: 'SELLER', status: 'PENDING', documents: req.body.documents || [], note: req.body.note }), 'Verification submitted', 201);
}));

module.exports = r;
