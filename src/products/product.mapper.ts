import { getConfig } from '../config/index.js';
import type { ShopifyProductNode, ShopifyVariantNode } from '../shopify/types.js';
import type { Product, ProductDetail, ProductVariant } from './product.types.js';

/** Shopify money arrives as a decimal string; keep 2dp and never emit NaN. */
export function parsePrice(raw: string | null | undefined): number {
  if (raw === null || raw === undefined) return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.round(value * 100) / 100;
}

function mapVariant(node: ShopifyVariantNode): ProductVariant {
  const options: Record<string, string> = {};
  for (const option of node.selectedOptions ?? []) {
    if (option?.name && option?.value) options[option.name] = option.value;
  }
  return {
    id: node.id,
    title: node.title ?? Object.values(options).join(' / ') ?? '',
    price: parsePrice(node.price),
    available: node.availableForSale === true,
    inventory_quantity: typeof node.inventoryQuantity === 'number' ? node.inventoryQuantity : null,
    options,
  };
}

function collectImages(node: ShopifyProductNode): string[] {
  const urls: string[] = [];
  const push = (url: string | null | undefined): void => {
    if (typeof url === 'string' && url.length > 0 && !urls.includes(url)) urls.push(url);
  };
  push(node.featuredImage?.url);
  // Non-image media (video, 3D models) arrive without an `image` field.
  for (const media of node.media?.nodes ?? []) push(media?.image?.url);
  return urls;
}

function storefrontProductUrl(handle: string, storefrontUrl?: string): string {
  const base = storefrontUrl ?? getConfig().shopify.storefrontUrl;
  return `${base.replace(/\/+$/, '')}/products/${handle}`;
}

/** Lowest price a shopper can actually buy at, falling back to the cheapest variant. */
function displayPrice(variants: ProductVariant[], fallback: number): number {
  const purchasable = variants.filter((v) => v.available).map((v) => v.price);
  if (purchasable.length > 0) return Math.min(...purchasable);
  const all = variants.map((v) => v.price);
  return all.length > 0 ? Math.min(...all) : fallback;
}

/**
 * Shopify node -> public Product. Tolerates missing/malformed fields rather than
 * throwing, so one bad product never fails an entire search.
 */
export function toProduct(node: ShopifyProductNode, storefrontUrl?: string): Product {
  const variants = (node.variants?.nodes ?? []).filter(Boolean).map(mapVariant);
  const handle = node.handle ?? '';
  const images = collectImages(node);
  const fallbackPrice = parsePrice(node.priceRangeV2?.minVariantPrice?.amount);

  return {
    id: node.id,
    title: node.title ?? 'Untitled product',
    handle,
    url: storefrontProductUrl(handle, storefrontUrl),
    description: node.description ?? '',
    price: displayPrice(variants, fallbackPrice),
    currency: node.priceRangeV2?.minVariantPrice?.currencyCode ?? 'USD',
    image: images[0] ?? null,
    available: variants.some((v) => v.available),
    variants,
    tags: (node.tags ?? []).filter((t): t is string => typeof t === 'string'),
    product_type: node.productType ?? '',
  };
}

/** Same data plus the extras the single-product endpoint returns. */
export function toProductDetail(node: ShopifyProductNode, storefrontUrl?: string): ProductDetail {
  const base = toProduct(node, storefrontUrl);
  const { image: _image, ...rest } = base;
  const prices = base.variants.map((v) => v.price);
  const min = prices.length > 0 ? Math.min(...prices) : base.price;
  const max = prices.length > 0 ? Math.max(...prices) : base.price;

  return {
    ...rest,
    images: collectImages(node),
    vendor: node.vendor ?? '',
    options: (node.options ?? []).map((o) => ({
      name: o?.name ?? '',
      values: (o?.values ?? []).filter((v): v is string => typeof v === 'string'),
    })),
    price_range: {
      min: parsePrice(node.priceRangeV2?.minVariantPrice?.amount) || min,
      max: parsePrice(node.priceRangeV2?.maxVariantPrice?.amount) || max,
    },
    total_inventory: typeof node.totalInventory === 'number' ? node.totalInventory : null,
  };
}
