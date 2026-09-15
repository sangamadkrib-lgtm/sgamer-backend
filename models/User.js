const mongoose = require('mongoose');
const { Schema } = mongoose;

const UserSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, unique: true, index: true },
    passwordHash: { type: String, required: true },

    // Wallet
    coinBalance: { type: Number, default: 0, min: 0 },
    lifetimeEarned: { type: Number, default: 0 },

    // Referral system
    referralCode: { type: String, unique: true, index: true }, // e.g. REF123
    referredBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    referralCount: { type: Number, default: 0 },

    // eSewa payout details
    esewaNumber: { type: String, match: /^[9][6-8]\d{8}$/, default: null }, // 10-digit NP mobile

    // Device / fraud fingerprinting
    deviceId: { type: String, index: true }, // hardware UUID at registration
    lastLoginDeviceId: { type: String },
    lastLoginIp: { type: String },
    signupIp: { type: String },

    // Security / session
    role: { type: String, enum: ['USER', 'ADMIN'], default: 'USER' },
    tokenVersion: { type: Number, default: 0 }, // bump to invalidate all JWTs

    // Ban state
    isBanned: { type: Boolean, default: false, index: true },
    banReason: { type: String, default: null },
    bannedAt: { type: Date, default: null },
    bannedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    // Fraud flags (soft signals, not auto-ban)
    fraudScore: { type: Number, default: 0 },
    flaggedReasons: [{ type: String }],
  },
  { timestamps: true }
);

UserSchema.index({ deviceId: 1, isBanned: 1 });

module.exports = mongoose.model('User', UserSchema);
