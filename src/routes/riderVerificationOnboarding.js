const express = require('express');
const multer = require('multer');
const path = require('path');
const { v2: cloudinary } = require('cloudinary');
const ah = require('../utils/asyncHandler');
const { ok } = require('../utils/respond');
const { requireAuth } = require('../middleware/auth');
const { AppError } = require('../utils/errors');
const { User, VerificationRequest, Notification, RiderLocation } = require('../models');
const { normalizeRole } = require('../utils/roles');
const { configureCloudinary } = require('../services/mediaService');

const router = express.Router();
const MAX_VERIFICATION_FILE_BYTES = 8 * 1024 * 1024;
const VERIFICATION_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.heic', '.heif', '.pdf',
]);

function isSupportedVerificationFile(file) {
  const mime = String(file?.mimetype || '').trim().toLowerCase();
  const extension = path.extname(String(file?.originalname || '')).toLowerCase();
  if (mime === 'application/pdf' || mime.startsWith('image/')) return true;
  return mime === 'application/octet-stream' && VERIFICATION_EXTENSIONS.has(extension);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_VERIFICATION_FILE_BYTES,
    files: 6,
    fields: 40,
  },
  fileFilter: (_req, file, cb) => {
    if (!isSupportedVerificationFile(file)) {
      return cb(new AppError(
        'Upload a clear JPG, PNG, WebP, HEIC, or PDF verification document.',
        415,
        'UNSUPPORTED_VERIFICATION_FILE',
      ));
    }
    cb(null, true);
  },
});

async function uploadDocument(file) {
  if (!file) return null;
  configureCloudinary();

  try {
    const uploaded = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: 'mr-breado/rider-verification',
          resource_type: 'auto',
          use_filename: true,
          unique_filename: true,
          overwrite: false,
          invalidate: true,
        },
        (error, result) => error ? reject(error) : resolve(result),
      );
      stream.end(file.buffer);
    });

    return {
      url: uploaded.secure_url || uploaded.url || '',
      publicId: uploaded.public_id || '',
      alt: file.originalname || '',
      resourceType: uploaded.resource_type || 'image',
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    const status = Number(error?.http_code || error?.status || 0);
    const detail = String(error?.message || '');
    if (status === 401 || /api key|signature|cloud name|credentials/i.test(detail)) {
      throw new AppError(
        'Verification document storage is temporarily unavailable.',
        503,
        'VERIFICATION_STORAGE_AUTH_FAILED',
      );
    }
    if (/timeout|timed out|network|socket|connect/i.test(detail)) {
      throw new AppError(
        'Verification upload is taking longer than expected. Please try again.',
        503,
        'VERIFICATION_UPLOAD_UNAVAILABLE',
      );
    }
    throw new AppError(
      'The verification documents could not be uploaded right now. Please try again.',
      502,
      'VERIFICATION_UPLOAD_FAILED',
    );
  }
}

async function cleanupUploadedDocuments(documents) {
  await Promise.allSettled((documents || []).map(async (document) => {
    if (!document?.publicId) return;
    await cloudinary.uploader.destroy(document.publicId, {
      resource_type: document.resourceType || 'image',
      invalidate: true,
    });
  }));
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
    passportPhoto: rider.riderProfile?.passportPhoto || rider.avatar || null,
  });
}));

router.post('/rider-verification/submit', upload.fields([
  { name: 'profilePhoto', maxCount: 1 },
  { name: 'passportPhoto', maxCount: 1 },
  { name: 'aadhaarFront', maxCount: 1 },
  { name: 'aadhaarBack', maxCount: 1 },
  { name: 'drivingLicense', maxCount: 1 },
  { name: 'vehicleRc', maxCount: 1 },
]), ah(async (req, res) => {
  const rider = await User.findById(req.user.id);
  if (!rider) throw new AppError('Account not found', 404, 'ACCOUNT_NOT_FOUND');
  const currentRole = assertApplicant(rider);

  const required = ['aadhaarFront', 'aadhaarBack', 'drivingLicense', 'vehicleRc'];
  const missing = required.filter((field) => !(req.files?.[field]?.length));
  if (!(req.files?.passportPhoto?.length || req.files?.profilePhoto?.length)) missing.unshift('passportPhoto');
  if (missing.length) {
    throw new AppError(`Missing required verification documents: ${missing.join(', ')}`, 400, 'VERIFICATION_DOCUMENTS_REQUIRED');
  }

  const pending = await VerificationRequest.findOne({ userId: rider._id, type: 'RIDER', status: 'PENDING' }).sort({ createdAt: -1 });
  if (pending) {
    throw new AppError('A rider verification request is already pending admin review', 409, 'VERIFICATION_ALREADY_PENDING');
  }

  const uploadedDocuments = [];
  let request = null;

  try {
    for (const [field, files] of Object.entries(req.files || {})) {
      for (const file of files) {
        const uploaded = await uploadDocument(file);
        uploadedDocuments.push({ ...uploaded, alt: field });
      }
    }

    const documents = uploadedDocuments.map(({ url, publicId, alt }) => ({
      url,
      publicId,
      alt,
    }));

    request = await VerificationRequest.create({
      userId: rider._id,
      type: 'RIDER',
      status: 'PENDING',
      documents,
      note: JSON.stringify({
        ...req.body,
        source: req.body?.source || 'RIDER_APP_UNIQUE_ONBOARDING',
      }),
    });

    const passportDocument = documents.find((doc) => doc.alt === 'passportPhoto')
      || documents.find((doc) => doc.alt === 'profilePhoto');
    if (passportDocument) {
      rider.avatar = {
        url: passportDocument.url,
        publicId: passportDocument.publicId,
        alt: 'passportPhoto',
      };
      if (!rider.riderProfile) rider.riderProfile = {};
      rider.riderProfile.passportPhoto = {
        url: passportDocument.url,
        publicId: passportDocument.publicId,
        alt: 'passportPhoto',
      };
    }

    if (currentRole !== 'RIDER') rider.role = 'RIDER';
    if (!rider.riderProfile) rider.riderProfile = {};
    rider.riderProfile.verificationStatus = 'PENDING';
    rider.riderProfile.online = false;
    rider.riderProfile.available = false;
    await rider.save();

    // A notification failure must not roll back a successfully stored request.
    await Notification.create({
      userId: rider._id,
      role: 'RIDER',
      title: 'Verification submitted',
      message: 'Your documents were submitted successfully and are awaiting admin review.',
      type: 'RIDER_VERIFICATION',
      data: { verificationRequestId: request._id, status: 'PENDING' },
    }).catch(() => null);

    ok(res, {
      ...request.toObject(),
      status: 'PENDING',
      requestStatus: 'PENDING',
      pending: true,
      verified: false,
    }, 'Rider verification submitted', 201);
  } catch (error) {
    if (request?._id) {
      await VerificationRequest.deleteOne({ _id: request._id }).catch(() => null);
    }
    await cleanupUploadedDocuments(uploadedDocuments);
    throw error;
  }
}));


// Runtime availability intentionally lives under the same unique
// /rider-verification namespace that already handles successful document
// submission and status checks. This avoids every legacy rider router and role
// gate. Authorization is based on the verified request linked to the token's
// user id, not on a possibly stale role value stored in an older account row.
router.post('/rider-verification/runtime-availability', ah(async (req, res) => {
  const rider = await User.findById(req.user.id);
  if (!rider) throw new AppError('Rider account not found', 404, 'RIDER_NOT_FOUND');

  const { approved, latest } = await synchronizeApprovedRider(rider);
  const requestedOnline = Boolean(req.body.online ?? req.body.isOnline ?? req.body.is_online);
  const requestedAvailable = Boolean(req.body.available ?? req.body.isAvailable ?? req.body.is_available ?? requestedOnline);

  if ((requestedOnline || requestedAvailable) && !approved) {
    throw new AppError(`Admin verification is required before going online. Current status: ${String(latest?.status || rider.riderProfile?.verificationStatus || 'UNVERIFIED').toUpperCase()}`, 409, 'RIDER_NOT_VERIFIED');
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
