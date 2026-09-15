require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');

const { connectRedis } = require('./config/redis');
const { scheduleLeaderboardReset } = require('./cron/leaderboardReset');
const { requireAuth } = require('./middleware/auth');

const authRoutes = require('./routes/auth.routes');
const redeemRoutes = require('./routes/redeem.routes');
const adminRoutes = require('./routes/admin.routes');
const gameController = require('./controllers/gameController');

const app = express();
app.set('trust proxy', 1); // required for req.ip to reflect real client IP behind a proxy/load balancer
app.use(express.json());

// Basic abuse guard on the redemption endpoint specifically — cashout fraud
// is the highest-value target, so it gets a tighter limit than the general API.
const redeemLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, message: { error: 'TOO_MANY_REQUESTS' } });

app.use('/api/auth', authRoutes);
app.use('/api/redeem', redeemLimiter, redeemRoutes);
app.use('/api/admin', adminRoutes);

app.post('/api/games/score', requireAuth, gameController.submitScore);
app.get('/api/games/leaderboard', requireAuth, gameController.getLeaderboard);

app.get('/health', (req, res) => res.json({ ok: true }));

async function start() {
  await mongoose.connect(process.env.MONGO_URI);
  await connectRedis();
  scheduleLeaderboardReset();

  const port = process.env.PORT || 4000;
  app.listen(port, () => console.log(`API listening on :${port}`));
}

start().catch((err) => {
  console.error('Fatal startup error', err);
  process.exit(1);
});

module.exports = app;
