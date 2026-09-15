const mongoose = require('mongoose');
const User = require('../models/User');
const Redemption = require('../models/Redemption');
const { Transaction } = require('../models/Transaction');

const COIN_TO_RS_RATE = 200; // 5000 coins = 25 Rs  =>  200 coins = 1 Rs
const MIN_COINS = 5000;

const ESEWA_ID_REGEX = /^[9][6-8]\d{8}$/; // 10-digit Nepali mobile used as eSewa ID

/**
 * POST /api/redeem/esewa
 * body: { esewaId: string, coins: number }
 *
 * Deducts coins atomically and creates a PENDING Redemption row.
 * Uses a MongoDB session/transaction so a crash mid-request can never
 * leave coins deducted without a redemption record (or vice versa).
 */
async function requestRedemption(req, res) {
  const { esewaId, coins } = req.body;
  const userId = req.userId;

  if (!esewaId || !ESEWA_ID_REGEX.test(esewaId)) {
    return res.status(400).json({ error: 'INVALID_ESEWA_ID', message: 'Enter a valid 10-digit eSewa number.' });
  }
  if (!Number.isInteger(coins) || coins < MIN_COINS || coins % MIN_COINS !== 0) {
    return res
      .status(400)
      .json({ error: 'INVALID_AMOUNT', message: `Amount must be a multiple of ${MIN_COINS} coins.` });
  }

  const amountRs = coins / COIN_TO_RS_RATE;
  const session = await mongoose.startSession();

  try {
    let redemption;

    await session.withTransaction(async () => {
      // Atomic conditional decrement — only succeeds if balance is sufficient,
      // which is what actually prevents double-spend under concurrent requests.
      const user = await User.findOneAndUpdate(
        { _id: userId, coinBalance: { $gte: coins }, isBanned: false },
        { $inc: { coinBalance: -coins } },
        { new: true, session }
      );

      if (!user) {
        throw Object.assign(new Error('INSUFFICIENT_BALANCE'), { code: 'INSUFFICIENT_BALANCE' });
      }

      const created = await Redemption.create(
        [
          {
            userId,
            esewaId,
            coins,
            amountRs,
            status: 'PENDING',
            deviceIdSnapshot: user.deviceId,
            ipSnapshot: req.ip,
            requestedAt: new Date(),
          },
        ],
        { session }
      );
      redemption = created[0];

      await Transaction.create(
        [
          {
            userId,
            type: 'REDEMPTION_DEDUCT',
            amount: -coins,
            balanceAfter: user.coinBalance,
            meta: { redemptionId: redemption._id, esewaId },
          },
        ],
        { session }
      );
    });

    return res.status(201).json({
      message: 'Redemption request submitted. Funds are held pending admin review.',
      redemption,
    });
  } catch (err) {
    if (err.code === 'INSUFFICIENT_BALANCE') {
      return res.status(400).json({ error: 'INSUFFICIENT_BALANCE', message: 'Not enough coins for this redemption.' });
    }
    console.error('requestRedemption error', err);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  } finally {
    session.endSession();
  }
}

/** GET /api/redeem/mine — user's own redemption history */
async function myRedemptions(req, res) {
  const items = await Redemption.find({ userId: req.userId }).sort({ requestedAt: -1 }).limit(50);
  res.json({ items });
}

module.exports = { requestRedemption, myRedemptions, COIN_TO_RS_RATE, MIN_COINS };
