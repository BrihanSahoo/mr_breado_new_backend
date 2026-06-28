const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const env = require('./config/env');
const requestContext = require('./middleware/requestContext');
const error = require('./middleware/error');
const payment = require('./services/paymentService');
const ah = require('./utils/asyncHandler');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

function normalizeOrigin(value) {
  return String(value || '').trim().replace(/\/$/, '').toLowerCase();
}

function originMatches(origin, pattern) {
  const candidate = normalizeOrigin(origin);
  const allowed = normalizeOrigin(pattern);
  if (!allowed || allowed === '*') return allowed === '*';
  if (candidate === allowed) return true;
  if (!allowed.includes('*')) return false;
  const escaped = allowed.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(candidate);
}

const corsOrigin = (origin, callback) => {
  // Native apps, server-to-server calls and same-origin requests may omit Origin.
  if (!origin) return callback(null, true);
  const allowed = env.corsOrigins.some((entry) => originMatches(origin, entry));
  return allowed
    ? callback(null, true)
    : callback(new Error('Origin is not allowed by CORS'));
};

app.use(requestContext);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({
  origin: corsOrigin,
  credentials: true,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Accept', 'Authorization', 'Content-Type', 'X-Requested-With', 'X-Request-Id'],
  exposedHeaders: ['X-Request-Id', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset'],
  maxAge: 86400,
}));
app.options('*', cors({ origin: corsOrigin, credentials: true }));
app.use(compression());

app.post(
  `${env.apiPrefix}/payments/webhook`,
  express.raw({ type: 'application/json', limit: '2mb' }),
  ah(async (req, res) => res.json({
    success: true,
    message: 'Webhook processed',
    data: await payment.webhook(
      req.body,
      req.headers['x-razorpay-signature'],
      req.headers['x-razorpay-event-id'],
    ),
  })),
);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(rateLimit({
  windowMs: 60_000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/health' || req.path === '/ready',
}));

app.get('/', (req, res) => res.json({
  success: true,
  message: 'Mr. Breado MongoDB backend running',
  version: 'mongodb-v1',
}));
app.get(`${env.apiPrefix}/health`, (req, res) => res.json({
  success: true,
  message: 'OK',
  database: 'MongoDB',
  time: new Date().toISOString(),
  uptimeSeconds: Math.round(process.uptime()),
}));
app.get(`${env.apiPrefix}/ready`, async (req, res) => {
  const mongoose = require('mongoose');
  const ready = mongoose.connection.readyState === 1;
  res.status(ready ? 200 : 503).json({
    success: ready,
    message: ready ? 'READY' : 'NOT_READY',
    databaseState: mongoose.connection.readyState,
    time: new Date().toISOString(),
  });
});
app.get(`${env.apiPrefix}/version`, (req, res) => res.json({
  success: true,
  version: 'mongodb-v1',
  apiCompatibility: 'v89-product-checkout-banner-pricing-consistency',
  previousCompatibility: 'v87-strict-brand-product-assignment',
  compatibilityHistory: [
    'v79-outlet-stock-smtp-map-user-premium',
    'v78-customer-engagement-user-app-consistency',
  ],
}));

const mountedRoutes=['./routes/auth','./routes/adminAccount','./routes/riderVerificationOnboarding','./routes/misc','./routes/customerCompatibility','./routes/public','./routes/payments','./routes/cartOrders','./routes/admin','./routes/sellerAppCompatibility','./routes/seller','./routes/riderFinance','./routes/riderManagement','./routes/riderAppCompatibility','./routes/rider','./routes/promotionAdmin','./routes/adminCustomerEngagement','./routes/adminUiCompatibility','./routes/adminWebCompatibility','./routes/compatibility','./routes/production'];
for (const route of mountedRoutes) app.use(env.apiPrefix, require(route));

app.use((req, res) => res.status(404).json({
  success: false,
  message: 'Endpoint not found',
  path: req.originalUrl,
  code: 'NOT_FOUND',
}));
app.use(error);

module.exports = app;
