import type { FastifyInstance } from 'fastify';
import { searchProductsService } from '../products/product.service.js';
import type { SearchOutcome } from '../products/product.service.js';
import { LIMITS } from '../products/product.validation.js';

export interface SearchRouteOptions {
  /** Injected in tests; defaults to the real service. */
  search?: (input: unknown) => Promise<SearchOutcome>;
}

/** Fast structural rejection; product.validation.ts owns the semantic rules. */
const searchBodySchema = {
  type: 'object',
  required: ['query'],
  additionalProperties: false,
  properties: {
    query: { type: 'string', minLength: 1, maxLength: LIMITS.maxQueryLength },
    min_price: { type: ['number', 'null'], minimum: 0 },
    max_price: { type: ['number', 'null'], minimum: 0 },
    size: { type: ['string', 'null'], maxLength: LIMITS.maxAttributeLength },
    color: { type: ['string', 'null'], maxLength: LIMITS.maxAttributeLength },
    limit: { type: ['integer', 'null'], minimum: 1, maximum: LIMITS.maxLimit },
  },
} as const;

export async function searchRoutes(
  app: FastifyInstance,
  options: SearchRouteOptions = {},
): Promise<void> {
  const search = options.search ?? ((input: unknown) => searchProductsService(input));

  app.post(
    '/api/search-products',
    { schema: { body: searchBodySchema } },
    async (request, reply) => {
      const outcome = await search(request.body);

      request.log.info(
        {
          endpoint: 'POST /api/search-products',
          query: outcome.params.query,
          filters: {
            min_price: outcome.params.minPrice,
            max_price: outcome.params.maxPrice,
            size: outcome.params.size,
            color: outcome.params.color,
          },
          limit: outcome.params.limit,
          results: outcome.total,
          top_score: outcome.topScore,
        },
        'product search completed',
      );

      return reply.send({ products: outcome.products, total: outcome.total });
    },
  );
}
