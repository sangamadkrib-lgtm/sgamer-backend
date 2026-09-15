const mongoose = require('mongoose');
const User = require('../models/User');
const Redemption = require('../models/Redemption');
const { Transaction, BannedDevice, BannedIp } = require('../models/Transaction');
const { sendEsewaPayout } = require('../utils/esewaPayout');

/**
 * GET /api/admin/redemptions?status=PENDING
 * Returns the payout queue enriched with device-fingerprint duplicate counts
 * and basic signup/referral context, so an admin can spot risk at a glance.
 */
async function listRedemptions(req, res) {
  const status = req.query.status || 'PENDING';
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit) || 25, 100);

  const redemptions = await Redemption.find({ status })
    .sort({ requestedAt: 1 }) // oldest first — FIFO queue
    .skip((page - 1) * limit)
    .limit(limit)
    .populate('userId', 'name phone deviceId coinBalance fraudScore flaggedReasons referralCount createdAt isBanned')
    .lean();

  // Enrich with "how many other accounts share this device" for quick fraud triage
  const deviceIds = [...new Set(redemptions.map((r) => r.userId?.deviceId).filter(Boolean))];
  const deviceCounts = deviceIds.length
    ? await User.aggregate([
        { $match: { deviceId: { $in: deviceIds } } },
        { $group: { _id: '$deviceId', count: { $sum: 1 } } },
      ])
    : [];
  const deviceCountMap = Object.fromEntries(deviceCounts.map((d) => [d._id, d.count]));

  const enriched = redemptions.map((r) => ({
    ...r,
    userName: r.userId?.name,
    deviceId: r.userId?.deviceId,
    accountsOnSameDevice: deviceCountMap[r.userId?.deviceId] || 1,
    signupAt: r.userId?.createdAt,
    referralCount: r.userId?.referralCount,
    fraudScore: r.userId?.fraudScore,
    flaggedReasons: r.userId?.flaggedReasons,
  }));

  const total = await Redemption.countDocuments({ status });
  res.json({ items: enriched, page, limit, total });
}

/**
 * POST /api/admin/redemption/process
 * body: { redemptionId, action: 'APPROVE_PAID' | 'REJECT' | 'APPROVE_API', txnId?, reason? }
 */
async function processRedemption(req, res) {
  const { redemptionId, action, txnId, reason } = req.body;
  const adminId = req.userId;

  if (!mongoose.isValidObjectId(redemptionId)) {
    return res.status(400).json({ error: 'INVALID_REDEMPTION_ID' });
  }

  const session = await mongoose.startSession();
  try {
    let result;

    await session.withTransaction(async () => {
      const redemption = await Redemption.findOne({ _id: redemptionId, status: 'PENDING' }).session(session);
      if (!redemption) {
        throw Object.assign(new Error('NOT_FOUND_OR_ALREADY_PROCESSED'), { code: 'NOT_FOUND' });
      }

      if (action === 'REJECT') {
        // refund coins back to the user's active wallet
        const user = await User.findByIdAndUpdate(
          redemption.userId,
          { $inc: { coinBalance: redemption.coins } },
          { new: true, session }
        );

        redemption.status = 'REJECTED';
        redemption.rejectionReason = reason || null;
        redemption.processedBy = adminId;
        redemption.processedAt = new Date();
        await redemption.save({ session });

        await Transaction.create(
          [
            {
              userId: redemption.userId,
              type: 'REDEMPTION_REFUND',
              amount: redemption.coins,
              balanceAfter: user.coinBalance,
              meta: { redemptionId: redemption._id, reason },
            },
          ],
          { session }
        );
      } else if (action === 'APPROVE_PAID') {
        // manual off-app payout already sent by admin; just record it
        if (!txnId) throw Object.assign(new Error('TXN_ID_REQUIRED'), { code: 'TXN_ID_REQUIRED' });

        redemption.status = 'COMPLETED';
        redemption.txnId = txnId;
        redemption.processedBy = adminId;
        redemption.processedAt = new Date();
        await redemption.save({ session });
      } else if (action === 'APPROVE_API') {
        // integrate eSewa merchant payout API directly
        redemption.status = 'APPROVED';
        redemption.processedBy = adminId;
        await redemption.save({ session });

        const payoutResult = await sendEsewaPayout({
          esewaId: redemption.esewaId,
          amountRs: redemption.amountRs,
          referenceId: redemption._id.toString(),
        });

        redemption.status = payoutResult.success ? 'COMPLETED' : 'PENDING'; // revert to PENDING on failure for retry/manual review
        redemption.txnId = payoutResult.txnId || null;
        redemption.processedAt = payoutResult.success ? new Date() : null;
        redemption.adminNotes = payoutResult.success ? null : `API payout failed: ${payoutResult.error}`;
        await redemption.save({ session });
      } else {
        throw Object.assign(new Error('INVALID_ACTION'), { code: 'INVALID_ACTION' });
      }

      result = redemption;
    });

    return res.json({ message: 'Redemption processed', redemption: result });
  } catch (err) {
    const known = ['NOT_FOUND', 'TXN_ID_REQUIRED', 'INVALID_ACTION'];
    if (known.includes(err.code)) {
      return res.status(400).json({ error: err.code });
    }
    console.error('processRedemption error', err);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  } finally {
    session.endSession();
  }
}

/**
 * POST /api/admin/user/ban
 * body: { userId, reason, banDevice?: boolean, banIp?: boolean }
 * Bans the user, force-invalidates their JWTs, freezes wallet activity,
 * and auto-rejects (refunds) any pending redemptions.
 */
async function banUser(req, res) {
  const { userId, reason, banDevice, banIp } = req.body;
  const adminId = req.userId;

  if (!mongoose.isValidObjectId(userId)) {
    return res.status(400).json({ error: 'INVALID_USER_ID' });
  }

  const session = await mongoose.startSession();
  try {
    let user;

    await session.withTransaction(async () => {
      user = await User.findByIdAndUpdate(
        userId,
        {
          isBanned: true,
          banReason: reason || 'Policy violation',
          bannedAt: new Date(),
          bannedBy: adminId,
          $inc: { tokenVersion: 1 }, // invalidates every previously-issued JWT
        },
        { new: true, session }
      );
      if (!user) throw Object.assign(new Error('USER_NOT_FOUND'), { code: 'USER_NOT_FOUND' });

      // auto-reject + refund any pending redemptions for this user
      const pending = await Redemption.find({ userId, status: 'PENDING' }).session(session);
      for (const r of pending) {
        r.status = 'REJECTED';
        r.rejectionReason = 'Account banned';
        r.processedBy = adminId;
        r.processedAt = new Date();
        await r.save({ session });

        const updated = await User.findByIdAndUpdate(
          userId,
          { $inc: { coinBalance: r.coins } },
          { new: true, session }
        );

        await Transaction.create(
          [
            {
              userId,
              type: 'REDEMPTION_REFUND',
              amount: r.coins,
              balanceAfter: updated.coinBalance,
              meta: { redemptionId: r._id, reason: 'account_banned' },
            },
          ],
          { session }
        );
      }

      if (banDevice && user.deviceId) {
        await BannedDevice.updateOne(
          { deviceId: user.deviceId },
          { $setOnInsert: { deviceId: user.deviceId, reason, bannedBy: adminId } },
          { upsert: true, session }
        );
      }
      if (banIp && user.signupIp) {
        await BannedIp.updateOne(
          { ip: user.signupIp },
          { $setOnInsert: { ip: user.signupIp, reason, bannedBy: adminId } },
          { upsert: true, session }
        );
      }
    });

    return res.json({ message: 'User banned', user: { id: user._id, isBanned: true } });
  } catch (err) {
    if (err.code === 'USER_NOT_FOUND') return res.status(404).json({ error: 'USER_NOT_FOUND' });
    console.error('banUser error', err);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  } finally {
    session.endSession();
  }
}

/** POST /api/admin/user/unban  body: { userId } */
async function unbanUser(req, res) {
  const { userId } = req.body;
  if (!mongoose.isValidObjectId(userId)) return res.status(400).json({ error: 'INVALID_USER_ID' });

  const user = await User.findByIdAndUpdate(
    userId,
    { isBanned: false, banReason: null, bannedAt: null, $inc: { tokenVersion: 1 } },
    { new: true }
  );
  if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });
  res.json({ message: 'User unbanned', user: { id: user._id, isBanned: false } });
}

/** GET /api/admin/users/flagged — accounts with fraudScore > 0, for manual review */
async function listFlaggedUsers(req, res) {
  const users = await User.find({ fraudScore: { $gt: 0 }, isBanned: false })
    .select('name phone deviceId coinBalance fraudScore flaggedReasons referralCount createdAt')
    .sort({ fraudScore: -1 })
    .limit(100);
  res.json({ items: users });
}

module.exports = { listRedemptions, processRedemption, banUser, unbanUser, listFlaggedUsers };
