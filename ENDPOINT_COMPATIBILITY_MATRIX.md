# Endpoint compatibility

The MongoDB backend retains the existing `/api` base and supports the principal aliases used by the four applications.

- Auth: `/auth/login`, `/login`, `/admin/login`, `/admin/auth/login`, `/seller/outlet-login`, `/outlet-manager/login`, `/auth/register`, `/auth/me`, `/user/profile`
- Discovery: `/home`, `/settings`, `/categories`, `/food-categories`, `/brands`, `/banners`, `/offers`, `/products`, `/products/:slug`, `/restaurants`, `/outlets`, `/restaurants/nearby`, `/outlets/nearby`, `/stores/:slug`, `/stores/:slug/menu`
- Outlet menus: `/outlets/:id/menu`, `/user/outlets/:id/menu`, `/outlets/:id/foods/search`, `/user/outlets/:id/foods/search`
- Cart/orders: `/cart`, `/cart/items`, `/checkout/summary`, `/user/orders`, `/orders`, `/orders/:id/status`, `/seller/orders/:id/status`, `/rider/orders/:id/status`, tracking and invoice aliases
- Payments: all legacy Razorpay create and verify aliases plus `/payments/webhook`
- Admin: outlets, primary outlet, categories, global products, outlet stock, managers, orders, transactions, refunds, settings, daily closings
- Seller: restaurant/outlet, products, orders, offline sales, day close
- Rider/delivery: available/current/history orders, accept, pickup, deliver, location, earnings

Unknown obsolete endpoints intentionally return a standard 404 rather than silently mutating data.
