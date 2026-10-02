const multer = require('multer');
const streamifier = require('streamifier');
const { cloudinary, hasCloudinary } = require('../config/cloudinary');

// Use memory storage so we can stream to Cloudinary
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  if (file.mimetype.startsWith('image/')) cb(null, true);
  else cb(new Error('Only image files allowed'), false);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

/**
 * Upload buffer to Cloudinary
 * Fails loudly (never returns a fake/placeholder image) when Cloudinary
 * is not configured or when the upload fails.
 * @param {Buffer} buffer
 * @param {Object} options - { folder }
 * @returns {Promise<{secure_url, public_id}>}
 */
const uploadToCloudinary = (buffer, options = {}) => {
  const folder = options.folder || 'anmool-dairy';
  if (!hasCloudinary) {
    return Promise.reject(
      new Error(
        'Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET in backend/.env — see your Cloudinary Console → Dashboard.'
      )
    );
  }

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: 'image', transformation: [{ quality: 'auto', fetch_format: 'auto' }] },
      (error, result) => {
        if (error) {
          console.error('Cloudinary upload failed:', error.message);
          return reject(new Error(`Cloudinary upload failed: ${error.message}`));
        }
        resolve(result);
      }
    );
    streamifier.createReadStream(buffer).pipe(stream);
  });
};

module.exports = { upload, uploadToCloudinary, hasCloudinary };