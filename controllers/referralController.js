const mongoose = require('mongoose');
const User = require('../models/User');
const { Transaction } = require('../models/Transaction');
const { checkReferralSpike } = require('../utils/fraudDetection');

const REFERRAL_BONUS = 200;

/**
 * Called once, right after a referred user's account is created
 * (hook this into auth.routes.js register flow, or call as its own
 * endpoint after e.g. first-game-played to reduce fake-signup abuse).
 */
async function creditReferralBonus(referredUser) {
  if (!referredUser.referredBy) return null;

  const session = await mongoose.startSession();
  try {
    let referrer;
    await session.withTransaction(async () => {
      // Anti-abuse: block credit if the referred account shares a device or IP
      // with the referrer (classic self-referral farm pattern).
      const referrerDoc = await User.findById(referredUser.referredBy).session(session);
      if (!referrerDoc) return;

      const sameDevice = referrerDoc.deviceId && referrerDoc.deviceId === referredUser.deviceId;
      const sameIp = referrerDoc.signupIp && referrerDoc.signupIp === referredUser.signupIp;
      if (sameDevice || sameIp) {
        await User.updateOne(
          { _id: referrerDoc._id },
          { $addToSet: { flaggedReasons: 'SELF_REFERRAL_SUSPECTED' }, $inc: { fraudScore: 3 } },
          { session }
        );
        return; // no bonus credited
      }

      referrer = await User.findByIdAndUpdate(
        referrerDoc._id,
        { $inc: { coinBalance: REFERRAL_BONUS, referralCount: 1, lifetimeEarned: REFERRAL_BONUS } },
        { new: true, session }
      );

      await Transaction.create(
        [
          {
            userId: referrer._id,
            type: 'REFERRAL_BONUS',
            amount: REFERRAL_BONUS,
            balanceAfter: referrer.coinBalance,
            meta: { referredUserId: referredUser._id },
          },
        ],
        { session }
      );
    });

    if (referrer) checkReferralSpike(referrer._id).catch((e) => console.error(e));
    return referrer;
  } finally {
    session.endSession();
  }
}

module.exports = { creditReferralBonus, REFERRAL_BONUS };
