const express = require('express');
const { body, validationResult } = require('express-validator');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const generateToken = require('../utils/generateToken');
const { issueOtp, verifyOtp } = require('../utils/otp');
const { protect } = require('../middleware/auth');
const { upload, uploadToCloudinary } = require('../middleware/upload');

const router = express.Router();

// Public-safe user payload (includes saved delivery address for checkout autofill)
const publicUser = (u) => ({
  id: u._id,
  name: u.name,
  email: u.email,
  phone: u.phone,
  avatar: u.avatar || '',
  address: u.address || {},
  role: u.role,
});

// @POST /api/auth/register
router.post(
  '/register',
  [
    body('name').trim().notEmpty().withMessage('Name required'),
    body('email').trim().isEmail().withMessage('Valid email required').normalizeEmail(),
    body('phone')
      .trim()
      .matches(/^[6-9]\d{9}$/)
      .withMessage('Valid 10 digit phone required'),
    body('password').isLength({ min: 6 }).withMessage('Password min 6 chars'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { name, email, phone, password } = req.body;
    try {
      const phoneExists = await User.findOne({ phone });
      const emailUser = await User.findOne({ email: email.toLowerCase() });

      // Already verified → hard duplicate
      if (emailUser && emailUser.isVerified !== false) {
        return res.status(400).json({ message: 'Email already registered' });
      }
      if (phoneExists && (!emailUser || String(phoneExists._id) !== String(emailUser._id))) {
        return res.status(400).json({ message: 'Phone already registered' });
      }

      let user = emailUser;
      if (user) {
        // Stale unverified signup — refresh details and re-issue OTP
        user.name = name;
        user.phone = phone;
        user.password = password;
        await user.save();
      } else {
        user = await User.create({
          name,
          email: email.toLowerCase(),
          phone,
          password,
          isVerified: false,
        });
      }

      try {
        await issueOtp(user, 'register');
      } catch (e) {
        return res.status(e.status || 500).json({ message: e.message });
      }
      res.status(201).json({
        requiresOtp: true,
        email: user.email,
        message: 'Verification code sent to your email. It expires in 10 minutes.',
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

// @POST /api/auth/login
router.post(
  '/login',
  [body('email').isEmail(), body('password').notEmpty()],
  async (req, res) => {
    const { email, password } = req.body;

    // Check admin env credentials first
    if (email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASSWORD) {
      const token = generateToken({ id: 'admin', email: process.env.ADMIN_EMAIL, role: 'admin' });
      return res.json({
        token,
        user: { id: 'admin', name: 'Admin', email: process.env.ADMIN_EMAIL, role: 'admin' },
      });
    }

    try {
      const user = await User.findOne({ email: email.toLowerCase() });
      if (!user) return res.status(401).json({ message: 'Invalid credentials' });

      const isMatch = await user.comparePassword(password);
      if (!isMatch) return res.status(401).json({ message: 'Invalid credentials' });

      if (user.isVerified === false) {
        return res.status(403).json({
          message: 'Email not verified. Please verify with the code sent to your email.',
          requiresOtp: true,
          email: user.email,
        });
      }

      const token = generateToken({ id: user._id, email: user.email, role: user.role });
      res.json({
        token,
        user: publicUser(user),
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

// @POST /api/auth/verify-otp — complete registration email verification
router.post(
  '/verify-otp',
  [body('email').isEmail(), body('otp').trim().notEmpty()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      const user = await User.findOne({ email: String(req.body.email).toLowerCase() });
      if (!user) return res.status(404).json({ message: 'Account not found' });
      if (user.isVerified) {
        const token = generateToken({ id: user._id, email: user.email, role: user.role });
        return res.json({ token, user: publicUser(user), message: 'Already verified' });
      }
      try {
        await verifyOtp(user, req.body.otp, 'register');
      } catch (e) {
        return res.status(e.status || 400).json({ message: e.message });
      }
      user.isVerified = true;
      await user.save();
      const token = generateToken({ id: user._id, email: user.email, role: user.role });
      res.json({ token, user: publicUser(user), message: 'Email verified — welcome!' });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

// @POST /api/auth/resend-otp — re-send registration code (60s cooldown)
router.post('/resend-otp', [body('email').isEmail()], async (req, res) => {
  try {
    const user = await User.findOne({ email: String(req.body.email).toLowerCase() });
    if (!user) return res.status(404).json({ message: 'Account not found' });
    if (user.isVerified) return res.status(400).json({ message: 'Email already verified — please login' });
    try {
      await issueOtp(user, 'register');
    } catch (e) {
      return res.status(e.status || 500).json({ message: e.message });
    }
    res.json({ message: 'New code sent to your email. It expires in 10 minutes.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// @POST /api/auth/forgot-password — request reset OTP (generic reply, no account probing)
router.post('/forgot-password', [body('email').isEmail()], async (req, res) => {
  const done = () => res.json({ message: 'If an account exists for this email, a reset code has been sent. It expires in 10 minutes.' });
  try {
    const user = await User.findOne({ email: String(req.body.email).toLowerCase() });
    if (!user) return done();
    try {
      await issueOtp(user, 'reset');
    } catch (e) {
      if (e.status === 429) return res.status(429).json({ message: e.message });
    }
    return done();
  } catch (err) {
    return done();
  }
});

// @POST /api/auth/verify-reset-otp — exchange reset OTP for a short-lived reset token
router.post(
  '/verify-reset-otp',
  [body('email').isEmail(), body('otp').trim().notEmpty()],
  async (req, res) => {
    try {
      const user = await User.findOne({ email: String(req.body.email).toLowerCase() });
      if (!user) return res.status(404).json({ message: 'Account not found' });
      try {
        await verifyOtp(user, req.body.otp, 'reset');
      } catch (e) {
        return res.status(e.status || 400).json({ message: e.message });
      }
      const resetToken = jwt.sign({ id: user._id, purpose: 'password-reset' }, process.env.JWT_SECRET, {
        expiresIn: '15m',
      });
      res.json({ resetToken, message: 'Code verified. Set a new password within 15 minutes.' });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

// @POST /api/auth/reset-password — set new password with reset token
router.post(
  '/reset-password',
  [body('resetToken').notEmpty(), body('password').isLength({ min: 6 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      let decoded;
      try {
        decoded = jwt.verify(req.body.resetToken, process.env.JWT_SECRET);
      } catch {
        return res.status(401).json({ message: 'Reset link expired. Please request a new code.' });
      }
      if (decoded.purpose !== 'password-reset' || !decoded.id) {
        return res.status(401).json({ message: 'Invalid reset token' });
      }
      const user = await User.findById(decoded.id);
      if (!user) return res.status(404).json({ message: 'Account not found' });
      user.password = req.body.password;
      user.isVerified = true;
      await user.save();
      const token = generateToken({ id: user._id, email: user.email, role: user.role });
      res.json({ token, user: publicUser(user), message: 'Password reset successful — you are logged in' });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

// @GET /api/auth/me
router.get('/me', protect, async (req, res) => {
  if (req.user.role === 'admin') {
    return res.json({ id: 'admin', name: 'Admin', email: process.env.ADMIN_EMAIL, role: 'admin' });
  }
  res.json(req.user);
});

// @PUT /api/auth/profile — logged-in user updates name/phone/avatar
// Accepts JSON (name, phone, avatar URL) or multipart (avatarFile via Cloudinary)
router.put('/profile', protect, upload.single('avatarFile'), async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.status(403).json({ message: 'Admin profile cannot be edited here' });
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const { name, phone, avatar, address } = req.body;
    if (name !== undefined) {
      if (!String(name).trim()) return res.status(400).json({ message: 'Name cannot be empty' });
      user.name = String(name).trim();
    }
    if (phone !== undefined) {
      if (!/^[6-9]\d{9}$/.test(String(phone))) return res.status(400).json({ message: 'Valid 10 digit phone required' });
      const clash = await User.findOne({ phone: String(phone), _id: { $ne: user._id } });
      if (clash) return res.status(400).json({ message: 'Phone already registered' });
      user.phone = String(phone);
    }
    if (req.file) {
      const result = await uploadToCloudinary(req.file.buffer, { folder: 'anmool-dairy/avatars' });
      user.avatar = result.secure_url;
    } else if (avatar !== undefined) {
      user.avatar = String(avatar);
    }
    if (address !== undefined) {
      let a = address;
      if (typeof a === 'string') {
        try { a = JSON.parse(a); } catch { a = {}; }
      }
      a = a || {};
      const clean = {
        fullName: String(a.fullName || '').trim(),
        phone: String(a.phone || '').trim(),
        address: String(a.address || '').trim(),
        city: String(a.city || '').trim(),
        state: String(a.state || '').trim(),
        pincode: String(a.pincode || '').trim(),
      };
      if (clean.phone && !/^[6-9]\d{9}$/.test(clean.phone)) {
        return res.status(400).json({ message: 'Valid 10 digit phone required in address' });
      }
      if (clean.pincode && !/^\d{6}$/.test(clean.pincode)) {
        return res.status(400).json({ message: 'Valid 6-digit pincode required in address' });
      }
      user.address = clean;
    }

    await user.save();
    res.json(publicUser(user));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
