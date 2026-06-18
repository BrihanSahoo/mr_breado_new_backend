const r = require('express').Router();
const ah = require('../utils/asyncHandler');
const { ok, embeddedLegacyId } = require('../utils/respond');
const { requireAuth, allowRoles } = require('../middleware/auth');
const {
  User, Outlet, Category, Banner, Offer, Product, OutletProduct, Cart, Order,
  OrderEvent, Review, RiderLocation, Payment, Notification, SupportTicket
} = require('../models');
const settings = require('../services/settingsService');
const orderService = require('../services/orderService');
const paymentService = require('../services/paymentService');
const invoiceService = require('../services/invoiceService');
const { haversineKm, deliveryCharge } = require('../utils/geo');
const { AppError } = require('../utils/errors');
const { serializeVariantFields } = require('../utils/productVariants');
const { findOneCompat, resolveObjectId, findEmbeddedByCompatId } = require('../utils/compatId');

const activeOutlet = { active: true, open: true };
const numberOrNull = (v) => Number.isFinite(Number(v)) ? Number(v) : null;
const readLat = (x = {}) => numberOrNull(x.latitude ?? x.lat ?? x.userLat ?? x.userLatitude ?? x.user_latitude);
const readLng = (x = {}) => numberOrNull(x.longitude ?? x.lng ?? x.userLng ?? x.userLongitude ?? x.user_longitude);
const text = (v) => String(v ?? '').trim();

async function nearestOutlet(lat, lng) {
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    const rows = await Outlet.aggregate([
      { $geoNear: { near: { type: 'Point', coordinates: [lng, lat] }, distanceField: 'distanceMeters', spherical: true, query: activeOutlet } },
      { $addFields: { distanceKm: { $divide: ['$distanceMeters', 1000] } } },
      { $match: { $expr: { $lte: ['$distanceKm', '$deliveryRadiusKm'] } } },
      { $sort: { primary: -1, distanceMeters: 1 } },
      { $limit: 1 }
    ]);
    if (rows[0]) return rows[0];
  }
  return Outlet.findOne({ ...activeOutlet, primary: true }).lean()
    || Outlet.findOne(activeOutlet).sort({ primary: -1, createdAt: 1 }).lean();
}

async function resolveOutlet(value) {
  return findOneCompat(Outlet, value, activeOutlet);
}

async function menu(outletId, query = {}) {
  const rows = await OutletProduct.find({ outletId, enabled: true, available: true })
    .populate({ path: 'productId', match: { active: true }, populate: [{ path: 'categoryId' }, { path: 'brandId' }] })
    .populate('outletId')
    .lean();
  const search = text(query.search ?? query.q).toLowerCase();
  const category = text(query.categoryId ?? query.category).toLowerCase();
  return rows
    .filter((row) => row.productId && row.outletId && row.stockQuantity - row.reservedQuantity > 0)
    .filter((row) => !search || [row.productId.name, row.productId.description, row.productId.sku].some((v) => text(v).toLowerCase().includes(search)))
    .filter((row) => !category || [
      String(row.productId.categoryId?._id || ''),
      String(row.productId.categoryId?.legacyId || ''),
      text(row.productId.categoryId?.slug).toLowerCase(),
      text(row.productId.categoryId?.name).toLowerCase()
    ].includes(category))
    .map((row) => ({
      ...row.productId,
      ...serializeVariantFields(row.productId),
      outletProductId: row._id,
      outletId: row.outletId._id,
      restaurantId: row.outletId.legacyId,
      restaurant_id: row.outletId.legacyId,
      outlet: row.outletId,
      restaurant: row.outletId,
      stockQuantity: row.stockQuantity,
      stock_quantity: row.stockQuantity,
      reservedQuantity: row.reservedQuantity,
      availableStock: row.stockQuantity - row.reservedQuantity,
      available: row.available,
      enabled: row.enabled,
      price: row.offerPriceOverride ?? row.priceOverride ?? (row.productId.offerPrice > 0 ? row.productId.offerPrice : row.productId.basePrice),
      effectivePrice: row.offerPriceOverride ?? row.priceOverride ?? (row.productId.offerPrice > 0 ? row.productId.offerPrice : row.productId.basePrice),
      preparationMinutes: row.preparationMinutes
    }));
}

async function addressForUser(userId, compatId) {
  const user = await User.findById(userId);
  if (!user) throw new AppError('User not found', 404);
  const address = findEmbeddedByCompatId(user.addresses, compatId);
  if (!address) throw new AppError('Address not found', 404);
  return { user, address };
}

async function cartForUser(userId) {
  return Cart.findOne({ customerId: userId }).populate('items.productId outletId');
}

async function resolveCartProduct(value) {
  const product = await findOneCompat(Product, value, { active: true });
  if (!product) throw new AppError('Food not found', 404);
  return product;
}

async function resolveCartOutlet(productId, requestedOutlet) {
  if (requestedOutlet != null && text(requestedOutlet)) {
    const outlet = await resolveOutlet(requestedOutlet);
    if (!outlet) throw new AppError('Outlet not found', 404);
    const available = await OutletProduct.exists({ outletId: outlet._id, productId, enabled: true, available: true, stockQuantity: { $gt: 0 } });
    if (!available) throw new AppError('Food is not available in this outlet', 409);
    return outlet;
  }
  const row = await OutletProduct.findOne({ productId, enabled: true, available: true, stockQuantity: { $gt: 0 } }).populate('outletId').sort({ createdAt: 1 });
  if (!row?.outletId?.active || !row.outletId.open) throw new AppError('Food is not available at an active outlet', 409);
  return row.outletId;
}

// Public compatibility endpoints used by the existing customer app.
r.get('/platform/settings', ah(async (req, res) => ok(res, await settings.publicSettings())));
r.get('/home', ah(async (req, res) => {
  const outlet = await nearestOutlet(readLat(req.query), readLng(req.query));
  const [categories, banners, offers, outlets, products] = await Promise.all([
    Category.find({ active: true }).sort({ sortOrder: 1, name: 1 }).lean(),
    Banner.find({ active: true }).sort({ sortOrder: 1 }).lean(),
    Offer.find({ active: true, startAt: { $lte: new Date() }, endAt: { $gte: new Date() } }).lean(),
    Outlet.find(activeOutlet).sort({ primary: -1, createdAt: 1 }).limit(30).lean(),
    outlet ? menu(outlet._id, req.query) : []
  ]);
  ok(res, { banners, categories, offers, outlets, restaurants: outlets, products, items: products, featured_foods: products, popular_foods: products, nearestOutlet: outlet });
}));
r.get('/products', ah(async (req, res) => {
  const requested = req.query.outletId ?? req.query.outlet_id ?? req.query.restaurantId ?? req.query.restaurant_id ?? req.query.store;
  const outlet = requested ? await resolveOutlet(requested) : await nearestOutlet(readLat(req.query), readLng(req.query));
  ok(res, outlet ? await menu(outlet._id, req.query) : []);
}));
r.get('/outlets/nearest', ah(async (req, res) => {
  const outlet = await nearestOutlet(readLat(req.query), readLng(req.query));
  if (!outlet) throw new AppError('No serviceable outlet found', 404);
  ok(res, outlet);
}));
r.get('/menu/nearest', ah(async (req, res) => {
  const outlet = await nearestOutlet(readLat(req.query), readLng(req.query));
  if (!outlet) throw new AppError('No serviceable outlet found', 404);
  const products = await menu(outlet._id, req.query);
  ok(res, { outlet, products, items: products });
}));
r.get('/outlets/:id/menu', ah(async (req, res) => {
  const outlet = await resolveOutlet(req.params.id);
  if (!outlet) throw new AppError('Outlet not found', 404);
  ok(res, { outlet, products: await menu(outlet._id, req.query), items: await menu(outlet._id, req.query) });
}));
r.get('/outlets/:id/contact', ah(async (req, res) => {
  const outlet = await resolveOutlet(req.params.id);
  if (!outlet) throw new AppError('Outlet not found', 404);
  ok(res, { outletId: outlet.legacyId, name: outlet.name, managerName: outlet.managerName, phone: outlet.managerPhone, email: outlet.email, address: outlet.address, latitude: outlet.location.coordinates[1], longitude: outlet.location.coordinates[0] });
}));

r.use(requireAuth, allowRoles('CUSTOMER', 'ADMIN'));

// Addresses with embedded numeric compatibility IDs.
r.get('/user/addresses', ah(async (req, res) => ok(res, (await User.findById(req.user.id).lean())?.addresses || [])));
r.post('/user/addresses', ah(async (req, res) => {
  const user = await User.findById(req.user.id);
  if (req.body.isDefault ?? req.body.is_default) user.addresses.forEach((a) => { a.isDefault = false; });
  user.addresses.push({
    label: req.body.label ?? req.body.type,
    line1: req.body.line1 ?? req.body.address ?? req.body.addressLine ?? req.body.address_line,
    line2: req.body.line2,
    area: req.body.area,
    city: req.body.city,
    state: req.body.state,
    pincode: req.body.pincode ?? req.body.zipcode,
    landmark: req.body.landmark,
    latitude: req.body.latitude,
    longitude: req.body.longitude,
    isDefault: Boolean(req.body.isDefault ?? req.body.is_default)
  });
  await user.save();
  ok(res, user.addresses.at(-1), 'Address added', 201);
}));
r.put('/user/addresses/:id', ah(async (req, res) => {
  const { user, address } = await addressForUser(req.user.id, req.params.id);
  Object.assign(address, {
    label: req.body.label ?? req.body.type ?? address.label,
    line1: req.body.line1 ?? req.body.address ?? req.body.addressLine ?? req.body.address_line ?? address.line1,
    line2: req.body.line2 ?? address.line2,
    area: req.body.area ?? address.area,
    city: req.body.city ?? address.city,
    state: req.body.state ?? address.state,
    pincode: req.body.pincode ?? req.body.zipcode ?? address.pincode,
    landmark: req.body.landmark ?? address.landmark,
    latitude: req.body.latitude ?? address.latitude,
    longitude: req.body.longitude ?? address.longitude
  });
  if (req.body.isDefault ?? req.body.is_default) user.addresses.forEach((a) => { a.isDefault = a._id.equals(address._id); });
  await user.save(); ok(res, address, 'Address updated');
}));
r.delete('/user/addresses/:id', ah(async (req, res) => {
  const { user, address } = await addressForUser(req.user.id, req.params.id); address.deleteOne(); await user.save(); ok(res, null, 'Address deleted');
}));
r.all('/user/addresses/:id/default', ah(async (req, res) => {
  const { user, address } = await addressForUser(req.user.id, req.params.id); user.addresses.forEach((a) => { a.isDefault = a._id.equals(address._id); }); await user.save(); ok(res, address, 'Default address updated');
}));

// Cart operations. The outlet is inferred safely when old clients omit outletId.
r.get('/cart', ah(async (req, res) => ok(res, await cartForUser(req.user.id))));
r.post('/cart/items', ah(async (req, res) => {
  const product = await resolveCartProduct(req.body.productId ?? req.body.product_id);
  const outlet = await resolveCartOutlet(product._id, req.body.outletId ?? req.body.outlet_id ?? req.body.restaurantId ?? req.body.restaurant_id);
  const quantity = Math.max(1, Number(req.body.quantity || 1));
  const inventory = await OutletProduct.findOne({ outletId: outlet._id, productId: product._id, enabled: true, available: true });
  if (!inventory || inventory.stockQuantity - inventory.reservedQuantity < quantity) throw new AppError('Food is out of stock', 409);
  let cart = await Cart.findOne({ customerId: req.user.id });
  if (cart && String(cart.outletId) !== String(outlet._id)) throw new AppError('Cart has items from a different outlet. Clear cart first.', 409);
  if (!cart) cart = new Cart({ customerId: req.user.id, outletId: outlet._id, items: [] });
  const selectedLabel = text(req.body.selectedSize ?? req.body.selected_size ?? req.body.selectedWeight ?? req.body.selected_weight);
  const requestedOptionIds = Array.isArray(req.body.customizationOptionIds ?? req.body.customization_option_ids) ? (req.body.customizationOptionIds ?? req.body.customization_option_ids).map(String) : [];
  const selectedCustomizations = [];
  for (const group of product.customizationGroups || []) {
    for (const option of group.options || []) {
      const matchesId = requestedOptionIds.includes(String(option._id));
      const matchesLabel = selectedLabel && text(option.name).toLowerCase() === selectedLabel.toLowerCase();
      if (matchesId || matchesLabel) selectedCustomizations.push({ groupName: group.name, optionName: option.name, price: Number(option.price || 0) });
    }
  }
  if (selectedLabel && !selectedCustomizations.length) throw new AppError('Selected food size or weight is not available', 400, 'INVALID_VARIANT');
  const cakeMessage = text(req.body.cakeMessage ?? req.body.cake_message);
  if (cakeMessage && product.cakeMessageEnabled) selectedCustomizations.push({ groupName: 'Cake Message Text', optionName: cakeMessage, price: Number(product.cakeMessageCharge || 0) });
  const existing = cart.items.find((item) => String(item.productId) === String(product._id) && JSON.stringify(item.customizations || []) === JSON.stringify(selectedCustomizations));
  if (existing) existing.quantity += quantity;
  else cart.items.push({ productId: product._id, quantity, customizations: selectedCustomizations });
  await cart.save(); ok(res, await cartForUser(req.user.id), 'Cart updated', 201);
}));
r.put('/cart/items/:id', ah(async (req, res) => {
  const cart = await Cart.findOne({ customerId: req.user.id });
  const item = findEmbeddedByCompatId(cart?.items, req.params.id);
  if (!item) throw new AppError('Cart item not found', 404);
  item.quantity = Number(req.body.quantity);
  if (item.quantity <= 0) item.deleteOne();
  await cart.save(); ok(res, await cartForUser(req.user.id));
}));
r.delete('/cart/items/:id', ah(async (req, res) => {
  const cart = await Cart.findOne({ customerId: req.user.id });
  const item = findEmbeddedByCompatId(cart?.items, req.params.id);
  if (!item) throw new AppError('Cart item not found', 404);
  item.deleteOne(); await cart.save(); ok(res, await cartForUser(req.user.id));
}));
r.delete(['/cart', '/cart/clear'], ah(async (req, res) => { await Cart.deleteMany({ customerId: req.user.id }); ok(res, null, 'Cart cleared'); }));

async function checkoutContext(req) {
  const cart = await Cart.findOne({ customerId: req.user.id });
  if (!cart?.items?.length) throw new AppError('Cart is empty', 400);
  const addressId = req.body.addressId ?? req.body.address_id;
  let address = null;
  if (String(req.body.orderType ?? req.body.order_type ?? req.body.fulfilmentType ?? 'DELIVERY').toUpperCase() !== 'TAKEAWAY') {
    ({ address } = await addressForUser(req.user.id, addressId));
  }
  return { cart, address };
}
r.post('/checkout/summary', ah(async (req, res) => {
  const { cart, address } = await checkoutContext(req);
  const pricing = await orderService.buildPricing({ outletId: cart.outletId, items: cart.items, address, fulfilmentType: req.body.orderType ?? req.body.order_type ?? req.body.fulfilmentType ?? 'DELIVERY', couponCode: req.body.promoCode ?? req.body.promo_code });
  ok(res, { ...pricing, items: pricing.snapshots, cart, restaurant: pricing.outlet, outlet: pricing.outlet });
}));

async function deliveryValidation(req, res) {
  const source = { ...req.query, ...req.body };
  const cart = await Cart.findOne({ customerId: req.user.id });
  const outlet = source.outletId || source.restaurantId ? await resolveOutlet(source.outletId ?? source.restaurantId) : cart ? await Outlet.findById(cart.outletId) : await nearestOutlet(readLat(source), readLng(source));
  if (!outlet) throw new AppError('Outlet not found', 404);
  let lat = readLat(source), lng = readLng(source);
  if ((!Number.isFinite(lat) || !Number.isFinite(lng)) && (source.addressId ?? source.address_id)) {
    const result = await addressForUser(req.user.id, source.addressId ?? source.address_id); lat = Number(result.address.latitude); lng = Number(result.address.longitude);
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new AppError('Latitude and longitude are required');
  const [outletLng, outletLat] = outlet.location.coordinates;
  const distanceKm = Number(haversineKm(outletLat, outletLng, lat, lng).toFixed(2));
  const charge = deliveryCharge(distanceKm, outlet.deliverySettings || {});
  ok(res, { outletId: outlet.legacyId, distanceKm, deliveryRadiusKm: outlet.deliveryRadiusKm, serviceable: distanceKm <= outlet.deliveryRadiusKm, deliverable: distanceKm <= outlet.deliveryRadiusKm, canDeliver: distanceKm <= outlet.deliveryRadiusKm, deliveryCharge: charge });
}
r.post(['/delivery/validate', '/orders/validate-delivery'], ah(deliveryValidation));

async function createOrderFromCart(req, paymentMethod) {
  const { cart, address } = await checkoutContext(req);
  return orderService.createOrder({
    customerId: req.user.id,
    outletId: cart.outletId,
    items: cart.items,
    address,
    fulfilmentType: req.body.orderType ?? req.body.order_type ?? req.body.fulfilmentType ?? 'DELIVERY',
    paymentMethod,
    clientRequestId: req.headers['idempotency-key'] ?? req.body.clientRequestId ?? `customer:${req.user.id}:${Date.now()}`
  });
}

r.post(['/payments/create-order', '/payment/create-order', '/razorpay/create-order', '/payments/razorpay/create-order', '/checkout/razorpay/create-order', '/checkout/payment/create-order'], ah(async (req, res) => {
  let order = req.body.orderId || req.body.appOrderId ? await findOneCompat(Order, req.body.orderId ?? req.body.appOrderId, { customerId: req.user.id }) : null;
  if (!order) order = await createOrderFromCart(req, 'ONLINE');
  const data = await paymentService.createOrder({ orderId: order._id, userId: req.user.id, idempotencyKey: req.headers['idempotency-key'] ?? `payment:${order._id}` });
  ok(res, { ...data, appOrderId: order.legacyId, orderId: order.legacyId, orderSlug: order.slug });
}));
r.post(['/payments/verify', '/payment/verify', '/razorpay/verify', '/payments/razorpay/verify', '/checkout/razorpay/verify', '/checkout/payment/verify'], ah(async (req, res) => ok(res, await paymentService.verify(req.body, req.user), 'Payment verified')));

r.post('/user/orders', ah(async (req, res) => {
  const gatewayOrderId = req.body.razorpayOrderId ?? req.body.razorpay_order_id;
  if (gatewayOrderId) {
    const payment = await Payment.findOne({ gatewayOrderId, customerId: req.user.id, status: 'SUCCESS' }).populate('orderId');
    if (!payment?.orderId) throw new AppError('Verified payment order not found', 409);
    await Cart.deleteMany({ customerId: req.user.id });
    return ok(res, payment.orderId, 'Order confirmed', 201);
  }
  const methodRaw = String(req.body.paymentType ?? req.body.payment_type ?? 'COD').toUpperCase();
  const method = methodRaw.includes('ONLINE') ? 'ONLINE' : methodRaw.includes('WALLET') ? 'WALLET' : 'COD';
  const order = await createOrderFromCart(req, method);
  await Cart.deleteMany({ customerId: req.user.id });
  ok(res, order, 'Order created', 201);
}));

r.get('/user/orders', ah(async (req, res) => ok(res, await Order.find({ customerId: req.user.id }).populate('outletId riderId').sort({ createdAt: -1 }).lean())));
r.get('/user/orders/:id', ah(async (req, res) => {
  const order = await findOneCompat(Order, req.params.id, { customerId: req.user.id });
  if (!order) throw new AppError('Order not found', 404);
  await order.populate('outletId riderId customerId'); ok(res, order);
}));
r.post('/user/orders/:id/cancel', ah(async (req, res) => {
  const order = await findOneCompat(Order, req.params.id, { customerId: req.user.id });
  if (!order) throw new AppError('Order not found', 404);
  ok(res, await orderService.changeStatus(order, req.user, 'CANCELLED', req.body.reason || 'Customer cancelled', req.headers['idempotency-key']));
}));
r.get(['/user/orders/:id/invoice', '/user/orders/:id/invoice.pdf', '/user/orders/:id/transaction-receipt.pdf'], ah(async (req, res) => {
  const order = await findOneCompat(Order, req.params.id, { customerId: req.user.id });
  if (!order) throw new AppError('Order not found', 404);
  await order.populate('outletId customerId'); await invoiceService.stream(order, res);
}));
r.get(['/user/orders/:id/tracking', '/user/orders/:id/live-location'], ah(async (req, res) => {
  const order = await findOneCompat(Order, req.params.id, { customerId: req.user.id });
  if (!order) throw new AppError('Order not found', 404);
  await order.populate('outletId riderId');
  const latest = await RiderLocation.findOne({ orderId: order._id }).sort({ recordedAt: -1 }).lean();
  const location = latest ? { latitude: latest.location?.coordinates?.[1], longitude: latest.location?.coordinates?.[0], heading: latest.heading, speed: latest.speed, updatedAt: latest.recordedAt } : null;
  ok(res, { order, orderStatus: order.status, rider: order.riderId, driver: order.riderId, location, riderLocation: location });
}));

r.get('/reviews/order/:id/eligibility', ah(async (req, res) => {
  const order = await findOneCompat(Order, req.params.id, { customerId: req.user.id });
  const old = order ? await Review.findOne({ orderId: order._id, customerId: req.user.id }) : null;
  ok(res, { orderId: order?.legacyId, orderNumber: order?.slug, eligible: Boolean(order && order.status === 'DELIVERED' && !old), canReview: Boolean(order && order.status === 'DELIVERED' && !old), alreadyReviewed: Boolean(old), reason: !order ? 'Order not found' : order.status !== 'DELIVERED' ? 'Order is not delivered' : old ? 'Already reviewed' : '' });
}));
async function submitReview(req, res) {
  const order = await findOneCompat(Order, req.params.id, { customerId: req.user.id, status: 'DELIVERED' });
  if (!order) throw new AppError('Only delivered orders can be reviewed', 409);
  const review = await Review.findOneAndUpdate({ customerId: req.user.id, orderId: order._id }, { $setOnInsert: { customerId: req.user.id, orderId: order._id, outletId: order.outletId }, $set: { rating: Number(req.body.rating ?? req.body.restaurantRating ?? req.body.restaurant_rating), comment: req.body.comment ?? req.body.restaurantReview ?? req.body.restaurant_review } }, { upsert: true, new: true, runValidators: true });
  ok(res, review, 'Review submitted', 201);
}
r.post(['/reviews/order/:id', '/user/orders/:id/review'], ah(submitReview));
r.post('/user/orders/:id/report', ah(async (req, res) => {
  const order = await findOneCompat(Order, req.params.id, { customerId: req.user.id });
  if (!order) throw new AppError('Order not found', 404);
  ok(res, await SupportTicket.create({ userId: req.user.id, subject: `Order report ${order.slug}`, message: `${req.body.reason || 'Issue'}\n${req.body.details || ''}`, priority: 'HIGH' }), 'Report submitted', 201);
}));

r.get('/notifications', ah(async (req, res) => ok(res, await Notification.find({ userId: req.user.id }).sort({ createdAt: -1 }).lean())));
r.patch('/notifications/:id/read', ah(async (req, res) => {
  const notification = await findOneCompat(Notification, req.params.id, { userId: req.user.id });
  if (!notification) throw new AppError('Notification not found', 404);
  notification.read = true; await notification.save(); ok(res, notification);
}));
r.patch('/notifications/read-all', ah(async (req, res) => { await Notification.updateMany({ userId: req.user.id }, { read: true }); ok(res, null, 'Notifications marked read'); }));

r.get('/user/payments', ah(async (req, res) => ok(res, await Payment.find({ customerId: req.user.id }).populate('orderId outletId').sort({ createdAt: -1 }).lean())));
r.get(['/user/payments/:id/receipt', '/user/payments/:id/receipt.pdf'], ah(async (req, res) => {
  const payment = await findOneCompat(Payment, req.params.id, { customerId: req.user.id });
  if (!payment) throw new AppError('Payment not found', 404);
  await payment.populate('orderId customerId outletId');
  if (req.path.endsWith('.pdf') && payment.orderId) return invoiceService.stream(payment.orderId, res);
  ok(res, payment);
}));

module.exports = r;
