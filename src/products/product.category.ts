import { normalize } from '../utils/text.js';
import type { Product } from './product.types.js';

/**
 * Product-category inference.
 *
 * Token matching cannot tell a shirt from a t-shirt: `normalize("T-Shirt")` is
 * `"t-shirt"`, which tokenizes to `["t", "shirt"]`, so the term "shirt" scores
 * against a T-shirt exactly as strongly as against a real shirt. The catalog
 * then silently substitutes one for the other.
 *
 * These rules match against the whole normalised phrase instead, most specific
 * first, so "t-shirt" is claimed before the generic "shirt" rule ever sees it.
 */

export type ProductCategory =
  | 'tshirt'
  | 'shirt'
  | 'polo'
  | 'sweatshirt'
  | 'dress'
  | 'jeans'
  | 'trousers'
  | 'shorts'
  | 'skirt'
  | 'jacket';

interface CategoryRule {
  category: ProductCategory;
  pattern: RegExp;
}

/**
 * Order is the logic here — the first match wins.
 *
 * `\b` anchors matter: they are what stops "sweatshirt" and "knit shirt" from
 * matching the bare `shirt` rule through a substring.
 */
const CATEGORY_RULES: CategoryRule[] = [
  // "dress shirt" is a shirt, not a dress: claim it before the dress rule.
  { category: 'shirt', pattern: /\bdress\s+shirts?\b/ },
  { category: 'tshirt', pattern: /\b(t[\s-]?shirts?|tshirts?|tees?)\b/ },
  { category: 'sweatshirt', pattern: /\b(sweat[\s-]?shirts?|hoodies?|sweaters?|jumpers?|cardigans?|pullovers?)\b/ },
  // Before `polo`, so a "Polo Dress" reads as a dress rather than a polo.
  { category: 'dress', pattern: /\bdress(es)?\b/ },
  { category: 'polo', pattern: /\bpolos?\b/ },
  { category: 'shirt', pattern: /\bshirts?\b/ },
  // Garment beats material: a "denim jacket" is a jacket, so this precedes `jeans`.
  { category: 'jacket', pattern: /\b(jackets?|coats?|blazers?|parkas?|gilets?|windbreakers?)\b/ },
  { category: 'jeans', pattern: /\b(jeans?|denims?)\b/ },
  { category: 'trousers', pattern: /\b(trousers?|pants?|chinos?|joggers?|leggings?)\b/ },
  { category: 'shorts', pattern: /\bshorts\b/ },
  { category: 'skirt', pattern: /\bskirts?\b/ },
];

/** The category a phrase names, or null when it names none. */
export function inferCategory(text: string): ProductCategory | null {
  if (!text) return null;
  const haystack = normalize(text);
  if (haystack === '') return null;
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(haystack)) return rule.category;
  }
  return null;
}

/**
 * What the product actually is. `product_type` is the merchant's own
 * classification and by far the most reliable signal, so it is tried first;
 * title and tags are fallbacks for stores that leave it blank.
 */
export function productCategory(product: Product): ProductCategory | null {
  return (
    inferCategory(product.product_type) ??
    inferCategory(product.title) ??
    inferCategory(product.tags.join(' '))
  );
}

/**
 * How well a product answers the category the shopper named.
 *
 * `exact`   — the shopper asked for a shirt and this is a shirt.
 * `related` — the shopper asked for a shirt and this is a t-shirt: a plausible
 *             substitute, but the agent must be able to say so rather than
 *             presenting it as the thing that was asked for.
 * `null`    — the query named no category, so there is nothing to judge.
 */
export type CategoryMatch = 'exact' | 'related';

export function categoryMatch(
  product: Product,
  requested: ProductCategory | null,
): CategoryMatch | null {
  if (requested === null) return null;
  const actual = productCategory(product);
  if (actual === null) return null;
  return actual === requested ? 'exact' : 'related';
}
