const normalizeRole = role => ({ CLIENT:'CUSTOMER', USER:'CUSTOMER', DELIVERY_BOY:'RIDER', DELIVERY_PARTNER:'RIDER', DELIVERY:'RIDER', DRIVER:'RIDER', OUTLET_MANAGER:'SELLER', RESTAURANT:'SELLER' }[String(role||'').toUpperCase()] || String(role||'').toUpperCase());
module.exports = { normalizeRole };
