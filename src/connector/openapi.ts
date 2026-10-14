import { LIMITS } from '../products/product.validation.js';
import { PRODUCT_DETAIL_SCHEMA, PRODUCT_SCHEMA, SEARCH_RESULT_SCHEMA } from './schemas.js';

/**
 * Minimal OpenAPI document describing the two shopping endpoints.
 * Point a ChatGPT custom GPT Action (or any OpenAPI-driven agent) at
 * GET /openapi.json to import the tools automatically.
 *
 * MCP clients do not need this: they use GET/POST /mcp instead.
 */
export function buildOpenApiDocument(serverUrl: string): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Shopify AI Shopping Connector',
      version: '1.0.0',
      description:
        'Search a live Shopify product catalog with natural-language shopping requirements. ' +
        'Never invent products: only recommend products returned by these endpoints.',
    },
    servers: [{ url: serverUrl }],
    paths: {
      '/api/search-products': {
        post: {
          operationId: 'search_products',
          summary: 'Search the live Shopify product catalog',
          description:
            'Use whenever a user asks to find, compare or recommend products based on product ' +
            'type, price, color, size, availability or keywords.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['query'],
                  properties: {
                    query: { type: 'string', maxLength: LIMITS.maxQueryLength },
                    min_price: { type: 'number', minimum: 0 },
                    max_price: { type: 'number', minimum: 0 },
                    size: { type: 'string', maxLength: LIMITS.maxAttributeLength },
                    color: { type: 'string', maxLength: LIMITS.maxAttributeLength },
                    limit: { type: 'integer', minimum: 1, maximum: LIMITS.maxLimit },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Matching products, most relevant first',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/SearchResult' } },
              },
            },
            '400': { description: 'Invalid request body' },
            '502': { description: 'Shopify API error' },
          },
        },
      },
      '/api/products/{id}': {
        get: {
          operationId: 'get_product',
          summary: 'Retrieve one product previously returned by search_products',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'URL-encoded product GID, e.g. gid%3A%2F%2Fshopify%2FProduct%2F123',
            },
          ],
          responses: {
            '200': {
              description: 'Product detail',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/ProductDetail' } },
              },
            },
            '404': { description: 'Product not found' },
          },
        },
      },
      '/health': {
        get: {
          operationId: 'health',
          summary: 'Health check',
          responses: { '200': { description: 'Service is up' } },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
      },
      schemas: {
        Product: PRODUCT_SCHEMA,
        ProductDetail: PRODUCT_DETAIL_SCHEMA,
        SearchResult: {
          ...SEARCH_RESULT_SCHEMA,
          properties: {
            ...SEARCH_RESULT_SCHEMA.properties,
            products: { type: 'array', items: { $ref: '#/components/schemas/Product' } },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
  };
}
