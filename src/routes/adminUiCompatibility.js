const express = require('express');
const ah = require('../utils/asyncHandler');
const { ok } = require('../utils/respond');
const { requireAuth, allowRoles } = require('../middleware/auth');
const { AppError } = require('../utils/errors');
const {
  User, Outlet, Product, OutletProduct, Order, Payment, Offer, Review,
  SupportTicket, Notification, Setting, VerificationRequest, DailyClosing,
} = require('../models');
const settings = require('../services/settingsService');
const media = require('../services/mediaService');
const { findOneCompat, resolveObjectId } = require('../utils/compatId');

const router = express.Router();
router.use('/admin', requireAuth, allowRoles('ADMIN'));

const text = (value) => String(value ?? '').trim();
const upper = (value) => text(value).toUpperCase();
const boolean = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  return !['false', '0', 'off', 'no', 'inactive', 'disabled'].includes(String(value).toLowerCase());
};
const number = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
function paging(req, max = 100) {
  const page = Math.max(1, Math.trunc(number(req.query.page, 1)));
  const perPage = Math.min(max, Math.max(1, Math.trunc(number(req.query.perPage ?? req.query.per_page, 20))));
  return { page, perPage, skip: (page - 1) * perPage };
}
function page(items, total, currentPage, perPage, extra = {}) {
  const totalPages = Math.max(1, Math.ceil(total / Math.max(1, perPage)));
  return { items, total, page: currentPage, perPage, per_page: perPage, totalPages, total_pages: totalPages, last: currentPage >= totalPages, ...extra };
}
function escapeRegex(value) { return text(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function userOut(doc) {
  const raw = doc?.toObject ? doc.toObject() : doc;
  if (!raw) return null;
  return {
    ...raw,
    id: raw.legacyId ?? String(raw._id),
    mongoId: String(raw._id),
    name: raw.name || '',
    fullName: raw.name || '',
    mobile: raw.phone || '',
    phoneNumber: raw.phone || '',
    enabled: raw.active !== false,
    blocked: raw.active === false,
    status: raw.active === false ? 'BLOCKED' : 'ACTIVE',
    profileImage: raw.avatar?.url || '',
  };
}
function outletOut(doc) {
  const raw = doc?.toObject ? doc.toObject() : doc;
  if (!raw) return null;
  const coordinates = raw.location?.coordinates || [0, 0];
  return {
    ...raw,
    id: raw.legacyId ?? String(raw._id),
    mongoId: String(raw._id),
    outletName: raw.name,
    logo: raw.logo?.url || '',
    logoUrl: raw.logo?.url || '',
    banner: raw.coverImage?.url || '',
    bannerUrl: raw.coverImage?.url || '',
    latitude: Number(coordinates[1] || 0),
    longitude: Number(coordinates[0] || 0),
    serviceRadiusKm: Number(raw.deliveryRadiusKm || 0),
    isOpen: raw.open === true,
    isActive: raw.active !== false,
    status: raw.active === false ? 'INACTIVE' : 'ACTIVE',
    verificationStatus: raw.active === false ? 'UNVERIFIED' : 'VERIFIED',
  };
}
function productOut(doc) {
  const raw = doc?.toObject ? doc.toObject() : doc;
  if (!raw) return null;
  return {
    ...raw,
    id: raw.legacyId ?? String(raw._id),
    mongoId: String(raw._id),
    title: raw.name,
    image: raw.images?.[0]?.url || '',
    imageUrl: raw.images?.[0]?.url || '',
    price: Number(raw.basePrice || 0),
    enabled: raw.active !== false,
    available: raw.active !== false,
    category: raw.categoryId?.name || raw.categoryId || null,
    brand: raw.brandId?.name || raw.brandId || null,
    cuisine: raw.cuisineId?.name || raw.cuisineId || null,
  };
}
function orderOut(doc) {
  const raw = doc?.toObject ? doc.toObject() : doc;
  if (!raw) return null;
  return {
    ...raw,
    id: raw.legacyId ?? String(raw._id),
    mongoId: String(raw._id),
    orderNumber: raw.slug || `ORDER-${raw.legacyId ?? String(raw._id).slice(-6)}`,
    customerName: raw.customerId?.name || '',
    outletName: raw.outletId?.name || '',
    riderName: raw.riderId?.name || '',
  };
}
function ticketStatus(value) {
  const status = upper(value || 'OPEN');
  if (status === 'OPEN') return 'PENDING';
  if (status === 'ASSIGNED') return 'ACTIVE';
  return status;
}
function ticketOut(doc) {
  const raw = doc?.toObject ? doc.toObject() : doc;
  if (!raw) return null;
  const user = raw.userId && typeof raw.userId === 'object' ? raw.userId : null;
  const employee = raw.assignedTo && typeof raw.assignedTo === 'object' ? raw.assignedTo : null;
  return {
    ...raw,
    id: raw.legacyId ?? String(raw._id),
    mongoId: String(raw._id),
    ticketNumber: `TKT-${raw.legacyId ?? String(raw._id).slice(-6).toUpperCase()}`,
    userName: user?.name || 'User',
    employeeName: employee?.name || '',
    userType: user?.role || 'CUSTOMER',
    type: user?.role || 'CUSTOMER',
    issue: raw.subject || 'Support issue',
    description: raw.message || '',
    status: ticketStatus(raw.status),
    user: user ? { name: user.name, email: user.email, phone: user.phone, type: user.role } : null,
    assignedEmployee: employee ? { name: employee.name, email: employee.email, phone: employee.phone } : null,
  };
}

// Users / outlet managers -----------------------------------------------------
router.get('/admin/users', ah(async (req, res) => {
  const { page: currentPage, perPage, skip } = paging(req);
  const query = {};
  if (req.query.role) query.role = upper(req.query.role);
  if (req.query.search) {
    const regex = new RegExp(escapeRegex(req.query.search), 'i');
    query.$or = [{ name: regex }, { email: regex }, { phone: regex }, { username: regex }];
  }
  const [rows, total] = await Promise.all([
    User.find(query).select('-passwordHash -passwordResetCodeHash').sort({ createdAt: -1 }).skip(skip).limit(perPage),
    User.countDocuments(query),
  ]);
  ok(res, page(rows.map(userOut), total, currentPage, perPage));
}));
router.get('/admin/users/:id', ah(async (req, res) => {
  const user = await findOneCompat(User, req.params.id);
  if (!user) throw new AppError('User not found', 404, 'USER_NOT_FOUND');
  ok(res, userOut(user));
}));
router.put('/admin/users/:id', ah(async (req, res) => {
  const user = await findOneCompat(User, req.params.id);
  if (!user) throw new AppError('User not found', 404, 'USER_NOT_FOUND');
  const name = text(req.body.name ?? req.body.fullName);
  const email = text(req.body.email).toLowerCase();
  const phone = text(req.body.phone ?? req.body.mobile ?? req.body.phoneNumber);
  if (name) user.name = name;
  if (email && email !== user.email) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError('Enter a valid email address', 400, 'INVALID_EMAIL');
    if (await User.exists({ email, _id: { $ne: user._id } })) throw new AppError('Email is already in use', 409, 'EMAIL_ALREADY_USED');
    user.email = email;
  }
  if (phone && phone !== user.phone) {
    if (await User.exists({ phone, _id: { $ne: user._id } })) throw new AppError('Phone number is already in use', 409, 'PHONE_ALREADY_USED');
    user.phone = phone;
  }
  await user.save();
  ok(res, userOut(user), 'User updated');
}));
router.put(['/admin/users/:id/status', '/admin/customers/:id/status'], ah(async (req, res) => {
  const user = await findOneCompat(User, req.params.id);
  if (!user) throw new AppError('User not found', 404, 'USER_NOT_FOUND');
  const enabled = req.body.blocked !== undefined ? !boolean(req.body.blocked) : boolean(req.body.enabled ?? req.body.active, true);
  if (String(user._id) === String(req.user.id) && !enabled) throw new AppError('You cannot disable your own admin account', 409, 'SELF_DISABLE_FORBIDDEN');
  user.active = enabled;
  await user.save();
  ok(res, userOut(user), enabled ? 'User enabled' : 'User blocked');
}));
router.patch(['/admin/owners/:id/status', '/admin/drivers/:id/status'], ah(async (req, res) => {
  const user = await findOneCompat(User, req.params.id);
  if (!user) throw new AppError('Account not found', 404, 'USER_NOT_FOUND');
  user.active = boolean(req.body.enabled ?? req.body.active, true);
  if (!user.active && user.role === 'RIDER') {
    user.riderProfile.online = false;
    user.riderProfile.available = false;
  }
  await user.save();
  ok(res, userOut(user), user.active ? 'Account enabled' : 'Account disabled');
}));
router.patch('/admin/owners/:id/verification', ah(async (req, res) => {
  const user = await findOneCompat(User, req.params.id, { role: 'SELLER' });
  if (!user) throw new AppError('Outlet manager not found', 404, 'SELLER_NOT_FOUND');
  user.active = boolean(req.body.verified, true);
  await user.save();
  ok(res, userOut(user), user.active ? 'Outlet manager verified' : 'Outlet manager unverified');
}));

// Support --------------------------------------------------------------------
router.get('/admin/support/dashboard', ah(async (_req, res) => {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const [allTickets, allPending, todayPending, todayActive, todayRows] = await Promise.all([
    SupportTicket.countDocuments(),
    SupportTicket.countDocuments({ status: { $in: ['OPEN', 'PENDING'] } }),
    SupportTicket.countDocuments({ createdAt: { $gte: start }, status: { $in: ['OPEN', 'PENDING'] } }),
    SupportTicket.countDocuments({ createdAt: { $gte: start }, status: { $in: ['ACTIVE', 'ASSIGNED', 'IN_PROGRESS'] } }),
    SupportTicket.find({ createdAt: { $gte: start } }).populate('userId assignedTo', 'name email phone role').sort({ createdAt: -1 }).limit(20),
  ]);
  ok(res, { allTickets, allPending, todayPending, todayActive, todayTickets: todayRows.map(ticketOut) });
}));
async function supportList(req, todayOnly = false) {
  const { page: currentPage, perPage, skip } = paging(req);
  const query = {};
  if (todayOnly) { const start = new Date(); start.setHours(0, 0, 0, 0); query.createdAt = { $gte: start }; }
  if (req.query.status) {
    const status = upper(req.query.status);
    query.status = status === 'PENDING' ? { $in: ['OPEN', 'PENDING'] } : status;
  }
  if (req.query.search) {
    const regex = new RegExp(escapeRegex(req.query.search), 'i');
    query.$or = [{ subject: regex }, { message: regex }];
  }
  const [rows, total] = await Promise.all([
    SupportTicket.find(query).populate('userId assignedTo', 'name email phone role').sort({ createdAt: -1 }).skip(skip).limit(perPage),
    SupportTicket.countDocuments(query),
  ]);
  return page(rows.map(ticketOut), total, currentPage, perPage);
}
router.get('/admin/support/tickets/today', ah(async (req, res) => ok(res, await supportList(req, true))));
router.get('/admin/support/tickets', ah(async (req, res) => ok(res, await supportList(req, false))));
router.get('/admin/support/tickets/:id', ah(async (req, res) => {
  const ticket = await findOneCompat(SupportTicket, req.params.id);
  if (!ticket) throw new AppError('Support ticket not found', 404, 'TICKET_NOT_FOUND');
  await ticket.populate('userId assignedTo', 'name email phone role');
  ok(res, ticketOut(ticket));
}));
router.patch('/admin/support/tickets/:id/accept', ah(async (req, res) => {
  const ticket = await findOneCompat(SupportTicket, req.params.id);
  if (!ticket) throw new AppError('Support ticket not found', 404, 'TICKET_NOT_FOUND');
  ticket.status = 'ACTIVE'; ticket.assignedTo = req.user.id; await ticket.save();
  await ticket.populate('userId assignedTo', 'name email phone role');
  ok(res, ticketOut(ticket), 'Ticket accepted');
}));
router.post('/admin/support/tickets/:id/reply', ah(async (req, res) => {
  const message = text(req.body.message ?? req.body.description);
  if (!message) throw new AppError('Reply message is required', 400, 'REPLY_REQUIRED');
  const ticket = await findOneCompat(SupportTicket, req.params.id);
  if (!ticket) throw new AppError('Support ticket not found', 404, 'TICKET_NOT_FOUND');
  ticket.responses.push({ senderId: req.user.id, message, createdAt: new Date() });
  ticket.status = 'IN_PROGRESS'; ticket.assignedTo = ticket.assignedTo || req.user.id; await ticket.save();
  await Notification.create({ userId: ticket.userId, role: 'CUSTOMER', title: `Support update: ${ticket.subject || 'Ticket'}`, message, type: 'SUPPORT_REPLY', data: { ticketId: ticket._id } });
  await ticket.populate('userId assignedTo', 'name email phone role');
  ok(res, ticketOut(ticket), 'Reply sent');
}));
router.patch('/admin/support/tickets/:id/status', ah(async (req, res) => {
  const requested = upper(req.body.status);
  const allowed = new Set(['PENDING', 'ACTIVE', 'IN_PROGRESS', 'COMPLETED', 'RESOLVED', 'CLOSED']);
  if (!allowed.has(requested)) throw new AppError('Invalid support ticket status', 400, 'INVALID_TICKET_STATUS');
  const stored = requested === 'PENDING' ? 'OPEN' : requested;
  const ticket = await findOneCompat(SupportTicket, req.params.id);
  if (!ticket) throw new AppError('Support ticket not found', 404, 'TICKET_NOT_FOUND');
  ticket.status = stored; if (stored !== 'OPEN') ticket.assignedTo = ticket.assignedTo || req.user.id; await ticket.save();
  await ticket.populate('userId assignedTo', 'name email phone role');
  ok(res, ticketOut(ticket), 'Ticket status updated');
}));
router.delete('/admin/support/tickets/:id', ah(async (req, res) => {
  const ticket = await findOneCompat(SupportTicket, req.params.id);
  if (!ticket) throw new AppError('Support ticket not found', 404, 'TICKET_NOT_FOUND');
  await ticket.deleteOne(); ok(res, null, 'Ticket deleted');
}));

// Reviews --------------------------------------------------------------------
router.get('/admin/reviews', ah(async (req, res) => {
  const { page: currentPage, perPage, skip } = paging(req);
  const [rows, total] = await Promise.all([
    Review.find().populate('customerId', 'name email').populate('orderId', 'slug legacyId riderId').populate('outletId', 'name legacyId').populate('productId', 'name').sort({ createdAt: -1 }).skip(skip).limit(perPage).lean(),
    Review.countDocuments(),
  ]);
  const items = rows.map((raw) => ({
    ...raw,
    id: raw.legacyId ?? String(raw._id),
    orderId: raw.orderId?.legacyId ?? String(raw.orderId?._id || ''),
    orderNumber: raw.orderId?.slug || '',
    restaurantRating: Number(raw.rating || 0),
    restaurantComment: raw.comment || '',
    driverRating: 0,
    driverComment: '',
    customerName: raw.customerId?.name || '',
    outletName: raw.outletId?.name || '',
    productName: raw.productId?.name || '',
  }));
  ok(res, page(items, total, currentPage, perPage));
}));

// Offers -----------------------------------------------------------------------
function arrayValue(value) {
  if (Array.isArray(value)) return value.map(String).map((x) => x.trim()).filter(Boolean);
  if (!value) return [];
  try { const parsed = JSON.parse(String(value)); return Array.isArray(parsed) ? parsed.map(String).map((x) => x.trim()).filter(Boolean) : []; }
  catch (_) { return String(value).split(',').map((x) => x.trim()).filter(Boolean); }
}
function dateValue(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new AppError('Enter a valid offer date', 400, 'INVALID_OFFER_DATE');
  return parsed;
}
function offerOut(doc) {
  const raw = doc?.toObject ? doc.toObject() : doc;
  if (!raw) return null;
  const image = raw.image?.url || (typeof raw.image === 'string' ? raw.image : '');
  const outletIds = (raw.outletIds || []).map((x) => String(x?._id || x));
  return {
    ...raw,
    id: raw.legacyId ?? String(raw._id),
    mongoId: String(raw._id),
    image,
    imageUrl: image,
    banner: image,
    enabled: raw.active !== false,
    discountType: raw.type || 'PERCENT',
    discountValue: Number(raw.value || 0),
    minOrderAmount: Number(raw.minOrder || 0),
    maxDiscount: Number(raw.maxDiscount || 0),
    validFrom: raw.startAt,
    validTo: raw.endAt,
    couponCode: raw.code || '',
    couponEnabled: Boolean(raw.code),
    outletIds,
    appliesToAllOutlets: raw.appliesToAllOutlets === true || outletIds.length === 0,
  };
}
async function offerPayload(req, existing = null) {
  const title = text(req.body.title ?? req.body.name);
  if (!title) throw new AppError('Offer title is required', 400, 'OFFER_TITLE_REQUIRED');
  const rawOutletIds = arrayValue(req.body.outletIds);
  const appliesToAllOutlets = boolean(req.body.appliesToAllOutlets, rawOutletIds.length === 0);
  const outletIds = [];
  if (!appliesToAllOutlets) {
    if (!rawOutletIds.length) throw new AppError('Select at least one outlet or enable all outlets', 400, 'OUTLET_SCOPE_REQUIRED');
    for (const value of rawOutletIds) {
      const id = await resolveObjectId(Outlet, value, { active: true });
      if (!id) throw new AppError('One or more selected outlets are invalid', 400, 'INVALID_OUTLET_SCOPE');
      if (!outletIds.some((entry) => String(entry) === String(id))) outletIds.push(id);
    }
  }
  const type = upper(req.body.discountType ?? req.body.type ?? 'PERCENT').replace('PERCENTAGE', 'PERCENT');
  if (!['PERCENT', 'FLAT', 'FREE_DELIVERY'].includes(type)) throw new AppError('Invalid offer type', 400, 'INVALID_OFFER_TYPE');
  const value = type === 'FREE_DELIVERY' ? 0 : Math.max(0, number(req.body.discountValue ?? req.body.value, 0));
  if (type !== 'FREE_DELIVERY' && value <= 0) throw new AppError('Enter a valid discount value', 400, 'INVALID_DISCOUNT_VALUE');
  if (type === 'PERCENT' && value > 100) throw new AppError('Percentage discount cannot exceed 100%', 400, 'INVALID_PERCENTAGE');
  const startAt = dateValue(req.body.validFrom ?? req.body.startAt);
  const endAt = dateValue(req.body.validTo ?? req.body.endAt);
  if (startAt && endAt && startAt >= endAt) throw new AppError('Offer end date must be after its start date', 400, 'INVALID_DATE_RANGE');
  const uploaded = req.file ? await media.uploadImage(req.file, 'offers') : null;
  const remote = media.imageFromUrl(req.body.imageUrl ?? req.body.image, title);
  return {
    uploaded,
    payload: {
      title,
      description: text(req.body.description ?? req.body.subtitle).slice(0, 1000),
      image: uploaded || remote || existing?.image || null,
      code: boolean(req.body.couponEnabled, Boolean(req.body.couponCode)) ? upper(req.body.couponCode) : undefined,
      campaignType: boolean(req.body.couponEnabled, Boolean(req.body.couponCode)) ? 'COUPON_OFFER' : 'GENERAL',
      type,
      value,
      minOrder: Math.max(0, number(req.body.minOrderAmount ?? req.body.minOrder, 0)),
      maxDiscount: Math.max(0, number(req.body.maxDiscount, 0)),
      startAt,
      endAt,
      active: boolean(req.body.enabled ?? req.body.active, true),
      appliesToAllOutlets,
      outletIds: appliesToAllOutlets ? [] : outletIds,
    },
  };
}
router.get('/admin/offers', ah(async (req, res) => {
  const { page: currentPage, perPage, skip } = paging(req);
  const [rows, total] = await Promise.all([
    Offer.find().populate('outletIds', 'name code slug legacyId').sort({ createdAt: -1 }).skip(skip).limit(perPage),
    Offer.countDocuments(),
  ]);
  ok(res, page(rows.map(offerOut), total, currentPage, perPage));
}));
router.post('/admin/offers', media.imageUpload.single('image'), ah(async (req, res) => {
  const { payload, uploaded } = await offerPayload(req);
  try {
    const row = await Offer.create(payload);
    await row.populate('outletIds', 'name code slug legacyId');
    ok(res, offerOut(row), 'Offer created', 201);
  } catch (error) {
    if (uploaded?.publicId) await media.deleteImage(uploaded.publicId);
    throw error;
  }
}));
router.put('/admin/offers/:id', media.imageUpload.single('image'), ah(async (req, res) => {
  const offer = await findOneCompat(Offer, req.params.id);
  if (!offer) throw new AppError('Offer not found', 404, 'OFFER_NOT_FOUND');
  const previousPublicId = offer.image?.publicId || '';
  const { payload, uploaded } = await offerPayload(req, offer);
  try {
    Object.assign(offer, payload);
    await offer.save();
    await offer.populate('outletIds', 'name code slug legacyId');
    if (uploaded?.publicId && previousPublicId && previousPublicId !== uploaded.publicId) await media.deleteImage(previousPublicId);
    ok(res, offerOut(offer), 'Offer updated');
  } catch (error) {
    if (uploaded?.publicId) await media.deleteImage(uploaded.publicId);
    throw error;
  }
}));
router.delete('/admin/offers/:id', ah(async (req, res) => {
  const offer = await findOneCompat(Offer, req.params.id);
  if (!offer) throw new AppError('Offer not found', 404, 'OFFER_NOT_FOUND');
  const publicId = offer.image?.publicId;
  await offer.deleteOne();
  if (publicId) await media.deleteImage(publicId);
  ok(res, null, 'Offer deleted');
}));

// Offers status --------------------------------------------------------------
router.patch('/admin/offers/:id/status', ah(async (req, res) => {
  const offer = await findOneCompat(Offer, req.params.id);
  if (!offer) throw new AppError('Offer not found', 404, 'OFFER_NOT_FOUND');
  offer.active = boolean(req.body.enabled ?? req.body.active, !offer.active);
  await offer.save();
  ok(res, { ...offer.toObject(), id: offer.legacyId ?? String(offer._id), enabled: offer.active }, offer.active ? 'Offer enabled' : 'Offer disabled');
}));

// Settings compatibility -----------------------------------------------------
async function getSetting(key, fallback = {}) { return (await Setting.findOne({ key, active: true }).lean())?.value ?? fallback; }
async function saveSetting(key, value, req, isPublic = false) { return settings.set(key, value, req.user.id, isPublic, { requestId: req.id || req.headers['x-request-id'] }); }
router.get('/admin/settings/restaurant', ah(async (_req, res) => ok(res, await getSetting('restaurant_operations', { subscriptionPlanEnabled: false, vendorDocumentVerificationEnabled: true, selfDeliveryEnabled: false, restaurantLocationRadius: 10 }))));
router.put('/admin/settings/restaurant', ah(async (req, res) => {
  const value = { subscriptionPlanEnabled: boolean(req.body.subscriptionPlanEnabled), vendorDocumentVerificationEnabled: boolean(req.body.vendorDocumentVerificationEnabled, true), selfDeliveryEnabled: boolean(req.body.selfDeliveryEnabled), restaurantLocationRadius: Math.max(0, number(req.body.restaurantLocationRadius, 10)) };
  await saveSetting('restaurant_operations', value, req); ok(res, value, 'Restaurant settings updated');
}));
router.get('/admin/settings/driver', ah(async (_req, res) => ok(res, await getSetting('driver_operations', { driverDocumentVerificationEnabled: true, driverLocationUpdateSeconds: 15 }))));
router.put('/admin/settings/driver', ah(async (req, res) => {
  const value = { driverDocumentVerificationEnabled: boolean(req.body.driverDocumentVerificationEnabled, true), driverLocationUpdateSeconds: Math.max(5, Math.min(300, Math.trunc(number(req.body.driverLocationUpdateSeconds, 15)))) };
  await saveSetting('driver_operations', value, req); ok(res, value, 'Rider operation settings updated');
}));
router.get('/admin/settings/commission', ah(async (_req, res) => ok(res, await getSetting('admin_commission', { vendor: { type: 'FIXED', value: 0, active: false }, driver: { type: 'FIXED', value: 0, active: false } }))));
async function updateCommission(kind, req, res) {
  const current = await getSetting('admin_commission', { vendor: {}, driver: {} });
  const type = upper(req.body.type || 'FIXED');
  if (!['FIXED', 'PERCENTAGE'].includes(type)) throw new AppError('Commission type must be FIXED or PERCENTAGE', 400, 'INVALID_COMMISSION_TYPE');
  const value = Math.max(0, number(req.body.value, 0));
  if (type === 'PERCENTAGE' && value > 100) throw new AppError('Percentage commission cannot exceed 100%', 400, 'INVALID_COMMISSION_VALUE');
  const next = { ...current, [kind]: { type, value, active: boolean(req.body.active, true) } };
  await saveSetting('admin_commission', next, req); ok(res, next, 'Commission settings updated');
}
router.put('/admin/settings/commission/vendor', ah(async (req, res) => updateCommission('vendor', req, res)));
router.put('/admin/settings/commission/driver', ah(async (req, res) => updateCommission('driver', req, res)));
router.get('/admin/settings/platform-fee', ah(async (_req, res) => ok(res, await getSetting('platform_fee', { platformFee: 0, platformFeeActive: false, packagingFeeActive: false }))));
router.put('/admin/settings/platform-fee', ah(async (req, res) => {
  const value = { platformFee: Math.max(0, number(req.body.platformFee, 0)), platformFeeActive: boolean(req.body.platformFeeActive), packagingFeeActive: boolean(req.body.packagingFeeActive) };
  await saveSetting('platform_fee', value, req, true); ok(res, value, 'Platform fee settings updated');
}));
router.get('/admin/settings/map', ah(async (_req, res) => {
  const admin = await settings.adminSettings();
  const maps = (admin.secrets || []).find((row) => row.key === 'google_maps_credentials') || {};
  ok(res, { googleMapKey: maps.apiKey || '', googleMapsApiKey: maps.apiKey || '', configured: Boolean(maps.configured), provider: maps.enabled === false ? 'OSM' : 'GOOGLE' });
}));
router.put('/admin/settings/map', ah(async (req, res) => {
  const apiKey = text(req.body.googleMapKey ?? req.body.googleMapsApiKey ?? req.body.apiKey);
  const provider = upper(req.body.provider || 'GOOGLE');
  if (provider === 'GOOGLE' && apiKey && !apiKey.includes('*')) await settings.setSecret('google_maps_credentials', { apiKey, enabled: true }, req.user.id, { requestId: req.id });
  if (provider !== 'GOOGLE') await settings.setSecret('google_maps_credentials', { enabled: false }, req.user.id, { requestId: req.id });
  ok(res, { googleMapKey: apiKey, provider }, 'Map settings updated');
}));
router.get('/admin/finance/payment-gateways', ah(async (_req, res) => {
  const admin = await settings.adminSettings();
  ok(res, admin.secrets || []);
}));
router.put('/admin/finance/payment-gateways', ah(async (req, res) => {
  const keyId = text(req.body.keyId ?? req.body.razorpayKeyId);
  const keySecret = text(req.body.keySecret ?? req.body.razorpayKeySecret);
  const payload = { ...(keyId && !keyId.includes('*') ? { keyId } : {}), ...(keySecret && !keySecret.includes('*') ? { keySecret } : {}), enabled: boolean(req.body.enabled, true) };
  ok(res, await settings.setSecret('razorpay_credentials', payload, req.user.id, { requestId: req.id }), 'Payment gateway settings updated');
}));

// Operations dashboard -------------------------------------------------------
function paymentOut(doc) {
  const raw = doc?.toObject ? doc.toObject() : doc;
  if (!raw) return null;
  const order = raw.orderId && typeof raw.orderId === 'object' ? raw.orderId : null;
  const customer = raw.customerId && typeof raw.customerId === 'object' ? raw.customerId : null;
  const outlet = raw.outletId && typeof raw.outletId === 'object' ? raw.outletId : null;
  return {
    ...raw,
    id: raw.legacyId ?? String(raw._id),
    mongoId: String(raw._id),
    paymentId: raw.gatewayPaymentId || raw.gatewayOrderId || `PAY-${raw.legacyId ?? String(raw._id).slice(-6)}`,
    razorpayPaymentId: raw.gatewayPaymentId || '',
    orderNumber: order?.slug || '',
    customerName: customer?.name || '',
    outletName: outlet?.name || '',
    paymentType: raw.gateway || order?.paymentMethod || 'ONLINE',
    paymentStatus: raw.status || order?.paymentStatus || 'PENDING',
    grandTotal: Number(raw.amount || order?.total || 0),
    totalAmount: Number(raw.amount || order?.total || 0),
  };
}

router.get('/admin/payments/summary', ah(async (_req, res) => {
  const successful = ['CAPTURED', 'SUCCESS', 'PAID', 'COMPLETED'];
  const pending = ['PENDING', 'CREATED', 'AUTHORIZED'];
  const [paymentTotals, codTotals] = await Promise.all([
    Payment.aggregate([
      { $group: {
        _id: null,
        totalAmount: { $sum: { $cond: [{ $in: ['$status', successful] }, { $ifNull: ['$amount', 0] }, 0] } },
        totalPayments: { $sum: 1 },
        onlineAmount: { $sum: { $cond: [{ $in: ['$status', successful] }, { $ifNull: ['$amount', 0] }, 0] } },
        onlinePayments: { $sum: { $cond: [{ $in: ['$status', successful] }, 1, 0] } },
        pendingAmount: { $sum: { $cond: [{ $in: ['$status', pending] }, { $ifNull: ['$amount', 0] }, 0] } },
        failedAmount: { $sum: { $cond: [{ $in: ['$status', ['FAILED', 'CANCELLED']] }, { $ifNull: ['$amount', 0] }, 0] } },
      } },
    ]),
    Order.aggregate([
      { $match: { paymentMethod: 'COD', status: { $nin: ['CANCELLED', 'REJECTED'] } } },
      { $group: { _id: null, codAmount: { $sum: { $ifNull: ['$total', 0] } }, codPayments: { $sum: 1 } } },
    ]),
  ]);
  const payment = paymentTotals[0] || {};
  const cod = codTotals[0] || {};
  ok(res, {
    totalAmount: Number(payment.totalAmount || 0) + Number(cod.codAmount || 0),
    totalPayments: Number(payment.totalPayments || 0) + Number(cod.codPayments || 0),
    onlineAmount: Number(payment.onlineAmount || 0),
    onlinePayments: Number(payment.onlinePayments || 0),
    codAmount: Number(cod.codAmount || 0),
    codPayments: Number(cod.codPayments || 0),
    pendingAmount: Number(payment.pendingAmount || 0),
    failedAmount: Number(payment.failedAmount || 0),
  });
}));

router.get('/admin/mr-breado/payments', ah(async (req, res) => {
  const { page: currentPage, perPage, skip } = paging(req, 200);
  const query = {};
  if (req.query.status) query.status = upper(req.query.status);
  const [rows, total] = await Promise.all([
    Payment.find(query)
      .populate('orderId', 'slug paymentMethod paymentStatus total')
      .populate('customerId', 'name email phone')
      .populate('outletId', 'name slug')
      .sort({ createdAt: -1 }).skip(skip).limit(perPage),
    Payment.countDocuments(query),
  ]);
  ok(res, page(rows.map(paymentOut), total, currentPage, perPage, { transactions: rows.map(paymentOut) }));
}));

function sellerMessageOut(doc) {
  const raw = doc?.toObject ? doc.toObject() : doc;
  if (!raw) return null;
  const seller = raw.userId && typeof raw.userId === 'object' ? raw.userId : null;
  const outlet = raw.outletId && typeof raw.outletId === 'object' ? raw.outletId : null;
  return {
    ...raw,
    id: raw.legacyId ?? String(raw._id),
    mongoId: String(raw._id),
    sellerId: seller?.legacyId ?? seller?._id ?? raw.userId,
    sellerName: seller?.name || outlet?.managerName || 'Outlet manager',
    outletName: outlet?.name || '',
    subject: raw.title || '',
    status: raw.read ? 'READ' : 'SENT',
  };
}

router.get('/admin/seller-messages', ah(async (req, res) => {
  const { page: currentPage, perPage, skip } = paging(req);
  const query = { role: 'SELLER', type: 'ADMIN_MESSAGE' };
  if (req.query.search) {
    const regex = new RegExp(escapeRegex(req.query.search), 'i');
    query.$or = [{ title: regex }, { message: regex }];
  }
  const [rows, total] = await Promise.all([
    Notification.find(query).populate('userId', 'name email phone legacyId').populate('outletId', 'name managerName legacyId').sort({ createdAt: -1 }).skip(skip).limit(perPage),
    Notification.countDocuments(query),
  ]);
  ok(res, page(rows.map(sellerMessageOut), total, currentPage, perPage, { messages: rows.map(sellerMessageOut) }));
}));

router.post('/admin/seller-messages', ah(async (req, res) => {
  const seller = await findOneCompat(User, req.body.sellerId ?? req.body.userId, { role: 'SELLER' });
  if (!seller) throw new AppError('Outlet manager not found', 404, 'SELLER_NOT_FOUND');
  const title = text(req.body.title ?? req.body.subject);
  const message = text(req.body.message ?? req.body.body);
  if (!title) throw new AppError('Message title is required', 400, 'MESSAGE_TITLE_REQUIRED');
  if (!message) throw new AppError('Message is required', 400, 'MESSAGE_REQUIRED');
  const outletId = seller.assignedOutletIds?.[0] || null;
  const row = await Notification.create({ userId: seller._id, outletId, role: 'SELLER', title, message, type: 'ADMIN_MESSAGE', data: { sentBy: req.user.id }, read: false });
  await row.populate('userId', 'name email phone legacyId');
  if (outletId) await row.populate('outletId', 'name managerName legacyId');
  ok(res, sellerMessageOut(row), 'Message sent to outlet manager', 201);
}));

router.patch('/admin/seller-messages/:id/read', ah(async (req, res) => {
  const row = await findOneCompat(Notification, req.params.id, { role: 'SELLER', type: 'ADMIN_MESSAGE' });
  if (!row) throw new AppError('Message not found', 404, 'MESSAGE_NOT_FOUND');
  row.read = true; await row.save();
  await row.populate('userId', 'name email phone legacyId');
  if (row.outletId) await row.populate('outletId', 'name managerName legacyId');
  ok(res, sellerMessageOut(row), 'Message marked as read');
}));

function reportOut(doc) {
  const raw = doc?.toObject ? doc.toObject() : doc;
  if (!raw) return null;
  const outlet = raw.outletId && typeof raw.outletId === 'object' ? raw.outletId : null;
  const seller = raw.sellerId && typeof raw.sellerId === 'object' ? raw.sellerId : null;
  return {
    ...raw,
    id: raw.legacyId ?? String(raw._id),
    mongoId: String(raw._id),
    restaurantName: outlet?.name || 'Outlet report',
    outletName: outlet?.name || '',
    sellerName: seller?.name || '',
    title: `Daily closing · ${raw.businessDate || ''}`,
    reason: raw.notes || raw.reviewNote || 'Daily sales and stock closing report',
    message: raw.notes || '',
    description: raw.reviewNote || '',
  };
}

router.get('/admin/restaurant-reports', ah(async (req, res) => {
  const { page: currentPage, perPage, skip } = paging(req);
  const query = {};
  if (req.query.status) {
    const requested = upper(req.query.status);
    query.status = requested === 'RESOLVED' ? 'APPROVED' : requested;
  }
  if (req.query.search) {
    const regex = new RegExp(escapeRegex(req.query.search), 'i');
    query.$or = [{ businessDate: regex }, { notes: regex }, { reviewNote: regex }];
  }
  const [rows, total] = await Promise.all([
    DailyClosing.find(query).populate('outletId', 'name slug legacyId').populate('sellerId', 'name email phone legacyId').sort({ submittedAt: -1, createdAt: -1 }).skip(skip).limit(perPage),
    DailyClosing.countDocuments(query),
  ]);
  ok(res, page(rows.map(reportOut), total, currentPage, perPage, { reports: rows.map(reportOut) }));
}));

router.get('/admin/restaurant-reports/:id', ah(async (req, res) => {
  const row = await findOneCompat(DailyClosing, req.params.id);
  if (!row) throw new AppError('Outlet report not found', 404, 'REPORT_NOT_FOUND');
  await row.populate('outletId', 'name slug legacyId'); await row.populate('sellerId', 'name email phone legacyId');
  ok(res, reportOut(row));
}));

router.patch('/admin/restaurant-reports/:id/status', ah(async (req, res) => {
  const row = await findOneCompat(DailyClosing, req.params.id);
  if (!row) throw new AppError('Outlet report not found', 404, 'REPORT_NOT_FOUND');
  const requested = upper(req.body.status);
  const mapped = requested === 'RESOLVED' ? 'APPROVED' : requested === 'PENDING' ? 'SUBMITTED' : requested;
  if (!['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CORRECTION_REQUIRED'].includes(mapped)) throw new AppError('Invalid report status', 400, 'INVALID_REPORT_STATUS');
  row.status = mapped; row.reviewNote = text(req.body.reason ?? req.body.note ?? req.body.reviewNote); row.reviewedAt = new Date(); row.reviewedBy = req.user.id; await row.save();
  await row.populate('outletId', 'name slug legacyId'); await row.populate('sellerId', 'name email phone legacyId');
  ok(res, reportOut(row), 'Outlet report status updated');
}));

function sellerPayoutOut(user) {
  const raw = user?.toObject ? user.toObject() : user;
  if (!raw) return null;
  const account = raw.sellerProfile?.payoutAccount || {};
  return {
    id: raw.legacyId ?? String(raw._id), mongoId: String(raw._id), sellerId: raw.legacyId ?? String(raw._id),
    sellerName: raw.name || 'Outlet manager', email: raw.email || '', phone: raw.phone || '',
    accountHolderName: account.accountHolderName || raw.name || '', bankName: account.bankName || '',
    accountNumber: account.accountNumber || '', ifscCode: account.ifscCode || '', upiId: account.upiId || '',
    verified: account.verified === true, status: account.status || (account.verified ? 'VERIFIED' : 'PENDING'),
    reviewedAt: account.reviewedAt || null, adminNote: account.adminNote || '',
  };
}

router.get('/admin/seller-payout-accounts', ah(async (req, res) => {
  const { page: currentPage, perPage, skip } = paging(req);
  const query = { role: 'SELLER' };
  if (req.query.search) { const regex = new RegExp(escapeRegex(req.query.search), 'i'); query.$or = [{ name: regex }, { email: regex }, { phone: regex }, { 'sellerProfile.payoutAccount.upiId': regex }]; }
  const [rows, total] = await Promise.all([User.find(query).sort({ createdAt: -1 }).skip(skip).limit(perPage), User.countDocuments(query)]);
  ok(res, page(rows.map(sellerPayoutOut), total, currentPage, perPage, { accounts: rows.map(sellerPayoutOut) }));
}));

router.patch('/admin/seller-payout-accounts/:id/verify', ah(async (req, res) => {
  const seller = await findOneCompat(User, req.params.id, { role: 'SELLER' });
  if (!seller) throw new AppError('Outlet manager not found', 404, 'SELLER_NOT_FOUND');
  const approved = boolean(req.body.approved ?? req.body.verified, upper(req.body.status) === 'VERIFIED');
  const status = approved ? 'VERIFIED' : 'REJECTED';
  seller.set('sellerProfile.payoutAccount.verified', approved);
  seller.set('sellerProfile.payoutAccount.status', status);
  seller.set('sellerProfile.payoutAccount.reviewedAt', new Date());
  seller.set('sellerProfile.payoutAccount.reviewedBy', req.user.id);
  seller.set('sellerProfile.payoutAccount.adminNote', text(req.body.note ?? req.body.adminNote));
  await seller.save();
  ok(res, sellerPayoutOut(seller), approved ? 'Payout account verified' : 'Payout account rejected');
}));

// Outlet / product / order aliases ------------------------------------------
router.get('/admin/outlets/:id/inventory', ah(async (req, res) => {
  const outletId = await resolveObjectId(Outlet, req.params.id);
  if (!outletId) throw new AppError('Outlet not found', 404, 'OUTLET_NOT_FOUND');
  const rows = await OutletProduct.find({ outletId }).populate('productId', 'name slug images basePrice offerPrice foodType active').sort({ updatedAt: -1 }).lean();
  ok(res, rows.map((row) => ({
    ...row,
    id: row.legacyId ?? String(row._id),
    productId: row.productId?.legacyId ?? String(row.productId?._id || row.productId || ''),
    title: row.productId?.name || 'Food item',
    name: row.productId?.name || 'Food item',
    image: row.productId?.images?.[0]?.url || '',
    imageUrl: row.productId?.images?.[0]?.url || '',
    price: Number(row.priceOverride ?? row.productId?.offerPrice ?? row.productId?.basePrice ?? 0),
    stockQuantity: Number(row.stockQuantity || 0),
    availableStock: Math.max(0, Number(row.stockQuantity || 0) - Number(row.reservedQuantity || 0)),
    available: row.available !== false && row.enabled !== false && row.productId?.active !== false,
  })));
}));

router.get(['/admin/restaurants/:id/details', '/admin/outlets/:id/dashboard'], ah(async (req, res) => {
  const outlet = await findOneCompat(Outlet, req.params.id);
  if (!outlet) throw new AppError('Outlet not found', 404, 'OUTLET_NOT_FOUND');
  const [products, orders, delivered] = await Promise.all([
    OutletProduct.countDocuments({ outletId: outlet._id, enabled: true }),
    Order.countDocuments({ outletId: outlet._id }),
    Order.aggregate([{ $match: { outletId: outlet._id, status: 'DELIVERED' } }, { $group: { _id: null, sales: { $sum: '$total' } } }]),
  ]);
  ok(res, { ...outletOut(outlet), totalProducts: products, totalOrders: orders, totalSales: Number(delivered[0]?.sales || 0) });
}));
router.patch('/admin/restaurants/:id/online-status', ah(async (req, res) => {
  const outlet = await findOneCompat(Outlet, req.params.id);
  if (!outlet) throw new AppError('Outlet not found', 404, 'OUTLET_NOT_FOUND');
  outlet.open = boolean(req.body.online ?? req.body.open ?? req.body.isOpen, false); await outlet.save();
  ok(res, outletOut(outlet), outlet.open ? 'Outlet opened' : 'Outlet closed');
}));
router.get('/admin/products/:id/details', ah(async (req, res) => {
  const product = await findOneCompat(Product, req.params.id);
  if (!product) throw new AppError('Product not found', 404, 'PRODUCT_NOT_FOUND');
  await product.populate('categoryId brandId cuisineId');
  ok(res, productOut(product));
}));
router.patch('/admin/mr-breado/products/:id/stock', ah(async (req, res) => {
  const productId = await resolveObjectId(Product, req.params.id);
  if (!productId) throw new AppError('Product not found', 404, 'PRODUCT_NOT_FOUND');
  const primary = await Outlet.findOne({ primary: true }) || await Outlet.findOne().sort({ createdAt: 1 });
  if (!primary) throw new AppError('Primary outlet not found', 404, 'OUTLET_NOT_FOUND');
  const quantity = Math.max(0, Math.trunc(number(req.body.stockQuantity ?? req.body.stock ?? req.body.quantity, 0)));
  const row = await OutletProduct.findOneAndUpdate({ outletId: primary._id, productId }, { $set: { stockQuantity: quantity, available: quantity > 0, enabled: true, stockInitialized: true, lastStockUpdatedAt: new Date(), lastStockUpdatedBy: req.user.id }, $inc: { version: 1 } }, { upsert: true, new: true, setDefaultsOnInsert: true });
  ok(res, row, 'Product stock updated');
}));
router.get('/admin/mr-breado/products/template', (_req, res) => {
  const csv = 'title,subtitle,category,cuisine,brand,foodType,basePrice,offerPrice,variantType,smallPrice,mediumPrice,largePrice,description,active,featured\n';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="mr-breado-products-template.csv"');
  res.send(csv);
});
router.get('/admin/mr-breado/products/export', ah(async (_req, res) => {
  const rows = await Product.find().populate('categoryId brandId cuisineId').sort({ createdAt: -1 }).lean();
  const quote = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const lines = [['title','slug','category','cuisine','brand','foodType','basePrice','offerPrice','variantType','active'].join(',')];
  for (const row of rows) lines.push([row.name,row.slug,row.categoryId?.name,row.cuisineId?.name,row.brandId?.name,row.foodType,row.basePrice,row.offerPrice,row.variantType,row.active].map(quote).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="mr-breado-products.csv"');
  res.send(lines.join('\n'));
}));
router.get('/admin/mr-breado/orders/:id', ah(async (req, res) => {
  const order = await findOneCompat(Order, req.params.id);
  if (!order) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');
  await order.populate('customerId outletId riderId');
  ok(res, orderOut(order));
}));
router.patch('/admin/mr-breado/restaurant/status', ah(async (req, res) => {
  const outlet = await Outlet.findOne({ primary: true }) || await Outlet.findOne().sort({ createdAt: 1 });
  if (!outlet) throw new AppError('Primary outlet not found', 404, 'OUTLET_NOT_FOUND');
  outlet.open = boolean(req.body.open ?? req.body.isOpen ?? req.body.online, false); await outlet.save();
  ok(res, outletOut(outlet), outlet.open ? 'Primary outlet opened' : 'Primary outlet closed');
}));

// Optional franchise lead compatibility (persisted, never static) ------------
async function settingRows(key) { const value = await getSetting(key, []); return Array.isArray(value) ? value : []; }
async function updateSettingRow(key, id, updater, req) {
  const rows = await settingRows(key);
  const index = rows.findIndex((row) => String(row.id ?? row._id) === String(id));
  if (index < 0) throw new AppError('Request not found', 404, 'REQUEST_NOT_FOUND');
  rows[index] = { ...rows[index], ...updater(rows[index]), updatedAt: new Date().toISOString() };
  await saveSetting(key, rows, req, false);
  return rows[index];
}
router.get('/admin/franchise-requests', ah(async (_req, res) => ok(res, await settingRows('franchise_requests'))));
router.patch('/admin/franchise-requests/:id/status', ah(async (req, res) => {
  const status = upper(req.body.status || 'PENDING');
  if (!['PENDING', 'CONTACTED', 'APPROVED', 'REJECTED'].includes(status)) throw new AppError('Invalid franchise request status', 400, 'INVALID_REQUEST_STATUS');
  ok(res, await updateSettingRow('franchise_requests', req.params.id, () => ({ status, reviewedBy: req.user.id }), req), 'Franchise request updated');
}));
router.post('/admin/franchise-requests/:id/contact', ah(async (req, res) => ok(res, await updateSettingRow('franchise_requests', req.params.id, (row) => ({ status: row.status === 'PENDING' ? 'CONTACTED' : row.status, contactNote: text(req.body.note), contactedAt: new Date().toISOString(), contactedBy: req.user.id }), req), 'Franchise request marked contacted')));
router.get('/admin/franchise-refill-requests', ah(async (_req, res) => ok(res, await settingRows('franchise_refill_requests'))));
router.patch('/admin/franchise-refill-requests/:id/status', ah(async (req, res) => {
  const status = upper(req.body.status || 'PENDING');
  if (!['PENDING', 'APPROVED', 'DISPATCHED', 'COMPLETED', 'REJECTED'].includes(status)) throw new AppError('Invalid refill request status', 400, 'INVALID_REFILL_STATUS');
  ok(res, await updateSettingRow('franchise_refill_requests', req.params.id, () => ({ status, reviewedBy: req.user.id }), req), 'Refill request updated');
}));

// Outlet onboarding / verification aliases -----------------------------------
function joinRequestOut(doc) {
  const raw = doc?.toObject ? doc.toObject() : doc;
  if (!raw) return null;
  const outlet = raw.outletId && typeof raw.outletId === 'object' ? raw.outletId : null;
  const user = raw.userId && typeof raw.userId === 'object' ? raw.userId : null;
  return {
    ...raw,
    id: raw.legacyId ?? String(raw._id), mongoId: String(raw._id),
    restaurantId: outlet?.legacyId ?? outlet?._id ?? raw.outletId,
    restaurantName: outlet?.name || 'Outlet', ownerName: user?.name || outlet?.managerName || '',
    email: user?.email || outlet?.email || '', phone: user?.phone || outlet?.managerPhone || '',
  };
}
router.get('/admin/restaurants/join-requests', ah(async (req, res) => {
  const { page: currentPage, perPage, skip } = paging(req);
  const query = { type: { $in: ['RESTAURANT', 'OUTLET', 'SELLER'] } };
  if (req.query.status) query.status = upper(req.query.status);
  const [rows, total] = await Promise.all([
    VerificationRequest.find(query).populate('outletId', 'name email managerName managerPhone legacyId').populate('userId', 'name email phone legacyId').sort({ createdAt: -1 }).skip(skip).limit(perPage),
    VerificationRequest.countDocuments(query),
  ]);
  ok(res, page(rows.map(joinRequestOut), total, currentPage, perPage));
}));
router.get('/admin/restaurants/join-requests/:id', ah(async (req, res) => {
  const row = await findOneCompat(VerificationRequest, req.params.id);
  if (!row) throw new AppError('Outlet verification request not found', 404, 'VERIFICATION_NOT_FOUND');
  await row.populate('outletId', 'name email managerName managerPhone legacyId'); await row.populate('userId', 'name email phone legacyId');
  ok(res, joinRequestOut(row));
}));
async function decideJoinRequest(req, approved) {
  const row = await findOneCompat(VerificationRequest, req.params.id);
  if (!row) throw new AppError('Outlet verification request not found', 404, 'VERIFICATION_NOT_FOUND');
  row.status = approved ? 'VERIFIED' : 'REJECTED'; row.note = text(req.body.reason ?? req.body.note); row.reviewedBy = req.user.id; row.reviewedAt = new Date(); await row.save();
  if (row.outletId) await Outlet.updateOne({ _id: row.outletId }, { $set: { active: approved } });
  if (row.userId) await User.updateOne({ _id: row.userId, role: 'SELLER' }, { $set: { active: approved } });
  await row.populate('outletId', 'name email managerName managerPhone legacyId'); await row.populate('userId', 'name email phone legacyId');
  return joinRequestOut(row);
}
router.post('/admin/restaurants/join-requests/:id/approve', ah(async (req, res) => ok(res, await decideJoinRequest(req, true), 'Outlet request approved')));
router.post('/admin/restaurants/join-requests/:id/reject', ah(async (req, res) => ok(res, await decideJoinRequest(req, false), 'Outlet request rejected')));
router.post('/admin/restaurants/join-requests/:id/verify', ah(async (req, res) => ok(res, await decideJoinRequest(req, boolean(req.body.verified ?? req.body.approved, true)), 'Outlet verification updated')));

// Verification aliases used by older admin builds ---------------------------
async function verificationByTarget(type, value) {
  const model = type === 'RIDER' ? User : Outlet;
  const id = await resolveObjectId(model, value);
  if (!id) return null;
  return type === 'RIDER'
    ? VerificationRequest.findOne({ userId: id, type: 'RIDER' }).sort({ createdAt: -1 })
    : VerificationRequest.findOne({ outletId: id }).sort({ createdAt: -1 });
}
router.patch(['/admin/verifications/riders/:id/status', '/admin/verifications/restaurants/:id/status'], ah(async (req, res) => {
  const isRider = req.path.includes('/riders/');
  const type = isRider ? 'RIDER' : 'RESTAURANT';
  const request = await verificationByTarget(type, req.params.id);
  if (!request) throw new AppError('Verification request not found', 404, 'VERIFICATION_NOT_FOUND');
  const requested = upper(req.query.status ?? req.body.status ?? (req.body.verified ? 'VERIFIED' : 'REJECTED'));
  const status = requested === 'APPROVED' ? 'VERIFIED' : requested;
  if (!['VERIFIED', 'REJECTED', 'PENDING', 'UNVERIFIED'].includes(status)) throw new AppError('Invalid verification status', 400, 'INVALID_VERIFICATION_STATUS');
  request.status = status; request.reviewedBy = req.user.id; request.reviewedAt = new Date(); await request.save();
  if (isRider) {
    const rider = await User.findById(request.userId);
    if (rider) { rider.role = 'RIDER'; rider.riderProfile.verificationStatus = status; rider.riderProfile.online = false; rider.riderProfile.available = false; await rider.save(); }
  } else if (request.outletId) {
    await Outlet.updateOne({ _id: request.outletId }, { $set: { active: status === 'VERIFIED' } });
  }
  ok(res, request, 'Verification status updated');
}));

// Persisted service zones ----------------------------------------------------
function zoneOut(zone) {
  return { id: zone.id, name: zone.name, deliveryCharge: Number(zone.deliveryCharge || 0), radiusKm: Number(zone.radiusKm || 0), latitude: Number(zone.latitude || 0), longitude: Number(zone.longitude || 0), active: zone.active !== false, status: zone.active === false ? 'Inactive' : 'Active' };
}
async function zones() { const value = await getSetting('delivery_zones', []); return Array.isArray(value) ? value : []; }
router.get('/admin/zones', ah(async (_req, res) => ok(res, (await zones()).map(zoneOut))));
router.post('/admin/zones', ah(async (req, res) => {
  const name = text(req.body.name); if (!name) throw new AppError('Zone name is required', 400, 'ZONE_NAME_REQUIRED');
  const current = await zones();
  const row = zoneOut({ id: `zone_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, name, deliveryCharge: number(req.body.deliveryCharge ?? req.body.charge, 0), radiusKm: number(req.body.radiusKm, 0), latitude: number(req.body.latitude, 0), longitude: number(req.body.longitude, 0), active: boolean(req.body.active, true) });
  current.push(row); await saveSetting('delivery_zones', current, req, true); ok(res, row, 'Zone created', 201);
}));
router.put('/admin/zones/:id', ah(async (req, res) => {
  const current = await zones(); const index = current.findIndex((zone) => String(zone.id) === String(req.params.id));
  if (index < 0) throw new AppError('Zone not found', 404, 'ZONE_NOT_FOUND');
  current[index] = zoneOut({ ...current[index], ...req.body, id: current[index].id }); await saveSetting('delivery_zones', current, req, true); ok(res, current[index], 'Zone updated');
}));
router.delete('/admin/zones/:id', ah(async (req, res) => {
  const current = await zones(); const next = current.filter((zone) => String(zone.id) !== String(req.params.id));
  if (next.length === current.length) throw new AppError('Zone not found', 404, 'ZONE_NOT_FOUND');
  await saveSetting('delivery_zones', next, req, true); ok(res, null, 'Zone deleted');
}));

module.exports = router;
