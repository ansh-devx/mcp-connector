import type { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  // Deliberately dependency-free: a deploy health check must not depend on Shopify.
  app.get('/health', async () => ({ status: 'ok' }));
}
