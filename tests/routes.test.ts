import './setup.env.js';
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { buildApp } from '../src/app.js';
import { resetConfigCache } from '../src/config/index.js';
import { getProductService, searchProductsService } from '../src/products/product.service.js';
import { NotFoundError, ShopifyApiError } from '../src/utils/errors.js';
import { catalog, makeProductNode, stubCandidates } from './fixtures.js';

/** App wired to a fake Shopify layer — no network, no credentials. */
function testApp(overrides: Parameters<typeof buildApp>[0]['routes'] = {}) {
  return buildApp({
    logger: false,
    routes: {
      search: (input) => searchProductsService(input, stubCandidates()),
      getProduct: (id) =>
        getProductService(id, {
          fetchProduct: async (gid) =>
            catalog().find((node) => node.id === gid) ??
            (gid === 'gid://shopify/Product/777'
              ? makeProductNode({
                  id: gid,
                  title: 'Direct Lookup Shirt',
                  tags: ['black'],
                  variants: [{ color: 'Black', size: 'L', price: 1500, available: true }],
                })
              : null),
          storefrontUrl: 'https://test-store.myshopify.com',
        }),
      ...overrides,
    },
  });
}

describe('GET /health', () => {
  it('returns status ok without touching Shopify', async () => {
    const app = testApp();
    after(() => app.close());
    const response = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: 'ok' });
  });
});

describe('POST /api/search-products', () => {
  it('returns products and a total in the documented shape', async () => {
    const app = testApp();
    after(() => app.close());
    const response = await app.inject({
      method: 'POST',
      url: '/api/search-products',
      payload: { query: 'black shirt', max_price: 2500, limit: 3 },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { products: Array<Record<string, unknown>>; total: number };
    assert.ok(Array.isArray(body.products));
    assert.equal(body.total, body.products.length);
    assert.ok(body.products.length <= 3);

    const product = body.products[0]!;
    assert.deepEqual(
      Object.keys(product).sort(),
      [
        'available', 'currency', 'description', 'handle', 'id', 'image',
        'price', 'product_type', 'tags', 'title', 'url', 'variants',
        // Present because the query named a category ("shirt").
        'category_match',
      ].sort(),
    );
    assert.ok(['exact', 'related'].includes(String(product.category_match)));
    assert.equal(typeof product.price, 'number');
    assert.match(String(product.url), /^https:\/\/test-store\.myshopify\.com\/products\//);
  });

  it('works with only a query', async () => {
    const app = testApp();
    after(() => app.close());
    const response = await app.inject({
      method: 'POST',
      url: '/api/search-products',
      payload: { query: 'shirt' },
    });
    assert.equal(response.statusCode, 200);
    assert.ok((response.json() as { total: number }).total <= 5, 'default limit is 5');
  });

  it('rejects a missing query with 400', async () => {
    const app = testApp();
    after(() => app.close());
    const response = await app.inject({
      method: 'POST',
      url: '/api/search-products',
      payload: { max_price: 2000 },
    });
    assert.equal(response.statusCode, 400);
    assert.equal((response.json() as { error: { code: string } }).error.code, 'BAD_REQUEST');
  });

  it('rejects an out-of-range limit and a negative price with 400', async () => {
    const app = testApp();
    after(() => app.close());
    for (const payload of [
      { query: 'shirt', limit: 50 },
      { query: 'shirt', limit: 0 },
      { query: 'shirt', max_price: -10 },
      { query: '' },
      { query: 'x'.repeat(500) },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/search-products',
        payload,
      });
      assert.equal(response.statusCode, 400, `expected 400 for ${JSON.stringify(payload)}`);
    }
  });

  it('rejects malformed JSON with 400', async () => {
    const app = testApp();
    after(() => app.close());
    const response = await app.inject({
      method: 'POST',
      url: '/api/search-products',
      headers: { 'content-type': 'application/json' },
      payload: '{"query": ',
    });
    assert.equal(response.statusCode, 400);
  });

  it('returns 502 and no secrets when Shopify fails', async () => {
    const app = testApp({
      search: async () => {
        throw new ShopifyApiError('Shopify GraphQL request failed: token shpat_supersecrettoken1234');
      },
    });
    after(() => app.close());
    const response = await app.inject({
      method: 'POST',
      url: '/api/search-products',
      payload: { query: 'shirt' },
    });
    assert.equal(response.statusCode, 502);
    const body = response.json() as { error: { code: string; message: string } };
    assert.equal(body.error.code, 'SHOPIFY_API_ERROR');
    assert.doesNotMatch(body.error.message, /shpat_supersecrettoken/);
    assert.match(body.error.message, /REDACTED/);
  });

  it('returns 503 when Shopify is unreachable or throttled', async () => {
    const app = testApp({
      search: async () => {
        throw new ShopifyApiError('Shopify rate limit reached, please retry shortly.', 503);
      },
    });
    after(() => app.close());
    const response = await app.inject({
      method: 'POST',
      url: '/api/search-products',
      payload: { query: 'shirt' },
    });
    assert.equal(response.statusCode, 503);
  });

  it('never leaks the access token in any response', async () => {
    const app = testApp();
    after(() => app.close());
    const response = await app.inject({
      method: 'POST',
      url: '/api/search-products',
      payload: { query: 'black shirt' },
    });
    assert.doesNotMatch(response.body, /shpat_/);
  });
});

describe('GET /api/products/:id', () => {
  it('returns product detail for a URL-encoded GID', async () => {
    const app = testApp();
    after(() => app.close());
    const response = await app.inject({
      method: 'GET',
      url: `/api/products/${encodeURIComponent('gid://shopify/Product/777')}`,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as Record<string, unknown>;
    assert.equal(body.id, 'gid://shopify/Product/777');
    assert.equal(body.title, 'Direct Lookup Shirt');
    assert.ok(Array.isArray(body.images));
    assert.ok(Array.isArray(body.variants));
    assert.equal(body.image, undefined, 'detail returns images[], not image');
  });

  it('returns 404 for an unknown product', async () => {
    const app = testApp();
    after(() => app.close());
    const response = await app.inject({
      method: 'GET',
      url: `/api/products/${encodeURIComponent('gid://shopify/Product/999999')}`,
    });
    assert.equal(response.statusCode, 404);
    assert.equal((response.json() as { error: { code: string } }).error.code, 'NOT_FOUND');
  });

  it('returns 400 for a malformed id', async () => {
    const app = testApp();
    after(() => app.close());
    const response = await app.inject({ method: 'GET', url: '/api/products/not-an-id' });
    assert.equal(response.statusCode, 400);
  });

  it('maps a thrown NotFoundError to 404', async () => {
    const app = testApp({
      getProduct: async () => {
        throw new NotFoundError('gone');
      },
    });
    after(() => app.close());
    const response = await app.inject({ method: 'GET', url: '/api/products/1' });
    assert.equal(response.statusCode, 404);
  });
});

describe('unknown routes', () => {
  it('returns a structured 404', async () => {
    const app = testApp();
    after(() => app.close());
    const response = await app.inject({ method: 'GET', url: '/nope' });
    assert.equal(response.statusCode, 404);
    assert.equal((response.json() as { error: { code: string } }).error.code, 'NOT_FOUND');
  });
});

describe('API key authentication', () => {
  it('is disabled when CONNECTOR_API_KEY is unset', async () => {
    const app = testApp();
    after(() => app.close());
    const response = await app.inject({
      method: 'POST',
      url: '/api/search-products',
      payload: { query: 'shirt' },
    });
    assert.equal(response.statusCode, 200);
  });

  it('enforces a bearer token when configured', async () => {
    process.env.CONNECTOR_API_KEY = 'secret-key';
    resetConfigCache();
    const app = testApp();
    after(() => {
      delete process.env.CONNECTOR_API_KEY;
      resetConfigCache();
      return app.close();
    });

    const missing = await app.inject({
      method: 'POST',
      url: '/api/search-products',
      payload: { query: 'shirt' },
    });
    assert.equal(missing.statusCode, 401);

    const wrong = await app.inject({
      method: 'POST',
      url: '/api/search-products',
      headers: { authorization: 'Bearer nope' },
      payload: { query: 'shirt' },
    });
    assert.equal(wrong.statusCode, 401);

    const ok = await app.inject({
      method: 'POST',
      url: '/api/search-products',
      headers: { authorization: 'Bearer secret-key' },
      payload: { query: 'shirt' },
    });
    assert.equal(ok.statusCode, 200);

    const health = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(health.statusCode, 200, '/health stays public for deploy checks');
  });
});
