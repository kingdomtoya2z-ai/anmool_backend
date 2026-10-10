const Coupon = require('../models/Coupon');
const Product = require('../models/Product');

/**
 * Validate a coupon against a cart and compute the discount — server side.
 * @param {string} code raw coupon code
 * @param {Array<{product, quantity}>} items cart items (product = id)
 * @returns {Promise<{coupon, subtotal, base, discount}>} throws status-coded Error
 */
async function validateCoupon(code, items) {
  const clean = String(code || '').trim().toUpperCase();
  if (!clean) {
    const err = new Error('Enter a coupon code');
    err.status = 400;
    throw err;
  }
  const coupon = await Coupon.findOne({ code: clean });
  if (!coupon) {
    const err = new Error('Invalid coupon code');
    err.status = 400;
    throw err;
  }
  if (!coupon.isActive) {
    const err = new Error('This coupon is no longer active');
    err.status = 400;
    throw err;
  }
  if (coupon.expiresAt && new Date() > coupon.expiresAt) {
    const err = new Error('This coupon has expired');
    err.status = 400;
    throw err;
  }
  if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) {
    const err = new Error('This coupon has been fully used');
    err.status = 400;
    throw err;
  }
  if (!items || !items.length) {
    const err = new Error('Your cart is empty');
    err.status = 400;
    throw err;
  }

  // Server-side cart valuation from live prices
  let subtotal = 0;
  let base = 0; // amount the discount applies to
  const onlyIds = (coupon.applicableProducts || []).map(String);
  for (const it of items) {
    const product = await Product.findById(it.product);
    if (!product) {
      const err = new Error('A product in your cart no longer exists');
      err.status = 400;
      throw err;
    }
    const line = product.price * it.quantity;
    subtotal += line;
    if (!onlyIds.length || onlyIds.includes(String(product._id))) base += line;
  }

  if (subtotal < (coupon.minOrderAmount || 0)) {
    const err = new Error(`Needs minimum order of ₹${coupon.minOrderAmount} (your cart: ₹${subtotal})`);
    err.status = 400;
    throw err;
  }
  if (onlyIds.length && base <= 0) {
    const err = new Error('This coupon does not apply to any product in your cart');
    err.status = 400;
    throw err;
  }

  let discount = 0;
  if (coupon.discountType === 'percent') {
    discount = Math.round((base * Math.min(coupon.discountValue, 90)) / 100);
  } else {
    discount = Math.min(Math.round(coupon.discountValue), base);
  }
  if (discount <= 0) {
    const err = new Error('This coupon gives no discount on your cart');
    err.status = 400;
    throw err;
  }
  return { coupon, subtotal, base, discount };
}

module.exports = { validateCoupon };
