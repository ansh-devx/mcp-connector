import './setup.env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toProduct } from '../src/products/product.mapper.js';
import { rankProducts, scoreProduct, WEIGHTS } from '../src/products/product.ranking.js';
import type { ResolvedSearchParams } from '../src/products/product.types.js';
import { catalog, makeProductNode } from './fixtures.js';

const products = catalog().map((node) => toProduct(node));
const params = (overrides: Partial<ResolvedSearchParams> = {}): ResolvedSearchParams => ({
  query: 'black shirt',
  minPrice: null,
  maxPrice: null,
  size: null,
  color: null,
  limit: 5,
  ...overrides,
});

describe('ranking', () => {
  it('scores an exact title match highest', () => {
    const node = makeProductNode({
      id: 'gid://shopify/Product/70',
      title: 'Black Shirt',
      variants: [{ color: 'Black', size: 'L', price: 1000, available: true }],
    });
    const exact = scoreProduct(toProduct(node), params());
    const partial = scoreProduct(
      products.find((p) => p.title === 'Premium Black Silk Shirt')!,
      params(),
    );
    assert.ok(exact.score > partial.score);
    assert.ok(exact.reasons.some((r) => r.startsWith('exact title match')));
  });

  it('rewards query terms appearing in the title', () => {
    const scored = scoreProduct(products.find((p) => p.title === 'Classic Black Shirt')!, params());
    assert.ok(scored.reasons.includes(`"black" in title (+${WEIGHTS.termInTitle})`));
    assert.ok(scored.reasons.includes(`"shirt" in title (+${WEIGHTS.termInTitle})`));
  });

  it('rewards tag and product-type matches', () => {
    const scored = scoreProduct(products.find((p) => p.title === 'Classic Black Shirt')!, params());
    assert.ok(scored.reasons.some((r) => r.includes('in tags')));
    assert.ok(scored.reasons.some((r) => r.includes('in product type')));
  });

  it('boosts a colour that is actually in stock over a mere mention', () => {
    const scored = scoreProduct(
      products.find((p) => p.title === 'Classic Black Shirt')!,
      params({ color: 'black' }),
    );
    assert.ok(scored.reasons.some((r) => r.includes('black available')));
  });

  it('boosts an in-stock requested size', () => {
    const scored = scoreProduct(
      products.find((p) => p.title === 'Classic Black Shirt')!,
      params({ size: 'L' }),
    );
    assert.ok(scored.reasons.some((r) => r.includes('size L in stock')));
  });

  it('ranks a relevant shirt above an unrelated jacket', () => {
    const ranked = rankProducts(products, params());
    const shirtIndex = ranked.findIndex((s) => s.product.title === 'Classic Black Shirt');
    const jacketIndex = ranked.findIndex((s) => s.product.title === 'Blue Denim Jacket');
    assert.ok(shirtIndex < jacketIndex);
  });

  it('sorts by score descending', () => {
    const ranked = rankProducts(products, params());
    for (let i = 1; i < ranked.length; i += 1) {
      assert.ok(ranked[i - 1]!.score >= ranked[i]!.score);
    }
  });

  it('is deterministic and breaks ties by price then title', () => {
    const a = rankProducts(products, params()).map((s) => s.product.id);
    const b = rankProducts([...products].reverse(), params()).map((s) => s.product.id);
    assert.deepEqual(a, b);
  });

  it('caps the credit a long description can earn', () => {
    const wordy = makeProductNode({
      id: 'gid://shopify/Product/71',
      title: 'Unrelated Item',
      productType: 'Accessory',
      tags: [],
      description: 'black shirt casual dinner black shirt casual dinner',
      variants: [{ color: 'Grey', size: 'L', price: 500, available: true }],
    });
    const scored = scoreProduct(toProduct(wordy), params({ query: 'black shirt casual dinner' }));
    const fromDescription = scored.reasons.filter((r) => r.includes('in description')).length;
    assert.ok(fromDescription * WEIGHTS.termInDescription <= WEIGHTS.maxDescriptionScore);
  });
});
