/**
 * models/Product.js
 * Mongoose schema for the "products" collection (MongoDB Atlas, DB: test).
 *
 * Converted to ES Module syntax to match the main project's "type":"module".
 * Uses the mongoose.models guard so hot-reloads and multiple imports
 * never attempt to re-register the same model.
 *
 * To update a product (price, sizes, colors, title) go to MongoDB Atlas →
 * Cluster login1 → Database test → Collection products → Edit document.
 * Changes are live immediately — no server restart needed.
 */

import mongoose from 'mongoose';

const ProductSchema = new mongoose.Schema(
  {
    title:    { type: String, required: true, trim: true },
    slug:     { type: String, required: true, trim: true, unique: true, lowercase: true },
    priceUSD: { type: Number, required: true, min: 0 },
    sizes:    { type: [String], default: [] },   // ["S", "M", "L"] or ["NA"]
    colors:   { type: [String], default: [] },   // ["Black", "White"] or ["NA"]
    images:   { type: [String], default: [] },   // relative paths or full URLs
    inStock:  { type: Boolean, default: true },
    category: { type: String, default: '' },
  },
  {
    collection: 'products',
    timestamps: false,
  }
);

const Product = mongoose.models.Product || mongoose.model('Product', ProductSchema);

export default Product;
