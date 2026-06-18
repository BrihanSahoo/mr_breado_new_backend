const mongoose = require('mongoose');

const COMPAT_MODELS = [
  'User','Outlet','Category','Brand','Product','Order','Payment','Refund',
  'RiderLocation','RiderEarning','OfflineSale','Invoice','Setting',
  'SettingAudit','Notification','Banner','Offer','Coupon','Review',
  'WalletTransaction','SupportTicket','VerificationRequest','DailyClosing'
];

async function nextSequence(collectionName) {
  const result = await mongoose.connection.collection('_counters').findOneAndUpdate(
    { _id: `legacy:${collectionName}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  return result.value?.seq ?? result.seq;
}

async function ensureLegacyIds() {
  for (const name of COMPAT_MODELS) {
    const Model = mongoose.models[name];
    if (!Model) continue;
    const missing = await Model.find({ legacyId: { $exists: false } }).select('_id').lean();
    if (!missing.length) continue;
    const ops = [];
    for (const doc of missing) {
      ops.push({ updateOne: { filter: { _id: doc._id, legacyId: { $exists: false } }, update: { $set: { legacyId: await nextSequence(Model.collection.collectionName) } } } });
    }
    if (ops.length) await Model.bulkWrite(ops, { ordered: true });
  }
}

module.exports = ensureLegacyIds;
