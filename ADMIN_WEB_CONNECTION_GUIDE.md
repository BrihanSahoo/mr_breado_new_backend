# Admin Web Connection Guide

The aligned Admin web calls this MongoDB backend through `VITE_API_BASE_URL`.

## Backend

```bash
npm ci
npm run check:syntax
npm test
npm start
```

## Admin web

Create `.env`:

```env
VITE_API_BASE_URL=https://YOUR-RENDER-SERVICE.onrender.com/api
```

Then:

```bash
npm ci
npm run build
npm run dev
```

## Connected business modules

- Admin login and JWT session
- Head-office dashboard and recent orders
- Category CRUD and category summary
- Global food catalog CRUD
- Outlet CRUD, primary outlet, location, GSTIN and branding
- Outlet food assignment, stock, low-stock limits and dashboard
- Outlet manager credentials
- Outlet orders and lifecycle actions
- Invoice downloads
- Online transactions
- Dynamic Razorpay, Google Maps, delivery-rate and rider-rate settings
- Online-payment, COD, takeaway and takeaway-advance controls
- Inventory movements and seller daily closings
