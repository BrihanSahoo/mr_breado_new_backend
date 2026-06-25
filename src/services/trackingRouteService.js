const settings = require('./settingsService');

const cache = new Map();
const CACHE_MS = 20_000;
const MAX_CACHE = 300;

function validPoint(point) {
  return point && Number.isFinite(Number(point.latitude)) && Number.isFinite(Number(point.longitude))
    && Math.abs(Number(point.latitude)) <= 90 && Math.abs(Number(point.longitude)) <= 180
    && (Math.abs(Number(point.latitude)) > 0.000001 || Math.abs(Number(point.longitude)) > 0.000001);
}

function cacheKey(origin, destination) {
  const round = (value) => Number(value).toFixed(4);
  return `${round(origin.latitude)},${round(origin.longitude)}:${round(destination.latitude)},${round(destination.longitude)}`;
}

function cleanInstruction(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

async function getDrivingRoute(origin, destination) {
  if (!validPoint(origin) || !validPoint(destination)) return null;
  const key = cacheKey(origin, destination);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.savedAt < CACHE_MS) return cached.value;

  const maps = await settings.get('googleMaps');
  const apiKey = maps?.apiKey || maps?.key;
  if (!apiKey) return null;

  try {
    const url = new URL('https://maps.googleapis.com/maps/api/directions/json');
    url.searchParams.set('origin', `${origin.latitude},${origin.longitude}`);
    url.searchParams.set('destination', `${destination.latitude},${destination.longitude}`);
    url.searchParams.set('mode', 'driving');
    url.searchParams.set('alternatives', 'false');
    url.searchParams.set('key', apiKey);
    const response = await fetch(url, { signal: AbortSignal.timeout(7000) });
    if (!response.ok) return null;
    const json = await response.json();
    const route = json.routes?.[0];
    const leg = route?.legs?.[0];
    if (!route || !leg) return null;
    const value = {
      encodedPolyline: route.overview_polyline?.points || '',
      polyline: route.overview_polyline?.points || '',
      distanceText: leg.distance?.text || '',
      distanceMeters: Number(leg.distance?.value || 0),
      distanceKm: Number(leg.distance?.value || 0) / 1000,
      durationText: leg.duration?.text || '',
      durationSeconds: Number(leg.duration?.value || 0),
      etaMinutes: Math.max(1, Math.ceil(Number(leg.duration?.value || 0) / 60)),
      steps: (leg.steps || []).map((step) => ({
        instruction: cleanInstruction(step.html_instructions),
        distance: step.distance?.text || '',
        duration: step.duration?.text || '',
        endLocation: step.end_location || null,
      })),
    };
    cache.set(key, { savedAt: Date.now(), value });
    if (cache.size > MAX_CACHE) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].savedAt - b[1].savedAt).slice(0, cache.size - MAX_CACHE);
      for (const [oldKey] of oldest) cache.delete(oldKey);
    }
    return value;
  } catch (_) {
    return null;
  }
}

module.exports = { getDrivingRoute };
