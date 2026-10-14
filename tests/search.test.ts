import './setup.env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildShopifyQuery,
  candidatePoolSize,
  searchProducts,
} from '../src/products/product.search.js';
import { getProductService, searchProductsService } from '../src/products/product.service.js';
import type { ResolvedSearchParams } from '../src/products/product.types.js';
import { ShopifyApiError } from '../src/utils/errors.js';
import { escapeShopifyQueryValue } from '../src/utils/text.js';
import { catalog, makeProductNode, stubCandidates } from './fixtures.js';

const params = (overrides: Partial<ResolvedSearchParams> = {}): ResolvedSearchParams => ({
  query: 'black shirt',
  minPrice: null,
  maxPrice: null,
  size: null,
  color: null,
  limit: 5,
  ...overrides,
});

describe('buildShopifyQuery', () => {
  it('scopes to published products', () => {
    assert.match(buildShopifyQuery(params(), 'strict'), /status:ACTIVE/);
  });

  it('ANDs terms in strict mode and ORs them in broad mode', () => {
    assert.match(buildShopifyQuery(params(), 'strict'), /"black" AND "shirt"/);
    assert.match(buildShopifyQuery(params(), 'broad'), /"black" OR "shirt"/);
  });

  it('drops stop words and bare budget numbers', () => {
    const query = buildShopifyQuery(
      params({ query: 'I need something casual for a dinner under 3000' }),
      'strict',
    );
    assert.match(query, /"casual"/);
    assert.match(query, /"dinner"/);
    assert.doesNotMatch(query, /"under"/);
    assert.doesNotMatch(query, /"3000"/);
  });

  it('folds an explicit colour filter into the search terms', () => {
    assert.match(buildShopifyQuery(params({ query: 'shirt', color: 'navy' }), 'strict'), /"navy"/);
  });

  it('cannot be broken out of by a crafted query', () => {
    // Normalisation strips quotes; escaping is the second line of defence.
    const query = buildShopifyQuery(
      params({ query: 'shirt" OR status:DRAFT OR "', color: 'bl"ack' }),
      'strict',
    );
    assert.doesNotMatch(query, /status:DRAFT/);
    // Every quote in the output must be a delimiter we emitted, so the count is even.
    assert.equal((query.match(/(?<!\\)"/g) ?? []).length % 2, 0);
    assert.equal(escapeShopifyQueryValue('bl"a\\ck'), 'bl\\"a\\\\ck');
  });
});

describe('searchProducts pipeline', () => {
  it('returns matching products with a total', async () => {
    const stub = stubCandidates();
    const result = await searchProducts(params(), stub);
    assert.ok(result.total > 0);
    assert.equal(result.products.length, result.total);
  });

  it('asks Shopify for more candidates than the requested limit', async () => {
    const stub = stubCandidates();
    await searchProducts(params({ limit: 3 }), stub);
    assert.ok(stub.calls[0]!.first >= 30);
    assert.equal(candidatePoolSize(3), 40);
    assert.equal(candidatePoolSize(20), 100);
  });

  it('honours the limit', async () => {
    const result = await searchProducts(params({ limit: 2 }), stubCandidates());
    assert.equal(result.products.length, 2);
    assert.equal(result.total, 2);
  });

  it('excludes out-of-stock products', async () => {
    const result = await searchProducts(params({ limit: 20 }), stubCandidates());
    assert.equal(
      result.products.some((p) => p.title === 'Sold Out Black Shirt'),
      false,
    );
    assert.ok(result.products.every((p) => p.available));
  });

  it('applies the price filter end to end', async () => {
    const result = await searchProducts(params({ maxPrice: 2000, limit: 20 }), stubCandidates());
    assert.ok(result.products.length > 0);
    assert.ok(result.products.every((p) => p.price <= 2000));
  });

  it('applies the size filter end to end', async () => {
    const result = await searchProducts(params({ size: 'XXL', limit: 20 }), stubCandidates());
    assert.deepEqual(
      result.products.map((p) => p.title),
      ['Black Regular Fit Shirt'],
    );
  });

  it('applies the colour filter end to end', async () => {
    const result = await searchProducts(
      params({ query: 'shirt', color: 'white', limit: 20 }),
      stubCandidates(),
    );
    assert.deepEqual(
      result.products.map((p) => p.title),
      ['White Linen Shirt'],
    );
  });

  it('falls back to a broad query when the strict pass under-delivers', async () => {
    const stub = stubCandidates();
    await searchProducts(params({ query: 'black shirt', limit: 10 }), stub);
    assert.equal(stub.calls.length, 2);
    assert.match(stub.calls[0]!.searchQuery!, / AND /);
    assert.match(stub.calls[1]!.searchQuery!, / OR /);
  });

  it('does not run the broad pass when the strict pass fills the page', async () => {
    const stub = stubCandidates();
    await searchProducts(params({ limit: 1 }), stub);
    assert.equal(stub.calls.length, 1);
  });

  it('de-duplicates products returned by both passes', async () => {
    const result = await searchProducts(params({ limit: 20 }), stubCandidates());
    const ids = result.products.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('returns an empty result rather than throwing when nothing matches', async () => {
    const result = await searchProducts(params({ maxPrice: 1 }), stubCandidates());
    assert.deepEqual(result.products, []);
    assert.equal(result.total, 0);
  });

  it('builds storefront URLs, never admin URLs', async () => {
    const result = await searchProducts(params(), stubCandidates());
    for (const product of result.products) {
      assert.equal(product.url, `https://test-store.myshopify.com/products/${product.handle}`);
      assert.doesNotMatch(product.url, /admin/);
    }
  });

  it('exposes variant detail an agent needs to answer "do you have XL?"', async () => {
    const result = await searchProducts(params({ limit: 20 }), stubCandidates());
    const product = result.products.find((p) => p.title === 'Premium Black Silk Shirt');
    assert.ok(product);
    const xl = product.variants.find((v) => v.options.Size === 'XL');
    assert.ok(xl);
    assert.equal(xl.available, true);
    assert.equal(typeof xl.price, 'number');
    assert.equal(typeof xl.id, 'string');
  });

  it('survives malformed product data', async () => {
    const broken = [
      {
        id: 'gid://shopify/Product/999',
        title: null,
        handle: null,
        description: null,
        productType: null,
        vendor: null,
        tags: null,
        status: null,
        totalInventory: null,
        featuredImage: null,
        media: null,
        options: null,
        priceRangeV2: null,
        variants: null,
      },
      ...catalog(),
    ];
    const result = await searchProducts(params({ limit: 20 }), stubCandidates(broken));
    // The broken product has no available variant, so it is filtered out, not thrown on.
    assert.equal(
      result.products.some((p) => p.id === 'gid://shopify/Product/999'),
      false,
    );
    assert.ok(result.products.length > 0);
  });
});

describe('searchProductsService', () => {
  it('validates before hitting Shopify', async () => {
    const stub = stubCandidates();
    await assert.rejects(() => searchProductsService({ query: '' }, stub), /query/);
    assert.equal(stub.calls.length, 0, 'Shopify must not be called for invalid input');
  });

  it('surfaces Shopify failures as ShopifyApiError', async () => {
    await assert.rejects(
      () =>
        searchProductsService(
          { query: 'shirt' },
          {
            fetchCandidates: async () => {
              throw new ShopifyApiError('Shopify GraphQL request failed: boom');
            },
          },
        ),
      (error: unknown) => {
        assert.ok(error instanceof ShopifyApiError);
        assert.equal(error.statusCode, 502);
        return true;
      },
    );
  });
});

describe('getProductService', () => {
  it('returns product detail for a known id', async () => {
    const node = makeProductNode({
      id: 'gid://shopify/Product/123',
      title: 'Classic Black Shirt',
      tags: ['black'],
      variants: [{ color: 'Black', size: 'L', price: 1799, available: true }],
    });
    const detail = await getProductService('gid://shopify/Product/123', {
      fetchProduct: async () => node,
      storefrontUrl: 'https://test-store.myshopify.com',
    });
    assert.equal(detail.id, 'gid://shopify/Product/123');
    assert.equal(detail.price, 1799);
    assert.equal(detail.currency, 'INR');
    assert.equal(detail.url, 'https://test-store.myshopify.com/products/classic-black-shirt');
    assert.ok(Array.isArray(detail.images) && detail.images.length > 0);
    assert.equal(detail.variants.length, 1);
    assert.deepEqual(detail.price_range, { min: 1799, max: 1799 });
  });

  it('accepts a numeric id and normalises it', async () => {
    let requested = '';
    await getProductService('123', {
      fetchProduct: async (gid) => {
        requested = gid;
        return makeProductNode({
          id: gid,
          title: 'X',
          variants: [{ price: 10, available: true, size: 'L' }],
        });
      },
    });
    assert.equal(requested, 'gid://shopify/Product/123');
  });

  it('throws NotFound when Shopify has no such product', async () => {
    await assert.rejects(
      () => getProductService('gid://shopify/Product/404', { fetchProduct: async () => null }),
      (error: unknown) => {
        assert.equal((error as { statusCode: number }).statusCode, 404);
        return true;
      },
    );
  });

  it('rejects a malformed id before calling Shopify', async () => {
    let called = false;
    await assert.rejects(
      () =>
        getProductService('nonsense', {
          fetchProduct: async () => {
            called = true;
            return null;
          },
        }),
      (error: unknown) => {
        assert.equal((error as { statusCode: number }).statusCode, 400);
        return true;
      },
    );
    assert.equal(called, false);
  });
});
