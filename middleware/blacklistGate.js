const { BannedDevice, BannedIp } = require('../models/Transaction');

/**
 * Apply globally (or at minimum on /auth/register and /auth/login).
 * Rejects requests from a blacklisted device fingerprint or IP before
 * any account is created or session issued.
 */
async function blacklistGate(req, res, next) {
  try {
    const deviceId = req.headers['x-device-id'] || req.body?.deviceId;
    const ip = req.ip;

    const [deviceBanned, ipBanned] = await Promise.all([
      deviceId ? BannedDevice.exists({ deviceId }) : null,
      ip ? BannedIp.exists({ ip }) : null,
    ]);

    if (deviceBanned || ipBanned) {
      return res.status(403).json({
        error: 'DEVICE_BLOCKED',
        message: 'This device is not permitted to access the app.',
      });
    }

    next();
  } catch (err) {
    // fail open on infra errors so a Redis/Mongo blip doesn't lock everyone out,
    // but log loudly since this is a security control
    console.error('blacklistGate error', err);
    next();
  }
}

module.exports = blacklistGate;
