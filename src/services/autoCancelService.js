const { Order } = require('../models');
const orderService = require('./orderService');
const env = require('../config/env');

function deadlineAgo(minutes) {
  return new Date(Date.now() - Math.max(1, Number(minutes || 60)) * 60_000);
}

async function runAutoCancel({ logger = console } = {}) {
  const now = new Date();
  const sellerMinutes = Math.max(1, Number(env.autoCancel.sellerMinutes || 60));
  const riderMinutes = Math.max(1, Number(env.autoCancel.riderMinutes || 60));
  const paymentMinutes = Math.max(1, Number(env.autoCancel.paymentMinutes || 30));

  const candidates = await Order.find({
    $or: [
      {
        status: 'PENDING_PAYMENT',
        $or: [
          { sellerAcceptanceDeadline: { $lte: now } },
          { sellerAcceptanceDeadline: { $exists: false }, createdAt: { $lte: deadlineAgo(paymentMinutes) } },
          { sellerAcceptanceDeadline: null, createdAt: { $lte: deadlineAgo(paymentMinutes) } },
        ],
      },
      {
        status: 'RECEIVED',
        $or: [
          { sellerAcceptanceDeadline: { $lte: now } },
          { sellerAcceptanceDeadline: { $exists: false }, createdAt: { $lte: deadlineAgo(sellerMinutes) } },
          { sellerAcceptanceDeadline: null, createdAt: { $lte: deadlineAgo(sellerMinutes) } },
        ],
      },
      {
        status: { $in: ['READY', 'RIDER_ASSIGNMENT_PENDING'] },
        $or: [
          { riderAcceptanceDeadline: { $lte: now } },
          { riderAcceptanceDeadline: { $exists: false }, readyAt: { $lte: deadlineAgo(riderMinutes) } },
          { riderAcceptanceDeadline: null, readyAt: { $lte: deadlineAgo(riderMinutes) } },
        ],
      },
      {
        status: 'RIDER_ASSIGNED',
        pickedUpAt: null,
        $or: [
          { riderAcceptanceDeadline: { $lte: now } },
          { riderAcceptanceDeadline: { $exists: false }, updatedAt: { $lte: deadlineAgo(riderMinutes) } },
          { riderAcceptanceDeadline: null, updatedAt: { $lte: deadlineAgo(riderMinutes) } },
        ],
      },
    ],
  });

  const actor = { id: null, role: 'ADMIN' };
  let cancelled = 0;
  const failures = [];

  for (const order of candidates) {
    let reason = 'Order timeout';
    if (order.status === 'PENDING_PAYMENT') reason = 'Payment was not completed within the allowed time';
    else if (order.status === 'RECEIVED') reason = 'Seller did not accept the order within the allowed time';
    else reason = 'No rider picked up the order within the allowed time';

    try {
      await orderService.changeStatus(
        order,
        actor,
        'CANCELLED',
        reason,
        `auto-cancel:${order._id}:${order.status}`,
        { force: true },
      );
      cancelled += 1;
    } catch (error) {
      if (error?.code !== 11000) {
        failures.push({ orderId: String(order._id), message: error.message });
        logger.error?.(`Auto-cancel failed for ${order._id}: ${error.message}`);
      }
    }
  }

  return { candidates: candidates.length, cancelled, failures };
}

function startAutoCancelScheduler({ logger = console, intervalMs = 60_000 } = {}) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runAutoCancel({ logger });
      if (result.cancelled || result.failures.length) logger.log?.('Auto-cancel result', result);
    } catch (error) {
      logger.error?.('Auto-cancel scheduler error', error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  setTimeout(tick, 5_000).unref?.();
  return timer;
}

module.exports = { runAutoCancel, startAutoCancelScheduler };
