/**
 * models/ProcessedOrder.js
 * Idempotency guard — records every Stripe session_id that has already been
 * counted toward sold units and triggered an order confirmation email.
 *
 * Collection: "processed_orders" (MongoDB Atlas, Cluster login1, DB: test)
 *
 * Flow:
 *   1. /api/verify-session receives a session_id.
 *   2. Checks this collection — if document exists, skip all writes.
 *   3. If not found: insert here first, then increment sold counts and send email.
 *
 * The TTL index removes records automatically after 90 days, keeping the
 * collection lean without any manual cleanup.
 */

import mongoose from 'mongoose';

const ProcessedOrderSchema = new mongoose.Schema(
  {
    session_id:  { type: String, required: true, unique: true },
    processedAt: { type: Date,   default: Date.now },
  },
  {
    collection: 'processed_orders',
    timestamps: false,
  }
);

// Auto-delete after 90 days — prevents unbounded collection growth
ProcessedOrderSchema.index({ processedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

const ProcessedOrder = mongoose.models.ProcessedOrder || mongoose.model('ProcessedOrder', ProcessedOrderSchema);

export default ProcessedOrder;
