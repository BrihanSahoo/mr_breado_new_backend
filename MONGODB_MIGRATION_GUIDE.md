# SQL to MongoDB migration guide

This project is a clean MongoDB implementation. It does not read the SQL database at runtime.

Recommended migration sequence:
1. Export SQL users, outlets/restaurants, categories, products, inventory, orders, payments, and riders to JSON.
2. Transform SQL identifiers into MongoDB ObjectIds while keeping old IDs in optional migration metadata.
3. Insert parent entities first: users, outlets, categories, products.
4. Insert outlet inventory using the unique `(outletId, productId)` key.
5. Insert orders with immutable item snapshots and one `outletId`.
6. Insert payments/refunds using unique gateway identifiers.
7. Reconcile counts and money totals before switching applications.

Do not point production applications to this backend until a staging migration and reconciliation pass is complete.
