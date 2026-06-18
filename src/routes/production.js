const express = require('express');
const mongoose = require('mongoose');
const ah = require('../utils/asyncHandler');
const { ok } = require('../utils/respond');
const { requireAuth, allowRoles } = require('../middleware/auth');
const analytics = require('../services/businessAnalyticsService');
const { Payment, Order, OutletProduct } = require('../models');

const r = express.Router();
r.use(requireAuth, allowRoles('ADMIN'));

r.get('/admin/business-metrics', ah(async (req, res) => ok(res, await analytics.overview(req.query))));
r.get('/admin/outlet-performance', ah(async (req, res) => ok(res, await analytics.outletPerformance(req.query))));
r.get('/admin/operational-alerts', ah(async (_req, res) => ok(res, await analytics.operationalAlerts())));

r.get('/admin/reconciliation/payments', ah(async (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit || 100)));
  const payments = await Payment.find({ status: { $in: ['SUCCESS', 'CAPTURED', 'PAID', 'FAILED'] } })
    .populate('orderId', 'slug total paidAmount balanceDue paymentStatus status')
    .sort({ createdAt: -1 }).limit(limit).lean();
  const items = payments.map((p) => ({
    ...p,
    mismatch: !p.orderId || (['SUCCESS', 'CAPTURED', 'PAID'].includes(p.status) && !['SUCCESS', 'PAID', 'PARTIALLY_PAID'].includes(p.orderId.paymentStatus)),
  }));
  ok(res, { items, mismatchCount: items.filter((x) => x.mismatch).length });
}));

r.get('/admin/inventory/alerts', ah(async (req, res) => {
  const query = req.query.outletId && mongoose.isValidObjectId(req.query.outletId) ? { outletId: req.query.outletId } : {};
  const rows = await OutletProduct.find({ ...query, $expr: { $lte: [{ $subtract: ['$stockQuantity', '$reservedQuantity'] }, '$lowStockThreshold'] } })
    .populate('outletId productId').sort({ updatedAt: -1 }).lean();
  ok(res, rows.map((x) => ({ ...x, availableStock: Number(x.stockQuantity || 0) - Number(x.reservedQuantity || 0) })));
}));

module.exports = r;
