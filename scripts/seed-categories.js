/**
 * Seeds the full catalogue category tree (idempotent — skips existing names).
 *
 *   Puja & Rituals > Sambrani Cup / Cone Dhoop / Stick Dhoop > 6 fragrances
 *   Dairy Product > Cow/Buffalo Milk, Ghee range, Butter Milk
 *   Spices, Achaar
 *
 * Images come from frontend/public/images: exact DhenuVera product shots
 * where they match, otherwise a deterministic pick from the numbered shots.
 *
 * Usage: node scripts/seed-categories.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const slugify = require('slugify');
const fs = require('fs');
const path = require('path');
const Category = require('../src/models/Category');

const IMG_DIR = path.join(__dirname, '..', '..', 'frontend', 'public', 'images');
const img = (f) => `/images/${encodeURIComponent(f)}`;

// Deterministic PRNG so re-runs / reviews are stable
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20260919);
const pick = (arr) => arr[Math.floor(rng() * arr.length)];

const numbered = fs.readdirSync(IMG_DIR).filter((f) => /^\d+\.png$/.test(f));
if (!numbered.length) throw new Error('No numbered images found in public/images');

const FRAG_FILE = {
  Rose: 'Rose',
  Sandal: 'Sandal',
  'Neem Kapur Tulsi': 'NKT',
  Bharatvasi: 'Bharatvasi',
  Guggal: 'Guggal',
  Mogra: 'Mogra',
};
const FRAGS = Object.keys(FRAG_FILE);

function dhenuShot(midName, frag) {
  const f = `DhenuVera_${midName} ${FRAG_FILE[frag]} 1.png`;
  return fs.existsSync(path.join(IMG_DIR, f)) ? img(f) : img(pick(numbered));
}

const DAIRY_DESC = {
  'Cow Milk': 'Fresh cow milk from trusted local dairy farmers — purity you can taste.',
  'Buffalo Milk': 'Rich and creamy buffalo milk, collected fresh every morning.',
  'HF Cow Ghee': 'Aromatic HF cow ghee, slow-cooked the traditional way.',
  'Desi Cow Ghee': 'Pure desi cow ghee with authentic taste and traditional goodness.',
  'Buffalo Ghee': 'Thick, grainy buffalo ghee for rich flavour in every meal.',
  'Butter Milk': 'Refreshing traditional butter milk (chaas), light and healthy.',
};

const TREE = [
  {
    name: 'Puja & Rituals',
    desc: 'Sacred essentials for pooja, havan and daily rituals — Sambrani Cups, Cone Dhoop and Dhoop Sticks.',
    children: [
      { name: 'Sambrani Cup', desc: 'Traditional Sambrani Cups in 6 divine fragrances for pooja and meditation.', leaves: FRAGS },
      { name: 'Cone Dhoop', desc: 'Slow-burning Cone Dhoop in 6 fragrances for home fragrance and rituals.', leaves: FRAGS },
      { name: 'Stick Dhoop', desc: 'Aromatic Dhoop Sticks in 6 fragrances for daily pooja and calm.', leaves: FRAGS },
    ],
  },
  {
    name: 'Dairy Product',
    desc: 'Farm-fresh dairy — milk, ghee and butter milk sourced with care.',
    children: Object.keys(DAIRY_DESC).map((n) => ({ name: n, desc: DAIRY_DESC[n], leaves: [] })),
  },
  { name: 'Spices', desc: 'Everyday spices, ground fresh and packed hygienically.', children: [] },
  { name: 'Achaar', desc: 'Traditional homemade-style pickles with authentic taste.', children: [] },
];

async function ensureCategory(name, desc, image, parentId, slug) {
  const q = { name };
  q.parent = parentId || null;
  let doc = await Category.findOne(q);
  if (doc) {
    console.log(`  skip (exists): ${name}`);
    return doc;
  }
  doc = await Category.create({ name, description: desc, image, parent: parentId || null });
  await Category.findByIdAndUpdate(doc._id, { slug });
  console.log(`  created: ${name} -> /${slug} [${image}]`);
  return Category.findById(doc._id);
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected. Seeding category tree...\n');
  let counts = { parents: 0, mids: 0, leaves: 0 };

  for (const top of TREE) {
    const topSlug = slugify(top.name, { lower: true, strict: true });
    const parent = await ensureCategory(top.name, top.desc, img(pick(numbered)), null, topSlug);
    counts.parents += 1;

    for (const mid of top.children || []) {
      const midSlug = slugify(mid.name, { lower: true, strict: true });
      const midDoc = await ensureCategory(mid.name, mid.desc, img(pick(numbered)), parent._id, midSlug);
      counts.mids += 1;

      for (const leaf of mid.leaves || []) {
        const leafSlug = `${midSlug}-${slugify(leaf, { lower: true, strict: true })}`;
        const leafDesc = `${leaf} fragrance ${mid.name.toLowerCase()} for pooja, meditation and home fragrance.`;
        const leafImg = dhenuShot(mid.name, leaf);
        await ensureCategory(leaf, leafDesc, leafImg, midDoc._id, leafSlug);
        counts.leaves += 1;
      }
    }
  }

  console.log(`\nDone. parents=${counts.parents} mids=${counts.mids} leaves=${counts.leaves}`);
  console.log('Total categories:', await Category.countDocuments());
  await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
