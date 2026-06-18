const normalizeRole = role => ({ CLIENT:'CUSTOMER', USER:'CUSTOMER', DELIVERY_BOY:'RIDER', OUTLET_MANAGER:'SELLER', RESTAURANT:'SELLER' }[String(role||'').toUpperCase()] || String(role||'').toUpperCase());
module.exports = { normalizeRole };
