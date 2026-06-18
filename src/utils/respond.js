exports.ok = (res, data = null, message = 'Success', status = 200) => res.status(status).json({ success: true, message, data });
exports.fail = (res, message = 'Request failed', status = 400, code = 'BAD_REQUEST', details) => res.status(status).json({ success: false, message, code, ...(details ? { details } : {}) });
