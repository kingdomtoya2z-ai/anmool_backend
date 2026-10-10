const mongoose = require('mongoose');

const couponSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    description: { type: String, default: '' },
    discountType: { type: String, enum: ['percent', 'flat'], required: true },
    // percent = 1..90 (% off), flat = ₹ off
    discountValue: { type: Number, required: true, min: 0 },
    // minimum cart subtotal (before discount) for the coupon to apply
    minOrderAmount: { type: Number, default: 0, min: 0 },
    // empty = applies to the whole cart; otherwise only these products count
    applicableProducts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
    isActive: { type: Boolean, default: true },
    expiresAt: { type: Date, default: null },
    usageLimit: { type: Number, default: null, min: 1 },
    usedCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Coupon', couponSchema);
