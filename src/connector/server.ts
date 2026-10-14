import type { FastifyInstance } from 'fastify';
import { callTool, TOOL_DEFINITIONS } from './tools.js';

export interface ConnectorRouteOptions {
  /** Injected in tests; defaults to the real dispatcher. */
  invoke?: (name: string, args: unknown) => Promise<unknown>;
}

/**
 * HTTP surface for the tool layer, so an agent runtime can discover and invoke
 * the tools without importing this package.
 *
 *   GET  /connector/tools          -> tool definitions (name, description, schema)
 *   POST /connector/tools/:name    -> invoke a tool with a JSON argument object
 */
export async function connectorRoutes(
  app: FastifyInstance,
  options: ConnectorRouteOptions = {},
): Promise<void> {
  const invoke = options.invoke ?? ((name: string, args: unknown) => callTool(name, args));

  app.get('/connector/tools', async () => ({ tools: TOOL_DEFINITIONS }));

  app.post<{ Params: { name: string }; Body: unknown }>(
    '/connector/tools/:name',
    async (request, reply) => {
      const { name } = request.params;
      const result = await invoke(name, request.body ?? {});

      request.log.info({ endpoint: 'POST /connector/tools/:name', tool: name }, 'tool invoked');

      return reply.send({ tool: name, result });
    },
  );
}
