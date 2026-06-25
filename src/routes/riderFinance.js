const express = require('express');
const ah = require('../utils/asyncHandler');
const { ok } = require('../utils/respond');
const { requireAuth, allowRoles } = require('../middleware/auth');
const { AppError } = require('../utils/errors');
const { findOneCompat } = require('../utils/compatId');
const {
  User,
  RiderEarning,
  RiderPayout,
  RiderSettlement,
  Notification,
} = require('../models');
const finance = require('../services/riderFinanceService');

const router = express.Router();

function payoutOut(row) {
  const p = row?.toObject ? row.toObject() : row;
  return {
    id: String(p._id), riderId: String(p.riderId?._id || p.riderId), riderName: p.riderId?.name,
    amount: Number(p.amount || 0), status: p.status, upiId: p.upiId, paymentMethod: p.paymentMethod,
    paymentReference: p.paymentReference, periodStart: p.periodStart, periodEnd: p.periodEnd,
    createdAt: p.createdAt, paidAt: p.paidAt, note: p.note,
  };
}

router.get(['/rider/finance/summary-v2', '/delivery/finance/summary-v2'], requireAuth, allowRoles('RIDER'), ah(async (req, res) => {
  const rider = await User.findById(req.user.id);
  if (!rider) throw new AppError('Rider account not found', 404, 'RIDER_NOT_FOUND');
  const [cash, earnings, history, pendingSettlements, payouts] = await Promise.all([
    finance.cashSummary(rider._id),
    finance.earningSummary(rider._id),
    finance.financeHistory(rider._id, 100),
    RiderSettlement.find({ riderId: rider._id, status: 'PENDING' }).sort({ createdAt: -1 }).lean(),
    RiderPayout.find({ riderId: rider._id }).sort({ createdAt: -1 }).limit(100).lean(),
  ]);
  ok(res, {
    cash,
    earnings,
    upiId: rider.riderProfile?.payoutAccount?.upiId || '',
    payoutAccount: rider.riderProfile?.payoutAccount || {},
    passportPhoto: rider.riderProfile?.passportPhoto || rider.avatar || null,
    pendingSettlements: pendingSettlements.map(finance.serializeSettlement),
    payouts: payouts.map(payoutOut),
    history,
  });
}));

router.get(['/rider/finance/history', '/delivery/finance/history'], requireAuth, allowRoles('RIDER'), ah(async (req, res) => {
  ok(res, { items: await finance.financeHistory(req.user.id, Math.min(200, Math.max(1, Number(req.query.limit || 100)))) });
}));

router.get(['/rider/cash/settlements', '/delivery/cash/settlements'], requireAuth, allowRoles('RIDER'), ah(async (req, res) => {
  const rows = await RiderSettlement.find({ riderId: req.user.id }).sort({ createdAt: -1 }).limit(100).lean();
  ok(res, { items: rows.map(finance.serializeSettlement) });
}));

router.post(['/rider/cash/settlements', '/delivery/cash/settlements'], requireAuth, allowRoles('RIDER'), ah(async (req, res) => {
  const rider = await User.findById(req.user.id);
  if (!rider) throw new AppError('Rider account not found', 404, 'RIDER_NOT_FOUND');
  const row = await finance.createCashSettlementRequest(rider, req.body);
  ok(res, finance.serializeSettlement(row), 'Cash handover request sent to admin', 201);
}));

router.post(['/rider/cash/settlements/razorpay/order', '/delivery/cash/settlements/razorpay/order'], requireAuth, allowRoles('RIDER'), ah(async (req, res) => {
  const rider = await User.findById(req.user.id);
  if (!rider) throw new AppError('Rider account not found', 404, 'RIDER_NOT_FOUND');
  const result = await finance.createRazorpaySettlementOrder(rider, req.body);
  ok(res, { settlement: finance.serializeSettlement(result.settlement), checkout: result.checkout }, 'Secure payment ready', 201);
}));

router.post(['/rider/cash/settlements/razorpay/verify', '/delivery/cash/settlements/razorpay/verify'], requireAuth, allowRoles('RIDER'), ah(async (req, res) => {
  const rider = await User.findById(req.user.id);
  if (!rider) throw new AppError('Rider account not found', 404, 'RIDER_NOT_FOUND');
  const row = await finance.verifyRazorpaySettlement(rider, req.body);
  ok(res, { settlement: finance.serializeSettlement(row), cash: await finance.cashSummary(rider._id) }, 'Payment received successfully');
}));

router.get('/admin/rider-settlements', requireAuth, allowRoles('ADMIN'), ah(async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Math.max(1, Number(req.query.perPage || req.query.per_page || 20)));
  const q = {};
  if (req.query.status) q.status = String(req.query.status).toUpperCase();
  if (req.query.method) q.method = String(req.query.method).toUpperCase();
  if (req.query.riderId) q.riderId = req.query.riderId;
  const [rows, total] = await Promise.all([
    RiderSettlement.find(q).populate('riderId', 'name email phone legacyId').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    RiderSettlement.countDocuments(q),
  ]);
  const summary = await RiderSettlement.aggregate([
    { $group: { _id: { direction: '$method', status: '$status' }, total: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);
  ok(res, {
    items: rows.map(finance.serializeSettlement), page, perPage: limit, total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    summary,
  });
}));

router.post('/admin/rider-settlements/:id/approve', requireAuth, allowRoles('ADMIN'), ah(async (req, res) => {
  const row = await RiderSettlement.findById(req.params.id);
  const updated = await finance.approveCashSettlement(row, req.user.id, req.body.note);
  ok(res, finance.serializeSettlement(updated), 'Rider cash receipt approved');
}));

router.post('/admin/rider-settlements/:id/reject', requireAuth, allowRoles('ADMIN'), ah(async (req, res) => {
  const row = await RiderSettlement.findById(req.params.id);
  const updated = await finance.rejectCashSettlement(row, req.user.id, req.body.reason);
  ok(res, finance.serializeSettlement(updated), 'Rider cash receipt rejected');
}));

// Existing admin clients call this endpoint. It now creates a reviewable pending payout;
// earnings are cleared only after the explicit mark-paid action below.
router.post('/admin/drivers/:id/payout', requireAuth, allowRoles('ADMIN'), ah(async (req, res) => {
  const rider = await findOneCompat(User, req.params.id, { role: 'RIDER' });
  if (!rider) throw new AppError('Rider not found', 404, 'RIDER_NOT_FOUND');
  const upiId = String(req.body.upiId || rider.riderProfile?.payoutAccount?.upiId || '').trim();
  if (!upiId) throw new AppError('Ask the rider to submit a UPI ID first', 409, 'UPI_ID_REQUIRED');
  const existing = await RiderPayout.findOne({ riderId: rider._id, status: 'PENDING' }).sort({ createdAt: -1 });
  if (existing) return ok(res, payoutOut(existing), 'A payout is already pending confirmation');
  const earnings = await RiderEarning.find({ riderId: rider._id, status: 'PENDING' }).sort({ createdAt: 1 });
  const available = Number(earnings.reduce((sum, x) => sum + Number(x.amount || 0), 0).toFixed(2));
  const requested = Number(req.body.amount ?? available);
  if (!Number.isFinite(requested) || requested <= 0 || available <= 0) throw new AppError('No rider payout is currently due', 409, 'NO_PENDING_PAYOUT');
  if (requested > available + 0.01) throw new AppError('Payout exceeds pending rider earnings', 409, 'PAYOUT_EXCEEDS_PENDING');
  let remaining = requested;
  const selected = [];
  for (const earning of earnings) {
    if (remaining <= 0.01) break;
    const value = Number(earning.amount || 0);
    if (value <= remaining + 0.01) { selected.push(earning); remaining = Number((remaining - value).toFixed(2)); }
  }
  if (remaining > 0.01) throw new AppError('Choose an amount matching complete delivery earnings', 409, 'PARTIAL_EARNING_NOT_SUPPORTED');
  const now = new Date();
  const payout = await RiderPayout.create({
    riderId: rider._id,
    periodStart: req.body.periodStart ? new Date(req.body.periodStart) : new Date(now.getFullYear(), now.getMonth(), 1),
    periodEnd: req.body.periodEnd ? new Date(req.body.periodEnd) : now,
    amount: requested,
    upiId,
    paymentMethod: 'UPI',
    status: 'PENDING',
    earningIds: selected.map((x) => x._id),
    note: req.body.note || 'Rider payout awaiting payment confirmation',
  });
  await Notification.create({
    userId: rider._id, role: 'RIDER', title: 'Payout initiated',
    message: `Your ₹${requested.toFixed(2)} payout to ${upiId} is awaiting admin payment confirmation.`,
    type: 'RIDER_PAYOUT_PENDING', data: { payoutId: payout._id, amount: requested, upiId },
  });
  ok(res, payoutOut(payout), 'Rider payout created and awaiting confirmation', 201);
}));

router.post('/admin/rider-payouts/:id/mark-paid', requireAuth, allowRoles('ADMIN'), ah(async (req, res) => {
  const payout = await RiderPayout.findById(req.params.id);
  if (!payout) throw new AppError('Payout not found', 404, 'PAYOUT_NOT_FOUND');
  if (payout.status === 'PAID') return ok(res, payoutOut(payout), 'Payout was already marked paid');
  if (payout.status !== 'PENDING') throw new AppError('Only pending payouts can be marked paid', 409, 'PAYOUT_NOT_PENDING');
  const reference = String(req.body.paymentReference || '').trim();
  if (!reference) throw new AppError('UPI transaction reference is required', 400, 'PAYMENT_REFERENCE_REQUIRED');
  const now = new Date();
  payout.status = 'PAID';
  payout.paymentReference = reference;
  payout.paidBy = req.user.id;
  payout.paidAt = now;
  payout.note = req.body.note || payout.note || 'Paid to rider by UPI';
  await payout.save();
  await RiderEarning.updateMany({ _id: { $in: payout.earningIds }, status: 'PENDING' }, { $set: { status: 'PAID', settledAt: now, payoutId: payout._id } });
  await Notification.create({
    userId: payout.riderId, role: 'RIDER', title: 'Payout received',
    message: `Admin marked ₹${Number(payout.amount).toFixed(2)} as paid to ${payout.upiId}.`,
    type: 'RIDER_PAYOUT', data: { payoutId: payout._id, amount: payout.amount, paymentReference: reference },
  });
  ok(res, payoutOut(payout), 'Rider payout marked paid');
}));

router.post('/admin/rider-payouts/:id/cancel', requireAuth, allowRoles('ADMIN'), ah(async (req, res) => {
  const payout = await RiderPayout.findById(req.params.id);
  if (!payout) throw new AppError('Payout not found', 404, 'PAYOUT_NOT_FOUND');
  if (payout.status !== 'PENDING') throw new AppError('Only pending payouts can be cancelled', 409, 'PAYOUT_NOT_PENDING');
  payout.status = 'CANCELLED';
  payout.note = req.body.reason || 'Payout cancelled by admin';
  await payout.save();
  await Notification.create({ userId: payout.riderId, role: 'RIDER', title: 'Payout cancelled', message: payout.note, type: 'RIDER_PAYOUT_CANCELLED', data: { payoutId: payout._id } });
  ok(res, payoutOut(payout), 'Payout cancelled');
}));

router.get('/admin/rider-finance-ledger', requireAuth, allowRoles('ADMIN'), ah(async (req, res) => {
  const riderId = req.query.riderId;
  if (!riderId) throw new AppError('Rider ID is required', 400, 'RIDER_ID_REQUIRED');
  ok(res, { items: await finance.financeHistory(riderId, Math.min(300, Math.max(1, Number(req.query.limit || 200)))) });
}));

module.exports = router;
