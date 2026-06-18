const PDFDocument = require('pdfkit');
const { Invoice, Order } = require('../models');
const { AppError } = require('../utils/errors');

const money = (value) => `₹${Number(value || 0).toFixed(2)}`;
const text = (value, fallback = '—') => String(value || '').trim() || fallback;
const addressLine = (address = {}) => [
  address.line1 || address.address || address.street,
  address.line2,
  address.area,
  address.landmark,
  address.city,
  address.state,
  address.pincode || address.zipcode,
].filter(Boolean).join(', ');

async function resolveOrder(orderOrId) {
  if (orderOrId && typeof orderOrId === 'object' && orderOrId._id) {
    if (!orderOrId.populated?.('outletId')) await orderOrId.populate('outletId customerId riderId');
    return orderOrId;
  }
  const order = await Order.findById(orderOrId).populate('outletId customerId riderId');
  if (!order) throw new AppError('Order not found', 404);
  return order;
}

async function stream(orderOrId, maybeUserOrRes, maybeRes) {
  // Supports both stream(order, res) and legacy stream(orderId, user, res).
  const res = maybeRes || maybeUserOrRes;
  const order = await resolveOrder(orderOrId);
  if (order.status !== 'DELIVERED') throw new AppError('Invoice is available only after delivery', 409, 'INVOICE_NOT_READY');

  const invoice = await Invoice.findOneAndUpdate(
    { orderId: order._id },
    { $setOnInsert: { invoiceNumber: `INV-${new Date().getFullYear()}-${String(order._id).slice(-8).toUpperCase()}` } },
    { upsert: true, new: true },
  );

  const outlet = order.outletId || {};
  const customer = order.customerId || {};
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${invoice.invoiceNumber}.pdf"`);

  const d = new PDFDocument({ margin: 42, size: 'A4' });
  d.pipe(res);
  d.fontSize(22).text(text(outlet.name, 'MR BREАDO'), { align: 'center' });
  d.fontSize(10).text('TAX INVOICE', { align: 'center' }).moveDown(0.5);
  d.fontSize(9).text(addressLine(outlet.address), { align: 'center' });
  d.text(`GSTIN: ${text(outlet.gstin, 'Not provided')}`, { align: 'center' }).moveDown();

  d.fontSize(10).text(`Invoice No: ${invoice.invoiceNumber}`);
  d.text(`Invoice Date: ${new Date(invoice.invoiceDate).toLocaleDateString('en-IN')}`);
  d.text(`Order No: ${order.slug}`);
  d.text(`Order Date: ${new Date(order.createdAt).toLocaleString('en-IN')}`).moveDown();

  d.fontSize(11).text('Bill To', { underline: true });
  d.fontSize(10).text(text(customer.name, order.address?.name || 'Customer'));
  d.text(text(customer.phone, order.address?.phone || 'Phone not provided'));
  d.text(text(customer.email, 'Email not provided'));
  d.text(addressLine(order.address)).moveDown();

  d.fontSize(11).text('Order Items', { underline: true }).moveDown(0.3);
  for (const item of order.items || []) {
    const variants = [item.selectedSize, item.selectedWeight].filter(Boolean).join(' / ');
    const custom = (item.customizations || []).map((x) => x.optionName || x.name).filter(Boolean).join(', ');
    d.fontSize(10).text(`${text(item.name)}${variants ? ` (${variants})` : ''} × ${Number(item.quantity || 0)}`);
    if (custom) d.fontSize(8).text(`  Add-ons: ${custom}`);
    d.fontSize(10).text(money(item.finalTotal), { align: 'right' });
  }

  d.moveDown().fontSize(10)
    .text(`Subtotal: ${money(order.subtotal)}`, { align: 'right' })
    .text(`Discount: -${money(order.discount)}`, { align: 'right' })
    .text(`Tax: ${money(order.tax)}`, { align: 'right' })
    .text(`Delivery Charge: ${money(order.deliveryCharge)}`, { align: 'right' })
    .fontSize(13).text(`Grand Total: ${money(order.total)}`, { align: 'right' })
    .moveDown().fontSize(9)
    .text(`Payment: ${text(order.paymentMethod)} / ${text(order.paymentStatus)}`)
    .text(`Fulfilment: ${text(order.fulfilmentType)}`)
    .text(`Outlet: ${text(outlet.name)} (${text(outlet.code)})`)
    .moveDown().text('This is a computer-generated invoice.', { align: 'center' });
  d.end();
}

module.exports = { stream, resolveOrder };
