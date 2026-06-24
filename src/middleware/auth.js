const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { User, VerificationRequest } = require('../models');
const { normalizeRole } = require('../utils/roles');
const { AppError } = require('../utils/errors');

const APPROVED_RIDER_STATUSES = new Set(['VERIFIED', 'APPROVED', 'ACTIVE']);

async function resolveEffectiveRole(user) {
  let role = normalizeRole(user.role);
  if (role === 'ADMIN' || role === 'SELLER') return role;

  const profileStatus = String(user.riderProfile?.verificationStatus || '')
    .trim()
    .toUpperCase();

  let approved = APPROVED_RIDER_STATUSES.has(profileStatus);

  // The verification request is the authoritative approval record. Older admin
  // flows may update it successfully while leaving User.role/riderProfile stale.
  if (!approved) {
    const latest = await VerificationRequest.findOne({
      userId: user._id,
      type: 'RIDER',
    })
      .sort({ createdAt: -1 })
      .select('status')
      .lean();
    approved = APPROVED_RIDER_STATUSES.has(
      String(latest?.status || '').trim().toUpperCase(),
    );
  }

  if (!approved) return role;

  // Repair the account once so every existing rider endpoint, background job,
  // and subsequent login sees a canonical RIDER + VERIFIED user record.
  const needsRoleRepair = role !== 'RIDER';
  const needsStatusRepair = profileStatus !== 'VERIFIED';
  if (needsRoleRepair || needsStatusRepair) {
    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          role: 'RIDER',
          'riderProfile.verificationStatus': 'VERIFIED',
        },
      },
    );
    user.role = 'RIDER';
    if (!user.riderProfile) user.riderProfile = {};
    user.riderProfile.verificationStatus = 'VERIFIED';
  }

  return 'RIDER';
}

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (!token) throw new AppError('Authentication required', 401, 'UNAUTHENTICATED');

    const payload = jwt.verify(token, env.jwtSecret);
    const userId = payload.sub || payload.userId || payload.id;
    if (!userId) throw new AppError('Invalid token payload', 401, 'UNAUTHENTICATED');

    const user = await User.findById(userId).lean();
    if (!user || !user.active) throw new AppError('Invalid account', 401, 'UNAUTHENTICATED');

    const role = await resolveEffectiveRole(user);
    req.user = { ...user, id: String(user._id), role };
    next();
  } catch (error) {
    next(error.status ? error : new AppError('Invalid or expired token', 401, 'UNAUTHENTICATED'));
  }
}

const allowRoles = (...roles) => (req, res, next) => (
  roles.map(normalizeRole).includes(normalizeRole(req.user?.role))
    ? next()
    : next(new AppError('Forbidden', 403, 'FORBIDDEN'))
);

const optionalAuth = async (req, res, next) => {
  if (!(req.headers.authorization || '').startsWith('Bearer ')) return next();
  return requireAuth(req, res, next);
};

module.exports = { requireAuth, allowRoles, optionalAuth, resolveEffectiveRole };
