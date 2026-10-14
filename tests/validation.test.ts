import './setup.env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  LIMITS,
  normalizeProductId,
  validateSearchParams,
} from '../src/products/product.validation.js';
import { BadRequestError } from '../src/utils/errors.js';

const expectBadRequest = (fn: () => unknown, match?: RegExp): void => {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof BadRequestError, `expected BadRequestError, got ${String(error)}`);
    assert.equal(error.statusCode, 400);
    if (match) assert.match(error.message, match);
    return true;
  });
};

describe('validateSearchParams', () => {
  it('requires a non-empty query', () => {
    expectBadRequest(() => validateSearchParams({}), /query/);
    expectBadRequest(() => validateSearchParams({ query: '   ' }), /query/);
    expectBadRequest(() => validateSearchParams({ query: 42 }), /query/);
  });

  it('rejects a non-object body', () => {
    expectBadRequest(() => validateSearchParams(null));
    expectBadRequest(() => validateSearchParams('black shirt'));
    expectBadRequest(() => validateSearchParams([]));
  });

  it('defaults limit to 5 and leaves optionals null', () => {
    const params = validateSearchParams({ query: 'black shirt' });
    assert.equal(params.limit, LIMITS.defaultLimit);
    assert.equal(params.minPrice, null);
    assert.equal(params.maxPrice, null);
    assert.equal(params.size, null);
    assert.equal(params.color, null);
  });

  it('accepts explicit nulls for every optional field', () => {
    const params = validateSearchParams({
      query: 'shirt',
      min_price: null,
      max_price: null,
      size: null,
      color: null,
      limit: null,
    });
    assert.equal(params.limit, LIMITS.defaultLimit);
    assert.equal(params.size, null);
  });

  it('enforces the limit bounds', () => {
    expectBadRequest(() => validateSearchParams({ query: 'a', limit: 0 }), /between 1/);
    expectBadRequest(() => validateSearchParams({ query: 'a', limit: 21 }), /between 1/);
    expectBadRequest(() => validateSearchParams({ query: 'a', limit: 2.5 }), /integer/);
    assert.equal(validateSearchParams({ query: 'a', limit: 20 }).limit, 20);
  });

  it('rejects negative prices and an inverted range', () => {
    expectBadRequest(() => validateSearchParams({ query: 'a', max_price: -1 }), /negative/);
    expectBadRequest(() => validateSearchParams({ query: 'a', min_price: -5 }), /negative/);
    expectBadRequest(
      () => validateSearchParams({ query: 'a', min_price: 900, max_price: 100 }),
      /less than or equal/,
    );
  });

  it('rejects over-long strings', () => {
    expectBadRequest(() => validateSearchParams({ query: 'x'.repeat(201) }), /200 characters/);
    expectBadRequest(
      () => validateSearchParams({ query: 'a', size: 'x'.repeat(41) }),
      /40 characters/,
    );
    expectBadRequest(
      () => validateSearchParams({ query: 'a', color: 'x'.repeat(41) }),
      /40 characters/,
    );
  });

  it('trims whitespace', () => {
    const params = validateSearchParams({ query: '  black shirt  ', size: ' L ', color: ' Black ' });
    assert.equal(params.query, 'black shirt');
    assert.equal(params.size, 'L');
    assert.equal(params.color, 'Black');
  });
});

describe('normalizeProductId', () => {
  it('accepts a full product GID', () => {
    assert.equal(
      normalizeProductId('gid://shopify/Product/123'),
      'gid://shopify/Product/123',
    );
  });

  it('accepts a bare numeric id', () => {
    assert.equal(normalizeProductId('123'), 'gid://shopify/Product/123');
  });

  it('accepts a URL-encoded GID', () => {
    assert.equal(
      normalizeProductId('gid%3A%2F%2Fshopify%2FProduct%2F123'),
      'gid://shopify/Product/123',
    );
  });

  it('rejects other gid types and junk', () => {
    expectBadRequest(() => normalizeProductId('gid://shopify/Customer/1'));
    expectBadRequest(() => normalizeProductId('not-an-id'));
    expectBadRequest(() => normalizeProductId(''));
    expectBadRequest(() => normalizeProductId(undefined));
  });
});
