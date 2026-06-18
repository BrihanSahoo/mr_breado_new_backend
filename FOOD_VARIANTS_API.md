# Category-driven food variants

Canonical Admin routes:

- `GET /api/admin/categories`
- `GET|POST /api/admin/mr-breado/products`
- `GET|PUT|DELETE /api/admin/mr-breado/products/:id`
- `PATCH /api/admin/mr-breado/products/:id/availability`

Pizza payload:

```json
{
  "name": "Farmhouse Pizza",
  "categoryId": "<pizza-category-object-id>",
  "smallSizePrice": 199,
  "mediumSizePrice": 299,
  "largeSizePrice": 399
}
```

Cake payload:

```json
{
  "name": "Chocolate Cake",
  "categoryId": "<cake-category-object-id>",
  "cake500gmPrice": 450,
  "cake1kgPrice": 800,
  "cake15kgPrice": 1150,
  "cake2kgPrice": 1450,
  "cakeMessageEnabled": true,
  "cakeMessageCharge": 30
}
```

The server derives the variant type from the selected Admin category. It never trusts a client-provided variant type.
