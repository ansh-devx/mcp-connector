import { buildApp } from './app.js';
import { ConfigError, getConfig } from './config/index.js';

/** Process entry point: resolve config, start Fastify, wire graceful shutdown. */
async function main(): Promise<void> {
  let config;
  try {
    config = getConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`[config] ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  const app = buildApp();

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      app.log.info({ signal }, 'shutting down');
      void app.close().then(() => process.exit(0));
    });
  }

  try {
    await app.listen({ port: config.server.port, host: config.server.host });
    app.log.info(
      {
        store: config.shopify.storeDomain,
        apiVersion: config.shopify.apiVersion,
        authEnabled: config.connectorApiKey !== null,
      },
      'shopify connector ready',
    );
  } catch (error) {
    app.log.error({ err: error }, 'failed to start server');
    process.exit(1);
  }
}

void main();
