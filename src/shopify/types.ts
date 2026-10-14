/** Raw shapes returned by the Shopify Admin GraphQL API (only the fields we ask for). */

export interface ShopifyMoney {
  amount: string;
  currencyCode: string;
}

export interface ShopifyImage {
  url: string;
  altText: string | null;
}

export interface ShopifySelectedOption {
  name: string;
  value: string;
}

export interface ShopifyVariantNode {
  id: string;
  title: string | null;
  sku: string | null;
  price: string | null;
  availableForSale: boolean | null;
  inventoryQuantity: number | null;
  selectedOptions: ShopifySelectedOption[] | null;
}

export interface ShopifyProductOption {
  name: string;
  values: string[];
}

export interface ShopifyProductNode {
  id: string;
  title: string | null;
  handle: string | null;
  description: string | null;
  productType: string | null;
  vendor: string | null;
  tags: string[] | null;
  status: string | null;
  totalInventory: number | null;
  featuredImage: ShopifyImage | null;
  /** Non-image media (video, 3D) arrives as an empty object, hence the optional image. */
  media: { nodes: Array<{ image?: ShopifyImage | null }> } | null;
  options: ShopifyProductOption[] | null;
  priceRangeV2: {
    minVariantPrice: ShopifyMoney | null;
    maxVariantPrice: ShopifyMoney | null;
  } | null;
  variants: { nodes: ShopifyVariantNode[] } | null;
}

export interface SearchProductsResponse {
  products: { nodes: ShopifyProductNode[] } | null;
}

export interface GetProductResponse {
  product: ShopifyProductNode | null;
}

export interface ShopResponse {
  shop: { name: string; currencyCode: string } | null;
}
