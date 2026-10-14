import './setup.env.js';
import assert from 'node:assert/strict';
import { FAKE_SHOPIFY_TOKEN } from './fixtures.js';
import { afterEach, describe, it } from 'node:test';
import { resetShopifyClient, shopifyRequest } from '../src/shopify/client.js';
import { SEARCH_PRODUCTS_QUERY } from '../src/shopify/queries.js';
import { ShopifyApiError, redactSecrets } from '../src/utils/errors.js';

const realFetch = globalThis.fetch;

/** Replaces global fetch so no request ever leaves the machine. */
function stubFetch(handler: () => Response | Promise<Response>): void {
  globalThis.fetch = (async () => handler()) as typeof fetch;
  resetShopifyClient();
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  globalThis.fetch = realFetch;
  resetShopifyClient();
});

async function expectShopifyError(status: number, match?: RegExp): Promise<void> {
  await assert.rejects(
    () => shopifyRequest(SEARCH_PRODUCTS_QUERY, { first: 5, query: 'shirt' }),
    (error: unknown) => {
      assert.ok(error instanceof ShopifyApiError, `expected ShopifyApiError, got ${String(error)}`);
      assert.equal(error.statusCode, status);
      assert.equal(error.code, 'SHOPIFY_API_ERROR');
      if (match) assert.match(error.message, match);
      return true;
    },
  );
}

describe('shopifyRequest', () => {
  it('returns data on success', async () => {
    stubFetch(() => jsonResponse({ data: { products: { nodes: [] } } }));
    const data = await shopifyRequest<{ products: { nodes: unknown[] } }>(SEARCH_PRODUCTS_QUERY, {
      first: 5,
      query: 'shirt',
    });
    assert.deepEqual(data.products.nodes, []);
  });

  it('maps an auth failure to 502 without echoing the token', async () => {
    stubFetch(() => jsonResponse({ errors: [{ message: 'Invalid API key or access token' }] }, 401));
    await expectShopifyError(502, /credentials|scope/i);
  });

  it('maps ACCESS_DENIED to 502 and names the missing scope', async () => {
    stubFetch(() =>
      jsonResponse({
        errors: [{ message: 'Access denied for inventoryQuantity', extensions: { code: 'ACCESS_DENIED' } }],
      }),
    );
    await expectShopifyError(502, /read_products/);
  });

  it('maps throttling to 503', async () => {
    stubFetch(() => jsonResponse({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] }, 429));
    await expectShopifyError(503, /rate limit/i);
  });

  it('maps a Shopify 5xx to 503', async () => {
    stubFetch(() => jsonResponse({ errors: [{ message: 'Internal error' }] }, 500));
    await expectShopifyError(503, /unavailable/i);
  });

  it('maps GraphQL field errors to 502', async () => {
    stubFetch(() => jsonResponse({ errors: [{ message: "Field 'bogus' doesn't exist on type 'Product'" }] }));
    await expectShopifyError(502, /bogus/);
  });

  it('maps a network failure to 503', async () => {
    stubFetch(() => {
      throw new Error('getaddrinfo ENOTFOUND test-store.myshopify.com');
    });
    await expectShopifyError(503, /Could not reach/);
  });

  it('rejects an empty response body', async () => {
    stubFetch(() => jsonResponse({}));
    await expectShopifyError(502);
  });

  it('never includes an access token in the thrown message', async () => {
    stubFetch(() =>
      jsonResponse({
        errors: [{ message: `Bad token ${FAKE_SHOPIFY_TOKEN}` }],
      }),
    );
    await assert.rejects(
      () => shopifyRequest(SEARCH_PRODUCTS_QUERY, { first: 5, query: 'shirt' }),
      (error: unknown) => {
        assert.doesNotMatch((error as Error).message, /shpat_abcdef/);
        return true;
      },
    );
  });
});

describe('redactSecrets', () => {
  it('scrubs Shopify tokens', () => {
    assert.equal(
      redactSecrets('token=shpat_abcdef0123456789'),
      'token=shp***_[REDACTED]',
    );
  });

  it('scrubs access-token headers and bearer tokens', () => {
    assert.match(redactSecrets('X-Shopify-Access-Token: abcdef123456'), /\[REDACTED\]/);
    assert.match(redactSecrets('Authorization: Bearer supersecretvalue'), /Bearer \[REDACTED\]/);
  });

  it('leaves ordinary text untouched', () => {
    assert.equal(redactSecrets('product not found'), 'product not found');
  });
});
