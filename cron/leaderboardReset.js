const cron = require('node-cron');
const mongoose = require('mongoose');
const { redis, LEADERBOARD_KEY } = require('../config/redis');
const User = require('../models/User');
const { Transaction } = require('../models/Transaction');
const { checkEarnVelocity } = require('../utils/fraudDetection');

/** Rank -> coin prize. Ranks 4-10, 11-100, 101-5000 use flat tiers. */
function prizeForRank(rank) {
  if (rank === 1) return 500;
  if (rank === 2) return 400;
  if (rank === 3) return 300;
  if (rank <= 10) return 200;
  if (rank <= 100) return 100;
  if (rank <= 5000) return 50;
  return 0;
}

/**
 * Snapshot the top 5000 ranked players, bulk-credit their wallets, then
 * reset the Redis leaderboard to empty for the next 10-hour cycle.
 * The snapshot + bulk write happens BEFORE the Redis reset so a crash
 * mid-run never loses the leaderboard state — worst case it just re-runs
 * against the same (unreset) sorted set.
 */
async function runLeaderboardReset() {
  const started = Date.now();
  console.log('[leaderboard-cron] starting reset cycle');

  const top = await redis.zRangeWithScores(LEADERBOARD_KEY, 0, 4999, { REV: true });
  if (top.length === 0) {
    console.log('[leaderboard-cron] no scores this cycle, skipping payout');
    return;
  }

  const bulkOps = top.map((entry, idx) => {
    const rank = idx + 1;
    const prize = prizeForRank(rank);
    return {
      updateOne: {
        filter: { _id: entry.value },
        update: { $inc: { coinBalance: prize, lifetimeEarned: prize } },
      },
    };
  }).filter((op) => op !== null);

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await User.bulkWrite(bulkOps, { session, ordered: false });

      const txnDocs = top.map((entry, idx) => ({
        userId: entry.value,
        type: 'TOURNAMENT_PRIZE',
        amount: prizeForRank(idx + 1),
        balanceAfter: null, // bulk-write path can't cheaply know post-balance per doc; see note below
        meta: { rank: idx + 1, score: entry.score, cycleEndedAt: new Date() },
      })).filter((t) => t.amount > 0);

      if (txnDocs.length) await Transaction.insertMany(txnDocs, { session });
    });

    // Only clear the leaderboard once rewards are durably committed to MongoDB
    await redis.del(LEADERBOARD_KEY);

    // Sample-check top earners for velocity fraud (full top 5000 would be expensive every cycle)
    const sampleUserIds = top.slice(0, 20).map((e) => e.value);
    await Promise.all(sampleUserIds.map((id) => checkEarnVelocity(id).catch(() => {})));

    console.log(`[leaderboard-cron] cycle complete: ${top.length} players rewarded in ${Date.now() - started}ms`);
  } catch (err) {
    console.error('[leaderboard-cron] FAILED — leaderboard NOT reset, will retry next tick', err);
  } finally {
    session.endSession();
  }
}

// NOTE: Transaction.balanceAfter is set null here because bulkWrite doesn't
// return per-doc post-update balances cheaply at scale. If you need an exact
// running balance per txn, swap bulkWrite for a loop of findOneAndUpdate
// (slower, but gives you `balanceAfter` for the ledger) or reconcile balances
// via a periodic balance = sum(transactions) audit job instead.

function scheduleLeaderboardReset() {
  // every 10 hours, on the hour: 00:00, 10:00, 20:00 server time
  cron.schedule('0 0,10,20 * * *', () => {
    runLeaderboardReset().catch((e) => console.error('[leaderboard-cron] unhandled error', e));
  });
  console.log('[leaderboard-cron] scheduled for 00:00 / 10:00 / 20:00 daily');
}

module.exports = { scheduleLeaderboardReset, runLeaderboardReset, prizeForRank };
