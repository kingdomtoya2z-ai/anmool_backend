require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');
require('./config/cloudinary'); // init Cloudinary

const authRoutes = require('./routes/auth');
const categoryRoutes = require('./routes/category');
const productRoutes = require('./routes/product');
const orderRoutes = require('./routes/order');
const adminRoutes = require('./routes/admin');
const uploadRoutes = require('./routes/upload');
const bannerRoutes = require('./routes/banner');

const app = express();

// Middleware
// CORS: production frontend(s) from env (comma-separated supported) +
// local dev origins (only outside production). Nodemon does NOT restart on
// .env changes, so restart the backend after editing FRONTEND_URL.
const envOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const devOrigins =
  process.env.NODE_ENV === 'production'
    ? []
    : [
        'http://localhost:3000',
        'http://localhost:3001',
        'http://127.0.0.1:3000',
        'http://127.0.0.1:3001',
      ];
const allowedOrigins = new Set([...(envOrigins.length ? envOrigins : ['http://localhost:3000']), ...devOrigins]);
// Native-app (Capacitor APK) origins. The Android WebView serves the app from
// https://localhost, so the backend must allow it or every API call from the
// installed app is blocked by CORS and the app shows no products. These are
// loopback-only origins (can only come from the user's own device), safe to
// allow in every environment including production.
for (const o of ['https://localhost', 'http://localhost', 'capacitor://localhost']) allowedOrigins.add(o);
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.has(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
  })
);
console.log('CORS allowed origins:', [...allowedOrigins].join(', '));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve uploads static
app.use('/uploads', express.static('uploads'));

// Routes
app.get('/', (req, res) => {
  res.json({
    message: 'Anmool Dairy API - Pure Products. Honest Promise.',
    version: '1.0.0',
    email: 'Resend',
    imageUpload: 'Cloudinary',
    endpoints: ['/api/auth', '/api/categories', '/api/products', '/api/orders', '/api/admin', '/api/upload', '/api/banners'],
  });
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', db: 'connected' }));

app.use('/api/auth', authRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/products', productRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/banners', bannerRoutes);

// Universal search: token-based matching across product fields AND the
// full category tree (a matching parent also returns products in all its
// descendants, e.g. "puja" finds everything under Puja & Rituals).
app.get('/api/search', async (req, res) => {
  const q = req.query.q || req.query.query || '';
  if (!q.trim()) return res.json({ products: [], categories: [], total: 0 });
  try {
    const Product = require('./models/Product');
    const Category = require('./models/Category');
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tokens = q.trim().split(/\s+/).filter(Boolean).map(esc);
    if (!tokens.length) return res.json({ products: [], categories: [], total: 0 });

    // 1) Categories matching ANY token (name or description)
    const catOr = [];
    tokens.forEach((t) => {
      const rx = new RegExp(t, 'i');
      catOr.push({ name: rx }, { description: rx });
    });
    const matchingCategories = await Category.find({ $or: catOr }).select('_id name slug parent');

    // 2) Expand matched categories to all descendants
    const allCats = await Category.find().select('_id parent');
    const expanded = new Set(matchingCategories.map((c) => String(c._id)));
    let grew = true;
    while (grew) {
      grew = false;
      for (const c of allCats) {
        const pid = String(c.parent || '');
        if (expanded.has(pid) && !expanded.has(String(c._id))) {
          expanded.add(String(c._id));
          grew = true;
        }
      }
    }

    // 3) Products: EVERY token must hit at least one text field,
    //    OR the product sits in a matching category subtree
    const textFields = ['name', 'description', 'shortDescription', 'tags', 'sku', 'weight', 'unit'];
    const andConds = tokens.map((t) => {
      const rx = new RegExp(t, 'i');
      return { $or: textFields.map((f) => ({ [f]: rx })) };
    });
    const orBranches = [];
    if (andConds.length) orBranches.push(andConds.length === 1 ? andConds[0] : { $and: andConds });
    if (expanded.size) orBranches.push({ category: { $in: [...expanded] } });

    const products = await Product.find({ isActive: true, $or: orBranches })
      .populate('category', 'name slug')
      .limit(100)
      .sort({ createdAt: -1 });
    res.json({ products, categories: matchingCategories, total: products.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// 404
app.use((req, res) => res.status(404).json({ message: 'Route not found' }));

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: err.message || 'Server error' });
});

const PORT = process.env.PORT || 5000;

connectDB().then(() => {
  app.listen(PORT, () => console.log(`Anmool Dairy Backend running on http://localhost:${PORT}`));
});
