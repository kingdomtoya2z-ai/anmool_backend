const express = require('express');
const Banner = require('../models/Banner');
const { protect, adminOnly } = require('../middleware/auth');
const { upload, uploadToCloudinary } = require('../middleware/upload');

const router = express.Router();

// Public: active banners for the homepage hero slider, in display order
router.get('/', async (req, res) => {
  try {
    const banners = await Banner.find({ isActive: true }).sort({ sortOrder: 1, createdAt: 1 });
    res.json(banners);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: all banners including hidden
router.get('/all', protect, adminOnly, async (req, res) => {
  try {
    const banners = await Banner.find().sort({ sortOrder: 1, createdAt: 1 });
    res.json(banners);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: create — JSON (image URL) or multipart (imageFile via Cloudinary)
router.post('/', protect, adminOnly, upload.single('imageFile'), async (req, res) => {
  try {
    const { title, subtitle, image, link, buttonText, sortOrder, isActive } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ message: 'Banner title required' });

    let imageUrl = (image || '').trim();
    if (req.file) {
      const result = await uploadToCloudinary(req.file.buffer, { folder: 'anmool-dairy/banners' });
      imageUrl = result.secure_url;
    }
    if (!imageUrl) {
      return res.status(400).json({ message: 'Banner image is required — upload an image (Cloudinary) or paste an image URL.' });
    }

    const banner = await Banner.create({
      title: title.trim(),
      subtitle: subtitle || '',
      image: imageUrl,
      link: link || '',
      buttonText: buttonText || 'Shop Now',
      sortOrder: sortOrder !== undefined ? Number(sortOrder) : 0,
      isActive: isActive === 'false' || isActive === false ? false : true,
    });
    res.status(201).json(banner);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: update — also supports file upload
router.put('/:id', protect, adminOnly, upload.single('imageFile'), async (req, res) => {
  try {
    const update = { ...req.body };
    if (update.sortOrder !== undefined) update.sortOrder = Number(update.sortOrder);
    if (update.isActive !== undefined) update.isActive = update.isActive === 'true' || update.isActive === true;
    if (req.file) {
      const result = await uploadToCloudinary(req.file.buffer, { folder: 'anmool-dairy/banners' });
      update.image = result.secure_url;
    }
    const banner = await Banner.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!banner) return res.status(404).json({ message: 'Banner not found' });
    res.json(banner);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: delete
router.delete('/:id', protect, adminOnly, async (req, res) => {
  try {
    const banner = await Banner.findByIdAndDelete(req.params.id);
    if (!banner) return res.status(404).json({ message: 'Banner not found' });
    res.json({ message: 'Banner deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
