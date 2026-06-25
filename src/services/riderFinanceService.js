const crypto = require('crypto');
const mongoose = require('mongoose');
const Razorpay = require('razorpay');
const settings = require('./settingsService');
const { AppError } = require('../utils/errors');
const {
  User,
  RiderCashTransaction,
  RiderEarning,
  RiderPayout,
  RiderSettlement,
  Notification,
} = require('../models');

function money(value) {
  return Number(Number(value || 0).toFixed(2));
}

function safeEqual(expected, supplied) {
  const a = Buffer.from(String(expected || ''));
  const b = Buffer.from(String(supplied || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function cashSummary(riderId) {
  const rows = await RiderCashTransaction.aggregate([
    { $match: { riderId: new mongoose.Types.ObjectId(String(riderId)), status: 'CONFIRMED' } },
    { $group: { _id: '$type', total: { $sum: '$amount' } } },
  ]);
  const collected = Number(rows.find((x) => x._id === 'COLLECTED')?.total || 0);
  const deposited = Number(rows.filter((x) => ['DEPOSIT', 'ADMIN_CASH_CONFIRMED'].includes(x._id)).reduce((sum, x) => sum + Number(x.total || 0), 0));
  const outstanding = Math.max(0, money(collected - deposited));
  const pendingRows = await RiderSettlement.aggregate([
    { $match: { riderId: new mongoose.Types.ObjectId(String(riderId)), status: 'PENDING' } },
    { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);
  return {
    collected: money(collected),
    deposited: money(deposited),
    outstanding,
    pendingSettlement: money(pendingRows[0]?.total || 0),
    pendingSettlementCount: Number(pendingRows[0]?.count || 0),
    availableToSettle: Math.max(0, money(outstanding - Number(pendingRows[0]?.total || 0))),
  };
}

async function earningSummary(riderId) {
  const rows = await RiderEarning.aggregate([
    { $match: { riderId: new mongoose.Types.ObjectId(String(riderId)) } },
    { $group: { _id: '$status', total: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);
  const pending = money(rows.find((x) => x._id === 'PENDING')?.total || 0);
  const paid = money(rows.find((x) => x._id === 'PAID')?.total || 0);
  const payoutPending = money((await RiderPayout.aggregate([
    { $match: { riderId: new mongoose.Types.ObjectId(String(riderId)), status: 'PENDING' } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]))[0]?.total || 0);
  return { pending, paid, total: money(pending + paid), payoutPending };
}

async function assertSettleable(riderId, amount) {
  const numeric = money(amount);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new AppError('Enter a valid settlement amount', 400, 'INVALID_AMOUNT');
  }
  const summary = await cashSummary(riderId);
  if (numeric > summary.availableToSettle + 0.01) {
    throw new AppError('Settlement amount is higher than the available COD balance', 409, 'SETTLEMENT_EXCEEDS_AVAILABLE');
  }
  return { numeric, summary };
}

async function createCashSettlementRequest(rider, body = {}) {
  const { numeric } = await assertSettleable(rider._id, body.amount);
  const request = await RiderSettlement.create({
    riderId: rider._id,
    amount: numeric,
    method: 'CASH',
    status: 'PENDING',
    requestedAt: new Date(),
    note: String(body.note || 'Rider requested admin confirmation for COD cash handover').trim(),
    idempotencyKey: body.idempotencyKey || undefined,
  });
  await Notification.create({
    role: 'ADMIN',
    title: 'Rider COD cash handover request',
    message: `${rider.name} requested confirmation for ₹${numeric.toFixed(2)} COD cash.`,
    type: 'RIDER_CASH_SETTLEMENT_REQUEST',
    data: { riderId: rider._id, settlementId: request._id, amount: numeric, method: 'CASH' },
  });
  return request;
}

async function razorpayClient() {
  const cfg = await settings.getRazorpayConfig();
  if (!cfg.keyId || !cfg.keySecret || cfg.enabled === false) {
    throw new AppError('Online settlement is currently unavailable', 503, 'PAYMENT_NOT_CONFIGURED');
  }
  return { cfg, instance: new Razorpay({ key_id: cfg.keyId, key_secret: cfg.keySecret }) };
}

async function createRazorpaySettlementOrder(rider, body = {}) {
  const { numeric } = await assertSettleable(rider._id, body.amount);
  const idempotencyKey = String(body.idempotencyKey || `rider-settlement:${rider._id}:${numeric}:${Date.now()}`);
  const existing = await RiderSettlement.findOne({ idempotencyKey });
  if (existing?.gatewayOrderId && existing.status === 'PENDING') {
    const cfg = await settings.getRazorpayConfig();
    return {
      settlement: existing,
      checkout: {
        keyId: cfg.keyId,
        razorpayOrderId: existing.gatewayOrderId,
        amount: Math.round(existing.amount * 100),
        currency: existing.currency || 'INR',
        name: 'Mr. Breado',
        description: 'COD cash settlement',
        prefill: { name: rider.name || '', email: rider.email || '', contact: rider.phone || '' },
      },
    };
  }
  const { cfg, instance } = await razorpayClient();
  let gatewayOrder;
  try {
    gatewayOrder = await instance.orders.create({
      amount: Math.round(numeric * 100),
      currency: 'INR',
      receipt: `RIDER-${String(rider.legacyId || rider._id).slice(-20)}-${Date.now()}`.slice(0, 40),
      notes: { type: 'RIDER_COD_SETTLEMENT', riderId: String(rider._id), riderName: rider.name || '' },
    });
  } catch (error) {
    throw new AppError('Unable to start secure payment right now. Please try again.', 502, 'RAZORPAY_ORDER_CREATE_FAILED');
  }
  const settlement = await RiderSettlement.create({
    riderId: rider._id,
    amount: numeric,
    method: 'RAZORPAY',
    status: 'PENDING',
    currency: 'INR',
    gatewayOrderId: gatewayOrder.id,
    idempotencyKey,
    requestedAt: new Date(),
    note: 'Rider initiated online COD cash settlement',
  });
  return {
    settlement,
    checkout: {
      keyId: cfg.keyId,
      razorpayOrderId: gatewayOrder.id,
      amount: gatewayOrder.amount,
      currency: gatewayOrder.currency,
      name: 'Mr. Breado',
      description: 'COD cash settlement',
      prefill: { name: rider.name || '', email: rider.email || '', contact: rider.phone || '' },
    },
  };
}

async function applySuccessfulSettlement(settlement, { gatewayPaymentId, signature, rawMetadata = {}, reviewedBy = null } = {}) {
  if (!settlement) throw new AppError('Settlement transaction not found', 404, 'SETTLEMENT_NOT_FOUND');
  if (['PAID', 'APPROVED'].includes(settlement.status)) return settlement;
  const paymentReference = gatewayPaymentId || String(settlement._id);
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await RiderCashTransaction.updateOne(
        { riderId: settlement.riderId, paymentReference },
        { $setOnInsert: {
          riderId: settlement.riderId,
          type: settlement.method === 'CASH' ? 'ADMIN_CASH_CONFIRMED' : 'DEPOSIT',
          amount: settlement.amount,
          paymentMethod: settlement.method,
          paymentReference,
          status: 'CONFIRMED',
          note: settlement.method === 'CASH' ? 'Cash handover approved by admin' : 'Razorpay COD settlement confirmed',
        } },
        { upsert: true, session },
      );
      settlement.status = settlement.method === 'CASH' ? 'APPROVED' : 'PAID';
      settlement.gatewayPaymentId = gatewayPaymentId || settlement.gatewayPaymentId;
      settlement.signature = signature || settlement.signature;
      settlement.paymentReference = gatewayPaymentId || settlement.paymentReference || String(settlement._id);
      settlement.reviewedBy = reviewedBy || settlement.reviewedBy;
      settlement.reviewedAt = new Date();
      settlement.paidAt = new Date();
      settlement.rawMetadata = { ...(settlement.rawMetadata || {}), ...rawMetadata };
      await settlement.save({ session });
    });
  } finally {
    await session.endSession();
  }
  const rider = await User.findById(settlement.riderId);
  await Notification.create({
    userId: settlement.riderId,
    role: 'RIDER',
    title: 'COD settlement completed',
    message: `₹${Number(settlement.amount).toFixed(2)} was received by Mr. Breado.`,
    type: 'RIDER_CASH_SETTLEMENT',
    data: { settlementId: settlement._id, amount: settlement.amount, method: settlement.method },
  });
  await Notification.create({
    role: 'ADMIN',
    title: 'Rider payment received',
    message: `${rider?.name || 'A rider'} paid ₹${Number(settlement.amount).toFixed(2)} by ${settlement.method}.`,
    type: 'RIDER_CASH_SETTLEMENT_PAID',
    data: { riderId: settlement.riderId, settlementId: settlement._id, amount: settlement.amount },
  });
  return settlement;
}

async function verifyRazorpaySettlement(rider, body = {}) {
  const orderId = body.razorpay_order_id || body.razorpayOrderId;
  const paymentId = body.razorpay_payment_id || body.razorpayPaymentId;
  const signature = body.razorpay_signature || body.razorpaySignature;
  if (!orderId || !paymentId || !signature) {
    throw new AppError('Payment confirmation is incomplete', 400, 'INCOMPLETE_PAYMENT_CONFIRMATION');
  }
  const settlement = await RiderSettlement.findOne({ gatewayOrderId: orderId, riderId: rider._id });
  if (!settlement) throw new AppError('Settlement transaction not found', 404, 'SETTLEMENT_NOT_FOUND');
  if (['PAID', 'APPROVED'].includes(settlement.status)) return settlement;
  const { cfg, instance } = await razorpayClient();
  const expected = crypto.createHmac('sha256', cfg.keySecret).update(`${orderId}|${paymentId}`).digest('hex');
  if (!safeEqual(expected, signature)) throw new AppError('Payment confirmation could not be verified', 400, 'INVALID_SIGNATURE');
  let payment;
  try {
    payment = await instance.payments.fetch(paymentId);
  } catch (_) {
    throw new AppError('Unable to confirm payment with Razorpay', 502, 'PAYMENT_CONFIRMATION_FAILED');
  }
  if (payment.order_id !== orderId) throw new AppError('Payment does not match this settlement', 409, 'PAYMENT_ORDER_MISMATCH');
  if (!['authorized', 'captured'].includes(String(payment.status).toLowerCase())) throw new AppError('Payment is not completed', 409, 'PAYMENT_NOT_CAPTURED');
  if (Number(payment.amount) !== Math.round(Number(settlement.amount) * 100)) throw new AppError('Payment amount does not match', 409, 'PAYMENT_AMOUNT_MISMATCH');
  return applySuccessfulSettlement(settlement, { gatewayPaymentId: paymentId, signature, rawMetadata: payment });
}

async function approveCashSettlement(settlement, adminId, note) {
  if (!settlement) throw new AppError('Settlement request not found', 404, 'SETTLEMENT_NOT_FOUND');
  if (settlement.method !== 'CASH') throw new AppError('Only cash handover requests require approval', 409, 'SETTLEMENT_NOT_CASH');
  if (settlement.status === 'REJECTED') throw new AppError('Rejected request cannot be approved', 409, 'SETTLEMENT_ALREADY_REJECTED');
  settlement.adminNote = String(note || '').trim();
  return applySuccessfulSettlement(settlement, { reviewedBy: adminId });
}

async function rejectCashSettlement(settlement, adminId, reason) {
  if (!settlement) throw new AppError('Settlement request not found', 404, 'SETTLEMENT_NOT_FOUND');
  if (settlement.status !== 'PENDING') throw new AppError('Only pending requests can be rejected', 409, 'SETTLEMENT_NOT_PENDING');
  settlement.status = 'REJECTED';
  settlement.adminNote = String(reason || 'Cash handover was not confirmed by admin').trim();
  settlement.reviewedBy = adminId;
  settlement.reviewedAt = new Date();
  await settlement.save();
  await Notification.create({
    userId: settlement.riderId,
    role: 'RIDER',
    title: 'COD settlement was not approved',
    message: settlement.adminNote,
    type: 'RIDER_CASH_SETTLEMENT_REJECTED',
    data: { settlementId: settlement._id, amount: settlement.amount },
  });
  return settlement;
}

function serializeSettlement(row) {
  const x = row?.toObject ? row.toObject() : row;
  return {
    id: String(x._id),
    riderId: x.riderId?._id ? String(x.riderId._id) : String(x.riderId),
    riderName: x.riderId?.name,
    riderPhone: x.riderId?.phone,
    amount: money(x.amount),
    method: x.method,
    status: x.status,
    gatewayOrderId: x.gatewayOrderId,
    gatewayPaymentId: x.gatewayPaymentId,
    paymentReference: x.paymentReference,
    note: x.note,
    adminNote: x.adminNote,
    requestedAt: x.requestedAt || x.createdAt,
    reviewedAt: x.reviewedAt,
    paidAt: x.paidAt,
    createdAt: x.createdAt,
  };
}

async function financeHistory(riderId, limit = 100) {
  const [settlements, payouts] = await Promise.all([
    RiderSettlement.find({ riderId }).sort({ createdAt: -1 }).limit(limit).lean(),
    RiderPayout.find({ riderId }).sort({ createdAt: -1 }).limit(limit).lean(),
  ]);
  return [
    ...settlements.map((x) => ({
      id: String(x._id), direction: 'RIDER_TO_ADMIN', kind: 'COD_SETTLEMENT', amount: money(x.amount),
      status: x.status, method: x.method, paymentReference: x.paymentReference || x.gatewayPaymentId,
      title: 'Paid to admin', note: x.adminNote || x.note, createdAt: x.createdAt, completedAt: x.paidAt || x.reviewedAt,
    })),
    ...payouts.map((x) => ({
      id: String(x._id), direction: 'ADMIN_TO_RIDER', kind: 'RIDER_PAYOUT', amount: money(x.amount),
      status: x.status, method: x.paymentMethod || 'UPI', paymentReference: x.paymentReference,
      title: 'Paid by admin', note: x.note, createdAt: x.createdAt, completedAt: x.paidAt,
    })),
  ].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(0, limit);
}

module.exports = {
  cashSummary,
  earningSummary,
  createCashSettlementRequest,
  createRazorpaySettlementOrder,
  verifyRazorpaySettlement,
  applySuccessfulSettlement,
  approveCashSettlement,
  rejectCashSettlement,
  serializeSettlement,
  financeHistory,
};
