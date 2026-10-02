const express = require('express');
const { protect, adminOnly } = require('../middleware/auth');
const { upload, uploadToCloudinary, hasCloudinary } = require('../middleware/upload');

const router = express.Router();

// @GET /api/upload/status - admin only, reports Cloudinary configuration state
router.get('/status', protect, adminOnly, (req, res) => {
  res.json({
    configured: hasCloudinary,
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
    message: hasCloudinary
      ? 'Cloudinary is configured — real image uploads enabled.'
      : 'Cloudinary is NOT configured. Set CLOUDINARY_CLOUD_NAME in backend/.env to enable real image uploads.',
  });
});

// @POST /api/upload/single  - admin only, single image
router.post('/single', protect, adminOnly, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No image file provided (field: image)' });
    const result = await uploadToCloudinary(req.file.buffer, { folder: 'anmool-dairy/products' });
    res.json({ url: result.secure_url, public_id: result.public_id, simulated: result.simulated || false });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ message: err.message || 'Upload failed' });
  }
});

// @POST /api/upload/multiple  - admin only, up to 5 images
router.post('/multiple', protect, adminOnly, upload.array('images', 5), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) return res.status(400).json({ message: 'No image files provided (field: images)' });
    const uploads = await Promise.all(
      req.files.map((f) => uploadToCloudinary(f.buffer, { folder: 'anmool-dairy/products' }))
    );
    res.json({
      urls: uploads.map((u) => u.secure_url),
      results: uploads,
    });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ message: err.message || 'Upload failed' });
  }
});

// @POST /api/upload/category - single category image
router.post('/category', protect, adminOnly, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No image file provided' });
    const result = await uploadToCloudinary(req.file.buffer, { folder: 'anmool-dairy/categories' });
    res.json({ url: result.secure_url, public_id: result.public_id, simulated: result.simulated || false });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
