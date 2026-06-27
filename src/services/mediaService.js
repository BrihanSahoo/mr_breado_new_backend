const multer = require('multer');
const path = require('path');
const { v2: cloudinary } = require('cloudinary');
const { AppError } = require('../utils/errors');

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/heic',
  'image/heif',
]);
const EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.heic', '.heif']);

function clean(value) {
  return String(value ?? '').trim().replace(/^['"]|['"]$/g, '');
}

function cloudinaryCredentials() {
  const combined = clean(process.env.CLOUDINARY_URL);
  if (combined) {
    try {
      const parsed = new URL(combined);
      if (parsed.protocol !== 'cloudinary:') throw new Error('Invalid protocol');
      return {
        cloud_name: clean(parsed.hostname),
        api_key: clean(decodeURIComponent(parsed.username)),
        api_secret: clean(decodeURIComponent(parsed.password)),
      };
    } catch (_) {
      throw new AppError(
        'Image storage configuration is invalid. Please check the Cloudinary URL.',
        503,
        'CLOUDINARY_CONFIG_INVALID',
      );
    }
  }

  return {
    cloud_name: clean(process.env.CLOUDINARY_CLOUD_NAME),
    api_key: clean(process.env.CLOUDINARY_API_KEY),
    api_secret: clean(process.env.CLOUDINARY_API_SECRET),
  };
}

function configureCloudinary() {
  const credentials = cloudinaryCredentials();
  if (!credentials.cloud_name || !credentials.api_key || !credentials.api_secret) {
    throw new AppError(
      'Image storage is not configured. Add the Cloudinary credentials and redeploy.',
      503,
      'CLOUDINARY_NOT_CONFIGURED',
    );
  }
  cloudinary.config({ ...credentials, secure: true });
}

function isSupportedImage(file) {
  const mime = clean(file?.mimetype).toLowerCase();
  const extension = path.extname(clean(file?.originalname)).toLowerCase();
  return MIME_TYPES.has(mime) || (mime === 'application/octet-stream' && EXTENSIONS.has(extension));
}

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 60 },
  fileFilter: (_req, file, callback) => {
    if (!isSupportedImage(file)) {
      return callback(new AppError(
        'Please upload a JPG, PNG, WebP, GIF, AVIF, HEIC, or HEIF image.',
        415,
        'UNSUPPORTED_IMAGE_TYPE',
      ));
    }
    callback(null, true);
  },
});

function normalizeUploadedImage(result, originalName = '') {
  return {
    url: result.secure_url || result.url || '',
    publicId: result.public_id || '',
    alt: clean(originalName),
  };
}

async function uploadImage(file, folder) {
  if (!file) return null;
  configureCloudinary();

  try {
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: `mr-breado/${clean(folder) || 'media'}`,
          resource_type: 'image',
          use_filename: true,
          unique_filename: true,
          overwrite: false,
          invalidate: true,
        },
        (error, uploaded) => error ? reject(error) : resolve(uploaded),
      );
      stream.end(file.buffer);
    });
    return normalizeUploadedImage(result, file.originalname);
  } catch (error) {
    const httpCode = Number(error?.http_code || error?.status || 0);
    const invalidCredentials = httpCode === 401 || /api key|signature|cloud name|credentials/i.test(String(error?.message || ''));
    if (invalidCredentials) {
      throw new AppError(
        'Image storage authentication failed. Please verify the Cloudinary credentials.',
        503,
        'CLOUDINARY_AUTH_FAILED',
      );
    }
    throw new AppError(
      'The image could not be uploaded right now. Please try again.',
      502,
      'IMAGE_UPLOAD_FAILED',
    );
  }
}

async function deleteImage(publicId) {
  const id = clean(publicId);
  if (!id) return;
  try {
    configureCloudinary();
    await cloudinary.uploader.destroy(id, { resource_type: 'image', invalidate: true });
  } catch (_) {
    // Media cleanup must not roll back a successful database operation.
  }
}

function imageFromUrl(value, alt = '') {
  const url = clean(value);
  if (!/^https:\/\//i.test(url)) return null;
  return { url, publicId: '', alt: clean(alt) };
}

module.exports = {
  MAX_IMAGE_BYTES,
  imageUpload,
  cloudinaryCredentials,
  configureCloudinary,
  uploadImage,
  deleteImage,
  imageFromUrl,
};
