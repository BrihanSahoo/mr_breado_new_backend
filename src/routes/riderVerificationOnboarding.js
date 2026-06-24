const express = require('express');
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
const ah = require('../utils/asyncHandler');
const { ok } = require('../utils/respond');
const { requireAuth } = require('../middleware/auth');
const { AppError } = require('../utils/errors');
const { User, VerificationRequest, Notification } = require('../models');
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

module.exports = router;
