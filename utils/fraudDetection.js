const User = require('../models/User');
const { Transaction } = require('../models/Transaction');

const RULES = {
  MAX_ACCOUNTS_PER_DEVICE: 2,
  MAX_COINS_PER_HOUR: 3000, // above this from GAME_REWARD txns alone looks scripted
  MAX_REFERRALS_PER_DAY: 15,
};

/** Called after signup: flags (does not block) accounts sharing a device/IP. */
async function checkMultiAccount(newUser) {
  const reasons = [];

  const [sameDevice, sameIp] = await Promise.all([
    newUser.deviceId
      ? User.countDocuments({ deviceId: newUser.deviceId, _id: { $ne: newUser._id } })
      : 0,
    newUser.signupIp
      ? User.countDocuments({ signupIp: newUser.signupIp, _id: { $ne: newUser._id } })
      : 0,
  ]);

  if (sameDevice >= RULES.MAX_ACCOUNTS_PER_DEVICE) {
    reasons.push(`MULTI_ACCOUNT_DEVICE:${sameDevice}`);
  }
  if (sameIp >= RULES.MAX_ACCOUNTS_PER_DEVICE) {
    reasons.push(`MULTI_ACCOUNT_IP:${sameIp}`);
  }

  if (reasons.length) await flagUser(newUser._id, reasons);
  return reasons;
}

/** Called after crediting GAME_REWARD/TOURNAMENT_PRIZE coins: flags abnormal earn velocity. */
async function checkEarnVelocity(userId) {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const agg = await Transaction.aggregate([
    {
      $match: {
        userId,
        type: { $in: ['GAME_REWARD', 'TOURNAMENT_PRIZE'] },
        createdAt: { $gte: oneHourAgo },
        amount: { $gt: 0 },
      },
    },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);

  const total = agg[0]?.total || 0;
  if (total > RULES.MAX_COINS_PER_HOUR) {
    await flagUser(userId, [`EARN_VELOCITY:${total}/hr`]);
    return true;
  }
  return false;
}

/** Called after a referral credit: flags referral rings / spikes. */
async function checkReferralSpike(referrerId) {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const count = await Transaction.countDocuments({
    userId: referrerId,
    type: 'REFERRAL_BONUS',
    createdAt: { $gte: oneDayAgo },
  });

  if (count > RULES.MAX_REFERRALS_PER_DAY) {
    await flagUser(referrerId, [`REFERRAL_SPIKE:${count}/day`]);
    return true;
  }
  return false;
}

async function flagUser(userId, reasons) {
  await User.updateOne(
    { _id: userId },
    {
      $inc: { fraudScore: reasons.length },
      $addToSet: { flaggedReasons: { $each: reasons } },
    }
  );
}

module.exports = { checkMultiAccount, checkEarnVelocity, checkReferralSpike, flagUser, RULES };
