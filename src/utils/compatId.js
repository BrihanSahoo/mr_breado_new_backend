const mongoose = require('mongoose');
const { embeddedLegacyId } = require('./respond');

const isObjectId = (value) => mongoose.Types.ObjectId.isValid(String(value || ''));

async function findOneCompat(Model, value, extra = {}) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (isObjectId(raw)) return Model.findOne({ _id: raw, ...extra });
  if (/^\d+$/.test(raw)) return Model.findOne({ legacyId: Number(raw), ...extra });
  return Model.findOne({ slug: raw, ...extra });
}

async function resolveObjectId(Model, value, extra = {}) {
  const doc = await findOneCompat(Model, value, extra);
  return doc?._id || null;
}

function findEmbeddedByCompatId(array, value) {
  const raw = String(value ?? '').trim();
  return (array || []).find((item) => {
    const id = String(item?._id ?? '');
    return id === raw || String(embeddedLegacyId(id)) === raw;
  }) || null;
}

module.exports = { isObjectId, findOneCompat, resolveObjectId, findEmbeddedByCompatId };
