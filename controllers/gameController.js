const crypto = require('crypto');
const { redis, LEADERBOARD_KEY } = require('../config/redis');

const GAME_HMAC_SECRET = process.env.GAME_HMAC_SECRET; // shared with the game client build, NOT the same as JWT_SECRET
const MAX_PAYLOAD_AGE_MS = 30 * 1000; // reject stale/replayed submissions

/**
 * POST /api/games/score
 * body: { gameId: 'bottle_shoot' | 'block_build', score, timestamp, signature }
 *
 * The client computes signature = HMAC_SHA256(`${gameId}:${score}:${timestamp}:${userId}`, secret)
 * baked into the game bundle at build time. This doesn't stop a fully reverse-engineered
 * client, but it blocks the common case of someone hitting the API directly with curl/Postman.
 * Pair with server-side sanity bounds (e.g. max plausible score per game) for real protection.
 */
async function submitScore(req, res) {
  const { gameId, score, timestamp, signature } = req.body;
  const userId = req.userId.toString();

  if (!['bottle_shoot', 'block_build'].includes(gameId)) {
    return res.status(400).json({ error: 'INVALID_GAME_ID' });
  }
  if (!Number.isFinite(score) || score < 0) {
    return res.status(400).json({ error: 'INVALID_SCORE' });
  }
  if (Math.abs(Date.now() - timestamp) > MAX_PAYLOAD_AGE_MS) {
    return res.status(400).json({ error: 'STALE_OR_REPLAYED_PAYLOAD' });
  }

  const expectedHex = crypto
    .createHmac('sha256', GAME_HMAC_SECRET)
    .update(`${gameId}:${score}:${timestamp}:${userId}`)
    .digest('hex');

  const expectedBuf = Buffer.from(expectedHex, 'hex');
  const providedBuf = Buffer.from(String(signature || ''), 'hex');

  const valid =
    providedBuf.length === expectedBuf.length && crypto.timingSafeEqual(expectedBuf, providedBuf);

  if (!valid) {
    return res.status(401).json({ error: 'INVALID_SIGNATURE' });
  }

  // ZADD with GT keeps only the user's best score in this cycle
  await redis.zAdd(LEADERBOARD_KEY, { score, value: userId }, { GT: true });

  res.json({ message: 'Score recorded' });
}

/** GET /api/games/leaderboard?limit=100 — live top-N for the in-app leaderboard view */
async function getLeaderboard(req, res) {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const raw = await redis.zRangeWithScores(LEADERBOARD_KEY, 0, limit - 1, { REV: true });
  res.json({ items: raw.map((r, i) => ({ rank: i + 1, userId: r.value, score: r.score })) });
}

module.exports = { submitScore, getLeaderboard };
