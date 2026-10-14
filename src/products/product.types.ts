/** Public, client-facing product shapes. Deliberately narrower than Shopify's. */

export interface ProductVariant {
  id: string;
  title: string;
  price: number;
  available: boolean;
  /** Null when the app cannot read inventory or Shopify does not track it. */
  inventory_quantity: number | null;
  options: Record<string, string>;
}

export interface Product {
  id: string;
  title: string;
  handle: string;
  url: string;
  description: string;
  /** Lowest price among available variants (falls back to lowest overall). */
  price: number;
  currency: string;
  image: string | null;
  available: boolean;
  variants: ProductVariant[];
  tags: string[];
  product_type: string;
  /**
   * Set only on search results, and only when the query named a product
   * category: `exact` when the product is that category, `related` when it is a
   * plausible substitute (a t-shirt for "shirt"). Lets an agent say "no shirts
   * matched, here are t-shirts" instead of passing a substitute off as the real
   * thing.
   */
  category_match?: 'exact' | 'related';
}

/** Everything in Product plus the extra detail the /api/products/:id route returns. */
export interface ProductDetail extends Omit<Product, 'image'> {
  images: string[];
  vendor: string;
  options: Array<{ name: string; values: string[] }>;
  price_range: { min: number; max: number };
  total_inventory: number | null;
}

export interface SearchParams {
  query: string;
  min_price?: number | null;
  max_price?: number | null;
  size?: string | null;
  color?: string | null;
  limit?: number | null;
}

/** Normalised params after validation — every optional resolved. */
export interface ResolvedSearchParams {
  query: string;
  minPrice: number | null;
  maxPrice: number | null;
  size: string | null;
  color: string | null;
  limit: number;
}

export interface SearchResult {
  products: Product[];
  total: number;
}
