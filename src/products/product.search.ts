import { escapeShopifyQueryValue, normalize, tokenize } from '../utils/text.js';
import type { ShopifyProductNode } from '../shopify/types.js';
import { categoryMatch, inferCategory } from './product.category.js';
import { applyFilters, eligibleVariants, priceForParams } from './product.filters.js';
import { toProduct } from './product.mapper.js';
import { rankProducts, type ScoredProduct } from './product.ranking.js';
import type { Product, ResolvedSearchParams, SearchResult } from './product.types.js';

/**
 * Search orchestration: build a Shopify query -> fetch candidates -> filter
 * locally -> rank -> trim. Shopify does the recall, we do the precision.
 */

/** Pull well beyond `limit` so local filtering still has something to rank. */
export function candidatePoolSize(limit: number): number {
  return Math.min(Math.max(limit * 10, 40), 100);
}

function quoteTerm(term: string): string {
  return `"${escapeShopifyQueryValue(term)}"`;
}

/**
 * Builds Shopify product-search syntax.
 *
 * `strict` ANDs every term (high precision). `broad` ORs them (high recall) and
 * is used as a fallback when the strict pass under-delivers — that is what makes
 * "something casual for a dinner" return results instead of nothing.
 */
export function buildShopifyQuery(params: ResolvedSearchParams, mode: 'strict' | 'broad'): string {
  const terms = tokenize(params.query);

  const extras: string[] = [];
  const color = params.color === null ? null : normalize(params.color);
  if (color !== null && color !== '' && !terms.includes(color)) extras.push(color);

  const searchable = [...terms, ...extras];
  // Only published products are worth recommending to a shopper.
  const scope = 'status:ACTIVE';

  if (searchable.length === 0) return scope;

  const joined =
    mode === 'strict'
      ? searchable.map(quoteTerm).join(' AND ')
      : searchable.map(quoteTerm).join(' OR ');

  return `${scope} AND (${joined})`;
}

export interface SearchDependencies {
  /** Injected so tests can run without touching Shopify. */
  fetchCandidates: (args: { searchQuery: string | null; first: number }) => Promise<
    ShopifyProductNode[]
  >;
  storefrontUrl?: string;
}

function dedupeById(products: Product[]): Product[] {
  const seen = new Set<string>();
  return products.filter((p) => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });
}

/** Full pipeline. Returns ranked products plus the scores (used for logging). */
export async function searchProducts(
  params: ResolvedSearchParams,
  deps: SearchDependencies,
): Promise<SearchResult & { scored: ScoredProduct[] }> {
  const first = candidatePoolSize(params.limit);

  const strictNodes = await deps.fetchCandidates({
    searchQuery: buildShopifyQuery(params, 'strict'),
    first,
  });

  let candidates = dedupeById(strictNodes.map((node) => toProduct(node, deps.storefrontUrl)));
  let matches = applyFilters(candidates, params);

  // Broaden only when the precise pass could not fill the page.
  if (matches.length < params.limit) {
    const broadQuery = buildShopifyQuery(params, 'broad');
    if (broadQuery !== buildShopifyQuery(params, 'strict')) {
      const broadNodes = await deps.fetchCandidates({ searchQuery: broadQuery, first });
      candidates = dedupeById([
        ...candidates,
        ...broadNodes.map((node) => toProduct(node, deps.storefrontUrl)),
      ]);
      matches = applyFilters(candidates, params);
    }
  }

  // Re-price against the variants the filters actually allow, and label whether
  // each product is the category the shopper asked for. Both have to happen
  // before ranking: `price` feeds the budget bonus and the tie-break.
  const requestedCategory = inferCategory(params.query);
  const annotated = matches.map((product) => {
    const eligible = eligibleVariants(product, params);
    const match = categoryMatch(product, requestedCategory);
    return {
      ...product,
      price: priceForParams(product, eligible),
      ...(match === null ? {} : { category_match: match }),
    };
  });

  const scored = rankProducts(annotated, params);
  const products = scored.slice(0, params.limit).map((s) => s.product);

  return { products, total: products.length, scored };
}
