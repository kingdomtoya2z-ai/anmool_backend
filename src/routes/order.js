const express = require('express');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const { nextOrderNumber } = require('../models/Order');
const Product = require('../models/Product');
const { protect, adminOnly } = require('../middleware/auth');
const sendEmail = require('../utils/sendEmail');

const router = express.Router();

// helper: calculate shipping
const SHIPPING_THRESHOLD = 300;
const SHIPPING_CHARGE = 100;
function calcShipping(subtotal) {
  return subtotal < SHIPPING_THRESHOLD ? SHIPPING_CHARGE : 0;
}

// @POST /api/orders  - user creates order after successful payment
router.post('/', protect, async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.status(403).json({ message: 'Admin cannot place orders' });

    const { items, shippingAddress, paymentMethod = 'online', paymentId = '' } = req.body;
    if (!items || !items.length) return res.status(400).json({ message: 'No items' });
    if (!shippingAddress) return res.status(400).json({ message: 'Shipping address required' });

    let subtotal = 0;
    const populatedItems = [];
    for (const it of items) {
      const product = await Product.findById(it.product);
      if (!product) return res.status(404).json({ message: `Product not found: ${it.product}` });
      if (product.stock < it.quantity) return res.status(400).json({ message: `Insufficient stock for ${product.name}` });
      const price = product.price;
      subtotal += price * it.quantity;
      populatedItems.push({
        product: product._id,
        name: product.name,
        image: product.images?.[0] || '',
        price,
        quantity: it.quantity,
      });
    }

    const shippingCharge = calcShipping(subtotal);
    const total = subtotal + shippingCharge;

    const initialStatus = paymentMethod === 'cod' ? 'pending' : 'confirmed';
    const orderNumber = await nextOrderNumber();
    const order = await Order.create({
      orderNumber,
      user: req.user._id,
      items: populatedItems,
      shippingAddress,
      subtotal,
      shippingCharge,
      total,
      paymentMethod,
      paymentStatus: paymentMethod === 'cod' ? 'pending' : 'paid',
      paymentId,
      orderStatus: initialStatus,
      statusHistory: [
        {
          status: initialStatus,
          timestamp: new Date(),
          note: paymentMethod === 'cod' ? 'Order placed (Cash on Delivery)' : 'Payment successful — order confirmed',
        },
      ],
    });

    // reduce stock
    for (const it of populatedItems) {
      await Product.findByIdAndUpdate(it.product, { $inc: { stock: -it.quantity } });
    }

    // Notify admin via email
    const adminEmail = process.env.ADMIN_NOTIFY_EMAIL || process.env.ADMIN_EMAIL;
    const orderHtml = `
      <h2>New Order Received - Anmool</h2>
      <p><strong>Order ID:</strong> ${order.orderNumber}</p>
      <p><strong>Customer:</strong> ${req.user.name} (${req.user.email}, ${req.user.phone})</p>
      <p><strong>Shipping:</strong> ${shippingAddress.fullName}, ${shippingAddress.address}, ${shippingAddress.city}, ${shippingAddress.state} - ${shippingAddress.pincode}, Phone: ${shippingAddress.phone}</p>
      <p><strong>Items:</strong></p>
      <ul>
        ${populatedItems.map((i) => `<li>${i.name} x ${i.quantity} = ₹${i.price * i.quantity}</li>`).join('')}
      </ul>
      <p><strong>Subtotal:</strong> ₹${subtotal}</p>
      <p><strong>Shipping:</strong> ₹${shippingCharge} ${shippingCharge ? '(Applied - order < ₹300)' : '(Free shipping)'}</p>
      <p><strong>Total Paid:</strong> ₹${total}</p>
      <p><strong>Payment:</strong> ${paymentMethod} - ${order.paymentId || 'N/A'}</p>
    `;
    await sendEmail({
      to: adminEmail,
      subject: `🛒 New Order #${order.orderNumber} - ₹${total} - Anmool`,
      html: orderHtml,
      text: `New order ${order.orderNumber} total ₹${total} from ${req.user.email}`,
    });

    // Also email customer confirmation (if configured)
    await sendEmail({
      to: req.user.email,
      subject: `Your Anmool Order #${order.orderNumber} ${paymentMethod === 'cod' ? 'Placed' : 'Confirmed'}!`,
      html: `<h2>Thank you for shopping with Anmool!</h2><p>Your order ${order.orderNumber} ${paymentMethod === 'cod' ? 'has been placed and will be confirmed after our team calls you.' : 'has been confirmed and is being processed.'}</p><p><a href="${process.env.FRONTEND_URL}/track-order?order=${order.orderNumber}">Track your order</a></p>${orderHtml}`,
      text: `Your order ${order.orderNumber} total ₹${total}. Track at /track-order`,
    });

    const populated = await order.populate('user', 'name email phone');
    res.status(201).json(populated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});

// Public: track an order by its order number (ANM-xxxxxx) without login
// Also accepts the raw mongo _id for backwards compatibility.
router.get('/track/:number', async (req, res) => {
  try {
    const number = (req.params.number || '').trim().toUpperCase();
    if (!number) return res.status(400).json({ message: 'Order ID required' });

    let order = await Order.findOne({ orderNumber: number });
    if (!order && mongoose.Types.ObjectId.isValid(number)) {
      order = await Order.findById(number);
    }
    if (!order) return res.status(404).json({ message: 'Order not found. Please check the Order ID.' });

    // Public-safe projection (no payment ID / user contact)
    res.json({
      _id: order._id,
      orderNumber: order.orderNumber,
      items: order.items,
      subtotal: order.subtotal,
      shippingCharge: order.shippingCharge,
      total: order.total,
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus,
      orderStatus: order.orderStatus,
      statusHistory: order.statusHistory,
      shippingAddress: {
        fullName: order.shippingAddress.fullName,
        city: order.shippingAddress.city,
        state: order.shippingAddress.state,
        pincode: order.shippingAddress.pincode,
      },
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get my orders
router.get('/my', protect, async (req, res) => {
  try {
    const orders = await Order.find({ user: req.user._id }).populate('items.product', 'name slug images').sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get single order (user can only see own, admin can see any)
router.get('/:id', protect, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).populate('user', 'name email phone').populate('items.product', 'name slug');
    if (!order) return res.status(404).json({ message: 'Order not found' });
    if (req.user.role !== 'admin' && order.user._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized' });
    }
    res.json(order);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: get all orders with filtering & search (incl. date-wise via ?from=YYYY-MM-DD&to=YYYY-MM-DD)
router.get('/', protect, adminOnly, async (req, res) => {
  try {
    const { status, payment, search, limit = 100, from, to } = req.query;
    const filter = {};

    if (status && status !== 'all') filter.orderStatus = status;
    if (payment && payment !== 'all') filter.paymentStatus = payment;
    if (from || to) {
      // Interpret calendar dates in IST (Asia/Kolkata) regardless of server timezone
      filter.createdAt = {};
      if (from) {
        const d = new Date(`${from}T00:00:00+05:30`);
        if (!isNaN(d)) filter.createdAt.$gte = d;
      }
      if (to) {
        const d = new Date(`${to}T23:59:59.999+05:30`);
        if (!isNaN(d)) filter.createdAt.$lte = d;
      }
    }
    if (search) {
      const s = search.trim();
      const or = [{ orderNumber: new RegExp(s, 'i') }, { 'shippingAddress.phone': new RegExp(s, 'i') }, { 'shippingAddress.fullName': new RegExp(s, 'i') }, { 'shippingAddress.city': new RegExp(s, 'i') }];
      if (mongoose.Types.ObjectId.isValid(s)) or.push({ _id: s });
      filter.$or = or;
    }

    const orders = await Order.find(filter)
      .populate('user', 'name email phone')
      .sort({ createdAt: -1 })
      .limit(Number(limit));
    res.json(orders);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: update order status (and optionally payment status)
router.put('/:id/status', protect, adminOnly, async (req, res) => {
  try {
    const { orderStatus, paymentStatus, note } = req.body;
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });

    const VALID_STATUSES = ['pending', 'confirmed', 'shipped', 'out-for-delivery', 'delivered', 'cancelled'];
    if (orderStatus && !VALID_STATUSES.includes(orderStatus)) {
      return res.status(400).json({ message: 'Invalid order status' });
    }
    if (paymentStatus && !['pending', 'paid', 'failed'].includes(paymentStatus)) {
      return res.status(400).json({ message: 'Invalid payment status' });
    }

    const previousStatus = order.orderStatus;
    const previousPayment = order.paymentStatus;
    if (orderStatus && previousStatus !== orderStatus) {
      order.orderStatus = orderStatus;
      order.statusHistory.push({
        status: orderStatus,
        timestamp: new Date(),
        note: note || '',
      });
    }
    if (paymentStatus) order.paymentStatus = paymentStatus;

    await order.save();
    const updated = await order.populate('user', 'name email phone');

    // Notify customer by email (Resend) on ANY order-state update
    const statusChanged = orderStatus && previousStatus !== orderStatus;
    const paymentChanged = paymentStatus && previousPayment !== paymentStatus;
    if ((statusChanged || paymentChanged) && updated.user?.email) {
      const pretty = (s) => String(s || '').replace(/-/g, ' ');
      const lines = [];
      if (statusChanged) lines.push(`Order status: <b>${pretty(previousStatus)} → ${pretty(orderStatus)}</b>`);
      if (paymentChanged) lines.push(`Payment status: <b>${pretty(previousPayment)} → ${pretty(paymentStatus)}</b>`);
      if (note) lines.push(`Note from our team: ${note}`);
      sendEmail({
        to: updated.user.email,
        subject: `Anmool Order #${order.orderNumber} update — ${pretty(orderStatus)}`,
        html: `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;border:1px solid #e5e7eb;border-radius:16px;overflow:hidden">
          <div style="background:#142808;color:#fff;padding:22px;text-align:center">
            <div style="font-size:20px;font-weight:bold">Anmool Dairy</div>
            <div style="font-size:12px;color:#FFC53D;margin-top:4px">Order update</div>
          </div>
          <div style="padding:24px">
            <h2 style="margin:0 0 8px;color:#142808">Namaste${updated.user?.name ? `, ${updated.user.name}` : ''} — your order moved</h2>
            <p style="color:#57534e;font-size:14px">Order <b>#${order.orderNumber}</b> (₹${order.total})</p>
            <div style="background:#F0F7E6;border:1px solid #DDEDC7;border-radius:12px;padding:14px 16px;margin:14px 0;font-size:14px;color:#142808">
              ${lines.join('<br>')}
            </div>
            <p style="font-size:14px"><a href="${process.env.FRONTEND_URL}/track-order?order=${order.orderNumber}">Track your order live</a></p>
            <p style="color:#78716c;font-size:12px">Questions? Reply to this email or contact us from the website.</p>
          </div>
        </div>`,
        text: `Order ${order.orderNumber}: ${statusChanged ? `status ${previousStatus} -> ${orderStatus}. ` : ''}${paymentChanged ? `payment ${previousPayment} -> ${paymentStatus}. ` : ''}${note || ''} Track at /track-order`,
      }).catch(() => {});
    }

    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Dummy payment simulation endpoint - returns success
router.post('/payment/simulate', protect, async (req, res) => {
  // simulate payment gateway success
  const paymentId = 'PAY_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6).toUpperCase();
  res.json({ success: true, paymentId, message: 'Payment simulated successfully' });
});

module.exports = router;