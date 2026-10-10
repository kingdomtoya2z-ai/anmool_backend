const express = require('express');
const Coupon = require('../models/Coupon');
const Product = require('../models/Product');
const { protect, adminOnly } = require('../middleware/auth');
const { validateCoupon } = require('../utils/coupon');

const router = express.Router();

// ---------- Admin: list all coupons ----------
router.get('/', protect, adminOnly, async (req, res) => {
  try {
    const coupons = await Coupon.find()
      .populate('applicableProducts', 'name slug')
      .sort({ createdAt: -1 });
    res.json(coupons);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ---------- Admin: create ----------
router.post('/', protect, adminOnly, async (req, res) => {
  try {
    const { code, description, discountType, discountValue, minOrderAmount, applicableProducts, isActive, expiresAt, usageLimit } = req.body;
    if (!code || !code.trim()) return res.status(400).json({ message: 'Coupon code required' });
    if (!['percent', 'flat'].includes(discountType)) return res.status(400).json({ message: 'Discount type must be percent or flat' });
    const val = Number(discountValue);
    if (!val || val <= 0) return res.status(400).json({ message: 'Discount value must be positive' });
    if (discountType === 'percent' && val > 90) return res.status(400).json({ message: 'Percent discount cannot exceed 90%' });

    let prodIds = [];
    if (applicableProducts && applicableProducts.length) {
      const found = await Product.find({ _id: { $in: applicableProducts } }).select('_id');
      if (found.length !== [...new Set(applicableProducts.map(String))].length) {
        return res.status(400).json({ message: 'One or more products not found' });
      }
      prodIds = found.map((p) => p._id);
    }

    const coupon = await Coupon.create({
      code: code.trim(),
      description: description || '',
      discountType,
      discountValue: val,
      minOrderAmount: Math.max(0, Number(minOrderAmount) || 0),
      applicableProducts: prodIds,
      isActive: isActive !== false,
      expiresAt: expiresAt || null,
      usageLimit: usageLimit ? Number(usageLimit) : null,
    });
    res.status(201).json(coupon);
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ message: 'This coupon code already exists' });
    res.status(500).json({ message: err.message });
  }
});

// ---------- Admin: update ----------
router.put('/:id', protect, adminOnly, async (req, res) => {
  try {
    const update = { ...req.body };
    delete update.code;
    delete update.usedCount;
    if (update.discountType && !['percent', 'flat'].includes(update.discountType)) {
      return res.status(400).json({ message: 'Discount type must be percent or flat' });
    }
    if (update.discountValue !== undefined) {
      const val = Number(update.discountValue);
      if (!val || val <= 0) return res.status(400).json({ message: 'Discount value must be positive' });
      const type = update.discountType || (await Coupon.findById(req.params.id))?.discountType;
      if (type === 'percent' && val > 90) return res.status(400).json({ message: 'Percent discount cannot exceed 90%' });
      update.discountValue = val;
    }
    if (update.applicableProducts) {
      if (!update.applicableProducts.length) update.applicableProducts = [];
      else {
        const found = await Product.find({ _id: { $in: update.applicableProducts } }).select('_id');
        if (found.length !== [...new Set(update.applicableProducts.map(String))].length) {
          return res.status(400).json({ message: 'One or more products not found' });
        }
        update.applicableProducts = found.map((p) => p._id);
      }
    }
    const coupon = await Coupon.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!coupon) return res.status(404).json({ message: 'Not found' });
    res.json(coupon);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ---------- Admin: delete ----------
router.delete('/:id', protect, adminOnly, async (req, res) => {
  try {
    const c = await Coupon.findByIdAndDelete(req.params.id);
    if (!c) return res.status(404).json({ message: 'Not found' });
    res.json({ message: 'Coupon deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ---------- Checkout: validate one code against the cart ----------
router.post('/validate', protect, async (req, res) => {
  try {
    const { code, items } = req.body;
    const { coupon, subtotal, base, discount } = await validateCoupon(code, items);
    res.json({
      valid: true,
      code: coupon.code,
      description: coupon.description,
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      minOrderAmount: coupon.minOrderAmount,
      subtotal,
      eligibleAmount: base,
      discount,
      payableBeforeShipping: subtotal - discount,
    });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
});

// ---------- Checkout: which coupons is this cart eligible for? (suggestions) ----------
router.post('/suggest', protect, async (req, res) => {
  try {
    const { items } = req.body;
    if (!items || !items.length) return res.json([]);
    const now = new Date();
    const coupons = await Coupon.find({ isActive: true })
      .or([{ expiresAt: null }, { expiresAt: { $gt: now } }])
      .sort({ createdAt: -1 })
      .limit(20);
    const out = [];
    for (const c of coupons) {
      if (c.usageLimit && c.usedCount >= c.usageLimit) continue;
      try {
        const r = await validateCoupon(c.code, items);
        out.push({
          code: r.coupon.code,
          description: r.coupon.description,
          discountType: r.coupon.discountType,
          discountValue: r.coupon.discountValue,
          minOrderAmount: r.coupon.minOrderAmount,
          discount: r.discount,
          specificProducts: (c.applicableProducts || []).length > 0,
        });
      } catch {
        // not applicable — skip silently
      }
    }
    res.json(out);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
