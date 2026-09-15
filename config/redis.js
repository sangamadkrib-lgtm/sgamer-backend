const { createClient } = require('redis');

const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
redis.on('error', (err) => console.error('Redis error', err));

const LEADERBOARD_KEY = 'leaderboard:current';

async function connectRedis() {
  if (!redis.isOpen) await redis.connect();
  return redis;
}

module.exports = { redis, connectRedis, LEADERBOARD_KEY };
