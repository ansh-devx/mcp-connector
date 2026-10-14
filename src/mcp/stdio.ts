#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, getConfig } from '../config/index.js';
import { buildMcpServer } from './server.js';

/**
 * Stdio entry point for local MCP clients (Claude Desktop, Claude Code, ...).
 *
 * stdout carries the JSON-RPC stream and nothing else — every diagnostic goes
 * to stderr, which the client surfaces as server logs.
 */
async function main(): Promise<void> {
  try {
    getConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`[config] ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  const server = buildMcpServer();
  const transport = new StdioServerTransport();

  // The client closes stdin to shut us down; mirror that for signals.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void server.close().finally(() => process.exit(0));
    });
  }

  await server.connect(transport);
  console.error('[mcp] shopify connector ready on stdio');
}

main().catch((error: unknown) => {
  console.error('[mcp] fatal:', error instanceof Error ? error.message : error);
  process.exit(1);
});
