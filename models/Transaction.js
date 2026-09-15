const mongoose = require('mongoose');
const { Schema } = mongoose;

// Append-only ledger for every coin movement — makes wallet balances auditable
// and lets fraud detection reconstruct "coins earned per hour" cheaply.
const TransactionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: {
      type: String,
      enum: [
        'GAME_REWARD',
        'TOURNAMENT_PRIZE',
        'REFERRAL_BONUS',
        'REDEMPTION_DEDUCT',
        'REDEMPTION_REFUND',
        'ADMIN_ADJUST',
      ],
      required: true,
      index: true,
    },
    amount: { type: Number, required: true }, // positive = credit, negative = debit
    balanceAfter: { type: Number, required: true },
    meta: { type: Schema.Types.Mixed, default: {} }, // e.g. { gameId, rank, referredUserId, redemptionId }
  },
  { timestamps: true }
);

TransactionSchema.index({ userId: 1, createdAt: -1 });

const BannedDeviceSchema = new Schema(
  {
    deviceId: { type: String, required: true, unique: true, index: true },
    reason: { type: String, default: null },
    bannedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

const BannedIpSchema = new Schema(
  {
    ip: { type: String, required: true, unique: true, index: true },
    reason: { type: String, default: null },
    bannedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

module.exports = {
  Transaction: mongoose.model('Transaction', TransactionSchema),
  BannedDevice: mongoose.model('BannedDevice', BannedDeviceSchema),
  BannedIp: mongoose.model('BannedIp', BannedIpSchema),
};
