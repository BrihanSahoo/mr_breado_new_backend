const mongoose = require('mongoose');
const { nanoid } = require('nanoid');
const {
  Outlet, OutletProduct, Order, OrderEvent, Payment, Refund,
  RiderEarning, Coupon, Offer, CouponUsage,
} = require('../models');
const settings = require('./settingsService');
const inventory = require('./inventoryService');
const deliveryService = require('./deliveryService');
const { deliveryCharge } = require('../utils/geo');
const { AppError } = require('../utils/errors');
const env = require('../config/env');

const ACTIVE_CUSTOMER_STATUSES = [
  'PENDING_PAYMENT', 'RECEIVED', 'ACCEPTED', 'PREPARING', 'READY',
  'RIDER_ASSIGNMENT_PENDING', 'RIDER_ASSIGNED', 'PICKED_UP',
  'OUT_FOR_DELIVERY', 'REACHED_DROP',
];

const transitions = {
  PENDING_PAYMENT: ['RECEIVED', 'PAYMENT_FAILED', 'CANCELLED'],
  RECEIVED: ['ACCEPTED', 'REJECTED', 'CANCELLED'],
  ACCEPTED: ['PREPARING', 'CANCELLED'],
  PREPARING: ['READY', 'CANCELLED'],
  READY: ['RIDER_ASSIGNMENT_PENDING', 'RIDER_ASSIGNED', 'PICKED_UP', 'DELIVERED', 'CANCELLED'],
  RIDER_ASSIGNMENT_PENDING: ['RIDER_ASSIGNED', 'CANCELLED'],
  RIDER_ASSIGNED: ['PICKED_UP', 'CANCELLED'],
  PICKED_UP: ['OUT_FOR_DELIVERY', 'REACHED_DROP', 'DELIVERED'],
  OUT_FOR_DELIVERY: ['REACHED_DROP', 'DELIVERED'],
  REACHED_DROP: ['DELIVERED'],
  REJECTED: [], CANCELLED: [], DELIVERED: [], REFUND_PENDING: ['REFUNDED'], PAYMENT_FAILED: [],
};
const aliases = { PLACED: 'RECEIVED', CONFIRMED: 'ACCEPTED', PREPARED: 'READY', OUT_FOR_DELIVERY: 'PICKED_UP', COMPLETED: 'DELIVERED' };
const canonical = (status) => aliases[String(status || '').toUpperCase()] || String(status || '').toUpperCase();

const imageUrl = (value) => {
  if (!value) return '';
  if (typeof value === 'string') {
    let url = value.trim();
    if (url.startsWith('//')) url = `https:${url}`;
    if (url.startsWith('http://res.cloudinary.com/')) url = url.replace('http://', 'https://');
    return url;
  }
  if (Array.isArray(value)) return imageUrl(value[0]);
  return imageUrl(value.secure_url || value.secureUrl || value.url || value.src || value.path || value.image || value.imageUrl);
};

function validGstin(value) {
  const gstin = String(value || '').trim().toUpperCase();
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin);
}

function couponDiscount(coupon, subtotal) {
  if (!coupon) return 0;
  const type = String(coupon.type || 'PERCENT').toUpperCase();
  if (['FREE_DELIVERY', 'FREEDELIVERY', 'DELIVERY'].includes(type)) return 0;
  let value = ['FIXED', 'FLAT', 'AMOUNT'].includes(type)
    ? Number(coupon.value || 0)
    : subtotal * Number(coupon.value || 0) / 100;
  if (Number(coupon.maxDiscount || 0) > 0) value = Math.min(value, Number(coupon.maxDiscount));
  return Math.max(0, Math.min(subtotal, Number(value.toFixed(2))));
}

async function findCoupon({ code, subtotal, outletId, items, customerId, paymentMethod, fulfilmentType }) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!normalized) return null;
  const now = new Date();
  const dateFilter = { active: true, $and: [
    { $or: [{ startAt: null }, { startAt: { $exists: false } }, { startAt: { $lte: now } }] },
    { $or: [{ endAt: null }, { endAt: { $exists: false } }, { endAt: { $gte: now } }] },
  ] };
  let coupon = await Coupon.findOne({ code: normalized, ...dateFilter }).lean();
  if (!coupon) coupon = await Offer.findOne({ code: normalized, ...dateFilter }).lean();
  if (!coupon) throw new AppError('Invalid or expired coupon', 409, 'INVALID_COUPON');
  if (Number(coupon.minOrder || 0) > subtotal) throw new AppError(`Minimum order value is ₹${Number(coupon.minOrder)}`, 409, 'COUPON_MIN_ORDER');
  if (Array.isArray(coupon.outletIds) && coupon.outletIds.length && !coupon.outletIds.map(String).includes(String(outletId))) {
    throw new AppError('Coupon is not valid for this outlet', 409, 'COUPON_OUTLET_MISMATCH');
  }
  if (Array.isArray(coupon.productIds) && coupon.productIds.length && !items.some((item) => coupon.productIds.map(String).includes(String(item.productId)))) {
    throw new AppError('Coupon is not valid for selected foods', 409, 'COUPON_PRODUCT_MISMATCH');
  }
  if (Array.isArray(coupon.paymentMethods) && coupon.paymentMethods.length && paymentMethod && !coupon.paymentMethods.includes(paymentMethod)) {
    throw new AppError('Coupon is not valid for this payment method', 409, 'COUPON_PAYMENT_MISMATCH');
  }
  if (Array.isArray(coupon.fulfilmentTypes) && coupon.fulfilmentTypes.length && !coupon.fulfilmentTypes.includes(fulfilmentType)) {
    throw new AppError('Coupon is not valid for this order type', 409, 'COUPON_FULFILMENT_MISMATCH');
  }
  if (Array.isArray(coupon.eligibleCustomerIds) && coupon.eligibleCustomerIds.length && !coupon.eligibleCustomerIds.map(String).includes(String(customerId))) {
    throw new AppError('You are not eligible for this coupon', 409, 'COUPON_CUSTOMER_INELIGIBLE');
  }
  if (Number(coupon.usageLimit || 0) > 0 && Number(coupon.usedCount || 0) >= Number(coupon.usageLimit)) {
    throw new AppError('Coupon usage limit reached', 409, 'COUPON_LIMIT_REACHED');
  }
  if (customerId && coupon._id && Number(coupon.perUserLimit || 0) > 0) {
    const used = await CouponUsage.countDocuments({ couponId: coupon._id, customerId, status: { $in: ['RESERVED', 'CONSUMED'] } });
    if (used >= Number(coupon.perUserLimit)) throw new AppError('You have already used this coupon the maximum number of times', 409, 'COUPON_USER_LIMIT_REACHED');
  }
  return coupon;
}

function choosePrice(product, outletProduct, input) {
  const customizations = Array.isArray(input.customizations) ? input.customizations : [];
  const customizationValue = (pattern) => {
    const found = customizations.find((item) => pattern.test(String(item.groupName || item.group || item.name || '')));
    return String(found?.optionName || found?.option || found?.value || '').trim();
  };
  const rawSize = String(input.selectedSize || input.selected_size || customizationValue(/size/i) || '').trim().toLowerCase();
  const rawWeight = String(input.selectedWeight || input.selected_weight || customizationValue(/weight/i) || '').trim().toLowerCase();
  const selectedSize = rawSize.includes('small') ? 'small' : rawSize.includes('medium') ? 'medium' : rawSize.includes('large') ? 'large' : rawSize;
  const compactWeight = rawWeight.replace(/\s/g, '');
  const selectedWeight = compactWeight.includes('500') ? '500g' : compactWeight.includes('1.5') ? '1.5kg' : compactWeight.includes('2kg') || compactWeight === '2' ? '2kg' : compactWeight.includes('1kg') || compactWeight === '1' ? '1kg' : compactWeight;
  let price = Number(
    outletProduct.offerPriceOverride ?? outletProduct.priceOverride ??
    (Number(product.offerPrice || 0) > 0 ? product.offerPrice : product.basePrice) ?? 0
  );
  if (product.variantType === 'PIZZA') {
    if (!['small', 'medium', 'large'].includes(selectedSize)) throw new AppError('Select a valid pizza size', 400, 'PIZZA_SIZE_REQUIRED');
    if (product.sizePrices?.[selectedSize] == null) throw new AppError('Selected pizza size is unavailable', 409, 'PIZZA_SIZE_UNAVAILABLE');
    price = Number(product.sizePrices[selectedSize]);
  }
  const weightKey = { '500gm': 'gm500', '500g': 'gm500', '1kg': 'kg1', '1.5kg': 'kg15', '2kg': 'kg2' }[selectedWeight];
  if (product.variantType === 'CAKE') {
    if (!weightKey) throw new AppError('Select a valid cake weight', 400, 'CAKE_WEIGHT_REQUIRED');
    if (product.weightPrices?.[weightKey] == null) throw new AppError('Selected cake weight is unavailable', 409, 'CAKE_WEIGHT_UNAVAILABLE');
    price = Number(product.weightPrices[weightKey]);
  }
  return { price, selectedSize, selectedWeight };
}

async function buildPricing({ outletId, items, address, fulfilmentType = 'DELIVERY', couponCode, customerId, paymentMethod }) {
  const type = String(fulfilmentType || 'DELIVERY').toUpperCase();
  const method = String(paymentMethod || 'COD').toUpperCase();
  if (!['DELIVERY', 'TAKEAWAY'].includes(type)) throw new AppError('Invalid fulfilment type', 400, 'INVALID_FULFILMENT_TYPE');
  if (!Array.isArray(items) || !items.length) throw new AppError('At least one food item is required', 400, 'EMPTY_ORDER');
  const features = await settings.getBusinessFeatures();
  if (type === 'DELIVERY' && !features.feature_toggles.delivery) throw new AppError('Delivery is currently disabled', 409, 'DELIVERY_DISABLED');
  if (type === 'TAKEAWAY' && !features.feature_toggles.takeaway) throw new AppError('Takeaway is currently disabled', 409, 'TAKEAWAY_DISABLED');

  const outlet = await Outlet.findById(outletId).lean();
  if (!outlet || !outlet.active) throw new AppError('Outlet is unavailable', 409, 'OUTLET_UNAVAILABLE');
  if (!outlet.open) throw new AppError('This outlet is currently closed', 409, 'OUTLET_CLOSED');
  if (!validGstin(outlet.gstin)) throw new AppError('Outlet GSTIN is not configured. Contact the administrator.', 409, 'OUTLET_GSTIN_REQUIRED');

  const ids = items.map((item) => item.productId);
  const rows = await OutletProduct.find({ outletId, productId: { $in: ids }, enabled: true, available: true }).populate('productId').lean();
  const rowByProduct = new Map(rows.map((row) => [String(row.productId?._id), row]));
  let subtotal = 0;
  const snapshots = items.map((input) => {
    const row = rowByProduct.get(String(input.productId));
    const quantity = Math.max(1, Number(input.quantity || 1));
    if (!row || !row.productId?.active || Number(row.stockQuantity || 0) - Number(row.reservedQuantity || 0) < quantity) {
      throw new AppError('One or more foods are unavailable or out of stock', 409, 'STOCK_UNAVAILABLE');
    }
    const product = row.productId;
    const { price, selectedSize, selectedWeight } = choosePrice(product, row, input);
    const customizations = Array.isArray(input.customizations) ? input.customizations : [];
    const addOnTotal = customizations.reduce((sum, option) => sum + Number(option.price || 0), 0);
    const cakeMessage = String(input.cakeMessage || input.cake_message || '').trim();
    const cakeMessageCharge = product.variantType === 'CAKE' && cakeMessage && product.cakeMessageEnabled ? Number(product.cakeMessageCharge || 0) : 0;
    const finalTotal = Number(((price + addOnTotal + cakeMessageCharge) * quantity).toFixed(2));
    subtotal += finalTotal;
    return {
      productId: product._id, name: product.name, slug: product.slug, sku: product.sku,
      image: imageUrl(product.images), quantity, unitPrice: price, offerPrice: price, tax: 0,
      customizations, selectedSize: selectedSize || undefined, selectedWeight: selectedWeight || undefined,
      cakeMessage: cakeMessage || undefined, addOnTotal: Number((addOnTotal + cakeMessageCharge).toFixed(2)), finalTotal,
    };
  });

  const taxSettings = await settings.get('tax');
  const tax = Number((subtotal * Number(taxSettings?.rate || 0) / 100).toFixed(2));
  let distanceKm = 0;
  let deliveryFee = 0;
  if (type === 'DELIVERY') {
    if (!address || address.latitude == null || address.longitude == null) throw new AppError('Current delivery latitude and longitude are required', 400, 'DELIVERY_LOCATION_REQUIRED');
    const validation = await deliveryService.checkServiceability({ outletId, latitude: address.latitude, longitude: address.longitude, pincode: address.pincode || address.zipcode, address: address.line1 || address.address, city: address.city, state: address.state });
    if (!validation.serviceable) throw new AppError(validation.message || 'This outlet is outside your delivery range', 409, validation.code || 'OUT_OF_RANGE');
    distanceKm = Number(validation.distanceKm || 0);
    const deliveryPricing = await settings.getDeliveryPricing();
    deliveryFee = deliveryCharge(distanceKm, deliveryPricing.customer);
  }

  const originalDeliveryFee = deliveryFee;
  const coupon = features.feature_toggles.offers ? await findCoupon({ code: couponCode, subtotal, outletId, items: snapshots, customerId, paymentMethod: method, fulfilmentType: type }) : null;
  const freeDelivery = coupon && ['FREE_DELIVERY', 'FREEDELIVERY', 'DELIVERY'].includes(String(coupon.type || '').toUpperCase());
  if (freeDelivery) deliveryFee = 0;
  const discount = couponDiscount(coupon, subtotal);
  const couponSavings = Number((discount + (freeDelivery ? originalDeliveryFee : 0)).toFixed(2));
  const total = Number(Math.max(0, subtotal - discount + tax + deliveryFee).toFixed(2));
  const takeawayAdvancePercentage = type === 'TAKEAWAY' ? Number(features.takeaway.advanceValue || 0) : 0;
  const payableOnlineAmount = type === 'TAKEAWAY' ? Number((total * takeawayAdvancePercentage / 100).toFixed(2)) : total;
  const balanceDue = type === 'TAKEAWAY' ? Number((total - payableOnlineAmount).toFixed(2)) : 0;
  return { outlet, snapshots, subtotal: Number(subtotal.toFixed(2)), discount, tax, deliveryCharge: deliveryFee, total, distanceKm, fulfilmentType: type, takeawayAdvancePercentage, payableOnlineAmount, balanceDue, featureToggles: features.feature_toggles, couponCode: coupon?.code || null, coupon, couponSavings, freeDelivery };
}

async function createOrder({ customerId, outletId, items, address, fulfilmentType, paymentMethod, clientRequestId, couponCode }) {
  if (clientRequestId) {
    const existing = await Order.findOne({ clientRequestId });
    if (existing) return existing;
  }
  const active = await Order.findOne({ customerId, status: { $in: ACTIVE_CUSTOMER_STATUSES } }).select('_id slug status').lean();
  if (active) throw new AppError(`You already have an active order (${active.slug}). Complete or cancel it before placing another order.`, 409, 'ACTIVE_ORDER_EXISTS');

  const method = String(paymentMethod || 'COD').toUpperCase();
  const pricing = await buildPricing({ outletId, items, address, fulfilmentType, couponCode, customerId, paymentMethod: method });
  if (method === 'ONLINE' && !pricing.featureToggles.onlinePayment) throw new AppError('Online payment is currently disabled', 409, 'ONLINE_PAYMENT_DISABLED');
  if (method === 'COD' && !pricing.featureToggles.cod) throw new AppError('Cash on delivery is currently disabled', 409, 'COD_DISABLED');
  if (pricing.fulfilmentType === 'TAKEAWAY' && pricing.takeawayAdvancePercentage > 0 && !pricing.featureToggles.onlinePayment) throw new AppError('Takeaway requires online advance payment, but online payment is disabled', 409, 'TAKEAWAY_PAYMENT_UNAVAILABLE');
  if (pricing.fulfilmentType === 'TAKEAWAY' && pricing.takeawayAdvancePercentage > 0 && !['ONLINE', 'TAKEAWAY_ADVANCE'].includes(method)) throw new AppError(`Takeaway requires ${pricing.takeawayAdvancePercentage}% online advance payment`, 409, 'TAKEAWAY_ADVANCE_REQUIRED');

  const effectiveMethod = pricing.fulfilmentType === 'TAKEAWAY' && pricing.takeawayAdvancePercentage > 0 ? 'TAKEAWAY_ADVANCE' : method;
  const requiresOnline = ['ONLINE', 'TAKEAWAY_ADVANCE'].includes(effectiveMethod);
  const session = await mongoose.startSession();
  let order;
  try {
    await session.withTransaction(async () => {
      [order] = await Order.create([{
        slug: `MB-${Date.now()}-${nanoid(6)}`, clientRequestId, customerId, outletId, items: pricing.snapshots,
        address, fulfilmentType: pricing.fulfilmentType, paymentMethod: effectiveMethod, paymentStatus: 'PENDING',
        status: requiresOnline ? 'PENDING_PAYMENT' : 'RECEIVED', subtotal: pricing.subtotal, discount: pricing.discount,
        tax: pricing.tax, deliveryCharge: pricing.deliveryCharge, total: pricing.total,
        payableOnlineAmount: requiresOnline ? pricing.payableOnlineAmount : 0, paidAmount: 0,
        balanceDue: pricing.fulfilmentType === 'TAKEAWAY' ? pricing.balanceDue : 0,
        takeawayAdvancePercentage: pricing.takeawayAdvancePercentage, distanceKm: pricing.distanceKm,
        couponCode: pricing.couponCode,
        sellerAcceptanceDeadline: new Date(Date.now() + Math.max(1, Number(requiresOnline ? env.autoCancel.paymentMinutes : env.autoCancel.sellerMinutes || 60)) * 60000),
      }], { session });
      await inventory.reserve(pricing.snapshots, outletId, order._id, customerId, session, `order:${order._id}`);
      if (pricing.coupon?._id && pricing.couponCode) {
        await CouponUsage.create([{ couponId: pricing.coupon._id, code: pricing.couponCode, customerId, orderId: order._id, outletId, discountAmount: pricing.couponSavings ?? pricing.discount, status: 'RESERVED' }], { session });
        if (pricing.coupon.constructor?.modelName === 'Coupon' || await Coupon.exists({ _id: pricing.coupon._id }).session(session)) {
          await Coupon.updateOne({ _id: pricing.coupon._id }, { $inc: { usedCount: 1 } }, { session });
        }
      }
      await OrderEvent.create([{ orderId: order._id, previousStatus: null, newStatus: order.status, actorType: 'CUSTOMER', actorId: customerId, metadata: { fulfilmentType: pricing.fulfilmentType, takeawayAdvancePercentage: pricing.takeawayAdvancePercentage, payableOnlineAmount: requiresOnline ? pricing.payableOnlineAmount : 0, balanceDue: pricing.balanceDue, couponCode: pricing.couponCode }, idempotencyKey: `order:${order._id}:created` }], { session });
    });
  } finally { await session.endSession(); }
  return order;
}

async function changeStatus(order, user, nextStatus, reason, idempotencyKey, options = {}) {
  const next = canonical(nextStatus);
  const previous = canonical(order.status);
  if (previous === next) return order;
  const forceCancel = next === 'CANCELLED' && (options.force === true || String(user?.role || '').toUpperCase() === 'ADMIN');
  if (!forceCancel && !(transitions[previous] || []).includes(next)) throw new AppError(`Invalid transition ${previous} -> ${next}`, 409, 'INVALID_STATUS_TRANSITION');
  if (order.fulfilmentType === 'TAKEAWAY' && ['RIDER_ASSIGNMENT_PENDING', 'RIDER_ASSIGNED', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'REACHED_DROP'].includes(next)) throw new AppError('A takeaway order cannot be assigned to a rider', 409, 'TAKEAWAY_RIDER_NOT_ALLOWED');
  if (next === 'DELIVERED' && order.fulfilmentType === 'TAKEAWAY' && Number(order.balanceDue || 0) > 0 && Number(order.paidAmount || 0) < Number(order.total || 0)) throw new AppError('Collect and record the remaining takeaway amount before completion', 409, 'TAKEAWAY_BALANCE_DUE');

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      order.status = next;
      if (next === 'ACCEPTED') { order.acceptedAt = new Date(); order.sellerAcceptanceDeadline = null; }
      if (next === 'READY') { order.readyAt = new Date(); order.sellerAcceptanceDeadline = null; if (order.fulfilmentType === 'DELIVERY') order.riderAcceptanceDeadline = new Date(Date.now() + Math.max(1, Number(env.autoCancel.riderMinutes || 60)) * 60000); }
      if (next === 'PICKED_UP') { order.pickedUpAt = new Date(); order.riderAcceptanceDeadline = null; }
      if (next === 'OUT_FOR_DELIVERY') order.outForDeliveryAt = new Date();
      if (next === 'REACHED_DROP') order.reachedDropAt = new Date();
      if (next === 'DELIVERED') {
        order.deliveredAt = new Date();
        order.invoiceStatus = 'READY';
        await inventory.consume(order.items, order.outletId, order._id, user.id, session, `order:${order._id}`);
        await CouponUsage.updateOne({ orderId: order._id }, { $set: { status: 'CONSUMED' } }, { session });
        if (order.riderId) {
          const riderSettings = (await settings.getDeliveryPricing()).rider;
          const rate = Number(riderSettings.perKmRate || 0);
          const basePay = Number(riderSettings.basePay || 0);
          const minimum = Number(riderSettings.minimumDeliveryPay || 0);
          const amount = Math.max(minimum, Number((basePay + Number(order.distanceKm || 0) * rate).toFixed(2)));
          await RiderEarning.updateOne({ orderId: order._id }, { $setOnInsert: { riderId: order.riderId, orderId: order._id, outletId: order.outletId, distanceKm: order.distanceKm, ratePerKm: rate, amount, status: 'PENDING' } }, { upsert: true, session });
        }
      }
      if (['CANCELLED', 'REJECTED', 'PAYMENT_FAILED'].includes(next)) {
        order.cancelledAt = new Date(); order.cancellationReason = reason;
        await inventory.release(order.items, order.outletId, order._id, user.id, session, `order:${order._id}`);
        const usage = await CouponUsage.findOneAndUpdate({ orderId: order._id, status: { $ne: 'RELEASED' } }, { $set: { status: 'RELEASED' } }, { new: true, session });
        if (usage?.couponId) await Coupon.updateOne({ _id: usage.couponId, usedCount: { $gt: 0 } }, { $inc: { usedCount: -1 } }, { session });
        if (order.paymentStatus === 'SUCCESS') {
          const payment = await Payment.findOne({ orderId: order._id, status: 'SUCCESS' }).session(session);
          if (payment) { await Refund.updateOne({ orderId: order._id, paymentId: payment._id }, { $setOnInsert: { customerId: order.customerId, outletId: order.outletId, amount: payment.amount, cancellationReason: reason, status: 'PENDING' } }, { upsert: true, session }); order.refundStatus = 'PENDING'; }
        }
      }
      await order.save({ session });
      await OrderEvent.create([{ orderId: order._id, previousStatus: previous, newStatus: next, actorType: user.role, actorId: user.id, reason, idempotencyKey: idempotencyKey || `order:${order._id}:${previous}:${next}` }], { session });
    });
  } finally { await session.endSession(); }
  return order;
}

module.exports = { buildPricing, createOrder, changeStatus, canonical, transitions, ACTIVE_CUSTOMER_STATUSES };
