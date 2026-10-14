import './setup.env.js';
import type { ShopifyProductNode, ShopifyVariantNode } from '../src/shopify/types.js';

/**
 * A correctly-shaped but entirely fake Shopify Admin token.
 *
 * Assembled at runtime on purpose. `shpat_` followed by exactly 32 hex
 * characters is GitHub's Shopify-token signature, so writing one as a literal
 * trips secret-scanning push protection on every push, clone and fork — and
 * training people to click "allow this secret" is how a real one eventually
 * gets through. The assembled value has the real shape, so redaction tests
 * exercise exactly the same code path.
 */
export const FAKE_SHOPIFY_TOKEN = `shpat_${'abcdef0123456789'.repeat(2)}`;

let variantSeq = 1;

export interface VariantSpec {
  color?: string;
  size?: string;
  price: number;
  available: boolean;
  inventory?: number | null;
  /** Overrides the generated "Colour / Size" title. */
  title?: string;
  /** Emits a variant with no selectedOptions, to exercise title parsing. */
  withoutOptions?: boolean;
}

export function makeVariant(spec: VariantSpec): ShopifyVariantNode {
  const parts = [spec.color, spec.size].filter(Boolean) as string[];
  const options = spec.withoutOptions
    ? []
    : [
        ...(spec.color ? [{ name: 'Colour', value: spec.color }] : []),
        ...(spec.size ? [{ name: 'Size', value: spec.size }] : []),
      ];
  return {
    id: `gid://shopify/ProductVariant/${variantSeq++}`,
    title: spec.title ?? parts.join(' / '),
    sku: null,
    price: spec.price.toFixed(2),
    availableForSale: spec.available,
    inventoryQuantity: spec.inventory === undefined ? (spec.available ? 5 : 0) : spec.inventory,
    selectedOptions: spec.withoutOptions ? null : options,
  };
}

export interface ProductSpec {
  id: string;
  title: string;
  handle?: string;
  description?: string;
  productType?: string;
  tags?: string[];
  variants: VariantSpec[];
  image?: string | null;
  currency?: string;
}

export function makeProductNode(spec: ProductSpec): ShopifyProductNode {
  const variants = spec.variants.map(makeVariant);
  const prices = variants.map((v) => Number(v.price));
  const currency = spec.currency ?? 'INR';
  const handle = spec.handle ?? spec.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const image = spec.image === undefined ? `https://cdn.example.com/${handle}.jpg` : spec.image;

  return {
    id: spec.id,
    title: spec.title,
    handle,
    description: spec.description ?? '',
    productType: spec.productType ?? 'Shirt',
    vendor: 'Test Vendor',
    tags: spec.tags ?? [],
    status: 'ACTIVE',
    totalInventory: variants.reduce((sum, v) => sum + (v.inventoryQuantity ?? 0), 0),
    featuredImage: image === null ? null : { url: image, altText: null },
    media:
      image === null
        ? { nodes: [{}] }
        : { nodes: [{ image: { url: image, altText: '' } }, {}, { image: { url: `${image}?2`, altText: '' } }] },
    options: [
      { name: 'Colour', values: [...new Set(spec.variants.map((v) => v.color ?? ''))].filter(Boolean) },
      { name: 'Size', values: [...new Set(spec.variants.map((v) => v.size ?? ''))].filter(Boolean) },
    ],
    priceRangeV2: {
      minVariantPrice: { amount: Math.min(...prices).toFixed(2), currencyCode: currency },
      maxVariantPrice: { amount: Math.max(...prices).toFixed(2), currencyCode: currency },
    },
    variants: { nodes: variants },
  };
}

/** A small, deliberately varied catalog used across the test suite. */
export function catalog(): ShopifyProductNode[] {
  return [
    makeProductNode({
      id: 'gid://shopify/Product/1',
      title: 'Classic Black Shirt',
      productType: 'Shirt',
      tags: ['black', 'shirt', 'casual'],
      description: 'A casual black cotton shirt, great for dinner.',
      variants: [
        { color: 'Black', size: 'S', price: 1799, available: false, inventory: 0 },
        { color: 'Black', size: 'M', price: 1799, available: true, inventory: 6 },
        { color: 'Black', size: 'L', price: 1799, available: true, inventory: 10 },
      ],
    }),
    makeProductNode({
      id: 'gid://shopify/Product/2',
      title: 'White Linen Shirt',
      productType: 'Shirt',
      tags: ['white', 'shirt', 'formal'],
      variants: [
        { color: 'White', size: 'M', price: 2499, available: true },
        { color: 'White', size: 'L', price: 2499, available: true },
      ],
    }),
    makeProductNode({
      id: 'gid://shopify/Product/3',
      title: 'Premium Black Silk Shirt',
      productType: 'Shirt',
      tags: ['black', 'shirt', 'premium'],
      variants: [
        { color: 'Black', size: 'L', price: 5999, available: true },
        { color: 'Black', size: 'XL', price: 5999, available: true },
      ],
    }),
    makeProductNode({
      id: 'gid://shopify/Product/4',
      title: 'Sold Out Black Shirt',
      productType: 'Shirt',
      tags: ['black', 'shirt'],
      variants: [
        { color: 'Black', size: 'M', price: 999, available: false, inventory: 0 },
        { color: 'Black', size: 'L', price: 999, available: false, inventory: 0 },
      ],
    }),
    makeProductNode({
      id: 'gid://shopify/Product/5',
      title: 'Blue Denim Jacket',
      productType: 'Jacket',
      tags: ['blue', 'jacket'],
      variants: [{ color: 'Blue', size: 'L', price: 3499, available: true }],
    }),
    makeProductNode({
      id: 'gid://shopify/Product/6',
      title: 'Black Regular Fit Shirt',
      productType: 'Shirt',
      tags: ['black', 'shirt', 'regular fit'],
      variants: [
        // "Large" spelled out, and a variant whose size only appears in the title.
        { color: 'Black', size: 'Large', price: 2199, available: true },
        { price: 2199, available: true, title: 'Black / XXL', withoutOptions: true },
      ],
    }),
  ];
}

/** Builds a fetchCandidates stub that ignores the Shopify query string. */
export function stubCandidates(nodes: ShopifyProductNode[] = catalog()): {
  fetchCandidates: (args: { searchQuery: string | null; first: number }) => Promise<ShopifyProductNode[]>;
  calls: Array<{ searchQuery: string | null; first: number }>;
} {
  const calls: Array<{ searchQuery: string | null; first: number }> = [];
  return {
    calls,
    fetchCandidates: async (args) => {
      calls.push(args);
      return nodes;
    },
  };
}
