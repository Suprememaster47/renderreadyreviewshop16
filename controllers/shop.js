/**
 * controllers/shop.js
 * ─────────────────────────────────────────────────────────────────────────────
 * All shop logic extracted from the standalone shop server.js and refactored
 * into a single ES Module controller for the main Hackathon Starter project.
 *
 * What lives here:
 *   • Stripe readiness flags (STRIPE_READY, WEBHOOK_READY)
 *   • Email readiness flag (EMAIL_READY) + Nodemailer transporter
 *   • buildOrderEmailHTML() + sendOrderEmail() helpers
 *   • sanitizeImagePaths() helper
 *   • SHIPPING_COUNTRIES allowlist
 *   • All route handler functions (exported individually)
 *   • stripeWebhookRaw — the raw-body webhook handler (must mount before
 *     body parsers in server.js — see integration notes below)
 *
 * Integration notes for server.js:
 *   1. Import this file:
 *        import * as shopController from './controllers/shop.js';
 *
 *   2. Mount the webhook route BEFORE body parsers (it needs the raw buffer):
 *        app.post('/webhook', express.raw({ type: 'application/json' }), shopController.stripeWebhookRaw);
 *
 *   3. Bypass CSRF for all shop API routes in the existing CSRF middleware:
 *        req.originalUrl.startsWith('/api/products') ||
 *        req.originalUrl.startsWith('/api/sold-counts') ||
 *        req.originalUrl === '/create-checkout-session' ||
 *        req.originalUrl.startsWith('/api/verify-session') ||
 *        req.originalUrl === '/webhook'
 *
 *   4. Register page routes (after session / passport middleware):
 *        app.get(['/shop', '/shop/collections', '/shop/collections/:slug'], shopController.getShopPage);
 *        app.get('/shop/status', shopController.getShopStatusPage);
 *
 *   5. Register API routes:
 *        app.get('/api/products',              shopController.getProducts);
 *        app.get('/api/products/:slug',        shopController.getProductBySlug);
 *        app.get('/api/sold-counts',           shopController.getSoldCounts);
 *        app.get('/api/sold-counts/:slug',     shopController.getSoldCountBySlug);
 *        app.post('/create-checkout-session',  shopController.createCheckoutSession);
 *        app.get('/api/verify-session',        shopController.verifySession);
 *
 *   6. Call shopController.verifyEmailConnection() inside app.listen() callback:
 *        shopController.verifyEmailConnection();
 *
 *   7. Copy all files from Shop/public/ into the main project's public/ folder.
 *      The main project's existing express.static('/public') will serve them.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import path            from 'path';
import { fileURLToPath } from 'url';
import nodemailer      from 'nodemailer';
import Stripe          from 'stripe';
import Product         from '../models/Product.js';
import Mapping         from '../models/Mapping.js';
import Sold            from '../models/Sold.js';
import ProcessedOrder  from '../models/ProcessedOrder.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── Helper: real value vs placeholder / empty ───────────────────────────────
function hasValue(key) {
  const v = process.env[key];
  if (!v || v.trim() === '') return false;
  if (v.startsWith('sk_test_XXXX')) return false;
  if (v.startsWith('pk_test_XXXX')) return false;
  if (v.startsWith('whsec_XXXX'))   return false;
  return true;
}

// ─── Helper: strip "/public" prefix from image paths ─────────────────────────
// MongoDB stores images as "/public/assets/images/foo.png".
// Express static middleware serves from the "public/" folder, so the browser
// must request "/assets/images/foo.png" (no "/public" prefix).
// Returns a NEW object — never mutates the original document.
function sanitizeImagePaths(product) {
  if (!product) return null;
  return {
    ...product,
    images: Array.isArray(product.images)
      ? product.images.map(img =>
          typeof img === 'string' && img.startsWith('/public')
            ? img.replace('/public', '')
            : img
        )
      : product.images,
  };
}

// ─── Stripe readiness ─────────────────────────────────────────────────────────
export const STRIPE_READY  = hasValue('STRIPE_SECRET_KEY') && hasValue('STRIPE_PUBLISHABLE_KEY');
export const WEBHOOK_READY = STRIPE_READY && hasValue('STRIPE_WEBHOOK_SECRET');

if (!STRIPE_READY) {
  console.warn('\n⚠️  [Shop] Stripe keys not configured — checkout runs in DEV mode.');
  console.warn('   Add STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY to .env\n');
} else if (!WEBHOOK_READY) {
  console.warn('\n⚠️  [Shop] STRIPE_WEBHOOK_SECRET not set — webhook verification disabled.');
  console.warn('   Checkout and payments work normally without it.\n');
}

const stripe = STRIPE_READY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

// ─── Email readiness ──────────────────────────────────────────────────────────
export const EMAIL_READY =
  hasValue('EMAIL_HOST') &&
  hasValue('EMAIL_PORT') &&
  hasValue('EMAIL_USER') &&
  hasValue('EMAIL_PASS');

if (!EMAIL_READY) {
  console.warn('\n⚠️  [Shop] Email not configured — order confirmation emails disabled.');
  console.warn('   Add EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASS to .env\n');
}

// ─── Nodemailer transporter ───────────────────────────────────────────────────
// Created unconditionally; sendOrderEmail() checks EMAIL_READY before use.
const transporter = nodemailer.createTransport({
  host:   process.env.EMAIL_HOST || 'mail.privateemail.com',
  port:   parseInt(process.env.EMAIL_PORT || '465', 10),
  secure: true, // port 465 always SSL
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  connectionTimeout: 10000,
  greetingTimeout:   10000,
  socketTimeout:     15000,
});

// ─── Verify SMTP connection on startup ────────────────────────────────────────
// Called from server.js inside app.listen() callback.
// A failure logs a warning but never crashes the server.
export function verifyEmailConnection() {
  if (EMAIL_READY) {
    transporter.verify()
      .then(() => console.log('    Email (SMTP)    : ✅  connected (Namecheap Private Email)'))
      .catch(err => {
        console.warn('    Email (SMTP)    : ⚠️  connection failed —', err.message);
        console.warn('                       Check EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASS in .env');
      });
  } else {
    console.log('    Email (SMTP)    : ⚠️  not configured (EMAIL_* vars missing)');
  }
}

// ─── Email helpers ────────────────────────────────────────────────────────────
function centsToUSD(cents) {
  return '$' + (cents / 100).toFixed(2);
}

function formatEmailDate(isoString) {
  try {
    return new Date(isoString).toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric',
    });
  } catch (_) {
    return isoString;
  }
}

function buildOrderEmailHTML({ customerName, customerEmail, sessionId, transactionDate, receiptItems, amountTotal }) {
  const shopUrl  = 'https://hydrosweepservices.com/shop/collections';
  const dateStr  = formatEmailDate(transactionDate);
  const totalStr = centsToUSD(amountTotal);
  const nameStr  = customerName || customerEmail || 'Valued Customer';

  const itemRows = (receiptItems || []).map(item => {
    const desc = item.description ? `<br><span style="color:#888; font-size:12px;">${item.description}</span>` : '';
    const qty  = item.quantity > 1 ? ` &times; ${item.quantity}` : '';
    return `
      <tr>
        <td style="padding:10px 0; border-bottom:1px solid #2a2a2a; font-size:14px; color:#ddd;">
          ${item.name}${qty}${desc}
        </td>
        <td style="padding:10px 0; border-bottom:1px solid #2a2a2a; font-size:14px;
                   color:#ddd; text-align:right; white-space:nowrap;">
          ${centsToUSD(item.totalAmount)}
        </td>
      </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Order Confirmation — Hydro Sweep Services</title>
</head>
<body style="margin:0; padding:0; background:#0a0a0a; font-family:'Helvetica Neue', Helvetica, Arial, sans-serif; color:#ffffff;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
         style="background:#0a0a0a; padding:40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width:560px; background:#111;
               border:1px solid #2a2a2a; border-radius:16px; overflow:hidden;">
          <tr>
            <td style="background:#000; padding:28px 36px; border-bottom:1px solid #222; text-align:center;">
              <p style="margin:0; font-size:11px; letter-spacing:3px; text-transform:uppercase; color:#666;">Hydro Sweep Services</p>
              <h1 style="margin:8px 0 0; font-size:22px; font-weight:800; letter-spacing:-0.5px; color:#fff;">Order Confirmed</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 36px;">
              <p style="margin:0 0 20px; font-size:15px; color:#ccc; line-height:1.6;">
                Hi ${nameStr},<br><br>
                Thank you for your purchase! Your payment has been confirmed and your
                order is currently being processed and prepared for shipment.
              </p>
              <hr style="border:none; border-top:1px solid #2a2a2a; margin:0 0 24px;">
              <p style="margin:0 0 12px; font-size:10px; font-weight:800; letter-spacing:2px; text-transform:uppercase; color:#555;">Order Details</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                ${itemRows || `<tr><td style="padding:10px 0; font-size:14px; color:#888;">No item details available.</td></tr>`}
                <tr><td style="height:8px;"></td></tr>
                <tr>
                  <td style="padding:6px 0; font-size:13px; color:#888;">Subtotal</td>
                  <td style="padding:6px 0; font-size:13px; color:#888; text-align:right;">${totalStr}</td>
                </tr>
                <tr>
                  <td style="padding:6px 0; font-size:13px; color:#888;">Shipping</td>
                  <td style="padding:6px 0; font-size:13px; color:#888; text-align:right;">Free</td>
                </tr>
                <tr>
                  <td style="padding:14px 0 6px; font-size:15px; font-weight:800; color:#fff; border-top:1px solid #2a2a2a;">Total Paid</td>
                  <td style="padding:14px 0 6px; font-size:15px; font-weight:800; color:#fff; text-align:right; border-top:1px solid #2a2a2a;">${totalStr}</td>
                </tr>
              </table>
              <hr style="border:none; border-top:1px solid #2a2a2a; margin:24px 0;">
              <p style="margin:0 0 12px; font-size:10px; font-weight:800; letter-spacing:2px; text-transform:uppercase; color:#555;">Reference Information</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;">
                <tr>
                  <td style="padding:4px 0; color:#666; width:40%;">Order Number</td>
                  <td style="padding:4px 0; color:#bbb; word-break:break-all;">${sessionId || '—'}</td>
                </tr>
                <tr>
                  <td style="padding:4px 0; color:#666;">Transaction Date</td>
                  <td style="padding:4px 0; color:#bbb;">${dateStr}</td>
                </tr>
                <tr>
                  <td style="padding:4px 0; color:#666;">Payment Status</td>
                  <td style="padding:4px 0; color:#4caf76; font-weight:700;">Confirmed</td>
                </tr>
                <tr>
                  <td style="padding:4px 0; color:#666;">Confirmation Sent To</td>
                  <td style="padding:4px 0; color:#bbb;">${customerEmail || '—'}</td>
                </tr>
              </table>
              <hr style="border:none; border-top:1px solid #2a2a2a; margin:28px 0 24px;">
              <div style="text-align:center;">
                <a href="${shopUrl}"
                   style="display:inline-block; background:#ffffff; color:#000000;
                          font-size:13px; font-weight:800; text-transform:uppercase;
                          letter-spacing:1px; text-decoration:none;
                          padding:14px 36px; border-radius:40px;">
                  Continue Shopping
                </a>
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 36px; border-top:1px solid #1a1a1a; text-align:center;">
              <p style="margin:0; font-size:11px; color:#444; line-height:1.6;">
                This email was sent by Hydro Sweep Services.<br>
                If you have questions about your order, please contact us at
                <a href="mailto:info@hydrosweepservices.com" style="color:#666; text-decoration:none;">info@hydrosweepservices.com</a>.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

async function sendOrderEmail(opts) {
  if (!EMAIL_READY) {
    console.warn('📧  [Shop] Email not configured — skipping order confirmation email.');
    return;
  }
  const { customerEmail, customerName, sessionId, transactionDate, receiptItems, amountTotal } = opts;
  if (!customerEmail) {
    console.warn('📧  [Shop] No customer email on session — skipping confirmation email.');
    return;
  }
  const shortOrder = sessionId ? sessionId.slice(-8) : 'ORDER';
  try {
    const info = await transporter.sendMail({
      from:    '"Hydro Sweep Services" <info@hydrosweepservices.com>',
      to:      customerEmail,
      subject: `Your Order Confirmation — Hydro Sweep Services (#${shortOrder})`,
      html:    buildOrderEmailHTML({ customerName, customerEmail, sessionId, transactionDate, receiptItems, amountTotal }),
      text: [
        'ORDER CONFIRMATION — HYDRO SWEEP SERVICES',
        '==========================================',
        '',
        `Hi ${customerName || customerEmail},`,
        '',
        'Thank you for your purchase! Your payment has been confirmed.',
        '',
        'ORDER DETAILS',
        '-------------',
        ...(receiptItems || []).map(i =>
          `${i.name}${i.quantity > 1 ? ` x${i.quantity}` : ''}: ${centsToUSD(i.totalAmount)}` +
          (i.description ? `\n  ${i.description}` : '')
        ),
        '',
        `Total Paid: ${centsToUSD(amountTotal)}`,
        'Shipping:   Free',
        '',
        'REFERENCE',
        '---------',
        `Order Number:     ${sessionId || '—'}`,
        `Transaction Date: ${formatEmailDate(transactionDate)}`,
        `Payment Status:   Confirmed`,
        '',
        'Questions? Email us at info@hydrosweepservices.com',
        '',
        'Hydro Sweep Services',
      ].join('\n'),
    });
    console.log(`📧  Order confirmation sent to ${customerEmail} (messageId: ${info.messageId})`);
  } catch (err) {
    // Never re-throw — a failed email must not crash the verify-session response
    console.error('📧  Failed to send order confirmation email:', err.message);
  }
}

// ─── Worldwide shipping country list ─────────────────────────────────────────
const SHIPPING_COUNTRIES = [
  'US', 'CA', 'MX', 'GB', 'IE', 'AU', 'NZ',
  'AT', 'BE', 'CH', 'DE', 'DK', 'ES', 'FI', 'FR', 'IT', 'LU', 'NL', 'NO', 'PT', 'SE',
  'BG', 'CY', 'CZ', 'EE', 'GR', 'HR', 'HU', 'LT', 'LV', 'MT', 'PL', 'RO', 'SI', 'SK',
  'AL', 'BA', 'IS', 'LI', 'ME', 'MK', 'RS', 'TR',
  'JP', 'KR', 'SG', 'HK', 'TW', 'IN', 'PH', 'TH', 'MY', 'ID', 'VN',
  'AE', 'SA', 'IL', 'QA', 'KW', 'BH',
  'ZA', 'NG', 'KE', 'GH', 'EG', 'MA',
  'BR', 'AR', 'CL', 'CO', 'PE', 'UY',
];

// ═════════════════════════════════════════════════════════════════════════════
// PAGE ROUTE HANDLERS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /shop
 * GET /shop/collections
 * GET /shop/collections/:slug
 * Serves the shop SPA shell. Client-side JS reads the URL and renders the
 * correct view (intro / collections grid / product PDP).
 */
export function getShopPage(req, res) {
  if (req.params.slug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(req.params.slug)) {
    return res.status(404).sendFile(path.join(__dirname, '..', 'public', '404.html'));
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'shop.html'));
}

/**
 * GET /shop/status
 * Post-payment result page. Verifies the session server-side before displaying.
 */
export function getShopStatusPage(_req, res) {
  res.sendFile(path.join(__dirname, '..', 'public', 'shop-status.html'));
}

// ═════════════════════════════════════════════════════════════════════════════
// API ROUTE HANDLERS — PRODUCTS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/products
 * Returns all in-stock products from MongoDB Atlas with sanitized image paths.
 */
export async function getProducts(_req, res) {
  try {
    const products = await Product.find({ inStock: true }).select('-__v').lean();
    res.json(products.map(p => sanitizeImagePaths(p)));
  } catch (err) {
    console.error('GET /api/products error:', err.message);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
}

/**
 * GET /api/products/:slug
 * Resolves slug → product title via the mapping collection, then fetches the product.
 * The mapping collection is read-only from the application — only editable in Atlas.
 */
export async function getProductBySlug(req, res) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(req.params.slug)) {
    return res.status(400).json({ error: 'Invalid slug format' });
  }
  try {
    const fullPath   = `/shop/collections/${req.params.slug}`;
    const mappingDoc = await Mapping.findById('69da9a93602cdd03a9098d9f').lean();
    if (!mappingDoc || !mappingDoc[fullPath]) {
      return res.status(404).json({ error: 'Route mapping not found for this slug' });
    }
    const product = await Product.findOne({ title: mappingDoc[fullPath] }).select('-__v').lean();
    if (!product) return res.status(404).json({ error: 'Product not found in database' });
    res.json(sanitizeImagePaths(product));
  } catch (err) {
    console.error('GET /api/products/:slug error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// API ROUTE HANDLERS — SOLD COUNTS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/sold-counts
 * Returns { slug: units_sold } map for all products.
 * Used by shop-script.js to display "X sold" on the PDP.
 */
export async function getSoldCounts(_req, res) {
  try {
    const counts = await Sold.find({}).select('slug units_sold -_id').lean();
    const map = {};
    counts.forEach(c => { map[c.slug] = c.units_sold; });
    res.json(map);
  } catch (err) {
    console.error('GET /api/sold-counts error:', err.message);
    res.status(500).json({ error: 'Failed to fetch sold counts' });
  }
}

/**
 * GET /api/sold-counts/:slug
 * Returns units_sold for a single product slug.
 */
export async function getSoldCountBySlug(req, res) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(req.params.slug)) {
    return res.status(400).json({ error: 'Invalid slug format' });
  }
  try {
    const record = await Sold.findOne({ slug: req.params.slug }).lean();
    res.json({ slug: req.params.slug, units_sold: record ? record.units_sold : 0 });
  } catch (err) {
    console.error('GET /api/sold-counts/:slug error:', err.message);
    res.status(500).json({ error: 'Failed to fetch sold count' });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// API ROUTE HANDLERS — STRIPE
// ═════════════════════════════════════════════════════════════════════════════

/**
 * POST /create-checkout-session
 * Body: { items: [{ slug, selectedSize, selectedColor, quantity }] }
 *
 * Prices are fetched from MongoDB — never from the client payload.
 * Any price update in Atlas is reflected in the next checkout automatically.
 * Returns { dev: true } when Stripe keys are not configured.
 */
export async function createCheckoutSession(req, res) {
  if (!STRIPE_READY) {
    return res.json({ dev: true, message: 'Stripe not configured.' });
  }

  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Cart is empty' });
  }
  if (items.length > 50) {
    return res.status(400).json({ error: 'Cart exceeds maximum item limit' });
  }
  for (const item of items) {
    if (typeof item.slug !== 'string' || !item.slug.trim()) {
      return res.status(400).json({ error: 'Each item must have a valid slug' });
    }
    if (typeof item.quantity !== 'number' || item.quantity < 1 || item.quantity > 99) {
      return res.status(400).json({ error: 'Item quantity must be between 1 and 99' });
    }
  }

  try {
    const slugs      = [...new Set(items.map(i => i.slug.trim().toLowerCase()))];
    const dbProducts = await Product.find({ slug: { $in: slugs }, inStock: true })
      .select('slug title priceUSD images')
      .lean();

    const productMap = {};
    dbProducts.forEach(p => { productMap[p.slug] = p; });

    const lineItems = [];
    for (const item of items) {
      const dbProduct = productMap[item.slug.trim().toLowerCase()];
      if (!dbProduct) {
        return res.status(400).json({ error: `Product not found or out of stock: ${item.slug}` });
      }

      const cleanProduct   = sanitizeImagePaths(dbProduct);
      const firstImage     = cleanProduct.images[0] || '';
      const stripeImageUrl = firstImage.startsWith('http')
        ? firstImage
        : firstImage ? `${process.env.BASE_URL}${firstImage}` : null;

      const descParts = [
        item.selectedSize  && item.selectedSize  !== 'NA' ? `Size: ${item.selectedSize}`  : null,
        item.selectedColor && item.selectedColor !== 'NA' ? `Color: ${item.selectedColor}` : null,
      ].filter(Boolean);

      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name:        dbProduct.title,
            images:      stripeImageUrl ? [stripeImageUrl] : [],
            description: descParts.join(' | ') || undefined,
          },
          unit_amount: Math.round(dbProduct.priceUSD * 100),
        },
        quantity: item.quantity || 1,
      });
    }

    const checkoutSession = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items:  lineItems,
      mode:        'payment',
      billing_address_collection:  'required',
      shipping_address_collection: { allowed_countries: SHIPPING_COUNTRIES },
      success_url: `${process.env.BASE_URL}/shop/status?status=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.BASE_URL}/shop/status?status=cancel`,
    });

    res.json({ url: checkoutSession.url });
  } catch (err) {
    console.error('[Shop] Stripe checkout error:', err.message);
    res.status(500).json({ error: 'Checkout failed' });
  }
}

/**
 * GET /api/verify-session
 * Verifies a Stripe session server-side after payment redirect.
 *
 * On the FIRST call for a given session_id:
 *   1. Inserts a ProcessedOrder record (idempotency guard).
 *   2. Increments units_sold in the Sold collection for each line item.
 *   3. Fires a confirmation email to the customer (non-blocking).
 *
 * On subsequent calls (page reload) all writes are skipped.
 */
export async function verifySession(req, res) {
  if (!STRIPE_READY) {
    return res.json({ status: 'dev', message: 'Stripe not configured' });
  }

  const { session_id } = req.query;
  if (!session_id || typeof session_id !== 'string') {
    return res.json({ status: 'cancelled' });
  }
  if (!session_id.startsWith('cs_')) {
    return res.status(400).json({ status: 'error', message: 'Invalid session ID format' });
  }

  try {
    const stripeSession = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ['line_items.data.price.product'],
    });

    if (stripeSession.payment_status !== 'paid') {
      return res.json({
        status:        stripeSession.payment_status,
        customerEmail: stripeSession.customer_details?.email || null,
      });
    }

    // ── Idempotent DB writes ──────────────────────────────────────────────────
    const alreadyProcessed = await ProcessedOrder.findOne({ session_id }).lean();

    if (!alreadyProcessed) {
      // Claim the session first — prevents race condition on double browser load
      await ProcessedOrder.create({ session_id });

      const stripeLineItems = stripeSession.line_items?.data || [];

      for (const lineItem of stripeLineItems) {
        const productName = lineItem.price?.product?.name || lineItem.description || '';
        const quantity    = lineItem.quantity || 1;

        if (productName) {
          const product = await Product.findOne({ title: productName }).select('slug').lean();
          if (product) {
            await Sold.findOneAndUpdate(
              { slug: product.slug },
              {
                $inc:         { units_sold: quantity },
                $setOnInsert: { name: productName },
              },
              { upsert: true, new: true }
            );
            console.log(`📦  [Shop] Sold count updated: ${product.slug} +${quantity}`);
          }
        }
      }

      // ── Send order confirmation email (fire-and-forget) ───────────────────
      // Intentionally NOT awaited at the outer level — SMTP latency must
      // never delay the JSON response the status page depends on.
      const receiptItemsForEmail = stripeLineItems.map(li => ({
        name:        li.price?.product?.name        || li.description || 'Item',
        description: li.price?.product?.description || '',
        quantity:    li.quantity || 1,
        unitAmount:  li.price?.unit_amount || 0,
        totalAmount: li.amount_total       || 0,
      }));

      sendOrderEmail({
        customerEmail:   stripeSession.customer_details?.email || null,
        customerName:    stripeSession.customer_details?.name  || null,
        sessionId:       session_id,
        transactionDate: new Date(stripeSession.created * 1000).toISOString(),
        receiptItems:    receiptItemsForEmail,
        amountTotal:     stripeSession.amount_total,
      });
    }

    // ── Build receipt items for the status page display ───────────────────────
    const receiptItems = (stripeSession.line_items?.data || []).map(li => ({
      name:        li.price?.product?.name        || li.description || 'Item',
      description: li.price?.product?.description || '',
      imageUrl:    li.price?.product?.images?.[0] || null,
      quantity:    li.quantity || 1,
      unitAmount:  li.price?.unit_amount || 0,
      totalAmount: li.amount_total       || 0,
    }));

    res.json({
      status:          'paid',
      customerEmail:   stripeSession.customer_details?.email || null,
      customerName:    stripeSession.customer_details?.name  || null,
      amountTotal:     stripeSession.amount_total,
      shippingAddress: stripeSession.shipping_details?.address || null,
      lineItems:       receiptItems,
      transactionDate: new Date(stripeSession.created * 1000).toISOString(),
    });
  } catch (err) {
    console.error('[Shop] Verify session error:', err.message);
    res.status(400).json({ status: 'error', message: 'Could not verify session' });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// STRIPE WEBHOOK — RAW BODY HANDLER
// Must be mounted in server.js BEFORE body parsers using express.raw():
//   app.post('/webhook', express.raw({ type: 'application/json' }), shopController.stripeWebhookRaw);
// ═════════════════════════════════════════════════════════════════════════════

export async function stripeWebhookRaw(req, res) {
  if (!WEBHOOK_READY) {
    console.warn('[Shop] Webhook received but STRIPE_WEBHOOK_SECRET not configured — ignoring.');
    return res.status(503).json({ error: 'Webhook secret not configured' });
  }

  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[Shop] Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    console.log('✅  [Shop] Payment confirmed via webhook:', event.data.object.id);
    // Sold-count incrementing and email are handled in verifySession() (idempotent).
    // The webhook is a secondary signal — no duplicate work done here.
  }

  res.json({ received: true });
}
