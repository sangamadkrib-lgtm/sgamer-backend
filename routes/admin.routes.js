const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin, signToken } = require('../middleware/auth');
const User = require('../models/User');
const bcrypt = require('bcryptjs');
const {
  listRedemptions,
  processRedemption,
  banUser,
  unbanUser,
  listFlaggedUsers,
} = require('../controllers/adminController');

// Admin login is a distinct endpoint from user login. It reuses the same
// User collection but enforces role: 'ADMIN' so a normal user JWT can never
// pass requireAdmin even if role were somehow spoofed client-side.
router.post('/login', async (req, res) => {
  const { phone, password } = req.body;
  const user = await User.findOne({ phone, role: 'ADMIN' });
  if (!user) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });

  const token = signToken(user);
  res.json({ token, admin: { id: user._id, name: user.name } });
});

// Everything below requires a valid ADMIN-role JWT
router.use(requireAuth, requireAdmin);

router.get('/redemptions', listRedemptions);
router.post('/redemption/process', processRedemption);
router.post('/user/ban', banUser);
router.post('/user/unban', unbanUser);
router.get('/users/flagged', listFlaggedUsers);

module.exports = router;
