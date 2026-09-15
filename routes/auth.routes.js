const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const User = require('../models/User');
const { signToken } = require('../middleware/auth');
const blacklistGate = require('../middleware/blacklistGate');
const { checkMultiAccount } = require('../utils/fraudDetection');

function generateReferralCode() {
  return 'REF' + crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 6);
}

router.post('/register', blacklistGate, async (req, res) => {
  const { name, phone, password, deviceId, referralCode } = req.body;
  if (!name || !phone || !password || !deviceId) {
    return res.status(400).json({ error: 'MISSING_FIELDS' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  let referredBy = null;
  if (referralCode) {
    const referrer = await User.findOne({ referralCode });
    if (referrer) referredBy = referrer._id;
  }

  let code;
  do {
    code = generateReferralCode();
  } while (await User.exists({ referralCode: code }));

  const user = await User.create({
    name,
    phone,
    passwordHash,
    deviceId,
    signupIp: req.ip,
    lastLoginDeviceId: deviceId,
    lastLoginIp: req.ip,
    referralCode: code,
    referredBy,
  });

  // fire-and-forget fraud check — never blocks signup, just flags for review
  checkMultiAccount(user).catch((e) => console.error('fraud check failed', e));

  const token = signToken(user);
  res.status(201).json({ token, user: { id: user._id, name: user.name, referralCode: user.referralCode } });
});

router.post('/login', blacklistGate, async (req, res) => {
  const { phone, password, deviceId } = req.body;
  const user = await User.findOne({ phone });
  if (!user) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'INVALID_CREDENTIALS' });

  // Ban gate happens even before token issuance so a banned user never gets a
  // fresh session — the app shows the suspension message immediately.
  if (user.isBanned) {
    return res.status(403).json({
      error: 'ACCOUNT_SUSPENDED',
      message: 'Your account has been suspended due to policy violations.',
    });
  }

  user.lastLoginDeviceId = deviceId || user.lastLoginDeviceId;
  user.lastLoginIp = req.ip;
  await user.save();

  const token = signToken(user);
  res.json({ token, user: { id: user._id, name: user.name, coinBalance: user.coinBalance } });
});

module.exports = router;
