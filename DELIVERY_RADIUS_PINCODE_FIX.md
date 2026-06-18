# Delivery Radius and Pincode Serviceability Fix

## Backend
- Outlet location update now accepts `serviceRadiusKm`, `deliveryRadiusKm`, `delivery_radius_km`, `radiusKm`, or `radius_km`.
- Radius must be greater than 0 and no more than 100 km.
- Coordinates are validated and compared with the configured Google Maps geocoding result. Reversed latitude/longitude are corrected automatically when the address proves they were swapped.
- Outlet address fields are preserved with dot-notation updates instead of replacing the full address object.
- Added `POST /api/delivery/check-pincode` plus compatibility aliases:
  - `/api/serviceability/check-pincode`
  - `/api/addresses/check-serviceability`
- Address creation and update now geocode the address/pincode, calculate the nearest active outlet, distance, allowed radius, exact serviceability, and delivery charge.
- Saved addresses persist serviceability metadata.

## Admin Web
- Delivery radius renders from all canonical and legacy response fields.
- Radius zero is no longer hidden by boolean fallback logic.
- Latitude and longitude labels include correct examples.

## Customer App
- A six-digit pincode automatically triggers backend serviceability validation.
- The Add Address page immediately shows whether delivery is available.
- Unserviceable addresses are blocked from being saved as checkout addresses.
- Backend-corrected coordinates are stored with the saved address.
