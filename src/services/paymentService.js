const crypto = require('crypto');
const Razorpay = require('razorpay');
const mongoose = require('mongoose');
const { Order, Payment, PaymentWebhookEvent, Refund } = require('../models');
const settings = require('./settingsService');
const { AppError } = require('../utils/errors');

async function client() {
  const cfg = await settings.getRazorpayConfig();
  if (!cfg.keyId || !cfg.keySecret) throw new AppError('Online payment is not configured', 503, 'PAYMENT_NOT_CONFIGURED');
  return { instance: new Razorpay({ key_id: cfg.keyId, key_secret: cfg.keySecret }), cfg };
}

function safeEqual(expected, supplied) {
  const a = Buffer.from(String(expected || ''));
  const b = Buffer.from(String(supplied || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function createOrder({ orderId, userId, idempotencyKey }) {
  const order = await Order.findOne({ _id: orderId, customerId: userId });
  if (!order) throw new AppError('Order not found', 404);
  if (['CANCELLED', 'DELIVERED'].includes(order.status)) throw new AppError('Payment cannot be initiated for this order', 409, 'ORDER_NOT_PAYABLE');

  const features = await settings.getBusinessFeatures();
  if (!features.feature_toggles.onlinePayment) throw new AppError('Online payment is currently disabled', 409, 'ONLINE_PAYMENT_DISABLED');
  if (order.fulfilmentType === 'TAKEAWAY' && !features.feature_toggles.takeaway) throw new AppError('Takeaway is currently disabled', 409, 'TAKEAWAY_DISABLED');

  const amount = Number(order.payableOnlineAmount || order.balanceDue || order.total || 0);
  if (amount <= 0) throw new AppError('No online amount is payable for this order', 409, 'NO_ONLINE_AMOUNT_DUE');

  const key = idempotencyKey || `payment:${order._id}`;
  const existingByKey = await Payment.findOne({ idempotencyKey: key });
  if (existingByKey && String(existingByKey.orderId) !== String(order._id)) {
    throw new AppError('Idempotency key was already used for another order', 409, 'IDEMPOTENCY_CONFLICT');
  }

  const { instance, cfg } = await client();
  const old = existingByKey || await Payment.findOne({ orderId: order._id, status: { $in: ['PENDING', 'SUCCESS', 'CAPTURED', 'PAID'] } }).sort({ createdAt: -1 });
  if (old?.gatewayOrderId) {
    return {
      keyId: cfg.keyId,
      razorpayOrderId: old.gatewayOrderId,
      amount: Math.round(Number(old.amount) * 100),
      currency: old.currency,
      appOrderId: String(order._id),
      fullOrderTotal: order.total,
      balanceDue: order.balanceDue || 0,
      takeawayAdvancePercentage: order.takeawayAdvancePercentage || 0,
      reused: true,
    };
  }

  let rz;
  try {
    rz = await instance.orders.create({
      amount: Math.round(amount * 100),
      currency: 'INR',
      receipt: String(order.slug || order._id).slice(0, 40),
      notes: {
        appOrderId: String(order._id),
        outletId: String(order.outletId),
        customerId: String(userId),
        fulfilmentType: order.fulfilmentType,
        fullOrderTotal: String(order.total),
      },
    });
  } catch (error) {
    const detail = error?.error?.description || error?.error?.reason || error?.message || 'Razorpay order creation failed';
    throw new AppError(`Razorpay could not create the payment order: ${detail}`, 502, 'RAZORPAY_ORDER_CREATE_FAILED');
  }

  await Payment.create({
    orderId: order._id,
    customerId: userId,
    outletId: order.outletId,
    gatewayOrderId: rz.id,
    amount,
    currency: 'INR',
    tax: order.tax,
    status: 'PENDING',
    idempotencyKey: key,
    rawMetadata: { razorpayOrderStatus: rz.status },
  });

  return {
    keyId: cfg.keyId,
    razorpayOrderId: rz.id,
    amount: rz.amount,
    currency: rz.currency,
    appOrderId: String(order._id),
    fullOrderTotal: order.total,
    balanceDue: order.balanceDue || 0,
    takeawayAdvancePercentage: order.takeawayAdvancePercentage || 0,
    reused: false,
  };
}

async function applySuccessfulPayment(payment, gatewayPaymentId, signature, rawMetadata = {}, session = null) {
  const opts = session ? { session } : {};
  const order = await Order.findById(payment.orderId).session(session || null);
  if (!order) throw new AppError('Order not found', 404);

  const expectedPaise = Math.round(Number(payment.amount || 0) * 100);
  const receivedPaise = rawMetadata.amount != null ? Number(rawMetadata.amount) : expectedPaise;
  if (receivedPaise !== expectedPaise) throw new AppError('Gateway amount does not match the payment amount', 409, 'PAYMENT_AMOUNT_MISMATCH');
  if (rawMetadata.currency && String(rawMetadata.currency).toUpperCase() !== String(payment.currency || 'INR').toUpperCase()) {
    throw new AppError('Gateway currency does not match', 409, 'PAYMENT_CURRENCY_MISMATCH');
  }

  const paidAmount = Number(payment.amount || 0);
  const previousPaid = payment.status === 'SUCCESS' ? 0 : Number(order.paidAmount || 0);
  const aggregatePaid = Math.min(Number(order.total || 0), previousPaid + paidAmount);
  const balanceDue = Math.max(0, Number((Number(order.total || 0) - aggregatePaid).toFixed(2)));

  await Payment.updateOne({ _id: payment._id }, {
    $set: {
      gatewayPaymentId,
      signature: signature || payment.signature,
      status: 'SUCCESS',
      failureReason: null,
      rawMetadata: { ...(payment.rawMetadata || {}), ...rawMetadata },
    },
  }, opts);

  await Order.updateOne({ _id: order._id }, {
    $set: {
      paymentStatus: balanceDue > 0 ? 'PARTIALLY_PAID' : 'SUCCESS',
      paidAmount: aggregatePaid,
      balanceDue,
    },
  }, opts);
}

async function verify(body, user) {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = body;
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) throw new AppError('Incomplete payment verification payload', 400);
  const payment = await Payment.findOne({ gatewayOrderId: razorpay_order_id, customerId: user.id });
  if (!payment) throw new AppError('Payment transaction not found', 404);
  if (payment.status === 'SUCCESS') return payment;

  const cfg = await settings.getRazorpayConfig();
  const expected = crypto.createHmac('sha256', cfg.keySecret).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
  if (!safeEqual(expected, razorpay_signature)) throw new AppError('Invalid payment signature', 400, 'INVALID_SIGNATURE');

  const { instance } = await client();
  const gatewayPayment = await instance.payments.fetch(razorpay_payment_id);
  if (gatewayPayment.order_id !== razorpay_order_id) throw new AppError('Gateway payment does not belong to this order', 409, 'PAYMENT_ORDER_MISMATCH');
  if (!['authorized', 'captured'].includes(String(gatewayPayment.status).toLowerCase())) throw new AppError('Payment is not authorized or captured', 409, 'PAYMENT_NOT_CAPTURED');

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await applySuccessfulPayment(payment, razorpay_payment_id, razorpay_signature, gatewayPayment, session);
    });
  } finally {
    await session.endSession();
  }
  return Payment.findById(payment._id);
}

async function webhook(raw, signature, eventIdHeader) {
  const cfg = await settings.getRazorpayConfig(false);
  if (!cfg.webhookSecret) throw new AppError('Webhook secret not configured', 503, 'WEBHOOK_NOT_CONFIGURED');
  const expected = crypto.createHmac('sha256', cfg.webhookSecret).update(raw).digest('hex');
  if (!safeEqual(expected, signature)) throw new AppError('Invalid webhook signature', 400, 'INVALID_WEBHOOK_SIGNATURE');

  const event = JSON.parse(raw.toString('utf8'));
  const paymentEntity = event.payload?.payment?.entity;
  const refundEntity = event.payload?.refund?.entity;
  const generatedId = crypto.createHash('sha256').update(`${event.event}:${paymentEntity?.id || refundEntity?.id || ''}:${raw}`).digest('hex');
  const eventId = String(eventIdHeader || generatedId);
  const payloadHash = crypto.createHash('sha256').update(raw).digest('hex');

  let record;
  try {
    record = await PaymentWebhookEvent.create({ eventId, eventType: event.event || 'unknown', signature, payloadHash, rawMetadata: event });
  } catch (error) {
    if (error?.code === 11000) return { duplicate: true, event: event.event, eventId };
    throw error;
  }

  try {
    let payment = null;
    if (paymentEntity?.id || paymentEntity?.order_id) {
      payment = await Payment.findOne({ $or: [{ gatewayPaymentId: paymentEntity.id }, { gatewayOrderId: paymentEntity.order_id }] });
    }

    if (event.event === 'payment.captured' || event.event === 'order.paid' || event.event === 'payment.authorized') {
      if (payment && paymentEntity) await applySuccessfulPayment(payment, paymentEntity.id, null, paymentEntity);
    } else if (event.event === 'payment.failed') {
      if (payment) {
        await Payment.updateOne({ _id: payment._id }, { $set: { status: 'FAILED', failureReason: paymentEntity?.error_description || paymentEntity?.error_reason || 'Payment failed', gatewayPaymentId: paymentEntity?.id, rawMetadata: paymentEntity } });
      }
    } else if (event.event?.startsWith('refund.')) {
      const refundStatus = event.event === 'refund.processed' ? 'PROCESSED' : event.event === 'refund.failed' ? 'FAILED' : 'PENDING';
      const matchedPayment = payment || (refundEntity?.payment_id ? await Payment.findOne({ gatewayPaymentId: refundEntity.payment_id }) : null);
      if (matchedPayment) {
        await Refund.findOneAndUpdate(
          { paymentId: matchedPayment._id },
          { $set: { gatewayRefundId: refundEntity?.id, status: refundStatus, amount: Number(refundEntity?.amount || 0) / 100 }, $setOnInsert: { orderId: matchedPayment.orderId, customerId: matchedPayment.customerId, outletId: matchedPayment.outletId } },
          { upsert: true, new: true }
        );
        if (refundStatus === 'PROCESSED') await Order.updateOne({ _id: matchedPayment.orderId }, { $set: { refundStatus: 'PROCESSED' } });
      }
    }

    await PaymentWebhookEvent.updateOne({ _id: record._id }, { $set: { processed: true, processedAt: new Date(), paymentId: payment?._id, orderId: payment?.orderId } });
    return { duplicate: false, processed: true, event: event.event, eventId };
  } catch (error) {
    await PaymentWebhookEvent.updateOne({ _id: record._id }, { $set: { processed: false, processingError: error.message } });
    throw error;
  }
}

module.exports = { createOrder, verify, webhook, applySuccessfulPayment };
