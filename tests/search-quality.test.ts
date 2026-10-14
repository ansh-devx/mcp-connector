import './setup.env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { searchProducts } from '../src/products/product.search.js';
import type { Product, ResolvedSearchParams } from '../src/products/product.types.js';
import { makeProductNode, stubCandidates } from './fixtures.js';

const params = (overrides: Partial<ResolvedSearchParams> = {}): ResolvedSearchParams => ({
  query: 'shirt',
  minPrice: null,
  maxPrice: null,
  size: null,
  color: null,
  limit: 5,
  ...overrides,
});

/**
 * The real catalogue shape that produced the bug: one cheap variant in an
 * unrelated colour, and the Black/L the shopper actually asked for priced above
 * their budget. Modelled on Tommy Hilfiger's "Solid Slim Fit Ribbed T-Shirt".
 */
const mixedPriceTee = makeProductNode({
  id: 'gid://shopify/Product/900',
  title: 'Solid Slim Fit Ribbed T-Shirt',
  productType: 'T-Shirt',
  tags: ['T-Shirt', 'Women'],
  variants: [
    { color: 'Orange', size: 'S', price: 2199, available: true },
    { color: 'Black', size: 'L', price: 2599, available: true },
  ],
});

const realShirt = makeProductNode({
  id: 'gid://shopify/Product/901',
  title: 'Regular Fit Poplin Shirt',
  productType: 'Shirt',
  tags: ['Shirt', 'Men'],
  variants: [{ color: 'Black', size: 'L', price: 2400, available: true }],
});

const search = (p: ResolvedSearchParams, nodes = [mixedPriceTee, realShirt]) =>
  searchProducts(p, stubCandidates(nodes));

describe('price respects the size and colour filters', () => {
  // Only the tee is in play here, so the assertions are about it alone.
  const searchTee = (p: ResolvedSearchParams) => search(p, [mixedPriceTee]);

  it('excludes a product whose matching variant is over budget', async () => {
    // Black/L costs 2599. The 2199 Orange/S must not buy it a place under 2500.
    const { products } = await searchTee(
      params({ query: 't-shirt', size: 'L', color: 'black', maxPrice: 2500 }),
    );
    assert.deepEqual(products.map((p) => p.id), [], 'the only matching variant is over budget');
  });

  it('includes it once the budget covers the matching variant', async () => {
    const { products } = await searchTee(
      params({ query: 't-shirt', size: 'L', color: 'black', maxPrice: 2600 }),
    );
    assert.deepEqual(products.map((p) => p.id), ['gid://shopify/Product/900']);
  });

  it('quotes the price of the variant the shopper asked for', async () => {
    const { products } = await searchTee(
      params({ query: 't-shirt', size: 'L', color: 'black', maxPrice: 3000 }),
    );
    // Not 2199: that is the Orange/S the shopper cannot buy.
    assert.equal(products[0]?.price, 2599);
  });

  it('does not exclude an unrelated product that genuinely fits the budget', async () => {
    // The real shirt's Black/L is 2400, so it survives the same 2500 budget
    // that rejects the tee — the filter is variant-accurate, not blanket.
    const { products } = await search(
      params({ query: 'shirt', size: 'L', color: 'black', maxPrice: 2500 }),
    );
    assert.deepEqual(products.map((p) => p.id), ['gid://shopify/Product/901']);
  });

  it('still quotes the cheapest in-stock variant when no filter is given', async () => {
    const { products } = await search(params({ query: 't-shirt' }), [mixedPriceTee]);
    assert.equal(products[0]?.price, 2199);
  });
});

describe('a t-shirt does not silently stand in for a shirt', () => {
  it('ranks the real shirt above the t-shirt', async () => {
    const { products } = await search(params({ query: 'black shirt', color: 'black' }));
    assert.equal(products[0]?.id, 'gid://shopify/Product/901', 'the Shirt should lead');
  });

  it('labels each result so the agent can name the substitution', async () => {
    const { products } = await search(params({ query: 'black shirt', color: 'black' }));
    const byId = new Map<string, Product>(products.map((p) => [p.id, p]));
    assert.equal(byId.get('gid://shopify/Product/901')?.category_match, 'exact');
    assert.equal(byId.get('gid://shopify/Product/900')?.category_match, 'related');
  });

  it('still returns substitutes rather than nothing when no exact match exists', async () => {
    const { products } = await search(params({ query: 'shirt' }), [mixedPriceTee]);
    assert.equal(products.length, 1);
    assert.equal(products[0]?.category_match, 'related');
  });

  it('leaves category_match unset when the query names no category', async () => {
    const { products } = await search(params({ query: 'something casual for dinner' }));
    for (const product of products) {
      assert.equal(product.category_match, undefined);
    }
  });
});
