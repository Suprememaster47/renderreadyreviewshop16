import mongoose from 'mongoose';

const qrSchema = new mongoose.Schema({
  route: { type: String, required: true, unique: true, index: true },
  company_name: { type: String },
  hardcoded_url: { type: String },
  destination_url: { type: String, required: true },
  redirect_delay_seconds: { type: Number, default: 3 },
  display_message: { type: String },
  page_title: { type: String },
  active: { type: Boolean, default: true },
  ownerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    index: true,
  },
  canEdit: { type: Boolean, default: true },
});

// Safe model pattern — prevents OverwriteModelError on hot-reloads
const QRRedirect =
  mongoose.models.QRcoderedirect1 ||
  mongoose.model('QRcoderedirect1', qrSchema, 'QRcoderedirect1');

export default QRRedirect;
