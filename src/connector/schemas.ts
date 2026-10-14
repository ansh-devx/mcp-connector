/**
 * JSON Schema fragments for the public product shapes.
 *
 * Single source of truth shared by the OpenAPI document and the MCP tool
 * `outputSchema`s, so the two descriptions of the API can never drift apart.
 * These mirror `src/products/product.types.ts`.
 */

export const VARIANT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    price: { type: 'number' },
    available: { type: 'boolean' },
    inventory_quantity: {
      type: ['integer', 'null'],
      description: 'Null when the app lacks read_inventory or Shopify does not track the variant.',
    },
    options: { type: 'object', additionalProperties: { type: 'string' } },
  },
} as const;

export const PRODUCT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Shopify product GID; pass this to get_product.' },
    title: { type: 'string' },
    handle: { type: 'string' },
    url: { type: 'string', description: 'Storefront URL a shopper can open.' },
    description: { type: 'string' },
    price: {
      type: 'number',
      description:
        'Lowest price among the in-stock variants matching the requested size/colour, so it is ' +
        'what the shopper would actually pay. Falls back to the cheapest in-stock variant when ' +
        'no size/colour filter was given.',
    },
    currency: { type: 'string' },
    image: { type: ['string', 'null'] },
    available: { type: 'boolean' },
    tags: { type: 'array', items: { type: 'string' } },
    product_type: { type: 'string' },
    category_match: {
      type: 'string',
      enum: ['exact', 'related'],
      description:
        'Search results only, and only when the query named a category. "exact" means the ' +
        'product is that category; "related" means it is a substitute (a t-shirt for "shirt") — ' +
        'say so rather than presenting it as what was asked for. Absent when nothing to judge.',
    },
    variants: { type: 'array', items: VARIANT_SCHEMA },
  },
} as const;

/** What `get_product` returns: Product minus `image`, plus the detail-only fields. */
export const PRODUCT_DETAIL_SCHEMA = {
  type: 'object',
  properties: {
    ...Object.fromEntries(
      Object.entries(PRODUCT_SCHEMA.properties).filter(([key]) => key !== 'image'),
    ),
    images: { type: 'array', items: { type: 'string' } },
    vendor: { type: 'string' },
    options: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          values: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    price_range: {
      type: 'object',
      description: 'Spans every variant, so min can be lower than `price` when the cheapest is sold out.',
      properties: { min: { type: 'number' }, max: { type: 'number' } },
    },
    total_inventory: { type: ['integer', 'null'] },
  },
} as const;

/** Envelope returned by the search tool/endpoint. */
export const SEARCH_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    products: { type: 'array', items: PRODUCT_SCHEMA },
    total: {
      type: 'integer',
      description: 'Number of products in this response (not the catalog-wide match count).',
    },
  },
  required: ['products', 'total'],
} as const;
