import QRRedirect from '../models/QRcoderedirect1.js';

/**
 * PUT /dashboard/update-destination
 * Authenticated: updates a QR redirect document owned by the current user.
 */
export const updateDestination = async (req, res) => {
  try {
    const { route, destination_url, page_title, display_message, redirect_delay_seconds } =
      req.body;

    // Step 1: Look up the document
    const doc = await QRRedirect.findOne({ route });

    // Step 2: Security gateways
    if (!doc) {
      return res.status(403).json({ success: false, error: 'Forbidden: route not found.' });
    }
    if (!doc.ownerId || doc.ownerId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, error: 'Forbidden: you do not own this route.' });
    }
    if (doc.canEdit === false) {
      return res.status(403).json({ success: false, error: 'Forbidden: editing is locked by admin.' });
    }

    // Step 3: Sanitize & mutate
    doc.destination_url = destination_url.trim();
    doc.page_title = page_title.trim();
    doc.display_message = display_message.trim();
    doc.redirect_delay_seconds = Math.max(
      0,
      Math.min(15, parseInt(redirect_delay_seconds, 10) || 3)
    );

    // Step 4: Persist
    await doc.save();
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[qrController] updateDestination error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
};

/**
 * GET /r/:route  (public catch-all — wire this at the BOTTOM of server.js)
 * Renders an intermediate redirect page for QR code scanners.
 */
export const handleQRRedirect = async (req, res) => {
  try {
    const doc = await QRRedirect.findOne({ route: req.params.route });

    if (!doc || !doc.active) {
      return res.status(404).render('error', {
        title: 'Not Found',
        message: 'This QR code link is inactive or does not exist.',
      });
    }

    return res.render('qr-redirect', {
      title: doc.page_title || 'Redirecting…',
      display_message: doc.display_message || 'Please wait, you are being redirected…',
      destination_url: doc.destination_url,
      redirect_delay_seconds: doc.redirect_delay_seconds ?? 3,
    });
  } catch (err) {
    console.error('[qrController] handleQRRedirect error:', err);
    return res.status(500).render('error', { title: 'Server Error', message: 'Something went wrong.' });
  }
};
