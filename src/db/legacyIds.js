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
  return result?.value?.seq ?? result?.seq;
}

/**
 * Backfills numeric compatibility IDs without asking Mongoose to cast `_id`.
 *
 * Some legacy collections (notably settings imported from older backends) may
 * legitimately contain string `_id` values such as "cmOfWestBengal". Using
 * Model.bulkWrite() makes Mongoose cast those values to ObjectId and crashes
 * startup. Native collection operations preserve the original BSON type and
 * safely support both ObjectId and string identifiers.
 */
async function ensureLegacyIds() {
  for (const name of COMPAT_MODELS) {
    const Model = mongoose.models[name];
    if (!Model) continue;

    const collection = Model.collection;
    const missing = await collection
      .find({ legacyId: { $exists: false } }, { projection: { _id: 1 } })
      .toArray();

    if (!missing.length) continue;

    const ops = [];
    for (const doc of missing) {
      const legacyId = await nextSequence(collection.collectionName);
      ops.push({
        updateOne: {
          filter: { _id: doc._id, legacyId: { $exists: false } },
          update: { $set: { legacyId } }
        }
      });
    }

    if (ops.length) {
      await collection.bulkWrite(ops, { ordered: false });
    }
  }
}

module.exports = ensureLegacyIds;
