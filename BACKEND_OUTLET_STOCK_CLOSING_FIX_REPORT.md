# Mr. Breado Backend Outlet Login, Stock and Daily Closing Fix

## Implemented

- Dedicated public outlet-manager login aliases no longer share role-ambiguous login handling.
- Outlet-manager login accepts only seller/outlet-manager accounts and returns the assigned outlet from the authoritative manager binding.
- New outlets are closed by default.
- Outlet managers and admin-selected outlet sessions can open an outlet directly.
- Closing an outlet through the simple status endpoint is blocked until a daily sales report is submitted.
- Submitting the daily report atomically stores the report, updates closing stock and closes the outlet.
- Admin can retrieve each outlet's daily reports and open one detailed report with populated seller and product information.
- Admin outlet-product updates now assign/unassign catalogue products only. New assignments start with zero stock and require seller initialization.
- Seller stock endpoints can initialize or update stock throughout the day and record who changed it and when.
- Startup stock summary returns assigned foods, initial-stock requirement, low-stock items and out-of-stock items.
- Inventory reservation, release and consumption keep availability synchronized with physical and reserved stock.
- Order completion deducts exact outlet stock through the existing transactional order flow.
- Customer outlet menus now return available stock, low-stock threshold, low-stock flag and professional stock message.
- Backend order creation still rejects insufficient outlet stock before creating an order.

## Important endpoints

- POST `/api/outlet/auth/login`
- POST `/api/outlet-manager/login`
- GET `/api/outlet-manager/me`
- GET `/api/outlet-manager/stock-summary`
- PUT `/api/seller/products/:productId`
- POST `/api/outlet-manager/stock`
- PATCH `/api/seller/restaurant/status` (open only; close requires report)
- POST `/api/outlet-manager/close-day`
- POST `/api/seller/day-close`
- GET `/api/admin/outlets/:outletId/daily-reports`
- GET `/api/admin/outlets/:outletId/daily-reports/:reportId`

## Validation

- JavaScript syntax validation passed for every source file.
- Automated backend test suite passed: 22/22.
