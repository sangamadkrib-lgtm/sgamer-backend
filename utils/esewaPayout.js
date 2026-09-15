const axios = require('axios');

// eSewa merchant payout / B2C disbursement integration.
// Replace ESEWA_PAYOUT_URL and payload shape with your merchant agreement's
// actual API contract — eSewa's disbursement API details are issued per-merchant.
const ESEWA_PAYOUT_URL = process.env.ESEWA_PAYOUT_URL;
const ESEWA_MERCHANT_ID = process.env.ESEWA_MERCHANT_ID;
const ESEWA_API_KEY = process.env.ESEWA_API_KEY;

/**
 * @param {{esewaId: string, amountRs: number, referenceId: string}} params
 * @returns {Promise<{success: boolean, txnId?: string, error?: string}>}
 */
async function sendEsewaPayout({ esewaId, amountRs, referenceId }) {
  if (!ESEWA_PAYOUT_URL || !ESEWA_API_KEY) {
    return { success: false, error: 'ESEWA_PAYOUT_NOT_CONFIGURED' };
  }

  try {
    const response = await axios.post(
      ESEWA_PAYOUT_URL,
      {
        merchantId: ESEWA_MERCHANT_ID,
        receiverId: esewaId,
        amount: amountRs,
        merchantReferenceId: referenceId, // idempotency key — use the Redemption _id
      },
      {
        headers: { Authorization: `Key ${ESEWA_API_KEY}` },
        timeout: 15000,
      }
    );

    if (response.data?.status === 'SUCCESS') {
      return { success: true, txnId: response.data.transactionId };
    }
    return { success: false, error: response.data?.message || 'UNKNOWN_ESEWA_ERROR' };
  } catch (err) {
    return { success: false, error: err.response?.data?.message || err.message };
  }
}

module.exports = { sendEsewaPayout };
