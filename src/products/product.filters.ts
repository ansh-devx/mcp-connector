import { allTokens, containsTerm, normalize } from '../utils/text.js';
import type { Product, ProductVariant, ResolvedSearchParams } from './product.types.js';

/**
 * Post-Shopify filtering. Shopify's search gets us candidates; these predicates
 * enforce the shopper's hard constraints (price, size, colour, availability).
 */

const SIZE_ALIASES: Record<string, string> = {
  xs: 'xs', 'extra small': 'xs', 'x small': 'xs', xsmall: 'xs',
  s: 's', small: 's', sm: 's',
  m: 'm', medium: 'm', med: 'm',
  l: 'l', large: 'l', lg: 'l',
  xl: 'xl', 'extra large': 'xl', 'x large': 'xl', xlarge: 'xl',
  xxl: 'xxl', '2xl': 'xxl', 'xx large': 'xxl', '2x large': 'xxl', xxlarge: 'xxl',
  xxxl: 'xxxl', '3xl': 'xxxl', xxxlarge: 'xxxl',
  xxxxl: 'xxxxl', '4xl': 'xxxxl',
  'one size': 'os', 'free size': 'os', onesize: 'os', os: 'os', freesize: 'os',
};

/** Maps "Large", "l", "X Large" onto a single comparable token. */
export function canonicalSize(raw: string): string {
  const cleaned = normalize(raw).replace(/\bsize\b/g, '').trim();
  return SIZE_ALIASES[cleaned] ?? SIZE_ALIASES[cleaned.replace(/[\s-]/g, '')] ?? cleaned;
}

function isRecognisedSize(raw: string): boolean {
  const cleaned = normalize(raw);
  if (cleaned === '') return false;
  if (SIZE_ALIASES[cleaned] !== undefined) return true;
  if (SIZE_ALIASES[cleaned.replace(/[\s-]/g, '')] !== undefined) return true;
  // Numeric apparel/shoe sizes: "32", "32w", "10.5"
  return /^\d{1,3}(\.\d)?[a-z]{0,2}$/.test(cleaned);
}

function isSizeOptionName(name: string): boolean {
  return /size/i.test(name);
}

function isColorOptionName(name: string): boolean {
  return /colou?r|shade|tone/i.test(name);
}

/**
 * Sizes a single variant covers. Prefers an explicit "Size" option and falls
 * back to parsing the variant title ("Black / L", "L / Black").
 */
export function variantSizes(variant: ProductVariant): string[] {
  const fromOptions = Object.entries(variant.options)
    .filter(([name]) => isSizeOptionName(name))
    .map(([, value]) => canonicalSize(value))
    .filter((s) => s.length > 0);
  if (fromOptions.length > 0) return fromOptions;

  return variant.title
    .split('/')
    .map((part) => part.trim())
    .filter((part) => isRecognisedSize(part))
    .map((part) => canonicalSize(part));
}

export function variantMatchesSize(variant: ProductVariant, requestedSize: string): boolean {
  const wanted = canonicalSize(requestedSize);
  if (wanted === '') return false;
  const sizes = variantSizes(variant);
  if (sizes.includes(wanted)) return true;
  // Unstructured variant naming: fall back to a whole-word title match.
  if (sizes.length === 0) return containsTerm(variant.title, requestedSize);
  return false;
}

/** True when the product can actually be bought in that size right now. */
export function hasAvailableVariantInSize(product: Product, requestedSize: string): boolean {
  return product.variants.some((v) => v.available && variantMatchesSize(v, requestedSize));
}

/** Every piece of product text worth matching a colour against. */
export function colorHaystacks(product: Product): string[] {
  const haystacks: string[] = [product.title, product.product_type, ...product.tags];
  for (const variant of product.variants) {
    haystacks.push(variant.title);
    // Any option value may carry the colour; the "Colour" option is just the clearest.
    haystacks.push(...Object.values(variant.options));
  }
  return haystacks.filter((h) => typeof h === 'string' && h.length > 0);
}

export function matchesColor(product: Product, requestedColor: string): boolean {
  const wanted = normalize(requestedColor);
  if (wanted === '') return false;
  return colorHaystacks(product).some(
    (haystack) => containsTerm(haystack, wanted) || normalize(haystack).includes(wanted),
  );
}

/** True when this specific variant carries the requested colour. */
export function variantMatchesColor(variant: ProductVariant, requestedColor: string): boolean {
  const wanted = normalize(requestedColor);
  if (wanted === '') return false;
  const colorValues = Object.entries(variant.options)
    .filter(([name]) => isColorOptionName(name))
    .map(([, value]) => value);
  const candidates = colorValues.length > 0 ? colorValues : Object.values(variant.options);
  return (
    containsTerm(variant.title, wanted) ||
    normalize(variant.title).includes(wanted) ||
    candidates.some((value) => normalize(value).includes(wanted))
  );
}

/** Does the product model colour as a variant dimension at all? */
export function hasColorDimension(product: Product): boolean {
  return product.variants.some((v) => Object.keys(v.options).some(isColorOptionName));
}

/**
 * Size *and* colour must be satisfied by the SAME purchasable variant.
 * Checking them independently would happily return a shirt that comes in black
 * and comes in L, but has no black L in stock.
 */
export function hasAvailableVariantMatching(
  product: Product,
  requestedSize: string,
  requestedColor: string,
): boolean {
  return product.variants.some(
    (v) =>
      v.available && variantMatchesSize(v, requestedSize) && variantMatchesColor(v, requestedColor),
  );
}

/** Colour matched on a variant that is actually in stock — a strong ranking signal. */
export function hasAvailableVariantInColor(product: Product, requestedColor: string): boolean {
  return product.variants.some((v) => v.available && variantMatchesColor(v, requestedColor));
}

function priceInRange(price: number, min: number | null, max: number | null): boolean {
  if (min !== null && price < min) return false;
  if (max !== null && price > max) return false;
  return true;
}

/**
 * The in-stock variants that satisfy the shopper's size and colour constraints —
 * i.e. the variants they could actually put in a basket.
 *
 * Price has to be judged against these, not against every available variant.
 * A shirt whose Black/L costs 2599 is over a 2500 budget even if some unrelated
 * Orange/S variant is 2199, and quoting the 2199 would be a lie.
 *
 * The colour constraint is only applied per-variant when colour is a real variant
 * dimension, mirroring `applyFilters`: products that mention colour only in the
 * title would otherwise match nothing.
 */
export function eligibleVariants(
  product: Product,
  params: Pick<ResolvedSearchParams, 'size' | 'color'>,
): ProductVariant[] {
  const colorIsVariantLevel = params.color !== null && hasColorDimension(product);
  return product.variants.filter((variant) => {
    if (!variant.available) return false;
    if (params.size !== null && !variantMatchesSize(variant, params.size)) return false;
    if (colorIsVariantLevel && !variantMatchesColor(variant, params.color as string)) return false;
    return true;
  });
}

/**
 * Price check runs against buyable variants so we never advertise an unbuyable price.
 *
 * Pass `eligible` (from `eligibleVariants`) to narrow the check to the variants
 * matching the shopper's size/colour filters. When that set is empty the product
 * is already excluded by the size/colour predicates, so we fall back to the
 * unfiltered behaviour rather than rejecting on a technicality.
 */
export function matchesPrice(
  product: Product,
  min: number | null,
  max: number | null,
  eligible?: ProductVariant[],
): boolean {
  if (min === null && max === null) return true;
  if (eligible !== undefined && eligible.length > 0) {
    return eligible.some((v) => priceInRange(v.price, min, max));
  }
  const purchasable = product.variants.filter((v) => v.available);
  if (purchasable.length > 0) {
    return purchasable.some((v) => priceInRange(v.price, min, max));
  }
  return priceInRange(product.price, min, max);
}

/**
 * Lowest price among the variants that match the shopper's filters, so `price`
 * is what they would actually pay for the thing they asked for. Falls back to
 * the product's own display price when no filter is active.
 */
export function priceForParams(product: Product, eligible: ProductVariant[]): number {
  if (eligible.length === 0) return product.price;
  return Math.min(...eligible.map((v) => v.price));
}

export function isAvailable(product: Product): boolean {
  return product.available && product.variants.some((v) => v.available);
}

/** Query terms that the product text actually contains — reused by ranking. */
export function matchedTerms(product: Product, terms: string[]): string[] {
  const haystack = normalize(
    [product.title, product.product_type, product.tags.join(' '), product.description].join(' '),
  );
  const tokens = new Set(allTokens(haystack));
  return terms.filter((term) => tokens.has(term) || haystack.includes(term));
}

/** Applies every hard constraint. Order is cheapest-check-first. */
export function applyFilters(products: Product[], params: ResolvedSearchParams): Product[] {
  return products.filter((product) => {
    if (!isAvailable(product)) return false;
    // Price is judged against the variants the shopper's filters actually allow.
    if (!matchesPrice(product, params.minPrice, params.maxPrice, eligibleVariants(product, params))) {
      return false;
    }
    if (params.size !== null && params.color !== null && hasColorDimension(product)) {
      // Both constraints given and colour is a real variant dimension:
      // one single in-stock variant has to satisfy both.
      return hasAvailableVariantMatching(product, params.size, params.color);
    }
    if (params.size !== null && !hasAvailableVariantInSize(product, params.size)) return false;
    if (params.color !== null && !matchesColor(product, params.color)) return false;
    return true;
  });
}
