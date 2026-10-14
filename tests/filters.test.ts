import './setup.env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyFilters,
  canonicalSize,
  hasAvailableVariantInSize,
  hasAvailableVariantMatching,
  isAvailable,
  matchesColor,
  matchesPrice,
} from '../src/products/product.filters.js';
import { toProduct } from '../src/products/product.mapper.js';
import type { ResolvedSearchParams } from '../src/products/product.types.js';
import { catalog, makeProductNode } from './fixtures.js';

const products = catalog().map((node) => toProduct(node));
const byTitle = (title: string) => {
  const found = products.find((p) => p.title === title);
  assert.ok(found, `fixture "${title}" missing`);
  return found;
};

const baseParams = (overrides: Partial<ResolvedSearchParams> = {}): ResolvedSearchParams => ({
  query: 'shirt',
  minPrice: null,
  maxPrice: null,
  size: null,
  color: null,
  limit: 5,
  ...overrides,
});

describe('price filtering', () => {
  it('keeps products at or below max_price', () => {
    assert.equal(matchesPrice(byTitle('Classic Black Shirt'), null, 2000), true);
    assert.equal(matchesPrice(byTitle('Premium Black Silk Shirt'), null, 2000), false);
  });

  it('keeps products at or above min_price', () => {
    assert.equal(matchesPrice(byTitle('Premium Black Silk Shirt'), 5000, null), true);
    assert.equal(matchesPrice(byTitle('Classic Black Shirt'), 5000, null), false);
  });

  it('treats the bounds as inclusive', () => {
    assert.equal(matchesPrice(byTitle('Classic Black Shirt'), 1799, 1799), true);
  });

  it('only considers prices a shopper can actually buy at', () => {
    const node = makeProductNode({
      id: 'gid://shopify/Product/90',
      title: 'Mixed Availability Shirt',
      variants: [
        { color: 'Black', size: 'S', price: 500, available: false },
        { color: 'Black', size: 'L', price: 4000, available: true },
      ],
    });
    // The cheap variant is sold out, so a 1000 budget must not match.
    assert.equal(matchesPrice(toProduct(node), null, 1000), false);
    assert.equal(matchesPrice(toProduct(node), null, 4000), true);
  });
});

describe('size filtering', () => {
  it('normalises size aliases', () => {
    assert.equal(canonicalSize('Large'), 'l');
    assert.equal(canonicalSize('l'), 'l');
    assert.equal(canonicalSize('Extra Large'), 'xl');
    assert.equal(canonicalSize('2XL'), 'xxl');
    assert.equal(canonicalSize('  M  '), 'm');
  });

  it('matches a size option on an available variant', () => {
    assert.equal(hasAvailableVariantInSize(byTitle('Classic Black Shirt'), 'L'), true);
    assert.equal(hasAvailableVariantInSize(byTitle('Classic Black Shirt'), 'Large'), true);
  });

  it('rejects a size that exists but is out of stock', () => {
    // Only the S variant is unavailable on this product.
    assert.equal(hasAvailableVariantInSize(byTitle('Classic Black Shirt'), 'S'), false);
  });

  it('rejects a size the product does not carry', () => {
    assert.equal(hasAvailableVariantInSize(byTitle('Classic Black Shirt'), 'XXL'), false);
  });

  it('falls back to parsing the variant title when options are missing', () => {
    assert.equal(hasAvailableVariantInSize(byTitle('Black Regular Fit Shirt'), 'XXL'), true);
  });
});

describe('colour filtering', () => {
  it('matches variant options', () => {
    assert.equal(matchesColor(byTitle('Classic Black Shirt'), 'black'), true);
    assert.equal(matchesColor(byTitle('Classic Black Shirt'), 'white'), false);
  });

  it('matches product tags and title', () => {
    assert.equal(matchesColor(byTitle('Blue Denim Jacket'), 'blue'), true);
  });

  it('is case insensitive', () => {
    assert.equal(matchesColor(byTitle('White Linen Shirt'), 'WHITE'), true);
  });
});

describe('availability filtering', () => {
  it('rejects products with no purchasable variant', () => {
    assert.equal(isAvailable(byTitle('Sold Out Black Shirt')), false);
    assert.equal(isAvailable(byTitle('Classic Black Shirt')), true);
  });

  it('never returns a completely unavailable product', () => {
    const result = applyFilters(products, baseParams());
    assert.equal(
      result.some((p) => p.title === 'Sold Out Black Shirt'),
      false,
    );
  });
});

describe('combined size + colour', () => {
  // A shirt that comes in black and comes in L, but has no black L in stock.
  const trap = toProduct(
    makeProductNode({
      id: 'gid://shopify/Product/91',
      title: 'Regular Fit Oxford Shirt',
      tags: ['black', 'shirt'],
      variants: [
        { color: 'Black', size: 'M', price: 2000, available: true },
        { color: 'Black', size: 'L', price: 2000, available: false, inventory: 0 },
        { color: 'White', size: 'L', price: 2000, available: true },
      ],
    }),
  );

  it('requires one in-stock variant to satisfy both constraints', () => {
    assert.equal(hasAvailableVariantMatching(trap, 'L', 'black'), false);
    assert.equal(hasAvailableVariantMatching(trap, 'M', 'black'), true);
    assert.equal(hasAvailableVariantMatching(trap, 'L', 'white'), true);
  });

  it('is not fooled by colour and size matching different variants', () => {
    // Each constraint passes on its own...
    assert.equal(hasAvailableVariantInSize(trap, 'L'), true);
    assert.equal(matchesColor(trap, 'black'), true);
    // ...but the product must still be excluded.
    const result = applyFilters([trap], baseParams({ size: 'L', color: 'black' }));
    assert.deepEqual(result, []);
  });

  it('still returns the product when the pair is genuinely in stock', () => {
    const result = applyFilters([trap], baseParams({ size: 'M', color: 'black' }));
    assert.equal(result.length, 1);
  });

  it('falls back to product-level colour when variants have no colour option', () => {
    const noColorOption = toProduct(
      makeProductNode({
        id: 'gid://shopify/Product/92',
        title: 'Classic Black Shirt',
        tags: ['black'],
        variants: [
          { size: 'L', price: 1500, available: true },
          { size: 'M', price: 1500, available: true },
        ],
      }),
    );
    const result = applyFilters([noColorOption], baseParams({ size: 'L', color: 'black' }));
    assert.equal(result.length, 1);
  });
});

describe('applyFilters', () => {
  it('combines price, size and colour as AND conditions', () => {
    const result = applyFilters(
      products,
      baseParams({ maxPrice: 2500, size: 'L', color: 'black' }),
    );
    const titles = result.map((p) => p.title);
    assert.deepEqual(titles.sort(), ['Black Regular Fit Shirt', 'Classic Black Shirt']);
  });

  it('returns an empty list when nothing satisfies the constraints', () => {
    assert.deepEqual(applyFilters(products, baseParams({ maxPrice: 100 })), []);
  });
});
