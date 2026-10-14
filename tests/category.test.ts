import './setup.env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  categoryMatch,
  inferCategory,
  productCategory,
} from '../src/products/product.category.js';
import { toProduct } from '../src/products/product.mapper.js';
import { makeProductNode } from './fixtures.js';

const product = (title: string, productType: string, tags: string[] = []) =>
  toProduct(
    makeProductNode({
      id: 'gid://shopify/Product/1',
      title,
      productType,
      tags,
      variants: [{ color: 'Black', size: 'L', price: 1000, available: true }],
    }),
  );

describe('inferCategory', () => {
  it('separates shirt from t-shirt', () => {
    assert.equal(inferCategory('shirt'), 'shirt');
    assert.equal(inferCategory('black shirt under 2500'), 'shirt');
    for (const phrase of ['t-shirt', 'T-Shirt', 'tshirt', 't shirt', 'tee']) {
      assert.equal(inferCategory(phrase), 'tshirt', `${phrase} should be a tshirt`);
    }
  });

  it('does not let a substring hijack the generic shirt rule', () => {
    // "sweatshirt" and "knit shirt" both contain "shirt".
    assert.equal(inferCategory('Sweatshirt'), 'sweatshirt');
    assert.equal(inferCategory('sweat shirt'), 'sweatshirt');
    assert.equal(inferCategory('Knit Shirt'), 'shirt');
  });

  it('reads "dress shirt" as a shirt and "polo dress" as a dress', () => {
    assert.equal(inferCategory('dress shirt'), 'shirt');
    assert.equal(inferCategory('Sleeveless Solid Pique Bodycon Polo Dress'), 'dress');
    assert.equal(inferCategory('Regular Fit Essential Polo'), 'polo');
  });

  it('prefers the garment over the material', () => {
    assert.equal(inferCategory('Blue Denim Jacket'), 'jacket');
    assert.equal(inferCategory('Men Jaimie Loose Mid Wash Jeans'), 'jeans');
  });

  it('returns null when the phrase names no category', () => {
    assert.equal(inferCategory('I need something casual for a dinner'), null);
    assert.equal(inferCategory(''), null);
  });
});

describe('productCategory', () => {
  it('trusts product_type over the title', () => {
    // Merchant says T-Shirt; the word "Shirt" in the title must not win.
    assert.equal(productCategory(product('Regular Fit Shirt Style', 'T-Shirt')), 'tshirt');
  });

  it('falls back to the title, then the tags', () => {
    assert.equal(productCategory(product('Poplin Shirt', '')), 'shirt');
    assert.equal(productCategory(product('Untitled', '', ['Jeans'])), 'jeans');
  });

  it('returns null for an unclassifiable product', () => {
    assert.equal(productCategory(product('Mystery Item', '', ['Sale'])), null);
  });
});

describe('categoryMatch', () => {
  it('labels a t-shirt as a substitute when the shopper asked for a shirt', () => {
    assert.equal(categoryMatch(product('Essential Tee', 'T-Shirt'), 'shirt'), 'related');
    assert.equal(categoryMatch(product('Poplin Shirt', 'Shirt'), 'shirt'), 'exact');
  });

  it('judges nothing when the query named no category', () => {
    assert.equal(categoryMatch(product('Poplin Shirt', 'Shirt'), null), null);
  });
});
