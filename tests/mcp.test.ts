import './setup.env.js';
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildApp } from '../src/app.js';
import { buildMcpServer, MCP_INSTRUCTIONS, MCP_SERVER_INFO, toMcpTools } from '../src/mcp/server.js';
import { getProductService, searchProductsService } from '../src/products/product.service.js';
import { catalog, FAKE_SHOPIFY_TOKEN, stubCandidates } from './fixtures.js';

/** Same injected catalogue the connector tests use: no Shopify, no network. */
const deps = {
  search: (input: unknown) => searchProductsService(input, stubCandidates()),
  getProduct: (id: unknown) =>
    getProductService(id, {
      fetchProduct: async (gid) => (gid === 'gid://shopify/Product/1' ? (catalog()[0] ?? null) : null),
      storefrontUrl: 'https://test-store.myshopify.com',
    }),
};

/** Wires a real MCP client to a real MCP server over an in-memory transport pair. */
async function connectClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildMcpServer(deps);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(result: { content: unknown }): string {
  const [first] = result.content as Array<{ type: string; text: string }>;
  return first?.text ?? '';
}

describe('toMcpTools', () => {
  it('adapts every connector tool to the MCP shape', () => {
    const tools = toMcpTools();
    assert.deepEqual(
      tools.map((t) => t.name),
      ['search_products', 'get_product'],
    );
    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, 'object');
      assert.ok(typeof tool.description === 'string' && tool.description.length > 0);
    }
  });

  it('carries the input contract over from the connector definitions', () => {
    const [search, get] = toMcpTools();
    assert.deepEqual(search!.inputSchema.required, ['query']);
    assert.deepEqual(
      Object.keys(search!.inputSchema.properties ?? {}).sort(),
      ['color', 'limit', 'max_price', 'min_price', 'query', 'size'],
    );
    assert.deepEqual(get!.inputSchema.required, ['product_id']);
  });

  it('declares an output schema so clients can validate structured results', () => {
    for (const tool of toMcpTools()) {
      assert.equal(tool.outputSchema?.type, 'object');
    }
    const [search] = toMcpTools();
    assert.deepEqual(search!.outputSchema?.required, ['products', 'total']);
  });

  it('marks both tools read-only and open-world', () => {
    for (const tool of toMcpTools()) {
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.destructiveHint, false);
      assert.equal(tool.annotations?.openWorldHint, true);
    }
  });
});

describe('MCP server over a transport', () => {
  it('advertises its identity and instructions on initialize', async () => {
    const client = await connectClient();
    assert.deepEqual(client.getServerVersion(), { ...MCP_SERVER_INFO });
    assert.equal(client.getInstructions(), MCP_INSTRUCTIONS);
    assert.match(client.getInstructions() ?? '', /never invent products/i);
    await client.close();
  });

  it('lists both tools', async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ['search_products', 'get_product']);
    await client.close();
  });

  it('runs search_products and returns text plus structured content', async () => {
    const client = await connectClient();
    const result = await client.callTool({
      name: 'search_products',
      arguments: { query: 'black shirt', limit: 2 },
    });

    assert.notEqual(result.isError, true);
    const structured = result.structuredContent as { products: unknown[]; total: number };
    assert.ok(Array.isArray(structured.products));
    assert.equal(structured.total, structured.products.length);
    // The text block must be the same payload, so text-only clients lose nothing.
    assert.deepEqual(JSON.parse(textOf(result)), structured);
    await client.close();
  });

  it('honours the price filter through the MCP layer', async () => {
    const client = await connectClient();
    const result = await client.callTool({
      name: 'search_products',
      arguments: { query: 'shirt', max_price: 2000, limit: 5 },
    });
    const { products } = result.structuredContent as {
      products: Array<{ title: string; price: number; available: boolean }>;
    };
    assert.ok(products.length > 0, 'expected at least one match under the budget');
    for (const product of products) {
      assert.ok(product.price <= 2000, `${product.price} should be within budget`);
      assert.equal(product.available, true);
    }
    await client.close();
  });

  it('does not surface a cheap product whose only variants are sold out', async () => {
    const client = await connectClient();
    // "Sold Out Black Shirt" is priced at 999 but has no buyable variant, so a
    // 1500 budget must come back empty rather than advertising an unbuyable price.
    const result = await client.callTool({
      name: 'search_products',
      arguments: { query: 'shirt', max_price: 1500, limit: 5 },
    });
    const { products, total } = result.structuredContent as {
      products: Array<{ title: string }>;
      total: number;
    };
    assert.equal(total, 0);
    assert.deepEqual(products, []);
    await client.close();
  });

  it('runs get_product and returns the detail shape', async () => {
    const client = await connectClient();
    const result = await client.callTool({
      name: 'get_product',
      arguments: { product_id: 'gid://shopify/Product/1' },
    });
    const detail = result.structuredContent as Record<string, unknown>;
    assert.equal(detail.id, 'gid://shopify/Product/1');
    assert.ok(Array.isArray(detail.images));
    assert.ok(typeof detail.price_range === 'object');
    await client.close();
  });

  it('reports invalid input as a tool error, not a protocol failure', async () => {
    const client = await connectClient();
    const result = await client.callTool({ name: 'search_products', arguments: { query: '' } });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /^BAD_REQUEST: /);
    await client.close();
  });

  it('reports a missing product as a tool error', async () => {
    const client = await connectClient();
    const result = await client.callTool({
      name: 'get_product',
      arguments: { product_id: '999999' },
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /^NOT_FOUND: /);
    await client.close();
  });

  it('reports an unknown tool name as a tool error', async () => {
    const client = await connectClient();
    const result = await client.callTool({ name: 'delete_everything', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Unknown tool "delete_everything"/);
    await client.close();
  });

  it('never leaks a Shopify token through a tool error', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildMcpServer({
      search: async () => {
        throw new Error(`request failed with ${FAKE_SHOPIFY_TOKEN}`);
      },
    });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: 'search_products', arguments: { query: 'x' } });
    assert.equal(result.isError, true);
    assert.doesNotMatch(textOf(result), /shpat_/);
    await client.close();
  });
});

describe('MCP HTTP transport', () => {
  const app = buildApp({ logger: false, routes: { createMcpServer: () => buildMcpServer(deps) } });
  after(async () => app.close());

  it('answers a tools/list POST', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /search_products/);
    assert.match(response.body, /get_product/);
  });

  it('rejects GET and DELETE with a JSON-RPC shaped 405', async () => {
    for (const method of ['GET', 'DELETE'] as const) {
      const response = await app.inject({ method, url: '/mcp' });
      assert.equal(response.statusCode, 405, `${method} should not be allowed`);
      assert.equal(response.headers.allow, 'POST');
      assert.equal(response.json().error.code, -32000);
    }
  });

  it('advertises /mcp on the root index', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });
    assert.ok((response.json().endpoints as string[]).some((e) => e.includes('/mcp')));
  });
});
