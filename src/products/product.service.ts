import { getConfig } from '../config/index.js';
import { fetchProductById, fetchProductCandidates } from '../shopify/service.js';
import { NotFoundError } from '../utils/errors.js';
import { toProductDetail } from './product.mapper.js';
import { searchProducts, type SearchDependencies } from './product.search.js';
import type { ProductDetail, ResolvedSearchParams, SearchResult } from './product.types.js';
import { normalizeProductId, validateSearchParams } from './product.validation.js';

/**
 * The single entry point used by both the REST routes and the connector tools.
 * Everything above this layer deals in plain objects, never GraphQL.
 */

export interface SearchOutcome extends SearchResult {
  /** Normalised params, echoed back for logging and debugging. */
  params: ResolvedSearchParams;
  topScore: number | null;
}

function defaultDependencies(): SearchDependencies {
  return {
    fetchCandidates: fetchProductCandidates,
    storefrontUrl: getConfig().shopify.storefrontUrl,
  };
}

/** Validates raw input, then runs the search pipeline. Throws BadRequestError on bad input. */
export async function searchProductsService(
  input: unknown,
  deps: SearchDependencies = defaultDependencies(),
): Promise<SearchOutcome> {
  const params = validateSearchParams(input);
  const { products, total, scored } = await searchProducts(params, deps);
  return { products, total, params, topScore: scored[0]?.score ?? null };
}

export interface ProductLookupDependencies {
  fetchProduct: (gid: string) => Promise<Parameters<typeof toProductDetail>[0] | null>;
  storefrontUrl?: string;
}

/** Throws BadRequestError for a malformed id and NotFoundError when it does not exist. */
export async function getProductService(
  rawId: unknown,
  deps: ProductLookupDependencies = {
    fetchProduct: fetchProductById,
    storefrontUrl: getConfig().shopify.storefrontUrl,
  },
): Promise<ProductDetail> {
  const gid = normalizeProductId(rawId);
  const node = await deps.fetchProduct(gid);
  if (node === null) throw new NotFoundError(`No product found for id "${gid}".`);
  return toProductDetail(node, deps.storefrontUrl);
}
