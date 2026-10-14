import type { FastifyInstance } from 'fastify';
import { getProductService } from '../products/product.service.js';
import type { ProductDetail } from '../products/product.types.js';

export interface ProductRouteOptions {
  /** Injected in tests; defaults to the real service. */
  getProduct?: (id: unknown) => Promise<ProductDetail>;
}

export async function productRoutes(
  app: FastifyInstance,
  options: ProductRouteOptions = {},
): Promise<void> {
  const getProduct = options.getProduct ?? ((id: unknown) => getProductService(id));

  app.get<{ Params: { id: string } }>('/api/products/:id', async (request, reply) => {
    const product = await getProduct(request.params.id);

    request.log.info(
      { endpoint: 'GET /api/products/:id', product_id: product.id, variants: product.variants.length },
      'product lookup completed',
    );

    return reply.send(product);
  });
}
