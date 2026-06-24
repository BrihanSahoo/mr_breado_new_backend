const express = require('express');
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
const ah = require('../utils/asyncHandler');
const { ok } = require('../utils/respond');
const { requireAuth } = require('../middleware/auth');
const { AppError } = require('../utils/errors');
const { User, VerificationRequest, Notification, RiderLocation } = require('../models');
const { normalizeRole } = require('../utils/roles');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 5 },
  fileFilter: (_req, file, cb) => {
    if (!/^image\//i.test(file.mimetype) && file.mimetype !== 'application/pdf') {
      return cb(new AppError('Only image or PDF verification documents are allowed', 400, 'INVALID_FILE_TYPE'));
    }
    cb(null, true);
  },
});

async function uploadDocument(file) {
  if (!file) return null;
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    throw new AppError('Cloudinary configuration is required for rider verification documents', 503, 'CLOUDINARY_NOT_CONFIGURED');
  }
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
  const data = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
  const result = await cloudinary.uploader.upload(data, {
    folder: 'mr-breado/rider-verification',
    resource_type: 'auto',
  });
  return { url: result.secure_url, publicId: result.public_id, alt: file.originalname };
}

function assertApplicant(user) {
  const role = normalizeRole(user?.role);
  if (role === 'SELLER') {
    throw new AppError('Seller accounts cannot submit rider verification', 403, 'RIDER_APPLICATION_NOT_ALLOWED');
  }
  // Any authenticated non-seller account may apply. Verification approval still
  // controls online/offers access, so this does not grant delivery privileges.
  return role;
}



async function synchronizeApprovedRider(user) {
  const latest = await VerificationRequest.findOne({ userId: user._id, type: 'RIDER' }).sort({ createdAt: -1 });
  const requestStatus = String(latest?.status || '').trim().toUpperCase();
  const profileStatus = String(user.riderProfile?.verificationStatus || '').trim().toUpperCase();
  const approved = ['VERIFIED', 'APPROVED', 'ACTIVE'].includes(requestStatus) || ['VERIFIED', 'APPROVED', 'ACTIVE'].includes(profileStatus);

  if (approved) {
    let changed = false;
    if (String(user.role || '').toUpperCase() !== 'RIDER') {
      user.role = 'RIDER';
      changed = true;
    }
    if (!user.riderProfile) {
      user.riderProfile = {};
      changed = true;
    }
    if (String(user.riderProfile.verificationStatus || '').toUpperCase() !== 'VERIFIED') {
      user.riderProfile.verificationStatus = 'VERIFIED';
      changed = true;
    }
    if (changed) await user.save();
  }

  return { latest, approved };
}

router.use('/rider-verification', requireAuth);

router.get('/rider-verification/status', ah(async (req, res) => {
  const rider = await User.findById(req.user.id);
  if (!rider) throw new AppError('Account not found', 404, 'ACCOUNT_NOT_FOUND');
  assertApplicant(rider);
  const request = await VerificationRequest.findOne({ userId: rider._id, type: 'RIDER' }).sort({ createdAt: -1 });
  const status = String(request?.status || rider.riderProfile?.verificationStatus || 'UNVERIFIED').toUpperCase();
  ok(res, request || {
    status,
    requestStatus: status,
    verified: ['VERIFIED', 'APPROVED', 'ACTIVE'].includes(status),
    pending: status === 'PENDING',
    rejected: status === 'REJECTED',
    documents: [],
  });
}));

router.post('/rider-verification/submit', upload.fields([
  { name: 'profilePhoto', maxCount: 1 },
  { name: 'aadhaarFront', maxCount: 1 },
  { name: 'aadhaarBack', maxCount: 1 },
  { name: 'drivingLicense', maxCount: 1 },
  { name: 'vehicleRc', maxCount: 1 },
]), ah(async (req, res) => {
  const rider = await User.findById(req.user.id);
  if (!rider) throw new AppError('Account not found', 404, 'ACCOUNT_NOT_FOUND');
  const currentRole = assertApplicant(rider);

  const required = ['profilePhoto', 'aadhaarFront', 'aadhaarBack', 'drivingLicense', 'vehicleRc'];
  const missing = required.filter((field) => !(req.files?.[field]?.length));
  if (missing.length) {
    throw new AppError(`Missing required verification documents: ${missing.join(', ')}`, 400, 'VERIFICATION_DOCUMENTS_REQUIRED');
  }

  const pending = await VerificationRequest.findOne({ userId: rider._id, type: 'RIDER', status: 'PENDING' }).sort({ createdAt: -1 });
  if (pending) {
    throw new AppError('A rider verification request is already pending admin review', 409, 'VERIFICATION_ALREADY_PENDING');
  }

  const documents = [];
  for (const [field, files] of Object.entries(req.files || {})) {
    for (const file of files) {
      const uploaded = await uploadDocument(file);
      documents.push({ ...uploaded, alt: field });
    }
  }

  if (currentRole !== 'RIDER') rider.role = 'RIDER';
  if (!rider.riderProfile) rider.riderProfile = {};
  rider.riderProfile.verificationStatus = 'PENDING';
  rider.riderProfile.online = false;
  rider.riderProfile.available = false;
  await rider.save();

  const request = await VerificationRequest.create({
    userId: rider._id,
    type: 'RIDER',
    status: 'PENDING',
    documents,
    note: JSON.stringify({ ...req.body, source: req.body?.source || 'RIDER_APP_UNIQUE_ONBOARDING' }),
  });

  await Notification.create({
    userId: rider._id,
    role: 'RIDER',
    title: 'Verification submitted',
    message: 'Your documents were submitted successfully and are awaiting admin review.',
    type: 'RIDER_VERIFICATION',
    data: { verificationRequestId: request._id, status: 'PENDING' },
  });

  ok(res, {
    ...request.toObject(),
    status: 'PENDING',
    requestStatus: 'PENDING',
    pending: true,
    verified: false,
  }, 'Rider verification submitted', 201);
}));


// Unique runtime availability endpoint. It is mounted before all legacy rider
// routers, so old role/status middleware cannot intercept a verified rider.
router.post('/rider-runtime/availability', requireAuth, ah(async (req, res) => {
  const rider = await User.findById(req.user.id);
  if (!rider) throw new AppError('Rider account not found', 404, 'RIDER_NOT_FOUND');
  if (String(rider.role || '').toUpperCase() === 'SELLER') {
    throw new AppError('Seller accounts cannot use rider availability', 403, 'RIDER_ACTION_NOT_ALLOWED');
  }

  const { approved } = await synchronizeApprovedRider(rider);
  const requestedOnline = Boolean(req.body.online ?? req.body.isOnline ?? req.body.is_online);
  const requestedAvailable = Boolean(req.body.available ?? req.body.isAvailable ?? req.body.is_available ?? requestedOnline);

  if ((requestedOnline || requestedAvailable) && !approved) {
    throw new AppError('Admin verification is required before going online', 409, 'RIDER_NOT_VERIFIED');
  }

  const latitude = Number(req.body.latitude ?? req.body.lat);
  const longitude = Number(req.body.longitude ?? req.body.lng ?? req.body.lon);
  if (requestedOnline && (!Number.isFinite(latitude) || !Number.isFinite(longitude))) {
    throw new AppError('Current location is required before going online', 400, 'RIDER_LOCATION_REQUIRED');
  }

  if (!rider.riderProfile) rider.riderProfile = {};
  rider.riderProfile.online = requestedOnline;
  rider.riderProfile.available = requestedOnline && requestedAvailable;
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    rider.riderProfile.currentLatitude = latitude;
    rider.riderProfile.currentLongitude = longitude;
    rider.riderProfile.lastLocationAt = new Date();
  }
  await rider.save();

  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    await RiderLocation.create({
      riderId: rider._id,
      location: { type: 'Point', coordinates: [longitude, latitude] },
      heading: Number(req.body.heading ?? req.body.headingDegrees ?? 0),
      speed: Number(req.body.speed ?? req.body.speedMetersPerSecond ?? 0),
      accuracy: Number(req.body.accuracy ?? req.body.accuracyMeters ?? 0),
      recordedAt: new Date(),
    });
  }

  ok(res, {
    id: rider.legacyId || String(rider._id),
    mongoId: String(rider._id),
    online: Boolean(rider.riderProfile.online),
    available: Boolean(rider.riderProfile.available),
    verificationStatus: rider.riderProfile.verificationStatus || 'VERIFIED',
    verification_status: rider.riderProfile.verificationStatus || 'VERIFIED',
    currentLatitude: rider.riderProfile.currentLatitude,
    currentLongitude: rider.riderProfile.currentLongitude,
    lastLocationAt: rider.riderProfile.lastLocationAt,
  }, requestedOnline ? 'Rider is online' : 'Rider is offline');
}));


module.exports = router;
