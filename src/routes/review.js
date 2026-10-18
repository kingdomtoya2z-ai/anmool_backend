const express = require('express');
const mongoose = require('mongoose');
const { protect, adminOnly, optionalProtect } = require('../middleware/auth');
const Review = require('../models/Review');
const Product = require('../models/Product');
const Order = require('../models/Order');
const { DEFAULT_RATING } = require('../models/Review');

const router = express.Router();

const toObjectId = (v) =>
  mongoose.Types.ObjectId.isValid(String(v || ''))
    ? new mongoose.Types.ObjectId(String(v))
    : null;

// Only customers who actually received the item may review it: the product
// has to appear in one of *their* orders that reached 'delivered'. Cancelled
// orders do not count, and an order merely shipped/confirmed is not enough —
// otherwise anyone could review before the product ever arrived.
const hasDeliveredProduct = (userId, productId) =>
  Order.exists({
    user: userId,
    'items.product': productId,
    orderStatus: 'delivered',
  }).then(Boolean);

/* ------------------------------------------------------------------ */
/* Public: approved reviews for a product + rating summary             */
/* ------------------------------------------------------------------ */
router.get('/product/:productId', optionalProtect, async (req, res) => {
  try {
    const productId = toObjectId(req.params.productId);
    if (!productId) return res.status(400).json({ message: 'Invalid product id' });

    const product = await Product.findById(productId).select('_id');
    if (!product) return res.status(404).json({ message: 'Product not found' });

    const filter = { product: productId, status: 'approved' };

    // Star histogram for the ratings breakdown bars
    const buckets = await Review.aggregate([
      { $match: filter },
      { $group: { _id: '$rating', count: { $sum: 1 } } },
    ]);
    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    buckets.forEach((b) => {
      distribution[b._id] = b.count;
    });

    const sort = req.query.sort === 'oldest' ? { createdAt: 1 } : { createdAt: -1 };
    const docs = await Review.find(filter).sort(sort).limit(100).lean();

    // Only approved reviews are ever exposed publicly.
    const reviews = docs.map((r) => ({
      id: r._id,
      name: r.authorName,
      avatar: r.authorAvatar || '',
      rating: r.rating,
      title: r.title || '',
      comment: r.comment,
      isVerifiedPurchase: r.isVerifiedPurchase,
      date: r.createdAt,
    }));

    // The signed-in viewer's own review, whatever its status, so the UI can
    // say "awaiting approval" instead of showing them the form again.
    // `canReview` is resolved here too, so the form can be hidden *before*
    // the visitor types anything rather than rejecting them after the fact.
    let myReview = null;
    let canReview = false;
    if (req.user && req.user._id) {
      const [mine, delivered] = await Promise.all([
        Review.findOne({ product: productId, user: req.user._id }).lean(),
        hasDeliveredProduct(req.user._id, productId),
      ]);
      if (mine) {
        myReview = {
          id: mine._id,
          rating: mine.rating,
          title: mine.title || '',
          comment: mine.comment,
          status: mine.status,
          date: mine.createdAt,
        };
      }
      canReview = delivered && !mine;
    }

    const total = Object.values(distribution).reduce((a, b) => a + b, 0);
    const starSum = [1, 2, 3, 4, 5].reduce((s, star) => s + star * distribution[star], 0);

    res.json({
      reviews,
      summary: {
        average: total ? Number((starSum / total).toFixed(1)) : DEFAULT_RATING,
        count: total,
        distribution,
      },
      myReview,
      canReview,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Logged-in customer: submit a review                                */
/* ------------------------------------------------------------------ */
router.post('/', protect, async (req, res) => {
  try {
    // The admin signs in from env vars and has no user document, so it cannot
    // own a review (the unique user+product index needs a real user id).
    if (req.user.role === 'admin') {
      return res.status(403).json({ message: 'Admin accounts cannot post product reviews' });
    }

    const { product: productId, rating, title, comment } = req.body || {};

    const stars = Number(rating);
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
      return res.status(400).json({ message: 'Please choose a rating between 1 and 5 stars' });
    }
    const text = String(comment ?? '').trim();
    if (text.length < 3) return res.status(400).json({ message: 'Please write a few words about the product' });
    if (text.length > 2000) return res.status(400).json({ message: 'Review is too long (2000 characters max)' });
    const heading = String(title ?? '').trim().slice(0, 120);

    const pid = toObjectId(productId);
    if (!pid) return res.status(400).json({ message: 'Invalid product id' });

    const product = await Product.findOne({ _id: pid, isActive: true }).select('_id');
    if (!product) return res.status(404).json({ message: 'Product not found' });

    // Friendly pre-check; the unique index below is the real guarantee.
    const existing = await Review.findOne({ product: product._id, user: req.user._id }).select('_id');
    if (existing) {
      return res.status(409).json({ message: 'You have already reviewed this product' });
    }

    // Only customers who have received this product may review it.
    const delivered = await hasDeliveredProduct(req.user._id, product._id);
    if (!delivered) {
      return res.status(403).json({
        message: 'You can review this product once it has been delivered in one of your orders',
      });
    }

    const review = await Review.create({
      product: product._id,
      user: req.user._id,
      authorName: req.user.name || 'Customer',
      authorAvatar: req.user.avatar || '',
      rating: stars,
      title: heading,
      comment: text,
      status: 'pending',
      // Guaranteed true now that the gate above passed.
      isVerifiedPurchase: true,
    });

    // A new review is pending, so the published rating is untouched — but if
    // this is somehow the first approved one, keep things consistent anyway.
    await Review.syncProductRating(product._id);

    res.status(201).json({
      id: review._id,
      rating: review.rating,
      title: review.title,
      comment: review.comment,
      status: review.status,
      date: review.createdAt,
    });
  } catch (err) {
    // Lost the race against a simultaneous duplicate submission.
    if (err && err.code === 11000) {
      return res.status(409).json({ message: 'You have already reviewed this product' });
    }
    if (err && err.name === 'ValidationError') {
      return res.status(400).json({ message: err.message });
    }
    res.status(500).json({ message: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Admin: moderation queue                                             */
/* ------------------------------------------------------------------ */
router.get('/admin/all', protect, adminOnly, async (req, res) => {
  try {
    const { status } = req.query;
    const filter = {};
    if (['pending', 'approved', 'rejected'].includes(status)) filter.status = status;

    const reviews = await Review.find(filter)
      .populate('product', 'name slug images')
      .populate('user', 'name email avatar')
      .sort({ createdAt: -1 })
      .limit(300)
      .lean();

    const counts = await Review.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
    const summary = { pending: 0, approved: 0, rejected: 0 };
    counts.forEach((c) => {
      summary[c._id] = c.count;
    });

    res.json({ reviews, summary });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.patch('/:id/status', protect, adminOnly, async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!['pending', 'approved', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'Invalid review status' });
    }
    const review = await Review.findByIdAndUpdate(
      req.params.id,
      { status, moderatedAt: new Date() },
      { new: true }
    );
    if (!review) return res.status(404).json({ message: 'Review not found' });

    // Publishing or hiding a review changes the product's published rating.
    const stats = await Review.syncProductRating(review.product);
    res.json({ review, stats });
  } catch (err) {
    if (err && err.name === 'CastError') return res.status(400).json({ message: 'Invalid review id' });
    res.status(500).json({ message: err.message });
  }
});

router.delete('/:id', protect, adminOnly, async (req, res) => {
  try {
    const review = await Review.findByIdAndDelete(req.params.id);
    if (!review) return res.status(404).json({ message: 'Review not found' });
    const stats = await Review.syncProductRating(review.product);
    res.json({ message: 'Review deleted', stats });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;