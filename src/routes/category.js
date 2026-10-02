const express = require('express');
const Category = require('../models/Category');
const Product = require('../models/Product');
const { protect, adminOnly } = require('../middleware/auth');
const { upload, uploadToCloudinary } = require('../middleware/upload');

const router = express.Router();

// Public: list categories with product counts optional
router.get('/', async (req, res) => {
  try {
    const categories = await Category.find().populate('parent', 'name slug').sort({ createdAt: 1 });
    // Attach live product counts per category
    const counts = await Product.aggregate([
      { $group: { _id: '$category', count: { $sum: 1 } } },
    ]);
    const countMap = {};
    counts.forEach((c) => (countMap[c._id] = c.count));
    const withCounts = categories.map((c) => {
      const obj = c.toObject();
      obj.productCount = countMap[c._id] || 0;
      return obj;
    });
    res.json(withCounts);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/:slug', async (req, res) => {
  try {
    const category = await Category.findOne({ slug: req.params.slug });
    if (!category) return res.status(404).json({ message: 'Category not found' });
    res.json(category);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: create - supports JSON (image URL) or multipart (image file via Cloudinary)
// Category image is REQUIRED (file upload or URL) — it shows on homepage + hero slider.
router.post('/', protect, adminOnly, upload.single('imageFile'), async (req, res) => {
  try {
    const { name, description, image, parent } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ message: 'Category name required' });

    let parentId = null;
    if (parent) {
      const parentCat = await Category.findById(parent);
      if (!parentCat) return res.status(400).json({ message: 'Parent category not found' });
      parentId = parentCat._id;
    }

    // Names are unique within the same parent (same name can repeat under different parents)
    const exists = await Category.findOne({ name: name.trim(), parent: parentId });
    if (exists) return res.status(400).json({ message: 'Category already exists here' });

    let imageUrl = (image || '').trim();
    // If file uploaded, push to Cloudinary (real upload — fails loudly if not configured)
    if (req.file) {
      const result = await uploadToCloudinary(req.file.buffer, { folder: 'anmool-dairy/categories' });
      imageUrl = result.secure_url;
    }
    if (!imageUrl) {
      return res.status(400).json({ message: 'Category image is required — upload an image (Cloudinary) or paste an image URL. It shows on the homepage.' });
    }

    const category = await Category.create({ name: name.trim(), description: description || '', image: imageUrl, parent: parentId });
    res.status(201).json(category);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: update - also supports file upload
router.put('/:id', protect, adminOnly, upload.single('imageFile'), async (req, res) => {
  try {
    const update = { ...req.body };
    if (req.file) {
      const result = await uploadToCloudinary(req.file.buffer, { folder: 'anmool-dairy/categories' });
      update.image = result.secure_url;
    }
    const category = await Category.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!category) return res.status(404).json({ message: 'Not found' });
    res.json(category);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: delete — children sub-categories move to top level so nothing orphans
router.delete('/:id', protect, adminOnly, async (req, res) => {
  try {
    const cat = await Category.findByIdAndDelete(req.params.id);
    if (!cat) return res.status(404).json({ message: 'Not found' });
    await Category.updateMany({ parent: cat._id }, { $set: { parent: null } });
    res.json({ message: 'Category deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
