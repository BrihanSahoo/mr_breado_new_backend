const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { User, Outlet } = require('../models');
const { AppError } = require('../utils/errors');
const { normalizeRole } = require('../utils/roles');

function token(user) {
  return jwt.sign(
    {
      sub: String(user._id),
      role: normalizeRole(user.role),
      assignedOutletIds: (user.assignedOutletIds || []).map(String),
      primaryOutletId: user.assignedOutletIds?.[0]
        ? String(user.assignedOutletIds[0])
        : null,
    },
    env.jwtSecret,
    { expiresIn: env.jwtExpiresIn },
  );
}

async function repairSellerOutletAssignment(user) {
  if (normalizeRole(user.role) !== 'SELLER') return null;

  const existingIds = (user.assignedOutletIds || []).map(String);
  if (existingIds.length) {
    const existingOutlet = await Outlet.findById(existingIds[0]);
    if (existingOutlet) return existingOutlet;
  }

  const or = [];
  if (user.email) or.push({ email: String(user.email).trim().toLowerCase() });
  if (user.phone) or.push({ managerPhone: String(user.phone).trim() });
  if (user.name) or.push({ managerName: String(user.name).trim() });

  if (!or.length) return null;

  const outlet = await Outlet.findOne({ $or: or }).sort({ updatedAt: -1 });
  if (!outlet) return null;

  user.assignedOutletIds = [outlet._id];
  await user.save();
  return outlet;
}

function outletDto(outlet) {
  if (!outlet) return null;
  const raw = typeof outlet.toObject === 'function' ? outlet.toObject() : outlet;
  const address = [
    raw.address?.line1,
    raw.address?.line2,
    raw.address?.area,
    raw.address?.city,
    raw.address?.state,
    raw.address?.pincode,
  ].filter(Boolean).join(', ');
  const logo = raw.logo?.url || '';
  const banner = raw.coverImage?.url || '';
  return {
    ...raw,
    _id: String(raw._id),
    mongoId: String(raw._id),
    outletId: String(raw._id),
    id: raw.legacyId ?? String(raw._id),
    address,
    logo,
    logoImage: logo,
    banner,
    bannerImage: banner,
  };
}

async function login(body) {
  const identity = String(
    body.email ||
      body.phone ||
      body.mobile ||
      body.emailOrMobile ||
      body.email_or_mobile ||
      body.identifier ||
      body.username ||
      '',
  ).trim();

  if (!identity) {
    throw new AppError(
      'Email, phone or username is required',
      400,
      'LOGIN_IDENTITY_REQUIRED',
    );
  }

  const normalized = identity.toLowerCase();
  const user = await User.findOne({
    $or: [
      { email: normalized },
      { phone: identity },
      { username: normalized },
    ],
  }).select('+passwordHash');

  if (!user || !(await bcrypt.compare(String(body.password || ''), user.passwordHash))) {
    throw new AppError('Invalid credentials', 401, 'INVALID_CREDENTIALS');
  }
  if (user.active === false) {
    throw new AppError(
      'This account is inactive. Contact the administrator.',
      403,
      'ACCOUNT_INACTIVE',
    );
  }

  let outlet = null;
  if (normalizeRole(user.role) === 'SELLER') {
    outlet = await repairSellerOutletAssignment(user);
    if (!outlet) {
      throw new AppError(
        'No outlet is assigned to this seller account. Ask the administrator to save outlet login credentials again.',
        403,
        'NO_OUTLET_ASSIGNED',
      );
    }
  }

  user.lastLoginAt = new Date();
  await user.save();

  const assignedOutletIds = (user.assignedOutletIds || []).map(String);
  const primaryOutletId = assignedOutletIds[0] || null;

  return {
    token: token(user),
    user: {
      id: user.legacyId,
      mongoId: String(user._id),
      _id: String(user._id),
      name: user.name,
      username: user.username,
      email: user.email,
      phone: user.phone,
      role: normalizeRole(user.role),
      assignedOutletIds,
      primaryOutletId,
      outletId: primaryOutletId,
    },
    assignedOutletIds,
    primaryOutletId,
    outletId: primaryOutletId,
    outlet: outletDto(outlet),
  };
}

async function register(body) {
  const role = normalizeRole(body.role || 'CUSTOMER');
  if (!['CUSTOMER', 'RIDER'].includes(role)) {
    throw new AppError(
      'Public registration supports customer or rider accounts only',
      403,
    );
  }
  const password = String(body.password || '');
  if (password.length < 6) {
    throw new AppError('Password must contain at least 6 characters');
  }
  const user = await User.create({
    name: body.name || 'Customer',
    email: body.email?.toLowerCase(),
    phone: body.phone || body.mobile,
    passwordHash: await bcrypt.hash(password, 12),
    role,
    ...(role === 'RIDER'
      ? {
          riderProfile: {
            online: false,
            available: false,
            verificationStatus: 'UNVERIFIED',
          },
        }
      : {}),
  });

  return {
    token: token(user),
    user: {
      id: user.legacyId,
      mongoId: String(user._id),
      _id: String(user._id),
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: normalizeRole(user.role),
      verificationStatus: user.riderProfile?.verificationStatus || null,
      verificationRequired: normalizeRole(user.role) === 'RIDER',
    },
  };
}

module.exports = { login, register, token, repairSellerOutletAssignment };
