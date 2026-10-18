const mongoose = require('mongoose');
const Product = require('../models/Product');

// Rating a product falls back to when it has no approved reviews yet.
// Matches the default in the Product schema so the storefront never shows 0.
const DEFAULT_RATING = 4.5;

const reviewSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // Snapshot of the name at review time, so renaming the profile later does
    // not rewrite (or silently orphan) the words already published.
    authorName: { type: String, required: true, trim: true, maxlength: 80 },
    authorAvatar: { type: String, default: '' },
    rating: { type: Number, required: true, min: 1, max: 5 },
    title: { type: String, default: '', trim: true, maxlength: 120 },
    comment: { type: String, required: true, trim: true, minlength: 3, maxlength: 2000 },
    // A review is private until an admin approves it.
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
      index: true,
    },
    isVerifiedPurchase: { type: Boolean, default: false },
    moderatedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// The "one review per user per product" rule is enforced here rather than only
// in the route handler: two simultaneous submissions (double tap, two tabs,
// two devices) would both pass a findOne() check, but only one can satisfy
// this index. The route translates the duplicate-key error into a 409.
reviewSchema.index({ product: 1, user: 1 }, { unique: true });

// Serves the public listing: approved reviews for one product, newest first.
reviewSchema.index({ product: 1, status: 1, createdAt: -1 });

/**
 * Recompute a product's rating/reviewsCount from its APPROVED reviews only.
 * Called after every approve / reject / delete so the number on the product
 * card can never disagree with the reviews actually published.
 */
reviewSchema.statics.syncProductRating = async function (productId) {
  const id = productId?._id || productId;
  const rows = await this.aggregate([
    { $match: { product: new mongoose.Types.ObjectId(String(id)), status: 'approved' } },
    { $group: { _id: null, average: { $avg: '$rating' }, count: { $sum: 1 } } },
  ]);

  const row = rows[0];
  const stats = row && row.count
    ? {
        rating: Math.round((row.average + Number.EPSILON) * 10) / 10,
        reviewsCount: row.count,
      }
    : { rating: DEFAULT_RATING, reviewsCount: 0 };

  await Product.updateOne({ _id: id }, stats);
  return stats;
};

module.exports = mongoose.model('Review', reviewSchema);
module.exports.DEFAULT_RATING = DEFAULT_RATING;