const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
const ah = require('../utils/asyncHandler');
const { ok } = require('../utils/respond');
const { requireAuth, allowRoles } = require('../middleware/auth');
const { AppError } = require('../utils/errors');
const { findOneCompat } = require('../utils/compatId');
const settings = require('../services/settingsService');
const orderService = require('../services/orderService');
const {
  User,
  Outlet,
  Order,
  RiderLocation,
  RiderEarning,
  RiderCashTransaction,
  VerificationRequest,
  Notification,
} = require('../models');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 5 },
  fileFilter: (_req, file, cb) => {
    if (!/^image\//i.test(file.mimetype) && file.mimetype !== 'application/pdf') {
      return cb(new AppError('Only image or PDF verification documents are allowed', 400, 'INVALID_FILE_TYPE'));
    }
    cb(null, true);
  },
});

router.use(['/delivery', '/rider'], requireAuth, allowRoles('RIDER', 'ADMIN'));

function riderQuery(req) {
  return req.user.role === 'ADMIN' && req.query.riderId
    ? findOneCompat(User, req.query.riderId, { role: 'RIDER' })
    : User.findById(req.user.id);
}

async function getRider(req) {
  const rider = await riderQuery(req);
  if (!rider) throw new AppError('Rider account not found', 404, 'RIDER_NOT_FOUND');
  return rider;
}

async function cashSummary(rider) {
  const rows = await RiderCashTransaction.aggregate([
    { $match: { riderId: rider._id, status: 'CONFIRMED' } },
    { $group: { _id: '$type', total: { $sum: '$amount' } } },
  ]);
  const collected = Number(rows.find((x) => x._id === 'COLLECTED')?.total || 0);
  const deposited = Number(rows.find((x) => x._id === 'DEPOSIT')?.total || 0);
  const cashInHand = Math.max(0, Number((collected - deposited).toFixed(2)));
  const cashLimit = Number(rider.riderProfile?.cashLimit || 2000);
  const remaining = Math.max(0, Number((cashLimit - cashInHand).toFixed(2)));
  const blocked = cashLimit > 0 && cashInHand >= cashLimit;
  return {
    cashInHand,
    cashLimit,
    remainingCashLimit: remaining,
    cashLimitBlocked: blocked,
    minimumCashDepositRequired: blocked ? Math.max(1, Number((cashInHand - cashLimit + 1).toFixed(2))) : 0,
    totalCashCollected: collected,
    totalCashDeposited: deposited,
    warningMessage: blocked
      ? 'Cash holding limit reached. Deposit cash before accepting another COD order.'
      : cashLimit > 0 && cashInHand / cashLimit >= 0.8
        ? 'You are close to the cash holding limit.'
        : '',
  };
}

function coordsToPoint(outlet, address, kind) {
  if (kind === 'pickup') {
    const [longitude = 0, latitude = 0] = outlet?.location?.coordinates || [];
    return {
      title: outlet?.name || 'Outlet Pickup',
      address: [outlet?.address?.line1, outlet?.address?.area, outlet?.address?.city, outlet?.address?.pincode].filter(Boolean).join(', '),
      latitude,
      longitude,
      contactName: outlet?.managerName || outlet?.name || '',
      contactPhone: outlet?.managerPhone || '',
    };
  }
  return {
    title: address?.label || 'Customer Drop',
    address: [address?.line1, address?.line2, address?.area, address?.city, address?.state, address?.pincode, address?.landmark].filter(Boolean).join(', '),
    latitude: Number(address?.latitude || 0),
    longitude: Number(address?.longitude || 0),
    contactName: '',
    contactPhone: '',
  };
}

async function riderRate() {
  const value = await settings.get('rider');
  return {
    perKm: Number(value?.perKmRate || value?.earningsPerKm || 0),
    minimum: Number(value?.minimumDeliveryPay || 0),
  };
}

async function serializeOrder(order, { offer = false } = {}) {
  if (!order) return null;
  const hydrated = order.outletId?.name ? order : await order.populate('outletId customerId');
  const outlet = hydrated.outletId;
  const customer = hydrated.customerId;
  const rate = await riderRate();
  const distance = Number(hydrated.distanceKm || 0);
  const riderPay = Math.max(rate.minimum, Number((distance * rate.perKm).toFixed(2)));
  const cod = hydrated.paymentMethod === 'COD';
  const appStatus = hydrated.status === 'RIDER_ASSIGNED'
    ? 'ASSIGNED'
    : hydrated.status === 'PICKED_UP' && hydrated.outForDeliveryAt
      ? 'OUT_FOR_DELIVERY'
      : hydrated.status;
  const amountToCollect = cod ? Number(hydrated.balanceDue > 0 ? hydrated.balanceDue : hydrated.total || 0) : 0;
  const base = {
    id: Number(hydrated.legacyId || 0),
    mongoId: String(hydrated._id),
    assignment_id: Number(hydrated.legacyId || 0),
    assignmentId: Number(hydrated.legacyId || 0),
    order_id: Number(hydrated.legacyId || 0),
    orderId: Number(hydrated.legacyId || 0),
    order_number: hydrated.slug,
    orderNumber: hydrated.slug,
    status: appStatus,
    order_status: hydrated.status,
    orderStatus: hydrated.status,
    payment_type: hydrated.paymentMethod,
    paymentType: hydrated.paymentMethod,
    payment_status: hydrated.paymentStatus,
    paymentStatus: hydrated.paymentStatus,
    grand_total: Number(hydrated.total || 0),
    grandTotal: Number(hydrated.total || 0),
    amount_to_collect: amountToCollect,
    amountToCollect,
    collection_amount: amountToCollect,
    collectionAmount: amountToCollect,
    cash_collected: Boolean(hydrated.cashCollected),
    cashCollected: Boolean(hydrated.cashCollected),
    cash_collected_amount: Number(hydrated.cashCollectedAmount || 0),
    cashCollectedAmount: Number(hydrated.cashCollectedAmount || 0),
    cash_collected_at: hydrated.cashCollectedAt,
    cashCollectedAt: hydrated.cashCollectedAt,
    is_cod: cod,
    isCod: cod,
    can_collect_cash: cod && Boolean(hydrated.outForDeliveryAt) && !hydrated.cashCollected,
    canCollectCash: cod && Boolean(hydrated.outForDeliveryAt) && !hydrated.cashCollected,
    can_complete_delivery: !cod || Boolean(hydrated.cashCollected),
    canCompleteDelivery: !cod || Boolean(hydrated.cashCollected),
    delivery_fee: Number(hydrated.deliveryCharge || 0),
    deliveryFee: Number(hydrated.deliveryCharge || 0),
    rider_delivery_pay: riderPay,
    riderDeliveryPay: riderPay,
    rider_delivery_pay_per_km: rate.perKm,
    riderDeliveryPayPerKm: rate.perKm,
    minimum_rider_delivery_pay: rate.minimum,
    minimumRiderDeliveryPay: rate.minimum,
    customer_delivery_fee: Number(hydrated.deliveryCharge || 0),
    customerDeliveryFee: Number(hydrated.deliveryCharge || 0),
    pickup_distance_km: 0,
    pickupDistanceKm: 0,
    total_distance_km: distance,
    totalDistanceKm: distance,
    estimated_minutes: Math.max(10, Math.round(distance * 4)),
    estimatedMinutes: Math.max(10, Math.round(distance * 4)),
    accepted_at: hydrated.acceptedAt,
    acceptedAt: hydrated.acceptedAt,
    picked_up_at: hydrated.pickedUpAt,
    pickedUpAt: hydrated.pickedUpAt,
    out_for_delivery_at: hydrated.outForDeliveryAt,
    outForDeliveryAt: hydrated.outForDeliveryAt,
    reached_drop_at: hydrated.reachedDropAt,
    reachedDropAt: hydrated.reachedDropAt,
    delivered_at: hydrated.deliveredAt,
    deliveredAt: hydrated.deliveredAt,
    pickup: coordsToPoint(outlet, hydrated.address, 'pickup'),
    drop: { ...coordsToPoint(outlet, hydrated.address, 'drop'), contactName: customer?.name || '', contactPhone: customer?.phone || '' },
  };
  if (offer) {
    base.offer_id = base.id;
    base.offerId = base.id;
    base.order_amount = base.grandTotal;
    base.orderAmount = base.grandTotal;
    base.expires_at = hydrated.riderAcceptanceDeadline || new Date(Date.now() + 15 * 60_000);
    base.expiresAt = base.expires_at;
  }
  return base;
}

async function dashboard(req, rider) {
  const [current, deliveredCount, earningAgg, cash] = await Promise.all([
    Order.findOne({ riderId: rider._id, status: { $in: ['RIDER_ASSIGNED', 'PICKED_UP'] } }).sort({ updatedAt: -1 }).populate('outletId customerId'),
    Order.countDocuments({ riderId: rider._id, status: 'DELIVERED' }),
    RiderEarning.aggregate([{ $match: { riderId: rider._id } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    cashSummary(rider),
  ]);
  const [verificationRequest, pendingPayoutAgg, paidPayoutAgg] = await Promise.all([
    VerificationRequest.findOne({ userId: rider._id, type: 'RIDER' }).sort({ createdAt: -1 }).lean(),
    RiderEarning.aggregate([{ $match: { riderId: rider._id, status: 'PENDING' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    RiderEarning.aggregate([{ $match: { riderId: rider._id, status: 'PAID' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
  ]);
  return {
    id: Number(rider.legacyId || 0),
    riderId: Number(rider.legacyId || 0),
    rider_id: Number(rider.legacyId || 0),
    online: Boolean(rider.riderProfile?.online),
    available: Boolean(rider.riderProfile?.available) && !cash.cashLimitBlocked,
    totalDeliveries: deliveredCount,
    total_deliveries: deliveredCount,
    totalEarnings: Number(earningAgg[0]?.total || 0),
    total_earnings: Number(earningAgg[0]?.total || 0),
    rating: Number(rider.riderProfile?.rating || 0),
    verificationStatus: rider.riderProfile?.verificationStatus || 'UNVERIFIED',
    verification_status: rider.riderProfile?.verificationStatus || 'UNVERIFIED',
    verificationRequest: verificationRequest ? { id: String(verificationRequest._id), status: verificationRequest.status, documents: verificationRequest.documents, createdAt: verificationRequest.createdAt } : null,
    verificationSubmitted: Boolean(verificationRequest),
    pendingPayout: Number(pendingPayoutAgg[0]?.total || 0),
    pending_payout: Number(pendingPayoutAgg[0]?.total || 0),
    paidEarnings: Number(paidPayoutAgg[0]?.total || 0),
    paid_earnings: Number(paidPayoutAgg[0]?.total || 0),
    upiId: rider.riderProfile?.payoutAccount?.upiId || '',
    upi_id: rider.riderProfile?.payoutAccount?.upiId || '',
    currentOrder: await serializeOrder(current),
    current_order: await serializeOrder(current),
    ...cash,
    cash_in_hand: cash.cashInHand,
    cash_limit: cash.cashLimit,
    remaining_cash_limit: cash.remainingCashLimit,
    cash_limit_blocked: cash.cashLimitBlocked,
    minimum_cash_deposit_required: cash.minimumCashDepositRequired,
    total_cash_collected: cash.totalCashCollected,
    total_cash_deposited: cash.totalCashDeposited,
    cash_warning_message: cash.warningMessage,
  };
}

router.get(['/delivery/dashboard', '/rider/dashboard'], ah(async (req, res) => {
  const rider = await getRider(req);
  ok(res, await dashboard(req, rider));
}));

router.post(['/delivery/profile/status', '/rider/profile/status', '/delivery/status'], ah(async (req, res) => {
  const rider = await getRider(req);
  const verification = rider.riderProfile?.verificationStatus || 'UNVERIFIED';
  if ((req.body.online || req.body.available || req.body.isAvailable || req.body.is_available) && !['VERIFIED', 'APPROVED', 'ACTIVE'].includes(String(verification).toUpperCase())) {
    throw new AppError('Rider verification is required before going online', 409, 'RIDER_NOT_VERIFIED');
  }
  const cash = await cashSummary(rider);
  const available = Boolean(req.body.available ?? req.body.isAvailable ?? req.body.is_available);
  rider.riderProfile = {
    ...(rider.riderProfile?.toObject?.() || rider.riderProfile || {}),
    online: Boolean(req.body.online),
    available: available && !cash.cashLimitBlocked,
  };
  await rider.save();
  ok(res, await dashboard(req, rider), 'Rider availability updated');
}));

router.get(['/delivery/profile', '/rider/profile'], ah(async (req, res) => {
  const rider = await getRider(req);
  ok(res, { id: rider.legacyId, mongoId: String(rider._id), name: rider.name, email: rider.email, phone: rider.phone, role: rider.role, ...rider.riderProfile?.toObject?.() });
}));

router.get(['/delivery/offers/active', '/rider/offers/active', '/delivery/orders/available'], ah(async (req, res) => {
  const rider = await getRider(req);
  const verification = String(rider.riderProfile?.verificationStatus || '').toUpperCase();
  if (!['VERIFIED', 'APPROVED', 'ACTIVE'].includes(verification) || !rider.riderProfile?.online || !rider.riderProfile?.available) return ok(res, []);
  const cash = await cashSummary(rider);
  const query = { status: { $in: ['READY', 'RIDER_ASSIGNMENT_PENDING'] }, riderId: null, fulfilmentType: 'DELIVERY' };
  if (cash.cashLimitBlocked) query.paymentMethod = { $ne: 'COD' };
  const orders = await Order.find(query).populate('outletId customerId').sort({ readyAt: 1 }).limit(100);
  const riderConfig = await settings.get('rider');
  const assignmentRadiusKm = Number(riderConfig?.assignmentRadiusKm ?? riderConfig?.deliveryOfferRadiusKm ?? 8);
  const latestLocation = await RiderLocation.findOne({ riderId: rider._id }).sort({ recordedAt: -1 });
  if (!latestLocation) throw new AppError('Update current location to receive nearby orders', 409, 'RIDER_LOCATION_REQUIRED');
  const [riderLng, riderLat] = latestLocation.location?.coordinates || [0, 0];
  const nearby = orders.filter((order) => {
    const [outletLng, outletLat] = order.outletId?.location?.coordinates || [0, 0];
    if (!outletLat || !outletLng || !riderLat || !riderLng) return false;
    const toRad = (value) => value * Math.PI / 180;
    const dLat = toRad(outletLat - riderLat);
    const dLng = toRad(outletLng - riderLng);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(riderLat)) * Math.cos(toRad(outletLat)) * Math.sin(dLng / 2) ** 2;
    const pickupDistanceKm = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    order._pickupDistanceKm = Number(pickupDistanceKm.toFixed(2));
    return pickupDistanceKm <= assignmentRadiusKm;
  });
  const serialized = await Promise.all(nearby.map(async (o) => ({ ...(await serializeOrder(o, { offer: true })), pickupDistanceKm: o._pickupDistanceKm, pickup_distance_km: o._pickupDistanceKm, assignmentRadiusKm, assignment_radius_km: assignmentRadiusKm })));
  ok(res, serialized);
}));

router.post(['/delivery/offers/:id/accept', '/rider/offers/:id/accept', '/delivery/orders/:id/accept'], ah(async (req, res) => {
  const rider = await getRider(req);
  const verification = String(rider.riderProfile?.verificationStatus || '').toUpperCase();
  if (!['VERIFIED', 'APPROVED', 'ACTIVE'].includes(verification)) throw new AppError('Rider verification required', 409, 'RIDER_NOT_VERIFIED');
  if (!rider.riderProfile?.online || !rider.riderProfile?.available) throw new AppError('Go online and available before accepting a delivery', 409, 'RIDER_NOT_AVAILABLE');
  const target = await findOneCompat(Order, req.params.id);
  if (!target) throw new AppError('Delivery offer not found', 404, 'OFFER_NOT_FOUND');
  const cash = await cashSummary(rider);
  if (target.paymentMethod === 'COD' && cash.cashLimitBlocked) throw new AppError('Cash holding limit reached', 409, 'CASH_LIMIT_REACHED');
  const updated = await Order.findOneAndUpdate(
    { _id: target._id, riderId: null, status: { $in: ['READY', 'RIDER_ASSIGNMENT_PENDING'] } },
    { $set: { riderId: rider._id, status: 'RIDER_ASSIGNED', riderAcceptanceDeadline: null } },
    { new: true }
  ).populate('outletId customerId');
  if (!updated) throw new AppError('Order is no longer available', 409, 'ALREADY_ASSIGNED');
  await Notification.create({ userId: updated.customerId?._id || updated.customerId, role: 'CUSTOMER', title: 'Rider assigned', message: `${rider.name} accepted your delivery`, type: 'RIDER_ASSIGNED', data: { orderId: updated._id } });
  req.app.get('io')?.to(`order:${updated._id}`).emit('order-status', { orderId: String(updated._id), status: 'RIDER_ASSIGNED' });
  ok(res, await serializeOrder(updated), 'Delivery accepted');
}));

router.post(['/delivery/offers/:id/reject', '/rider/offers/:id/reject'], ah(async (req, res) => {
  const order = await findOneCompat(Order, req.params.id);
  if (!order) throw new AppError('Delivery offer not found', 404);
  ok(res, { rejected: true, orderId: order.legacyId, reason: req.body.reason || 'Rejected by rider' }, 'Offer rejected');
}));

router.get(['/delivery/orders/current', '/rider/orders/current'], ah(async (req, res) => {
  const rider = await getRider(req);
  const order = await Order.findOne({ riderId: rider._id, status: { $in: ['RIDER_ASSIGNED', 'PICKED_UP'] } }).sort({ updatedAt: -1 }).populate('outletId customerId');
  ok(res, await serializeOrder(order));
}));

router.get(['/delivery/orders/history', '/rider/orders/history'], ah(async (req, res) => {
  const rider = await getRider(req);
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Math.max(1, Number(req.query.per_page || req.query.limit || 30)));
  const orders = await Order.find({ riderId: rider._id, status: 'DELIVERED' }).sort({ deliveredAt: -1 }).skip((page - 1) * limit).limit(limit).populate('outletId customerId');
  ok(res, { items: await Promise.all(orders.map((o) => serializeOrder(o))), page, per_page: limit });
}));

async function assignedOrder(req) {
  const rider = await getRider(req);
  const order = await findOneCompat(Order, req.params.id, { riderId: rider._id });
  if (!order) throw new AppError('Assigned delivery not found', 404, 'DELIVERY_NOT_FOUND');
  return { rider, order };
}

router.post(['/delivery/orders/:id/picked-up', '/delivery/orders/:id/pickup', '/rider/orders/:id/pickup'], ah(async (req, res) => {
  const { rider, order } = await assignedOrder(req);
  const updated = await orderService.changeStatus(order, { id: rider._id, role: 'RIDER' }, 'PICKED_UP', null, req.headers['idempotency-key'] || `rider:${rider._id}:pickup:${order._id}`);
  await updated.populate('outletId customerId');
  ok(res, await serializeOrder(updated), 'Pickup confirmed');
}));

router.post(['/delivery/orders/:id/out-for-delivery', '/rider/orders/:id/out-for-delivery'], ah(async (req, res) => {
  const { order } = await assignedOrder(req);
  if (order.status !== 'PICKED_UP') throw new AppError('Order must be picked up first', 409, 'INVALID_STATUS_TRANSITION');
  if (!order.outForDeliveryAt) { order.outForDeliveryAt = new Date(); await order.save(); }
  await order.populate('outletId customerId');
  req.app.get('io')?.to(`order:${order._id}`).emit('order-status', { orderId: String(order._id), status: 'OUT_FOR_DELIVERY' });
  ok(res, await serializeOrder(order), 'Delivery started');
}));

router.post(['/delivery/orders/:id/reached-drop', '/rider/orders/:id/reached-drop'], ah(async (req, res) => {
  const { order } = await assignedOrder(req);
  if (order.status !== 'PICKED_UP' || !order.outForDeliveryAt) throw new AppError('Start delivery before marking arrival', 409, 'INVALID_STATUS_TRANSITION');
  if (!order.reachedDropAt) { order.reachedDropAt = new Date(); await order.save(); }
  await order.populate('outletId customerId');
  ok(res, await serializeOrder(order), 'Reached customer location');
}));

router.post(['/delivery/orders/:id/cash-collected', '/rider/orders/:id/cash-collected'], ah(async (req, res) => {
  const { rider, order } = await assignedOrder(req);
  if (order.paymentMethod !== 'COD') throw new AppError('Cash collection applies only to COD orders', 409, 'NOT_COD');
  if (!order.outForDeliveryAt) throw new AppError('Start delivery before collecting cash', 409, 'INVALID_STATUS_TRANSITION');
  const expected = Number(order.balanceDue > 0 ? order.balanceDue : order.total || 0);
  const amount = Number(req.body.amount ?? expected);
  if (Math.abs(amount - expected) > 0.01) throw new AppError(`Cash amount must be ${expected.toFixed(2)}`, 409, 'CASH_AMOUNT_MISMATCH');
  if (!order.cashCollected) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        order.cashCollected = true;
        order.cashCollectedAmount = amount;
        order.cashCollectedAt = new Date();
        await order.save({ session });
        await RiderCashTransaction.create([{ riderId: rider._id, orderId: order._id, type: 'COLLECTED', amount, paymentMethod: 'COD', paymentReference: order.slug }], { session });
      });
    } finally { await session.endSession(); }
  }
  await order.populate('outletId customerId');
  ok(res, await serializeOrder(order), 'Cash collection recorded');
}));

router.post(['/delivery/orders/:id/delivered', '/delivery/orders/:id/deliver', '/rider/orders/:id/delivered'], ah(async (req, res) => {
  const { rider, order } = await assignedOrder(req);
  if (order.paymentMethod === 'COD' && !order.cashCollected) throw new AppError('Collect COD cash before completing delivery', 409, 'CASH_NOT_COLLECTED');
  const updated = await orderService.changeStatus(order, { id: rider._id, role: 'RIDER' }, 'DELIVERED', null, req.headers['idempotency-key'] || `rider:${rider._id}:delivered:${order._id}`);
  const rate = await riderRate();
  const distanceKm = Number(updated.distanceKm || 0);
  const earningAmount = Math.max(rate.minimum, Number((distanceKm * rate.perKm).toFixed(2)));
  await RiderEarning.findOneAndUpdate(
    { orderId: updated._id },
    { $setOnInsert: { riderId: rider._id, outletId: updated.outletId, distanceKm, ratePerKm: rate.perKm, amount: earningAmount, status: 'PENDING' } },
    { upsert: true, new: true }
  );
  await updated.populate('outletId customerId');
  req.app.get('io')?.to(`order:${updated._id}`).emit('order-status', { orderId: String(updated._id), status: 'DELIVERED' });
  ok(res, await serializeOrder(updated), 'Delivery completed');
}));

async function saveLocation(req, res) {
  const rider = await getRider(req);
  const orderValue = req.params.id || req.body.orderId || req.body.order_id;
  let order = null;
  if (orderValue) {
    order = await findOneCompat(Order, orderValue, { riderId: rider._id });
    if (!order) throw new AppError('Order assignment not found', 403, 'ORDER_NOT_ASSIGNED');
  }
  const latitude = Number(req.body.latitude ?? req.body.lat);
  const longitude = Number(req.body.longitude ?? req.body.lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new AppError('Valid latitude and longitude are required', 400, 'INVALID_COORDINATES');
  rider.riderProfile.currentLatitude = latitude;
  rider.riderProfile.currentLongitude = longitude;
  rider.riderProfile.lastLocationAt = new Date();
  await rider.save();
  const loc = await RiderLocation.create({
    riderId: rider._id,
    orderId: order?._id,
    location: { type: 'Point', coordinates: [longitude, latitude] },
    heading: Number(req.body.headingDegrees ?? req.body.heading ?? 0),
    speed: Number(req.body.speedMetersPerSecond ?? req.body.speed ?? 0),
    accuracy: Number(req.body.accuracyMeters ?? req.body.accuracy ?? 0),
    recordedAt: new Date(),
  });
  if (order) req.app.get('io')?.to(`order:${order._id}`).emit('rider-location', { latitude, longitude, heading: loc.heading, speed: loc.speed, accuracy: loc.accuracy, recordedAt: loc.recordedAt });
  ok(res, await dashboard(req, rider), 'Location updated');
}
router.post(['/delivery/location', '/rider/location'], ah(saveLocation));
router.post(['/delivery/orders/:id/location', '/rider/orders/:id/location'], ah(saveLocation));

router.get(['/delivery/earnings', '/rider/earnings'], ah(async (req, res) => {
  const rider = await getRider(req);
  const rows = await RiderEarning.find({ riderId: rider._id }).populate('orderId outletId').sort({ createdAt: -1 });
  ok(res, rows.map((row) => ({ id: row.legacyId, amount: row.amount, distance_km: row.distanceKm, rate_per_km: row.ratePerKm, status: row.status, created_at: row.createdAt, order_number: row.orderId?.slug, outlet_name: row.outletId?.name })));
}));

router.get(['/delivery/cash/summary', '/rider/cash/summary'], ah(async (req, res) => {
  const rider = await getRider(req);
  ok(res, await cashSummary(rider));
}));
router.get(['/delivery/cash/transactions', '/rider/cash/transactions'], ah(async (req, res) => {
  const rider = await getRider(req);
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Math.max(1, Number(req.query.per_page || 20)));
  const rows = await RiderCashTransaction.find({ riderId: rider._id }).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate('orderId');
  const summary = await cashSummary(rider);
  let running = summary.cashInHand;
  const items = rows.map((x) => {
    const balanceAfter = running;
    running = x.type === 'COLLECTED' ? running - Number(x.amount || 0) : running + Number(x.amount || 0);
    return {
      id: x.legacyId,
      type: x.type === 'COLLECTED' ? 'COD_COLLECTED' : 'DRIVER_DEPOSIT',
      amount: x.amount,
      balance_after: Number(balanceAfter.toFixed(2)),
      balanceAfter: Number(balanceAfter.toFixed(2)),
      order_number: x.orderId?.slug || '',
      orderNumber: x.orderId?.slug || '',
      payment_method: x.paymentMethod,
      payment_reference: x.paymentReference,
      note: x.note || '',
      status: x.status,
      created_at: x.createdAt,
    };
  });
  ok(res, { items, page, per_page: limit });
}));
router.post(['/delivery/cash/deposit', '/rider/cash/deposit'], ah(async (req, res) => {
  const rider = await getRider(req);
  const summary = await cashSummary(rider);
  const amount = Number(req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new AppError('Deposit amount must be greater than zero', 400, 'INVALID_AMOUNT');
  if (amount > summary.cashInHand + 0.01) throw new AppError('Deposit cannot exceed cash in hand', 409, 'DEPOSIT_EXCEEDS_CASH');
  await RiderCashTransaction.create({ riderId: rider._id, type: 'DEPOSIT', amount, paymentMethod: req.body.payment_method || req.body.paymentMethod, paymentReference: req.body.payment_reference || req.body.paymentReference });
  ok(res, await cashSummary(rider), 'Cash deposit recorded');
}));

router.get(['/delivery/payout-account', '/rider/payout-account'], ah(async (req, res) => {
  const rider = await getRider(req);
  ok(res, rider.riderProfile?.payoutAccount || {});
}));
router.put(['/delivery/payout-account', '/rider/payout-account'], ah(async (req, res) => {
  const rider = await getRider(req);
  rider.riderProfile.payoutAccount = {
    accountHolderName: req.body.accountHolderName || req.body.account_holder_name,
    accountNumber: req.body.accountNumber || req.body.account_number,
    ifsc: req.body.ifsc,
    bankName: req.body.bankName || req.body.bank_name,
    upiId: req.body.upiId || req.body.upi_id,
    verified: false,
  };
  await rider.save();
  ok(res, rider.riderProfile.payoutAccount, 'Payout account updated');
}));

async function uploadDocument(file) {
  if (!file) return null;
  if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
    cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET });
    const data = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
    const result = await cloudinary.uploader.upload(data, { folder: 'mr-breado/rider-verification', resource_type: 'auto' });
    return { url: result.secure_url, publicId: result.public_id, alt: file.originalname };
  }
  return { url: `data:${file.mimetype};base64,${file.buffer.toString('base64')}`, alt: file.originalname };
}

router.get('/rider/verification/status', ah(async (req, res) => {
  const rider = await getRider(req);
  const request = await VerificationRequest.findOne({ userId: rider._id, type: 'RIDER' }).sort({ createdAt: -1 });
  ok(res, request || { status: rider.riderProfile?.verificationStatus || 'UNVERIFIED' });
}));
router.post(['/rider/verification/:riderId', '/rider/verification/request'], upload.fields([{ name: 'aadhaarFront', maxCount: 1 }, { name: 'aadhaarBack', maxCount: 1 }, { name: 'drivingLicense', maxCount: 1 }, { name: 'vehicleRc', maxCount: 1 }, { name: 'profilePhoto', maxCount: 1 }]), ah(async (req, res) => {
  const rider = await getRider(req);
  if (req.params.riderId && String(req.params.riderId) !== String(rider.legacyId) && String(req.params.riderId) !== String(rider._id) && req.user.role !== 'ADMIN') throw new AppError('Cannot submit verification for another rider', 403);
  const documents = [];
  for (const [field, files] of Object.entries(req.files || {})) for (const file of files) { const doc = await uploadDocument(file); if (doc) documents.push({ ...doc, alt: field }); }
  const verification = await VerificationRequest.create({ userId: rider._id, type: 'RIDER', status: 'PENDING', documents, note: JSON.stringify(req.body || {}) });
  rider.riderProfile.verificationStatus = 'PENDING';
  await rider.save();
  ok(res, verification, 'Rider verification submitted', 201);
}));


router.get('/rider/earnings/summary', ah(async (req, res) => {
  const rider = await getRider(req);
  const rows = await RiderEarning.aggregate([
    { $match: { riderId: rider._id } },
    { $group: { _id: '$status', total: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);
  const pending = Number(rows.find((x) => x._id === 'PENDING')?.total || 0);
  const paid = Number(rows.find((x) => x._id === 'PAID')?.total || 0);
  ok(res, { totalEarnings: pending + paid, pendingPayout: pending, paidEarnings: paid, totalDeliveries: await Order.countDocuments({ riderId: rider._id, status: 'DELIVERED' }) });
}));

router.get('/rider/payouts', ah(async (req, res) => {
  const rider = await getRider(req);
  const { RiderPayout } = require('../models');
  const rows = await RiderPayout.find({ riderId: rider._id }).sort({ createdAt: -1 }).limit(100).lean();
  ok(res, { items: rows.map((p) => ({ id: String(p._id), amount: p.amount, status: p.status, upiId: p.upiId, paymentReference: p.paymentReference, paidAt: p.paidAt, periodStart: p.periodStart, periodEnd: p.periodEnd, note: p.note })) });
}));

module.exports = router;
