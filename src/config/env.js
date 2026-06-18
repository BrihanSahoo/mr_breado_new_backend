require('dotenv').config();
const required = (name, fallback) => {
  const value = process.env[name] || fallback;
  if (!value && process.env.NODE_ENV === 'production') throw new Error(`Missing required environment variable: ${name}`);
  return value;
};
module.exports = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 8080),
  apiPrefix: process.env.API_PREFIX || '/api',
  mongoUri: required('MONGODB_URI', 'mongodb://127.0.0.1:27017/mr_breado'),
  jwtSecret: required('JWT_SECRET', 'development-only-secret-change-me'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '30d',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  corsOrigins: (process.env.CORS_ORIGIN || '*').split(',').map(value => value.trim()).filter(Boolean),
  timezone: process.env.BUSINESS_TIMEZONE || 'Asia/Kolkata',
  razorpay: { keyId: process.env.RAZORPAY_KEY_ID || '', keySecret: process.env.RAZORPAY_KEY_SECRET || '', webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '' },
  googleMapsKey: process.env.GOOGLE_MAPS_API_KEY || '',
  settingsEncryptionKey: required('SETTINGS_ENCRYPTION_KEY', process.env.NODE_ENV === 'production' ? undefined : 'development-settings-encryption-key-change-me'),
  autoCancel: { sellerMinutes: Number(process.env.AUTO_CANCEL_SELLER_MINUTES || 30), riderMinutes: Number(process.env.AUTO_CANCEL_RIDER_MINUTES || 45), inProcess: process.env.ENABLE_IN_PROCESS_AUTOCANCEL === 'true' },
  cloudinary: { cloudName: process.env.CLOUDINARY_CLOUD_NAME || '', apiKey: process.env.CLOUDINARY_API_KEY || '', apiSecret: process.env.CLOUDINARY_API_SECRET || '' },
};
