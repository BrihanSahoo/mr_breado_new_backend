# Customer Flutter App Connection

This backend release is aligned with the supplied v62 customer Flutter source tree.

## Compatibility strategy

MongoDB ObjectIds remain canonical in the database. The API additionally exposes stable numeric `id` / `legacyId` values so the existing Flutter code can continue using integer identifiers without endpoint changes. `_id` and `mongoId` remain available for future migration to native MongoDB string IDs.

## Connected flows

- Customer registration/login and persistent JWT session
- Admin categories shown to customers
- Nearby/primary outlet discovery
- Only enabled, available, in-stock foods from the selected/nearest outlet
- Category and keyword food filtering
- Single-outlet cart
- Address CRUD
- Delivery-radius validation and server delivery charge
- Dynamic online-payment and takeaway settings
- Takeaway advance percentage
- COD and Razorpay checkout
- Payment verification without duplicate order creation
- Customer order history/details/cancellation
- Invoice/receipt PDF
- Notifications
- Delivered-order reviews
- Rider/order status tracking and latest rider location

## Flutter base URL

Run with:

```bash
flutter run --dart-define=API_BASE_URL=https://YOUR-RENDER-SERVICE.onrender.com/api
```

The supplied app archive is a source tree and does not contain `pubspec.yaml` or platform folders, so it must be copied into the complete Flutter project before `flutter analyze` or platform builds can run.
