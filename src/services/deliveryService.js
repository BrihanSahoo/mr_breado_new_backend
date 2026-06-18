const axios = require('axios');
const { Outlet } = require('../models');
const settings = require('./settingsService');
const { haversineKm, deliveryCharge } = require('../utils/geo');
const { AppError } = require('../utils/errors');

const finite = (v) => Number.isFinite(Number(v)) ? Number(v) : null;
const cleanPincode = (v) => String(v || '').replace(/\D/g, '').slice(0, 6);

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
  if (!directValid && !swappedValid) throw new AppError('Invalid latitude or longitude', 400, 'INVALID_COORDINATES');

  // India-specific protection: valid numeric coordinates can still be reversed
  // (for example latitude=86.56, longitude=20.57).
  const directLooksIndia = lat >= 6 && lat <= 38 && lng >= 68 && lng <= 98;
  const swappedLooksIndia = lng >= 6 && lng <= 38 && lat >= 68 && lat <= 98;
  if (swappedLooksIndia && !directLooksIndia) return { latitude: lng, longitude: lat, swapped: true };
  if (directValid) return { latitude: lat, longitude: lng };
  return { latitude: lng, longitude: lat, swapped: true };
}

function storedOutletCoordinates(outlet) {
  const raw = outlet?.location?.coordinates || [0, 0];
  const first = finite(raw[0]);
  const second = finite(raw[1]);
  if (first == null || second == null) return { latitude: 0, longitude: 0, corrected: false };
  // Correct records accidentally stored as [latitude, longitude].
  const storedCorrect = second >= 6 && second <= 38 && first >= 68 && first <= 98;
  const storedReversed = first >= 6 && first <= 38 && second >= 68 && second <= 98;
  if (storedReversed && !storedCorrect) return { latitude: first, longitude: second, corrected: true };
  return { latitude: second, longitude: first, corrected: false };
}

async function normalizeCoordinates({ latitude, longitude, address, pincode, city, state }) {
  const supplied = coordinatePair(latitude, longitude);
  const coded = await geocode({ address, pincode, city, state }).catch(() => null);
  if (!supplied && coded) return coded;
  if (!supplied) throw new AppError('A valid address, pincode, latitude and longitude are required', 400, 'LOCATION_REQUIRED');
  if (!coded) return supplied;
  const direct = haversineKm(supplied.latitude, supplied.longitude, coded.latitude, coded.longitude);
  const swappedValid = Math.abs(supplied.longitude) <= 90 && Math.abs(supplied.latitude) <= 180;
  const swapped = swappedValid ? haversineKm(supplied.longitude, supplied.latitude, coded.latitude, coded.longitude) : Infinity;
  if (swapped + 1 < direct) return { ...coded, suppliedCoordinatesSwapped: true };
  return { ...supplied, formattedAddress: coded.formattedAddress, pincode: coded.pincode };
}

async function checkServiceability({ latitude, longitude, pincode, address, city, state, outletId }) {
  const coords = await normalizeCoordinates({ latitude, longitude, pincode, address, city, state });
  let outlets;
  if (outletId) outlets = await Outlet.find({ _id: outletId, active: true, open: true }).lean();
  else outlets = await Outlet.find({ active: true, open: true }).lean();
  if (!outlets.length) return { ...coords, serviceable: false, message: 'No active outlet is currently available.' };
  const ranked = outlets.map((o) => {
    const stored = storedOutletCoordinates(o);
    const distanceKm = Number(haversineKm(stored.latitude, stored.longitude, coords.latitude, coords.longitude).toFixed(2));
    const radius = Number(o.deliveryRadiusKm || 0);
    return { outlet: o, distanceKm, radius, serviceable: radius > 0 && distanceKm <= radius };
  }).sort((a,b) => a.distanceKm - b.distanceKm);
  const best = ranked.find((x) => x.serviceable) || ranked[0];
  const charge = deliveryCharge(best.distanceKm, best.outlet.deliverySettings || {});
  return {
    ...coords,
    serviceable: best.serviceable,
    deliverable: best.serviceable,
    canDeliver: best.serviceable,
    nearestOutletId: String(best.outlet._id),
    nearestOutletName: best.outlet.name,
    distanceKm: best.distanceKm,
    deliveryRadiusKm: best.radius,
    allowedRadiusKm: best.radius,
    deliveryCharge: charge,
    message: best.serviceable
      ? `Delivery is available from ${best.outlet.name}.`
      : `Delivery is unavailable. The nearest outlet is ${best.distanceKm} km away and serves up to ${best.radius} km.`,
  };
}

module.exports = { cleanPincode, geocode, normalizeCoordinates, checkServiceability, coordinatePair, storedOutletCoordinates };
