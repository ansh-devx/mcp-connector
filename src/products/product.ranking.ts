import { containsTerm, normalize, tokenize } from '../utils/text.js';
import { categoryMatch, inferCategory } from './product.category.js';
import {
  hasAvailableVariantInColor,
  hasAvailableVariantInSize,
  matchesColor,
} from './product.filters.js';
import type { Product, ResolvedSearchParams } from './product.types.js';

/**
 * Deterministic relevance scoring — no embeddings, no model calls.
 *
 * This module is intentionally self-contained: swapping it for a semantic
 * ranker later means replacing `scoreProduct`/`rankProducts` and nothing else.
 */

export const WEIGHTS = {
  exactTitleMatch: 60,
  titleStartsWithQuery: 30,
  titlePhraseMatch: 25,
  termInTitle: 10,
  termInProductType: 6,
  termInTags: 5,
  termInDescription: 2,
  /** Cap description credit so a long description cannot outrank a real title match. */
  maxDescriptionScore: 6,
  /**
   * Category signals are deliberately large. "shirt" tokenizes into "T-Shirt",
   * so without them a t-shirt scores identically to a real shirt and silently
   * takes its place; the penalty has to outweigh the term/type/tag credit a
   * near-miss collects.
   */
  categoryExact: 25,
  categoryMismatch: -30,
  colorInStock: 14,
  colorMatch: 8,
  sizeInStock: 12,
  hasAvailableVariant: 5,
  withinBudget: 3,
  hasImage: 1,
} as const;

export interface ScoredProduct {
  product: Product;
  score: number;
  /** Human-readable explanation, handy when debugging ranking behaviour. */
  reasons: string[];
}

export function scoreProduct(product: Product, params: ResolvedSearchParams): ScoredProduct {
  const reasons: string[] = [];
  let score = 0;

  const add = (points: number, reason: string): void => {
    if (points === 0) return;
    score += points;
    reasons.push(`${reason} (+${points})`);
  };

  const query = normalize(params.query);
  const title = normalize(product.title);
  const terms = tokenize(params.query);

  if (query.length > 0) {
    if (title === query) {
      add(WEIGHTS.exactTitleMatch, 'exact title match');
    } else if (title.startsWith(query)) {
      add(WEIGHTS.titleStartsWithQuery, 'title starts with query');
    } else if (title.includes(query)) {
      add(WEIGHTS.titlePhraseMatch, 'title contains full query');
    }
  }

  const tagText = product.tags.join(' ');
  let descriptionScore = 0;

  for (const term of terms) {
    if (containsTerm(title, term)) add(WEIGHTS.termInTitle, `"${term}" in title`);
    if (containsTerm(product.product_type, term)) {
      add(WEIGHTS.termInProductType, `"${term}" in product type`);
    }
    if (containsTerm(tagText, term)) add(WEIGHTS.termInTags, `"${term}" in tags`);
    if (
      descriptionScore < WEIGHTS.maxDescriptionScore &&
      containsTerm(product.description, term)
    ) {
      descriptionScore += WEIGHTS.termInDescription;
      add(WEIGHTS.termInDescription, `"${term}" in description`);
    }
  }

  // Did the shopper name a product category, and is this actually one?
  const requestedCategory = inferCategory(params.query);
  const match = categoryMatch(product, requestedCategory);
  if (match === 'exact') {
    add(WEIGHTS.categoryExact, `is a ${requestedCategory}`);
  } else if (match === 'related') {
    add(WEIGHTS.categoryMismatch, `not a ${requestedCategory}`);
  }

  if (params.color !== null) {
    if (hasAvailableVariantInColor(product, params.color)) {
      add(WEIGHTS.colorInStock, `${params.color} available`);
    } else if (matchesColor(product, params.color)) {
      add(WEIGHTS.colorMatch, `${params.color} mentioned`);
    }
  }

  if (params.size !== null && hasAvailableVariantInSize(product, params.size)) {
    add(WEIGHTS.sizeInStock, `size ${params.size} in stock`);
  }

  if (product.available) add(WEIGHTS.hasAvailableVariant, 'in stock');
  if (params.maxPrice !== null && product.price <= params.maxPrice) {
    add(WEIGHTS.withinBudget, 'within budget');
  }
  if (product.image !== null) add(WEIGHTS.hasImage, 'has image');

  return { product, score, reasons };
}

/**
 * Sorts by score desc. Ties break on price asc then title, so identical inputs
 * always produce identical output (important for cacheable, testable results).
 */
export function rankProducts(
  products: Product[],
  params: ResolvedSearchParams,
): ScoredProduct[] {
  return products
    .map((product) => scoreProduct(product, params))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.product.price !== b.product.price) return a.product.price - b.product.price;
      return a.product.title.localeCompare(b.product.title);
    });
}
