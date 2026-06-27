const express = require('express');
const multer = require('multer');
const ah = require('../utils/asyncHandler');
const { ok } = require('../utils/respond');
const { requireAuth, allowRoles } = require('../middleware/auth');
const { AppError } = require('../utils/errors');
const {
  User, Order, Product, Outlet, Notification, AdminEmailLog, ClientErrorReport, Setting,
} = require('../models');
const { findOneCompat } = require('../utils/compatId');
const emailService = require('../services/emailService');
const settings = require('../services/settingsService');

const router = express.Router();
const clean = (value) => String(value ?? '').trim();
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const customerRoles = ['CUSTOMER', 'USER', 'CLIENT'];
const customerRoleQuery = { $in: customerRoles.map((role) => new RegExp(`^${role}$`, 'i')) };
const activeOrderStatuses = { $nin: ['CANCELLED', 'REJECTED', 'FAILED'] };

function paging(req, max = 100) {
  const page = Math.max(1, Math.trunc(number(req.query.page, 1)));
  const perPage = Math.min(max, Math.max(1, Math.trunc(number(req.query.perPage ?? req.query.per_page, 20))));
  return { page, perPage, skip: (page - 1) * perPage };
}

function page(items, total, currentPage, perPage, extra = {}) {
  const totalPages = Math.max(1, Math.ceil(total / Math.max(1, perPage)));
  return { items, total, page: currentPage, perPage, per_page: perPage, totalPages, total_pages: totalPages, last: currentPage >= totalPages, ...extra };
}

function userDto(user, stats = {}) {
  const raw = user?.toObject ? user.toObject() : user;
  return {
    ...raw,
    id: raw.legacyId ?? String(raw._id),
    mongoId: String(raw._id),
    mobile: raw.phone || '',
    phoneNumber: raw.phone || '',
    profileImage: raw.avatar?.url || '',
    enabled: raw.active !== false && raw.deleted !== true,
    blocked: raw.active === false,
    deleted: raw.deleted === true,
    totalOrders: Number(stats.totalOrders || 0),
    deliveredOrders: Number(stats.deliveredOrders || 0),
    totalSpending: Number(stats.totalSpending || 0),
    averageOrderValue: Number(stats.averageOrderValue || 0),
    lastOrderAt: stats.lastOrderAt || null,
  };
}

async function customerStats(userIds) {
  if (!userIds.length) return new Map();
  const rows = await Order.aggregate([
    { $match: { customerId: { $in: userIds } } },
    { $group: {
      _id: '$customerId',
      totalOrders: { $sum: 1 },
      deliveredOrders: { $sum: { $cond: [{ $eq: ['$status', 'DELIVERED'] }, 1, 0] } },
      totalSpending: { $sum: { $cond: [{ $not: [{ $in: ['$status', ['CANCELLED', 'REJECTED', 'FAILED']] }] }, { $ifNull: ['$total', 0] }, 0] } },
      lastOrderAt: { $max: '$createdAt' },
    } },
  ]);
  return new Map(rows.map((row) => [String(row._id), {
    ...row,
    averageOrderValue: Number(row.totalOrders || 0) > 0 ? Number(row.totalSpending || 0) / Number(row.totalOrders) : 0,
  }]));
}

async function findCustomer(id) {
  const user = await findOneCompat(User, id);
  if (!user || !customerRoles.includes(String(user.role || '').toUpperCase())) {
    throw new AppError('Customer not found', 404, 'CUSTOMER_NOT_FOUND');
  }
  return user;
}

async function orderDtos(customerId) {
  const orders = await Order.find({ customerId })
    .populate('outletId', 'name slug code address logo coverImage legacyId')
    .sort({ createdAt: -1 })
    .lean();
  const productIds = [...new Set(orders.flatMap((order) => order.items || []).map((item) => item.productId).filter(Boolean).map(String))];
  const products = productIds.length
    ? await Product.find({ _id: { $in: productIds } }).populate('categoryId', 'name slug').lean()
    : [];
  const productMap = new Map(products.map((product) => [String(product._id), product]));
  return orders.map((order) => ({
    ...order,
    id: order.legacyId ?? String(order._id),
    mongoId: String(order._id),
    orderNumber: order.slug || `ORDER-${order.legacyId ?? String(order._id).slice(-6).toUpperCase()}`,
    outlet: order.outletId ? {
      id: order.outletId.legacyId ?? String(order.outletId._id),
      mongoId: String(order.outletId._id),
      name: order.outletId.name,
      slug: order.outletId.slug,
      code: order.outletId.code,
      address: order.outletId.address,
      logo: order.outletId.logo?.url || '',
      banner: order.outletId.coverImage?.url || '',
    } : null,
    outletName: order.outletId?.name || '',
    items: (order.items || []).map((item) => {
      const product = productMap.get(String(item.productId));
      return {
        ...item,
        id: item._id ? String(item._id) : undefined,
        productId: item.productId ? String(item.productId) : undefined,
        image: item.image || product?.images?.[0]?.url || '',
        categoryId: product?.categoryId?._id ? String(product.categoryId._id) : '',
        categoryName: product?.categoryId?.name || 'Uncategorised',
        categorySlug: product?.categoryId?.slug || '',
      };
    }),
  }));
}

function analyticsFromOrders(orders) {
  const categoryMap = new Map();
  const productMap = new Map();
  for (const order of orders) {
    if (['CANCELLED', 'REJECTED', 'FAILED'].includes(String(order.status).toUpperCase())) continue;
    for (const item of order.items || []) {
      const category = item.categoryName || 'Uncategorised';
      const quantity = Number(item.quantity || 0);
      const spend = Number(item.finalTotal ?? item.offerPrice ?? item.unitPrice ?? 0) * Math.max(1, quantity || 1);
      const categoryRow = categoryMap.get(category) || { category, quantity: 0, spend: 0, orders: new Set() };
      categoryRow.quantity += quantity;
      categoryRow.spend += spend;
      categoryRow.orders.add(String(order._id || order.id));
      categoryMap.set(category, categoryRow);
      const productName = item.name || 'Food item';
      const productRow = productMap.get(productName) || { productName, quantity: 0, spend: 0 };
      productRow.quantity += quantity;
      productRow.spend += spend;
      productMap.set(productName, productRow);
    }
  }
  const categories = [...categoryMap.values()].map((row) => ({ ...row, orders: row.orders.size })).sort((a, b) => b.quantity - a.quantity || b.spend - a.spend);
  const products = [...productMap.values()].sort((a, b) => b.quantity - a.quantity || b.spend - a.spend).slice(0, 20);
  return {
    categories,
    products,
    favouriteCategory: categories[0] || null,
    favouriteProduct: products[0] || null,
  };
}

router.post('/client-error-reports', requireAuth, ah(async (req, res) => {
  const report = await ClientErrorReport.create({
    userId: req.user.id,
    app: clean(req.body.app || req.user.role || 'CUSTOMER').toUpperCase(),
    screen: clean(req.body.screen),
    action: clean(req.body.action || req.body.operation),
    errorCode: clean(req.body.errorCode || req.body.code),
    safeMessage: clean(req.body.safeMessage || req.body.message).slice(0, 500),
    endpoint: clean(req.body.endpoint || req.body.operation).slice(0, 300),
    method: clean(req.body.method || clean(req.body.operation).split(' ')[0]).toUpperCase().slice(0, 12),
    statusCode: number(req.body.statusCode, undefined),
    appVersion: clean(req.body.appVersion),
    platform: clean(req.body.platform),
    device: clean(req.body.device),
    metadata: req.body.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : {},
  });
  const admins = await User.find({ role: 'ADMIN', active: true, deleted: { $ne: true } }).select('_id');
  if (admins.length) {
    await Notification.insertMany(admins.map((admin) => ({
      userId: admin._id,
      role: 'ADMIN',
      title: `Customer app issue: ${report.screen || report.action || 'Unknown screen'}`,
      message: report.safeMessage || 'A customer app operation failed.',
      type: 'CLIENT_ERROR_REPORT',
      data: { reportId: String(report._id), userId: String(req.user.id), errorCode: report.errorCode, endpoint: report.endpoint },
    })));
  }
  ok(res, { id: String(report._id), received: true }, 'Issue report received', 201);
}));

router.use('/admin', requireAuth, allowRoles('ADMIN'));

router.get(['/admin/users', '/admin/customers'], ah(async (req, res) => {
  const { page: currentPage, perPage, skip } = paging(req);
  const requestedRole = clean(req.query.role).toUpperCase();
  const query = { deleted: req.query.includeDeleted === 'true' ? { $in: [true, false] } : { $ne: true } };
  if (requestedRole && requestedRole !== 'ALL') {
    query.role = customerRoles.includes(requestedRole) ? customerRoleQuery : new RegExp(`^${requestedRole}$`, 'i');
  }
  if (!requestedRole && req.path.endsWith('/customers')) query.role = customerRoleQuery;
  if (req.query.search) {
    const regex = new RegExp(clean(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    query.$or = [{ name: regex }, { email: regex }, { phone: regex }, { username: regex }];
  }
  const [users, total] = await Promise.all([
    User.find(query).select('-passwordHash -passwordResetCodeHash').sort({ createdAt: -1 }).skip(skip).limit(perPage),
    User.countDocuments(query),
  ]);
  const stats = await customerStats(users.map((user) => user._id));
  ok(res, page(users.map((user) => userDto(user, stats.get(String(user._id)))), total, currentPage, perPage));
}));

router.get('/admin/customers/:id/details', ah(async (req, res) => {
  const user = await findCustomer(req.params.id);
  const orders = await orderDtos(user._id);
  const analytics = analyticsFromOrders(orders);
  const stats = {
    totalOrders: orders.length,
    deliveredOrders: orders.filter((order) => order.status === 'DELIVERED').length,
    totalSpending: orders.filter((order) => !['CANCELLED', 'REJECTED', 'FAILED'].includes(String(order.status).toUpperCase())).reduce((sum, order) => sum + Number(order.total || 0), 0),
    lastOrderAt: orders[0]?.createdAt || null,
  };
  stats.averageOrderValue = stats.totalOrders ? stats.totalSpending / stats.totalOrders : 0;
  ok(res, { customer: userDto(user, stats), orders, analytics });
}));

router.get('/admin/customers/:id/orders', ah(async (req, res) => {
  const user = await findCustomer(req.params.id);
  const orders = await orderDtos(user._id);
  ok(res, { items: orders, total: orders.length, analytics: analyticsFromOrders(orders) });
}));

router.delete('/admin/customers/:id', ah(async (req, res) => {
  const user = await findCustomer(req.params.id);
  const activeOrders = await Order.countDocuments({ customerId: user._id, status: { $in: ['RECEIVED', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'RIDER_ASSIGNMENT_PENDING', 'RIDER_ASSIGNED', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'REACHED_DROP'] } });
  if (activeOrders > 0) throw new AppError('This customer has an active order and cannot be deleted yet.', 409, 'CUSTOMER_HAS_ACTIVE_ORDER');
  user.active = false;
  user.deleted = true;
  user.deletedAt = new Date();
  user.deletedBy = req.user.id;
  user.deleteReason = clean(req.body.reason || 'Deleted by administrator');
  user.fcmTokens = [];
  await user.save();
  ok(res, userDto(user), 'Customer deleted');
}));

router.post('/admin/customers/:id/notifications', ah(async (req, res) => {
  const user = await findCustomer(req.params.id);
  const type = clean(req.body.type || req.body.category || 'ADMIN_MESSAGE').toUpperCase();
  const allowed = new Set(['OFFER', 'ADMIN_MESSAGE', 'UPDATE', 'PAYMENT_REQUEST', 'ALERT']);
  const normalized = allowed.has(type) ? type : 'ADMIN_MESSAGE';
  const title = clean(req.body.title);
  const message = clean(req.body.message || req.body.description);
  if (!title || !message) throw new AppError('Notification title and message are required.', 400, 'NOTIFICATION_FIELDS_REQUIRED');
  const notification = await Notification.create({
    userId: user._id,
    role: 'CUSTOMER',
    title,
    message,
    type: normalized,
    data: { ...(req.body.data || {}), sentByAdmin: true, sentBy: String(req.user.id), category: normalized },
  });
  ok(res, { id: String(notification._id), sent: true }, 'Notification sent', 201);
}));

const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 5, fileSize: 12 * 1024 * 1024, fields: 30 },
  fileFilter: (_req, file, callback) => {
    const mime = clean(file.mimetype).toLowerCase();
    const supported = mime.startsWith('image/') || mime === 'application/pdf' || mime === 'text/plain' || mime.includes('spreadsheet') || mime.includes('wordprocessingml');
    callback(supported ? null : new AppError('Only images, PDF, text, Word, and spreadsheet attachments are supported.', 415, 'UNSUPPORTED_EMAIL_ATTACHMENT'), supported);
  },
});

async function sendAdminEmail(req, res, role) {
  const user = await findOneCompat(User, req.params.id);
  const actualRole = String(user?.role || '').toUpperCase();
  const roleMatches = role === 'CUSTOMER' ? customerRoles.includes(actualRole) : actualRole === role;
  if (!user || !roleMatches) throw new AppError(`${role === 'RIDER' ? 'Rider' : 'Customer'} not found`, 404, 'RECIPIENT_NOT_FOUND');
  if (!user.email) throw new AppError('This account does not have an email address.', 409, 'RECIPIENT_EMAIL_MISSING');
  const category = emailService.normalizeCategory(req.body.category);
  const template = emailService.templateFor(category, user.name);
  const subject = clean(req.body.subject || template.subject);
  const bodyText = clean(req.body.bodyText || req.body.body || template.bodyText);
  if (!subject || !bodyText) throw new AppError('Email subject and message are required.', 400, 'EMAIL_FIELDS_REQUIRED');
  const log = await AdminEmailLog.create({
    recipientUserId: user._id,
    recipientRole: role,
    recipientEmail: user.email,
    category,
    subject,
    bodyText,
    bodyHtml: emailService.htmlDocument({ category, recipientName: user.name, subject, bodyText }),
    attachments: (req.files || []).map((file) => ({ filename: file.originalname, contentType: file.mimetype, size: file.size })),
    status: 'PENDING',
    sentBy: req.user.id,
  });
  try {
    const result = await emailService.send({
      to: user.email,
      subject,
      text: bodyText,
      html: log.bodyHtml,
      attachments: req.files || [],
    });
    log.status = 'SENT';
    log.provider = result.provider;
    log.providerMessageId = result.id;
    log.sentAt = new Date();
    await log.save();
    ok(res, { id: String(log._id), status: log.status, providerMessageId: log.providerMessageId }, 'Email sent', 201);
  } catch (error) {
    log.status = 'FAILED';
    log.errorCode = error.code || 'EMAIL_SEND_FAILED';
    await log.save();
    throw error;
  }
}

router.get('/admin/email/templates', ah(async (req, res) => {
  const recipientName = clean(req.query.recipientName);
  ok(res, ['PROMOTIONAL', 'ALERT', 'PAYMENT_REQUEST', 'DOCUMENT', 'GENERAL'].map((category) => emailService.templateFor(category, recipientName)));
}));
router.get('/admin/email/config-status', ah(async (_req, res) => {
  const cfg = await emailService.config();
  ok(res, { configured: cfg.configured, senderConfigured: Boolean(cfg.fromEmail), provider: 'SMTP', host: cfg.host || '', port: cfg.port || 587, fromEmail: cfg.fromEmail || '', missing: [!cfg.host ? 'SMTP_HOST' : null, !cfg.user ? 'SMTP_USER' : null, !cfg.password ? 'SMTP_PASSWORD' : null, !cfg.fromEmail ? 'SMTP_FROM_EMAIL' : null].filter(Boolean) });
}));
router.get('/admin/email/settings', ah(async (_req, res) => {
  const admin = await settings.adminSettings();
  const smtp = admin.secrets.find((row) => row.key === 'smtp_credentials') || {};
  ok(res, { ...smtp, password: '', user: '', provider: 'SMTP' });
}));
router.put('/admin/email/settings', ah(async (req, res) => {
  const current = await settings.getSmtpConfig(false);
  const suppliedUser = clean(req.body.user || req.body.username || req.body.smtpUser);
  const suppliedPassword = String(req.body.password || req.body.smtpPassword || '').trim();
  const user = suppliedUser.includes('*') ? current.user : suppliedUser || current.user;
  const password = suppliedPassword.includes('*') ? current.password : suppliedPassword || current.password;
  await settings.setSecret('smtp_credentials', {
    host: clean(req.body.host || req.body.smtpHost || current.host),
    port: Number(req.body.port || req.body.smtpPort || current.port || 587),
    secure: req.body.secure === true || String(req.body.secure).toLowerCase() === 'true' || Number(req.body.port || current.port) === 465,
    user, password,
    fromName: clean(req.body.fromName || current.fromName || 'Mr. Breado'),
    fromEmail: clean(req.body.fromEmail || current.fromEmail),
    replyTo: clean(req.body.replyTo || current.replyTo || req.body.fromEmail || current.fromEmail),
    enabled: req.body.enabled !== false,
  }, req.user.id, { requestId: req.id });
  const admin = await settings.adminSettings();
  ok(res, admin.secrets.find((row) => row.key === 'smtp_credentials') || {}, 'SMTP settings saved');
}));
router.post('/admin/email/settings/validate', ah(async (_req, res) => ok(res, await emailService.verify(), 'SMTP connection verified')));
router.post('/admin/customers/:id/email', attachmentUpload.array('attachments', 5), ah(async (req, res) => sendAdminEmail(req, res, 'CUSTOMER')));
router.post('/admin/riders/:id/email', attachmentUpload.array('attachments', 5), ah(async (req, res) => sendAdminEmail(req, res, 'RIDER')));
router.get(['/admin/customers/:id/emails', '/admin/riders/:id/emails'], ah(async (req, res) => {
  const user = await findOneCompat(User, req.params.id);
  if (!user) throw new AppError('Account not found', 404, 'RECIPIENT_NOT_FOUND');
  const rows = await AdminEmailLog.find({ recipientUserId: user._id }).sort({ createdAt: -1 }).limit(100).lean();
  ok(res, rows.map((row) => ({ ...row, id: String(row._id) })));
}));

router.get('/admin/integrations/health', ah(async (_req, res) => {
  const [razorpay, maps, business, pricing, outlets] = await Promise.all([
    settings.getRazorpayConfig(false).catch(() => ({})),
    settings.getGoogleMapsConfig(false).catch(() => ({})),
    settings.getBusinessFeatures(),
    settings.getDeliveryPricing(),
    Outlet.find().select('name legacyId active open deliveryRadiusKm featureToggles deliverySettings').lean(),
  ]);
  const cloudinary = Boolean(clean(process.env.CLOUDINARY_URL) || (clean(process.env.CLOUDINARY_CLOUD_NAME) && clean(process.env.CLOUDINARY_API_KEY) && clean(process.env.CLOUDINARY_API_SECRET)));
  const email = await emailService.config();
  const checks = {
    googleMaps: { configured: Boolean(maps.apiKey), enabled: maps.enabled !== false },
    razorpay: { configured: Boolean(razorpay.keyId && razorpay.keySecret), enabled: razorpay.enabled !== false },
    cloudinary: { configured: cloudinary, enabled: true },
    email: { configured: email.configured, enabled: true },
  };
  const missing = Object.entries(checks).filter(([, value]) => value.enabled && !value.configured).map(([key]) => key);
  ok(res, {
    healthy: missing.length === 0,
    missing,
    checks,
    globalFeatures: business.feature_toggles,
    deliveryPricing: pricing,
    outlets: outlets.map((outlet) => ({
      id: outlet.legacyId ?? String(outlet._id), name: outlet.name, active: outlet.active !== false, open: outlet.open === true,
      serviceRadiusKm: Number(outlet.deliveryRadiusKm || 0), featureToggles: outlet.featureToggles || {}, deliverySettings: outlet.deliverySettings || {},
    })),
  });
}));

router.get(['/admin/notifications', '/admin/notifications/list', '/admin/notifications/all'], ah(async (req, res) => {
  const { page: currentPage, perPage, skip } = paging(req);
  const query = { userId: req.user.id };
  if (req.query.type) query.type = clean(req.query.type).toUpperCase();
  const [rows, total] = await Promise.all([
    Notification.find(query).sort({ createdAt: -1 }).skip(skip).limit(perPage).lean(),
    Notification.countDocuments(query),
  ]);
  ok(res, page(rows.map((row) => ({ ...row, id: String(row._id), status: row.read ? 'READ' : 'UNREAD' })), total, currentPage, perPage, { notifications: rows }));
}));

router.patch(['/admin/notifications/:id/read', '/admin/notifications/:id/mark-read'], ah(async (req, res) => {
  const row = await Notification.findOneAndUpdate({ _id: req.params.id, userId: req.user.id }, { $set: { read: true } }, { new: true }).lean();
  if (!row) throw new AppError('Notification not found', 404, 'NOTIFICATION_NOT_FOUND');
  ok(res, { ...row, id: String(row._id), status: 'READ' }, 'Notification marked read');
}));

router.get('/admin/client-error-reports', ah(async (req, res) => {
  const { page: currentPage, perPage, skip } = paging(req);
  const query = {};
  if (req.query.resolved !== undefined) query.resolved = String(req.query.resolved) === 'true';
  if (req.query.app) query.app = clean(req.query.app).toUpperCase();
  const [rows, total] = await Promise.all([
    ClientErrorReport.find(query).populate('userId', 'name email phone role legacyId').sort({ createdAt: -1 }).skip(skip).limit(perPage).lean(),
    ClientErrorReport.countDocuments(query),
  ]);
  ok(res, page(rows.map((row) => ({ ...row, id: String(row._id) })), total, currentPage, perPage));
}));

router.patch('/admin/client-error-reports/:id', ah(async (req, res) => {
  const row = await ClientErrorReport.findByIdAndUpdate(req.params.id, { $set: {
    resolved: req.body.resolved !== false,
    resolvedBy: req.user.id,
    resolvedAt: new Date(),
    adminNote: clean(req.body.adminNote || req.body.note),
  } }, { new: true });
  if (!row) throw new AppError('Issue report not found', 404, 'REPORT_NOT_FOUND');
  ok(res, { ...row.toObject(), id: String(row._id) }, 'Issue report updated');
}));

module.exports = router;
