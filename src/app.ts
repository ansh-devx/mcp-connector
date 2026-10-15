import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { getConfig } from './config/index.js';
import { buildOpenApiDocument } from './connector/openapi.js';
import { connectorRoutes, type ConnectorRouteOptions } from './connector/server.js';
import { mcpRoutes, type McpRouteOptions } from './mcp/http.js';
import { healthRoutes } from './routes/health.js';
import { productRoutes, type ProductRouteOptions } from './routes/products.js';
import { searchRoutes, type SearchRouteOptions } from './routes/search.js';
import { apiKeyGuard } from './utils/auth.js';
import { rateLimitGuard } from './utils/rate-limit-hook.js';
import { isAppError, redactSecrets } from './utils/errors.js';

export interface BuildAppOptions {
  logger?: boolean;
  routes?: SearchRouteOptions & ProductRouteOptions & ConnectorRouteOptions & McpRouteOptions;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const config = getConfig();

  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: config.server.logLevel,
            // Belt and braces: these must never reach a log line.
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers["x-shopify-access-token"]',
                'res.headers["set-cookie"]',
              ],
              censor: '[REDACTED]',
            },
            serializers: {
              req: (request) => ({
                method: request.method,
                url: request.url,
                remoteAddress: request.ip,
              }),
            },
          },
    disableRequestLogging: false,
    trustProxy: true,
    bodyLimit: 256 * 1024,
  });

  app.addHook('onRequest', apiKeyGuard);
  // After the auth guard: an unauthenticated caller should not be able to spend
  // another caller's quota just by hammering the endpoint with a bad key.
  app.addHook('onRequest', rateLimitGuard);

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: { code: 'NOT_FOUND', message: `Route ${request.method} ${request.url} not found.` },
    });
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    // Fastify schema validation -> 400 with a useful message.
    if (error.validation) {
      const detail = error.validation
        .map((issue) => `${issue.instancePath || 'body'} ${issue.message ?? 'is invalid'}`)
        .join('; ');
      request.log.warn({ err: detail }, 'request validation failed');
      return reply.status(400).send({
        error: { code: 'BAD_REQUEST', message: `Invalid request: ${detail}` },
      });
    }

    if (isAppError(error)) {
      const payload = {
        error: {
          code: error.code,
          message: redactSecrets(error.message),
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      };
      if (error.statusCode >= 500) {
        request.log.error({ code: error.code, msg: redactSecrets(error.message) }, 'request failed');
      } else {
        request.log.warn({ code: error.code, msg: redactSecrets(error.message) }, 'request rejected');
      }
      return reply.status(error.statusCode).send(payload);
    }

    if (error.statusCode !== undefined && error.statusCode < 500) {
      return reply.status(error.statusCode).send({
        error: { code: error.code ?? 'BAD_REQUEST', message: redactSecrets(error.message) },
      });
    }

    // Unexpected: log the detail, return something generic.
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' },
    });
  });

  app.get('/', async () => ({
    name: 'shopify-ai-shopping-connector',
    status: 'ok',
    endpoints: [
      'GET  /health',
      'POST /api/search-products',
      'GET  /api/products/:id',
      'GET  /connector/tools',
      'POST /connector/tools/:name',
      'POST /mcp',
      'GET  /openapi.json',
    ],
  }));

  app.get('/openapi.json', async (request) => {
    const proto = (request.headers['x-forwarded-proto'] as string | undefined) ?? request.protocol;
    return buildOpenApiDocument(`${proto}://${request.headers.host ?? `localhost:${config.server.port}`}`);
  });

  app.register(healthRoutes);
  app.register(async (instance) => searchRoutes(instance, options.routes ?? {}));
  app.register(async (instance) => productRoutes(instance, options.routes ?? {}));
  app.register(async (instance) => connectorRoutes(instance, options.routes ?? {}));
  app.register(async (instance) => mcpRoutes(instance, options.routes ?? {}));

  return app;
}
