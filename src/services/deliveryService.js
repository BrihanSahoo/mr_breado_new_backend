const axios = require('axios');
const { Outlet } = require('../models');
const settings = require('./settingsService');
const { haversineKm, deliveryCharge } = require('../utils/geo');
const { AppError } = require('../utils/errors');

const finite = (v) => Number.isFinite(Number(v)) ? Number(v) : null;
const cleanPincode = (v) => String(v || '').replace(/\D/g, '').slice(0, 6);
const validPincode = (v) => /^\d{6}$/.test(cleanPincode(v));

async function geocode({ address, pincode, city, state }) {
  const cfg = await settings.getGoogleMapsConfig(false);
  if (!cfg?.apiKey || cfg.enabled === false) return null;
  const query = [address, city, state, cleanPincode(pincode), 'India'].filter(Boolean).join(', ');
  if (!query.trim()) return null;
  const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
    params: { address: query, key: cfg.apiKey, region: 'in' }, timeout: 12000,
  });
  if (response.data?.status === 'ZERO_RESULTS') return null;
  if (response.data?.status !== 'OK' || !response.data?.results?.[0]) {
    throw new AppError(`Address verification failed: ${response.data?.status || 'UNKNOWN'}`, 422, 'ADDRESS_GEOCODING_FAILED');
  }
  const first = response.data.results[0];
  return {
    latitude: Number(first.geometry.location.lat),
    longitude: Number(first.geometry.location.lng),
    formattedAddress: first.formatted_address,
    pincode: first.address_components?.find((c) => c.types?.includes('postal_code'))?.long_name || cleanPincode(pincode),
  };
}

function coordinatePair(latitude, longitude) {
  const lat = finite(latitude); const lng = finite(longitude);
  if (lat == null || lng == null) return null;
  const directValid = Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  const swappedValid = Math.abs(lng) <= 90 && Math.abs(lat) <= 180;
  if (!directValid && !swappedValid) return null;
  const directLooksIndia = lat >= 6 && lat <= 38 && lng >= 68 && lng <= 98;
  const swappedLooksIndia = lng >= 6 && lng <= 38 && lat >= 68 && lat <= 98;
  if (swappedLooksIndia && !directLooksIndia) return { latitude: lng, longitude: lat, swapped: true };
  if (directValid) return { latitude: lat, longitude: lng };
  return { latitude: lng, longitude: lat, swapped: true };
}

function storedOutletCoordinates(outlet) {
  const raw = outlet?.location?.coordinates || [0, 0];
  const first = finite(raw[0]); const second = finite(raw[1]);
  if (first == null || second == null) return { latitude: 0, longitude: 0, corrected: false, valid: false };
  const storedCorrect = second >= 6 && second <= 38 && first >= 68 && first <= 98;
  const storedReversed = first >= 6 && first <= 38 && second >= 68 && second <= 98;
  const value = storedReversed && !storedCorrect
    ? { latitude: first, longitude: second, corrected: true }
    : { latitude: second, longitude: first, corrected: false };
  return { ...value, valid: value.latitude !== 0 && value.longitude !== 0 };
}

async function normalizeCoordinates({ latitude, longitude, address, pincode, city, state }) {
  const supplied = coordinatePair(latitude, longitude);
  let coded = null;
  try { coded = await geocode({ address, pincode, city, state }); } catch (_) { coded = null; }
  if (!supplied && coded) return coded;
  if (!supplied) return { latitude: null, longitude: null, pincode: cleanPincode(pincode), geocodingUnavailable: true };
  if (!coded) return { ...supplied, pincode: cleanPincode(pincode), geocodingUnavailable: true };
  const direct = haversineKm(supplied.latitude, supplied.longitude, coded.latitude, coded.longitude);
  const swappedValid = Math.abs(supplied.longitude) <= 90 && Math.abs(supplied.latitude) <= 180;
  const swapped = swappedValid ? haversineKm(supplied.longitude, supplied.latitude, coded.latitude, coded.longitude) : Infinity;
  if (swapped + 1 < direct) return { ...coded, suppliedCoordinatesSwapped: true };
  return { ...supplied, formattedAddress: coded.formattedAddress, pincode: coded.pincode || cleanPincode(pincode) };
}

async function checkServiceability({ latitude, longitude, pincode, address, city, state, outletId }) {
  const requestedPincode = cleanPincode(pincode);
  const coords = await normalizeCoordinates({ latitude, longitude, pincode, address, city, state });
  const query = { active: true, open: true };
  if (outletId) query._id = outletId;
  const outlets = await Outlet.find(query).lean();
  if (!outlets.length) return { ...coords, pincode: requestedPincode, serviceable: false, deliverable: false, canDeliver: false, message: 'No active outlet is currently available.' };

  const ranked = outlets.map((o) => {
    const stored = storedOutletCoordinates(o);
    const outletPincode = cleanPincode(o.address?.pincode);
    const pincodeMatch = validPincode(requestedPincode) && outletPincode === requestedPincode;
    const hasBothCoordinates = stored.valid && coords.latitude != null && coords.longitude != null;
    const distanceKm = hasBothCoordinates
      ? Number(haversineKm(stored.latitude, stored.longitude, coords.latitude, coords.longitude).toFixed(2))
      : null;
    const radius = Number(o.deliveryRadiusKm || 0);
    const distanceWorks = distanceKm != null && Number.isFinite(distanceKm);
    const distanceServiceable = distanceWorks && radius > 0 && distanceKm <= radius;
    // Safety fallback requested for production: same 6-digit pincode is serviceable when
    // Google/geocoding/coordinates fail or produce an obviously unusable result.
    const fallbackUsed = pincodeMatch && (!distanceWorks || coords.geocodingUnavailable || distanceKm > 500);
    return { outlet: o, distanceKm, radius, pincodeMatch, fallbackUsed, serviceable: distanceServiceable || fallbackUsed };
  }).sort((a,b) => {
    if (a.serviceable !== b.serviceable) return a.serviceable ? -1 : 1;
    if (a.pincodeMatch !== b.pincodeMatch) return a.pincodeMatch ? -1 : 1;
    return (a.distanceKm ?? Number.MAX_SAFE_INTEGER) - (b.distanceKm ?? Number.MAX_SAFE_INTEGER);
  });

  const best = ranked[0];
  const safeDistance = best.distanceKm ?? 0;
  const charge = best.serviceable ? deliveryCharge(safeDistance, best.outlet.deliverySettings || {}) : 0;
  return {
    ...coords,
    pincode: requestedPincode || coords.pincode,
    serviceable: best.serviceable,
    deliverable: best.serviceable,
    canDeliver: best.serviceable,
    nearestOutletId: String(best.outlet._id),
    nearestOutletName: best.outlet.name,
    distanceKm: safeDistance,
    deliveryRadiusKm: best.radius,
    allowedRadiusKm: best.radius,
    pincodeMatched: best.pincodeMatch,
    pincodeFallbackUsed: best.fallbackUsed,
    deliveryCharge: charge,
    message: best.serviceable
      ? (best.fallbackUsed ? `Delivery is available from ${best.outlet.name} for pincode ${requestedPincode}.` : `Delivery is available from ${best.outlet.name}.`)
      : `Delivery is unavailable for pincode ${requestedPincode || 'the selected address'}.`,
  };
}

module.exports = { cleanPincode, validPincode, geocode, normalizeCoordinates, checkServiceability, coordinatePair, storedOutletCoordinates };
