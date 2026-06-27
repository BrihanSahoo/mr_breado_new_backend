const express = require('express');
const mongoose = require('mongoose');
const ah = require('../utils/asyncHandler');
const { ok } = require('../utils/respond');
const { requireAuth, allowRoles } = require('../middleware/auth');
const { AppError } = require('../utils/errors');
const { Banner, Coupon, CouponUsage, Outlet, Order } = require('../models');
const promotions = require('../services/promotionService');
const media = require('../services/mediaService');
const { resolveObjectId } = require('../utils/compatId');

const router = express.Router();

router.use('/admin', requireAuth, allowRoles('ADMIN'));

function bool(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  return !['false', '0', 'off', 'no'].includes(String(value).toLowerCase());
}

function array(value) {
  if (Array.isArray(value)) return [...new Set(value.map(String).map((x) => x.trim()).filter(Boolean))];
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? [...new Set(parsed.map(String).map((x) => x.trim()).filter(Boolean))] : [];
  } catch (_) {
    return [...new Set(String(value).split(',').map((x) => x.trim()).filter(Boolean))];
  }
}

function date(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new AppError('Enter a valid date and time', 400, 'INVALID_PROMOTION_DATE');
  return parsed;
}

function imageUrl(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  return value.url || value.secureUrl || value.secure_url || '';
}

function pagination(req) {
  const page = Math.max(1, Number(req.query.page || 1));
  const perPage = Math.min(100, Math.max(1, Number(req.query.perPage || req.query.per_page || 20)));
  return { page, perPage, skip: (page - 1) * perPage };
}

function pageOut(items, total, page, perPage, extra = {}) {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  return { items, total, page, perPage, per_page: perPage, totalPages, total_pages: totalPages, ...extra };
}

function couponOut(doc) {
  const raw = doc?.toObject ? doc.toObject() : doc;
  const type = promotions.normalizeCouponType(raw.type);
  const benefit = promotions.couponBenefit(raw);
  const outletIds = (raw.outletIds || []).map((x) => String(x?._id || x));
  const outletNames = (raw.outletIds || []).map((x) => typeof x === 'object' ? x.name : '').filter(Boolean);
  const expired = Boolean(raw.endAt && new Date(raw.endAt) < new Date());
  return {
    ...raw,
    id: String(raw._id),
    code: String(raw.code || '').toUpperCase(),
    type,
    value: Number(raw.value || 0),
    minOrder: Number(raw.minOrder || 0), minOrderAmount: Number(raw.minOrder || 0),
    maxDiscount: Number(raw.maxDiscount || 0), maxDiscountAmount: Number(raw.maxDiscount || 0),
    startsAt: raw.startAt, expiresAt: raw.endAt, endsAt: raw.endAt,
    enabled: raw.active !== false && !expired, active: raw.active !== false && !expired,
    expired, status: expired ? 'EXPIRED' : raw.active === false ? 'INACTIVE' : 'ACTIVE',
    freeDelivery: benefit.freeDelivery, discountText: benefit.label,
    appliesToAllOutlets: raw.appliesToAllOutlets === true || outletIds.length === 0,
    outletIds, outletNames,
  };
}

function bannerOut(doc, coupon = null) {
  const raw = doc?.toObject ? doc.toObject() : doc;
  const outletIds = (raw.outletIds || []).map((x) => String(x?._id || x));
  const outletNames = (raw.outletIds || []).map((x) => typeof x === 'object' ? x.name : '').filter(Boolean);
  const code = String(raw.couponCode || (raw.actionType === 'COUPON' ? raw.actionValue : '') || coupon?.code || '').toUpperCase();
  const expired = Boolean(raw.endAt && new Date(raw.endAt) < new Date());
  return {
    ...raw,
    id: String(raw._id), image: imageUrl(raw.image), imageUrl: imageUrl(raw.image), banner: imageUrl(raw.image),
    couponCode: code, code, coupon: coupon ? couponOut(coupon) : null,
    enabled: raw.active !== false && !expired, active: raw.active !== false && !expired,
    expired, status: expired ? 'EXPIRED' : raw.active === false ? 'INACTIVE' : 'ACTIVE',
    startsAt: raw.startAt, endsAt: raw.endAt,
    priority: raw.sortOrder || 0, sortOrder: raw.sortOrder || 0,
    appliesToAllOutlets: raw.appliesToAllOutlets === true || outletIds.length === 0,
    outletIds, outletNames,
    scopeText: raw.appliesToAllOutlets === true || outletIds.length === 0 ? 'All outlets' : outletNames.join(', ') || `${outletIds.length} selected outlets`,
  };
}

async function validateScope(outletIds, appliesToAllOutlets) {
  if (appliesToAllOutlets) return [];
  if (!outletIds.length) throw new AppError('Select at least one outlet or enable all outlets', 400, 'OUTLET_SCOPE_REQUIRED');

  const resolved = [];
  for (const value of outletIds) {
    const id = await resolveObjectId(Outlet, value, { active: true });
    if (!id) throw new AppError('One or more selected outlets are invalid', 400, 'INVALID_OUTLET_SCOPE');
    const text = String(id);
    if (!resolved.some((item) => String(item) === text)) resolved.push(id);
  }
  return resolved;
}

function validRemoteImage(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const image = media.imageFromUrl(text, 'Banner image');
  if (!image) throw new AppError('Enter a valid HTTPS image URL', 400, 'INVALID_IMAGE_URL');
  return image;
}

async function bannerPayload(req, existing = null) {
  const requestedIds = array(req.body.outletIds ?? req.body.outlet_ids);
  const appliesToAllOutlets = bool(
    req.body.appliesToAllOutlets ?? req.body.applies_to_all_outlets,
    requestedIds.length === 0,
  );
  const outletIds = await validateScope(requestedIds, appliesToAllOutlets);

  const couponCode = String(req.body.couponCode || req.body.code || '').trim().toUpperCase();
  let coupon = null;
  if (couponCode) {
    coupon = await Coupon.findOne({ code: couponCode });
    if (!coupon) throw new AppError('Selected coupon does not exist', 409, 'COUPON_NOT_FOUND');
    if (coupon.active === false) throw new AppError('Selected coupon is inactive', 409, 'COUPON_INACTIVE');
    if (coupon.endAt && new Date(coupon.endAt) <= new Date()) throw new AppError('Selected coupon has expired', 409, 'COUPON_EXPIRED');

    if (!appliesToAllOutlets && coupon.appliesToAllOutlets !== true && Array.isArray(coupon.outletIds) && coupon.outletIds.length) {
      const allowed = new Set(coupon.outletIds.map(String));
      const incompatible = outletIds.some((id) => !allowed.has(String(id)));
      if (incompatible) throw new AppError('The selected coupon is not available for every selected outlet', 409, 'COUPON_OUTLET_MISMATCH');
    }
  }

  const startAt = date(req.body.startsAt ?? req.body.startAt ?? req.body.validFrom);
  const endAt = date(req.body.endsAt ?? req.body.endAt ?? req.body.expiresAt ?? req.body.validTo);
  if (startAt && endAt && startAt >= endAt) throw new AppError('Banner end time must be after its start time', 400, 'INVALID_DATE_RANGE');

  const title = String(req.body.title || '').trim();
  if (!title) throw new AppError('Banner title is required', 400, 'BANNER_TITLE_REQUIRED');
  if (title.length > 120) throw new AppError('Banner title must be 120 characters or fewer', 400, 'BANNER_TITLE_TOO_LONG');

  const uploaded = req.file ? await media.uploadImage(req.file, 'banners') : null;
  const remote = validRemoteImage(req.body.image || req.body.imageUrl);
  const image = uploaded || remote || existing?.image || null;

  return {
    payload: {
      title,
      subtitle: String(req.body.subtitle || '').trim().slice(0, 180),
      description: String(req.body.description || '').trim().slice(0, 1000),
      image,
      actionType: couponCode ? 'COUPON' : String(req.body.actionType || '').trim().toUpperCase(),
      actionValue: couponCode || String(req.body.actionValue || '').trim(),
      couponId: coupon?._id || null,
      couponCode: couponCode || '',
      appliesToAllOutlets,
      outletIds: appliesToAllOutlets ? [] : outletIds,
      startAt,
      endAt,
      active: bool(req.body.enabled ?? req.body.active, true),
      sortOrder: Math.max(0, Number(req.body.priority ?? req.body.sortOrder ?? 0) || 0),
    },
    uploaded,
  };
}

async function couponPayload(body) {
  const outletIds = array(body.outletIds ?? body.outlet_ids);
  const appliesToAllOutlets = bool(body.appliesToAllOutlets ?? body.applies_to_all_outlets, outletIds.length === 0);
  const resolvedOutletIds = await validateScope(outletIds, appliesToAllOutlets);
  const startAt = date(body.startsAt ?? body.startAt ?? body.validFrom);
  const endAt = date(body.expiresAt ?? body.endsAt ?? body.endAt ?? body.validTo);
  if (startAt && endAt && startAt >= endAt) throw new AppError('Coupon expiry must be after its start time', 400, 'INVALID_DATE_RANGE');
  const type = promotions.normalizeCouponType(body.type || body.discountType || (bool(body.freeDelivery, false) ? 'FREE_DELIVERY' : 'PERCENT'));
  const value = type === 'FREE_DELIVERY' ? 0 : Number(body.value ?? body.discountValue ?? 0);
  if (type !== 'FREE_DELIVERY' && (!Number.isFinite(value) || value <= 0)) throw new AppError('Enter a valid discount value', 400, 'INVALID_DISCOUNT_VALUE');
  if (type === 'PERCENT' && value > 100) throw new AppError('Percentage discount cannot exceed 100%', 400, 'INVALID_PERCENTAGE');
  const code = String(body.code || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z0-9_-]{3,30}$/.test(code)) throw new AppError('Coupon code must be 3-30 letters, numbers, hyphens or underscores', 400, 'INVALID_COUPON_CODE');
  return {
    code,
    title: String(body.title || '').trim(), description: String(body.description || '').trim(), type, value,
    minOrder: Number(body.minOrder ?? body.minOrderAmount ?? 0) || 0,
    maxDiscount: Number(body.maxDiscount ?? body.maxDiscountAmount ?? 0) || 0,
    usageLimit: Number(body.usageLimit || 0) || 0,
    perUserLimit: Number(body.perUserLimit || 0) || 0,
    startAt, endAt,
    active: bool(body.enabled ?? body.active, true),
    appliesToAllOutlets,
    outletIds: appliesToAllOutlets ? [] : resolvedOutletIds,
    productIds: array(body.productIds),
    paymentMethods: array(body.paymentMethods).map((x) => x.toUpperCase()),
    fulfilmentTypes: array(body.fulfilmentTypes).map((x) => x.toUpperCase()),
    eligibleCustomerIds: array(body.eligibleCustomerIds),
  };
}

router.get('/admin/banners', ah(async (req, res) => {
  await promotions.deactivateExpired();
  const { page, perPage, skip } = pagination(req);
  const [rows, total, coupons] = await Promise.all([
    Banner.find().populate('outletIds', 'name code slug').sort({ sortOrder: 1, createdAt: -1 }).skip(skip).limit(perPage),
    Banner.countDocuments(),
    Coupon.find().select('code title type value minOrder maxDiscount active startAt endAt outletIds appliesToAllOutlets').lean(),
  ]);
  const couponMap = new Map(coupons.map((x) => [String(x.code).toUpperCase(), x]));
  ok(res, pageOut(rows.map((row) => bannerOut(row, couponMap.get(String(row.couponCode || row.actionValue || '').toUpperCase()))), total, page, perPage));
}));

router.post('/admin/banners', media.imageUpload.single('imageFile'), ah(async (req, res) => {
  const { payload, uploaded } = await bannerPayload(req);
  if (!payload.image?.url) {
    if (uploaded?.publicId) await media.deleteImage(uploaded.publicId);
    throw new AppError('Banner image is required', 400, 'BANNER_IMAGE_REQUIRED');
  }
  try {
    const row = await Banner.create(payload);
    await row.populate('outletIds', 'name code slug');
    ok(res, bannerOut(row, payload.couponCode ? await Coupon.findOne({ code: payload.couponCode }).lean() : null), 'Banner created', 201);
  } catch (error) {
    if (uploaded?.publicId) await media.deleteImage(uploaded.publicId);
    throw error;
  }
}));

router.put('/admin/banners/:id', media.imageUpload.single('imageFile'), ah(async (req, res) => {
  const existing = await Banner.findById(req.params.id);
  if (!existing) throw new AppError('Banner not found', 404, 'BANNER_NOT_FOUND');
  const previousPublicId = existing.image?.publicId || '';
  const { payload, uploaded } = await bannerPayload(req, existing);
  try {
    const row = await Banner.findByIdAndUpdate(req.params.id, { $set: payload }, { new: true, runValidators: true }).populate('outletIds', 'name code slug');
    if (uploaded?.publicId && previousPublicId && previousPublicId !== uploaded.publicId) await media.deleteImage(previousPublicId);
    ok(res, bannerOut(row, payload.couponCode ? await Coupon.findOne({ code: payload.couponCode }).lean() : null), 'Banner updated');
  } catch (error) {
    if (uploaded?.publicId) await media.deleteImage(uploaded.publicId);
    throw error;
  }
}));

router.patch('/admin/banners/:id/status', ah(async (req, res) => {
  const row = await Banner.findByIdAndUpdate(req.params.id, { $set: { active: bool(req.body.enabled ?? req.body.active, true) } }, { new: true }).populate('outletIds', 'name code slug');
  if (!row) throw new AppError('Banner not found', 404, 'BANNER_NOT_FOUND');
  ok(res, bannerOut(row), 'Banner status updated');
}));

router.delete('/admin/banners/:id', ah(async (req, res) => {
  const row = await Banner.findByIdAndDelete(req.params.id);
  if (!row) throw new AppError('Banner not found', 404, 'BANNER_NOT_FOUND');
  if (row.image?.publicId) await media.deleteImage(row.image.publicId);
  ok(res, null, 'Banner deleted');
}));

router.get('/admin/coupons', ah(async (req, res) => {
  await promotions.deactivateExpired();
  const { page, perPage, skip } = pagination(req);
  const query = {};
  if (req.query.status === 'active') query.active = true;
  if (req.query.status === 'inactive') query.active = false;
  if (req.query.search) query.$or = [{ code: new RegExp(String(req.query.search), 'i') }, { title: new RegExp(String(req.query.search), 'i') }];
  const [rows, total] = await Promise.all([
    Coupon.find(query).populate('outletIds', 'name code slug').sort({ createdAt: -1 }).skip(skip).limit(perPage),
    Coupon.countDocuments(query),
  ]);
  ok(res, pageOut(rows.map(couponOut), total, page, perPage));
}));

router.post('/admin/coupons', ah(async (req, res) => {
  const payload = await couponPayload(req.body);
  if (await Coupon.exists({ code: payload.code })) throw new AppError('Coupon code already exists', 409, 'COUPON_CODE_EXISTS');
  const row = await Coupon.create(payload);
  await row.populate('outletIds', 'name code slug');
  ok(res, couponOut(row), 'Coupon created', 201);
}));

router.put('/admin/coupons/:id', ah(async (req, res) => {
  const payload = await couponPayload(req.body);
  if (await Coupon.exists({ code: payload.code, _id: { $ne: req.params.id } })) throw new AppError('Coupon code already exists', 409, 'COUPON_CODE_EXISTS');
  const row = await Coupon.findByIdAndUpdate(req.params.id, { $set: payload }, { new: true, runValidators: true }).populate('outletIds', 'name code slug');
  if (!row) throw new AppError('Coupon not found', 404, 'COUPON_NOT_FOUND');
  ok(res, couponOut(row), 'Coupon updated');
}));

router.patch('/admin/coupons/:id/status', ah(async (req, res) => {
  const row = await Coupon.findByIdAndUpdate(req.params.id, { $set: { active: bool(req.body.enabled ?? req.body.active, true) } }, { new: true }).populate('outletIds', 'name code slug');
  if (!row) throw new AppError('Coupon not found', 404, 'COUPON_NOT_FOUND');
  ok(res, couponOut(row), 'Coupon status updated');
}));

router.delete('/admin/coupons/:id', ah(async (req, res) => {
  const row = await Coupon.findByIdAndUpdate(req.params.id, { $set: { active: false } }, { new: true }).populate('outletIds', 'name code slug');
  if (!row) throw new AppError('Coupon not found', 404, 'COUPON_NOT_FOUND');
  ok(res, couponOut(row), 'Coupon deactivated');
}));

router.get(['/admin/coupon-usages', '/admin/coupons/usage-history'], ah(async (req, res) => {
  const { page, perPage, skip } = pagination(req);
  const query = {};
  if (req.query.code) query.code = String(req.query.code).trim().toUpperCase();
  if (req.query.status) query.status = String(req.query.status).toUpperCase();
  if (req.query.outletId) {
    if (!mongoose.isValidObjectId(req.query.outletId)) throw new AppError('Invalid outlet filter', 400, 'INVALID_OUTLET_ID');
    query.outletId = new mongoose.Types.ObjectId(req.query.outletId);
  }
  if (req.query.couponId) {
    if (!mongoose.isValidObjectId(req.query.couponId)) throw new AppError('Invalid coupon filter', 400, 'INVALID_COUPON_ID');
    query.couponId = new mongoose.Types.ObjectId(req.query.couponId);
  }
  const [rows, total, totals] = await Promise.all([
    CouponUsage.find(query)
      .populate('couponId', 'title code type value')
      .populate('customerId', 'name email phone legacyId')
      .populate('outletId', 'name code slug legacyId')
      .populate({ path: 'orderId', select: 'slug legacyId status total subtotal discount deliveryCharge paymentMethod paymentStatus fulfilmentType createdAt deliveredAt items' })
      .sort({ createdAt: -1 }).skip(skip).limit(perPage).lean(),
    CouponUsage.countDocuments(query),
    CouponUsage.aggregate([{ $match: query }, { $group: { _id: '$status', amount: { $sum: '$discountAmount' }, count: { $sum: 1 } } }]),
  ]);
  const items = rows.map((usage) => ({
    ...usage,
    id: String(usage._id),
    couponId: usage.couponId?._id ? String(usage.couponId._id) : String(usage.couponId || ''),
    couponTitle: usage.couponId?.title || '', couponCode: usage.code,
    customer: usage.customerId ? { id: usage.customerId.legacyId ?? String(usage.customerId._id), name: usage.customerId.name, email: usage.customerId.email, phone: usage.customerId.phone } : null,
    customerName: usage.customerId?.name || '', customerEmail: usage.customerId?.email || '', customerPhone: usage.customerId?.phone || '',
    outlet: usage.outletId ? { id: usage.outletId.legacyId ?? String(usage.outletId._id), name: usage.outletId.name, code: usage.outletId.code, slug: usage.outletId.slug } : null,
    outletName: usage.outletId?.name || '',
    order: usage.orderId ? { id: usage.orderId.legacyId ?? String(usage.orderId._id), orderNumber: usage.orderId.slug, status: usage.orderId.status, total: usage.orderId.total, subtotal: usage.orderId.subtotal, discount: usage.orderId.discount, deliveryCharge: usage.orderId.deliveryCharge, paymentMethod: usage.orderId.paymentMethod, paymentStatus: usage.orderId.paymentStatus, fulfilmentType: usage.orderId.fulfilmentType, createdAt: usage.orderId.createdAt, deliveredAt: usage.orderId.deliveredAt, items: usage.orderId.items } : null,
    orderNumber: usage.orderId?.slug || '', discountAmount: Number(usage.discountAmount || 0),
  }));
  const summary = {
    reservedCount: Number(totals.find((x) => x._id === 'RESERVED')?.count || 0),
    consumedCount: Number(totals.find((x) => x._id === 'CONSUMED')?.count || 0),
    releasedCount: Number(totals.find((x) => x._id === 'RELEASED')?.count || 0),
    consumedDiscount: Number(totals.find((x) => x._id === 'CONSUMED')?.amount || 0),
    totalDiscount: totals.reduce((sum, x) => sum + Number(x.amount || 0), 0),
  };
  ok(res, pageOut(items, total, page, perPage, { summary }));
}));

router.get('/admin/coupons/:id/usages', ah(async (req, res) => {
  req.query.couponId = req.params.id;
  const rows = await CouponUsage.find({ couponId: req.params.id }).populate('customerId outletId orderId').sort({ createdAt: -1 }).lean();
  ok(res, rows);
}));

module.exports = router;
