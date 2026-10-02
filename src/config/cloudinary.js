const cloudinary = require('cloudinary').v2;

const isDummy = (v) => !v || v.includes('dummy') || v.includes('your_') || v.includes('placeholder');
const hasCloudinary = !!(
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET &&
  !isDummy(process.env.CLOUDINARY_CLOUD_NAME) &&
  !isDummy(process.env.CLOUDINARY_API_KEY) &&
  !isDummy(process.env.CLOUDINARY_API_SECRET)
);

if (hasCloudinary) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
  console.log('☁️  Cloudinary configured:', process.env.CLOUDINARY_CLOUD_NAME);
} else {
  console.log('⚠️  Cloudinary NOT configured (or dummy) — image uploads will be simulated/logged. Set real CLOUDINARY_* in .env');
}

module.exports = { cloudinary, hasCloudinary };
