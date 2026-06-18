const mongoose = require('mongoose');
const {
  Order, Payment, Refund, OfflineSale, Outlet, OutletProduct, Product, User,
} = require('../models');

function dateRange(query = {}) {
  const now = new Date();
  const to = query.to ? new Date(query.to) : now;
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * 86400000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new Error('Invalid date range');
  return { from, to };
}

function oid(value) {
  return value ? new mongoose.Types.ObjectId(value) : null;
}

async function overview(query = {}) {
  const { from, to } = dateRange(query);
  const orderMatch = { createdAt: { $gte: from, $lte: to } };
  if (query.outletId) orderMatch.outletId = oid(query.outletId);
  const deliveredMatch = { ...orderMatch, status: 'DELIVERED' };
  const paymentMatch = { createdAt: { $gte: from, $lte: to }, status: { $in: ['SUCCESS', 'PAID', 'CAPTURED'] } };
  if (query.outletId) paymentMatch.outletId = oid(query.outletId);

  const [orderSummary, paymentSummary, refundSummary, offlineSummary, customers, outlets, lowStock, statusBreakdown] = await Promise.all([
    Order.aggregate([
      { $match: orderMatch },
      { $group: {
        _id: null,
        totalOrders: { $sum: 1 },
        deliveredOrders: { $sum: { $cond: [{ $eq: ['$status', 'DELIVERED'] }, 1, 0] } },
        cancelledOrders: { $sum: { $cond: [{ $eq: ['$status', 'CANCELLED'] }, 1, 0] } },
        deliveredRevenue: { $sum: { $cond: [{ $eq: ['$status', 'DELIVERED'] }, '$total', 0] } },
        deliveryFees: { $sum: { $cond: [{ $eq: ['$status', 'DELIVERED'] }, '$deliveryCharge', 0] } },
        discounts: { $sum: '$discount' },
        taxes: { $sum: { $cond: [{ $eq: ['$status', 'DELIVERED'] }, '$tax', 0] } },
        averageOrderValue: { $avg: { $cond: [{ $eq: ['$status', 'DELIVERED'] }, '$total', null] } },
      } },
    ]),
    Payment.aggregate([{ $match: paymentMatch }, { $group: { _id: null, amount: { $sum: '$amount' }, count: { $sum: 1 } } }]),
    Refund.aggregate([{ $match: { createdAt: { $gte: from, $lte: to }, ...(query.outletId ? { outletId: oid(query.outletId) } : {}) } }, { $group: { _id: null, amount: { $sum: '$amount' }, count: { $sum: 1 } } }]),
    OfflineSale.aggregate([{ $match: { createdAt: { $gte: from, $lte: to }, ...(query.outletId ? { outletId: oid(query.outletId) } : {}) } }, { $group: { _id: null, amount: { $sum: '$total' }, count: { $sum: 1 } } }]),
    User.countDocuments({ role: 'CUSTOMER', createdAt: { $gte: from, $lte: to } }),
    Outlet.countDocuments(query.outletId ? { _id: oid(query.outletId) } : {}),
    OutletProduct.countDocuments({ $expr: { $lte: [{ $subtract: ['$stockQuantity', '$reservedQuantity'] }, '$lowStockThreshold'] }, ...(query.outletId ? { outletId: oid(query.outletId) } : {}) }),
    Order.aggregate([{ $match: orderMatch }, { $group: { _id: '$status', count: { $sum: 1 }, value: { $sum: '$total' } } }, { $sort: { count: -1 } }]),
  ]);

  const o = orderSummary[0] || {};
  const p = paymentSummary[0] || {};
  const r = refundSummary[0] || {};
  const off = offlineSummary[0] || {};
  const totalOrders = Number(o.totalOrders || 0);
  const delivered = Number(o.deliveredOrders || 0);
  const cancelled = Number(o.cancelledOrders || 0);
  return {
    period: { from, to },
    totalOrders,
    deliveredOrders: delivered,
    cancelledOrders: cancelled,
    fulfilmentRate: totalOrders ? Number(((delivered / totalOrders) * 100).toFixed(2)) : 0,
    cancellationRate: totalOrders ? Number(((cancelled / totalOrders) * 100).toFixed(2)) : 0,
    totalRevenue: Number(o.deliveredRevenue || 0),
    grossMerchandiseValue: Number(o.deliveredRevenue || 0) + Number(off.amount || 0),
    onlineCollected: Number(p.amount || 0),
    offlineSales: Number(off.amount || 0),
    refunds: Number(r.amount || 0),
    netCollected: Math.max(0, Number(p.amount || 0) + Number(off.amount || 0) - Number(r.amount || 0)),
    deliveryFees: Number(o.deliveryFees || 0),
    discounts: Number(o.discounts || 0),
    taxes: Number(o.taxes || 0),
    averageOrderValue: Number((o.averageOrderValue || 0).toFixed?.(2) || 0),
    newCustomers: customers,
    totalOutlets: outlets,
    lowStockItems: lowStock,
    statusBreakdown,
  };
}

async function outletPerformance(query = {}) {
  const { from, to } = dateRange(query);
  return Order.aggregate([
    { $match: { createdAt: { $gte: from, $lte: to } } },
    { $group: {
      _id: '$outletId',
      totalOrders: { $sum: 1 },
      deliveredOrders: { $sum: { $cond: [{ $eq: ['$status', 'DELIVERED'] }, 1, 0] } },
      cancelledOrders: { $sum: { $cond: [{ $eq: ['$status', 'CANCELLED'] }, 1, 0] } },
      revenue: { $sum: { $cond: [{ $eq: ['$status', 'DELIVERED'] }, '$total', 0] } },
      avgAcceptanceMinutes: { $avg: { $cond: [{ $and: ['$acceptedAt', '$createdAt'] }, { $divide: [{ $subtract: ['$acceptedAt', '$createdAt'] }, 60000] }, null] } },
      avgPreparationMinutes: { $avg: { $cond: [{ $and: ['$readyAt', '$acceptedAt'] }, { $divide: [{ $subtract: ['$readyAt', '$acceptedAt'] }, 60000] }, null] } },
      avgDeliveryMinutes: { $avg: { $cond: [{ $and: ['$deliveredAt', '$pickedUpAt'] }, { $divide: [{ $subtract: ['$deliveredAt', '$pickedUpAt'] }, 60000] }, null] } },
    } },
    { $lookup: { from: 'outlets', localField: '_id', foreignField: '_id', as: 'outlet' } },
    { $unwind: { path: '$outlet', preserveNullAndEmptyArrays: true } },
    { $project: {
      outletId: '$_id', _id: 0, outletName: '$outlet.name', outletCode: '$outlet.code',
      totalOrders: 1, deliveredOrders: 1, cancelledOrders: 1, revenue: 1,
      averageOrderValue: { $cond: [{ $gt: ['$deliveredOrders', 0] }, { $divide: ['$revenue', '$deliveredOrders'] }, 0] },
      cancellationRate: { $cond: [{ $gt: ['$totalOrders', 0] }, { $multiply: [{ $divide: ['$cancelledOrders', '$totalOrders'] }, 100] }, 0] },
      avgAcceptanceMinutes: { $round: ['$avgAcceptanceMinutes', 2] },
      avgPreparationMinutes: { $round: ['$avgPreparationMinutes', 2] },
      avgDeliveryMinutes: { $round: ['$avgDeliveryMinutes', 2] },
    } },
    { $sort: { revenue: -1 } },
  ]);
}

async function operationalAlerts() {
  const now = new Date();
  const staleLocationAt = new Date(now.getTime() - 5 * 60000);
  const [sellerTimeout, riderTimeout, paymentMismatch, invoiceMissing, lowStock] = await Promise.all([
    Order.find({ status: 'RECEIVED', sellerAcceptanceDeadline: { $lte: now } }).select('slug outletId sellerAcceptanceDeadline').lean(),
    Order.find({ status: { $in: ['READY', 'RIDER_ASSIGNMENT_PENDING'] }, riderAcceptanceDeadline: { $lte: now } }).select('slug outletId riderAcceptanceDeadline').lean(),
    Payment.find({ status: 'SUCCESS' }).populate({ path: 'orderId', select: 'slug paymentStatus status' }).lean(),
    Order.find({ status: 'DELIVERED', $or: [{ invoiceStatus: { $exists: false } }, { invoiceStatus: { $ne: 'GENERATED' } }] }).select('slug outletId deliveredAt').limit(100).lean(),
    OutletProduct.find({ $expr: { $lte: [{ $subtract: ['$stockQuantity', '$reservedQuantity'] }, '$lowStockThreshold'] } }).populate('outletId productId').limit(200).lean(),
  ]);
  const mismatches = paymentMismatch.filter((p) => p.orderId && !['SUCCESS', 'PAID', 'PARTIALLY_PAID'].includes(p.orderId.paymentStatus));
  return {
    generatedAt: now,
    counts: { sellerTimeout: sellerTimeout.length, riderTimeout: riderTimeout.length, paymentMismatch: mismatches.length, invoiceMissing: invoiceMissing.length, lowStock: lowStock.length },
    sellerTimeout, riderTimeout, paymentMismatch: mismatches, invoiceMissing,
    lowStock: lowStock.map((x) => ({ outletId: x.outletId?._id, outletName: x.outletId?.name, productId: x.productId?._id, productName: x.productId?.name, availableStock: Number(x.stockQuantity || 0) - Number(x.reservedQuantity || 0), threshold: x.lowStockThreshold })),
    staleLocationThreshold: staleLocationAt,
  };
}

module.exports = { overview, outletPerformance, operationalAlerts, dateRange };
