# Outlet Manager App Connection Guide

This backend revision includes a canonical seller/outlet compatibility router mounted before the generic seller router.

## Supported app flows

- `POST /api/outlet/auth/login`
- `GET|PUT /api/seller/restaurant`
- `PATCH /api/seller/restaurant/status`
- `GET /api/seller/products`
- `PUT /api/seller/products/:id`
- `PATCH /api/seller/products/:id/availability`
- `POST /api/outlet-manager/stock`
- `GET /api/seller/orders`
- `GET /api/seller/orders/:id`
- `POST /api/seller/orders/:id/accept|reject|preparing|ready|cancel`
- `GET /api/seller/orders/:id/invoice.pdf`
- `POST /api/seller/orders/:id/invoice/send-to-customer`
- `POST /api/outlet-manager/offline-sales`
- `GET /api/outlet-manager/dashboard`
- `GET /api/outlet-manager/stock-ledger`
- `POST /api/outlet-manager/close-day`

Every seller operation resolves the outlet from the authenticated user's assigned outlets. Client-provided outlet IDs are authorization-checked.
