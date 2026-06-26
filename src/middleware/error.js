const multer = require('multer');

module.exports = (err, req, res, next) => {
  let status = Number(err.status || err.statusCode || 0);
  let code = String(err.code || 'INTERNAL_ERROR');
  let message = String(err.message || 'Unexpected error');

  if (err instanceof multer.MulterError) {
    status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    code = err.code === 'LIMIT_FILE_SIZE' ? 'IMAGE_TOO_LARGE' : `UPLOAD_${err.code}`;
    message = err.code === 'LIMIT_FILE_SIZE'
      ? 'The selected image is too large. Upload an image smaller than 8 MB.'
      : 'The image upload could not be processed. Please select the file again.';
  } else if (err.name === 'ValidationError') {
    status = 422;
    code = 'VALIDATION_ERROR';
    message = Object.values(err.errors || {}).map((item) => item.message).filter(Boolean).join(', ') || 'Some fields are invalid.';
  } else if (err.name === 'CastError') {
    status = 400;
    code = 'INVALID_IDENTIFIER';
    message = 'The selected record is invalid.';
  } else if (Number(err.code) === 11000) {
    status = 409;
    code = 'DUPLICATE_RECORD';
    const field = Object.keys(err.keyPattern || err.keyValue || {})[0];
    message = field === 'slug' ? 'A record with this name already exists.' : 'This record already exists.';
  } else if (/Origin is not allowed by CORS/i.test(message)) {
    status = 403;
    code = 'CORS_ORIGIN_BLOCKED';
    message = 'This admin website is not allowed to access the API. Update CORS_ORIGINS in the backend.';
  }

  if (!status) status = 500;
  if (process.env.NODE_ENV !== 'production') console.error(err);

  res.status(status).json({
    success: false,
    message: status >= 500 && code === 'INTERNAL_ERROR' ? 'Internal server error' : message,
    code,
    requestId: req.id,
    ...(err.details ? { details: err.details } : {}),
  });
};
