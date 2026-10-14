import './setup.env.js';
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { buildApp } from '../src/app.js';
import { callTool, TOOL_DEFINITIONS } from '../src/connector/tools.js';
import { getProductService, searchProductsService } from '../src/products/product.service.js';
import { catalog, makeProductNode, stubCandidates } from './fixtures.js';

const deps = {
  search: (input: unknown) => searchProductsService(input, stubCandidates()),
  getProduct: (id: unknown) =>
    getProductService(id, {
      fetchProduct: async (gid) =>
        gid === 'gid://shopify/Product/1'
          ? (catalog()[0] ?? null)
          : gid === 'gid://shopify/Product/500'
            ? makeProductNode({
                id: gid,
                title: 'Tool Lookup Shirt',
                variants: [{ color: 'Black', size: 'L', price: 1200, available: true }],
              })
            : null,
      storefrontUrl: 'https://test-store.myshopify.com',
    }),
};

describe('tool definitions', () => {
  it('exposes exactly search_products and get_product', () => {
    assert.deepEqual(
      TOOL_DEFINITIONS.map((t) => t.name),
      ['search_products', 'get_product'],
    );
  });

  it('documents the required inputs for each tool', () => {
    const search = TOOL_DEFINITIONS[0]!;
    assert.deepEqual(search.input_schema.required, ['query']);
    const props = search.input_schema.properties as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(props).sort(),
      ['color', 'limit', 'max_price', 'min_price', 'query', 'size'].sort(),
    );

    const get = TOOL_DEFINITIONS[1]!;
    assert.deepEqual(get.input_schema.required, ['product_id']);
  });

  it('tells the model not to invent products', () => {
    assert.match(TOOL_DEFINITIONS[0]!.description, /Never invent products/);
  });
});

describe('callTool', () => {
  it('runs search_products and returns products + total', async () => {
    const result = (await callTool('search_products', { query: 'black shirt', limit: 2 }, deps)) as {
      products: unknown[];
      total: number;
    };
    assert.ok(Array.isArray(result.products));
    assert.equal(result.total, result.products.length);
    assert.ok(result.products.length <= 2);
  });

  it('runs get_product with the id returned by search_products', async () => {
    const search = (await callTool('search_products', { query: 'black shirt' }, deps)) as {
      products: Array<{ id: string }>;
    };
    const id = search.products[0]?.id;
    assert.ok(id);
    const detail = (await callTool('get_product', { product_id: id }, deps)) as { id: string };
    assert.equal(detail.id, id);
  });

  it('propagates validation errors as 400', async () => {
    await assert.rejects(
      () => callTool('search_products', { query: '' }, deps),
      (error: unknown) => {
        assert.equal((error as { statusCode: number }).statusCode, 400);
        return true;
      },
    );
  });

  it('rejects an unknown tool name', async () => {
    await assert.rejects(
      () => callTool('delete_everything', {}, deps),
      (error: unknown) => {
        assert.equal((error as { statusCode: number }).statusCode, 400);
        assert.match((error as Error).message, /Unknown tool/);
        return true;
      },
    );
  });

  it('rejects get_product without a product_id', async () => {
    await assert.rejects(
      () => callTool('get_product', {}, deps),
      (error: unknown) => {
        assert.equal((error as { statusCode: number }).statusCode, 400);
        return true;
      },
    );
  });
});

describe('connector HTTP surface', () => {
  const app = buildApp({
    logger: false,
    routes: { invoke: (name, args) => callTool(name, args, deps) },
  });
  after(() => app.close());

  it('lists the tools for an agent runtime', async () => {
    const response = await app.inject({ method: 'GET', url: '/connector/tools' });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { tools: Array<{ name: string; input_schema: unknown }> };
    assert.equal(body.tools.length, 2);
    assert.ok(body.tools.every((t) => typeof t.description === 'string'));
  });

  it('invokes a tool over HTTP', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/connector/tools/search_products',
      payload: { query: 'black shirt', size: 'L', limit: 2 },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { tool: string; result: { total: number } };
    assert.equal(body.tool, 'search_products');
    assert.ok(body.result.total >= 1);
  });

  it('returns 400 for an unknown tool', async () => {
    const response = await app.inject({ method: 'POST', url: '/connector/tools/nope', payload: {} });
    assert.equal(response.statusCode, 400);
  });

  it('serves an OpenAPI document describing both operations', async () => {
    const response = await app.inject({ method: 'GET', url: '/openapi.json' });
    assert.equal(response.statusCode, 200);
    const doc = response.json() as { paths: Record<string, Record<string, { operationId: string }>> };
    assert.equal(doc.paths['/api/search-products']?.post?.operationId, 'search_products');
    assert.equal(doc.paths['/api/products/{id}']?.get?.operationId, 'get_product');
  });
});
