const express = require('express');
const Category = require('../models/Category');
const Product = require('../models/Product');
const { protect, adminOnly } = require('../middleware/auth');
const { upload, uploadToCloudinary } = require('../middleware/upload');

const router = express.Router();

// ---------- tree helpers (unlimited depth) ----------
const idStr = (v) => String(v || '');
async function getChildIds(parentId) {
  const kids = await Category.find({ parent: parentId }).select('_id');
  return kids.map((k) => String(k._id));
}
async function getDescendantIds(parentId) {
  const all = await Category.find().select('_id parent');
  const ids = [];
  let frontier = [idStr(parentId)];
  let guard = 0;
  while (frontier.length && guard++ < 1000) {
    const next = [];
    for (const c of all) {
      if (frontier.includes(idStr(c.parent)) && !ids.includes(idStr(c._id))) {
        ids.push(idStr(c._id));
        next.push(idStr(c._id));
      }
    }
    frontier = next;
  }
  return ids;
}
async function isLeafCategory(categoryId) {
  const n = await Category.countDocuments({ parent: categoryId });
  return n === 0;
}
// true if assigning newParentId as parent of categoryId would create a cycle
async function wouldCreateCycle(categoryId, newParentId) {
  if (!newParentId) return false;
  if (idStr(categoryId) === idStr(newParentId)) return true;
  const desc = await getDescendantIds(categoryId);
  return desc.includes(idStr(newParentId));
}

// Public: list categories with product counts optional
router.get('/', async (req, res) => {
  try {
    const categories = await Category.find()
      .populate('parent', 'name slug')
      .populate({
        path: 'homepageProducts',
        select: 'name slug price comparePrice images stock unit weight isActive',
        populate: { path: 'category', select: 'name slug' },
      })
      .sort({ createdAt: 1 });
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
// Changing parent is validated: no self-parenting, no cycles (can't move a
// category under one of its own descendants at any depth).
router.put('/:id', protect, adminOnly, upload.single('imageFile'), async (req, res) => {
  try {
    const update = { ...req.body };
    if (req.file) {
      const result = await uploadToCloudinary(req.file.buffer, { folder: 'anmool-dairy/categories' });
      update.image = result.secure_url;
    }
    if (update.parent !== undefined) {
      const newParentId = update.parent || null;
      if (newParentId) {
        const parentCat = await Category.findById(newParentId);
        if (!parentCat) return res.status(400).json({ message: 'Parent category not found' });
        update.parent = parentCat._id;
      } else {
        update.parent = null;
      }
      if (await wouldCreateCycle(req.params.id, update.parent)) {
        return res.status(400).json({ message: 'Cannot move a category under itself or its own sub-category' });
      }
    }
    const category = await Category.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!category) return res.status(404).json({ message: 'Not found' });
    res.json(category);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: set this category's homepage picks (ordered product ids, max 8).
// Products must belong to this category's own subtree (category-wise picks).
router.put('/:id/homepage-products', protect, adminOnly, async (req, res) => {
  try {
    const cat = await Category.findById(req.params.id);
    if (!cat) return res.status(404).json({ message: 'Category not found' });
    let ids = req.body.productIds || req.body.ids || [];
    if (!Array.isArray(ids)) return res.status(400).json({ message: 'productIds must be an array' });
    ids = [...new Set(ids.map(String))].slice(0, 8);
    if (ids.length) {
      const subtree = [String(cat._id), ...(await getDescendantIds(cat._id))];
      const found = await Product.find({ _id: { $in: ids } }).select('_id category');
      if (found.length !== ids.length) {
        return res.status(400).json({ message: 'One or more products not found' });
      }
      const outsiders = found.filter((p) => !subtree.includes(String(p.category)));
      if (outsiders.length) {
        return res.status(400).json({ message: 'Homepage picks must be products of this category (or its sub-categories)' });
      }
    }
    cat.homepageProducts = ids;
    await cat.save();
    const populated = await Category.findById(cat._id).populate({
      path: 'homepageProducts',
      select: 'name slug price comparePrice images stock unit weight isActive',
      populate: { path: 'category', select: 'name slug' },
    });
    res.json(populated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: delete — blocked when the category subtree holds products (products
// live only on final/leaf categories, so move/delete them first). Otherwise
// direct children are re-attached to the deleted node's own parent so the
// tree stays intact at any depth.
router.delete('/:id', protect, adminOnly, async (req, res) => {
  try {
    const cat = await Category.findById(req.params.id);
    if (!cat) return res.status(404).json({ message: 'Not found' });
    const subtreeIds = [String(cat._id), ...(await getDescendantIds(cat._id))];
    const productCount = await Product.countDocuments({ category: { $in: subtreeIds } });
    if (productCount > 0) {
      return res.status(400).json({
        message: `Cannot delete — ${productCount} product(s) live under "${cat.name}" (or its sub-categories). Move or delete those products first.`,
      });
    }
    await Category.findByIdAndDelete(req.params.id);
    await Category.updateMany({ parent: cat._id }, { $set: { parent: cat.parent || null } });
    res.json({ message: 'Category deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
