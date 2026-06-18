const toRad = d => d * Math.PI / 180;
function haversineKm(aLat, aLng, bLat, bLng) {
  const R = 6371; const dLat = toRad(bLat-aLat); const dLng = toRad(bLng-aLng);
  const x = Math.sin(dLat/2)**2 + Math.cos(toRad(aLat))*Math.cos(toRad(bLat))*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
}
function deliveryCharge(distanceKm, settings) {
  const raw = Number(settings.baseCharge||0) + distanceKm * Number(settings.perKmCharge||0);
  return Number(Math.min(Number(settings.maximumCharge||raw), Math.max(Number(settings.minimumCharge||0), raw)).toFixed(2));
}
module.exports = { haversineKm, deliveryCharge };
