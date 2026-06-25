const { Banner, Offer, Coupon } = require('../models');

function dateWindow(now = new Date()) {
  return {
    $and: [
      { $or: [{ startAt: null }, { startAt: { $exists: false } }, { startAt: { $lte: now } }] },
      { $or: [{ endAt: null }, { endAt: { $exists: false } }, { endAt: { $gte: now } }] },
    ],
  };
}

function outletScope(outletId) {
  if (!outletId) return {};
  return {
    $or: [
      { appliesToAllOutlets: true },
      { appliesToAllOutlets: { $exists: false }, outletIds: { $size: 0 } },
      { outletIds: outletId },
    ],
  };
}

function appliesToOutlet(doc, outletId) {
  const ids = Array.isArray(doc?.outletIds) ? doc.outletIds.map(String) : [];
  if (doc?.appliesToAllOutlets === true || ids.length === 0) return true;
  return Boolean(outletId) && ids.includes(String(outletId));
}

function isActiveNow(doc, now = new Date()) {
  if (!doc || doc.active === false) return false;
  const start = doc.startAt ? new Date(doc.startAt) : null;
  const end = doc.endAt ? new Date(doc.endAt) : null;
  return (!start || start <= now) && (!end || end >= now);
}

async function deactivateExpired(now = new Date()) {
  const expired = { active: true, endAt: { $ne: null, $lt: now } };
  await Promise.all([
    Coupon.updateMany(expired, { $set: { active: false } }),
    Offer.updateMany(expired, { $set: { active: false } }),
    Banner.updateMany(expired, { $set: { active: false } }),
  ]);
}

async function validCouponMap({ outletId, now = new Date() } = {}) {
  await deactivateExpired(now);
  const rows = await Coupon.find({ active: true, ...dateWindow(now), ...outletScope(outletId) }).lean();
  return new Map(rows.map((row) => [String(row.code || '').trim().toUpperCase(), row]));
}

function normalizeCouponType(value) {
  const type = String(value || '').trim().toUpperCase().replace(/[-\s]/g, '_');
  if (['DELIVERY', 'FREEDELIVERY', 'FREE_DELIVERY'].includes(type)) return 'FREE_DELIVERY';
  if (['FLAT', 'FIXED', 'AMOUNT'].includes(type)) return 'FLAT';
  return 'PERCENT';
}

function couponBenefit(coupon) {
  if (!coupon) return { label: '', freeDelivery: false };
  const type = normalizeCouponType(coupon.type);
  const value = Number(coupon.value || 0);
  if (type === 'FREE_DELIVERY') return { label: 'FREE DELIVERY', freeDelivery: true };
  if (type === 'FLAT') return { label: `₹${value.toFixed(value % 1 ? 2 : 0)} OFF`, freeDelivery: false };
  return { label: `${value.toFixed(value % 1 ? 1 : 0)}% OFF`, freeDelivery: false };
}

module.exports = {
  dateWindow,
  outletScope,
  appliesToOutlet,
  isActiveNow,
  deactivateExpired,
  validCouponMap,
  normalizeCouponType,
  couponBenefit,
};
