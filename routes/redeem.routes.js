const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { requestRedemption, myRedemptions } = require('../controllers/redeemController');

router.post('/esewa', requireAuth, requestRedemption);
router.get('/mine', requireAuth, myRedemptions);

module.exports = router;
