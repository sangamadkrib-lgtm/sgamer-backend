const mongoose = require('mongoose');
const { Schema } = mongoose;

const RedemptionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    esewaId: { type: String, required: true }, // 10-digit mobile / eSewa ID used for this payout
    coins: { type: Number, required: true, min: 5000 },
    amountRs: { type: Number, required: true }, // coins / 200 -> 5000 coins = 25 Rs

    status: {
      type: String,
      enum: ['PENDING', 'APPROVED', 'COMPLETED', 'REJECTED'],
      default: 'PENDING',
      index: true,
    },

    // snapshot info captured at request time, useful for admin review without extra joins
    deviceIdSnapshot: { type: String },
    ipSnapshot: { type: String },

    // admin processing
    processedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    processedAt: { type: Date, default: null },
    txnId: { type: String, default: null }, // eSewa transaction reference once paid
    adminNotes: { type: String, default: null },
    rejectionReason: { type: String, default: null },

    requestedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

RedemptionSchema.index({ status: 1, requestedAt: -1 });

module.exports = mongoose.model('Redemption', RedemptionSchema);
