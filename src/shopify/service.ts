import { shopifyRequest } from './client.js';
import { GET_PRODUCT_QUERY, SEARCH_PRODUCTS_QUERY, SHOP_QUERY } from './queries.js';
import type {
  GetProductResponse,
  SearchProductsResponse,
  ShopResponse,
  ShopifyProductNode,
} from './types.js';

/** Shopify caps `first` at 250 for product connections. */
export const MAX_CANDIDATES = 250;

export interface FetchCandidatesArgs {
  /** Shopify product search syntax, or null to list the catalog. */
  searchQuery: string | null;
  /** How many candidates to pull before our own filtering/ranking. */
  first: number;
}

/**
 * Reusable Shopify reads. Route handlers and the connector go through these
 * functions — no GraphQL lives outside this folder.
 */

export async function fetchProductCandidates({
  searchQuery,
  first,
}: FetchCandidatesArgs): Promise<ShopifyProductNode[]> {
  const data = await shopifyRequest<SearchProductsResponse>(SEARCH_PRODUCTS_QUERY, {
    first: Math.min(Math.max(first, 1), MAX_CANDIDATES),
    query: searchQuery,
  });
  return data.products?.nodes?.filter((node): node is ShopifyProductNode => Boolean(node)) ?? [];
}

export async function fetchProductById(gid: string): Promise<ShopifyProductNode | null> {
  const data = await shopifyRequest<GetProductResponse>(GET_PRODUCT_QUERY, { id: gid });
  return data.product ?? null;
}

export async function fetchShop(): Promise<{ name: string; currencyCode: string } | null> {
  const data = await shopifyRequest<ShopResponse>(SHOP_QUERY);
  return data.shop ?? null;
}
