const express = require('express');
const User = require('../models/User');
const Product = require('../models/Product');
const Category = require('../models/Category');
const Order = require('../models/Order');
const { protect, adminOnly } = require('../middleware/auth');

const router = express.Router();

// Admin stats
router.get('/stats', protect, adminOnly, async (req, res) => {
  try {
    const [users, products, categories, orders, revenueAgg, statusAgg] = await Promise.all([
      User.countDocuments(),
      Product.countDocuments(),
      Category.countDocuments(),
      Order.countDocuments(),
      Order.aggregate([{ $match: { paymentStatus: 'paid' } }, { $group: { _id: null, total: { $sum: '$total' } } }]),
      Order.aggregate([{ $group: { _id: '$orderStatus', count: { $sum: 1 } } }]),
    ]);
    const totalRevenue = revenueAgg[0]?.total || 0;
    const orderStatusCounts = {};
    statusAgg.forEach((s) => (orderStatusCounts[s._id] = s.count));
    const recentOrders = await Order.find().populate('user', 'name email').sort({ createdAt: -1 }).limit(5);
    res.json({ users, products, categories, orders, totalRevenue, orderStatusCounts, recentOrders });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: list users
router.get('/users', protect, adminOnly, async (req, res) => {
  try {
    const users = await User.find().select('-password').sort({ createdAt: -1 });
    res.json(users);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
