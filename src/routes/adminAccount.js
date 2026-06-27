const express = require('express');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const axios = require('axios');
const ah = require('../utils/asyncHandler');
const { ok } = require('../utils/respond');
const { requireAuth, allowRoles } = require('../middleware/auth');
const { AppError } = require('../utils/errors');
const { User, Setting } = require('../models');

const router = express.Router();
const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, code: 'RESET_RATE_LIMITED', message: 'Too many reset attempts. Please wait and try again.' },
});

function clean(value) {
  return String(value ?? '').trim();
}

function normalizeEmail(value) {
  return clean(value).toLowerCase();
}

function validateEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validatePassword(value) {
  const password = String(value || '');
  if (password.length < 8) throw new AppError('Password must contain at least 8 characters', 400, 'PASSWORD_TOO_SHORT');
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw new AppError('Password must contain at least one letter and one number', 400, 'PASSWORD_TOO_WEAK');
  }
  return password;
}

function safeAdmin(user, business = {}) {
  return {
    id: user.legacyId ?? String(user._id),
    mongoId: String(user._id),
    name: user.name || '',
    email: user.email || '',
    phone: user.phone || '',
    username: user.username || '',
    role: user.role,
    active: user.active !== false,
    gstin: business.gstin || '',
    gstinNumber: business.gstin || '',
    lastLoginAt: user.lastLoginAt || null,
    passwordChangedAt: user.passwordChangedAt || null,
  };
}

async function businessProfile() {
  return (await Setting.findOne({ key: 'admin_business_profile' }).lean())?.value || {};
}

async function verifyCurrentPassword(userId, currentPassword) {
  const user = await User.findById(userId).select('+passwordHash');
  if (!user) throw new AppError('Admin account not found', 404, 'ADMIN_NOT_FOUND');
  const valid = await bcrypt.compare(String(currentPassword || ''), user.passwordHash);
  if (!valid) throw new AppError('Current password is incorrect', 401, 'CURRENT_PASSWORD_INVALID');
  return user;
}

async function sendResetEmail(to, code) {
  const apiKey = clean(process.env.RESEND_API_KEY);
  const from = clean(process.env.ADMIN_RESET_FROM_EMAIL || process.env.RESEND_FROM_EMAIL);
  if (!apiKey || !from) return false;
  await axios.post('https://api.resend.com/emails', {
    from,
    to: [to],
    subject: 'Mr. Breado Admin password reset code',
    html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px"><h2>Admin password reset</h2><p>Use this verification code to reset your Mr. Breado admin password:</p><div style="font-size:32px;font-weight:800;letter-spacing:8px;padding:18px;background:#fff5e8;border-radius:12px;text-align:center">${code}</div><p>This code expires in 10 minutes. If you did not request it, ignore this email.</p></div>`,
  }, { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 15000 });
  return true;
}

function recoveryKeyMatches(value) {
  const configured = clean(process.env.ADMIN_PASSWORD_RECOVERY_KEY);
  const supplied = clean(value);
  if (!configured || !supplied) return false;
  const a = Buffer.from(configured);
  const b = Buffer.from(supplied);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.post(['/admin/auth/forgot-password', '/admin/forgot-password'], resetLimiter, ah(async (req, res) => {
  const email = normalizeEmail(req.body.email);
  if (!validateEmail(email)) throw new AppError('Enter a valid admin email address', 400, 'INVALID_EMAIL');

  const admin = await User.findOne({ email, role: 'ADMIN', active: true }).select('+passwordResetCodeHash');
  const recoveryAvailable = Boolean(clean(process.env.ADMIN_PASSWORD_RECOVERY_KEY));
  let emailSent = false;

  if (admin) {
    const code = String(crypto.randomInt(100000, 1000000));
    admin.passwordResetCodeHash = await bcrypt.hash(code, 10);
    admin.passwordResetExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await admin.save();
    try { emailSent = await sendResetEmail(email, code); } catch (_) { emailSent = false; }
  }

  ok(res, {
    emailDeliveryConfigured: Boolean(clean(process.env.RESEND_API_KEY) && clean(process.env.ADMIN_RESET_FROM_EMAIL || process.env.RESEND_FROM_EMAIL)),
    recoveryKeyAvailable: recoveryAvailable,
    emailSent: admin ? emailSent : false,
  }, 'If the admin account exists, password recovery instructions are available.');
}));

router.post(['/admin/auth/reset-password', '/admin/reset-password'], resetLimiter, ah(async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = validatePassword(req.body.newPassword ?? req.body.password);
  const confirmation = String(req.body.confirmPassword ?? req.body.confirm_password ?? password);
  if (password !== confirmation) throw new AppError('Password confirmation does not match', 400, 'PASSWORD_MISMATCH');

  const admin = await User.findOne({ email, role: 'ADMIN', active: true }).select('+passwordHash +passwordResetCodeHash');
  if (!admin) throw new AppError('The reset request is invalid or expired', 400, 'PASSWORD_RESET_INVALID');

  const byRecoveryKey = recoveryKeyMatches(req.body.recoveryKey ?? req.body.recovery_key);
  const code = clean(req.body.code ?? req.body.otp);
  const byCode = Boolean(
    code &&
    admin.passwordResetCodeHash &&
    admin.passwordResetExpiresAt &&
    new Date(admin.passwordResetExpiresAt).getTime() > Date.now() &&
    await bcrypt.compare(code, admin.passwordResetCodeHash)
  );
  if (!byRecoveryKey && !byCode) throw new AppError('The reset code or recovery key is invalid or expired', 400, 'PASSWORD_RESET_INVALID');

  admin.passwordHash = await bcrypt.hash(password, 12);
  admin.passwordResetCodeHash = undefined;
  admin.passwordResetExpiresAt = undefined;
  admin.passwordChangedAt = new Date();
  await admin.save();
  ok(res, null, 'Password reset successfully. Sign in with the new password.');
}));

router.use('/admin', requireAuth, allowRoles('ADMIN'));

router.get(['/admin/account/profile', '/admin/profile', '/admin/me'], ah(async (req, res) => {
  const admin = await User.findById(req.user.id);
  if (!admin) throw new AppError('Admin account not found', 404, 'ADMIN_NOT_FOUND');
  ok(res, safeAdmin(admin, await businessProfile()));
}));

router.put(['/admin/account/profile', '/admin/profile'], ah(async (req, res) => {
  const name = clean(req.body.name ?? req.body.fullName);
  const phone = clean(req.body.phone ?? req.body.mobile);
  if (!name) throw new AppError('Admin name is required', 400, 'ADMIN_NAME_REQUIRED');
  if (phone && !/^[+0-9][0-9\s-]{6,18}$/.test(phone)) throw new AppError('Enter a valid phone number', 400, 'INVALID_PHONE');
  if (phone && await User.exists({ phone, _id: { $ne: req.user.id } })) throw new AppError('This phone number is already in use', 409, 'PHONE_ALREADY_USED');
  const admin = await User.findByIdAndUpdate(req.user.id, { $set: { name, phone: phone || undefined } }, { new: true, runValidators: true });
  ok(res, safeAdmin(admin, await businessProfile()), 'Profile updated');
}));

router.put(['/admin/account/phone', '/admin/profile/phone'], ah(async (req, res) => {
  req.body.name = req.user.name;
  const phone = clean(req.body.phone ?? req.body.mobile);
  if (!/^[+0-9][0-9\s-]{6,18}$/.test(phone)) throw new AppError('Enter a valid phone number', 400, 'INVALID_PHONE');
  if (await User.exists({ phone, _id: { $ne: req.user.id } })) throw new AppError('This phone number is already in use', 409, 'PHONE_ALREADY_USED');
  const admin = await User.findByIdAndUpdate(req.user.id, { $set: { phone } }, { new: true, runValidators: true });
  ok(res, safeAdmin(admin, await businessProfile()), 'Phone updated');
}));

router.patch(['/admin/account/profile/gstin', '/admin/profile/gstin'], ah(async (req, res) => {
  const gstin = clean(req.body.gstin ?? req.body.gstinNumber).toUpperCase();
  if (gstin && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) {
    throw new AppError('Enter a valid 15-character GSTIN', 400, 'INVALID_GSTIN');
  }
  const setting = await Setting.findOneAndUpdate(
    { key: 'admin_business_profile' },
    { $set: { value: { ...(await businessProfile()), gstin }, public: false, active: true, updatedBy: req.user.id }, $inc: { version: 1 } },
    { upsert: true, new: true },
  );
  const admin = await User.findById(req.user.id);
  ok(res, safeAdmin(admin, setting.value || {}), 'GSTIN updated');
}));

router.put(['/admin/account/email', '/admin/profile/email', '/admin/change-email'], ah(async (req, res) => {
  const newEmail = normalizeEmail(req.body.newEmail ?? req.body.new_email ?? req.body.email);
  if (!validateEmail(newEmail)) throw new AppError('Enter a valid email address', 400, 'INVALID_EMAIL');
  const admin = await verifyCurrentPassword(req.user.id, req.body.currentPassword ?? req.body.current_password ?? req.body.password);
  if (await User.exists({ email: newEmail, _id: { $ne: admin._id } })) throw new AppError('This email address is already in use', 409, 'EMAIL_ALREADY_USED');
  admin.email = newEmail;
  admin.passwordChangedAt = new Date();
  await admin.save();
  ok(res, safeAdmin(admin, await businessProfile()), 'Admin email updated');
}));

router.put(['/admin/account/password', '/admin/profile/password', '/admin/change-password'], ah(async (req, res) => {
  const admin = await verifyCurrentPassword(req.user.id, req.body.currentPassword ?? req.body.current_password ?? req.body.oldPassword);
  const password = validatePassword(req.body.newPassword ?? req.body.new_password ?? req.body.password);
  const confirmation = String(req.body.confirmPassword ?? req.body.confirm_password ?? password);
  if (password !== confirmation) throw new AppError('Password confirmation does not match', 400, 'PASSWORD_MISMATCH');
  if (await bcrypt.compare(password, admin.passwordHash)) throw new AppError('New password must be different from the current password', 400, 'PASSWORD_UNCHANGED');
  admin.passwordHash = await bcrypt.hash(password, 12);
  admin.passwordChangedAt = new Date();
  admin.passwordResetCodeHash = undefined;
  admin.passwordResetExpiresAt = undefined;
  await admin.save();
  ok(res, null, 'Password updated');
}));

router.post(['/admin/account/password/otp', '/admin/profile/password/otp'], ah(async (req, res) => {
  req.body.email = req.user.email;
  const email = normalizeEmail(req.user.email);
  const admin = await User.findById(req.user.id).select('+passwordResetCodeHash');
  const code = String(crypto.randomInt(100000, 1000000));
  admin.passwordResetCodeHash = await bcrypt.hash(code, 10);
  admin.passwordResetExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await admin.save();
  const sent = await sendResetEmail(email, code).catch(() => false);
  if (!sent) throw new AppError('Password email delivery is not configured. Use the current password or configured recovery key.', 503, 'PASSWORD_EMAIL_NOT_CONFIGURED');
  ok(res, null, 'Password verification code sent');
}));

router.post(['/admin/account/email/otp', '/admin/profile/email/otp'], ah(async (_req, res) => {
  ok(res, null, 'Current password verification is required to change the admin email.');
}));

module.exports = router;
