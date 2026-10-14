import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildMcpServer } from './server.js';

export interface McpRouteOptions {
  /** Injected in tests; defaults to the real MCP server. */
  createMcpServer?: () => Server;
}

/** JSON-RPC shaped rejection, so a non-conforming client still gets a parseable error. */
function methodNotAllowed(reply: FastifyReply): FastifyReply {
  return reply.status(405).header('Allow', 'POST').send({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed. Use POST for MCP requests.' },
    id: null,
  });
}

/**
 * Streamable HTTP transport for remote MCP clients.
 *
 *   POST /mcp   -> JSON-RPC request/response (and SSE when the client asks for it)
 *   GET/DELETE  -> 405: this server is stateless, so there are no standalone
 *                  notification streams or sessions to terminate.
 *
 * A fresh transport and server are created per request. That is what keeps the
 * process stateless and stops concurrent clients from colliding on request ids;
 * the cost is negligible because neither object touches the network on creation.
 *
 * Auth: the global `apiKeyGuard` hook already covers /mcp, so setting
 * CONNECTOR_API_KEY requires `Authorization: Bearer <key>` here too.
 */
export async function mcpRoutes(
  app: FastifyInstance,
  options: McpRouteOptions = {},
): Promise<void> {
  const createServer = options.createMcpServer ?? (() => buildMcpServer());

  app.post('/mcp', async (request, reply) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      // Stateless: no session ids to mint or validate.
      sessionIdGenerator: undefined,
    });

    // Fastify must not also try to answer; the transport owns the socket now.
    reply.hijack();

    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      request.log.error({ err: error }, 'mcp request failed');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error.' },
            id: null,
          }),
        );
      }
    }
  });

  app.get('/mcp', async (_request, reply) => methodNotAllowed(reply));
  app.delete('/mcp', async (_request, reply) => methodNotAllowed(reply));
}
