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

function outletIdsFor(user) {
  return (user.assignedOutletIds || []).map((id) => String(id));
}
function ensureOutlet(user, outletId) {
  if (user.role === 'ADMIN') return;
  if (!outletIdsFor(user).includes(String(outletId))) {
    throw new AppError('Outlet access denied', 403, 'OUTLET_ACCESS_DENIED');
  }
}
async function currentOutlet(req) {
  const requested = req.query.outletId || req.body?.outletId || req.body?.restaurantId;
  if (requested) {
    const id = await resolveObjectId(Outlet, requested);
    if (!id) throw new AppError('Outlet not found', 404, 'OUTLET_NOT_FOUND');
    ensureOutlet(req.user, id);
    return id;
  }
  const first = req.user.assignedOutletIds?.[0];
  if (!first && req.user.role !== 'ADMIN') throw new AppError('No outlet assigned', 403, 'NO_OUTLET_ASSIGNED');
  return first;
}
async function orderForUser(req) {
  const order = await findOneCompat(Order, req.params.id);
  if (!order) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');
  ensureOutlet(req.user, order.outletId);
  return order;
}
function productDto(row) {
  const p = row.productId || {};
  const price = Number(row.offerPriceOverride ?? row.priceOverride ?? p.offerPrice ?? p.basePrice ?? 0);
  return {
    ...row.toObject?.() || row,
    productId: p,
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
  };
}
function orderQuery(req, outletId) {
  const q = { outletId };
  if (req.query.status) q.status = String(req.query.status).toUpperCase();
  if (req.query.orderType || req.query.fulfilmentType) q.fulfilmentType = String(req.query.orderType || req.query.fulfilmentType).toUpperCase();
  if (req.query.paymentType || req.query.paymentMethod) q.paymentMethod = String(req.query.paymentType || req.query.paymentMethod).toUpperCase();
  return q;
}

r.get(['/seller/restaurant', '/outlet-manager/me', '/outlet-manager/outlet'], ah(async (req, res) => {
  const id = await currentOutlet(req);
  ok(res, await Outlet.findById(id).lean());
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

r.patch('/seller/restaurant/status', ah(async (req, res) => {
  const id = await currentOutlet(req);
  const open = Boolean(req.body.open ?? req.body.is_open ?? req.body.isOpen);
  ok(res, await Outlet.findByIdAndUpdate(id, { $set: { open } }, { new: true }), open ? 'Outlet opened' : 'Outlet closed');
}));

r.get(['/seller/products','/outlet-manager/products'], ah(async (req, res) => {
  const outletId = await currentOutlet(req);
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
  const update = {};
  if (req.body.stockQuantity !== undefined || req.body.stock !== undefined || req.body.stock_qty !== undefined) update.stockQuantity = Number(req.body.stockQuantity ?? req.body.stock ?? req.body.stock_qty);
  if (req.body.lowStockThreshold !== undefined || req.body.lowStockAlert !== undefined) update.lowStockThreshold = Number(req.body.lowStockThreshold ?? req.body.lowStockAlert);
  if (req.body.price !== undefined || req.body.sellingPrice !== undefined) update.priceOverride = Number(req.body.price ?? req.body.sellingPrice);
  if (req.body.offerPrice !== undefined) update.offerPriceOverride = Number(req.body.offerPrice);
  if (req.body.preparationMinutes !== undefined) update.preparationMinutes = Number(req.body.preparationMinutes);
  if (req.body.available !== undefined || req.body.isAvailable !== undefined) update.available = Boolean(req.body.available ?? req.body.isAvailable);
  const row = await OutletProduct.findOneAndUpdate({ outletId, productId }, { $set: update }, { new: true, runValidators: true }).populate('productId');
  if (!row) throw new AppError('Product is not assigned to this outlet', 404);
  ok(res, productDto(row), 'Product updated');
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
      row.lowStockThreshold = Number(req.body.lowStockAlert ?? req.body.lowStockThreshold ?? row.lowStockThreshold);
      row.preparationMinutes = Number(req.body.preparationMinutes ?? row.preparationMinutes);
      row.available = Boolean(req.body.isAvailable ?? req.body.available ?? row.available);
      await row.save({ session });
      await InventoryMovement.create([{ outletId, productId, type: 'MANUAL_ADJUSTMENT', quantityBefore: before, quantityChanged: after - before, quantityAfter: after, reservedBefore: row.reservedQuantity, reservedAfter: row.reservedQuantity, referenceType: 'SELLER_STOCK_UPDATE', reason: req.body.note || 'Seller stock update', performedBy: req.user.id, idempotencyKey: req.headers['idempotency-key'] || `seller-stock:${outletId}:${productId}:${Date.now()}` }], { session });
    });
  } finally { await session.endSession(); }
  await row.populate('productId');
  ok(res, productDto(row), 'Stock updated');
}));

r.get(['/seller/orders','/outlet-manager/orders'], ah(async (req, res) => {
  const outletId = await currentOutlet(req);
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(200, Math.max(1, Number(req.query.per_page || req.query.limit || 80)));
  const q = orderQuery(req, outletId);
  const [items, total] = await Promise.all([
    Order.find(q).populate('customerId riderId outletId').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Order.countDocuments(q),
  ]);
  ok(res, { items, orders: items, content: items, total, page, per_page: limit });
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
  ok(res, order);
}));

for (const [suffix, status] of [['accept','ACCEPTED'],['preparing','PREPARING'],['ready','READY'],['reject','REJECTED'],['cancel','CANCELLED']]) {
  r.post(`/seller/orders/:id/${suffix}`, ah(async (req, res) => {
    const order = await orderForUser(req);
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
    recentOrders: orders.slice(0, 20),
  });
}));

r.get('/outlet-manager/stock-ledger', ah(async (req, res) => {
  const outletId = await currentOutlet(req);
  ok(res, await InventoryMovement.find({ outletId }).populate('productId').sort({ createdAt: -1 }).limit(500).lean());
}));

r.post(['/outlet-manager/close-day','/outlet-manager/day-close','/outlet-manager/end-of-day'], ah(async (req, res) => {
  const outletId = await currentOutlet(req);
  const businessDate = req.body.businessDate || req.body.date || new Date().toISOString().slice(0,10);
  const inventory = await OutletProduct.find({ outletId }).lean();
  const start = new Date(`${businessDate}T00:00:00.000Z`);
  const end = new Date(`${businessDate}T23:59:59.999Z`);
  const [orders, offline] = await Promise.all([
    Order.find({ outletId, status: 'DELIVERED', deliveredAt: { $gte: start, $lte: end } }).lean(),
    OfflineSale.find({ outletId, createdAt: { $gte: start, $lte: end } }).lean(),
  ]);
  const calculatedOffline = offline.reduce((a,x) => a + Number(x.total || 0), 0);
  const closing = await DailyClosing.findOneAndUpdate(
    { outletId, businessDate },
    { $set: { sellerId: req.user.id, stockSnapshot: inventory.map((x) => ({ productId: x.productId, stockQuantity: x.stockQuantity, reservedQuantity: x.reservedQuantity })), onlineSales: orders.reduce((a,x) => a + Number(x.total || 0), 0), offlineSales: calculatedOffline || Number(req.body.offlineSales || 0), totalSales: orders.reduce((a,x) => a + Number(x.total || 0), 0) + (calculatedOffline || Number(req.body.offlineSales || 0)), notes: req.body.note || req.body.notes, submittedAt: new Date() } },
    { upsert: true, new: true, runValidators: true }
  );
  ok(res, closing, 'End-of-day report submitted');
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
