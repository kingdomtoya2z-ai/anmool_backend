const jwt = require('jsonwebtoken');
const User = require('../models/User');

const protect = async (req, res, next) => {
  let token;
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }
  if (!token) {
    return res.status(401).json({ message: 'Not authorized, no token' });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // decoded contains id, email, role — reject single-purpose tokens (e.g. password-reset)
    if (decoded.purpose && decoded.purpose !== 'auth') {
      return res.status(401).json({ message: 'Not authorized, token failed' });
    }
    if (decoded.role === 'admin') {
      // admin from env - not in DB
      req.user = { id: 'admin', email: decoded.email, role: 'admin', name: 'Admin' };
      return next();
    }
    const user = await User.findById(decoded.id).select('-password');
    if (!user) return res.status(401).json({ message: 'User not found' });
    req.user = user;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Token expired, please login again' });
    }
    return res.status(401).json({ message: 'Not authorized, token failed' });
  }
};

const adminOnly = (req, res, next) => {
  if (req.user && req.user.role === 'admin') return next();
  return res.status(403).json({ message: 'Admin access required' });
};

// Attaches req.user when a valid token is present, but never rejects. Lets a
// public endpoint (e.g. the product review list) additionally personalise its
// response for a signed-in visitor without forcing everyone to log in.
const optionalProtect = async (req, res, next) => {
  let token;
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }
  if (!token) return next();
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role === 'admin') {
      req.user = { id: 'admin', email: decoded.email, role: 'admin', name: 'Admin' };
      return next();
    }
    const user = await User.findById(decoded.id).select('-password');
    if (user) req.user = user;
  } catch {
    // ignore — the request simply stays anonymous
  }
  return next();
};

module.exports = { protect, adminOnly, optionalProtect };
