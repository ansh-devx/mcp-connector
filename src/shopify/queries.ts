/**
 * GraphQL documents for the Shopify Admin API.
 *
 * Kept in one place so the shape of what we ask Shopify for is reviewable at a
 * glance, and so no route handler ever builds a GraphQL string itself.
 */

/** Max variants we pull per product. Shopify allows up to 250; 100 is plenty for apparel. */
export const VARIANTS_PER_PRODUCT = 100;
/** Max images we pull per product. */
export const MEDIA_PER_PRODUCT = 10;

const PRODUCT_FIELDS = `
  id
  title
  handle
  description
  productType
  vendor
  tags
  status
  totalInventory
  featuredImage {
    url
    altText
  }
  media(first: ${MEDIA_PER_PRODUCT}) {
    nodes {
      ... on MediaImage {
        image {
          url
          altText
        }
      }
    }
  }
  options {
    name
    values
  }
  priceRangeV2 {
    minVariantPrice {
      amount
      currencyCode
    }
    maxVariantPrice {
      amount
      currencyCode
    }
  }
  variants(first: ${VARIANTS_PER_PRODUCT}) {
    nodes {
      id
      title
      sku
      price
      availableForSale
      inventoryQuantity
      selectedOptions {
        name
        value
      }
    }
  }
`;

/** Candidate fetch for search. `query` uses Shopify's product search syntax. */
export const SEARCH_PRODUCTS_QUERY = `#graphql
  query SearchProducts($first: Int!, $query: String) {
    products(first: $first, query: $query, sortKey: RELEVANCE) {
      nodes {
        ${PRODUCT_FIELDS}
      }
    }
  }
`;

/** Single product lookup by global id. */
export const GET_PRODUCT_QUERY = `#graphql
  query GetProduct($id: ID!) {
    product(id: $id) {
      ${PRODUCT_FIELDS}
    }
  }
`;

/** Cheap call used by the health check to prove credentials still work. */
export const SHOP_QUERY = `#graphql
  query Shop {
    shop {
      name
      currencyCode
    }
  }
`;
