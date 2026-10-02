/**
 * Seeds demo products across the category tree (idempotent — skips existing names).
 * Images are picked RANDOMLY from frontend/public/images (numbered + DhenuVera shots).
 *
 * Usage: node scripts/seed-products.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const Category = require('../src/models/Category');
const Product = require('../src/models/Product');

const IMG_DIR = path.join(__dirname, '..', '..', 'frontend', 'public', 'images');
const img = (f) => `/images/${encodeURIComponent(f)}`;

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20260920);
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const ri = (min, max) => min + Math.floor(rng() * (max - min + 1));

const EXCLUDE = /logo|favicon|loader|apple-touch|icon-|manifest|avatar-default|Poster/i;
const pool = fs.readdirSync(IMG_DIR).filter((f) => /\.png$/i.test(f) && !EXCLUDE.test(f));
if (!pool.length) throw new Error('No usable images in public/images');
const shots = (n) => {
  const out = new Set();
  while (out.size < Math.min(n, pool.length)) out.add(img(pick(pool)));
  return [...out];
};

const FRAGS = ['Rose', 'Sandal', 'Neem Kapur Tulsi', 'Bharatvasi', 'Guggal', 'Mogra'];
const TYPE_INFO = {
  'sambrani-cup': { label: 'Sambrani Cup', pack: 'Pack of 12 cups', price: [149, 249], weight: '12 cups', blurb: 'Slow-burning Sambrani Cups for pooja, meditation and a fragrant home.' },
  'cone-dhoop': { label: 'Cone Dhoop', pack: 'Box of 20 cones', price: [99, 199], weight: '20 cones', blurb: 'Long-lasting Cone Dhoop with a rich, calming aroma.' },
  'stick-dhoop': { label: 'Stick Dhoop', pack: 'Pack of 30 sticks', price: [79, 149], weight: '30 sticks', blurb: 'Aromatic Dhoop Sticks for daily pooja and peaceful evenings.' },
};

const DAIRY = [
  { slug: 'cow-milk', name: 'Fresh Cow Milk 1 Litre', price: [65, 80], unit: '1 litre', desc: 'Farm-fresh cow milk, hygienically packed and delivered fresh every morning.' },
  { slug: 'buffalo-milk', name: 'Fresh Buffalo Milk 1 Litre', price: [75, 90], unit: '1 litre', desc: 'Thick and creamy buffalo milk from trusted local dairy farmers.' },
  { slug: 'hf-cow-ghee', name: 'HF Cow Ghee 500ml', price: [320, 420], unit: '500 ml jar', desc: 'Aromatic HF cow ghee, slow-cooked the traditional way for rich flavour.' },
  { slug: 'desi-cow-ghee', name: 'Desi Cow Ghee 500ml', price: [380, 480], unit: '500 ml jar', desc: 'Pure desi cow ghee with authentic taste, granular texture and traditional goodness.' },
  { slug: 'buffalo-ghee', name: 'Buffalo Ghee 500ml', price: [340, 440], unit: '500 ml jar', desc: 'Thick, grainy buffalo ghee that adds richness to every meal.' },
  { slug: 'butter-milk', name: 'Fresh Butter Milk 500ml', price: [35, 50], unit: '500 ml', desc: 'Refreshing traditional chaas — light, healthy and perfect for summer.' },
];

const EXTRA = [
  { slug: 'spices', name: 'Turmeric Powder 200g', price: [55, 75], unit: '200 g pack', tags: ['spice', 'haldi', 'turmeric'], desc: 'Pure ground turmeric with high curcumin, no added colour or filler.' },
  { slug: 'spices', name: 'Red Chilli Powder 200g', price: [65, 90], unit: '200 g pack', tags: ['spice', 'mirch', 'chilli'], desc: 'Bold, flavourful red chilli powder ground fresh from quality chillies.' },
  { slug: 'spices', name: 'Coriander Powder 200g', price: [50, 70], unit: '200 g pack', tags: ['spice', 'dhania', 'coriander'], desc: 'Freshly ground coriander powder with a warm, citrusy aroma.' },
  { slug: 'achaar', name: 'Mango Pickle 500g', price: [140, 180], unit: '500 g jar', tags: ['pickle', 'aam', 'mango'], desc: 'Traditional homemade-style mango pickle with mustard oil and classic spices.' },
  { slug: 'achaar', name: 'Mixed Veg Pickle 500g', price: [130, 170], unit: '500 g jar', tags: ['pickle', 'mixed', 'veg'], desc: 'Tangy mixed vegetable pickle made in small batches, just like home.' },
];

async function ensureProduct(def, categoryId, featured) {
  const exists = await Product.findOne({ name: def.name });
  if (exists) {
    console.log(`  skip (exists): ${def.name}`);
    return null;
  }
  const price = ri(def.price[0], def.price[1]);
  const p = await Product.create({
    name: def.name,
    description: def.desc,
    shortDescription: def.desc.slice(0, 90),
    price,
    comparePrice: Math.round(price * 1.25),
    category: categoryId,
    images: shots(ri(1, 3)),
    stock: ri(20, 120),
    unit: def.unit || 'piece',
    weight: def.weight || '',
    isFeatured: !!featured,
    tags: def.tags || [],
  });
  console.log(`  created: ${def.name} (₹${price})`);
  return p;
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected. Seeding products...\n');
  const cats = await Category.find();
  const bySlug = Object.fromEntries(cats.map((c) => [c.slug, c]));
  let n = 0, i = 0;

  // Fragrance leaves: 1 product each
  for (const [midSlug, info] of Object.entries(TYPE_INFO)) {
    for (const frag of FRAGS) {
      const leafSlug = `${midSlug}-${frag.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      const cat = bySlug[leafSlug];
      if (!cat) { console.log(`  !! missing category: ${leafSlug}`); continue; }
      const created = await ensureProduct(
        {
          name: `${info.label} – ${frag} (${info.pack})`,
          price: info.price,
          unit: 'pack',
          weight: info.weight,
          tags: ['dhenuvera', frag.toLowerCase(), info.label.toLowerCase()],
          desc: `${frag} fragrance ${info.label.toLowerCase()} — ${info.blurb}`,
        },
        cat._id,
        i % 4 === 0
      );
      if (created) n += 1;
      i += 1;
    }
  }

  // Dairy leaves
  for (const d of DAIRY) {
    const cat = bySlug[d.slug];
    if (!cat) { console.log(`  !! missing category: ${d.slug}`); continue; }
    const created = await ensureProduct({ ...d, tags: ['dairy', 'fresh'], weight: d.unit }, cat._id, i % 4 === 0);
    if (created) n += 1;
    i += 1;
  }

  // Spices + Achaar
  for (const e of EXTRA) {
    const cat = bySlug[e.slug];
    if (!cat) { console.log(`  !! missing category: ${e.slug}`); continue; }
    const created = await ensureProduct({ ...e, weight: e.unit }, cat._id, i % 4 === 0);
    if (created) n += 1;
    i += 1;
  }

  console.log(`\nDone. products created this run: ${n}`);
  console.log('Total products:', await Product.countDocuments());
  await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
