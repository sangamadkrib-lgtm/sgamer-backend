const jwt = require('jsonwebtoken');
const User = require('../models/User');

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * Standard user auth. Verifies signature AND re-checks live DB state
 * (isBanned, tokenVersion) so a ban takes effect immediately — not just
 * when the JWT naturally expires.
 */
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'AUTH_REQUIRED' });

    const payload = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(payload.sub).select(
      'isBanned banReason tokenVersion role coinBalance deviceId'
    );

    if (!user) return res.status(401).json({ error: 'INVALID_TOKEN' });

    // tokenVersion mismatch = token was issued before a ban/force-logout bump
    if (payload.tv !== user.tokenVersion) {
      return res.status(401).json({ error: 'SESSION_REVOKED' });
    }

    if (user.isBanned) {
      return res.status(403).json({
        error: 'ACCOUNT_SUSPENDED',
        message: 'Your account has been suspended due to policy violations.',
        reason: user.banReason || undefined,
      });
    }

    req.user = user;
    req.userId = user._id;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'INVALID_TOKEN' });
  }
}

/** Admin-only gate. Stacks on top of requireAuth. */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'ADMIN_ONLY' });
  }
  next();
}

/** Issue a JWT embedding the user's current tokenVersion. */
function signToken(user) {
  return jwt.sign({ sub: user._id.toString(), tv: user.tokenVersion, role: user.role }, JWT_SECRET, {
    expiresIn: '30d',
  });
}

module.exports = { requireAuth, requireAdmin, signToken };
