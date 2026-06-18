const crypto = require('crypto');

function embeddedLegacyId(value) {
  const text = String(value || '');
  if (!text) return 0;
  const digest = crypto.createHash('sha1').update(text).digest();
  return digest.readUInt32BE(0) & 0x7fffffff;
}

function serialize(value) {
  if (value == null) return value;
  if (Buffer.isBuffer(value) || value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(serialize);
  if (typeof value?.toObject === 'function') return serialize(value.toObject({ virtuals: false }));
  if (typeof value !== 'object') return value;

  const out = {};
  for (const [key, val] of Object.entries(value)) out[key] = serialize(val);

  if (value._id != null) {
    const mongoId = String(value._id);
    out._id = mongoId;
    out.mongoId = mongoId;
    out.id = value.legacyId != null ? Number(value.legacyId) : embeddedLegacyId(mongoId);
  }
  if (value.legacyId != null) out.legacyId = Number(value.legacyId);
  return out;
}

exports.serialize = serialize;
exports.embeddedLegacyId = embeddedLegacyId;
exports.ok = (res, data = null, message = 'Success', status = 200) => res.status(status).json({ success: true, message, data: serialize(data) });
exports.fail = (res, message = 'Request failed', status = 400, code = 'BAD_REQUEST', details) => res.status(status).json({ success: false, message, code, ...(details ? { details: serialize(details) } : {}) });
