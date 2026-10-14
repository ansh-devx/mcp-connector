import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { callTool, TOOL_DEFINITIONS, type ToolDependencies } from '../connector/tools.js';
import { PRODUCT_DETAIL_SCHEMA, SEARCH_RESULT_SCHEMA } from '../connector/schemas.js';
import { isAppError, redactSecrets } from '../utils/errors.js';

/**
 * Model Context Protocol server.
 *
 * It exposes the same two tools as the REST connector and delegates to the same
 * `callTool` dispatcher, so there is exactly one implementation of the shopping
 * logic. Transports live in `stdio.ts` (local clients such as Claude Desktop)
 * and `http.ts` (remote clients over Streamable HTTP).
 */

export const MCP_SERVER_INFO = {
  name: 'shopify-ai-shopping-connector',
  // Kept in step with package.json by hand: importing it would break rootDir.
  version: '1.0.0',
} as const;

/** Shown to the model once, when it connects. Mirrors the system-prompt advice in the README. */
export const MCP_INSTRUCTIONS =
  'This server searches a live Shopify product catalog. Use `search_products` for every ' +
  'product question and `get_product` when the shopper wants more detail about a specific ' +
  'result. Only recommend products these tools return — never invent products, prices, ' +
  'sizes or availability. Prices are in the store currency and already reflect what a ' +
  'shopper can actually buy: sold-out variants are excluded.';

/** Per-tool JSON Schema for the tool result, so clients can validate structured output. */
const OUTPUT_SCHEMAS: Record<string, Record<string, unknown>> = {
  search_products: SEARCH_RESULT_SCHEMA as unknown as Record<string, unknown>,
  get_product: PRODUCT_DETAIL_SCHEMA as unknown as Record<string, unknown>,
};

/**
 * Both tools only read, never mutate, and reach a catalog outside this process.
 * Clients use these hints to decide what may run without a confirmation prompt.
 */
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/** Adapts the Anthropic-style tool definitions to the MCP `Tool` shape. */
export function toMcpTools(): Tool[] {
  return TOOL_DEFINITIONS.map((definition) => {
    const outputSchema = OUTPUT_SCHEMAS[definition.name];
    return {
      name: definition.name,
      description: definition.description,
      inputSchema: definition.input_schema as Tool['inputSchema'],
      ...(outputSchema === undefined ? {} : { outputSchema: outputSchema as Tool['outputSchema'] }),
      annotations: READ_ONLY_ANNOTATIONS,
    };
  });
}

/**
 * Turns a thrown error into a tool result the model can read and act on.
 *
 * MCP draws a line between protocol failures (throw) and tool failures
 * (`isError: true`). A bad size or an unknown product id is a tool failure: the
 * model should see the message and retry, not have the connection error out.
 */
function toErrorResult(error: unknown): CallToolResult {
  const message = isAppError(error)
    ? `${error.code}: ${redactSecrets(error.message)}`
    : 'INTERNAL_ERROR: An unexpected error occurred.';
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function buildMcpServer(deps: ToolDependencies = {}): Server {
  const server = new Server(MCP_SERVER_INFO, {
    capabilities: { tools: {} },
    instructions: MCP_INSTRUCTIONS,
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toMcpTools() }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;
    try {
      const result = await callTool(name, args ?? {}, deps);
      return {
        // Text content is what every client understands; structuredContent is
        // the typed form for clients that support it.
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result as Record<string, unknown>,
      };
    } catch (error) {
      return toErrorResult(error);
    }
  });

  return server;
}
