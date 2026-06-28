const crypto = require('crypto');
const axios = require('axios');
const nodemailer = require('nodemailer');
const env = require('../config/env');
const { Setting, SettingAudit } = require('../models');
const { AppError } = require('../utils/errors');

const defaults = {
  feature_toggles: { onlinePayment:true, cod:true, takeaway:true, delivery:true, riderAssignment:true, offers:true },
  delivery: { baseCharge:20, perKmCharge:8, minimumCharge:20, maximumCharge:150 },
  rider: { basePay:0, perKmRate:7, minimumDeliveryPay:20, assignmentRadiusKm:8, monthlySettlementDay:1 },
  delivery_pricing: {
    customer: { baseCharge:20, perKmCharge:8, minimumCharge:20, maximumCharge:150 },
    rider: { basePay:0, perKmRate:7, minimumDeliveryPay:20, assignmentRadiusKm:8, monthlySettlementDay:1 },
  },
  takeaway: { advanceType:'PERCENT', advanceValue:20 },
  tax: { rate:5 },
};

const finiteMoney = (value, fallback, field) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    if (fallback !== undefined) return Number(fallback);
    throw new AppError(`${field} must be a non-negative number`, 400, 'INVALID_DELIVERY_PRICING');
  }
  return Number(number.toFixed(2));
};

function normalizeDeliveryPricing(value={}) {
  const customerInput = value.customer || value.delivery || value.customerPricing || value;
  const riderInput = value.rider || value.riderPricing || value;
  const customer = {
    baseCharge: finiteMoney(customerInput.baseCharge ?? customerInput.baseDeliveryCharge, defaults.delivery.baseCharge, 'Customer base charge'),
    perKmCharge: finiteMoney(customerInput.perKmCharge ?? customerInput.deliveryChargePerKm ?? customerInput.customerChargePerKm, defaults.delivery.perKmCharge, 'Customer per-km charge'),
    minimumCharge: finiteMoney(customerInput.minimumCharge ?? customerInput.minimumDeliveryCharge, defaults.delivery.minimumCharge, 'Minimum customer delivery charge'),
    maximumCharge: finiteMoney(customerInput.maximumCharge ?? customerInput.maximumDeliveryCharge, defaults.delivery.maximumCharge, 'Maximum customer delivery charge'),
  };
  if (customer.maximumCharge < customer.minimumCharge) {
    throw new AppError('Maximum customer delivery charge cannot be below the minimum charge', 400, 'INVALID_DELIVERY_PRICING');
  }
  const rider = {
    basePay: finiteMoney(riderInput.basePay ?? riderInput.riderBasePay, defaults.rider.basePay, 'Rider base pay'),
    perKmRate: finiteMoney(riderInput.perKmRate ?? riderInput.riderPayPerKm ?? riderInput.riderDeliveryPayPerKm ?? riderInput.earningsPerKm, defaults.rider.perKmRate, 'Rider per-km pay'),
    minimumDeliveryPay: finiteMoney(riderInput.minimumDeliveryPay ?? riderInput.minimumRiderDeliveryPay ?? riderInput.minimumDeliveryEarning ?? riderInput.minimumCharge, defaults.rider.minimumDeliveryPay, 'Minimum rider delivery pay'),
    assignmentRadiusKm: finiteMoney(riderInput.assignmentRadiusKm ?? riderInput.deliveryOfferRadiusKm, defaults.rider.assignmentRadiusKm, 'Rider assignment radius'),
    monthlySettlementDay: Math.min(28, Math.max(1, Math.trunc(Number(riderInput.monthlySettlementDay ?? defaults.rider.monthlySettlementDay) || defaults.rider.monthlySettlementDay))),
  };
  return { customer, rider };
}

async function storedValue(key) {
  const row = await Setting.findOne({ key, active:true, isSecret:{$ne:true} }).lean();
  return row?.value ?? null;
}

async function getDeliveryPricing() {
  const [canonical, delivery, deliveryCompat, rider, riderCompat] = await Promise.all([
    storedValue('delivery_pricing'),
    storedValue('delivery'),
    storedValue('delivery_settings'),
    storedValue('rider'),
    storedValue('rider_settings'),
  ]);
  return normalizeDeliveryPricing({
    customer: { ...defaults.delivery, ...(delivery || {}), ...(deliveryCompat || {}), ...(canonical?.customer || canonical?.delivery || {}) },
    rider: { ...defaults.rider, ...(rider || {}), ...(riderCompat || {}), ...(canonical?.rider || {}) },
  });
}

async function setDeliveryPricing(value, userId, options={}) {
  const pricing = normalizeDeliveryPricing(value);
  await Promise.all([
    set('delivery_pricing', pricing, userId, true, options),
    set('delivery', pricing.customer, userId, true, options),
    set('delivery_settings', pricing.customer, userId, true, options),
    set('rider', pricing.rider, userId, false, options),
    set('rider_settings', pricing.rider, userId, false, options),
  ]);
  return pricing;
}

function normalizeFeatureToggles(value={}) {
  const current = { ...defaults.feature_toggles, ...(value || {}) };
  return {
    onlinePayment: current.onlinePayment !== false,
    cod: current.cod !== false,
    takeaway: current.takeaway !== false,
    delivery: current.delivery !== false,
    riderAssignment: current.riderAssignment !== false,
    offers: current.offers !== false,
  };
}

function normalizeTakeaway(value={}) {
  const advanceType = String(value.advanceType || 'PERCENT').toUpperCase();
  if (advanceType !== 'PERCENT') throw new AppError('Only percentage-based takeaway advance is supported', 400, 'INVALID_TAKEAWAY_ADVANCE_TYPE');
  const advanceValue = Number(value.advanceValue ?? value.advancePercentage ?? value.percentage);
  if (!Number.isFinite(advanceValue) || advanceValue < 0 || advanceValue > 100) {
    throw new AppError('Takeaway advance percentage must be between 0 and 100', 400, 'INVALID_TAKEAWAY_ADVANCE_PERCENTAGE');
  }
  return { advanceType:'PERCENT', advanceValue:Number(advanceValue.toFixed(2)) };
}

async function getBusinessFeatures() {
  return {
    feature_toggles: normalizeFeatureToggles(await get('feature_toggles')),
    takeaway: normalizeTakeaway(await get('takeaway')),
  };
}

async function setBusinessFeatures(payload, userId, options={}) {
  const current = await getBusinessFeatures();
  const feature_toggles = normalizeFeatureToggles({
    ...current.feature_toggles,
    ...(payload.feature_toggles || payload.features || {}),
    ...(payload.onlinePaymentEnabled !== undefined ? {onlinePayment:Boolean(payload.onlinePaymentEnabled)} : {}),
    ...(payload.takeawayEnabled !== undefined ? {takeaway:Boolean(payload.takeawayEnabled)} : {}),
  });
  const takeaway = normalizeTakeaway({
    ...current.takeaway,
    ...(payload.takeaway || {}),
    ...(payload.takeawayAdvancePercentage !== undefined ? {advanceValue:payload.takeawayAdvancePercentage} : {}),
  });
  if (feature_toggles.takeaway && takeaway.advanceValue > 0 && !feature_toggles.onlinePayment) {
    throw new AppError('Online payment must be enabled when takeaway advance is greater than 0%', 409, 'TAKEAWAY_REQUIRES_ONLINE_PAYMENT');
  }
  await set('feature_toggles', feature_toggles, userId, true, options);
  await set('takeaway', takeaway, userId, true, options);
  return {feature_toggles, takeaway};
}

const SECRET_KEYS = new Set(['razorpay_credentials', 'google_maps_credentials', 'smtp_credentials']);
const keyBuffer = () => crypto.createHash('sha256').update(String(env.settingsEncryptionKey)).digest();

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { encryptedValue:encrypted.toString('base64'), encryptionIv:iv.toString('base64'), encryptionTag:cipher.getAuthTag().toString('base64') };
}
function decrypt(row) {
  if (!row?.encryptedValue) return null;
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuffer(), Buffer.from(row.encryptionIv, 'base64'));
  decipher.setAuthTag(Buffer.from(row.encryptionTag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(row.encryptedValue, 'base64')), decipher.final()]).toString('utf8'));
}
const mask = (v) => {
  if (!v) return '';
  const s = String(v);
  return s.length <= 8 ? '********' : `${s.slice(0,4)}${'*'.repeat(Math.min(12,s.length-8))}${s.slice(-4)}`;
};
const maskedIntegration = (key, value, row) => {
  if (key === 'razorpay_credentials') return { keyId:mask(value?.keyId), keySecretConfigured:Boolean(value?.keySecret), webhookSecretConfigured:Boolean(value?.webhookSecret), enabled:value?.enabled !== false, active:row?.active !== false, updatedAt:row?.updatedAt, lastValidatedAt:row?.lastValidatedAt };
  if (key === 'google_maps_credentials') return { apiKey:mask(value?.apiKey), configured:Boolean(value?.apiKey), enabled:value?.enabled !== false, active:row?.active !== false, updatedAt:row?.updatedAt, lastValidatedAt:row?.lastValidatedAt };
  if (key === 'smtp_credentials') return {
    host:value?.host||'', port:Number(value?.port||587), secure:Boolean(value?.secure), user:mask(value?.user),
    userConfigured:Boolean(value?.user), passwordConfigured:Boolean(value?.password), fromName:value?.fromName||'Mr. Breado',
    fromEmail:value?.fromEmail||'', replyTo:value?.replyTo||'', configured:Boolean(value?.host&&value?.user&&value?.password&&value?.fromEmail),
    enabled:value?.enabled !== false, active:row?.active !== false, updatedAt:row?.updatedAt, lastValidatedAt:row?.lastValidatedAt,
  };
  return value;
};

async function get(key) {
  const row = await Setting.findOne({ key, active:true }).lean();
  if (!row) return defaults[key];
  return row.isSecret ? decrypt(row) : row.value;
}
async function publicSettings() {
  const rows = await Setting.find({ public:true, active:true, isSecret:{$ne:true} }).lean();
  const data = { ...defaults };
  for (const row of rows) data[row.key] = row.value;
  const [razorpay, maps, deliveryPricing] = await Promise.all([
    getRazorpayConfig(false),
    getGoogleMapsConfig(false),
    getDeliveryPricing(),
  ]);
  data.feature_toggles = normalizeFeatureToggles(data.feature_toggles);
  data.takeaway = normalizeTakeaway(data.takeaway);
  data.deliveryPricing = deliveryPricing;
  data.delivery_pricing = deliveryPricing;
  data.delivery = deliveryPricing.customer;
  data.rider = deliveryPricing.rider;
  data.baseDeliveryCharge = deliveryPricing.customer.baseCharge;
  data.deliveryChargePerKm = deliveryPricing.customer.perKmCharge;
  data.minimumDeliveryCharge = deliveryPricing.customer.minimumCharge;
  data.maximumDeliveryCharge = deliveryPricing.customer.maximumCharge;
  data.riderBasePay = deliveryPricing.rider.basePay;
  data.riderPayPerKm = deliveryPricing.rider.perKmRate;
  data.minimumRiderDeliveryPay = deliveryPricing.rider.minimumDeliveryPay;
  const onlineEnabled = data.feature_toggles.onlinePayment && razorpay.enabled !== false;
  data.payment = { ...(data.payment||{}), onlinePaymentEnabled:onlineEnabled, onlinePaymentConfigured:Boolean(razorpay.keyId && razorpay.keySecret), razorpayKeyId:onlineEnabled ? razorpay.keyId : '', razorpayMode:razorpay.mode || (String(razorpay.keyId||'').startsWith('rzp_live_') ? 'LIVE' : 'TEST') };
  data.razorpayKeyId = onlineEnabled ? razorpay.keyId : '';
  data.razorpayMode = data.payment.razorpayMode;
  data.takeawayEnabled = data.feature_toggles.takeaway;
  data.takeawayAdvancePercentage = data.takeaway.advanceValue;
  data.googleMapsApiKey = maps.enabled ? maps.apiKey : '';
  return data;
}
async function writeAudit(key, action, userId, previous, next, requestId) {
  await SettingAudit.create({ settingKey:key, action, changedBy:userId, previousMasked:maskedIntegration(key,previous), nextMasked:maskedIntegration(key,next), requestId });
}
async function set(key, value, userId, isPublic=false, options={}) {
  if (SECRET_KEYS.has(key)) return setSecret(key, value, userId, options);
  const previous = await Setting.findOne({key}).lean();
  const row = await Setting.findOneAndUpdate({key},{$set:{key,value,updatedBy:userId,public:Boolean(isPublic),active:options.active!==false,isSecret:false},$inc:{version:1}},{upsert:true,new:true,setDefaultsOnInsert:true});
  await writeAudit(key, previous?'UPDATED':'CREATED', userId, previous?.value, value, options.requestId);
  return row;
}
async function setSecret(key, value, userId, options={}) {
  if (!SECRET_KEYS.has(key)) throw new AppError('Unsupported secret setting',400);
  const previousRow = await Setting.findOne({key}).lean();
  const previous = previousRow ? decrypt(previousRow) : null;
  const merged = {...(previous||{}), ...(value||{})};
  for (const k of Object.keys(merged)) if (merged[k] === '' || merged[k] == null) delete merged[k];
  if (key === 'razorpay_credentials' && merged.enabled !== false && (!merged.keyId || !merged.keySecret)) throw new AppError('Razorpay Key ID and Secret are required when enabled',400,'INVALID_RAZORPAY_SETTINGS');
  if (key === 'google_maps_credentials' && merged.enabled !== false && !merged.apiKey) throw new AppError('Google Maps API key is required when enabled',400,'INVALID_MAPS_SETTINGS');
  if (key === 'smtp_credentials' && merged.enabled !== false) {
    const port=Number(merged.port||587);
    if(!merged.host||!merged.user||!merged.password||!merged.fromEmail) throw new AppError('SMTP host, username, password and sender email are required when email delivery is enabled',400,'INVALID_SMTP_SETTINGS');
    if(!Number.isInteger(port)||port<1||port>65535) throw new AppError('SMTP port must be between 1 and 65535',400,'INVALID_SMTP_PORT');
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(merged.fromEmail))) throw new AppError('Enter a valid SMTP sender email address',400,'INVALID_SMTP_FROM_EMAIL');
    merged.port=port; merged.secure=Boolean(merged.secure||port===465);
  }
  const enc = encrypt(merged);
  const row = await Setting.findOneAndUpdate({key},{$set:{key,...enc,value:undefined,isSecret:true,public:false,active:options.active!==false,updatedBy:userId},$inc:{version:1}},{upsert:true,new:true,setDefaultsOnInsert:true});
  await writeAudit(key, previousRow?'ROTATED':'CREATED', userId, previous, merged, options.requestId);
  return maskedIntegration(key, merged, row.toObject());
}
async function getRazorpayConfig(requireEnabled=true) {
  const row = await Setting.findOne({key:'razorpay_credentials',active:true}).lean();
  const dynamic = row ? decrypt(row) : null;
  const raw = dynamic || {keyId:env.razorpay.keyId,keySecret:env.razorpay.keySecret,webhookSecret:env.razorpay.webhookSecret,enabled:true};
  if (requireEnabled && raw.enabled === false) throw new AppError('Online payment is disabled',503,'PAYMENT_DISABLED');
  const requestedMode = String(raw.mode || raw.activeMode || '').toUpperCase();
  const inferredMode = String(raw.liveKeyId || raw.keyId || '').startsWith('rzp_live_') ? 'LIVE' : 'TEST';
  const mode = requestedMode === 'LIVE' ? 'LIVE' : (requestedMode === 'TEST' ? 'TEST' : inferredMode);
  const selected = mode === 'LIVE'
    ? { keyId: raw.liveKeyId || (String(raw.keyId||'').startsWith('rzp_live_') ? raw.keyId : ''), keySecret: raw.liveKeySecret || (String(raw.keyId||'').startsWith('rzp_live_') ? raw.keySecret : ''), webhookSecret: raw.liveWebhookSecret || raw.webhookSecret }
    : { keyId: raw.testKeyId || (String(raw.keyId||'').startsWith('rzp_test_') ? raw.keyId : ''), keySecret: raw.testKeySecret || (String(raw.keyId||'').startsWith('rzp_test_') ? raw.keySecret : ''), webhookSecret: raw.testWebhookSecret || raw.webhookSecret };
  return { ...raw, ...selected, mode, enabled: raw.enabled !== false };
}
async function getGoogleMapsConfig(requireEnabled=true) {
  const row = await Setting.findOne({key:'google_maps_credentials',active:true}).lean();
  const dynamic = row ? decrypt(row) : null;
  const cfg = dynamic || {apiKey:'',enabled:false,adminConfigured:false};
  cfg.adminConfigured = Boolean(dynamic?.apiKey);
  if (requireEnabled && cfg.enabled === false) throw new AppError('Google Maps is disabled',503,'MAPS_DISABLED');
  return cfg;
}
async function getSmtpConfig(requireEnabled=true) {
  const row = await Setting.findOne({key:'smtp_credentials',active:true}).lean();
  const dynamic = row ? decrypt(row) : null;
  const envConfig = {
    host:String(process.env.SMTP_HOST||'').trim(), port:Number(process.env.SMTP_PORT||587),
    secure:String(process.env.SMTP_SECURE||'').toLowerCase()==='true'||Number(process.env.SMTP_PORT||587)===465,
    user:String(process.env.SMTP_USER||process.env.SMTP_USERNAME||'').trim(),
    password:String(process.env.SMTP_PASSWORD||process.env.SMTP_PASS||'').trim(),
    fromName:String(process.env.SMTP_FROM_NAME||'Mr. Breado').trim(),
    fromEmail:String(process.env.SMTP_FROM_EMAIL||process.env.ADMIN_EMAIL_FROM||'').replace(/^.*<|>$/g,'').trim(),
    replyTo:String(process.env.SMTP_REPLY_TO||process.env.ADMIN_EMAIL_REPLY_TO||'').trim(), enabled:true,
  };
  const cfg = dynamic || envConfig;
  cfg.configured = Boolean(cfg.host&&cfg.user&&cfg.password&&cfg.fromEmail);
  if (requireEnabled && cfg.enabled === false) throw new AppError('Email delivery is disabled',503,'EMAIL_DISABLED');
  return cfg;
}
async function adminSettings() {
  const rows = await Setting.find().sort({key:1}).lean();
  const regular = rows.filter(r=>!r.isSecret).map(r=>({...r}));
  const secrets=[];
  for (const row of rows.filter(r=>r.isSecret)) secrets.push({key:row.key,...maskedIntegration(row.key,decrypt(row),row)});
  const existingKeys=new Set(rows.map(r=>r.key));
  if(!existingKeys.has('razorpay_credentials')) secrets.push({key:'razorpay_credentials',...maskedIntegration('razorpay_credentials',{keyId:env.razorpay.keyId,keySecret:env.razorpay.keySecret,webhookSecret:env.razorpay.webhookSecret,enabled:true},{active:true})});
  if(!existingKeys.has('google_maps_credentials')) secrets.push({key:'google_maps_credentials',...maskedIntegration('google_maps_credentials',{apiKey:env.googleMapsKey,enabled:true},{active:true})});
  if(!existingKeys.has('smtp_credentials')) secrets.push({key:'smtp_credentials',...maskedIntegration('smtp_credentials',await getSmtpConfig(false),{active:true})});
  return {regular,secrets};
}
async function validateIntegration(key) {
  if (key === 'razorpay_credentials') {
    const cfg=await getRazorpayConfig();
    const auth=Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString('base64');
    await axios.get('https://api.razorpay.com/v1/payments?count=1',{headers:{Authorization:`Basic ${auth}`},timeout:10000});
  } else if (key === 'google_maps_credentials') {
    const cfg=await getGoogleMapsConfig();
    const response=await axios.get('https://maps.googleapis.com/maps/api/geocode/json',{params:{address:'Kolkata',key:cfg.apiKey},timeout:10000});
    if (!['OK','ZERO_RESULTS'].includes(response.data?.status)) throw new AppError(`Google Maps validation failed: ${response.data?.status||'UNKNOWN'}`,400,'MAPS_VALIDATION_FAILED');
  } else if (key === 'smtp_credentials') {
    const cfg=await getSmtpConfig();
    const transporter=nodemailer.createTransport({host:cfg.host,port:Number(cfg.port||587),secure:Boolean(cfg.secure),auth:{user:cfg.user,pass:cfg.password},connectionTimeout:12000,greetingTimeout:12000,socketTimeout:15000});
    await transporter.verify();
  } else throw new AppError('Unsupported integration',400);
  await Setting.updateOne({key},{$set:{lastValidatedAt:new Date()}});
  return {key,valid:true,validatedAt:new Date()};
}
module.exports={get,set,setSecret,publicSettings,adminSettings,getRazorpayConfig,getGoogleMapsConfig,getSmtpConfig,validateIntegration,getBusinessFeatures,setBusinessFeatures,getDeliveryPricing,setDeliveryPricing,normalizeDeliveryPricing,normalizeFeatureToggles,normalizeTakeaway,defaults,mask};
