const express = require('express');
const Product = require('../models/Product');
const Category = require('../models/Category');
const { protect, adminOnly } = require('../middleware/auth');
const { upload, uploadToCloudinary } = require('../middleware/upload');

const router = express.Router();

// Universal search - must be before /:slug
// Matches product name/description/tags AND category/sub-category names
router.get('/search/query', async (req, res) => {
  const q = req.query.q || '';
  if (!q.trim()) return res.json([]);
  try {
    const regex = new RegExp(q, 'i');

    // 1) Categories / sub-categories whose name matches the query
    const matchingCategories = await Category.find({
      $or: [{ name: regex }, { description: regex }],
    }).select('_id name slug parent');
    const catIds = matchingCategories.map((c) => c._id);

    // 2) Products matching the text OR belonging to a matching category chain
    const products = await Product.find({
      isActive: true,
      $or: [
        { name: regex },
        { description: regex },
        { tags: regex },
        ...(catIds.length ? [{ category: { $in: catIds } }] : []),
      ],
    })
      .populate('category', 'name slug')
      .limit(24)
      .sort({ createdAt: -1 });

    // Also return the matching categories so UIs can show category chips
    res.json({ products, categories: matchingCategories });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Public: list with filters
router.get('/', async (req, res) => {
  try {
    const { category, search, featured, limit = 20, page = 1, sort } = req.query;
    const filter = { isActive: true };
    if (featured === 'true') filter.isFeatured = true;
    if (search) {
      const regex = new RegExp(search, 'i');
      filter.$or = [{ name: regex }, { description: regex }, { tags: regex }];
    }
    if (category) {
      const cat = await Category.findOne({ slug: category });
      if (cat) {
        // include subcategories at any depth (e.g. Puja & Rituals > Sambrani Cup > Rose)
        const allCats = await Category.find().select('_id parent');
        const ids = [String(cat._id)];
        let grew = true;
        while (grew) {
          grew = false;
          for (const c of allCats) {
            const pid = String(c.parent || '');
            if (ids.includes(pid) && !ids.includes(String(c._id))) {
              ids.push(String(c._id));
              grew = true;
            }
          }
        }
        filter.category = { $in: ids };
      } else {
        filter.category = null; // will return empty
      }
    }

    let query = Product.find(filter).populate('category', 'name slug');

    if (sort === 'price_asc') query = query.sort({ price: 1 });
    else if (sort === 'price_desc') query = query.sort({ price: -1 });
    else query = query.sort({ createdAt: -1 });

    const total = await Product.countDocuments(filter);
    const products = await query.skip((page - 1) * limit).limit(Number(limit));

    res.json({ products, total, page: Number(page), pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: all including inactive
router.get('/admin/all', protect, adminOnly, async (req, res) => {
  try {
    const products = await Product.find().populate('category', 'name slug').sort({ createdAt: -1 });
    res.json(products);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/:slug', async (req, res) => {
  try {
    const product = await Product.findOne({ slug: req.params.slug }).populate('category', 'name slug');
    if (!product) return res.status(404).json({ message: 'Product not found' });
    res.json(product);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/id/:id', async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).populate('category', 'name slug');
    if (!product) return res.status(404).json({ message: 'Not found' });
    res.json(product);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin create - supports JSON images array OR multipart files (images) via Cloudinary
router.post('/', protect, adminOnly, upload.array('imageFiles', 5), async (req, res) => {
  try {
    const { name, description, shortDescription, price, comparePrice, category, images, stock, unit, weight, isFeatured, tags } = req.body;
    if (!name || !description || !price || !category) return res.status(400).json({ message: 'Missing required fields' });

    // resolve category: if slug provided, find id
    let categoryId = category;
    if (!category.match(/^[0-9a-fA-F]{24}$/)) {
      const cat = await Category.findOne({ slug: category });
      if (!cat) return res.status(400).json({ message: 'Category not found' });
      categoryId = cat._id;
    }

    // Handle images: from JSON array OR uploaded files via Cloudinary
    let imageUrls = [];
    if (images) {
      // images may be JSON string if multipart, or array if JSON
      if (typeof images === 'string') {
        try {
          const parsed = JSON.parse(images);
          imageUrls = Array.isArray(parsed) ? parsed : images.split(',').map((s) => s.trim()).filter(Boolean);
        } catch {
          imageUrls = images.split(',').map((s) => s.trim()).filter(Boolean);
        }
      } else if (Array.isArray(images)) {
        imageUrls = images;
      }
    }
    // If files uploaded, upload each to Cloudinary and append
    if (req.files && req.files.length > 0) {
      const uploads = await Promise.all(req.files.map((f) => uploadToCloudinary(f.buffer, { folder: 'anmool-dairy/products' })));
      imageUrls = [...imageUrls, ...uploads.map((u) => u.secure_url)];
    }

    // Parse tags if string
    let tagsArr = tags;
    if (typeof tags === 'string') {
      try {
        tagsArr = JSON.parse(tags);
      } catch {
        tagsArr = tags.split(',').map((s) => s.trim()).filter(Boolean);
      }
    }

    const product = await Product.create({
      name,
      description,
      shortDescription,
      price,
      comparePrice: comparePrice ? Number(comparePrice) : null,
      category: categoryId,
      images: imageUrls,
      stock: stock ? Number(stock) : 100,
      unit,
      weight,
      isFeatured: isFeatured === 'true' || isFeatured === true,
      tags: tagsArr || [],
    });
    const populated = await product.populate('category', 'name slug');
    res.status(201).json(populated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin update - also supports Cloudinary file uploads
router.put('/:id', protect, adminOnly, upload.array('imageFiles', 5), async (req, res) => {
  try {
    let update = { ...req.body };
    if (update.category && !update.category.match(/^[0-9a-fA-F]{24}$/)) {
      const cat = await Category.findOne({ slug: update.category });
      if (cat) update.category = cat._id;
    }
    // Handle images/files if provided
    if (req.files && req.files.length > 0) {
      const uploads = await Promise.all(req.files.map((f) => uploadToCloudinary(f.buffer, { folder: 'anmool-dairy/products' })));
      const urls = uploads.map((u) => u.secure_url);
      // If images also provided as array, merge
      if (update.images) {
        let existing = update.images;
        if (typeof existing === 'string') {
          try { existing = JSON.parse(existing); } catch { existing = existing.split(',').map((s) => s.trim()).filter(Boolean); }
        }
        update.images = [...(Array.isArray(existing) ? existing : []), ...urls];
      } else {
        update.images = urls;
      }
    } else if (typeof update.images === 'string') {
      try { update.images = JSON.parse(update.images); } catch { update.images = update.images.split(',').map((s) => s.trim()).filter(Boolean); }
    }
    if (typeof update.tags === 'string') {
      try { update.tags = JSON.parse(update.tags); } catch { update.tags = update.tags.split(',').map((s) => s.trim()).filter(Boolean); }
    }

    const product = await Product.findByIdAndUpdate(req.params.id, update, { new: true }).populate('category', 'name slug');
    if (!product) return res.status(404).json({ message: 'Not found' });
    res.json(product);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin delete
router.delete('/:id', protect, adminOnly, async (req, res) => {
  try {
    const p = await Product.findByIdAndDelete(req.params.id);
    if (!p) return res.status(404).json({ message: 'Not found' });
    res.json({ message: 'Product deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
